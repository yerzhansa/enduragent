import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PROBE_CAMPAIGN_ID, canonicalProbeJson } from "../probe-contract.mjs";
import {
  CONTROLLER_PROTOCOL_SCHEMA_VERSION,
  validateControllerRequest,
  verifyControllerResponse,
} from "./protocol.mjs";

export const CONTROLLER_JOURNAL_SCHEMA_VERSION = 1;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const blobPublicationPattern = /^\.enduragent-controller-blob-([a-f0-9]{64})-([a-f0-9]{24})\.tmp$/u;
const exactVersionPattern = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const executionLeaseDatabaseLeaf = "journal-execution-lease.sqlite";
const defaultLimits = Object.freeze({
  maxBlobBytes: 32 * 1024 * 1024,
  maxBlobs: 4096,
  maxTotalBlobBytes: 512 * 1024 * 1024,
  maxOperations: 16384,
});
const metadataTableSql = `
  CREATE TABLE controller_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    protocol_schema_version INTEGER NOT NULL,
    controller_identity_sha256 TEXT NOT NULL,
    controller_public_key_sha256 TEXT NOT NULL,
    controller_version TEXT NOT NULL,
    campaign_run_id TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    run_plan_sha256 TEXT NOT NULL,
    run_authorization_sha256 TEXT NOT NULL,
    root_identity_sha256 TEXT NOT NULL,
    execution_lease_database_identity_sha256 TEXT NOT NULL
  ) STRICT
`;
const operationsTableSql = `
  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    request_sha256 TEXT NOT NULL UNIQUE,
    semantic_sha256 TEXT NOT NULL UNIQUE,
    intent_sha256 TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
    response_sha256 TEXT UNIQUE,
    response_json TEXT,
    CHECK (
      (state = 'pending' AND response_sha256 IS NULL AND response_json IS NULL) OR
      (state = 'complete' AND response_sha256 IS NOT NULL AND response_json IS NOT NULL)
    )
  ) STRICT
`;
const authorizationClaimsTableSql = `
  CREATE TABLE authorization_claims (
    environment_id TEXT NOT NULL,
    path_profile_id TEXT NOT NULL,
    claim_sha256 TEXT NOT NULL UNIQUE,
    issuance_operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
    PRIMARY KEY (environment_id, path_profile_id)
  ) STRICT
`;
const secretTextPatterns = Object.freeze([
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/iu,
  /"(?:api[_-]?key|credential|password|private[_-]?key|secret|token)"\s*:/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
]);

export class ControllerJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControllerJournalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerJournalError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function operationSemanticSha256(request) {
  return sha256(
    Buffer.from(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-controller-operation-semantic.v1",
        campaignId: request.campaignId,
        manifestSha256: request.manifestSha256,
        candidateSha256: request.candidateSha256,
        runPlanSha256: request.runPlanSha256,
        runAuthorizationSha256: request.runAuthorizationSha256,
        runAuthorizationClaimSha256: request.runAuthorizationClaimSha256,
        coordinate: request.coordinate,
        operationKind: request.operation.kind,
        operationSequence: request.operation.sequence,
        controllerIdentitySha256: request.controllerIdentitySha256,
      }),
      "utf8",
    ),
  );
}

function objectFingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
}

function executionLeaseDatabaseIdentitySha256(stat) {
  return sha256(
    Buffer.from(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-controller-execution-lease-database-identity.v1",
        fingerprint: objectFingerprint(stat),
      }),
      "utf8",
    ),
  );
}

function fileFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.nlink,
    stat.size,
    stat.mode,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(":");
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLimits(value) {
  const limits = { ...defaultLimits, ...value };
  for (const key of Object.keys(defaultLimits)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      fail("CONTROLLER_JOURNAL_LIMIT", "controller journal limits are invalid");
    }
  }
  return Object.freeze(limits);
}

function validateForbiddenValues(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) {
    fail("CONTROLLER_JOURNAL_SECRET_POLICY", "forbidden values must be a bounded array");
  }
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length < 8 || entry.length > 4096) {
      fail("CONTROLLER_JOURNAL_SECRET_POLICY", "forbidden values are invalid");
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return Object.freeze(result);
}

function validateControllerAuthority({
  controllerIdentitySha256,
  controllerPublicKeyBytes,
  controllerVersion,
  campaignRunId,
  candidateSha256,
  runPlanSha256,
  runAuthorizationSha256,
}) {
  for (const [value, label] of [
    [controllerIdentitySha256, "controller identity"],
    [candidateSha256, "candidate"],
    [runPlanSha256, "run plan"],
    [runAuthorizationSha256, "run authorization"],
  ]) {
    if (typeof value !== "string" || !sha256Pattern.test(value)) {
      fail("CONTROLLER_JOURNAL_IDENTITY", `${label} must be a SHA-256 digest`);
    }
  }
  if (
    typeof campaignRunId !== "string" ||
    campaignRunId.length > 128 ||
    !identifierPattern.test(campaignRunId)
  ) {
    fail("CONTROLLER_JOURNAL_IDENTITY", "campaign run identifier is invalid");
  }
  if (typeof controllerVersion !== "string" || !exactVersionPattern.test(controllerVersion)) {
    fail("CONTROLLER_JOURNAL_IDENTITY", "controller version is invalid");
  }
  if (
    !(controllerPublicKeyBytes instanceof Uint8Array) ||
    controllerPublicKeyBytes.byteLength === 0 ||
    controllerPublicKeyBytes.byteLength > 4096
  ) {
    fail("CONTROLLER_JOURNAL_IDENTITY", "controller public key bytes are invalid");
  }
  const publicKeyBytes = Buffer.from(controllerPublicKeyBytes);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    fail("CONTROLLER_JOURNAL_IDENTITY", "controller public key is not SPKI DER");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(publicKey.export({ format: "der", type: "spki" })).equals(publicKeyBytes)
  ) {
    fail("CONTROLLER_JOURNAL_IDENTITY", "controller public key is not canonical Ed25519");
  }
  return Object.freeze({
    controllerIdentitySha256,
    controllerPublicKeyBytes: publicKeyBytes,
    controllerPublicKeySha256: sha256(publicKeyBytes),
    controllerVersion,
    campaignRunId,
    candidateSha256,
    runPlanSha256,
    runAuthorizationSha256,
  });
}

function assertRequestAuthority(request, authority) {
  if (
    request.controllerIdentitySha256 !== authority.controllerIdentitySha256 ||
    request.coordinate.campaignRunId !== authority.campaignRunId ||
    request.candidateSha256 !== authority.candidateSha256 ||
    request.runPlanSha256 !== authority.runPlanSha256 ||
    request.runAuthorizationSha256 !== authority.runAuthorizationSha256
  ) {
    fail("CONTROLLER_JOURNAL_REQUEST_BINDING", "controller request authority differs");
  }
}

function requirePlainDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("CONTROLLER_JOURNAL_REPARSE", `${label} must be a plain directory`);
  }
}

function requireOwnedMode(stat, label, modeMask) {
  if (process.platform === "win32") return;
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o777) !== modeMask) {
    fail("CONTROLLER_JOURNAL_PERMISSIONS", `${label} permissions are not private`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("CONTROLLER_JOURNAL_OWNER", `${label} is not owned by the controller user`);
  }
}

