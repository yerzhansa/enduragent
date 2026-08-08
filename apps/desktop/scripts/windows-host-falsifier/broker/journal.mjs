import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  PROBE_BROKER_RECOVERY_CLASSES,
  PROBE_BROKER_ROLES,
  acceptProbeBrokerTask,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  getProbeBrokerAcceptedContextExecutionAuthorityLease,
  validateProbeBrokerControllerAcceptanceInputForTask,
  validateProbeBrokerDriverValidationReceipt,
  validateProbeBrokerResult,
  validateProbeBrokerResultForTask,
  validateProbeBrokerTask,
} from "./protocol.mjs";
import {
  assertProbeBrokerExecutionAuthorityLease,
  confirmProbeBrokerExecutionAuthority,
  markProbeBrokerExecutionAuthorityEffectStarted,
  markProbeBrokerExecutionAuthorityResultRetained,
  withProbeBrokerExecutionAuthorityConfirmation,
  withProbeBrokerExecutionAuthorityLease,
} from "./execution-authority.mjs";
import { validateProbePreparedBrokerEnrollment } from "./mailbox-protocol.mjs";
import {
  PROBE_CAMPAIGN_ID,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../probe-contract.mjs";

export const PROBE_BROKER_JOURNAL_SCHEMA_VERSION = 1;
export const PROBE_BROKER_JOURNAL_STATES = Object.freeze([
  "accepted",
  "effect-started",
  "effect-committed",
  "result-retained",
]);
export const PROBE_BROKER_JOURNAL_RECOVERY_DIRECTIVES = Object.freeze([
  "execute",
  "reconcile",
  "manual-intervention",
  "replay-retained-result",
]);

const databaseLeaf = "broker-journal.sqlite";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const coordinateKeys = Object.freeze([
  "campaignRunId",
  "executionRunId",
  "attemptId",
  "workId",
  "environmentId",
  "pathProfileId",
  "rowId",
  "variantId",
  "repetition",
]);
const expectedActorKeys = Object.freeze(["role", "identitySource", "identitySha256"]);
const actorIdentitySources = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  "second-user": "actors.secondUserSidSha256",
  "remote-peer": "actors.remotePeerActorSha256",
});
const transitionDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "authoritySha256",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "taskSha256",
  "sequence",
  "state",
  "capability",
  "capabilitySha256",
  "acceptedContextSha256",
  "protocolRecoveryDirective",
  "artifactSha256",
  "previousRecordSha256",
]);
const recoveryDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "authoritySha256",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "taskSha256",
  "currentState",
  "recoveryClass",
  "protocolRecoveryDirective",
  "orchestrationDirective",
  "transitionRecordSha256",
  "effectSha256",
  "resultSha256",
]);
const capabilityKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "coordinate",
  "producerActionId",
  "brokerTaskSha256",
  "brokerTaskNonceSha256",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "expectedActor",
  "mailboxAclSha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "executionAuthoritySha256",
  "recoveryClass",
  "driverValidationReceiptSha256",
  "replayJournalDisposition",
  "replayJournalEntrySha256",
]);
const authorityKeys = Object.freeze([
  "controllerIdentitySha256",
  "controllerPublicKeySha256",
  "brokerEnrollmentSha256",
  "preparedBrokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "mailboxRootObjectIdentitySha256",
  "mailboxVolumeIdSha256",
  "mailboxTransportIdentitySha256",
  "mailboxAclSha256",
  "mailboxOwnerSidSha256",
  "journalRootPathSha256",
  "journalRootObjectIdentitySha256",
  "journalVolumeIdSha256",
  "journalRootOwnerSidSha256",
  "journalRootAclSha256",
  "journalDatabasePathSha256",
  "journalDatabaseObjectIdentitySha256",
  "journalDatabaseOwnerSidSha256",
  "journalDatabaseAclSha256",
  "journalTransportIdentitySha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "nativeObservationSha256",
]);
const defaultLimits = Object.freeze({ maxTasks: 16384 });

const metadataTableSql = [
  "CREATE TABLE broker_journal_metadata (",
  "  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),",
  "  schema_version INTEGER NOT NULL,",
  "  kind TEXT NOT NULL,",
  "  campaign_id TEXT NOT NULL,",
  "  authority_sha256 TEXT NOT NULL,",
  "  authority_json TEXT NOT NULL",
  ") STRICT",
].join("\n");
const tasksTableSql = [
  "CREATE TABLE broker_tasks (",
  "  semantic_key_sha256 TEXT PRIMARY KEY,",
  "  physical_operation_key_sha256 TEXT NOT NULL UNIQUE,",
  "  task_sha256 TEXT NOT NULL UNIQUE,",
  "  task_id TEXT NOT NULL UNIQUE,",
  "  nonce_sha256 TEXT NOT NULL UNIQUE,",
  "  recovery_class TEXT NOT NULL CHECK (recovery_class IN ('read-only-replay', 'inspect-and-reconcile', 'never-auto-replay')),",
  "  replay_journal_entry_sha256 TEXT NOT NULL UNIQUE,",
  "  task_json TEXT NOT NULL,",
  "  UNIQUE (semantic_key_sha256, physical_operation_key_sha256)",
  ") STRICT",
].join("\n");
const transitionsTableSql = [
  "CREATE TABLE broker_transitions (",
  "  semantic_key_sha256 TEXT NOT NULL,",
  "  physical_operation_key_sha256 TEXT NOT NULL,",
  "  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4),",
  "  state TEXT NOT NULL CHECK (state IN ('accepted', 'effect-started', 'effect-committed', 'result-retained')),",
  "  capability_sha256 TEXT NOT NULL,",
  "  accepted_context_sha256 TEXT NOT NULL,",
  "  protocol_recovery_directive TEXT NOT NULL CHECK (protocol_recovery_directive IN ('execute', 'replay', 'reconcile', 'manual-intervention')),",
  "  artifact_sha256 TEXT,",
  "  previous_record_sha256 TEXT,",
  "  record_sha256 TEXT NOT NULL UNIQUE,",
  "  record_json TEXT NOT NULL,",
  "  PRIMARY KEY (physical_operation_key_sha256, sequence),",
  "  UNIQUE (physical_operation_key_sha256, state),",
  "  FOREIGN KEY (semantic_key_sha256, physical_operation_key_sha256) REFERENCES broker_tasks(semantic_key_sha256, physical_operation_key_sha256),",
  "  CHECK ((state IN ('accepted', 'effect-started') AND artifact_sha256 IS NULL) OR (state IN ('effect-committed', 'result-retained') AND artifact_sha256 IS NOT NULL)),",
  "  CHECK ((sequence = 1 AND previous_record_sha256 IS NULL) OR (sequence > 1 AND previous_record_sha256 IS NOT NULL))",
  ") STRICT",
].join("\n");
const resultsTableSql = [
  "CREATE TABLE broker_results (",
  "  semantic_key_sha256 TEXT NOT NULL UNIQUE,",
  "  physical_operation_key_sha256 TEXT PRIMARY KEY,",
  "  task_sha256 TEXT NOT NULL UNIQUE,",
  "  result_sha256 TEXT NOT NULL UNIQUE,",
  "  result_json TEXT NOT NULL,",
  "  FOREIGN KEY (semantic_key_sha256, physical_operation_key_sha256) REFERENCES broker_tasks(semantic_key_sha256, physical_operation_key_sha256)",
  ") STRICT",
].join("\n");

function appendOnlyTrigger(name, table, operation) {
  return [
    `CREATE TRIGGER ${name}`,
    `${operation} ON ${table}`,
    "BEGIN",
    "  SELECT RAISE(ABORT, 'broker journal is append-only');",
    "END",
  ].join("\n");
}

const appendOnlyTriggers = Object.freeze(
  Object.fromEntries(
    [
      ["broker_journal_metadata", "broker_journal_metadata"],
      ["broker_tasks", "broker_tasks"],
      ["broker_transitions", "broker_transitions"],
      ["broker_results", "broker_results"],
    ].flatMap(([prefix, table]) => [
      [`${prefix}_no_delete`, appendOnlyTrigger(`${prefix}_no_delete`, table, "BEFORE DELETE")],
      [`${prefix}_no_update`, appendOnlyTrigger(`${prefix}_no_update`, table, "BEFORE UPDATE")],
    ]),
  ),
);
const databaseSchemaObjects = Object.freeze(
  [
    ["broker_journal_metadata", "table", metadataTableSql],
    ["broker_tasks", "table", tasksTableSql],
    ["broker_transitions", "table", transitionsTableSql],
    ["broker_results", "table", resultsTableSql],
    ...Object.entries(appendOnlyTriggers).map(([name, sql]) => [name, "trigger", sql]),
  ].map(([name, type, sql]) => Object.freeze({ name, type, sql })),
);
const databaseSchemaByName = new Map(
  databaseSchemaObjects.map((definition) => [definition.name, definition]),
);

export class ProbeBrokerJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerJournalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerJournalError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneCanonicalData(value, label, depth = 0, ancestors = new Set()) {
  if (depth > 64) fail("BROKER_JOURNAL_VALUE", `${label} exceeds the depth bound`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) fail("BROKER_JOURNAL_VALUE", `${label} contains invalid Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("BROKER_JOURNAL_VALUE", `${label} is not finite`);
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    fail("BROKER_JOURNAL_VALUE", `${label} is not canonical data`);
  }
  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      )
    ) {
      fail("BROKER_JOURNAL_VALUE", `${label} array shape is invalid`);
    }
    clone = value.map((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("BROKER_JOURNAL_VALUE", `${label} contains an accessor or sparse entry`);
      }
      return cloneCanonicalData(descriptor.value, label, depth + 1, ancestors);
    });
  } else {
    if (!exactObject(value)) fail("BROKER_JOURNAL_VALUE", `${label} must be a plain object`);
    clone = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !key.isWellFormed() ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        fail("BROKER_JOURNAL_VALUE", `${label} contains a non-data field`);
      }
      clone[key] = cloneCanonicalData(descriptor.value, label, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
  return clone;
}

function freezeCanonical(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) stack.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("BROKER_JOURNAL_SCHEMA", `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    }) ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail("BROKER_JOURNAL_SCHEMA", `${label} has an invalid field set`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_JOURNAL_DIGEST", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BROKER_JOURNAL_IDENTIFIER", `${label} is invalid`);
  }
  return value;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonceSha256(task) {
  return sha256(Buffer.from(task.nonceBase64, "base64"));
}

