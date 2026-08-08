import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NATIVE_COMMANDS } from "./native-client.mjs";
import {
  PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES,
  deriveProbeNativeActionPlanStepOperationId,
  validateProbeNativeActionPlan,
} from "./probe-native-action-plan.mjs";
import { PROBE_CAMPAIGN_ID, canonicalProbeJson } from "./probe-contract.mjs";

export const PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION = 1;
export const PROBE_NATIVE_OPERATION_INTENT_KIND = "windows-host-probe-native-operation-intent";
export const PROBE_NATIVE_OPERATION_TRANSITION_KIND =
  "windows-host-probe-native-operation-transition";
export const PROBE_NATIVE_OPERATION_RECOVERY_DECISION_KIND =
  "windows-host-probe-native-operation-recovery-decision";
export const PROBE_NATIVE_OPERATION_RECOVERY_CLASSES = PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES;
export const PROBE_NATIVE_OPERATION_STATES = Object.freeze([
  "claim",
  "effect-started",
  "transcript-retained",
  "terminal-result-retained",
]);
export const PROBE_NATIVE_OPERATION_RECOVERY_DECISIONS = Object.freeze([
  "CLAIM_BEFORE_EXECUTION",
  "EXECUTE",
  "RESUME_RETAINED_TRANSCRIPT",
  "REPLAY_READ_ONLY",
  "INSPECT_AND_RECONCILE",
  "INCONCLUSIVE",
  "RETURN_RETAINED_RESULT",
]);

const intentDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "operationId",
  "actionPlanSha256",
  "stepId",
  "command",
  "inputSha256",
  "recoveryClass",
]);
const transitionDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "operationId",
  "intentSha256",
  "sequence",
  "state",
  "artifactSha256",
  "previousRecordSha256",
]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const databaseLeaf = "native-operation-journal.sqlite";
const executionLeaseDatabaseLeaf = "native-operation-execution-lease.sqlite";
const metadataTableSql = [
  "CREATE TABLE native_operation_metadata (",
  "  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),",
  "  schema_version INTEGER NOT NULL,",
  "  kind TEXT NOT NULL,",
  "  campaign_id TEXT NOT NULL",
  ") STRICT",
].join("\n");
const operationsTableSql = [
  "CREATE TABLE native_operations (",
  "  operation_id TEXT PRIMARY KEY,",
  "  intent_sha256 TEXT NOT NULL UNIQUE,",
  "  action_plan_sha256 TEXT NOT NULL,",
  "  input_sha256 TEXT NOT NULL,",
  "  recovery_class TEXT NOT NULL CHECK (recovery_class IN ('read-only-replay', 'inspect-and-reconcile', 'never-auto-replay')),",
  "  intent_json TEXT NOT NULL",
  ") STRICT",
].join("\n");
const transitionsTableSql = [
  "CREATE TABLE native_operation_transitions (",
  "  operation_id TEXT NOT NULL REFERENCES native_operations(operation_id),",
  "  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4),",
  "  state TEXT NOT NULL CHECK (state IN ('claim', 'effect-started', 'transcript-retained', 'terminal-result-retained')),",
  "  artifact_sha256 TEXT,",
  "  previous_record_sha256 TEXT,",
  "  record_sha256 TEXT NOT NULL UNIQUE,",
  "  record_json TEXT NOT NULL,",
  "  PRIMARY KEY (operation_id, sequence),",
  "  UNIQUE (operation_id, state),",
  "  CHECK (",
  "    (state IN ('claim', 'effect-started') AND artifact_sha256 IS NULL) OR",
  "    (state IN ('transcript-retained', 'terminal-result-retained') AND artifact_sha256 IS NOT NULL)",
  "  ),",
  "  CHECK (",
  "    (sequence = 1 AND previous_record_sha256 IS NULL) OR",
  "    (sequence > 1 AND previous_record_sha256 IS NOT NULL)",
  "  )",
  ") STRICT",
].join("\n");
const appendOnlyTriggers = Object.freeze({
  native_operation_metadata_no_delete: [
    "CREATE TRIGGER native_operation_metadata_no_delete",
    "BEFORE DELETE ON native_operation_metadata",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
  native_operation_metadata_no_update: [
    "CREATE TRIGGER native_operation_metadata_no_update",
    "BEFORE UPDATE ON native_operation_metadata",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
  native_operations_no_delete: [
    "CREATE TRIGGER native_operations_no_delete",
    "BEFORE DELETE ON native_operations",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
  native_operations_no_update: [
    "CREATE TRIGGER native_operations_no_update",
    "BEFORE UPDATE ON native_operations",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
  native_operation_transitions_no_delete: [
    "CREATE TRIGGER native_operation_transitions_no_delete",
    "BEFORE DELETE ON native_operation_transitions",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
  native_operation_transitions_no_update: [
    "CREATE TRIGGER native_operation_transitions_no_update",
    "BEFORE UPDATE ON native_operation_transitions",
    "BEGIN",
    "  SELECT RAISE(ABORT, 'native operation journal is append-only');",
    "END",
  ].join("\n"),
});
const databaseSchemaObjects = Object.freeze(
  [
    ["native_operation_metadata", "table", metadataTableSql],
    ["native_operations", "table", operationsTableSql],
    ["native_operation_transitions", "table", transitionsTableSql],
    ...Object.entries(appendOnlyTriggers).map(([name, sql]) => [name, "trigger", sql]),
  ].map(([name, type, sql]) => Object.freeze({ name, type, sql })),
);
const databaseSchemaByName = new Map(
  databaseSchemaObjects.map((definition) => [definition.name, definition]),
);
const defaultLimits = Object.freeze({ maxOperations: 16384 });

export class ProbeNativeOperationJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeNativeOperationJournalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeNativeOperationJournalError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) {
    fail("NATIVE_OPERATION_JOURNAL_SCHEMA", label + " must be a plain object");
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("NATIVE_OPERATION_JOURNAL_SCHEMA", label + " has an invalid field set");
  }
  const expected = [...keys].sort(compareUtf8);
  actual.sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("NATIVE_OPERATION_JOURNAL_SCHEMA", label + " has an invalid field set");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("NATIVE_OPERATION_JOURNAL_SCHEMA", label + " fields must be enumerable data");
    }
  }
}

function assertIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    value.normalize("NFC") !== value ||
    !identifierPattern.test(value)
  ) {
    fail("NATIVE_OPERATION_JOURNAL_IDENTIFIER", label + " must be a bounded protocol identifier");
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("NATIVE_OPERATION_JOURNAL_SHA256", label + " must be a lowercase SHA-256 digest");
  }
}