function pathWithin(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function sameCanonicalPath(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function inspectRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("CONTROLLER_JOURNAL_ROOT", "controller journal root must be an absolute path");
  }
  const resolvedRoot = resolve(root);
  const stat = await lstat(resolvedRoot);
  requirePlainDirectory(stat, "controller journal root");
  requireOwnedMode(stat, "controller journal root", 0o700);
  const canonicalRoot = await realpath(resolvedRoot);
  if (!sameCanonicalPath(resolvedRoot, canonicalRoot)) {
    fail("CONTROLLER_JOURNAL_REPARSE", "controller journal root has an aliased ancestor");
  }
  const fingerprint = objectFingerprint(stat);
  return Object.freeze({
    root: resolvedRoot,
    canonicalRoot,
    fingerprint,
    device: stat.dev,
    rootIdentitySha256: sha256(
      Buffer.from(
        canonicalProbeJson({
          domain: "enduragent.windows-host-probe-controller-root-identity.v1",
          canonicalRoot,
          fingerprint,
        }),
        "utf8",
      ),
    ),
  });
}

async function assertRootStable(state) {
  const stat = await lstat(state.root);
  requirePlainDirectory(stat, "controller journal root");
  requireOwnedMode(stat, "controller journal root", 0o700);
  if (
    objectFingerprint(stat) !== state.fingerprint ||
    !sameCanonicalPath(await realpath(state.root), state.canonicalRoot)
  ) {
    fail("CONTROLLER_JOURNAL_ROOT_CHANGED", "controller journal root identity changed");
  }
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectoryMetadata(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error?.code)
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureOwnedDirectory(state, parent, leaf) {
  await assertRootStable(state);
  const candidate = join(parent, leaf);
  if (!pathWithin(state.root, candidate)) {
    fail("CONTROLLER_JOURNAL_ESCAPE", "controller journal directory escapes its root");
  }
  const existing = await lstatIfPresent(candidate);
  if (existing === null) {
    await mkdir(candidate, { recursive: false, mode: 0o700 });
    await syncDirectoryMetadata(parent);
  }
  const stat = await lstat(candidate);
  requirePlainDirectory(stat, "controller journal directory");
  requireOwnedMode(stat, "controller journal directory", 0o700);
  if (stat.dev !== state.device) {
    fail("CONTROLLER_JOURNAL_FILESYSTEM", "controller journal directory changed filesystem");
  }
  const canonical = await realpath(candidate);
  if (!pathWithin(state.canonicalRoot, canonical) || !sameCanonicalPath(candidate, canonical)) {
    fail("CONTROLLER_JOURNAL_REPARSE", "controller journal directory is aliased");
  }
  return candidate;
}

async function captureOwnedDirectory(state, path) {
  const stat = await lstat(path);
  requirePlainDirectory(stat, "controller journal directory");
  requireOwnedMode(stat, "controller journal directory", 0o700);
  const canonical = await realpath(path);
  if (
    stat.dev !== state.device ||
    !pathWithin(state.canonicalRoot, canonical) ||
    !sameCanonicalPath(path, canonical)
  ) {
    fail("CONTROLLER_JOURNAL_REPARSE", "controller journal directory identity is invalid");
  }
  return Object.freeze({ path, fingerprint: objectFingerprint(stat), canonical });
}

async function assertOwnedDirectoryStable(state, directory) {
  const stat = await lstat(directory.path);
  requirePlainDirectory(stat, "controller journal directory");
  requireOwnedMode(stat, "controller journal directory", 0o700);
  if (
    stat.dev !== state.device ||
    objectFingerprint(stat) !== directory.fingerprint ||
    !sameCanonicalPath(await realpath(directory.path), directory.canonical)
  ) {
    fail("CONTROLLER_JOURNAL_TREE_CHANGED", "controller journal directory identity changed");
  }
}

function requireJournalFile(state, stat, label, allowedLinks = new Set([1])) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("CONTROLLER_JOURNAL_REPARSE", `${label} must be a regular file`);
  }
  if (!allowedLinks.has(stat.nlink)) {
    fail("CONTROLLER_JOURNAL_HARD_LINK", `${label} has an invalid link count`);
  }
  if (stat.dev !== state.device) {
    fail("CONTROLLER_JOURNAL_FILESYSTEM", `${label} changed filesystem`);
  }
  requireOwnedMode(stat, label, 0o600);
}

function encodedForbiddenValues(value) {
  const utf8 = Buffer.from(value, "utf8");
  const utf16LittleEndian = Buffer.from(value, "utf16le");
  const utf16BigEndian = Buffer.from(utf16LittleEndian);
  utf16BigEndian.swap16();
  return [
    utf8,
    utf16LittleEndian,
    utf16BigEndian,
    Buffer.from(utf8.toString("base64"), "ascii"),
    Buffer.from(utf8.toString("hex"), "ascii"),
  ];
}

function parsesAsPrivateKey(bytes) {
  const attempts = [
    () => createPrivateKey(bytes),
    () => createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }),
    () => createPrivateKey({ key: bytes, format: "der", type: "pkcs1" }),
    () => createPrivateKey({ key: bytes, format: "der", type: "sec1" }),
  ];
  return attempts.some((attempt) => {
    try {
      attempt();
      return true;
    } catch {
      return false;
    }
  });
}

function assertBlobContainsNoSecrets(bytes, forbiddenValues) {
  const utf8 = bytes.toString("utf8");
  if (
    secretTextPatterns.some((pattern) => pattern.test(utf8)) ||
    forbiddenValues.some((value) =>
      encodedForbiddenValues(value).some((encoded) => bytes.includes(encoded)),
    ) ||
    parsesAsPrivateKey(bytes)
  ) {
    fail("CONTROLLER_JOURNAL_SECRET_MATERIAL", "controller blob contains prohibited material");
  }
}

async function readStableFile(
  state,
  path,
  { allowedLinks = new Set([1]), maxBytes, expectedSha256, forbiddenValues },
) {
  await assertRootStable(state);
  const pathStat = await lstat(path);
  requireJournalFile(state, pathStat, "controller journal artifact", allowedLinks);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    requireJournalFile(state, before, "controller journal artifact", allowedLinks);
    if (before.size > maxBytes) {
      fail("CONTROLLER_JOURNAL_BLOB_SIZE", "controller blob exceeds its size bound");
    }
    const bytes = await readFile(handle);
    const after = await handle.stat();
    requireJournalFile(state, after, "controller journal artifact", allowedLinks);
    const afterPath = await lstat(path);
    requireJournalFile(state, afterPath, "controller journal artifact", allowedLinks);
    if (
      fileFingerprint(before) !== fileFingerprint(after) ||
      fileFingerprint(after) !== fileFingerprint(afterPath) ||
      bytes.length !== after.size
    ) {
      fail("CONTROLLER_JOURNAL_MUTATED", "controller journal artifact changed while read");
    }
    const observedSha256 = sha256(bytes);
    if (expectedSha256 !== undefined && observedSha256 !== expectedSha256) {
      fail("CONTROLLER_JOURNAL_BLOB_COLLISION", "controller blob digest is invalid");
    }
    assertBlobContainsNoSecrets(bytes, forbiddenValues);
    return Object.freeze({ bytes, sha256: observedSha256, size: bytes.length, stat: after });
  } finally {
    await handle.close();
  }
}

function blobPath(blobsSha256Root, digest) {
  if (typeof digest !== "string" || !sha256Pattern.test(digest)) {
    fail("CONTROLLER_JOURNAL_BLOB_DIGEST", "controller blob digest is invalid");
  }
  return join(blobsSha256Root, digest);
}

function blobPublicationPath(blobsSha256Root, digest) {
  return join(
    blobsSha256Root,
    `.enduragent-controller-blob-${digest}-${randomBytes(12).toString("hex")}.tmp`,
  );
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten < 1) {
      fail("CONTROLLER_JOURNAL_PUBLICATION", "controller blob write made no progress");
    }
    offset += bytesWritten;
  }
}