function validateAuthority(value) {
  const snapshot = cloneCanonicalData(value, "broker journal authority");
  assertExactKeys(snapshot, authorityKeys, "broker journal authority");
  for (const key of authorityKeys.filter(
    (key) => !["brokerInstanceId", "brokerRole"].includes(key),
  )) {
    requireSha256(snapshot[key], `broker journal authority.${key}`);
  }
  requireIdentifier(snapshot.brokerInstanceId, "broker journal authority.brokerInstanceId");
  if (!PROBE_BROKER_ROLES.includes(snapshot.brokerRole)) {
    fail("BROKER_JOURNAL_AUTHORITY", "broker journal role is invalid");
  }
  return freezeCanonical(snapshot);
}

const preparedExecutionBindingKeys = Object.freeze([
  "brokerEnrollmentSha256",
  "preparedBrokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "mailboxRootObjectIdentitySha256",
  "mailboxVolumeIdSha256",
  "mailboxTransportIdentitySha256",
  "mailboxAclSha256",
  "mailboxOwnerSidSha256",
  "journalRootPathSha256",
  "journalRootObjectIdentitySha256",
  "journalVolumeIdSha256",
  "journalRootOwnerSidSha256",
  "journalRootAclSha256",
  "journalDatabasePathSha256",
  "journalDatabaseObjectIdentitySha256",
  "journalDatabaseOwnerSidSha256",
  "journalDatabaseAclSha256",
  "journalTransportIdentitySha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "nativeObservationSha256",
]);

function assertLivePreparedJournalBinding(snapshot, binding, root) {
  if (!sameCanonicalPath(resolve(root), resolve(binding.journalRoot))) {
    fail(
      "BROKER_JOURNAL_ROOT_BINDING",
      "broker journal root differs from the prepared native enrollment",
    );
  }
  for (const key of preparedExecutionBindingKeys) {
    if (snapshot[key] !== binding[key]) {
      fail(
        "BROKER_JOURNAL_LIVE_AUTHORITY",
        `live journal authority differs from prepared field ${key}`,
      );
    }
  }
  if (
    binding.journalSecurityProfile !== "role-separated-append-only-journal-v1" ||
    binding.journalFileSystem !== "NTFS" ||
    binding.journalDriveType !== "fixed" ||
    binding.journalLocalAbsolute !== true ||
    binding.journalNetworkPath !== false ||
    binding.journalReparsePoint !== false
  ) {
    fail("BROKER_JOURNAL_LIVE_AUTHORITY", "prepared journal storage posture is invalid");
  }
}

function journalAuthorityFromSnapshot(snapshot) {
  return validateAuthority(Object.fromEntries(authorityKeys.map((key) => [key, snapshot[key]])));
}

export function deriveProbeBrokerJournalAuthoritySha256(value) {
  const authority = validateAuthority(value);
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-journal-authority.v1",
    authority,
  });
}

function validateCapability(value) {
  const snapshot = cloneCanonicalData(value, "broker journal acceptance capability");
  assertExactKeys(snapshot, capabilityKeys, "broker journal acceptance capability");
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "windows-host-probe-broker-acceptance-capability"
  ) {
    fail("BROKER_JOURNAL_CAPABILITY", "broker acceptance capability identity is invalid");
  }
  for (const key of [
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "brokerTaskSha256",
    "brokerTaskNonceSha256",
    "brokerEnrollmentSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "executionAuthoritySha256",
    "driverValidationReceiptSha256",
    "replayJournalEntrySha256",
  ]) {
    requireSha256(snapshot[key], `broker acceptance capability.${key}`);
  }
  requireIdentifier(snapshot.producerActionId, "broker acceptance capability.producerActionId");
  requireIdentifier(snapshot.brokerInstanceId, "broker acceptance capability.brokerInstanceId");
  assertExactKeys(snapshot.coordinate, coordinateKeys, "broker acceptance capability.coordinate");
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    requireIdentifier(snapshot.coordinate[key], `broker acceptance capability.coordinate.${key}`);
  }
  if (
    !["win11-floor", "win11-current"].includes(snapshot.coordinate.environmentId) ||
    !["ascii", "spaces-unicode"].includes(snapshot.coordinate.pathProfileId) ||
    typeof snapshot.coordinate.rowId !== "string" ||
    !rowIdPattern.test(snapshot.coordinate.rowId) ||
    (snapshot.coordinate.repetition !== null &&
      (!Number.isSafeInteger(snapshot.coordinate.repetition) || snapshot.coordinate.repetition < 1))
  ) {
    fail("BROKER_JOURNAL_CAPABILITY", "broker acceptance capability coordinate is invalid");
  }
  assertExactKeys(
    snapshot.expectedActor,
    expectedActorKeys,
    "broker acceptance capability.expectedActor",
  );
  requireSha256(
    snapshot.expectedActor.identitySha256,
    "broker acceptance capability.expectedActor.identitySha256",
  );
  if (
    !PROBE_BROKER_ROLES.includes(snapshot.brokerRole) ||
    !PROBE_BROKER_RECOVERY_CLASSES.includes(snapshot.recoveryClass) ||
    !["accepted", "idempotent-replay"].includes(snapshot.replayJournalDisposition) ||
    !PROBE_BROKER_ROLES.includes(snapshot.expectedActor.role) ||
    snapshot.expectedActor.identitySource !== actorIdentitySources[snapshot.expectedActor.role]
  ) {
    fail("BROKER_JOURNAL_CAPABILITY", "broker acceptance capability is invalid");
  }
  return freezeCanonical(snapshot);
}

function capabilitySha256(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-journal-capability.v1",
    capability: value,
  });
}

function acceptedContextSha256(task, capability, directive) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-accepted-task-context.v1",
    taskSha256: task.taskSha256,
    capability,
    recoveryDirective: directive,
  });
}

function protocolRecoveryDirective(recoveryClass, disposition) {
  if (disposition === "accepted") return "execute";
  if (recoveryClass === "read-only-replay") return "replay";
  if (recoveryClass === "inspect-and-reconcile") return "reconcile";
  if (recoveryClass === "never-auto-replay") return "manual-intervention";
  fail("BROKER_JOURNAL_RECOVERY", "broker recovery class is invalid");
}

function validateTransitionPayload(value, includeDigest) {
  const snapshot = cloneCanonicalData(value, "broker journal transition");
  assertExactKeys(
    snapshot,
    includeDigest ? [...transitionDraftKeys, "recordSha256"] : transitionDraftKeys,
    "broker journal transition",
  );
  if (
    snapshot.schemaVersion !== PROBE_BROKER_JOURNAL_SCHEMA_VERSION ||
    snapshot.kind !== "windows-host-probe-broker-journal-transition" ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 1 ||
    snapshot.sequence > PROBE_BROKER_JOURNAL_STATES.length ||
    snapshot.state !== PROBE_BROKER_JOURNAL_STATES[snapshot.sequence - 1]
  ) {
    fail("BROKER_JOURNAL_TRANSITION", "broker journal transition identity is invalid");
  }
  for (const key of [
    "authoritySha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "capabilitySha256",
    "acceptedContextSha256",
  ]) {
    requireSha256(snapshot[key], `broker journal transition.${key}`);
  }
  const capability = validateCapability(snapshot.capability);
  if (
    snapshot.capabilitySha256 !== capabilitySha256(capability) ||
    capability.semanticKeySha256 !== snapshot.semanticKeySha256 ||
    capability.physicalOperationKeySha256 !== snapshot.physicalOperationKeySha256 ||
    capability.brokerTaskSha256 !== snapshot.taskSha256 ||
    snapshot.protocolRecoveryDirective !==
      protocolRecoveryDirective(capability.recoveryClass, capability.replayJournalDisposition)
  ) {
    fail("BROKER_JOURNAL_TRANSITION", "broker journal transition capability differs");
  }
  if (
    (snapshot.state === "accepted" &&
      (snapshot.artifactSha256 !== null || snapshot.previousRecordSha256 !== null)) ||
    (snapshot.state === "effect-started" && snapshot.artifactSha256 !== null) ||
    (["effect-committed", "result-retained"].includes(snapshot.state) &&
      (snapshot.artifactSha256 === null || snapshot.previousRecordSha256 === null)) ||
    (snapshot.sequence > 1 && snapshot.previousRecordSha256 === null)
  ) {
    fail("BROKER_JOURNAL_TRANSITION", "broker journal transition chain is invalid");
  }
  if (snapshot.artifactSha256 !== null) {
    requireSha256(snapshot.artifactSha256, "broker journal transition.artifactSha256");
  }
  if (snapshot.previousRecordSha256 !== null) {
    requireSha256(snapshot.previousRecordSha256, "broker journal transition.previousRecordSha256");
  }
  if (includeDigest) requireSha256(snapshot.recordSha256, "broker journal transition digest");
  return freezeCanonical({ ...snapshot, capability });
}

function transitionDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-journal-transition.v1",
    transition: Object.fromEntries(transitionDraftKeys.map((key) => [key, value[key]])),
  });
}