function validateIntentPayload(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest ? [...intentDraftKeys, "intentSha256"] : intentDraftKeys,
    "native operation intent",
  );
  if (
    value.schemaVersion !== PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION ||
    value.kind !== PROBE_NATIVE_OPERATION_INTENT_KIND ||
    value.campaignId !== PROBE_CAMPAIGN_ID
  ) {
    fail("NATIVE_OPERATION_JOURNAL_BINDING", "native operation intent campaign binding is invalid");
  }
  assertIdentifier(value.operationId, "native operation intent operationId");
  assertSha256(value.actionPlanSha256, "native operation intent actionPlanSha256");
  assertIdentifier(value.stepId, "native operation intent stepId");
  if (!NATIVE_COMMANDS.includes(value.command)) {
    fail("NATIVE_OPERATION_JOURNAL_COMMAND", "native operation intent command is not allowlisted");
  }
  assertSha256(value.inputSha256, "native operation intent inputSha256");
  if (!PROBE_NATIVE_OPERATION_RECOVERY_CLASSES.includes(value.recoveryClass)) {
    fail(
      "NATIVE_OPERATION_JOURNAL_RECOVERY_CLASS",
      "native operation intent recovery class is invalid",
    );
  }
  if (includeDigest) {
    assertSha256(value.intentSha256, "native operation intent intentSha256");
  }
  return value;
}

function intentDigestPayload(value) {
  const includesDigest = exactObject(value) && Object.hasOwn(value, "intentSha256");
  validateIntentPayload(value, includesDigest);
  const result = {};
  for (const key of intentDraftKeys) result[key] = value[key];
  return result;
}

export function deriveProbeNativeOperationIntentSha256(value) {
  return sha256(
    Buffer.from(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-native-operation-intent.v1",
        intent: intentDigestPayload(value),
      }),
      "utf8",
    ),
  );
}

export function validateProbeNativeOperationIntent(value) {
  validateIntentPayload(value, true);
  if (value.intentSha256 !== deriveProbeNativeOperationIntentSha256(value)) {
    fail(
      "NATIVE_OPERATION_JOURNAL_INTENT_DIGEST",
      "native operation intent digest is inconsistent",
    );
  }
  return Object.freeze({ ...value });
}

export function createProbeNativeOperationIntent(value) {
  assertExactKeys(
    value,
    ["actionPlan", "stepId", "inputSha256"],
    "native operation intent creation input",
  );
  const actionPlan = validateProbeNativeActionPlan(value.actionPlan);
  assertIdentifier(value.stepId, "native operation intent creation stepId");
  assertSha256(value.inputSha256, "native operation intent creation inputSha256");
  const step = actionPlan.steps.find((entry) => entry.stepId === value.stepId);
  if (step === undefined) {
    fail(
      "NATIVE_OPERATION_JOURNAL_ACTION_PLAN",
      "native operation intent step is absent from its action plan",
    );
  }
  const draft = {
    schemaVersion: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
    kind: PROBE_NATIVE_OPERATION_INTENT_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    operationId: deriveProbeNativeActionPlanStepOperationId(actionPlan, step.stepId),
    actionPlanSha256: actionPlan.actionPlanSha256,
    stepId: step.stepId,
    command: step.command,
    inputSha256: value.inputSha256,
    recoveryClass: step.recoveryClass,
  };
  return validateProbeNativeOperationIntent({
    ...draft,
    intentSha256: deriveProbeNativeOperationIntentSha256(draft),
  });
}

function validateTransitionPayload(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest ? [...transitionDraftKeys, "recordSha256"] : transitionDraftKeys,
    "native operation transition",
  );
  if (
    value.schemaVersion !== PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION ||
    value.kind !== PROBE_NATIVE_OPERATION_TRANSITION_KIND
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_TRANSITION_BINDING",
      "native operation transition binding is invalid",
    );
  }
  assertIdentifier(value.operationId, "native operation transition operationId");
  assertSha256(value.intentSha256, "native operation transition intentSha256");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 4) {
    fail("NATIVE_OPERATION_JOURNAL_SEQUENCE", "native operation transition sequence is invalid");
  }
  if (
    !PROBE_NATIVE_OPERATION_STATES.includes(value.state) ||
    PROBE_NATIVE_OPERATION_STATES.indexOf(value.state) + 1 !== value.sequence
  ) {
    fail("NATIVE_OPERATION_JOURNAL_STATE", "native operation transition state is not monotonic");
  }
  if (value.sequence === 1) {
    if (value.previousRecordSha256 !== null) {
      fail("NATIVE_OPERATION_JOURNAL_CHAIN", "claim transition cannot have a predecessor");
    }
  } else {
    assertSha256(value.previousRecordSha256, "native operation transition previousRecordSha256");
  }
  if (value.state === "claim" || value.state === "effect-started") {
    if (value.artifactSha256 !== null) {
      fail(
        "NATIVE_OPERATION_JOURNAL_ARTIFACT",
        "native operation transition cannot bind an artifact",
      );
    }
  } else {
    assertSha256(value.artifactSha256, "native operation transition artifactSha256");
  }
  if (includeDigest) {
    assertSha256(value.recordSha256, "native operation transition recordSha256");
  }
  return value;
}