async function stageBlobBytes(state, path, bytes, limits, forbiddenValues) {
  const handle = await open(path, "wx", 0o600);
  try {
    const before = await handle.stat();
    requireJournalFile(state, before, "controller blob publication", new Set([1]));
    await writeAll(handle, bytes);
    await handle.sync();
    const after = await handle.stat();
    requireJournalFile(state, after, "controller blob publication", new Set([1]));
    if (after.size !== bytes.length) {
      fail("CONTROLLER_JOURNAL_PUBLICATION", "controller blob publication did not stabilize");
    }
  } finally {
    await handle.close();
  }
  return readStableFile(state, path, {
    allowedLinks: new Set([1]),
    maxBytes: limits.maxBlobBytes,
    expectedSha256: sha256(bytes),
    forbiddenValues,
  });
}

async function recoverBlobPublications(state, blobsSha256Root, limits, forbiddenValues) {
  const entries = await readdir(blobsSha256Root, { withFileTypes: true });
  let publicationCount = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(".enduragent-controller-blob-")) continue;
    publicationCount += 1;
    if (publicationCount > limits.maxBlobs) {
      fail("CONTROLLER_JOURNAL_PUBLICATION", "too many controller blob publications exist");
    }
    const match = blobPublicationPattern.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      fail("CONTROLLER_JOURNAL_PUBLICATION", "controller blob publication state is invalid");
    }
    const digest = match[1];
    const publication = join(blobsSha256Root, entry.name);
    const final = blobPath(blobsSha256Root, digest);
    const publicationStat = await lstat(publication);
    requireJournalFile(state, publicationStat, "controller blob publication", new Set([1, 2]));
    const finalStat = await lstatIfPresent(final);
    if (publicationStat.nlink === 2) {
      if (
        finalStat === null ||
        objectFingerprint(finalStat) !== objectFingerprint(publicationStat)
      ) {
        fail("CONTROLLER_JOURNAL_PUBLICATION", "linked controller blob has no final artifact");
      }
      await readStableFile(state, final, {
        allowedLinks: new Set([2]),
        maxBytes: limits.maxBlobBytes,
        expectedSha256: digest,
        forbiddenValues,
      });
      await unlink(publication);
      await syncDirectoryMetadata(blobsSha256Root);
      const recoveredFinal = await lstat(final);
      requireJournalFile(state, recoveredFinal, "controller blob", new Set([1]));
      continue;
    }
    const staged = await readStableFile(state, publication, {
      allowedLinks: new Set([1]),
      maxBytes: limits.maxBlobBytes,
      forbiddenValues,
    });
    if (finalStat === null && staged.sha256 === digest) {
      try {
        await link(publication, final);
        await syncDirectoryMetadata(blobsSha256Root);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const recoveredFinal = await lstatIfPresent(final);
    if (recoveredFinal !== null) {
      requireJournalFile(state, recoveredFinal, "controller blob", new Set([1, 2]));
      await readStableFile(state, final, {
        allowedLinks: new Set([recoveredFinal.nlink]),
        maxBytes: limits.maxBlobBytes,
        expectedSha256: digest,
        forbiddenValues,
      });
    }
    await unlink(publication);
    await syncDirectoryMetadata(blobsSha256Root);
    if (recoveredFinal !== null) {
      requireJournalFile(state, await lstat(final), "controller blob", new Set([1]));
    }
  }
}

function normalizeSql(value) {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function sqliteCall(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ControllerJournalError) throw error;
    fail("CONTROLLER_JOURNAL_SQLITE", "controller journal database operation failed");
  }
}

function isSqliteLockContention(error) {
  return error?.errcode === 5 || error?.errcode === 6;
}

function assertExecutionLeaseDatabase(database) {
  let schemaRows;
  let integrityRows;
  let journalMode;
  let trustedSchema;
  let userVersion;
  let applicationId;
  let freelistCount;
  try {
    schemaRows = database
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all();
    integrityRows = database.prepare("PRAGMA quick_check(1)").all();
    journalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
    trustedSchema = database.prepare("PRAGMA trusted_schema").get().trusted_schema;
    userVersion = database.prepare("PRAGMA user_version").get().user_version;
    applicationId = database.prepare("PRAGMA application_id").get().application_id;
    freelistCount = database.prepare("PRAGMA freelist_count").get().freelist_count;
  } catch {
    fail(
      "CONTROLLER_JOURNAL_EXECUTION_LEASE_SCHEMA",
      "controller execution lease database could not be inspected",
    );
  }
  if (
    schemaRows.length !== 0 ||
    integrityRows.length !== 1 ||
    Object.values(integrityRows[0]).length !== 1 ||
    Object.values(integrityRows[0])[0] !== "ok" ||
    String(journalMode).toLowerCase() !== "delete" ||
    trustedSchema !== 0 ||
    userVersion !== 0 ||
    applicationId !== 0 ||
    freelistCount !== 0
  ) {
    fail(
      "CONTROLLER_JOURNAL_EXECUTION_LEASE_SCHEMA",
      "controller execution lease database differs",
    );
  }
}

function assertDatabaseSchema(database) {
  const rows = sqliteCall(() =>
    database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
  const expected = new Map([
    ["authorization_claims", authorizationClaimsTableSql],
    ["controller_metadata", metadataTableSql],
    ["operations", operationsTableSql],
  ]);
  if (
    rows.length !== expected.size ||
    rows.some(
      (row) =>
        row.type !== "table" ||
        !expected.has(row.name) ||
        normalizeSql(row.sql) !== normalizeSql(expected.get(row.name)),
    )
  ) {
    fail("CONTROLLER_JOURNAL_SCHEMA", "controller journal database schema differs");
  }
}

function assertDatabaseDurability(database) {
  const journalMode = sqliteCall(() => database.prepare("PRAGMA journal_mode").get().journal_mode);
  const synchronous = sqliteCall(() => database.prepare("PRAGMA synchronous").get().synchronous);
  const fullfsync = sqliteCall(() => database.prepare("PRAGMA fullfsync").get().fullfsync);
  const checkpointFullfsync = sqliteCall(
    () => database.prepare("PRAGMA checkpoint_fullfsync").get().checkpoint_fullfsync,
  );
  if (
    String(journalMode).toLowerCase() !== "wal" ||
    synchronous !== 2 ||
    fullfsync !== 1 ||
    checkpointFullfsync !== 1
  ) {
    fail("CONTROLLER_JOURNAL_DURABILITY", "controller journal durability mode is unavailable");
  }
}

function transact(database, operation) {
  sqliteCall(() => database.exec("BEGIN IMMEDIATE"));
  try {
    const result = operation();
    sqliteCall(() => database.exec("COMMIT"));
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      fail("CONTROLLER_JOURNAL_SQLITE", "controller journal rollback failed");
    }
    throw error;
  }
}

function parseCanonicalRecord(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) {
    fail("CONTROLLER_JOURNAL_RECORD", `${label} is invalid`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("CONTROLLER_JOURNAL_RECORD", `${label} is invalid`);
  }
  if (!exactObject(parsed) || canonicalProbeJson(parsed) !== value) {
    fail("CONTROLLER_JOURNAL_RECORD", `${label} is not canonical`);
  }
  return parsed;
}