export function deriveProbeBrokerJournalTransitionSha256(value) {
  const snapshot = cloneCanonicalData(value, "broker journal transition");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "recordSha256");
  const transition = validateTransitionPayload(snapshot, includeDigest);
  return transitionDigest(transition);
}

export function validateProbeBrokerJournalTransition(value) {
  const transition = validateTransitionPayload(value, true);
  if (transition.recordSha256 !== transitionDigest(transition)) {
    fail("BROKER_JOURNAL_TRANSITION_DIGEST", "broker journal transition digest is invalid");
  }
  return transition;
}

function createTransition({
  authoritySha256,
  task,
  capability,
  acceptedContextSha256: contextSha256,
  protocolRecoveryDirective: directive,
  sequence,
  state,
  artifactSha256,
  previousRecordSha256,
}) {
  const draft = {
    schemaVersion: PROBE_BROKER_JOURNAL_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-journal-transition",
    authoritySha256,
    semanticKeySha256: capability.semanticKeySha256,
    physicalOperationKeySha256: capability.physicalOperationKeySha256,
    taskSha256: task.taskSha256,
    sequence,
    state,
    capability,
    capabilitySha256: capabilitySha256(capability),
    acceptedContextSha256: contextSha256,
    protocolRecoveryDirective: directive,
    artifactSha256,
    previousRecordSha256,
  };
  return validateProbeBrokerJournalTransition({
    ...draft,
    recordSha256: transitionDigest(draft),
  });
}

function validateRecoveryPayload(value, includeDigest) {
  const snapshot = cloneCanonicalData(value, "broker journal recovery");
  assertExactKeys(
    snapshot,
    includeDigest ? [...recoveryDraftKeys, "recoverySha256"] : recoveryDraftKeys,
    "broker journal recovery",
  );
  if (
    snapshot.schemaVersion !== PROBE_BROKER_JOURNAL_SCHEMA_VERSION ||
    snapshot.kind !== "windows-host-probe-broker-journal-recovery" ||
    !PROBE_BROKER_JOURNAL_STATES.includes(snapshot.currentState) ||
    !PROBE_BROKER_RECOVERY_CLASSES.includes(snapshot.recoveryClass) ||
    !["execute", "replay", "reconcile", "manual-intervention"].includes(
      snapshot.protocolRecoveryDirective,
    ) ||
    !PROBE_BROKER_JOURNAL_RECOVERY_DIRECTIVES.includes(snapshot.orchestrationDirective)
  ) {
    fail("BROKER_JOURNAL_RECOVERY", "broker journal recovery identity is invalid");
  }
  for (const key of [
    "authoritySha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "transitionRecordSha256",
  ]) {
    requireSha256(snapshot[key], `broker journal recovery.${key}`);
  }
  for (const key of ["effectSha256", "resultSha256"]) {
    if (snapshot[key] !== null) requireSha256(snapshot[key], `broker journal recovery.${key}`);
  }
  const expectedDirective =
    snapshot.currentState === "accepted"
      ? "execute"
      : snapshot.currentState === "result-retained"
        ? "replay-retained-result"
        : snapshot.recoveryClass === "inspect-and-reconcile"
          ? "reconcile"
          : "manual-intervention";
  if (snapshot.orchestrationDirective !== expectedDirective) {
    fail("BROKER_JOURNAL_RECOVERY", "broker journal recovery directive differs from state");
  }
  if (
    (snapshot.currentState === "accepted" &&
      (snapshot.effectSha256 !== null || snapshot.resultSha256 !== null)) ||
    (snapshot.currentState === "effect-started" &&
      (snapshot.effectSha256 !== null || snapshot.resultSha256 !== null)) ||
    (snapshot.currentState === "effect-committed" &&
      (snapshot.effectSha256 === null || snapshot.resultSha256 !== null)) ||
    (snapshot.currentState === "result-retained" &&
      (snapshot.effectSha256 === null || snapshot.resultSha256 === null))
  ) {
    fail("BROKER_JOURNAL_RECOVERY", "broker journal recovery artifacts differ from state");
  }
  if (includeDigest) requireSha256(snapshot.recoverySha256, "broker journal recovery digest");
  return freezeCanonical(snapshot);
}

function recoveryDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-journal-recovery.v1",
    recovery: Object.fromEntries(recoveryDraftKeys.map((key) => [key, value[key]])),
  });
}

export function deriveProbeBrokerJournalRecoverySha256(value) {
  const snapshot = cloneCanonicalData(value, "broker journal recovery");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "recoverySha256");
  const recovery = validateRecoveryPayload(snapshot, includeDigest);
  return recoveryDigest(recovery);
}

export function validateProbeBrokerJournalRecovery(value) {
  const recovery = validateRecoveryPayload(value, true);
  if (recovery.recoverySha256 !== recoveryDigest(recovery)) {
    fail("BROKER_JOURNAL_RECOVERY_DIGEST", "broker journal recovery digest is invalid");
  }
  return recovery;
}

function normalizeSql(value) {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function sqliteCall(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProbeBrokerJournalError) throw error;
    fail("BROKER_JOURNAL_SQLITE", "broker journal database operation failed");
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
      fail("BROKER_JOURNAL_SQLITE", "broker journal rollback failed");
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
    fail("BROKER_JOURNAL_PERMISSIONS", `${label} permissions are not private`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("BROKER_JOURNAL_OWNER", `${label} is owned by another user`);
  }
}

function requirePlainDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("BROKER_JOURNAL_REPARSE", `${label} must be a plain directory`);
  }
  requirePrivateOwned(stat, label);
}

function requirePlainFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("BROKER_JOURNAL_REPARSE", `${label} must be a regular file`);
  }
  if (stat.nlink !== 1) {
    fail("BROKER_JOURNAL_HARD_LINK", `${label} must have one filesystem link`);
  }
  requirePrivateOwned(stat, label);
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

async function inspectRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("BROKER_JOURNAL_ROOT", "broker journal root must be an absolute path");
  }
  const resolvedRoot = resolve(root);
  const stat = await lstat(resolvedRoot);
  requirePlainDirectory(stat, "broker journal root");
  const canonicalRoot = await realpath(resolvedRoot);
  if (!sameCanonicalPath(canonicalRoot, resolvedRoot)) {
    fail("BROKER_JOURNAL_REPARSE", "broker journal root must not be aliased");
  }
  return Object.freeze({
    root: resolvedRoot,
    canonicalRoot,
    fingerprint: objectFingerprint(stat),
    device: stat.dev,
  });
}

async function prepareDatabaseFile(state, databasePath) {
  const existing = await lstatIfPresent(databasePath);
  if (existing !== null) {
    requirePlainFile(existing, "broker journal database");
    if (existing.dev !== state.device) {
      fail("BROKER_JOURNAL_FILESYSTEM", "broker journal database changed filesystem");
    }
    return;
  }
  let handle;
  try {
    handle = await open(databasePath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await lstat(databasePath);
    requirePlainFile(raced, "broker journal database");
    if (raced.dev !== state.device) {
      fail("BROKER_JOURNAL_FILESYSTEM", "broker journal database changed filesystem");
    }
    return;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryMetadata(state.root);
}

async function assertRootStable(state) {
  const stat = await lstat(state.root);
  requirePlainDirectory(stat, "broker journal root");
  if (
    objectFingerprint(stat) !== state.fingerprint ||
    !sameCanonicalPath(await realpath(state.root), state.canonicalRoot)
  ) {
    fail("BROKER_JOURNAL_ROOT_CHANGED", "broker journal root identity changed");
  }
}

async function assertStorageObjects(state) {
  await assertRootStable(state);
  const allowed = new Set([databaseLeaf, `${databaseLeaf}-wal`]);
  const entries = await readdir(state.root, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("BROKER_JOURNAL_ROOT_CONTENT", "broker journal root contains an unknown object");
    }
    const stat = await lstat(join(state.root, entry.name));
    requirePlainFile(stat, "broker journal file");
    if (stat.dev !== state.device) {
      fail("BROKER_JOURNAL_FILESYSTEM", "broker journal file changed filesystem");
    }
  }
  const databaseStat = await lstat(state.databasePath);
  if (objectFingerprint(databaseStat) !== state.databaseFingerprint) {
    fail("BROKER_JOURNAL_DATABASE_CHANGED", "broker journal database identity changed");
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

function assertDatabaseSchema(database) {
  const rows = readDatabaseSchema(database);
  if (
    rows.length !== databaseSchemaObjects.length ||
    rows.some((row) => {
      const expected = databaseSchemaByName.get(row.name);
      return (
        expected === undefined ||
        row.type !== expected.type ||
        typeof row.sql !== "string" ||
        normalizeSql(row.sql) !== normalizeSql(expected.sql)
      );
    })
  ) {
    fail("BROKER_JOURNAL_DATABASE_SCHEMA", "broker journal database schema differs");
  }
}

function assertDatabaseDurability(database) {
  const journalMode = sqliteCall(() => database.prepare("PRAGMA journal_mode").get().journal_mode);
  const lockingMode = sqliteCall(() => database.prepare("PRAGMA locking_mode").get().locking_mode);
  const synchronous = sqliteCall(() => database.prepare("PRAGMA synchronous").get().synchronous);
  const foreignKeys = sqliteCall(() => database.prepare("PRAGMA foreign_keys").get().foreign_keys);
  const trustedSchema = sqliteCall(
    () => database.prepare("PRAGMA trusted_schema").get().trusted_schema,
  );
  const fullfsync = sqliteCall(() => database.prepare("PRAGMA fullfsync").get().fullfsync);
  const checkpointFullfsync = sqliteCall(
    () => database.prepare("PRAGMA checkpoint_fullfsync").get().checkpoint_fullfsync,
  );
  const busyTimeout = sqliteCall(() => database.prepare("PRAGMA busy_timeout").get().timeout);
  if (
    String(journalMode).toLowerCase() !== "wal" ||
    String(lockingMode).toLowerCase() !== "exclusive" ||
    synchronous !== 2 ||
    foreignKeys !== 1 ||
    trustedSchema !== 0 ||
    fullfsync !== 1 ||
    checkpointFullfsync !== 1 ||
    busyTimeout !== 0
  ) {
    fail("BROKER_JOURNAL_DURABILITY", "broker journal durability mode is unavailable");
  }
}

function assertDatabaseReferentialIntegrity(database) {
  const violations = sqliteCall(() => database.prepare("PRAGMA foreign_key_check").all());
  if (violations.length !== 0) {
    fail(
      "BROKER_JOURNAL_REFERENTIAL_INTEGRITY",
      "broker journal contains rows outside its retained task authority",
    );
  }
}

function checkpoint(database) {
  const result = sqliteCall(() => database.prepare("PRAGMA wal_checkpoint(FULL)").get());
  if (result.busy !== 0 || result.log !== result.checkpointed) {
    fail("BROKER_JOURNAL_CHECKPOINT", "broker journal checkpoint did not complete");
  }
}

function validateLimits(value) {
  if (value === undefined) return defaultLimits;
  const snapshot = cloneCanonicalData(value, "broker journal limits");
  assertExactKeys(snapshot, ["maxTasks"], "broker journal limits");
  if (!Number.isSafeInteger(snapshot.maxTasks) || snapshot.maxTasks < 1) {
    fail("BROKER_JOURNAL_LIMIT", "broker journal maxTasks must be a positive integer");
  }
  return Object.freeze(snapshot);
}

function initializeDatabase(database, authority, authoritySha256) {
  const existing = readDatabaseSchema(database);
  if (existing.length === 0) {
    transact(database, () => {
      sqliteCall(() => database.exec(databaseSchemaObjects.map(({ sql }) => sql).join(";\n")));
      sqliteCall(() =>
        database
          .prepare(
            [
              "INSERT INTO broker_journal_metadata",
              "(singleton, schema_version, kind, campaign_id, authority_sha256, authority_json)",
              "VALUES (1, ?, ?, ?, ?, ?)",
            ].join(" "),
          )
          .run(
            PROBE_BROKER_JOURNAL_SCHEMA_VERSION,
            "windows-host-probe-broker-journal",
            PROBE_CAMPAIGN_ID,
            authoritySha256,
            canonicalProbeJson(authority),
          ),
      );
    });
  }
  assertDatabaseSchema(database);
  const metadata = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT singleton, schema_version, kind, campaign_id, authority_sha256, authority_json",
          "FROM broker_journal_metadata",
        ].join(" "),
      )
      .all(),
  );
  if (
    metadata.length !== 1 ||
    metadata[0].singleton !== 1 ||
    metadata[0].schema_version !== PROBE_BROKER_JOURNAL_SCHEMA_VERSION ||
    metadata[0].kind !== "windows-host-probe-broker-journal" ||
    metadata[0].campaign_id !== PROBE_CAMPAIGN_ID ||
    metadata[0].authority_sha256 !== authoritySha256 ||
    metadata[0].authority_json !== canonicalProbeJson(authority)
  ) {
    fail("BROKER_JOURNAL_AUTHORITY", "broker journal belongs to another authority");
  }
}