function transitionDigestPayload(value) {
  const includesDigest = exactObject(value) && Object.hasOwn(value, "recordSha256");
  validateTransitionPayload(value, includesDigest);
  const result = {};
  for (const key of transitionDraftKeys) result[key] = value[key];
  return result;
}

export function deriveProbeNativeOperationTransitionSha256(value) {
  return sha256(
    Buffer.from(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-native-operation-transition.v1",
        transition: transitionDigestPayload(value),
      }),
      "utf8",
    ),
  );
}

export function validateProbeNativeOperationTransition(value) {
  validateTransitionPayload(value, true);
  if (value.recordSha256 !== deriveProbeNativeOperationTransitionSha256(value)) {
    fail(
      "NATIVE_OPERATION_JOURNAL_TRANSITION_DIGEST",
      "native operation transition digest is inconsistent",
    );
  }
  return Object.freeze({ ...value });
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function normalizeSql(value) {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function sqliteCall(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProbeNativeOperationJournalError) throw error;
    fail("NATIVE_OPERATION_JOURNAL_SQLITE", "native operation journal database operation failed");
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
      fail("NATIVE_OPERATION_JOURNAL_SQLITE", "native operation journal rollback failed");
    }
    throw error;
  }
}

function objectFingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
}

function sameCanonicalPath(left, right) {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function requirePrivateOwned(stat, label) {
  if (process.platform === "win32") return;
  if ((stat.mode & 0o077) !== 0) {
    fail("NATIVE_OPERATION_JOURNAL_PERMISSIONS", label + " permissions are not private");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("NATIVE_OPERATION_JOURNAL_OWNER", label + " is owned by another user");
  }
}

function requirePlainDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("NATIVE_OPERATION_JOURNAL_REPARSE", label + " must be a plain directory");
  }
}

function requirePlainFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("NATIVE_OPERATION_JOURNAL_REPARSE", label + " must be a regular file");
  }
  if (stat.nlink !== 1) {
    fail("NATIVE_OPERATION_JOURNAL_HARD_LINK", label + " must have one filesystem link");
  }
  requirePrivateOwned(stat, label);
}

async function inspectRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("NATIVE_OPERATION_JOURNAL_ROOT", "native operation journal root must be an absolute path");
  }
  const resolvedRoot = resolve(root);
  const stat = await lstat(resolvedRoot);
  requirePlainDirectory(stat, "native operation journal root");
  requirePrivateOwned(stat, "native operation journal root");
  const canonicalRoot = await realpath(resolvedRoot);
  if (!sameCanonicalPath(canonicalRoot, resolvedRoot)) {
    fail("NATIVE_OPERATION_JOURNAL_REPARSE", "native operation journal root must not be aliased");
  }
  return Object.freeze({
    root: resolvedRoot,
    canonicalRoot,
    fingerprint: objectFingerprint(stat),
    device: stat.dev,
  });
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

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareDatabaseFile(state, databasePath, label) {
  const existing = await lstatIfPresent(databasePath);
  if (existing !== null) {
    requirePlainFile(existing, label);
    if (existing.dev !== state.device) {
      fail("NATIVE_OPERATION_JOURNAL_FILESYSTEM", label + " changed filesystem");
    }
    return false;
  }
  let handle;
  try {
    handle = await open(databasePath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await lstat(databasePath);
    requirePlainFile(raced, label);
    if (raced.dev !== state.device) {
      fail("NATIVE_OPERATION_JOURNAL_FILESYSTEM", label + " changed filesystem");
    }
    return false;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryMetadata(state.root);
  return true;
}

async function assertRootStable(state) {
  const stat = await lstat(state.root);
  requirePlainDirectory(stat, "native operation journal root");
  requirePrivateOwned(stat, "native operation journal root");
  if (
    objectFingerprint(stat) !== state.fingerprint ||
    !sameCanonicalPath(await realpath(state.root), state.canonicalRoot)
  ) {
    fail("NATIVE_OPERATION_JOURNAL_ROOT_CHANGED", "native operation journal root identity changed");
  }
}

async function assertDatabaseStable(state) {
  const stat = await lstat(state.databasePath);
  requirePlainFile(stat, "native operation journal database");
  if (stat.dev !== state.device || objectFingerprint(stat) !== state.databaseFingerprint) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_CHANGED",
      "native operation journal database identity changed",
    );
  }
}

async function assertExecutionLeaseDatabaseStable(state) {
  const stat = await lstat(state.executionLeaseDatabasePath);
  requirePlainFile(stat, "native operation journal execution lease database");
  if (
    stat.dev !== state.device ||
    objectFingerprint(stat) !== state.executionLeaseDatabaseFingerprint
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_CHANGED",
      "native operation journal execution lease database identity changed",
    );
  }
}

async function assertRootObjects(state) {
  await assertRootStable(state);
  const allowed = new Set([
    databaseLeaf,
    databaseLeaf + "-shm",
    databaseLeaf + "-wal",
    executionLeaseDatabaseLeaf,
    executionLeaseDatabaseLeaf + "-journal",
  ]);
  const entries = await readdir(state.root, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail(
        "NATIVE_OPERATION_JOURNAL_ROOT_CONTENT",
        "native operation journal root contains an unknown object",
      );
    }
    const stat = await lstat(join(state.root, entry.name));
    requirePlainFile(stat, "native operation journal file");
    if (stat.dev !== state.device) {
      fail(
        "NATIVE_OPERATION_JOURNAL_FILESYSTEM",
        "native operation journal file changed filesystem",
      );
    }
  }
}

