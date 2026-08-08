import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { canonicalProbeJson } from "./probe-contract.mjs";
import { validateProbePreparationTransaction } from "./probe-preflight.mjs";

export const PROBE_CONTRACT_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/probe-contract.mjs";
export const PROBE_REGISTRY_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/probe-registry.mjs";
export const PROBE_TRANSCRIPT_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/probe-transcript.mjs";
export const NATIVE_CLIENT_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/native-client.mjs";
export const NATIVE_MANIFEST_DIGEST_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/native-manifest-digest.mjs";
export const PROBE_VERIFIER_SOURCE_PATHS = Object.freeze([
  PROBE_CONTRACT_SOURCE_PATH,
  PROBE_REGISTRY_SOURCE_PATH,
  PROBE_TRANSCRIPT_SOURCE_PATH,
  NATIVE_CLIENT_SOURCE_PATH,
  NATIVE_MANIFEST_DIGEST_SOURCE_PATH,
]);

const execFileAsync = promisify(execFile);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const forbiddenWindowsPathCharacter = /[<>:"|?*]/u;
const defaultMaximumArtifactBytes = 64 * 1024 * 1024;

export class ProbeAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeAdapterError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("PROBE_ADAPTER_SCHEMA", `${label} must be an object`);
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) fail("PROBE_ADAPTER_SCHEMA", `${label} shape is invalid`);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("PROBE_ADAPTER_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireRepositoryRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[a-z]:/iu.test(value)
  ) {
    fail("PROBE_ADAPTER_PATH", `${label} must be repository-root-relative NFC`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        forbiddenWindowsPathCharacter.test(segment) ||
        [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
        reservedWindowsName.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    fail("PROBE_ADAPTER_PATH", `${label} contains an unsafe path segment`);
  }
  return value;
}

function validateArtifactReferences(sourceHashes) {
  if (!Array.isArray(sourceHashes) || sourceHashes.length === 0) {
    fail("PROBE_ADAPTER_SOURCES", "candidate sourceHashes must be a non-empty array");
  }
  let previous = null;
  const foldedPaths = new Set();
  return sourceHashes.map((reference, index) => {
    assertExactKeys(reference, ["path", "sha256"], `sourceHashes[${index}]`);
    const path = requireRepositoryRelativePath(reference.path, `sourceHashes[${index}].path`);
    const sha256 = requireSha256(reference.sha256, `sourceHashes[${index}].sha256`);
    if (previous !== null && compareUtf8(previous, path) >= 0) {
      fail("PROBE_ADAPTER_SOURCE_ORDER", "candidate sourceHashes must be strictly path sorted");
    }
    const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) {
      fail("PROBE_ADAPTER_CASE_COLLISION", "candidate sourceHashes contain a case collision");
    }
    foldedPaths.add(folded);
    previous = path;
    return Object.freeze({ path, sha256 });
  });
}

function requirePlainDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("PROBE_ADAPTER_REPARSE", `${label} is not a plain directory`);
  }
}

function rootFingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
}

function fileFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mode,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(":");
}