function validateOperationRow(row, forbiddenValues, authority) {
  assertBlobContainsNoSecrets(Buffer.from(row.request_json ?? "", "utf8"), forbiddenValues);
  const request = validateControllerRequest(
    parseCanonicalRecord(row.request_json, "request record"),
  );
  assertRequestAuthority(request, authority);
  if (
    row.operation_id !== request.operation.operationId ||
    row.request_sha256 !== request.requestSha256 ||
    row.semantic_sha256 !== operationSemanticSha256(request) ||
    row.intent_sha256 !== request.intentSha256 ||
    row.payload_sha256 !== request.payload.sha256
  ) {
    fail("CONTROLLER_JOURNAL_RECORD", "request record columns differ");
  }
  if (row.state === "pending") {
    if (row.response_sha256 !== null || row.response_json !== null) {
      fail("CONTROLLER_JOURNAL_RECORD", "pending operation has terminal fields");
    }
    return Object.freeze({
      operationId: request.operation.operationId,
      state: "pending",
      request,
      response: null,
    });
  }
  if (row.state !== "complete" || row.response_sha256 === null || row.response_json === null) {
    fail("CONTROLLER_JOURNAL_RECORD", "operation state is invalid");
  }
  assertBlobContainsNoSecrets(Buffer.from(row.response_json, "utf8"), forbiddenValues);
  const response = verifyControllerResponse(
    parseCanonicalRecord(row.response_json, "response record"),
    {
      request,
      controllerIdentitySha256: authority.controllerIdentitySha256,
      controllerVersion: authority.controllerVersion,
      controllerPublicKeyBytes: authority.controllerPublicKeyBytes,
    },
  );
  if (
    row.response_sha256 !== response.responseSha256 ||
    response.requestSha256 !== request.requestSha256 ||
    response.controllerIdentitySha256 !== request.controllerIdentitySha256
  ) {
    fail("CONTROLLER_JOURNAL_RECORD", "response record columns differ");
  }
  return Object.freeze({
    operationId: request.operation.operationId,
    state: "complete",
    request,
    response,
  });
}

function validateAuthorizationClaimRow(row, forbiddenValues, authority, operationById) {
  if (
    row === undefined ||
    typeof row.environment_id !== "string" ||
    typeof row.path_profile_id !== "string" ||
    typeof row.claim_sha256 !== "string" ||
    !sha256Pattern.test(row.claim_sha256) ||
    typeof row.issuance_operation_id !== "string"
  ) {
    fail("CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM", "authorization claim record is invalid");
  }
  const issuanceRow = operationById(row.issuance_operation_id);
  if (issuanceRow === undefined) {
    fail(
      "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
      "authorization claim issuance operation is missing",
    );
  }
  const issuance = validateOperationRow(issuanceRow, forbiddenValues, authority);
  if (
    issuance.state !== "complete" ||
    issuance.request.operation.kind !== "run-authorization-claim" ||
    issuance.request.coordinate.environmentId !== row.environment_id ||
    issuance.request.coordinate.pathProfileId !== row.path_profile_id ||
    issuance.request.runAuthorizationClaimSha256 !== null ||
    issuance.response.outcome !== "SUCCEEDED"
  ) {
    fail(
      "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
      "authorization claim differs from its issuance operation",
    );
  }
  return Object.freeze({
    environmentId: row.environment_id,
    pathProfileId: row.path_profile_id,
    claimSha256: row.claim_sha256,
    issuanceOperationId: row.issuance_operation_id,
  });
}

function validateAuthorizationClaimCompletion(request, response, value) {
  if (request.operation.kind !== "run-authorization-claim") {
    if (value !== undefined && value !== null) {
      fail(
        "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
        "non-issuance operation cannot publish an authorization claim",
      );
    }
    return null;
  }
  if (response.outcome !== "SUCCEEDED") {
    if (value !== undefined && value !== null) {
      fail(
        "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
        "unsuccessful authorization verification cannot publish a claim",
      );
    }
    return null;
  }
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail(
      "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
      "successful authorization verification must publish its claim digest",
    );
  }
  return value;
}

async function prepareDatabaseFile(state, databasePath, label) {
  const existing = await lstatIfPresent(databasePath);
  let created = false;
  if (existing === null) {
    let handle;
    try {
      handle = await open(databasePath, "wx", 0o600);
      await handle.sync();
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
    if (created) await syncDirectoryMetadata(state.root);
  }
  const stat = await lstat(databasePath);
  requireJournalFile(state, stat, label);
  return created;
}

async function validateRootObjects(state, databasePath, executionLeaseDatabasePath, blobsRoot) {
  await assertRootStable(state);
  const allowedFiles = new Set([
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
    executionLeaseDatabasePath,
    `${executionLeaseDatabasePath}-journal`,
  ]);
  const entries = await readdir(state.root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(state.root, entry.name);
    if (path === blobsRoot) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail("CONTROLLER_JOURNAL_REPARSE", "controller blob root is invalid");
      }
      continue;
    }
    if (!allowedFiles.has(path) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("CONTROLLER_JOURNAL_ROOT_CONTENT", "controller journal root contains an unknown object");
    }
    requireJournalFile(state, await lstat(path), "controller journal database file");
  }
}

async function scanBlobs(state, blobsSha256Root, limits, forbiddenValues) {
  await recoverBlobPublications(state, blobsSha256Root, limits, forbiddenValues);
  const entries = await readdir(blobsSha256Root, { withFileTypes: true });
  const blobs = [];
  let totalBytes = 0;
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.name.startsWith(".enduragent-controller-blob-")) {
      const match = blobPublicationPattern.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        fail("CONTROLLER_JOURNAL_PUBLICATION", "controller blob publication state is invalid");
      }
      const stat = await lstat(join(blobsSha256Root, entry.name));
      requireJournalFile(state, stat, "controller blob publication", new Set([1]));
      fail(
        "CONTROLLER_JOURNAL_PUBLICATION_INCOMPLETE",
        "controller blob publication is incomplete",
      );
    }
    if (!sha256Pattern.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("CONTROLLER_JOURNAL_BLOB_TREE", "controller blob tree contains an invalid object");
    }
    const retained = await readStableFile(state, join(blobsSha256Root, entry.name), {
      allowedLinks: new Set([1]),
      maxBytes: limits.maxBlobBytes,
      expectedSha256: entry.name,
      forbiddenValues,
    });
    totalBytes += retained.size;
    if (totalBytes > limits.maxTotalBlobBytes) {
      fail("CONTROLLER_JOURNAL_BLOB_SIZE", "controller blob tree exceeds its total size bound");
    }
    blobs.push(
      Object.freeze({
        blobPath: `blobs/sha256/${entry.name}`,
        bytes: retained.size,
        sha256: entry.name,
      }),
    );
    if (blobs.length > limits.maxBlobs) {
      fail("CONTROLLER_JOURNAL_BLOB_COUNT", "controller blob tree exceeds its count bound");
    }
  }
  return Object.freeze(blobs);
}