function readDatabaseSchema(database) {
  return sqliteCall(() =>
    database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
}

function assertExpectedDatabaseSchemaSubset(rows) {
  if (
    rows.some((row) => {
      const definition = databaseSchemaByName.get(row.name);
      return (
        definition === undefined ||
        row.type !== definition.type ||
        typeof row.sql !== "string" ||
        normalizeSql(row.sql) !== normalizeSql(definition.sql)
      );
    })
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
      "native operation journal database schema differs",
    );
  }
}

function assertDatabaseSchema(database) {
  const rows = readDatabaseSchema(database);
  assertExpectedDatabaseSchemaSubset(rows);
  if (rows.length !== databaseSchemaObjects.length) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
      "native operation journal database schema differs",
    );
  }
}

function assertDatabaseDurability(database) {
  const journalMode = sqliteCall(() => database.prepare("PRAGMA journal_mode").get().journal_mode);
  const synchronous = sqliteCall(() => database.prepare("PRAGMA synchronous").get().synchronous);
  const foreignKeys = sqliteCall(() => database.prepare("PRAGMA foreign_keys").get().foreign_keys);
  const trustedSchema = sqliteCall(
    () => database.prepare("PRAGMA trusted_schema").get().trusted_schema,
  );
  const fullfsync = sqliteCall(() => database.prepare("PRAGMA fullfsync").get().fullfsync);
  const checkpointFullfsync = sqliteCall(
    () => database.prepare("PRAGMA checkpoint_fullfsync").get().checkpoint_fullfsync,
  );
  if (
    String(journalMode).toLowerCase() !== "wal" ||
    synchronous !== 2 ||
    foreignKeys !== 1 ||
    trustedSchema !== 0 ||
    fullfsync !== 1 ||
    checkpointFullfsync !== 1
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DURABILITY",
      "native operation journal durability mode is unavailable",
    );
  }
}

function checkpoint(database) {
  const result = sqliteCall(() => database.prepare("PRAGMA wal_checkpoint(FULL)").get());
  if (result.busy !== 0 || result.log !== result.checkpointed) {
    fail(
      "NATIVE_OPERATION_JOURNAL_CHECKPOINT",
      "native operation journal checkpoint did not complete",
    );
  }
}

function parseCanonicalRecord(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    fail("NATIVE_OPERATION_JOURNAL_RECORD", label + " is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("NATIVE_OPERATION_JOURNAL_RECORD", label + " is not JSON");
  }
  if (!exactObject(parsed) || canonicalProbeJson(parsed) !== value) {
    fail("NATIVE_OPERATION_JOURNAL_RECORD", label + " is not canonical");
  }
  return parsed;
}

function validateOperationRow(row) {
  if (row === undefined) return null;
  const intent = validateProbeNativeOperationIntent(
    parseCanonicalRecord(row.intent_json, "native operation intent record"),
  );
  if (
    row.operation_id !== intent.operationId ||
    row.intent_sha256 !== intent.intentSha256 ||
    row.action_plan_sha256 !== intent.actionPlanSha256 ||
    row.input_sha256 !== intent.inputSha256 ||
    row.recovery_class !== intent.recoveryClass
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_RECORD",
      "native operation intent columns differ from their record",
    );
  }
  return intent;
}

function validateTransitionRow(row, intent, expectedSequence, previousRecordSha256) {
  const transition = validateProbeNativeOperationTransition(
    parseCanonicalRecord(row.record_json, "native operation transition record"),
  );
  if (
    row.operation_id !== intent.operationId ||
    row.sequence !== expectedSequence ||
    row.state !== transition.state ||
    row.artifact_sha256 !== transition.artifactSha256 ||
    row.previous_record_sha256 !== transition.previousRecordSha256 ||
    row.record_sha256 !== transition.recordSha256 ||
    transition.operationId !== intent.operationId ||
    transition.intentSha256 !== intent.intentSha256 ||
    transition.sequence !== expectedSequence ||
    transition.previousRecordSha256 !== previousRecordSha256
  ) {
    fail("NATIVE_OPERATION_JOURNAL_RECORD", "native operation transition columns or chain differ");
  }
  return transition;
}

function loadOperation(database, operationId) {
  const row = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT operation_id, intent_sha256, action_plan_sha256, input_sha256,",
          "       recovery_class, intent_json",
          "FROM native_operations WHERE operation_id = ?",
        ].join(" "),
      )
      .get(operationId),
  );
  const intent = validateOperationRow(row);
  if (intent === null) return null;
  const rows = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT operation_id, sequence, state, artifact_sha256,",
          "       previous_record_sha256, record_sha256, record_json",
          "FROM native_operation_transitions",
          "WHERE operation_id = ? ORDER BY sequence",
        ].join(" "),
      )
      .all(operationId),
  );
  if (rows.length < 1 || rows.length > PROBE_NATIVE_OPERATION_STATES.length) {
    fail("NATIVE_OPERATION_JOURNAL_RECORD", "native operation has an invalid transition count");
  }
  const transitions = [];
  let previousRecordSha256 = null;
  for (const [index, transitionRow] of rows.entries()) {
    const transition = validateTransitionRow(
      transitionRow,
      intent,
      index + 1,
      previousRecordSha256,
    );
    transitions.push(transition);
    previousRecordSha256 = transition.recordSha256;
  }
  const current = transitions.at(-1);
  const transcript = transitions.find((entry) => entry.state === "transcript-retained");
  const terminal = transitions.find((entry) => entry.state === "terminal-result-retained");
  const retainedTranscript =
    transcript === undefined
      ? null
      : Object.freeze({
          transcriptSha256: transcript.artifactSha256,
          transitionRecordSha256: transcript.recordSha256,
        });
  return Object.freeze({
    operationId: intent.operationId,
    intent,
    transitions: Object.freeze(transitions),
    currentState: current.state,
    transcriptSha256: transcript?.artifactSha256 ?? null,
    retainedTranscript,
    terminalResultSha256: terminal?.artifactSha256 ?? null,
  });
}