function pathWithin(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

async function openStableFilesystemRoot(root, maximumArtifactBytes) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("PROBE_ADAPTER_ROOT", "artifact root must be an absolute path");
  }
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1) {
    fail("PROBE_ADAPTER_BOUND", "maximumArtifactBytes must be a positive safe integer");
  }
  const requestedRoot = resolve(root);
  const requested = await lstat(requestedRoot);
  requirePlainDirectory(requested, "artifact root");
  const canonicalRoot = await realpath(requestedRoot);
  const initial = await lstat(canonicalRoot);
  requirePlainDirectory(initial, "artifact root");
  const fingerprint = rootFingerprint(initial);

  async function assertRootStable() {
    const current = await lstat(canonicalRoot);
    requirePlainDirectory(current, "artifact root");
    if (
      rootFingerprint(current) !== fingerprint ||
      (await realpath(canonicalRoot)) !== canonicalRoot
    ) {
      fail("PROBE_ADAPTER_ROOT_CHANGED", "artifact root identity changed");
    }
  }

  async function resolvePlainFile(relativePath) {
    requireRepositoryRelativePath(relativePath, "artifact path");
    await assertRootStable();
    const segments = relativePath.split("/");
    let current = canonicalRoot;
    for (const [index, segment] of segments.entries()) {
      const entries = await readdir(current, { withFileTypes: true });
      const folded = segment.normalize("NFC").toLocaleLowerCase("en-US");
      const foldedMatches = entries.filter(
        (entry) => entry.name.normalize("NFC").toLocaleLowerCase("en-US") === folded,
      );
      if (foldedMatches.length !== 1 || foldedMatches[0].name !== segment) {
        fail("PROBE_ADAPTER_CASE_COLLISION", "artifact path has a missing or case-colliding entry");
      }
      current = join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        fail("PROBE_ADAPTER_REPARSE", "artifact path traverses a symlink or reparse point");
      }
      if (index < segments.length - 1) requirePlainDirectory(stat, "artifact ancestor");
      else if (!stat.isFile()) fail("PROBE_ADAPTER_FILE", "artifact is not a regular file");
    }
    const canonicalFile = await realpath(current);
    if (!pathWithin(canonicalRoot, canonicalFile) || canonicalFile !== current) {
      fail("PROBE_ADAPTER_REPARSE", "artifact path resolves outside its plain path");
    }
    return current;
  }

  async function read(relativePath) {
    const absolutePath = await resolvePlainFile(relativePath);
    const before = await lstat(absolutePath);
    if (before.size > maximumArtifactBytes) {
      fail("PROBE_ADAPTER_BOUND", "artifact exceeds its byte bound");
    }
    const handle = await open(absolutePath, "r");
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || fileFingerprint(before) !== fileFingerprint(openedBefore)) {
        fail("PROBE_ADAPTER_FILE_CHANGED", "artifact changed while opened");
      }
      const bytes = await handle.readFile();
      const openedAfter = await handle.stat();
      const pathAfter = await lstat(absolutePath);
      if (
        bytes.length > maximumArtifactBytes ||
        bytes.length !== openedAfter.size ||
        fileFingerprint(openedBefore) !== fileFingerprint(openedAfter) ||
        fileFingerprint(openedAfter) !== fileFingerprint(pathAfter)
      ) {
        fail("PROBE_ADAPTER_FILE_CHANGED", "artifact changed while read");
      }
      await assertRootStable();
      return Buffer.from(bytes);
    } finally {
      await handle.close();
    }
  }

  return Object.freeze({ root: canonicalRoot, read });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateReference(reference, label = "artifact reference") {
  assertExactKeys(reference, ["path", "sha256"], label);
  return {
    path: requireRepositoryRelativePath(reference.path, `${label}.path`),
    sha256: requireSha256(reference.sha256, `${label}.sha256`),
  };
}

async function readExpectedFilesystemArtifact(root, reference) {
  const expected = validateReference(reference);
  const bytes = await root.read(expected.path);
  const observedSha256 = sha256(bytes);
  if (observedSha256 !== expected.sha256) {
    fail("PROBE_ADAPTER_ARTIFACT_DRIFT", `artifact digest changed: ${expected.path}`);
  }
  return Object.freeze({
    path: expected.path,
    sha256: observedSha256,
    bytes,
    stableRead: true,
    regularFile: true,
  });
}

export async function createProbeFilesystemArtifactReader({
  root,
  maximumArtifactBytes = defaultMaximumArtifactBytes,
}) {
  const filesystemRoot = await openStableFilesystemRoot(root, maximumArtifactBytes);
  return async (reference) => readExpectedFilesystemArtifact(filesystemRoot, reference);
}

export function createProbeEvidenceStoreArtifactReader({ store }) {
  requireEvidenceStore(store);
  return async (reference) => {
    const expected = validateReference(reference);
    const artifact = await store.readArtifact(expected.path);
    if (artifact.path !== expected.path || artifact.sha256 !== expected.sha256) {
      fail("PROBE_ADAPTER_ARTIFACT_DRIFT", `retained artifact changed: ${expected.path}`);
    }
    return Object.freeze({
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: Buffer.from(artifact.bytes),
      stableRead: true,
      regularFile: true,
    });
  };
}

function requireEvidenceStore(store) {
  if (
    !exactObject(store) ||
    typeof store.root !== "string" ||
    !isAbsolute(store.root) ||
    typeof store.createDirectory !== "function" ||
    typeof store.writeCanonicalJson !== "function" ||
    typeof store.readArtifact !== "function" ||
    typeof store.assertRootStable !== "function"
  ) {
    fail("PROBE_ADAPTER_STORE", "an evidence store is required");
  }
  return store;
}