export async function openControllerJournal({
  root,
  controllerIdentitySha256,
  controllerPublicKeyBytes,
  controllerVersion,
  campaignRunId,
  candidateSha256,
  runPlanSha256,
  runAuthorizationSha256,
  forbiddenValues,
  limits,
} = {}) {
  const authority = validateControllerAuthority({
    controllerIdentitySha256,
    controllerPublicKeyBytes,
    controllerVersion,
    campaignRunId,
    candidateSha256,
    runPlanSha256,
    runAuthorizationSha256,
  });
  const bounded = validateLimits(limits);
  const forbidden = validateForbiddenValues(forbiddenValues);
  const state = await inspectRoot(root);
  const databasePath = join(state.root, "journal.sqlite");
  const executionLeaseDatabasePath = join(state.root, executionLeaseDatabaseLeaf);
  const existingDatabaseStat = await lstatIfPresent(databasePath);
  if (existingDatabaseStat !== null) {
    requireJournalFile(state, existingDatabaseStat, "controller journal database");
  }
  let executionLeaseDatabaseStat = await lstatIfPresent(executionLeaseDatabasePath);
  if (executionLeaseDatabaseStat === null) {
    const databaseBeforeLeaseCreation = await lstatIfPresent(databasePath);
    if (existingDatabaseStat !== null || databaseBeforeLeaseCreation !== null) {
      const observedDatabaseStat = existingDatabaseStat ?? databaseBeforeLeaseCreation;
      requireJournalFile(state, observedDatabaseStat, "controller journal database");
      fail(
        "CONTROLLER_JOURNAL_EXECUTION_LEASE_IDENTITY",
        "controller execution lease database is missing from an existing journal",
      );
    }
    await prepareDatabaseFile(
      state,
      executionLeaseDatabasePath,
      "controller execution lease database",
    );
    executionLeaseDatabaseStat = await lstat(executionLeaseDatabasePath);
  }
  requireJournalFile(state, executionLeaseDatabaseStat, "controller execution lease database");
  const executionLeaseDatabaseFingerprint = objectFingerprint(executionLeaseDatabaseStat);
  const expectedExecutionLeaseDatabaseIdentitySha256 = executionLeaseDatabaseIdentitySha256(
    executionLeaseDatabaseStat,
  );
  const blobsRoot = await ensureOwnedDirectory(state, state.root, "blobs");
  const blobsSha256Root = await ensureOwnedDirectory(state, blobsRoot, "sha256");
  const blobsRootIdentity = await captureOwnedDirectory(state, blobsRoot);
  const blobsSha256RootIdentity = await captureOwnedDirectory(state, blobsSha256Root);
  const created = await prepareDatabaseFile(state, databasePath, "controller journal database");
  const databaseFingerprint = objectFingerprint(await lstat(databasePath));
  let database;
  try {
    database = new DatabaseSync(databasePath);
  } catch {
    fail("CONTROLLER_JOURNAL_SQLITE", "controller journal database could not be opened");
  }
  let closed = false;
  let operationTail = Promise.resolve();
  let activeExecutionLease = null;

  function assertOpen() {
    if (closed) fail("CONTROLLER_JOURNAL_CLOSED", "controller journal is closed");
  }

  async function assertJournalTreeStable() {
    await assertRootStable(state);
    await assertOwnedDirectoryStable(state, blobsRootIdentity);
    await assertOwnedDirectoryStable(state, blobsSha256RootIdentity);
    const databaseStat = await lstat(databasePath);
    requireJournalFile(state, databaseStat, "controller journal database");
    if (objectFingerprint(databaseStat) !== databaseFingerprint) {
      fail("CONTROLLER_JOURNAL_TREE_CHANGED", "controller journal database identity changed");
    }
    const executionLeaseDatabaseStat = await lstat(executionLeaseDatabasePath);
    requireJournalFile(state, executionLeaseDatabaseStat, "controller execution lease database");
    if (objectFingerprint(executionLeaseDatabaseStat) !== executionLeaseDatabaseFingerprint) {
      fail(
        "CONTROLLER_JOURNAL_TREE_CHANGED",
        "controller execution lease database identity changed",
      );
    }
  }

  async function releaseExecutionLease(leaseState) {
    if (leaseState.released) return;
    let releaseFailed = false;
    try {
      leaseState.database.exec("ROLLBACK");
    } catch {
      releaseFailed = true;
    }
    try {
      leaseState.database.close();
    } catch {
      releaseFailed = true;
    }
    leaseState.released = true;
    if (activeExecutionLease === leaseState) activeExecutionLease = null;
    try {
      await assertJournalTreeStable();
    } catch {
      releaseFailed = true;
    }
    if (releaseFailed) {
      fail("CONTROLLER_JOURNAL_EXECUTION_LEASE", "controller execution lease release failed");
    }
  }

  async function acquireExecutionLease(operationId, requestSha256) {
    if (activeExecutionLease !== null) {
      fail(
        "CONTROLLER_JOURNAL_EXECUTION_ACTIVE",
        "controller journal already holds physical execution authority",
      );
    }
    let leaseDatabase;
    let transactionStarted = false;
    try {
      leaseDatabase = new DatabaseSync(executionLeaseDatabasePath);
      leaseDatabase.exec(
        [
          "PRAGMA busy_timeout = 0",
          "PRAGMA synchronous = FULL",
          "PRAGMA trusted_schema = OFF",
        ].join(";\n"),
      );
      leaseDatabase.exec("BEGIN EXCLUSIVE");
      transactionStarted = true;
      assertExecutionLeaseDatabase(leaseDatabase);
      await assertJournalTreeStable();
    } catch (error) {
      if (transactionStarted) {
        try {
          leaseDatabase?.exec("ROLLBACK");
        } catch {}
      }
      try {
        leaseDatabase?.close();
      } catch {
        fail(
          "CONTROLLER_JOURNAL_EXECUTION_LEASE",
          "controller execution lease database could not close",
        );
      }
      if (error instanceof ControllerJournalError) throw error;
      if (isSqliteLockContention(error)) return null;
      fail("CONTROLLER_JOURNAL_EXECUTION_LEASE", "controller execution lease acquisition failed");
    }
    const leaseState = {
      database: leaseDatabase,
      operationId,
      requestSha256,
      released: false,
    };
    activeExecutionLease = leaseState;
    return leaseState;
  }

  function requireExecutionLease(request) {
    if (
      activeExecutionLease === null ||
      activeExecutionLease.released ||
      activeExecutionLease.operationId !== request.operation.operationId ||
      activeExecutionLease.requestSha256 !== request.requestSha256
    ) {
      fail(
        "CONTROLLER_JOURNAL_EXECUTION_AUTHORITY",
        "controller completion has no live physical execution authority",
      );
    }
    return activeExecutionLease;
  }

  async function serialize(operation) {
    let release;
    const turn = new Promise((resolveTurn) => {
      release = resolveTurn;
    });
    const previous = operationTail;
    operationTail = turn;
    await previous;
    try {
      assertOpen();
      await assertJournalTreeStable();
      const result = await operation();
      await assertJournalTreeStable();
      return result;
    } finally {
      release();
    }
  }

  function rows() {
    return sqliteCall(() =>
      database
        .prepare(
          `SELECT operation_id, request_sha256, intent_sha256, payload_sha256,
                  semantic_sha256, request_json, state, response_sha256, response_json
             FROM operations ORDER BY operation_id`,
        )
        .all(),
    );
  }

  function operationById(operationId) {
    return sqliteCall(() =>
      database
        .prepare(
          `SELECT operation_id, request_sha256, intent_sha256, payload_sha256,
                  semantic_sha256, request_json, state, response_sha256, response_json
             FROM operations WHERE operation_id = ?`,
        )
        .get(operationId),
    );
  }

  function authorizationClaimRows() {
    return sqliteCall(() =>
      database
        .prepare(
          `SELECT environment_id, path_profile_id, claim_sha256, issuance_operation_id
             FROM authorization_claims ORDER BY environment_id, path_profile_id`,
        )
        .all(),
    );
  }

  function authorizationClaimByCoordinate(environmentId, pathProfileId) {
    return sqliteCall(() =>
      database
        .prepare(
          `SELECT environment_id, path_profile_id, claim_sha256, issuance_operation_id
             FROM authorization_claims
            WHERE environment_id = ? AND path_profile_id = ?`,
        )
        .get(environmentId, pathProfileId),
    );
  }

  function authorizationClaimByIssuanceOperation(operationId) {
    return sqliteCall(() =>
      database
        .prepare(
          `SELECT environment_id, path_profile_id, claim_sha256, issuance_operation_id
             FROM authorization_claims WHERE issuance_operation_id = ?`,
        )
        .get(operationId),
    );
  }

  function requireRequestAuthorizationClaim(request) {
    if (request.operation.kind === "run-authorization-claim") return null;
    const row = authorizationClaimByCoordinate(
      request.coordinate.environmentId,
      request.coordinate.pathProfileId,
    );
    if (row === undefined) {
      fail(
        "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
        "controller request has no durably issued authorization claim",
      );
    }
    const claim = validateAuthorizationClaimRow(row, forbidden, authority, operationById);
    if (request.runAuthorizationClaimSha256 !== claim.claimSha256) {
      fail(
        "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
        "controller request selects another authorization claim",
      );
    }
    return claim;
  }

  async function requireRetainedReference(reference, label) {
    let retained;
    try {
      retained = await readStableFile(state, blobPath(blobsSha256Root, reference.sha256), {
        allowedLinks: new Set([1]),
        maxBytes: bounded.maxBlobBytes,
        expectedSha256: reference.sha256,
        forbiddenValues: forbidden,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail("CONTROLLER_JOURNAL_ARTIFACT", `${label} is not retained`);
      }
      throw error;
    }
    if (
      reference.blobPath !== `blobs/sha256/${reference.sha256}` ||
      reference.bytes !== retained.size
    ) {
      fail("CONTROLLER_JOURNAL_ARTIFACT", `${label} differs from its retained blob`);
    }
    return retained;
  }

  async function scanInternal() {
    await assertJournalTreeStable();
    assertDatabaseDurability(database);
    assertDatabaseSchema(database);
    await validateRootObjects(state, databasePath, executionLeaseDatabasePath, blobsRoot);
    const operationRows = rows();
    if (operationRows.length > bounded.maxOperations) {
      fail("CONTROLLER_JOURNAL_OPERATION_COUNT", "controller journal has too many operations");
    }
    const operations = Object.freeze(
      operationRows.map((row) => validateOperationRow(row, forbidden, authority)),
    );
    const authorizationClaims = Object.freeze(
      authorizationClaimRows().map((row) =>
        validateAuthorizationClaimRow(row, forbidden, authority, operationById),
      ),
    );
    const claimsByIssuanceOperation = new Map(
      authorizationClaims.map((claim) => [claim.issuanceOperationId, claim]),
    );
    for (const operation of operations) {
      const issuedClaim = claimsByIssuanceOperation.get(operation.operationId);
      const mustHaveClaim =
        operation.state === "complete" &&
        operation.request.operation.kind === "run-authorization-claim" &&
        operation.response.outcome === "SUCCEEDED";
      if (mustHaveClaim !== (issuedClaim !== undefined)) {
        fail(
          "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
          "authorization claim issuance state differs from its operation",
        );
      }
    }
    const blobs = await scanBlobs(state, blobsSha256Root, bounded, forbidden);
    const blobsBySha256 = new Map(blobs.map((blob) => [blob.sha256, blob]));
    const referenced = new Set();
    for (const record of operations) {
      const references = [record.request.payload];
      if (record.response !== null) {
        references.push(record.response.payload, ...record.response.artifacts);
      }
      for (const artifact of references) {
        const blob = blobsBySha256.get(artifact.sha256);
        if (
          blob === undefined ||
          blob.blobPath !== artifact.blobPath ||
          blob.bytes !== artifact.bytes
        ) {
          fail("CONTROLLER_JOURNAL_ARTIFACT", "journal record references a missing blob");
        }
        referenced.add(artifact.sha256);
      }
    }
    const pendingOperationIds = Object.freeze(
      operations.filter((record) => record.state === "pending").map((record) => record.operationId),
    );
    const orphanBlobSha256s = Object.freeze(
      blobs.filter((blob) => !referenced.has(blob.sha256)).map((blob) => blob.sha256),
    );
    return Object.freeze({
      schemaVersion: CONTROLLER_JOURNAL_SCHEMA_VERSION,
      kind: "windows-host-probe-controller-journal-scan",
      campaignId: PROBE_CAMPAIGN_ID,
      campaignRunId: authority.campaignRunId,
      candidateSha256: authority.candidateSha256,
      runPlanSha256: authority.runPlanSha256,
      runAuthorizationSha256: authority.runAuthorizationSha256,
      controllerIdentitySha256: authority.controllerIdentitySha256,
      controllerPublicKeySha256: authority.controllerPublicKeySha256,
      controllerVersion: authority.controllerVersion,
      journalMode: "wal",
      synchronous: "FULL",
      operations,
      authorizationClaims,
      pendingOperationIds,
      blobs,
      orphanBlobSha256s,
    });
  }

  try {
    sqliteCall(() => database.prepare("PRAGMA journal_mode = WAL").get().journal_mode);
    sqliteCall(() =>
      database.exec(`
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA wal_autocheckpoint = 1;
        PRAGMA fullfsync = ON;
        PRAGMA checkpoint_fullfsync = ON;
      `),
    );
    assertDatabaseDurability(database);
    const existingSchemaObjects = sqliteCall(
      () =>
        database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .get().count,
    );
    if (existingSchemaObjects === 0) {
      transact(database, () => {
        sqliteCall(() =>
          database.exec(
            `${metadataTableSql}; ${operationsTableSql}; ${authorizationClaimsTableSql};`,
          ),
        );
        sqliteCall(() =>
          database
            .prepare(
              `INSERT INTO controller_metadata
                (singleton, schema_version, kind, campaign_id, protocol_schema_version,
                 controller_identity_sha256, controller_public_key_sha256, controller_version,
                 campaign_run_id, candidate_sha256, run_plan_sha256, run_authorization_sha256,
                 root_identity_sha256, execution_lease_database_identity_sha256)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              CONTROLLER_JOURNAL_SCHEMA_VERSION,
              "windows-host-probe-controller-journal",
              PROBE_CAMPAIGN_ID,
              CONTROLLER_PROTOCOL_SCHEMA_VERSION,
              authority.controllerIdentitySha256,
              authority.controllerPublicKeySha256,
              authority.controllerVersion,
              authority.campaignRunId,
              authority.candidateSha256,
              authority.runPlanSha256,
              authority.runAuthorizationSha256,
              state.rootIdentitySha256,
              expectedExecutionLeaseDatabaseIdentitySha256,
            ),
        );
      });
    }
    assertDatabaseSchema(database);
    const metadata = sqliteCall(() =>
      database.prepare("SELECT * FROM controller_metadata WHERE singleton = 1").get(),
    );
    if (metadata === undefined) {
      fail(
        "CONTROLLER_JOURNAL_METADATA",
        "controller journal metadata is missing from an initialized schema",
      );
    } else {
      if (
        metadata.schema_version !== CONTROLLER_JOURNAL_SCHEMA_VERSION ||
        metadata.kind !== "windows-host-probe-controller-journal" ||
        metadata.campaign_id !== PROBE_CAMPAIGN_ID ||
        metadata.protocol_schema_version !== CONTROLLER_PROTOCOL_SCHEMA_VERSION ||
        metadata.controller_identity_sha256 !== authority.controllerIdentitySha256 ||
        metadata.controller_public_key_sha256 !== authority.controllerPublicKeySha256 ||
        metadata.controller_version !== authority.controllerVersion ||
        metadata.campaign_run_id !== authority.campaignRunId ||
        metadata.candidate_sha256 !== authority.candidateSha256 ||
        metadata.run_plan_sha256 !== authority.runPlanSha256 ||
        metadata.run_authorization_sha256 !== authority.runAuthorizationSha256 ||
        metadata.root_identity_sha256 !== state.rootIdentitySha256
      ) {
        fail("CONTROLLER_JOURNAL_METADATA", "controller journal metadata differs");
      }
      if (
        metadata.execution_lease_database_identity_sha256 !==
        expectedExecutionLeaseDatabaseIdentitySha256
      ) {
        fail(
          "CONTROLLER_JOURNAL_EXECUTION_LEASE_IDENTITY",
          "controller execution lease database identity differs from journal metadata",
        );
      }
    }
    if (created) await syncDirectoryMetadata(state.root);
    await recoverBlobPublications(state, blobsSha256Root, bounded, forbidden);
    await scanInternal();
  } catch (error) {
    try {
      database.close();
    } catch {}
    closed = true;
    throw error;
  }

  async function claimOperation(value) {
    return serialize(async () => {
      await assertRootStable(state);
      const request = validateControllerRequest(value);
      assertRequestAuthority(request, authority);
      requireRequestAuthorizationClaim(request);
      await requireRetainedReference(request.payload, "controller request payload");
      const operationId = request.operation.operationId;
      const semanticSha256 = operationSemanticSha256(request);
      const requestJson = canonicalProbeJson(request);
      assertBlobContainsNoSecrets(Buffer.from(requestJson, "utf8"), forbidden);
      const beforeLease = operationById(operationId);
      if (beforeLease !== undefined) {
        const record = validateOperationRow(beforeLease, forbidden, authority);
        if (!canonicalEqual(record.request, request)) {
          fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller operation replay differs");
        }
        if (record.state === "complete") {
          return Object.freeze({ record, created: false });
        }
        if (
          activeExecutionLease !== null &&
          !activeExecutionLease.released &&
          activeExecutionLease.operationId === operationId &&
          activeExecutionLease.requestSha256 === request.requestSha256
        ) {
          return Object.freeze({ record, created: false });
        }
      } else {
        const requestOwner = sqliteCall(() =>
          database
            .prepare("SELECT operation_id FROM operations WHERE request_sha256 = ?")
            .get(request.requestSha256),
        );
        if (requestOwner !== undefined) {
          fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller request is already claimed");
        }
        const semanticOwner = sqliteCall(() =>
          database
            .prepare("SELECT operation_id FROM operations WHERE semantic_sha256 = ?")
            .get(semanticSha256),
        );
        if (semanticOwner !== undefined) {
          fail(
            "CONTROLLER_JOURNAL_OPERATION_COLLISION",
            "controller logical operation is already claimed",
          );
        }
        if (
          request.operation.kind === "run-authorization-claim" &&
          authorizationClaimByCoordinate(
            request.coordinate.environmentId,
            request.coordinate.pathProfileId,
          ) !== undefined
        ) {
          fail(
            "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
            "controller coordinate already has an issued authorization claim",
          );
        }
        const operationCount = sqliteCall(
          () => database.prepare("SELECT COUNT(*) AS count FROM operations").get().count,
        );
        if (operationCount >= bounded.maxOperations) {
          fail("CONTROLLER_JOURNAL_OPERATION_COUNT", "controller journal has too many operations");
        }
      }
      const executionLease = await acquireExecutionLease(operationId, request.requestSha256);
      if (executionLease === null) {
        fail(
          "CONTROLLER_JOURNAL_EXECUTION_BUSY",
          "another controller process holds physical execution authority",
        );
      }
      let result;
      try {
        result = transact(database, () => {
          const existing = operationById(operationId);
          if (existing !== undefined) {
            const record = validateOperationRow(existing, forbidden, authority);
            if (!canonicalEqual(record.request, request)) {
              fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller operation replay differs");
            }
            return Object.freeze({ record, created: false });
          }
          const requestOwner = sqliteCall(() =>
            database
              .prepare("SELECT operation_id FROM operations WHERE request_sha256 = ?")
              .get(request.requestSha256),
          );
          if (requestOwner !== undefined) {
            fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller request is already claimed");
          }
          const semanticOwner = sqliteCall(() =>
            database
              .prepare("SELECT operation_id FROM operations WHERE semantic_sha256 = ?")
              .get(semanticSha256),
          );
          if (semanticOwner !== undefined) {
            fail(
              "CONTROLLER_JOURNAL_OPERATION_COLLISION",
              "controller logical operation is already claimed",
            );
          }
          if (
            request.operation.kind === "run-authorization-claim" &&
            authorizationClaimByCoordinate(
              request.coordinate.environmentId,
              request.coordinate.pathProfileId,
            ) !== undefined
          ) {
            fail(
              "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
              "controller coordinate already has an issued authorization claim",
            );
          }
          const operationCount = sqliteCall(
            () => database.prepare("SELECT COUNT(*) AS count FROM operations").get().count,
          );
          if (operationCount >= bounded.maxOperations) {
            fail(
              "CONTROLLER_JOURNAL_OPERATION_COUNT",
              "controller journal has too many operations",
            );
          }
          sqliteCall(() =>
            database
              .prepare(
                `INSERT INTO operations
                (operation_id, request_sha256, semantic_sha256, intent_sha256, payload_sha256,
                 request_json, state, response_sha256, response_json)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
              )
              .run(
                operationId,
                request.requestSha256,
                semanticSha256,
                request.intentSha256,
                request.payload.sha256,
                requestJson,
              ),
          );
          return Object.freeze({
            record: validateOperationRow(operationById(operationId), forbidden, authority),
            created: true,
          });
        });
      } catch (error) {
        await releaseExecutionLease(executionLease);
        throw error;
      }
      if (result.record.state === "complete") {
        await releaseExecutionLease(executionLease);
      }
      return result;
    });
  }

  async function beginOperation(value) {
    return (await claimOperation(value)).record;
  }

  async function retainBlob(value) {
    return serialize(async () => {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
      if (bytes.length > bounded.maxBlobBytes) {
        fail("CONTROLLER_JOURNAL_BLOB_SIZE", "controller blob exceeds its size bound");
      }
      assertBlobContainsNoSecrets(bytes, forbidden);
      await recoverBlobPublications(state, blobsSha256Root, bounded, forbidden);
      const digest = sha256(bytes);
      const final = blobPath(blobsSha256Root, digest);
      const existingFinal = await lstatIfPresent(final);
      if (existingFinal !== null) {
        const retained = await readStableFile(state, final, {
          allowedLinks: new Set([1, 2]),
          maxBytes: bounded.maxBlobBytes,
          expectedSha256: digest,
          forbiddenValues: forbidden,
        });
        if (!retained.bytes.equals(bytes)) {
          fail("CONTROLLER_JOURNAL_BLOB_COLLISION", "controller blob content differs");
        }
        return Object.freeze({
          blobPath: `blobs/sha256/${digest}`,
          bytes: bytes.length,
          sha256: digest,
        });
      }
      const retainedBlobs = await scanBlobs(state, blobsSha256Root, bounded, forbidden);
      const retainedBytes = retainedBlobs.reduce((total, blob) => total + blob.bytes, 0);
      if (retainedBlobs.length >= bounded.maxBlobs) {
        fail("CONTROLLER_JOURNAL_BLOB_COUNT", "controller blob tree exceeds its count bound");
      }
      if (retainedBytes + bytes.length > bounded.maxTotalBlobBytes) {
        fail("CONTROLLER_JOURNAL_BLOB_SIZE", "controller blob tree exceeds its total size bound");
      }
      const publication = blobPublicationPath(blobsSha256Root, digest);
      await stageBlobBytes(state, publication, bytes, bounded, forbidden);
      await assertRootStable(state);
      try {
        await link(publication, final);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = await readStableFile(state, final, {
          allowedLinks: new Set([1, 2]),
          maxBytes: bounded.maxBlobBytes,
          expectedSha256: digest,
          forbiddenValues: forbidden,
        });
        if (!raced.bytes.equals(bytes)) {
          fail("CONTROLLER_JOURNAL_BLOB_COLLISION", "controller blob content differs");
        }
      }
      const publicationAfter = await lstat(publication);
      requireJournalFile(state, publicationAfter, "controller blob publication", new Set([1, 2]));
      if (publicationAfter.nlink === 2) {
        await syncDirectoryMetadata(blobsSha256Root);
      }
      await unlink(publication);
      await syncDirectoryMetadata(blobsSha256Root);
      const retained = await readStableFile(state, final, {
        allowedLinks: new Set([1, 2]),
        maxBytes: bounded.maxBlobBytes,
        expectedSha256: digest,
        forbiddenValues: forbidden,
      });
      if (!retained.bytes.equals(bytes)) {
        fail("CONTROLLER_JOURNAL_BLOB_COLLISION", "controller blob content differs");
      }
      return Object.freeze({
        blobPath: `blobs/sha256/${digest}`,
        bytes: bytes.length,
        sha256: digest,
      });
    });
  }

  async function readBlob(reference) {
    return serialize(async () => {
      if (
        !exactObject(reference) ||
        Object.keys(reference).sort().join(",") !== "blobPath,bytes,sha256"
      ) {
        fail("CONTROLLER_JOURNAL_ARTIFACT", "controller blob reference is invalid");
      }
      const retained = await requireRetainedReference(reference, "controller blob");
      return Buffer.from(retained.bytes);
    });
  }

  async function completeOperation({
    request: requestValue,
    response: responseValue,
    issuedAuthorizationClaimSha256,
  } = {}) {
    return serialize(async () => {
      await assertRootStable(state);
      const request = validateControllerRequest(requestValue);
      assertRequestAuthority(request, authority);
      requireRequestAuthorizationClaim(request);
      const response = verifyControllerResponse(responseValue, {
        request,
        controllerIdentitySha256: authority.controllerIdentitySha256,
        controllerVersion: authority.controllerVersion,
        controllerPublicKeyBytes: authority.controllerPublicKeyBytes,
      });
      const issuedClaimSha256 = validateAuthorizationClaimCompletion(
        request,
        response,
        issuedAuthorizationClaimSha256,
      );

      function assertPersistedAuthorizationClaim() {
        const row = authorizationClaimByIssuanceOperation(request.operation.operationId);
        if (issuedClaimSha256 === null) {
          if (row !== undefined) {
            fail(
              "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
              "operation unexpectedly published an authorization claim",
            );
          }
          return null;
        }
        if (row === undefined) {
          fail(
            "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
            "successful authorization claim is not durable",
          );
        }
        const claim = validateAuthorizationClaimRow(row, forbidden, authority, operationById);
        if (
          claim.claimSha256 !== issuedClaimSha256 ||
          claim.environmentId !== request.coordinate.environmentId ||
          claim.pathProfileId !== request.coordinate.pathProfileId
        ) {
          fail(
            "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
            "persisted authorization claim differs from its completion",
          );
        }
        return claim;
      }

      const existing = operationById(request.operation.operationId);
      if (existing === undefined) {
        fail("CONTROLLER_JOURNAL_OPERATION_MISSING", "controller operation intent is missing");
      }
      const current = validateOperationRow(existing, forbidden, authority);
      if (!canonicalEqual(current.request, request)) {
        fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller operation replay differs");
      }
      if (current.response !== null) {
        if (!canonicalEqual(current.response, response)) {
          fail("CONTROLLER_JOURNAL_RESPONSE_COLLISION", "controller terminal response differs");
        }
        assertPersistedAuthorizationClaim();
        return current;
      }
      const executionLease = requireExecutionLease(request);
      for (const reference of [response.payload, ...response.artifacts]) {
        await requireRetainedReference(reference, "controller response artifact");
      }
      const responseJson = canonicalProbeJson(response);
      assertBlobContainsNoSecrets(Buffer.from(responseJson, "utf8"), forbidden);
      const completed = transact(database, () => {
        const latest = operationById(request.operation.operationId);
        if (latest === undefined) {
          fail("CONTROLLER_JOURNAL_OPERATION_MISSING", "controller operation intent is missing");
        }
        const latestRecord = validateOperationRow(latest, forbidden, authority);
        if (!canonicalEqual(latestRecord.request, request)) {
          fail("CONTROLLER_JOURNAL_OPERATION_COLLISION", "controller operation replay differs");
        }
        if (latestRecord.response !== null) {
          if (!canonicalEqual(latestRecord.response, response)) {
            fail("CONTROLLER_JOURNAL_RESPONSE_COLLISION", "controller terminal response differs");
          }
          assertPersistedAuthorizationClaim();
          return latestRecord;
        }
        const changed = sqliteCall(() =>
          database
            .prepare(
              `UPDATE operations
                  SET state = 'complete', response_sha256 = ?, response_json = ?
                WHERE operation_id = ? AND state = 'pending'`,
            )
            .run(response.responseSha256, responseJson, request.operation.operationId),
        );
        if (changed.changes !== 1) {
          fail("CONTROLLER_JOURNAL_RESPONSE_COLLISION", "controller response publication raced");
        }
        if (issuedClaimSha256 !== null) {
          const existingCoordinateClaim = authorizationClaimByCoordinate(
            request.coordinate.environmentId,
            request.coordinate.pathProfileId,
          );
          if (existingCoordinateClaim !== undefined) {
            fail(
              "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
              "controller coordinate already has an issued authorization claim",
            );
          }
          sqliteCall(() =>
            database
              .prepare(
                `INSERT INTO authorization_claims
                  (environment_id, path_profile_id, claim_sha256, issuance_operation_id)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(
                request.coordinate.environmentId,
                request.coordinate.pathProfileId,
                issuedClaimSha256,
                request.operation.operationId,
              ),
          );
        }
        const completed = validateOperationRow(
          operationById(request.operation.operationId),
          forbidden,
          authority,
        );
        assertPersistedAuthorizationClaim();
        return completed;
      });
      await releaseExecutionLease(executionLease);
      return completed;
    });
  }

  async function readOperation(operationId) {
    return serialize(async () => {
      if (
        typeof operationId !== "string" ||
        operationId.length > 128 ||
        !identifierPattern.test(operationId)
      ) {
        fail("CONTROLLER_JOURNAL_OPERATION_ID", "controller operation identifier is invalid");
      }
      await assertRootStable(state);
      const row = operationById(operationId);
      return row === undefined ? null : validateOperationRow(row, forbidden, authority);
    });
  }

  async function scan() {
    return serialize(() => scanInternal());
  }

  async function assertClean() {
    return serialize(async () => {
      const result = await scanInternal();
      if (result.pendingOperationIds.length !== 0) {
        fail("CONTROLLER_JOURNAL_PENDING", "controller journal has pending operations");
      }
      if (result.orphanBlobSha256s.length !== 0) {
        fail("CONTROLLER_JOURNAL_ORPHAN_BLOB", "controller journal has unreferenced blobs");
      }
      return result;
    });
  }

  async function close() {
    if (closed) return;
    let release;
    const turn = new Promise((resolveTurn) => {
      release = resolveTurn;
    });
    const previous = operationTail;
    operationTail = turn;
    await previous;
    try {
      if (closed) return;
      if (activeExecutionLease !== null) {
        await assertJournalTreeStable();
        fail(
          "CONTROLLER_JOURNAL_EXECUTION_ACTIVE",
          "controller journal cannot close while physical execution authority is live",
        );
      }
      let closeError = null;
      try {
        await assertJournalTreeStable();
        const checkpoint = sqliteCall(() => database.prepare("PRAGMA wal_checkpoint(FULL)").get());
        if (
          checkpoint.busy !== 0 ||
          !Number.isSafeInteger(checkpoint.log) ||
          checkpoint.checkpointed !== checkpoint.log
        ) {
          fail("CONTROLLER_JOURNAL_DURABILITY", "controller journal checkpoint is incomplete");
        }
      } catch (error) {
        closeError = error;
      } finally {
        try {
          database.close();
        } catch {
          closeError ??= new ControllerJournalError(
            "CONTROLLER_JOURNAL_SQLITE",
            "controller journal database could not close",
          );
        }
        closed = true;
      }
      if (closeError !== null) throw closeError;
    } finally {
      release();
    }
  }

  return Object.freeze({
    root: state.root,
    controllerIdentitySha256: authority.controllerIdentitySha256,
    claimOperation,
    beginOperation,
    retainBlob,
    readBlob,
    completeOperation,
    readOperation,
    scan,
    assertClean,
    assertRootStable: () => serialize(() => assertRootStable(state)),
    close,
  });
}