function createTransition(intent, state, artifactSha256, previousRecordSha256) {
  const draft = {
    schemaVersion: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
    kind: PROBE_NATIVE_OPERATION_TRANSITION_KIND,
    operationId: intent.operationId,
    intentSha256: intent.intentSha256,
    sequence: PROBE_NATIVE_OPERATION_STATES.indexOf(state) + 1,
    state,
    artifactSha256,
    previousRecordSha256,
  };
  return validateProbeNativeOperationTransition({
    ...draft,
    recordSha256: deriveProbeNativeOperationTransitionSha256(draft),
  });
}

function insertTransition(database, transition) {
  sqliteCall(() =>
    database
      .prepare(
        [
          "INSERT INTO native_operation_transitions",
          "(operation_id, sequence, state, artifact_sha256, previous_record_sha256,",
          " record_sha256, record_json)",
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        transition.operationId,
        transition.sequence,
        transition.state,
        transition.artifactSha256,
        transition.previousRecordSha256,
        transition.recordSha256,
        canonicalProbeJson(transition),
      ),
  );
}

function recoveryDecision(intent, record, { ownsClaim = false } = {}) {
  let decision;
  let reason;
  if (record === null) {
    decision = "CLAIM_BEFORE_EXECUTION";
    reason = "unclaimed";
  } else if (record.currentState === "claim") {
    decision = ownsClaim ? "EXECUTE" : "INCONCLUSIVE";
    reason = ownsClaim ? "claim-created-by-current-invocation" : "claim-owner-is-unknown";
  } else if (record.currentState === "terminal-result-retained") {
    decision = "RETURN_RETAINED_RESULT";
    reason = "terminal-result-is-durable";
  } else if (record.currentState === "transcript-retained") {
    decision = "RESUME_RETAINED_TRANSCRIPT";
    reason = "retained-transcript-awaits-terminal-publication";
  } else if (intent.recoveryClass === "read-only-replay") {
    decision = "REPLAY_READ_ONLY";
    reason = "read-only-effect-is-replayable";
  } else if (intent.recoveryClass === "inspect-and-reconcile") {
    decision = "INSPECT_AND_RECONCILE";
    reason = "mutation-requires-inspection";
  } else {
    decision = "INCONCLUSIVE";
    reason = "automatic-replay-is-forbidden";
  }
  const draft = {
    schemaVersion: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
    kind: PROBE_NATIVE_OPERATION_RECOVERY_DECISION_KIND,
    operationId: intent.operationId,
    intentSha256: intent.intentSha256,
    currentState: record?.currentState ?? null,
    recoveryClass: intent.recoveryClass,
    decision,
    reason,
    transcriptSha256: record?.transcriptSha256 ?? null,
    retainedTranscript: record?.retainedTranscript ?? null,
    terminalResultSha256: record?.terminalResultSha256 ?? null,
  };
  const decisionSha256 = sha256(
    Buffer.from(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-native-operation-recovery-decision.v1",
        decision: draft,
      }),
      "utf8",
    ),
  );
  return Object.freeze({ ...draft, decisionSha256 });
}

function validateTransitionInput(value, requiresArtifact, label) {
  assertExactKeys(
    value,
    requiresArtifact
      ? ["operationId", "intentSha256", "artifactSha256"]
      : ["operationId", "intentSha256"],
    label,
  );
  assertIdentifier(value.operationId, label + " operationId");
  assertSha256(value.intentSha256, label + " intentSha256");
  if (requiresArtifact) assertSha256(value.artifactSha256, label + " artifactSha256");
  return value;
}

function validateExecutionBatch(value, maxOperations) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maxOperations ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(value, index),
    )
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_BATCH",
      "native operation execution batch must be a bounded non-empty dense array",
    );
  }
  const intents = value.map((entry) => validateProbeNativeOperationIntent(entry));
  const operationIds = new Set();
  const intentSha256s = new Set();
  for (const intent of intents) {
    if (operationIds.has(intent.operationId) || intentSha256s.has(intent.intentSha256)) {
      fail(
        "NATIVE_OPERATION_JOURNAL_BATCH",
        "native operation execution batch intents must be unique",
      );
    }
    operationIds.add(intent.operationId);
    intentSha256s.add(intent.intentSha256);
  }
  return Object.freeze(intents);
}

function validateLimits(value) {
  if (value === undefined) return defaultLimits;
  if (!exactObject(value)) {
    fail("NATIVE_OPERATION_JOURNAL_LIMIT", "native operation journal limits are invalid");
  }
  assertExactKeys(
    value,
    Object.hasOwn(value, "maxOperations") ? ["maxOperations"] : [],
    "native operation journal limits",
  );
  const limits = { ...defaultLimits, ...value };
  if (!Number.isSafeInteger(limits.maxOperations) || limits.maxOperations < 1) {
    fail("NATIVE_OPERATION_JOURNAL_LIMIT", "maxOperations must be a positive integer");
  }
  return Object.freeze(limits);
}