export async function readProbeCandidateSourceHashes({ repositoryRoot, sourceHashes }) {
  const references = validateArtifactReferences(sourceHashes);
  const root = await openStableFilesystemRoot(repositoryRoot, defaultMaximumArtifactBytes);
  const observed = [];
  for (const reference of references) {
    const bytes = await root.read(reference.path);
    observed.push(Object.freeze({ path: reference.path, sha256: sha256(bytes) }));
  }
  return Object.freeze(observed);
}

export async function createProbeCandidateSourceReaders({ repositoryRoot }) {
  const root = await openStableFilesystemRoot(repositoryRoot, defaultMaximumArtifactBytes);
  return Object.freeze({
    readContractSource: async () => root.read(PROBE_CONTRACT_SOURCE_PATH),
    readVerifierSource: async () => root.read(PROBE_REGISTRY_SOURCE_PATH),
    readTranscriptSource: async () => root.read(PROBE_TRANSCRIPT_SOURCE_PATH),
    readNativeClientSource: async () => root.read(NATIVE_CLIENT_SOURCE_PATH),
    readNativeManifestDigestSource: async () => root.read(NATIVE_MANIFEST_DIGEST_SOURCE_PATH),
  });
}

async function readGitRepositoryIdentity(repositoryRoot) {
  try {
    const [commitResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }),
      execFileAsync(
        "git",
        [
          "-C",
          repositoryRoot,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      ),
    ]);
    return {
      repositoryCommit: commitResult.stdout.trim(),
      repositoryDirty: statusResult.stdout.length > 0,
    };
  } catch {
    fail("PROBE_ADAPTER_GIT", "repository identity could not be read with git");
  }
}

function validateRepositoryIdentity(value) {
  assertExactKeys(value, ["repositoryCommit", "repositoryDirty"], "repository identity");
  if (typeof value.repositoryCommit !== "string" || !commitPattern.test(value.repositoryCommit)) {
    fail("PROBE_ADAPTER_COMMIT", "repository commit must be lowercase 40-hex");
  }
  if (typeof value.repositoryDirty !== "boolean") {
    fail("PROBE_ADAPTER_GIT", "repository dirty state must be boolean");
  }
  return value;
}

export async function createProbeRepositoryStateReader({
  repositoryRoot,
  sourceHashes,
  readRepositoryIdentity = readGitRepositoryIdentity,
}) {
  const references = validateArtifactReferences(sourceHashes);
  const root = await openStableFilesystemRoot(repositoryRoot, defaultMaximumArtifactBytes);
  if (typeof readRepositoryIdentity !== "function") {
    fail("PROBE_ADAPTER_GIT", "readRepositoryIdentity must be a function");
  }
  return async () => {
    const identityBefore = validateRepositoryIdentity(await readRepositoryIdentity(root.root));
    const observed = [];
    for (const reference of references) {
      const bytes = await root.read(reference.path);
      observed.push(Object.freeze({ path: reference.path, sha256: sha256(bytes) }));
    }
    const identityAfter = validateRepositoryIdentity(await readRepositoryIdentity(root.root));
    if (
      identityBefore.repositoryCommit !== identityAfter.repositoryCommit ||
      identityBefore.repositoryDirty !== identityAfter.repositoryDirty
    ) {
      fail("PROBE_ADAPTER_SOURCE_DRIFT", "repository identity changed during source hashing");
    }
    return Object.freeze({
      repositoryCommit: identityAfter.repositoryCommit,
      repositoryDirty: identityAfter.repositoryDirty,
      sourceHashes: Object.freeze(observed),
    });
  };
}

function parseCanonicalObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("PROBE_ADAPTER_CANONICAL", `${label} is not JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== bytes.toString("utf8")) {
    fail("PROBE_ADAPTER_CANONICAL", `${label} is not canonical JSON`);
  }
  return value;
}

async function createDirectoryIfAbsent(store, path) {
  try {
    await store.createDirectory(path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function validateRetainedPreparationTransaction(value, requestSha256) {
  let transaction;
  try {
    transaction = validateProbePreparationTransaction(value);
  } catch {
    fail("PROBE_ADAPTER_PREPARATION_COLLISION", "preparation transaction is invalid");
  }
  if (transaction.requestSha256 !== requestSha256) {
    fail(
      "PROBE_ADAPTER_PREPARATION_COLLISION",
      "preparation transaction belongs to another request",
    );
  }
  return transaction;
}

export function createProbePreparationTransactionPersistence({ store }) {
  requireEvidenceStore(store);
  return async (value) => {
    let transaction;
    try {
      transaction = validateProbePreparationTransaction(value);
    } catch {
      fail("PROBE_ADAPTER_PREPARATION", "preparation transaction is invalid");
    }
    await createDirectoryIfAbsent(store, "preflight");
    await createDirectoryIfAbsent(store, "preflight/preparation-transactions");
    const path = `preflight/preparation-transactions/${transaction.requestSha256}.json`;
    try {
      await store.writeCanonicalJson(path, transaction);
      return Object.freeze({ transaction, reused: false });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const artifact = await store.readArtifact(path);
      const retained = validateRetainedPreparationTransaction(
        parseCanonicalObject(artifact.bytes, "preparation transaction"),
        transaction.requestSha256,
      );
      return Object.freeze({ transaction: retained, reused: true });
    }
  };
}

export function createProbePreparationTransactionReader({ store }) {
  requireEvidenceStore(store);
  return async (requestSha256) => {
    requireSha256(requestSha256, "preparation requestSha256");
    const path = `preflight/preparation-transactions/${requestSha256}.json`;
    await store.assertRootStable();
    let artifact;
    try {
      artifact = await store.readArtifact(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (artifact.path !== path) {
      fail(
        "PROBE_ADAPTER_PREPARATION_COLLISION",
        "preparation transaction resolved to another path",
      );
    }
    return validateRetainedPreparationTransaction(
      parseCanonicalObject(artifact.bytes, "preparation transaction"),
      requestSha256,
    );
  };
}

function validateControllerTransportMethods(controllerTransport, methodNames, label) {
  if (!exactObject(controllerTransport)) {
    fail("PROBE_ADAPTER_CONTROLLER", `${label} controller transport must be an object`);
  }
  for (const methodName of methodNames) {
    if (typeof controllerTransport[methodName] !== "function") {
      fail("PROBE_ADAPTER_CONTROLLER", `${label} controller transport is missing ${methodName}`);
    }
  }
  return controllerTransport;
}

function validatePreflightControllerTransport(controllerTransport) {
  return validateControllerTransportMethods(
    controllerTransport,
    ["observeController"],
    "preflight",
  );
}

function validateFinalizerControllerTransport(controllerTransport) {
  return validateControllerTransportMethods(
    controllerTransport,
    [
      "recoverOrAcquireEvidenceQuiescence",
      "renewEvidenceQuiescence",
      "captureQuiescedEvidenceSeal",
      "completeEvidenceQuiescence",
      "abandonEvidenceQuiescence",
    ],
    "finalizer",
  );
}

function validateFinalizerRequest(value, keys, label) {
  assertExactKeys(value, keys, label);
  return value;
}

function validateFinalizationIntent(value, label) {
  if (!exactObject(value)) {
    fail("PROBE_ADAPTER_CONTROLLER", `${label} must be an object`);
  }
  return value;
}

function validateLeaseReceipt(value, label) {
  if (!exactObject(value)) {
    fail("PROBE_ADAPTER_CONTROLLER", `${label} must be an object`);
  }
  return value;
}

function validateRecoverOrAcquireResponse(value) {
  assertExactKeys(
    value,
    ["acquisitionReceipt", "leaseReceipt", "completionReceipt"],
    "recover-or-acquire response",
  );
  validateLeaseReceipt(value.acquisitionReceipt, "recover-or-acquire acquisitionReceipt");
  validateLeaseReceipt(value.leaseReceipt, "recover-or-acquire leaseReceipt");
  if (value.completionReceipt !== null && !exactObject(value.completionReceipt)) {
    fail(
      "PROBE_ADAPTER_CONTROLLER",
      "recover-or-acquire completionReceipt must be an object or null",
    );
  }
  return value;
}

function validateCaptureResponse(value) {
  assertExactKeys(value, ["nativeSeal", "controllerReceipt"], "evidence capture response");
  if (!exactObject(value.nativeSeal) || !exactObject(value.controllerReceipt)) {
    fail("PROBE_ADAPTER_CONTROLLER", "evidence capture response is incomplete");
  }
  return value;
}

function validateSegmentProof(value) {
  assertExactKeys(
    value,
    [
      "segmentPath",
      "segmentSha256",
      "segmentArtifactSha256",
      "verificationInputSha256",
      "outcomeEvidenceSha256",
    ],
    "quiescence completion segmentProof",
  );
  requireRepositoryRelativePath(value.segmentPath, "quiescence completion segmentProof.path");
  for (const key of [
    "segmentSha256",
    "segmentArtifactSha256",
    "verificationInputSha256",
    "outcomeEvidenceSha256",
  ]) {
    requireSha256(value[key], `quiescence completion segmentProof.${key}`);
  }
  return value;
}

function requireCandidateVerifierSources(sourceHashes) {
  const references = validateArtifactReferences(sourceHashes);
  for (const path of PROBE_VERIFIER_SOURCE_PATHS) {
    if (!references.some((reference) => reference.path === path)) {
      fail("PROBE_ADAPTER_CANDIDATE", `candidate sourceHashes is missing ${path}`);
    }
  }
}

export async function createProbePreflightReaders({
  store,
  repositoryRoot,
  binaryRoot = repositoryRoot,
  candidate,
  observeGuest,
  observeBrokerMailbox,
  controllerTransport,
  readRepositoryIdentity = readGitRepositoryIdentity,
}) {
  requireEvidenceStore(store);
  if (!exactObject(candidate)) fail("PROBE_ADAPTER_CANDIDATE", "candidate is required");
  if (typeof observeGuest !== "function") {
    fail("PROBE_ADAPTER_GUEST", "observeGuest must be an injected function");
  }
  if (typeof observeBrokerMailbox !== "function") {
    fail("PROBE_ADAPTER_BROKER_MAILBOX", "observeBrokerMailbox must be an injected function");
  }
  const transport = validatePreflightControllerTransport(controllerTransport);
  requireCandidateVerifierSources(candidate.sourceHashes);
  const readRepositoryState = await createProbeRepositoryStateReader({
    repositoryRoot,
    sourceHashes: candidate.sourceHashes,
    readRepositoryIdentity,
  });
  const readVerifiedEvidenceArtifact = createProbeEvidenceStoreArtifactReader({ store });
  const readVerifiedBinaryArtifact = await createProbeFilesystemArtifactReader({
    root: binaryRoot,
  });
  const readPreparationTransaction = createProbePreparationTransactionReader({ store });
  const persistPreparation = createProbePreparationTransactionPersistence({ store });
  return Object.freeze({
    readRepositoryState,
    observeGuest: async (request) => {
      await store.assertRootStable();
      return observeGuest(Object.freeze({ request, evidenceRoot: store.root }));
    },
    observeBrokerMailbox: async (enrollment, request) => {
      await store.assertRootStable();
      return observeBrokerMailbox(Object.freeze({ enrollment, request, evidenceRoot: store.root }));
    },
    observeController: async (request) => {
      await store.assertRootStable();
      return transport.observeController(Object.freeze({ request, evidenceRoot: store.root }));
    },
    readVerifiedEvidenceArtifact,
    readVerifiedBinaryArtifact,
    readPreparationTransaction,
    persistPreparation,
  });
}

export async function createProbeFinalizerAdapters({
  store,
  repositoryRoot,
  candidate,
  controllerTransport,
  readRepositoryIdentity = readGitRepositoryIdentity,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
}) {
  requireEvidenceStore(store);
  if (!exactObject(candidate)) fail("PROBE_ADAPTER_CANDIDATE", "candidate is required");
  if (typeof now !== "function" || typeof monotonicNow !== "function") {
    fail("PROBE_ADAPTER_CLOCK", "finalizer clocks must be functions");
  }
  const transport = validateFinalizerControllerTransport(controllerTransport);
  requireCandidateVerifierSources(candidate.sourceHashes);
  const readRepositoryState = await createProbeRepositoryStateReader({
    repositoryRoot,
    sourceHashes: candidate.sourceHashes,
    readRepositoryIdentity,
  });
  const sourceReaders = await createProbeCandidateSourceReaders({ repositoryRoot });
  return Object.freeze({
    readRepositoryState,
    readVerifierSource: sourceReaders.readVerifierSource,
    readContractSource: sourceReaders.readContractSource,
    readTranscriptSource: sourceReaders.readTranscriptSource,
    readNativeClientSource: sourceReaders.readNativeClientSource,
    readNativeManifestDigestSource: sourceReaders.readNativeManifestDigestSource,
    now,
    monotonicNow,
    recoverOrAcquireEvidenceQuiescence: async (request) => {
      validateFinalizerRequest(request, ["finalizationIntent"], "recover-or-acquire request");
      validateFinalizationIntent(
        request.finalizationIntent,
        "recover-or-acquire finalizationIntent",
      );
      await store.assertRootStable();
      const response = await transport.recoverOrAcquireEvidenceQuiescence(
        Object.freeze({
          finalizationIntent: request.finalizationIntent,
          evidenceRoot: store.root,
        }),
      );
      return validateRecoverOrAcquireResponse(response);
    },
    renewEvidenceQuiescence: async (request) => {
      validateFinalizerRequest(
        request,
        ["finalizationIntent", "previousLeaseReceipt", "purpose"],
        "lease renewal request",
      );
      validateFinalizationIntent(request.finalizationIntent, "lease renewal finalizationIntent");
      validateLeaseReceipt(request.previousLeaseReceipt, "lease renewal previousLeaseReceipt");
      if (request.purpose !== "capture" && request.purpose !== "completion") {
        fail("PROBE_ADAPTER_CONTROLLER", "lease renewal purpose is invalid");
      }
      await store.assertRootStable();
      const receipt = await transport.renewEvidenceQuiescence(
        Object.freeze({
          finalizationIntent: request.finalizationIntent,
          previousLeaseReceipt: request.previousLeaseReceipt,
          purpose: request.purpose,
          evidenceRoot: store.root,
        }),
      );
      return validateLeaseReceipt(receipt, "lease renewal receipt");
    },
    captureQuiescedEvidenceSeal: async (binding) => {
      validateFinalizerRequest(
        binding,
        [
          "finalizationIntent",
          "quiescenceLease",
          "campaignId",
          "manifestSha256",
          "candidateSha256",
          "campaignRunId",
          "executionRunId",
          "executionBundleId",
          "executionBundleManifestSha256",
          "attemptId",
          "environmentId",
          "pathProfileId",
          "rowId",
          "variantId",
          "exactArtifactPaths",
        ],
        "evidence capture binding",
      );
      validateFinalizationIntent(binding.finalizationIntent, "capture finalizationIntent");
      validateLeaseReceipt(binding.quiescenceLease, "capture quiescenceLease");
      await store.assertRootStable();
      return validateCaptureResponse(
        await transport.captureQuiescedEvidenceSeal(
          Object.freeze({ binding, evidenceRoot: store.root }),
        ),
      );
    },
    completeEvidenceQuiescence: async (request) => {
      validateFinalizerRequest(
        request,
        ["finalizationIntent", "leaseReceipt", "evidenceCaptureReceiptSha256", "segmentProof"],
        "quiescence completion request",
      );
      validateFinalizationIntent(
        request.finalizationIntent,
        "quiescence completion finalizationIntent",
      );
      validateLeaseReceipt(request.leaseReceipt, "quiescence completion leaseReceipt");
      requireSha256(
        request.evidenceCaptureReceiptSha256,
        "quiescence completion evidenceCaptureReceiptSha256",
      );
      validateSegmentProof(request.segmentProof);
      await store.assertRootStable();
      const receipt = await transport.completeEvidenceQuiescence(
        Object.freeze({
          finalizationIntent: request.finalizationIntent,
          leaseReceipt: request.leaseReceipt,
          evidenceCaptureReceiptSha256: request.evidenceCaptureReceiptSha256,
          segmentProof: request.segmentProof,
          evidenceRoot: store.root,
        }),
      );
      return validateLeaseReceipt(receipt, "quiescence completion receipt");
    },
    abandonEvidenceQuiescence: async (request) => {
      validateFinalizerRequest(
        request,
        ["finalizationIntent", "leaseReceipt", "reasonCode"],
        "quiescence abandonment request",
      );
      validateFinalizationIntent(
        request.finalizationIntent,
        "quiescence abandonment finalizationIntent",
      );
      validateLeaseReceipt(request.leaseReceipt, "quiescence abandonment leaseReceipt");
      if (typeof request.reasonCode !== "string" || request.reasonCode.length === 0) {
        fail("PROBE_ADAPTER_CONTROLLER", "quiescence abandonment reasonCode is invalid");
      }
      await store.assertRootStable();
      const receipt = await transport.abandonEvidenceQuiescence(
        Object.freeze({
          finalizationIntent: request.finalizationIntent,
          leaseReceipt: request.leaseReceipt,
          reasonCode: request.reasonCode,
          evidenceRoot: store.root,
        }),
      );
      return validateLeaseReceipt(receipt, "quiescence abandonment receipt");
    },
  });
}