function parseCanonicalRecord(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    fail("BROKER_JOURNAL_RECORD", `${label} is invalid`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("BROKER_JOURNAL_RECORD", `${label} is not JSON`);
  }
  if (canonicalProbeJson(parsed) !== value) {
    fail("BROKER_JOURNAL_RECORD", `${label} is not canonical JSON`);
  }
  return parsed;
}

function assertTaskAuthority(task, authority) {
  if (
    task.controllerIdentitySha256 !== authority.controllerIdentitySha256 ||
    task.controllerPublicKeySha256 !== authority.controllerPublicKeySha256 ||
    task.brokerEnrollmentSha256 !== authority.brokerEnrollmentSha256 ||
    task.brokerInstanceId !== authority.brokerInstanceId ||
    task.brokerRole !== authority.brokerRole ||
    task.mailboxAclSha256 !== authority.mailboxAclSha256 ||
    task.processSidSha256 !== authority.processSidSha256 ||
    task.bootIdSha256 !== authority.bootIdSha256 ||
    task.runnerSessionIdSha256 !== authority.runnerSessionIdSha256
  ) {
    fail("BROKER_JOURNAL_AUTHORITY", "broker task belongs to another journal authority");
  }
}

function replayEntrySha256(
  authoritySha256,
  task,
  semanticKeySha256,
  physicalOperationKeySha256,
  nonceDigest,
) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-replay-journal-entry.v1",
    authoritySha256,
    semanticKeySha256,
    physicalOperationKeySha256,
    taskSha256: task.taskSha256,
    taskId: task.taskId,
    nonceSha256: nonceDigest,
    recoveryClass: task.recoveryClass,
    issuedAt: task.issuedAt,
    deadline: task.deadline,
    controllerIdentitySha256: task.controllerIdentitySha256,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    candidateSha256: task.candidateSha256,
    runAuthorizationClaimReceiptSha256: task.runAuthorizationClaimReceiptSha256,
    coordinate: task.coordinate,
    runtimeActionIntentSha256: task.runtimeActionIntentSha256,
    operationId: task.action.operationId,
    producerActionId: task.action.producerActionId,
  });
}

function expectedCapability(
  task,
  semanticKeySha256,
  physicalOperationKeySha256,
  entrySha256,
  driverValidationReceiptSha256,
  executionAuthoritySha256,
  disposition,
) {
  return freezeCanonical({
    schemaVersion: 1,
    kind: "windows-host-probe-broker-acceptance-capability",
    semanticKeySha256,
    physicalOperationKeySha256,
    coordinate: task.coordinate,
    producerActionId: task.action.producerActionId,
    brokerTaskSha256: task.taskSha256,
    brokerTaskNonceSha256: nonceSha256(task),
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
    expectedActor: task.expectedActor,
    mailboxAclSha256: task.mailboxAclSha256,
    processSidSha256: task.processSidSha256,
    bootIdSha256: task.bootIdSha256,
    runnerSessionIdSha256: task.runnerSessionIdSha256,
    executionAuthoritySha256,
    recoveryClass: task.recoveryClass,
    driverValidationReceiptSha256,
    replayJournalDisposition: disposition,
    replayJournalEntrySha256: entrySha256,
  });
}

function validateCapabilityForTask(
  capabilityValue,
  task,
  authority,
  entrySha256,
  expectedDriverValidationReceiptSha256,
) {
  const capability = validateCapability(capabilityValue);
  const receiptSha256 =
    expectedDriverValidationReceiptSha256 ?? capability.driverValidationReceiptSha256;
  requireSha256(receiptSha256, "broker capability driver-validation receipt");
  const expected = expectedCapability(
    task,
    deriveProbeBrokerTaskSemanticKeySha256(task),
    deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    entrySha256,
    receiptSha256,
    capability.executionAuthoritySha256,
    capability.replayJournalDisposition,
  );
  assertTaskAuthority(task, authority);
  if (!canonicalEqual(capability, expected)) {
    fail("BROKER_JOURNAL_CAPABILITY", "broker capability differs from its retained task");
  }
  return capability;
}

function validateTransitionForTask(
  transitionValue,
  task,
  authority,
  authoritySha256,
  entrySha256,
  expectedSequence,
  previousRecordSha256,
) {
  const transition = validateProbeBrokerJournalTransition(transitionValue);
  const capability = validateCapabilityForTask(transition.capability, task, authority, entrySha256);
  if (
    transition.authoritySha256 !== authoritySha256 ||
    transition.semanticKeySha256 !== deriveProbeBrokerTaskSemanticKeySha256(task) ||
    transition.physicalOperationKeySha256 !==
      deriveProbeBrokerTaskPhysicalOperationKeySha256(task) ||
    transition.taskSha256 !== task.taskSha256 ||
    transition.sequence !== expectedSequence ||
    transition.state !== PROBE_BROKER_JOURNAL_STATES[expectedSequence - 1] ||
    transition.previousRecordSha256 !== previousRecordSha256 ||
    transition.capabilitySha256 !== capabilitySha256(capability) ||
    transition.acceptedContextSha256 !==
      acceptedContextSha256(task, capability, transition.protocolRecoveryDirective)
  ) {
    fail("BROKER_JOURNAL_RECORD", "broker journal transition differs from its task chain");
  }
  if (
    expectedSequence === 1 &&
    (capability.replayJournalDisposition !== "accepted" ||
      transition.protocolRecoveryDirective !== "execute")
  ) {
    fail("BROKER_JOURNAL_RECORD", "broker acceptance transition is not fresh");
  }
  return transition;
}

function validateRetainedResultForTask(value, task) {
  const result = validateProbeBrokerResult(value);
  if (
    result.taskSha256 !== task.taskSha256 ||
    result.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    result.brokerInstanceId !== task.brokerInstanceId ||
    result.brokerRole !== task.brokerRole ||
    !canonicalEqual(result.actor, task.expectedActor) ||
    result.driverResult.driverId !== task.driverRequest.driverId ||
    result.bootIdSha256 !== task.bootIdSha256 ||
    result.runnerSessionIdSha256 !== task.runnerSessionIdSha256
  ) {
    fail("BROKER_JOURNAL_RESULT", "retained broker result differs from its task");
  }
  return result;
}