function insertMetadata(database) {
  sqliteCall(() =>
    database
      .prepare(
        [
          "INSERT INTO native_operation_metadata",
          "(singleton, schema_version, kind, campaign_id) VALUES (1, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
        "windows-host-probe-native-operation-journal",
        PROBE_CAMPAIGN_ID,
      ),
  );
}

function readMetadataRows(database) {
  return sqliteCall(() =>
    database
      .prepare("SELECT singleton, schema_version, kind, campaign_id FROM native_operation_metadata")
      .all(),
  );
}

function assertRecoverableInitializationDatabase(database, presentNames) {
  const internalSchemaRows = sqliteCall(() =>
    database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
  if (
    internalSchemaRows.some(
      (row) =>
        row.type !== "index" ||
        typeof row.name !== "string" ||
        !row.name.startsWith("sqlite_autoindex_") ||
        !presentNames.has(row.tbl_name) ||
        row.sql !== null,
    )
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
      "native operation journal partial initialization contains unknown internal schema",
    );
  }
  for (const tableName of ["native_operations", "native_operation_transitions"]) {
    if (!presentNames.has(tableName)) continue;
    const count = sqliteCall(
      () => database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count,
    );
    if (count !== 0) {
      fail(
        "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
        "native operation journal partial initialization contains operation data",
      );
    }
  }
  const userVersion = sqliteCall(() => database.prepare("PRAGMA user_version").get().user_version);
  const applicationId = sqliteCall(
    () => database.prepare("PRAGMA application_id").get().application_id,
  );
  const freelistCount = sqliteCall(
    () => database.prepare("PRAGMA freelist_count").get().freelist_count,
  );
  const integrityRows = sqliteCall(() => database.prepare("PRAGMA quick_check(1)").all());
  if (
    userVersion !== 0 ||
    applicationId !== 0 ||
    freelistCount !== 0 ||
    integrityRows.length !== 1 ||
    Object.values(integrityRows[0]).length !== 1 ||
    Object.values(integrityRows[0])[0] !== "ok"
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
      "native operation journal database is not a recoverable initialization",
    );
  }
}

function ensureInitializedSchema(database) {
  transact(database, () => {
    const rows = readDatabaseSchema(database);
    assertExpectedDatabaseSchemaSubset(rows);
    const presentNames = new Set(rows.map((row) => row.name));
    let prefixLength = 0;
    while (
      prefixLength < databaseSchemaObjects.length &&
      presentNames.has(databaseSchemaObjects[prefixLength].name)
    ) {
      prefixLength += 1;
    }
    if (
      rows.length !== prefixLength ||
      databaseSchemaObjects
        .slice(prefixLength)
        .some((definition) => presentNames.has(definition.name))
    ) {
      fail(
        "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
        "native operation journal database is not an initialization prefix",
      );
    }

    const metadataRows = presentNames.has("native_operation_metadata")
      ? readMetadataRows(database)
      : [];
    if (metadataRows.length > 0) {
      if (prefixLength !== databaseSchemaObjects.length) {
        fail(
          "NATIVE_OPERATION_JOURNAL_DATABASE_SCHEMA",
          "native operation journal initialized metadata has a partial schema",
        );
      }
      return;
    }

    assertRecoverableInitializationDatabase(database, presentNames);
    const missingSql = databaseSchemaObjects
      .slice(prefixLength)
      .map((definition) => definition.sql);
    if (missingSql.length > 0) {
      sqliteCall(() => database.exec(missingSql.join(";\n")));
    }
    insertMetadata(database);
  });
}

function assertMetadata(database) {
  const rows = readMetadataRows(database);
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].schema_version !== PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION ||
    rows[0].kind !== "windows-host-probe-native-operation-journal" ||
    rows[0].campaign_id !== PROBE_CAMPAIGN_ID
  ) {
    fail("NATIVE_OPERATION_JOURNAL_METADATA", "native operation journal metadata differs");
  }
}

function isSqliteLockContention(error) {
  return error?.errcode === 5 || error?.errcode === 6;
}

function assertExecutionLeaseDatabase(database) {
  const schemaRows = database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all();
  const integrityRows = database.prepare("PRAGMA quick_check(1)").all();
  const journalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
  const trustedSchema = database.prepare("PRAGMA trusted_schema").get().trusted_schema;
  const userVersion = database.prepare("PRAGMA user_version").get().user_version;
  const applicationId = database.prepare("PRAGMA application_id").get().application_id;
  const freelistCount = database.prepare("PRAGMA freelist_count").get().freelist_count;
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
      "NATIVE_OPERATION_JOURNAL_LEASE_SCHEMA",
      "native operation journal execution lease database differs",
    );
  }
}

export async function openProbeNativeOperationJournal(options) {
  assertExactKeys(
    options,
    exactObject(options) && Object.hasOwn(options, "limits") ? ["root", "limits"] : ["root"],
    "native operation journal options",
  );
  const limits = validateLimits(options.limits);
  const rootState = await inspectRoot(options.root);
  const databasePath = join(rootState.root, databaseLeaf);
  const executionLeaseDatabasePath = join(rootState.root, executionLeaseDatabaseLeaf);
  const preexistingDatabase = await lstatIfPresent(databasePath);
  if (preexistingDatabase !== null) {
    requirePlainFile(preexistingDatabase, "native operation journal database");
    if (preexistingDatabase.dev !== rootState.device) {
      fail(
        "NATIVE_OPERATION_JOURNAL_FILESYSTEM",
        "native operation journal database changed filesystem",
      );
    }
  }
  await assertRootObjects(rootState);
  if (
    preexistingDatabase === null &&
    (await readdir(rootState.root, { withFileTypes: true })).length !== 0
  ) {
    fail(
      "NATIVE_OPERATION_JOURNAL_ROOT_CONTENT",
      "native operation journal root contains orphan database state",
    );
  }
  await prepareDatabaseFile(rootState, databasePath, "native operation journal database");
  await prepareDatabaseFile(
    rootState,
    executionLeaseDatabasePath,
    "native operation journal execution lease database",
  );
  let database;
  try {
    database = new DatabaseSync(databasePath);
    sqliteCall(() => database.prepare("PRAGMA journal_mode = WAL").get());
    sqliteCall(() =>
      database.exec(
        [
          "PRAGMA synchronous = FULL",
          "PRAGMA foreign_keys = ON",
          "PRAGMA trusted_schema = OFF",
          "PRAGMA wal_autocheckpoint = 1",
          "PRAGMA fullfsync = ON",
          "PRAGMA checkpoint_fullfsync = ON",
        ].join(";\n"),
      ),
    );
    ensureInitializedSchema(database);
    assertDatabaseSchema(database);
    assertDatabaseDurability(database);
    assertMetadata(database);
    checkpoint(database);
    const databaseStat = await lstat(databasePath);
    requirePlainFile(databaseStat, "native operation journal database");
    const executionLeaseDatabaseStat = await lstat(executionLeaseDatabasePath);
    requirePlainFile(
      executionLeaseDatabaseStat,
      "native operation journal execution lease database",
    );
    const state = Object.freeze({
      ...rootState,
      databasePath,
      databaseFingerprint: objectFingerprint(databaseStat),
      executionLeaseDatabasePath,
      executionLeaseDatabaseFingerprint: objectFingerprint(executionLeaseDatabaseStat),
    });
    let closed = false;
    let activeExecutionLease = null;

    async function assertStorage() {
      if (closed) {
        fail("NATIVE_OPERATION_JOURNAL_CLOSED", "native operation journal is closed");
      }
      await assertDatabaseStable(state);
      await assertExecutionLeaseDatabaseStable(state);
      await assertRootObjects(state);
      assertDatabaseSchema(database);
      assertDatabaseDurability(database);
      assertMetadata(database);
    }

    async function scan() {
      await assertStorage();
      const rows = sqliteCall(() =>
        database.prepare("SELECT operation_id FROM native_operations ORDER BY operation_id").all(),
      );
      if (rows.length > limits.maxOperations) {
        fail(
          "NATIVE_OPERATION_JOURNAL_LIMIT",
          "native operation journal exceeds its operation bound",
        );
      }
      const operations = rows
        .map((row) => {
          assertIdentifier(row.operation_id, "native operation row operationId");
          return loadOperation(database, row.operation_id);
        })
        .sort((left, right) => compareUtf8(left.operationId, right.operationId));
      return Object.freeze({
        schemaVersion: PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION,
        kind: "windows-host-probe-native-operation-journal-scan",
        campaignId: PROBE_CAMPAIGN_ID,
        journalMode: "wal",
        synchronous: "FULL",
        operations: Object.freeze(operations),
        incompleteOperationIds: Object.freeze(
          operations
            .filter((record) => record.currentState !== "terminal-result-retained")
            .map((record) => record.operationId),
        ),
      });
    }

    await scan();

    function insertClaim(intent) {
      sqliteCall(() =>
        database
          .prepare(
            [
              "INSERT INTO native_operations",
              "(operation_id, intent_sha256, action_plan_sha256, input_sha256,",
              " recovery_class, intent_json) VALUES (?, ?, ?, ?, ?, ?)",
            ].join(" "),
          )
          .run(
            intent.operationId,
            intent.intentSha256,
            intent.actionPlanSha256,
            intent.inputSha256,
            intent.recoveryClass,
            canonicalProbeJson(intent),
          ),
      );
      insertTransition(database, createTransition(intent, "claim", null, null));
    }

    async function acquireExecutionBatch(value) {
      const intents = validateExecutionBatch(value, limits.maxOperations);
      await assertStorage();
      const result = transact(database, () => {
        const records = intents.map((intent) => {
          const record = loadOperation(database, intent.operationId);
          if (record !== null && !canonicalEqual(record.intent, intent)) {
            fail(
              "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
              "native operation identifier was reused with another intent",
            );
          }
          return record;
        });
        const existingCount = records.filter((record) => record !== null).length;
        if (existingCount !== 0 && existingCount !== intents.length) {
          fail(
            "NATIVE_OPERATION_JOURNAL_BATCH_PARTIAL",
            "native operation execution batch is only partially claimed",
          );
        }
        if (existingCount === intents.length) {
          return Object.freeze({
            acquired: false,
            recoveries: Object.freeze(
              intents.map((intent, index) => recoveryDecision(intent, records[index])),
            ),
          });
        }
        const count = sqliteCall(
          () => database.prepare("SELECT COUNT(*) AS count FROM native_operations").get().count,
        );
        if (count + intents.length > limits.maxOperations) {
          fail(
            "NATIVE_OPERATION_JOURNAL_LIMIT",
            "native operation journal reached its operation bound",
          );
        }
        for (const intent of intents) insertClaim(intent);
        return Object.freeze({
          acquired: true,
          records: Object.freeze(
            intents.map((intent) => loadOperation(database, intent.operationId)),
          ),
        });
      });
      checkpoint(database);
      await assertStorage();
      return result;
    }

    async function claimOperation(value) {
      const intent = validateProbeNativeOperationIntent(value);
      await assertStorage();
      const result = transact(database, () => {
        const existing = loadOperation(database, intent.operationId);
        if (existing !== null) {
          if (!canonicalEqual(existing.intent, intent)) {
            fail(
              "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
              "native operation identifier was reused with another intent",
            );
          }
          return { created: false };
        }
        const count = sqliteCall(
          () => database.prepare("SELECT COUNT(*) AS count FROM native_operations").get().count,
        );
        if (count >= limits.maxOperations) {
          fail(
            "NATIVE_OPERATION_JOURNAL_LIMIT",
            "native operation journal reached its operation bound",
          );
        }
        insertClaim(intent);
        return { created: true };
      });
      checkpoint(database);
      await assertStorage();
      const record = loadOperation(database, intent.operationId);
      return Object.freeze({
        created: result.created,
        record,
        recovery: recoveryDecision(intent, record, { ownsClaim: result.created }),
      });
    }

    async function appendState(value, stateName, requiresArtifact, label) {
      const input = validateTransitionInput(value, requiresArtifact, label);
      await assertStorage();
      const result = transact(database, () => {
        const record = loadOperation(database, input.operationId);
        if (record === null) {
          fail(
            "NATIVE_OPERATION_JOURNAL_UNCLAIMED",
            "native operation must be claimed before a transition",
          );
        }
        if (record.intent.intentSha256 !== input.intentSha256) {
          fail(
            "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
            "native operation transition names another intent",
          );
        }
        const prior = record.transitions.find((entry) => entry.state === stateName);
        const artifactSha256 = requiresArtifact ? input.artifactSha256 : null;
        if (prior !== undefined) {
          if (prior.artifactSha256 !== artifactSha256) {
            fail(
              "NATIVE_OPERATION_JOURNAL_TRANSITION_CONFLICT",
              "native operation transition was reused with another artifact",
            );
          }
          return { created: false };
        }
        const expectedState = PROBE_NATIVE_OPERATION_STATES[record.transitions.length];
        if (expectedState !== stateName) {
          fail(
            "NATIVE_OPERATION_JOURNAL_TRANSITION_ORDER",
            "native operation transition is out of order",
          );
        }
        const previousRecordSha256 = record.transitions.at(-1).recordSha256;
        insertTransition(
          database,
          createTransition(record.intent, stateName, artifactSha256, previousRecordSha256),
        );
        return { created: true };
      });
      checkpoint(database);
      await assertStorage();
      return Object.freeze({
        created: result.created,
        record: loadOperation(database, input.operationId),
      });
    }

    async function tryAcquireExecutionLease() {
      await assertStorage();
      if (activeExecutionLease !== null) return Object.freeze({ acquired: false });

      let leaseDatabase;
      let transactionStarted = false;
      try {
        leaseDatabase = new DatabaseSync(state.executionLeaseDatabasePath);
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
        await assertExecutionLeaseDatabaseStable(state);
      } catch (error) {
        if (transactionStarted) {
          try {
            leaseDatabase?.exec("ROLLBACK");
          } catch {
            // Closing the connection below is the final lock-release authority.
          }
        }
        try {
          leaseDatabase?.close();
        } catch {
          fail(
            "NATIVE_OPERATION_JOURNAL_LEASE",
            "native operation journal execution lease database could not close",
          );
        }
        if (error instanceof ProbeNativeOperationJournalError) throw error;
        if (isSqliteLockContention(error)) return Object.freeze({ acquired: false });
        fail(
          "NATIVE_OPERATION_JOURNAL_LEASE",
          "native operation journal execution lease acquisition failed",
        );
      }

      const token = {};
      let released = false;
      const lease = Object.freeze({
        acquired: true,
        async release() {
          if (released) return;
          let releaseFailed = false;
          try {
            leaseDatabase.exec("ROLLBACK");
          } catch {
            releaseFailed = true;
          }
          try {
            leaseDatabase.close();
          } catch {
            releaseFailed = true;
          }
          released = true;
          if (activeExecutionLease?.token === token) activeExecutionLease = null;
          if (releaseFailed) {
            fail(
              "NATIVE_OPERATION_JOURNAL_LEASE",
              "native operation journal execution lease release failed",
            );
          }
        },
      });
      activeExecutionLease = Object.freeze({ token, lease });
      return lease;
    }

    return Object.freeze({
      root: state.root,
      databasePath: state.databasePath,
      async acquireExecutionBatch(value) {
        return acquireExecutionBatch(value);
      },
      async claimOperation(value) {
        return claimOperation(value);
      },
      async tryAcquireExecutionLease() {
        return tryAcquireExecutionLease();
      },
      async recordEffectStarted(value) {
        return appendState(value, "effect-started", false, "native effect-started transition");
      },
      async recordTranscriptRetained(value) {
        return appendState(
          value,
          "transcript-retained",
          true,
          "native transcript-retained transition",
        );
      },
      async recordTerminalResultRetained(value) {
        return appendState(
          value,
          "terminal-result-retained",
          true,
          "native terminal-result-retained transition",
        );
      },
      async decideRecovery(value) {
        const intent = validateProbeNativeOperationIntent(value);
        await assertStorage();
        const record = loadOperation(database, intent.operationId);
        if (record !== null && !canonicalEqual(record.intent, intent)) {
          fail(
            "NATIVE_OPERATION_JOURNAL_OPERATION_REUSE",
            "native operation identifier was reused with another intent",
          );
        }
        return recoveryDecision(intent, record);
      },
      async readOperation(operationId) {
        assertIdentifier(operationId, "native operationId");
        await assertStorage();
        return loadOperation(database, operationId);
      },
      async scan() {
        return scan();
      },
      async assertStorageStable() {
        await assertStorage();
      },
      async close() {
        if (closed) return;
        if (activeExecutionLease !== null) await activeExecutionLease.lease.release();
        checkpoint(database);
        database.close();
        closed = true;
      },
    });
  } catch (error) {
    try {
      database?.close();
    } catch {
      fail("NATIVE_OPERATION_JOURNAL_SQLITE", "native operation journal database could not close");
    }
    throw error;
  }
}