function validateDriverValidationReceiptForTask(value, task) {
  const receipt = validateProbeBrokerDriverValidationReceipt(value);
  if (
    receipt.taskSha256 !== task.taskSha256 ||
    receipt.driverId !== task.driverRequest.driverId ||
    receipt.requestArtifactSha256 !== task.driverRequest.requestArtifact.sha256 ||
    receipt.requestArtifactBytes !== task.driverRequest.requestArtifact.bytes ||
    receipt.recoveryClass !== task.recoveryClass
  ) {
    fail(
      "BROKER_JOURNAL_DRIVER_VALIDATION",
      "driver-validation receipt differs from its signed broker task",
    );
  }
  return receipt;
}

function loadTaskBySemanticKey(database, semanticKeySha256, authority, authoritySha256) {
  const row = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT semantic_key_sha256, physical_operation_key_sha256, task_sha256, task_id, nonce_sha256, recovery_class,",
          "replay_journal_entry_sha256, task_json FROM broker_tasks",
          "WHERE semantic_key_sha256 = ?",
        ].join(" "),
      )
      .get(semanticKeySha256),
  );
  if (row === undefined) return null;
  const task = validateProbeBrokerTask(parseCanonicalRecord(row.task_json, "broker task row"));
  assertTaskAuthority(task, authority);
  const expectedSemanticKey = deriveProbeBrokerTaskSemanticKeySha256(task);
  const expectedPhysicalOperationKey = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
  const expectedNonceSha256 = nonceSha256(task);
  const expectedEntrySha256 = replayEntrySha256(
    authoritySha256,
    task,
    expectedSemanticKey,
    expectedPhysicalOperationKey,
    expectedNonceSha256,
  );
  if (
    row.semantic_key_sha256 !== expectedSemanticKey ||
    row.physical_operation_key_sha256 !== expectedPhysicalOperationKey ||
    row.task_sha256 !== task.taskSha256 ||
    row.task_id !== task.taskId ||
    row.nonce_sha256 !== expectedNonceSha256 ||
    row.recovery_class !== task.recoveryClass ||
    row.replay_journal_entry_sha256 !== expectedEntrySha256 ||
    row.task_json !== canonicalProbeJson(task)
  ) {
    fail("BROKER_JOURNAL_RECORD", "broker task row is invalid");
  }
  const transitionRows = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT physical_operation_key_sha256, sequence, state, capability_sha256, accepted_context_sha256,",
          "protocol_recovery_directive, artifact_sha256, previous_record_sha256,",
          "record_sha256, record_json FROM broker_transitions",
          "WHERE semantic_key_sha256 = ? ORDER BY sequence",
        ].join(" "),
      )
      .all(expectedSemanticKey),
  );
  if (transitionRows.length < 1 || transitionRows.length > PROBE_BROKER_JOURNAL_STATES.length) {
    fail("BROKER_JOURNAL_RECORD", "broker task transition count is invalid");
  }
  let previousRecordSha256 = null;
  const transitions = transitionRows.map((transitionRow, index) => {
    const transition = validateTransitionForTask(
      parseCanonicalRecord(transitionRow.record_json, "broker transition row"),
      task,
      authority,
      authoritySha256,
      expectedEntrySha256,
      index + 1,
      previousRecordSha256,
    );
    if (
      transitionRow.sequence !== transition.sequence ||
      transitionRow.physical_operation_key_sha256 !== transition.physicalOperationKeySha256 ||
      transitionRow.state !== transition.state ||
      transitionRow.capability_sha256 !== transition.capabilitySha256 ||
      transitionRow.accepted_context_sha256 !== transition.acceptedContextSha256 ||
      transitionRow.protocol_recovery_directive !== transition.protocolRecoveryDirective ||
      transitionRow.artifact_sha256 !== transition.artifactSha256 ||
      transitionRow.previous_record_sha256 !== transition.previousRecordSha256 ||
      transitionRow.record_sha256 !== transition.recordSha256 ||
      transitionRow.record_json !== canonicalProbeJson(transition)
    ) {
      fail("BROKER_JOURNAL_RECORD", "broker transition row differs from canonical evidence");
    }
    previousRecordSha256 = transition.recordSha256;
    return transition;
  });
  const currentState = transitions.at(-1).state;
  const effectSha256 =
    transitions.find(({ state }) => state === "effect-committed")?.artifactSha256 ?? null;
  const resultSha256 =
    transitions.find(({ state }) => state === "result-retained")?.artifactSha256 ?? null;
  const resultRows = sqliteCall(() =>
    database
      .prepare(
        [
          "SELECT physical_operation_key_sha256, task_sha256, result_sha256, result_json FROM broker_results",
          "WHERE semantic_key_sha256 = ?",
        ].join(" "),
      )
      .all(expectedSemanticKey),
  );
  if (
    (currentState === "result-retained" && resultRows.length !== 1) ||
    (currentState !== "result-retained" && resultRows.length !== 0)
  ) {
    fail("BROKER_JOURNAL_RESULT", "broker result row differs from the transition chain");
  }
  if (resultRows.length === 1) {
    const result = validateRetainedResultForTask(
      parseCanonicalRecord(resultRows[0].result_json, "broker result row"),
      task,
    );
    if (
      resultRows[0].task_sha256 !== task.taskSha256 ||
      resultRows[0].physical_operation_key_sha256 !== expectedPhysicalOperationKey ||
      resultRows[0].result_sha256 !== result.resultSha256 ||
      resultRows[0].result_json !== canonicalProbeJson(result) ||
      result.resultSha256 !== resultSha256
    ) {
      fail("BROKER_JOURNAL_RESULT", "broker result row is invalid");
    }
  }
  return freezeCanonical({
    semanticKeySha256: expectedSemanticKey,
    physicalOperationKeySha256: expectedPhysicalOperationKey,
    taskSha256: task.taskSha256,
    taskId: task.taskId,
    nonceSha256: expectedNonceSha256,
    replayJournalEntrySha256: expectedEntrySha256,
    task,
    transitions: Object.freeze(transitions),
    currentState,
    effectSha256,
    resultSha256,
  });
}

function insertTransition(database, transition) {
  sqliteCall(() =>
    database
      .prepare(
        [
          "INSERT INTO broker_transitions",
          "(semantic_key_sha256, physical_operation_key_sha256, sequence, state, capability_sha256,",
          "accepted_context_sha256, protocol_recovery_directive, artifact_sha256,",
          "previous_record_sha256, record_sha256, record_json)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        transition.semanticKeySha256,
        transition.physicalOperationKeySha256,
        transition.sequence,
        transition.state,
        transition.capabilitySha256,
        transition.acceptedContextSha256,
        transition.protocolRecoveryDirective,
        transition.artifactSha256,
        transition.previousRecordSha256,
        transition.recordSha256,
        canonicalProbeJson(transition),
      ),
  );
}

function validateAcceptedContextStructure(value, record, authority) {
  const snapshot = cloneCanonicalData(value, "accepted broker task context");
  assertExactKeys(
    snapshot,
    [
      "schemaVersion",
      "kind",
      "task",
      "driverValidationReceipt",
      "capability",
      "recoveryDirective",
      "contextSha256",
    ],
    "accepted broker task context",
  );
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "windows-host-probe-broker-accepted-task-context"
  ) {
    fail("BROKER_JOURNAL_CONTEXT", "accepted broker task context identity is invalid");
  }
  const task = validateProbeBrokerTask(snapshot.task);
  const driverValidationReceipt = validateDriverValidationReceiptForTask(
    snapshot.driverValidationReceipt,
    task,
  );
  const capability = validateCapabilityForTask(
    snapshot.capability,
    task,
    authority,
    record.replayJournalEntrySha256,
    driverValidationReceipt.receiptSha256,
  );
  const expectedDirective = protocolRecoveryDirective(
    task.recoveryClass,
    capability.replayJournalDisposition,
  );
  if (
    !canonicalEqual(task, record.task) ||
    record.transitions[0].capability.driverValidationReceiptSha256 !==
      driverValidationReceipt.receiptSha256 ||
    record.transitions[0].capability.executionAuthoritySha256 !==
      capability.executionAuthoritySha256 ||
    capability.semanticKeySha256 !== record.semanticKeySha256 ||
    capability.physicalOperationKeySha256 !== record.physicalOperationKeySha256 ||
    snapshot.recoveryDirective !== expectedDirective ||
    snapshot.contextSha256 !== acceptedContextSha256(task, capability, expectedDirective)
  ) {
    fail("BROKER_JOURNAL_CONTEXT", "accepted broker task context differs from retained authority");
  }
  return freezeCanonical({ ...snapshot, task, driverValidationReceipt, capability });
}

function createRecovery(authoritySha256, record, context) {
  const orchestrationDirective =
    record.currentState === "accepted"
      ? "execute"
      : record.currentState === "result-retained"
        ? "replay-retained-result"
        : record.task.recoveryClass === "inspect-and-reconcile"
          ? "reconcile"
          : "manual-intervention";
  const draft = {
    schemaVersion: PROBE_BROKER_JOURNAL_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-journal-recovery",
    authoritySha256,
    semanticKeySha256: record.semanticKeySha256,
    physicalOperationKeySha256: record.physicalOperationKeySha256,
    taskSha256: record.taskSha256,
    currentState: record.currentState,
    recoveryClass: record.task.recoveryClass,
    protocolRecoveryDirective: context.recoveryDirective,
    orchestrationDirective,
    transitionRecordSha256: record.transitions.at(-1).recordSha256,
    effectSha256: record.effectSha256,
    resultSha256: record.resultSha256,
  };
  return validateProbeBrokerJournalRecovery({
    ...draft,
    recoverySha256: recoveryDigest(draft),
  });
}

function validateEffectCommitInput(value) {
  assertExactKeys(value, ["acceptedContext", "effectSha256"], "broker effect commitment");
  requireSha256(value.effectSha256, "broker effect commitment.effectSha256");
  return value;
}

function validateResultRetentionInput(value) {
  assertExactKeys(value, ["acceptedContext", "result"], "broker result retention");
  return value;
}

async function openJournalStorage(
  options,
  authority,
  capturedExecutionAuthorityLease,
  enforceCapturedExecutionAuthorityLease,
) {
  const authoritySha256 = deriveProbeBrokerJournalAuthoritySha256(authority);
  const limits = validateLimits(options.limits);
  const rootState = await inspectRoot(options.root);
  const databasePath = join(rootState.root, databaseLeaf);
  const preexistingDatabase = await lstatIfPresent(databasePath);
  if (preexistingDatabase !== null) {
    requirePlainFile(preexistingDatabase, "broker journal database");
    if (preexistingDatabase.dev !== rootState.device) {
      fail("BROKER_JOURNAL_FILESYSTEM", "broker journal database changed filesystem");
    }
  }
  const existingEntries = await readdir(rootState.root, { withFileTypes: true });
  const allowed = new Set([databaseLeaf, `${databaseLeaf}-wal`]);
  for (const entry of existingEntries) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail("BROKER_JOURNAL_ROOT_CONTENT", "broker journal root contains an unknown object");
    }
  }
  if (preexistingDatabase === null && existingEntries.length !== 0) {
    fail("BROKER_JOURNAL_ROOT_CONTENT", "broker journal root contains orphan database state");
  }
  await prepareDatabaseFile(rootState, databasePath);
  const preparedDatabaseStat = await lstat(databasePath);
  requirePlainFile(preparedDatabaseStat, "broker journal database");
  if (preparedDatabaseStat.dev !== rootState.device) {
    fail("BROKER_JOURNAL_FILESYSTEM", "broker journal database changed filesystem");
  }
  const preparedDatabaseFingerprint = objectFingerprint(preparedDatabaseStat);

  let database;
  try {
    database = new DatabaseSync(databasePath);
    sqliteCall(() => database.prepare("PRAGMA locking_mode = EXCLUSIVE").get());
    sqliteCall(() => database.prepare("PRAGMA journal_mode = WAL").get());
    sqliteCall(() =>
      database.exec(
        [
          "PRAGMA synchronous = FULL",
          "PRAGMA foreign_keys = ON",
          "PRAGMA trusted_schema = OFF",
          "PRAGMA busy_timeout = 0",
          "PRAGMA wal_autocheckpoint = 1",
          "PRAGMA fullfsync = ON",
          "PRAGMA checkpoint_fullfsync = ON",
        ].join(";\n"),
      ),
    );
    initializeDatabase(database, authority, authoritySha256);
    assertDatabaseDurability(database);
    assertDatabaseReferentialIntegrity(database);
    checkpoint(database);
    const databaseStat = await lstat(databasePath);
    requirePlainFile(databaseStat, "broker journal database");
    if (objectFingerprint(databaseStat) !== preparedDatabaseFingerprint) {
      fail("BROKER_JOURNAL_DATABASE_CHANGED", "broker journal database changed while opening");
    }
    const state = Object.freeze({
      ...rootState,
      databasePath,
      databaseFingerprint: objectFingerprint(databaseStat),
    });
    const acceptedContexts = new WeakMap();
    let closed = false;

    async function assertStorage() {
      if (closed) fail("BROKER_JOURNAL_CLOSED", "broker journal is closed");
      await assertStorageObjects(state);
      assertDatabaseSchema(database);
      assertDatabaseDurability(database);
      initializeDatabase(database, authority, authoritySha256);
      assertDatabaseReferentialIntegrity(database);
    }

    function loadBySemanticKey(semanticKeySha256) {
      requireSha256(semanticKeySha256, "broker journal semantic key");
      return loadTaskBySemanticKey(database, semanticKeySha256, authority, authoritySha256);
    }

    function loadByPhysicalOperationKey(physicalOperationKeySha256) {
      requireSha256(physicalOperationKeySha256, "broker journal physical-operation key");
      const row = sqliteCall(() =>
        database
          .prepare(
            "SELECT semantic_key_sha256 FROM broker_tasks WHERE physical_operation_key_sha256 = ?",
          )
          .get(physicalOperationKeySha256),
      );
      return row === undefined ? null : loadBySemanticKey(row.semantic_key_sha256);
    }

    function loadByTaskDigest(taskSha256) {
      requireSha256(taskSha256, "broker journal task digest");
      const row = sqliteCall(() =>
        database
          .prepare("SELECT semantic_key_sha256 FROM broker_tasks WHERE task_sha256 = ?")
          .get(taskSha256),
      );
      return row === undefined ? null : loadBySemanticKey(row.semantic_key_sha256);
    }

    function loadRetainedCompletion(record) {
      if (record.currentState !== "result-retained") return null;
      const row = sqliteCall(() =>
        database
          .prepare("SELECT result_json FROM broker_results WHERE semantic_key_sha256 = ?")
          .get(record.semanticKeySha256),
      );
      if (row === undefined) {
        fail("BROKER_JOURNAL_RESULT", "retained broker result is missing");
      }
      const result = validateRetainedResultForTask(
        parseCanonicalRecord(row.result_json, "retained broker result"),
        record.task,
      );
      const capability = record.transitions[0].capability;
      const controllerAcceptanceInput = validateProbeBrokerControllerAcceptanceInputForTask(
        {
          coordinate: capability.coordinate,
          producerActionId: capability.producerActionId,
          brokerTaskSha256: capability.brokerTaskSha256,
          brokerTaskNonceSha256: capability.brokerTaskNonceSha256,
          brokerResultSha256: result.resultSha256,
          brokerEnrollmentSha256: capability.brokerEnrollmentSha256,
          brokerInstanceId: capability.brokerInstanceId,
          brokerRole: capability.brokerRole,
          expectedActor: capability.expectedActor,
          mailboxAclSha256: capability.mailboxAclSha256,
          processSidSha256: capability.processSidSha256,
          bootIdSha256: capability.bootIdSha256,
          runnerSessionIdSha256: capability.runnerSessionIdSha256,
          replayJournalDisposition: capability.replayJournalDisposition,
          replayJournalEntrySha256: capability.replayJournalEntrySha256,
        },
        record.task,
        result,
      );
      return freezeCanonical({ result, controllerAcceptanceInput });
    }

    function assertTaskCountAvailable() {
      const count = sqliteCall(
        () => database.prepare("SELECT COUNT(*) AS count FROM broker_tasks").get().count,
      );
      if (count >= limits.maxTasks) {
        fail("BROKER_JOURNAL_LIMIT", "broker journal reached its task bound");
      }
    }

    function insertAcceptedTask(
      task,
      semanticKeySha256,
      physicalOperationKeySha256,
      driverValidationReceipt,
      executionAuthoritySha256,
    ) {
      const nonceDigest = nonceSha256(task);
      const entrySha256 = replayEntrySha256(
        authoritySha256,
        task,
        semanticKeySha256,
        physicalOperationKeySha256,
        nonceDigest,
      );
      const capability = expectedCapability(
        task,
        semanticKeySha256,
        physicalOperationKeySha256,
        entrySha256,
        driverValidationReceipt.receiptSha256,
        executionAuthoritySha256,
        "accepted",
      );
      const directive = "execute";
      const contextSha256 = acceptedContextSha256(task, capability, directive);
      sqliteCall(() =>
        database
          .prepare(
            [
              "INSERT INTO broker_tasks",
              "(semantic_key_sha256, physical_operation_key_sha256, task_sha256, task_id, nonce_sha256, recovery_class,",
              "replay_journal_entry_sha256, task_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ].join(" "),
          )
          .run(
            semanticKeySha256,
            physicalOperationKeySha256,
            task.taskSha256,
            task.taskId,
            nonceDigest,
            task.recoveryClass,
            entrySha256,
            canonicalProbeJson(task),
          ),
      );
      insertTransition(
        database,
        createTransition({
          authoritySha256,
          task,
          capability,
          acceptedContextSha256: contextSha256,
          protocolRecoveryDirective: directive,
          sequence: 1,
          state: "accepted",
          artifactSha256: null,
          previousRecordSha256: null,
        }),
      );
      return entrySha256;
    }

    function retainedIdentityCollision(task, semanticKeySha256, physicalOperationKeySha256) {
      const nonceDigest = nonceSha256(task);
      const row = sqliteCall(() =>
        database
          .prepare(
            [
              "SELECT semantic_key_sha256, physical_operation_key_sha256, task_sha256, task_id, nonce_sha256 FROM broker_tasks",
              "WHERE task_sha256 = ? OR task_id = ? OR nonce_sha256 = ? LIMIT 1",
            ].join(" "),
          )
          .get(task.taskSha256, task.taskId, nonceDigest),
      );
      if (row === undefined) return;
      if (
        row.semantic_key_sha256 !== semanticKeySha256 ||
        row.physical_operation_key_sha256 !== physicalOperationKeySha256 ||
        row.task_sha256 !== task.taskSha256 ||
        row.task_id !== task.taskId ||
        row.nonce_sha256 !== nonceDigest
      ) {
        fail(
          "BROKER_JOURNAL_IDENTITY_REUSE",
          "broker task digest, task id, or nonce was reused across semantic operations",
        );
      }
    }

    async function consume(
      taskValue,
      bindingValue,
      driverValidationReceiptValue,
      expectedAllowFresh,
      executionAuthorityLease,
    ) {
      const task = validateProbeBrokerTask(taskValue);
      assertTaskAuthority(task, authority);
      const driverValidationReceipt = validateDriverValidationReceiptForTask(
        driverValidationReceiptValue,
        task,
      );
      const binding = cloneCanonicalData(bindingValue, "broker replay binding");
      const semanticKeySha256 = deriveProbeBrokerTaskSemanticKeySha256(task);
      const physicalOperationKeySha256 = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
      const expectedBinding = {
        taskId: task.taskId,
        taskSha256: task.taskSha256,
        nonceBase64: task.nonceBase64,
        recoveryClass: task.recoveryClass,
        issuedAt: task.issuedAt,
        deadline: task.deadline,
        allowFresh: expectedAllowFresh,
        semanticKeySha256,
        physicalOperationKeySha256,
        controllerIdentitySha256: task.controllerIdentitySha256,
        brokerEnrollmentSha256: task.brokerEnrollmentSha256,
        candidateSha256: task.candidateSha256,
        runAuthorizationClaimReceiptSha256: task.runAuthorizationClaimReceiptSha256,
        coordinate: task.coordinate,
        runtimeActionIntentSha256: task.runtimeActionIntentSha256,
        operationId: task.action.operationId,
        producerActionId: task.action.producerActionId,
      };
      if (typeof binding.allowFresh !== "boolean" || !canonicalEqual(binding, expectedBinding)) {
        fail("BROKER_JOURNAL_BINDING", "broker replay binding differs from its signed task");
      }
      await assertStorage();
      const executionAuthority = assertProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
      const journalConfirmation = await confirmProbeBrokerExecutionAuthority(
        executionAuthorityLease,
        "journal-consumption",
      );
      return withProbeBrokerExecutionAuthorityConfirmation(
        executionAuthorityLease,
        journalConfirmation,
        "journal-consumption",
        async () => {
          const decision = transact(database, () => {
            const retained = loadByPhysicalOperationKey(physicalOperationKeySha256);
            if (retained !== null) {
              if (retained.taskSha256 !== task.taskSha256 || !canonicalEqual(retained.task, task)) {
                return freezeCanonical({
                  disposition: "equivocation",
                  semanticKeySha256,
                  physicalOperationKeySha256,
                  retainedTaskSha256: retained.taskSha256,
                  replayJournalEntrySha256: retained.replayJournalEntrySha256,
                });
              }
              return freezeCanonical({
                disposition: "retained",
                semanticKeySha256,
                physicalOperationKeySha256,
                taskSha256: task.taskSha256,
                replayJournalEntrySha256: retained.replayJournalEntrySha256,
              });
            }
            retainedIdentityCollision(task, semanticKeySha256, physicalOperationKeySha256);
            if (!binding.allowFresh) {
              return freezeCanonical({
                disposition: "absent",
                semanticKeySha256,
                physicalOperationKeySha256,
              });
            }
            assertTaskCountAvailable();
            const entrySha256 = insertAcceptedTask(
              task,
              semanticKeySha256,
              physicalOperationKeySha256,
              driverValidationReceipt,
              executionAuthority.authoritySha256,
            );
            return freezeCanonical({
              disposition: "fresh",
              semanticKeySha256,
              physicalOperationKeySha256,
              taskSha256: task.taskSha256,
              replayJournalEntrySha256: entrySha256,
            });
          });
          checkpoint(database);
          await assertStorage();
          return decision;
        },
      );
    }

    function trustedContext(value) {
      if (!exactObject(value) || !acceptedContexts.has(value)) {
        fail(
          "BROKER_JOURNAL_CONTEXT",
          "broker transition requires a context accepted through this journal",
        );
      }
      const executionAuthorityLease = acceptedContexts.get(value);
      if (getProbeBrokerAcceptedContextExecutionAuthorityLease(value) !== executionAuthorityLease) {
        fail(
          "BROKER_JOURNAL_CONTEXT",
          "accepted broker context belongs to another execution authority lease",
        );
      }
      const executionAuthority = assertProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
      const task = validateProbeBrokerTask(value.task);
      const semanticKeySha256 = deriveProbeBrokerTaskSemanticKeySha256(task);
      const record = loadBySemanticKey(semanticKeySha256);
      if (record === null) {
        fail("BROKER_JOURNAL_CONTEXT", "accepted broker context has no retained task");
      }
      const context = validateAcceptedContextStructure(value, record, authority);
      if (
        context.capability.executionAuthoritySha256 !== executionAuthority.authoritySha256 ||
        record.transitions[0].capability.executionAuthoritySha256 !==
          executionAuthority.authoritySha256
      ) {
        fail(
          "BROKER_JOURNAL_CONTEXT",
          "accepted broker context differs from its live execution authority",
        );
      }
      return Object.freeze({ context, record, executionAuthorityLease });
    }

    function adoptDurableExecutionAuthorityLifecycle(executionAuthorityLease, record) {
      if (record.currentState !== "accepted") {
        markProbeBrokerExecutionAuthorityEffectStarted(executionAuthorityLease);
      }
      if (record.currentState === "result-retained") {
        markProbeBrokerExecutionAuthorityResultRetained(executionAuthorityLease);
      }
    }

    function appendTransition(record, context, stateName, artifactSha256) {
      const existing = record.transitions.find(({ state }) => state === stateName);
      if (existing !== undefined) {
        if (existing.artifactSha256 !== artifactSha256) {
          fail(
            "BROKER_JOURNAL_TRANSITION_CONFLICT",
            "broker transition was reused with another artifact",
          );
        }
        return false;
      }
      const sequence = record.transitions.length + 1;
      if (PROBE_BROKER_JOURNAL_STATES[sequence - 1] !== stateName) {
        fail("BROKER_JOURNAL_TRANSITION_ORDER", "broker transition is out of order");
      }
      insertTransition(
        database,
        createTransition({
          authoritySha256,
          task: record.task,
          capability: context.capability,
          acceptedContextSha256: context.contextSha256,
          protocolRecoveryDirective: context.recoveryDirective,
          sequence,
          state: stateName,
          artifactSha256,
          previousRecordSha256: record.transitions.at(-1).recordSha256,
        }),
      );
      return true;
    }

    async function scan() {
      await assertStorage();
      const rows = sqliteCall(() =>
        database
          .prepare("SELECT semantic_key_sha256 FROM broker_tasks ORDER BY semantic_key_sha256")
          .all(),
      );
      if (rows.length > limits.maxTasks) {
        fail("BROKER_JOURNAL_LIMIT", "broker journal exceeds its task bound");
      }
      const tasks = rows
        .map(({ semantic_key_sha256: semanticKeySha256 }) => loadBySemanticKey(semanticKeySha256))
        .sort((left, right) => compareUtf8(left.semanticKeySha256, right.semanticKeySha256));
      return freezeCanonical({
        schemaVersion: PROBE_BROKER_JOURNAL_SCHEMA_VERSION,
        kind: "windows-host-probe-broker-journal-scan",
        authoritySha256,
        journalMode: "wal",
        lockingMode: "exclusive",
        synchronous: "FULL",
        tasks: Object.freeze(tasks),
        incompleteSemanticKeySha256s: Object.freeze(
          tasks
            .filter(({ currentState }) => currentState !== "result-retained")
            .map(({ semanticKeySha256 }) => semanticKeySha256),
        ),
      });
    }

    await scan();

    return Object.freeze({
      root: state.root,
      databasePath: state.databasePath,
      authoritySha256,
      async acceptTask(taskValue, acceptanceOptions) {
        const task = validateProbeBrokerTask(taskValue);
        assertTaskAuthority(task, authority);
        assertExactKeys(
          acceptanceOptions,
          [
            "controllerPublicKeyBytes",
            "executionAuthorityLease",
            "validateDriverRequest",
            "verificationInstant",
          ],
          "broker journal task acceptance options",
        );
        if (typeof acceptanceOptions.validateDriverRequest !== "function") {
          fail(
            "BROKER_JOURNAL_ACCEPTANCE",
            "broker journal validateDriverRequest must be a function",
          );
        }
        assertProbeBrokerExecutionAuthorityLease(acceptanceOptions.executionAuthorityLease);
        if (
          enforceCapturedExecutionAuthorityLease &&
          acceptanceOptions.executionAuthorityLease !== capturedExecutionAuthorityLease
        ) {
          fail(
            "BROKER_JOURNAL_LIVE_AUTHORITY",
            "broker task acceptance supplied another execution authority lease",
          );
        }
        if (
          !(acceptanceOptions.verificationInstant instanceof Date) ||
          !Number.isFinite(acceptanceOptions.verificationInstant.getTime())
        ) {
          fail("BROKER_JOURNAL_ACCEPTANCE", "broker journal verification instant is invalid");
        }
        const expectedAllowFresh =
          acceptanceOptions.verificationInstant.getTime() < Date.parse(task.deadline);
        let driverValidationReceipt = null;
        const context = await acceptProbeBrokerTask(task, {
          controllerPublicKeyBytes: acceptanceOptions.controllerPublicKeyBytes,
          expectedControllerIdentitySha256: authority.controllerIdentitySha256,
          executionAuthorityLease: acceptanceOptions.executionAuthorityLease,
          async validateDriverRequest(request) {
            const receipt = validateDriverValidationReceiptForTask(
              await acceptanceOptions.validateDriverRequest(request),
              task,
            );
            if (
              driverValidationReceipt !== null &&
              !canonicalEqual(driverValidationReceipt, receipt)
            ) {
              fail(
                "BROKER_JOURNAL_DRIVER_VALIDATION",
                "driver-validation callback changed receipt during acceptance",
              );
            }
            driverValidationReceipt = receipt;
            return receipt;
          },
          verificationInstant: acceptanceOptions.verificationInstant,
          replayGuard: Object.freeze({
            consume(binding) {
              if (driverValidationReceipt === null) {
                fail(
                  "BROKER_JOURNAL_DRIVER_VALIDATION",
                  "replay acceptance preceded driver validation",
                );
              }
              return consume(
                task,
                binding,
                driverValidationReceipt,
                expectedAllowFresh,
                acceptanceOptions.executionAuthorityLease,
              );
            },
          }),
        });
        const finalizationConfirmation = await confirmProbeBrokerExecutionAuthority(
          acceptanceOptions.executionAuthorityLease,
          "journal-consumption",
        );
        return withProbeBrokerExecutionAuthorityConfirmation(
          acceptanceOptions.executionAuthorityLease,
          finalizationConfirmation,
          "journal-consumption",
          async () => {
            await assertStorage();
            const record = loadBySemanticKey(deriveProbeBrokerTaskSemanticKeySha256(task));
            if (record === null) {
              fail("BROKER_JOURNAL_CONTEXT", "accepted broker task was not retained");
            }
            validateAcceptedContextStructure(context, record, authority);
            adoptDurableExecutionAuthorityLifecycle(
              acceptanceOptions.executionAuthorityLease,
              record,
            );
            acceptedContexts.set(context, acceptanceOptions.executionAuthorityLease);
            return context;
          },
        );
      },
      async authorizeEffect(acceptedContext) {
        await assertStorage();
        const trusted = trustedContext(acceptedContext);
        const confirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "effect-started",
        );
        const outcome = await withProbeBrokerExecutionAuthorityConfirmation(
          trusted.executionAuthorityLease,
          confirmation,
          "effect-started",
          async () => {
            const decision = transact(database, () => {
              const record = loadBySemanticKey(trusted.record.semanticKeySha256);
              if (record.currentState !== "accepted") {
                return Object.freeze({ authorized: false });
              }
              appendTransition(record, trusted.context, "effect-started", null);
              return Object.freeze({ authorized: true });
            });
            if (decision.authorized) {
              markProbeBrokerExecutionAuthorityEffectStarted(trusted.executionAuthorityLease);
            }
            checkpoint(database);
            await assertStorage();
            const record = loadBySemanticKey(trusted.record.semanticKeySha256);
            adoptDurableExecutionAuthorityLifecycle(trusted.executionAuthorityLease, record);
            return Object.freeze({ decision, record });
          },
        );
        return outcome.decision.authorized
          ? freezeCanonical({ authorized: true, record: outcome.record })
          : freezeCanonical({
              authorized: false,
              record: outcome.record,
              recovery: createRecovery(authoritySha256, outcome.record, trusted.context),
            });
      },
      async recordEffectCommitted(value) {
        const input = validateEffectCommitInput(value);
        await assertStorage();
        const trusted = trustedContext(input.acceptedContext);
        const confirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "effect-committed",
        );
        return withProbeBrokerExecutionAuthorityConfirmation(
          trusted.executionAuthorityLease,
          confirmation,
          "effect-committed",
          async () => {
            const result = transact(database, () => {
              const record = loadBySemanticKey(trusted.record.semanticKeySha256);
              return {
                created: appendTransition(
                  record,
                  trusted.context,
                  "effect-committed",
                  input.effectSha256,
                ),
              };
            });
            checkpoint(database);
            await assertStorage();
            const record = loadBySemanticKey(trusted.record.semanticKeySha256);
            adoptDurableExecutionAuthorityLifecycle(trusted.executionAuthorityLease, record);
            return freezeCanonical({ created: result.created, record });
          },
        );
      },
      async recordResultRetained(value) {
        const input = validateResultRetentionInput(value);
        await assertStorage();
        const trusted = trustedContext(input.acceptedContext);
        const durableRecord = loadBySemanticKey(trusted.record.semanticKeySha256);
        if (
          durableRecord.currentState !== "effect-committed" &&
          durableRecord.currentState !== "result-retained"
        ) {
          fail("BROKER_JOURNAL_TRANSITION_ORDER", "broker result retention is out of order");
        }
        markProbeBrokerExecutionAuthorityEffectStarted(trusted.executionAuthorityLease);
        const resultValidationConfirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "result-validation",
        );
        const resultValue = await validateProbeBrokerResultForTask(
          input.result,
          input.acceptedContext,
          resultValidationConfirmation,
        );
        const resultRetentionConfirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "result-retained",
        );
        return withProbeBrokerExecutionAuthorityConfirmation(
          trusted.executionAuthorityLease,
          resultRetentionConfirmation,
          "result-retained",
          async () => {
            const result = transact(database, () => {
              const record = loadBySemanticKey(trusted.record.semanticKeySha256);
              const existing = record.transitions.find(({ state }) => state === "result-retained");
              if (existing !== undefined) {
                if (existing.artifactSha256 !== resultValue.resultSha256) {
                  fail(
                    "BROKER_JOURNAL_TRANSITION_CONFLICT",
                    "broker result retention was reused with another result",
                  );
                }
                return { created: false };
              }
              if (record.currentState !== "effect-committed") {
                fail("BROKER_JOURNAL_TRANSITION_ORDER", "broker result retention is out of order");
              }
              sqliteCall(() =>
                database
                  .prepare(
                    [
                      "INSERT INTO broker_results",
                      "(semantic_key_sha256, physical_operation_key_sha256, task_sha256, result_sha256, result_json)",
                      "VALUES (?, ?, ?, ?, ?)",
                    ].join(" "),
                  )
                  .run(
                    record.semanticKeySha256,
                    record.physicalOperationKeySha256,
                    record.taskSha256,
                    resultValue.resultSha256,
                    canonicalProbeJson(resultValue),
                  ),
              );
              appendTransition(
                record,
                trusted.context,
                "result-retained",
                resultValue.resultSha256,
              );
              return { created: true };
            });
            checkpoint(database);
            await assertStorage();
            const record = loadBySemanticKey(trusted.record.semanticKeySha256);
            adoptDurableExecutionAuthorityLifecycle(trusted.executionAuthorityLease, record);
            return freezeCanonical({ created: result.created, record });
          },
        );
      },
      async recover(acceptedContext) {
        await assertStorage();
        const trusted = trustedContext(acceptedContext);
        const record = loadBySemanticKey(trusted.record.semanticKeySha256);
        adoptDurableExecutionAuthorityLifecycle(trusted.executionAuthorityLease, record);
        return createRecovery(authoritySha256, record, trusted.context);
      },
      async readTaskByDigest(taskSha256) {
        await assertStorage();
        return withProbeBrokerExecutionAuthorityLease(
          capturedExecutionAuthorityLease,
          "journal-consumption",
          () => loadByTaskDigest(taskSha256),
        );
      },
      async readRetainedResult(acceptedContext) {
        await assertStorage();
        const trusted = trustedContext(acceptedContext);
        const confirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "retained-result-read",
        );
        return withProbeBrokerExecutionAuthorityConfirmation(
          trusted.executionAuthorityLease,
          confirmation,
          "retained-result-read",
          () => {
            const record = loadBySemanticKey(trusted.record.semanticKeySha256);
            return loadRetainedCompletion(record)?.result ?? null;
          },
        );
      },
      async readRetainedCompletion(acceptedContext) {
        await assertStorage();
        const trusted = trustedContext(acceptedContext);
        const confirmation = await confirmProbeBrokerExecutionAuthority(
          trusted.executionAuthorityLease,
          "retained-result-read",
        );
        return withProbeBrokerExecutionAuthorityConfirmation(
          trusted.executionAuthorityLease,
          confirmation,
          "retained-result-read",
          () => {
            const record = loadBySemanticKey(trusted.record.semanticKeySha256);
            return loadRetainedCompletion(record);
          },
        );
      },
      async scan() {
        return scan();
      },
      async assertStorageStable() {
        await assertStorage();
      },
      async close() {
        if (closed) return;
        checkpoint(database);
        database.close();
        closed = true;
      },
    });
  } catch (error) {
    try {
      database?.close();
    } catch {
      fail("BROKER_JOURNAL_SQLITE", "broker journal database could not close");
    }
    throw error;
  }
}

export async function openProbeBrokerJournal(options) {
  const optionKeys = ["root", "preparedBrokerEnrollment", "executionAuthorityLease"];
  assertExactKeys(
    options,
    exactObject(options) && Object.hasOwn(options, "limits")
      ? [...optionKeys, "limits"]
      : optionKeys,
    "broker journal options",
  );
  const binding = validateProbePreparedBrokerEnrollment(options.preparedBrokerEnrollment);
  const executionAuthorityLease = options.executionAuthorityLease;
  assertProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    fail("BROKER_JOURNAL_ROOT", "broker journal root must be an absolute path");
  }
  return withProbeBrokerExecutionAuthorityLease(
    executionAuthorityLease,
    "journal-open",
    async (snapshot) => {
      assertLivePreparedJournalBinding(snapshot, binding, options.root);
      return openJournalStorage(
        { root: options.root, limits: options.limits },
        journalAuthorityFromSnapshot(snapshot),
        executionAuthorityLease,
        true,
      );
    },
  );
}

export async function openProbeBrokerJournalStorageForTest(options) {
  if (process.platform === "win32") {
    fail(
      "BROKER_JOURNAL_TEST_ONLY",
      "the unprepared journal storage harness is unavailable on Windows",
    );
  }
  const optionKeys = ["root", "executionAuthorityLease"];
  assertExactKeys(
    options,
    exactObject(options) && Object.hasOwn(options, "limits")
      ? [...optionKeys, "limits"]
      : optionKeys,
    "broker journal storage test options",
  );
  const executionAuthorityLease = options.executionAuthorityLease;
  assertProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    fail("BROKER_JOURNAL_ROOT", "broker journal root must be an absolute path");
  }
  return withProbeBrokerExecutionAuthorityLease(
    executionAuthorityLease,
    "journal-open",
    async (snapshot) => {
      if (!sameCanonicalPath(resolve(options.root), resolve(snapshot.journalRoot))) {
        fail(
          "BROKER_JOURNAL_ROOT_BINDING",
          "test journal root differs from its live execution authority",
        );
      }
      return openJournalStorage(
        { root: options.root, limits: options.limits },
        journalAuthorityFromSnapshot(snapshot),
        executionAuthorityLease,
        false,
      );
    },
  );
}
