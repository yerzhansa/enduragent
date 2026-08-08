import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../probe-contract.mjs";
import { getProbeActionMapping, resolveProbeActionActor } from "../probe-action-map.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN_SHA256, getProbeRunWorkItem } from "../probe-runner.mjs";
import { PROBE_SCENARIO_DEFINITIONS } from "../probe-scenarios.mjs";
import {
  assertProbeBrokerExecutionAuthorityLease,
  bindProbeBrokerExecutionAuthorityLeaseToOperation,
  withProbeBrokerExecutionAuthorityConfirmation,
  withProbeBrokerExecutionAuthorityLease,
} from "./execution-authority.mjs";

export const PROBE_BROKER_PROTOCOL_SCHEMA_VERSION = 1;
export const PROBE_BROKER_TASK_KIND = "windows-host-probe-broker-task";
export const PROBE_BROKER_RESULT_KIND = "windows-host-probe-broker-result";
export const PROBE_BROKER_DRIVER_REQUEST_KIND = "windows-host-probe-broker-driver-request";
export const PROBE_BROKER_DRIVER_RESULT_KIND = "windows-host-probe-broker-driver-result";
export const PROBE_BROKER_ROLES = Object.freeze([
  "primary-standard-user",
  "second-user",
  "remote-peer",
]);
export const PROBE_BROKER_RECOVERY_CLASSES = Object.freeze([
  "read-only-replay",
  "inspect-and-reconcile",
  "never-auto-replay",
]);
export const PROBE_BROKER_RESULT_OUTCOMES = Object.freeze(["FAILED", "INCONCLUSIVE", "SUCCEEDED"]);
export const PROBE_BROKER_MAX_CANONICAL_BYTES = 256 * 1024;
export const PROBE_BROKER_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const PROBE_BROKER_MAX_REFERENCES = 128;
export const PROBE_BROKER_MAX_DEPTH = 16;
export const PROBE_BROKER_TASK_MAX_TTL_MS = 10 * 60 * 1000;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const forbiddenFieldPattern =
  /(?:credential|password|passphrase|private(?:[-_]?signing)?[-_]?key|secret|bearer|access[-_]?token|refresh[-_]?token)/iu;
const taskDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "taskId",
  "controllerIdentitySha256",
  "controllerPublicKeySha256",
  "campaignId",
  "manifestSha256",
  "candidateSha256",
  "runPlanSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "runtimeActionIntentSha256",
  "action",
  "execution",
  "actorSelectorInput",
  "expectedActor",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "mailboxAclSha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "driverRequest",
  "recoveryClass",
  "issuedAt",
  "deadline",
  "nonceBase64",
  "signatureAlgorithm",
]);
const taskCreateInputKeys = Object.freeze(
  taskDraftKeys.filter(
    (key) =>
      ![
        "schemaVersion",
        "kind",
        "campaignId",
        "manifestSha256",
        "runPlanSha256",
        "signatureAlgorithm",
      ].includes(key),
  ),
);
const resultDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "taskSha256",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "actor",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "outcome",
  "driverResult",
  "proofArtifacts",
  "observerTranscripts",
  "pausedSessionReceipt",
]);
const resultCreateInputKeys = Object.freeze(
  resultDraftKeys.filter((key) => !["schemaVersion", "kind"].includes(key)),
);
const actorIdentitySources = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  "second-user": "actors.secondUserSidSha256",
  "remote-peer": "actors.remotePeerActorSha256",
});
const allowedLoci = Object.freeze({
  "primary-standard-user": Object.freeze([
    "guest-standard-user-worker",
    "controller-orchestrated-guest",
  ]),
  "second-user": Object.freeze(["guest-second-user-broker", "controller-orchestrated-guest"]),
  "remote-peer": Object.freeze(["controller-remote-peer"]),
});
const replayBindingKeys = Object.freeze([
  "taskId",
  "taskSha256",
  "nonceBase64",
  "recoveryClass",
  "issuedAt",
  "deadline",
  "allowFresh",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "controllerIdentitySha256",
  "brokerEnrollmentSha256",
  "candidateSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "runtimeActionIntentSha256",
  "operationId",
  "producerActionId",
]);
const replayDecisionKeys = Object.freeze([
  "disposition",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "taskSha256",
  "replayJournalEntrySha256",
]);
const replayEquivocationKeys = Object.freeze([
  "disposition",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "retainedTaskSha256",
  "replayJournalEntrySha256",
]);
const replayAbsentKeys = Object.freeze([
  "disposition",
  "semanticKeySha256",
  "physicalOperationKeySha256",
]);
const driverValidationReceiptKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "taskSha256",
  "driverId",
  "requestArtifactSha256",
  "requestArtifactBytes",
  "requestSchemaSha256",
  "recoveryClass",
  "receiptSha256",
]);
const driverValidationReceiptDraftKeys = Object.freeze(
  driverValidationReceiptKeys.filter((key) => key !== "receiptSha256"),
);
const driverValidationReceiptCreateInputKeys = Object.freeze(
  driverValidationReceiptDraftKeys.filter((key) => !["schemaVersion", "kind"].includes(key)),
);
const acceptanceCapabilityKeys = Object.freeze([
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
const acceptedContextKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "task",
  "driverValidationReceipt",
  "capability",
  "recoveryDirective",
  "contextSha256",
]);
const controllerAcceptanceInputKeys = Object.freeze([
  "coordinate",
  "producerActionId",
  "brokerTaskSha256",
  "brokerTaskNonceSha256",
  "brokerResultSha256",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "expectedActor",
  "mailboxAclSha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "replayJournalDisposition",
  "replayJournalEntrySha256",
]);
const liveAcceptedContexts = new WeakMap();

export class ProbeBrokerProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerProtocolError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertProtocolString(value, label, maximumLength = 4096) {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    value.includes("\0") ||
    !validUnicodeScalarString(value) ||
    value !== value.normalize("NFC")
  ) {
    fail("BROKER_PROTOCOL_UNICODE", `${label} must be bounded canonical Unicode`);
  }
  return value;
}

function cloneProtocolData(value, label) {
  const ancestors = new Set();
  let nodeCount = 0;

  const visit = (entry, entryLabel, depth) => {
    nodeCount += 1;
    if (nodeCount > 4096 || depth > PROBE_BROKER_MAX_DEPTH) {
      fail("BROKER_PROTOCOL_BOUNDS", `${label} exceeds the protocol depth or node bound`);
    }
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "string") return assertProtocolString(entry, entryLabel);
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        fail("BROKER_PROTOCOL_NUMBER", `${entryLabel} must be a finite number`);
      }
      return entry;
    }
    if (typeof entry !== "object" || ancestors.has(entry)) {
      fail("BROKER_PROTOCOL_DATA", `${entryLabel} must be acyclic JSON data`);
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (
          Object.getPrototypeOf(entry) !== Array.prototype ||
          entry.length > PROBE_BROKER_MAX_REFERENCES
        ) {
          fail("BROKER_PROTOCOL_BOUNDS", `${entryLabel} must be a bounded plain array`);
        }
        const keys = Reflect.ownKeys(entry);
        if (
          keys.length !== entry.length + 1 ||
          !keys.includes("length") ||
          keys.some(
            (key) =>
              typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)),
          )
        ) {
          fail("BROKER_PROTOCOL_DATA", `${entryLabel} has invalid array properties`);
        }
        const result = [];
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
            fail("BROKER_PROTOCOL_DATA", `${entryLabel}[${index}] must be enumerable data`);
          }
          result.push(visit(descriptor.value, `${entryLabel}[${index}]`, depth + 1));
        }
        return result;
      }
      if (!exactObject(entry)) {
        fail("BROKER_PROTOCOL_DATA", `${entryLabel} must be a plain object`);
      }
      const keys = Reflect.ownKeys(entry);
      if (keys.length > 64) {
        fail("BROKER_PROTOCOL_BOUNDS", `${entryLabel} has too many fields`);
      }
      const result = Object.create(null);
      for (const key of keys) {
        if (typeof key !== "string") {
          fail("BROKER_PROTOCOL_DATA", `${entryLabel} has a symbolic field`);
        }
        assertProtocolString(key, `${entryLabel} field name`, 128);
        if (forbiddenFieldPattern.test(key)) {
          fail("BROKER_PROTOCOL_SECRET", `${entryLabel} names forbidden credential material`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("BROKER_PROTOCOL_DATA", `${entryLabel}.${key} must be enumerable data`);
        }
        result[key] = visit(descriptor.value, `${entryLabel}.${key}`, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(entry);
    }
  };

  const snapshot = visit(value, label, 0);
  if (Buffer.byteLength(canonicalProbeJson(snapshot), "utf8") > PROBE_BROKER_MAX_CANONICAL_BYTES) {
    fail("BROKER_PROTOCOL_BOUNDS", `${label} exceeds the canonical byte bound`);
  }
  return snapshot;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeCanonical(value) {
  return deepFreeze(JSON.parse(canonicalProbeJson(value)));
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("BROKER_PROTOCOL_SCHEMA", `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("BROKER_PROTOCOL_SCHEMA", `${label} has an invalid field set`);
  }
  actual.sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("BROKER_PROTOCOL_SCHEMA", `${label} has an invalid field set`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("BROKER_PROTOCOL_DATA", `${label}.${key} must be enumerable data`);
    }
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_PROTOCOL_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !identifierPattern.test(value)
  ) {
    fail("BROKER_PROTOCOL_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    fail("BROKER_PROTOCOL_TIMESTAMP", `${label} must be strict UTC ISO-8601`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("BROKER_PROTOCOL_TIMESTAMP", `${label} must be strict UTC ISO-8601`);
  }
  return value;
}

function decodeCanonicalBase64(value, label, exactBytes) {
  if (typeof value !== "string" || !canonicalBase64Pattern.test(value)) {
    fail("BROKER_PROTOCOL_BASE64", `${label} must be canonical padded base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== exactBytes || bytes.toString("base64") !== value) {
    fail("BROKER_PROTOCOL_BASE64", `${label} has an invalid decoded size`);
  }
  return bytes;
}

function validateArtifactReference(value, label) {
  assertExactKeys(value, ["blobPath", "bytes", "sha256"], label);
  requireSha256(value.sha256, `${label}.sha256`);
  if (value.blobPath !== `blobs/sha256/${value.sha256}`) {
    fail("BROKER_PROTOCOL_PATH", `${label}.blobPath must be content-addressed`);
  }
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > PROBE_BROKER_MAX_ARTIFACT_BYTES
  ) {
    fail("BROKER_PROTOCOL_BOUNDS", `${label}.bytes exceeds the artifact bound`);
  }
  return value;
}

function validateCoordinate(value) {
  assertExactKeys(
    value,
    [
      "campaignRunId",
      "executionRunId",
      "attemptId",
      "workId",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "repetition",
    ],
    "broker task coordinate",
  );
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    requireIdentifier(value[key], `broker task coordinate.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task coordinate.environmentId is invalid");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task coordinate.pathProfileId is invalid");
  }
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task coordinate.rowId is invalid");
  }
  if (
    value.repetition !== null &&
    (!Number.isSafeInteger(value.repetition) || value.repetition < 1)
  ) {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task coordinate.repetition is invalid");
  }
  return value;
}

function validateActorSelector(value) {
  if (exactObject(value) && value.kind === "fixed") {
    assertExactKeys(value, ["kind", "role"], "broker task execution.actorSelector");
    if (
      ![...PROBE_BROKER_ROLES, "controller", "power-control", "snapshot-control"].includes(
        value.role,
      )
    ) {
      fail("BROKER_PROTOCOL_EXECUTION", "fixed actor selector role is invalid");
    }
    return value;
  }
  assertExactKeys(
    value,
    ["kind", "parameter", "roleByValue"],
    "broker task execution.actorSelector",
  );
  assertExactKeys(
    value.roleByValue,
    ["current-user", "second-user"],
    "broker task execution.actorSelector.roleByValue",
  );
  if (
    value.kind !== "parameter" ||
    value.parameter !== "actor" ||
    value.roleByValue["current-user"] !== "primary-standard-user" ||
    value.roleByValue["second-user"] !== "second-user"
  ) {
    fail("BROKER_PROTOCOL_EXECUTION", "parameter actor selector is invalid");
  }
  return value;
}

function validateAction(value) {
  assertExactKeys(
    value,
    ["scenarioPlanSha256", "producerActionId", "operationId", "sequence"],
    "broker task action",
  );
  requireSha256(value.scenarioPlanSha256, "broker task action.scenarioPlanSha256");
  requireIdentifier(value.producerActionId, "broker task action.producerActionId");
  requireIdentifier(value.operationId, "broker task action.operationId");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    fail("BROKER_PROTOCOL_ACTION", "broker task action.sequence must be a positive safe integer");
  }
  return value;
}

function validateActorSelectorInput(value) {
  if (value === null) return value;
  assertExactKeys(value, ["parameter", "value"], "broker task actorSelectorInput");
  if (value.parameter !== "actor" || !["current-user", "second-user"].includes(value.value)) {
    fail(
      "BROKER_PROTOCOL_ACTOR_SELECTOR_INPUT",
      "broker task actorSelectorInput is not a normalized actor selection",
    );
  }
  return value;
}

function validateExpectedActor(value) {
  assertExactKeys(value, ["role", "identitySource", "identitySha256"], "broker task expectedActor");
  if (
    !PROBE_BROKER_ROLES.includes(value.role) ||
    value.identitySource !== actorIdentitySources[value.role]
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task expectedActor is not a closed broker actor");
  }
  requireSha256(value.identitySha256, "broker task expectedActor.identitySha256");
  return value;
}

function validateExecution(value, expectedActor, brokerRole) {
  assertExactKeys(
    value,
    [
      "actor",
      "operation",
      "locus",
      "driverId",
      "disruptive",
      "nativeTranscriptRequired",
      "actorSelector",
    ],
    "broker task execution",
  );
  requireIdentifier(value.operation, "broker task execution.operation");
  requireIdentifier(value.driverId, "broker task execution.driverId");
  if (
    value.actor !== "external-controller" ||
    typeof value.disruptive !== "boolean" ||
    typeof value.nativeTranscriptRequired !== "boolean"
  ) {
    fail("BROKER_PROTOCOL_EXECUTION", "broker task execution identity is invalid");
  }
  const selector = validateActorSelector(value.actorSelector);
  if (
    expectedActor.role !== brokerRole ||
    !allowedLoci[brokerRole]?.includes(value.locus) ||
    value.disruptive
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task actor, role, or locus differs");
  }
  if (selector.kind === "fixed" && selector.role !== expectedActor.role) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task fixed selector differs from expectedActor");
  }
  if (
    selector.kind === "parameter" &&
    (!Object.values(selector.roleByValue).includes(expectedActor.role) ||
      value.operation !== "exercise-directory-access" ||
      value.locus !== "controller-orchestrated-guest")
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task parameter selector cannot select expectedActor");
  }
  return value;
}

function validateScenarioAgreement(value, execution, expectedActor, actorSelectorInput) {
  const definition = PROBE_SCENARIO_DEFINITIONS.find(
    (candidate) =>
      candidate.rowId === value.coordinate.rowId &&
      candidate.variantId === value.coordinate.variantId,
  );
  if (definition === undefined) {
    fail("BROKER_PROTOCOL_SCENARIO", "broker task coordinate is not in the frozen registry");
  }
  if (definition.planSha256 !== value.action.scenarioPlanSha256) {
    fail("BROKER_PROTOCOL_SCENARIO", "broker task scenario plan differs from the registry");
  }
  const plannedAction = definition.actions.find(
    (candidate) => candidate.actionId === value.action.producerActionId,
  );
  if (
    plannedAction === undefined ||
    plannedAction.actor !== "external-controller" ||
    plannedAction.sequence !== value.action.sequence ||
    plannedAction.operation !== execution.operation
  ) {
    fail("BROKER_PROTOCOL_SCENARIO", "broker task action differs from the frozen scenario");
  }
  const invocation = {
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: plannedAction,
  };
  const audited = getProbeActionMapping(invocation);
  if (canonicalProbeJson(audited) !== canonicalProbeJson(execution)) {
    fail("BROKER_PROTOCOL_EXECUTION", "broker task execution is not the exact audited mapping");
  }
  const selector = audited.actorSelector;
  if (selector.kind === "fixed") {
    if (actorSelectorInput !== null) {
      fail(
        "BROKER_PROTOCOL_ACTOR_SELECTOR_INPUT",
        "fixed broker action must have a null actorSelectorInput",
      );
    }
  } else {
    const selectedValue = plannedAction.parameters.actor;
    if (
      !exactObject(actorSelectorInput) ||
      actorSelectorInput.parameter !== selector.parameter ||
      actorSelectorInput.value !== selectedValue
    ) {
      fail(
        "BROKER_PROTOCOL_ACTOR_SELECTOR_INPUT",
        "broker task actorSelectorInput differs from the frozen scenario",
      );
    }
  }
  const resolvedActor = resolveProbeActionActor(invocation);
  if (
    expectedActor.role !== resolvedActor.role ||
    expectedActor.identitySource !== resolvedActor.identitySource
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task expectedActor differs from the scenario selector");
  }
  let workItem;
  try {
    workItem = getProbeRunWorkItem({
      environmentId: value.coordinate.environmentId,
      pathProfileId: value.coordinate.pathProfileId,
      rowId: value.coordinate.rowId,
      variantId: value.coordinate.variantId,
    });
  } catch {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task has no frozen run-plan work item");
  }
  if (workItem.workId !== value.coordinate.workId) {
    fail("BROKER_PROTOCOL_COORDINATE", "broker task differs from its frozen run-plan work item");
  }
  const plannedRepetition = plannedAction.parameters.repetition;
  if (Number.isSafeInteger(plannedRepetition)) {
    if (
      plannedRepetition < 1 ||
      plannedRepetition > workItem.continuationRepetitions ||
      value.coordinate.repetition !== plannedRepetition
    ) {
      fail("BROKER_PROTOCOL_COORDINATE", "broker task repetition differs from the frozen action");
    }
  } else if (value.coordinate.repetition !== null) {
    fail("BROKER_PROTOCOL_COORDINATE", "non-repeated broker task must have a null repetition");
  }
  const operationCommand = {
    campaignRunId: value.coordinate.campaignRunId,
    attemptId: value.coordinate.attemptId,
    workId: value.coordinate.workId,
    ...(value.coordinate.repetition === null ? {} : { repetition: value.coordinate.repetition }),
  };
  const operationId = deriveProbeRuntimeScenarioOperationId(
    operationCommand,
    plannedAction.actionId,
  );
  if (value.action.operationId !== operationId) {
    fail("BROKER_PROTOCOL_OPERATION", "broker task operationId is not the canonical operation");
  }
  const runtimeActionIntentSha256 = hashProbeCanonicalJson({
    schemaVersion: 2,
    kind: "windows-host-probe-runtime-action-intent",
    campaignRunId: value.coordinate.campaignRunId,
    attemptId: value.coordinate.attemptId,
    workId: value.coordinate.workId,
    rowId: value.coordinate.rowId,
    variantId: value.coordinate.variantId,
    repetition: value.coordinate.repetition,
    planSha256: definition.planSha256,
    actionId: plannedAction.actionId,
    operationId,
    action: plannedAction,
    execution: audited,
    expectedActor,
  });
  if (value.runtimeActionIntentSha256 !== runtimeActionIntentSha256) {
    fail(
      "BROKER_PROTOCOL_RUNTIME_INTENT",
      "broker task runtime action intent differs from canonical inputs",
    );
  }
  return { definition, invocation, plannedAction, workItem };
}

function validateTaskLocalIdentity(value, expectedActor) {
  for (const key of [
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
  ]) {
    requireSha256(value[key], `broker task.${key}`);
  }
  if (
    ["primary-standard-user", "second-user"].includes(value.brokerRole) &&
    value.processSidSha256 !== expectedActor.identitySha256
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker task process SID differs from its expected local actor");
  }
}

function validateDriverRequest(value, execution) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "driverId", "requestArtifact"],
    "broker task driverRequest",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_DRIVER_REQUEST_KIND ||
    value.driverId !== execution.driverId
  ) {
    fail("BROKER_PROTOCOL_DRIVER", "broker task driverRequest identity is invalid");
  }
  validateArtifactReference(value.requestArtifact, "broker task driverRequest.requestArtifact");
  return value;
}

function validateTaskSnapshot(value, terminal) {
  assertExactKeys(
    value,
    terminal ? [...taskDraftKeys, "taskSha256", "signatureBase64"] : taskDraftKeys,
    "broker task",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_TASK_KIND ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    value.signatureAlgorithm !== "Ed25519"
  ) {
    fail("BROKER_PROTOCOL_TASK_IDENTITY", "broker task authority identity is invalid");
  }
  requireIdentifier(value.taskId, "broker task.taskId");
  for (const key of [
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "manifestSha256",
    "candidateSha256",
    "runPlanSha256",
    "runAuthorizationClaimReceiptSha256",
    "runtimeActionIntentSha256",
    "brokerEnrollmentSha256",
  ]) {
    requireSha256(value[key], `broker task.${key}`);
  }
  requireIdentifier(value.brokerInstanceId, "broker task.brokerInstanceId");
  if (!PROBE_BROKER_ROLES.includes(value.brokerRole)) {
    fail("BROKER_PROTOCOL_BROKER", "broker task.brokerRole is invalid");
  }
  validateCoordinate(value.coordinate);
  validateAction(value.action);
  const expectedActor = validateExpectedActor(value.expectedActor);
  const execution = validateExecution(value.execution, expectedActor, value.brokerRole);
  const actorSelectorInput = validateActorSelectorInput(value.actorSelectorInput);
  validateScenarioAgreement(value, execution, expectedActor, actorSelectorInput);
  validateTaskLocalIdentity(value, expectedActor);
  validateDriverRequest(value.driverRequest, execution);
  if (!PROBE_BROKER_RECOVERY_CLASSES.includes(value.recoveryClass)) {
    fail("BROKER_PROTOCOL_RECOVERY", "broker task.recoveryClass is invalid");
  }
  requireTimestamp(value.issuedAt, "broker task.issuedAt");
  requireTimestamp(value.deadline, "broker task.deadline");
  const ttlMs = Date.parse(value.deadline) - Date.parse(value.issuedAt);
  if (ttlMs <= 0 || ttlMs > PROBE_BROKER_TASK_MAX_TTL_MS) {
    fail(
      "BROKER_PROTOCOL_DEADLINE",
      "broker task lifetime must be positive and at most ten minutes",
    );
  }
  decodeCanonicalBase64(value.nonceBase64, "broker task.nonceBase64", 32);
  if (terminal) {
    requireSha256(value.taskSha256, "broker task.taskSha256");
    decodeCanonicalBase64(value.signatureBase64, "broker task.signatureBase64", 64);
  }
  return value;
}

function deriveTaskDigestFromSnapshot(value) {
  const task = Object.fromEntries(taskDraftKeys.map((key) => [key, value[key]]));
  return createHash("sha256")
    .update(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-broker-task.v1",
        task,
      }),
      "utf8",
    )
    .digest("hex");
}

export function deriveProbeBrokerTaskDigest(value) {
  const snapshot = cloneProtocolData(value, "broker task");
  const terminal = exactObject(snapshot) && Object.hasOwn(snapshot, "taskSha256");
  validateTaskSnapshot(snapshot, terminal);
  return deriveTaskDigestFromSnapshot(snapshot);
}

export function validateProbeBrokerTask(value) {
  const snapshot = cloneProtocolData(value, "broker task");
  validateTaskSnapshot(snapshot, true);
  if (snapshot.taskSha256 !== deriveTaskDigestFromSnapshot(snapshot)) {
    fail("BROKER_PROTOCOL_TASK_DIGEST", "broker task digest is invalid");
  }
  return freezeCanonical(snapshot);
}

function deriveTaskSemanticKeyFromSnapshot(task) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-semantic-operation.v1",
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

function deriveTaskPhysicalOperationKeyFromSnapshot(task) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-physical-operation.v1",
    controllerIdentitySha256: task.controllerIdentitySha256,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    runtimeActionIntentSha256: task.runtimeActionIntentSha256,
    operationId: task.action.operationId,
    producerActionId: task.action.producerActionId,
  });
}

export function deriveProbeBrokerTaskSemanticKeySha256(value) {
  return deriveTaskSemanticKeyFromSnapshot(validateProbeBrokerTask(value));
}

export function deriveProbeBrokerTaskPhysicalOperationKeySha256(value) {
  return deriveTaskPhysicalOperationKeyFromSnapshot(validateProbeBrokerTask(value));
}

export function createProbeBrokerTask(input, signTaskDigest) {
  const snapshot = cloneProtocolData(input, "broker task creation input");
  assertExactKeys(snapshot, taskCreateInputKeys, "broker task creation input");
  if (typeof signTaskDigest !== "function") {
    fail("BROKER_PROTOCOL_SIGNATURE", "broker task requires a digest signer");
  }
  const draft = {
    schemaVersion: PROBE_BROKER_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_TASK_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    ...snapshot,
    signatureAlgorithm: "Ed25519",
  };
  validateTaskSnapshot(draft, false);
  const taskSha256 = deriveTaskDigestFromSnapshot(draft);
  const signature = signTaskDigest(Buffer.from(taskSha256, "hex"));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    fail("BROKER_PROTOCOL_SIGNATURE", "broker task signer returned an invalid signature");
  }
  return validateProbeBrokerTask({
    ...draft,
    taskSha256,
    signatureBase64: Buffer.from(
      signature.buffer,
      signature.byteOffset,
      signature.byteLength,
    ).toString("base64"),
  });
}

function loadCanonicalEd25519PublicKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 4096) {
    fail("BROKER_PROTOCOL_PUBLIC_KEY", "controller public-key bytes are invalid");
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    fail("BROKER_PROTOCOL_PUBLIC_KEY", "controller public key must be SPKI DER");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(key.export({ format: "der", type: "spki" })).equals(bytes)
  ) {
    fail("BROKER_PROTOCOL_PUBLIC_KEY", "controller public key must be canonical Ed25519");
  }
  return {
    key,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function verifyProbeBrokerTaskSignature(value, options) {
  assertExactKeys(
    options,
    ["controllerPublicKeyBytes", "expectedControllerIdentitySha256"],
    "broker task signature verification options",
  );
  const task = validateProbeBrokerTask(value);
  const publicKey = loadCanonicalEd25519PublicKey(options.controllerPublicKeyBytes);
  requireSha256(options.expectedControllerIdentitySha256, "expected controller identity digest");
  if (
    task.controllerIdentitySha256 !== options.expectedControllerIdentitySha256 ||
    task.controllerPublicKeySha256 !== publicKey.sha256
  ) {
    fail("BROKER_PROTOCOL_CONTROLLER", "broker task belongs to another controller");
  }
  if (
    !verify(
      null,
      Buffer.from(task.taskSha256, "hex"),
      publicKey.key,
      decodeCanonicalBase64(task.signatureBase64, "broker task.signatureBase64", 64),
    )
  ) {
    fail("BROKER_PROTOCOL_SIGNATURE", "broker task signature is invalid");
  }
  return task;
}

function deriveDriverValidationReceiptDigestFromSnapshot(value) {
  const receipt = Object.fromEntries(
    driverValidationReceiptDraftKeys.map((key) => [key, value[key]]),
  );
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-driver-validation-receipt.v1",
    receipt,
  });
}

function validateDriverValidationReceiptSnapshot(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest ? driverValidationReceiptKeys : driverValidationReceiptDraftKeys,
    "broker driver-validation receipt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-broker-driver-validation-receipt"
  ) {
    fail("BROKER_PROTOCOL_DRIVER_VALIDATION", "driver-validation receipt identity is invalid");
  }
  for (const key of ["taskSha256", "requestArtifactSha256", "requestSchemaSha256"]) {
    requireSha256(value[key], `broker driver-validation receipt.${key}`);
  }
  requireIdentifier(value.driverId, "broker driver-validation receipt.driverId");
  if (
    !Number.isSafeInteger(value.requestArtifactBytes) ||
    value.requestArtifactBytes < 1 ||
    value.requestArtifactBytes > PROBE_BROKER_MAX_ARTIFACT_BYTES
  ) {
    fail(
      "BROKER_PROTOCOL_DRIVER_VALIDATION",
      "driver-validation receipt artifact byte length is invalid",
    );
  }
  if (!PROBE_BROKER_RECOVERY_CLASSES.includes(value.recoveryClass)) {
    fail("BROKER_PROTOCOL_RECOVERY", "driver-validation receipt recovery class is invalid");
  }
  if (includeDigest) {
    requireSha256(value.receiptSha256, "broker driver-validation receipt.receiptSha256");
    if (value.receiptSha256 !== deriveDriverValidationReceiptDigestFromSnapshot(value)) {
      fail("BROKER_PROTOCOL_DRIVER_VALIDATION", "driver-validation receipt digest is invalid");
    }
  }
  return value;
}

export function deriveProbeBrokerDriverValidationReceiptDigest(value) {
  const snapshot = cloneProtocolData(value, "broker driver-validation receipt");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "receiptSha256");
  validateDriverValidationReceiptSnapshot(snapshot, includeDigest);
  return deriveDriverValidationReceiptDigestFromSnapshot(snapshot);
}

export function validateProbeBrokerDriverValidationReceipt(value) {
  const snapshot = cloneProtocolData(value, "broker driver-validation receipt");
  validateDriverValidationReceiptSnapshot(snapshot, true);
  return freezeCanonical(snapshot);
}

export function createProbeBrokerDriverValidationReceipt(input) {
  const snapshot = cloneProtocolData(input, "broker driver-validation receipt creation input");
  assertExactKeys(
    snapshot,
    driverValidationReceiptCreateInputKeys,
    "broker driver-validation receipt creation input",
  );
  const draft = {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-driver-validation-receipt",
    ...snapshot,
  };
  validateDriverValidationReceiptSnapshot(draft, false);
  return validateProbeBrokerDriverValidationReceipt({
    ...draft,
    receiptSha256: deriveDriverValidationReceiptDigestFromSnapshot(draft),
  });
}

function recoveryDirective(recoveryClass, disposition) {
  if (disposition === "fresh") return "execute";
  switch (recoveryClass) {
    case "read-only-replay":
      return "replay";
    case "inspect-and-reconcile":
      return "reconcile";
    case "never-auto-replay":
      return "manual-intervention";
    default:
      fail("BROKER_PROTOCOL_RECOVERY", "broker task recovery class is invalid");
  }
}

function validateReplayDecision(value, binding) {
  const snapshot = cloneProtocolData(value, "broker replay-journal decision");
  if (snapshot.disposition === "absent") {
    assertExactKeys(snapshot, replayAbsentKeys, "broker replay-journal decision");
    requireSha256(snapshot.semanticKeySha256, "broker replay decision semantic key");
    requireSha256(
      snapshot.physicalOperationKeySha256,
      "broker replay decision physical-operation key",
    );
    if (
      snapshot.semanticKeySha256 !== binding.semanticKeySha256 ||
      snapshot.physicalOperationKeySha256 !== binding.physicalOperationKeySha256
    ) {
      fail("BROKER_PROTOCOL_REPLAY", "replay decision belongs to another operation binding");
    }
    return snapshot;
  }
  if (snapshot.disposition === "equivocation") {
    assertExactKeys(snapshot, replayEquivocationKeys, "broker replay-journal decision");
    requireSha256(snapshot.semanticKeySha256, "broker replay decision semantic key");
    requireSha256(
      snapshot.physicalOperationKeySha256,
      "broker replay decision physical-operation key",
    );
    requireSha256(snapshot.retainedTaskSha256, "broker replay retained task digest");
    requireSha256(snapshot.replayJournalEntrySha256, "broker replay journal entry digest");
    if (
      snapshot.semanticKeySha256 !== binding.semanticKeySha256 ||
      snapshot.physicalOperationKeySha256 !== binding.physicalOperationKeySha256
    ) {
      fail("BROKER_PROTOCOL_REPLAY", "replay decision belongs to another operation binding");
    }
    fail(
      "BROKER_PROTOCOL_EQUIVOCATION",
      "broker replay-journal equivocation: semantic operation was re-enveloped",
    );
  }
  assertExactKeys(snapshot, replayDecisionKeys, "broker replay-journal decision");
  if (!["fresh", "retained"].includes(snapshot.disposition)) {
    fail("BROKER_PROTOCOL_REPLAY", "broker replay-journal decision is invalid");
  }
  for (const key of [
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "replayJournalEntrySha256",
  ]) {
    requireSha256(snapshot[key], `broker replay decision.${key}`);
  }
  if (
    snapshot.semanticKeySha256 !== binding.semanticKeySha256 ||
    snapshot.physicalOperationKeySha256 !== binding.physicalOperationKeySha256
  ) {
    fail("BROKER_PROTOCOL_REPLAY", "replay decision belongs to another operation binding");
  }
  if (snapshot.taskSha256 !== binding.taskSha256) {
    fail(
      "BROKER_PROTOCOL_EQUIVOCATION",
      "broker replay-journal equivocation: semantic operation has another task envelope",
    );
  }
  return snapshot;
}

function deriveAcceptedContextDigest(task, capability, directive) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-accepted-task-context.v1",
    taskSha256: task.taskSha256,
    capability,
    recoveryDirective: directive,
  });
}

export async function acceptProbeBrokerTask(value, options) {
  assertExactKeys(
    options,
    [
      "controllerPublicKeyBytes",
      "expectedControllerIdentitySha256",
      "executionAuthorityLease",
      "validateDriverRequest",
      "verificationInstant",
      "replayGuard",
    ],
    "broker task acceptance options",
  );
  if (typeof options.validateDriverRequest !== "function") {
    fail(
      "BROKER_PROTOCOL_ACCEPTANCE",
      "broker task acceptance validateDriverRequest must be a function",
    );
  }
  assertExactKeys(options.replayGuard, ["consume"], "broker task replayGuard");
  if (typeof options.replayGuard.consume !== "function") {
    fail("BROKER_PROTOCOL_REPLAY", "broker task replayGuard.consume must be a function");
  }
  const task = verifyProbeBrokerTaskSignature(value, {
    controllerPublicKeyBytes: options.controllerPublicKeyBytes,
    expectedControllerIdentitySha256: options.expectedControllerIdentitySha256,
  });
  const semanticKeySha256 = deriveTaskSemanticKeyFromSnapshot(task);
  const physicalOperationKeySha256 = deriveTaskPhysicalOperationKeyFromSnapshot(task);
  bindProbeBrokerExecutionAuthorityLeaseToOperation(
    options.executionAuthorityLease,
    physicalOperationKeySha256,
  );
  if (
    !(options.verificationInstant instanceof Date) ||
    !Number.isFinite(options.verificationInstant.getTime())
  ) {
    fail("BROKER_PROTOCOL_TIMESTAMP", "broker task acceptance instant is invalid");
  }
  const acceptedAt = options.verificationInstant.getTime();
  if (acceptedAt < Date.parse(task.issuedAt)) {
    fail("BROKER_PROTOCOL_DEADLINE", "broker task was issued in the future");
  }
  const allowFresh = acceptedAt < Date.parse(task.deadline);
  return withProbeBrokerExecutionAuthorityLease(
    options.executionAuthorityLease,
    "acceptance",
    async (authority) => {
      const executionAuthority = assertProbeBrokerExecutionAuthorityLease(
        options.executionAuthorityLease,
      );
      if (
        authority.controllerIdentitySha256 !== task.controllerIdentitySha256 ||
        authority.controllerPublicKeySha256 !== task.controllerPublicKeySha256 ||
        authority.candidateSha256 !== task.candidateSha256 ||
        authority.runAuthorizationClaimReceiptSha256 !== task.runAuthorizationClaimReceiptSha256 ||
        authority.semanticKeySha256 !== semanticKeySha256 ||
        authority.physicalOperationKeySha256 !== physicalOperationKeySha256 ||
        authority.runtimeActionIntentSha256 !== task.runtimeActionIntentSha256 ||
        authority.operationId !== task.action.operationId ||
        authority.producerActionId !== task.action.producerActionId ||
        authority.driverId !== task.driverRequest.driverId ||
        canonicalProbeJson(authority.coordinate) !== canonicalProbeJson(task.coordinate)
      ) {
        fail(
          "BROKER_PROTOCOL_PREPARED_RUN",
          "broker task differs from the current prepared run authority",
        );
      }
      if (
        task.brokerEnrollmentSha256 !== authority.brokerEnrollmentSha256 ||
        task.brokerInstanceId !== authority.brokerInstanceId ||
        task.brokerRole !== authority.brokerRole
      ) {
        fail("BROKER_PROTOCOL_BROKER", "broker task differs from its live execution authority");
      }
      if (task.mailboxAclSha256 !== authority.mailboxAclSha256) {
        fail(
          "BROKER_PROTOCOL_LOCAL_IDENTITY",
          "broker task mailbox ACL differs from its live execution authority",
        );
      }
      if (task.processSidSha256 !== authority.processSidSha256) {
        fail(
          "BROKER_PROTOCOL_LOCAL_IDENTITY",
          "broker task process SID differs from its live execution authority",
        );
      }
      if (task.bootIdSha256 !== authority.bootIdSha256) {
        fail("BROKER_PROTOCOL_LOCAL_IDENTITY", "broker task boot differs from live authority");
      }
      if (task.runnerSessionIdSha256 !== authority.runnerSessionIdSha256) {
        fail("BROKER_PROTOCOL_LOCAL_IDENTITY", "broker task session differs from live authority");
      }
      if (task.brokerRole === "remote-peer") {
        if (authority.peerAuthoritySha256 !== task.expectedActor.identitySha256) {
          fail(
            "BROKER_PROTOCOL_LOCAL_IDENTITY",
            "live remote peer authority differs from the expected opaque actor",
          );
        }
      } else if (authority.processSidSha256 !== task.expectedActor.identitySha256) {
        fail("BROKER_PROTOCOL_LOCAL_IDENTITY", "live process SID differs from expected actor");
      }
      const driverValidationRequest = freezeCanonical({
        taskSha256: task.taskSha256,
        driverId: task.driverRequest.driverId,
        execution: task.execution,
        requestArtifact: task.driverRequest.requestArtifact,
      });
      const driverValidationReceipt = validateProbeBrokerDriverValidationReceipt(
        await options.validateDriverRequest(driverValidationRequest),
      );
      if (
        driverValidationReceipt.taskSha256 !== task.taskSha256 ||
        driverValidationReceipt.driverId !== task.execution.driverId ||
        driverValidationReceipt.requestArtifactSha256 !==
          task.driverRequest.requestArtifact.sha256 ||
        driverValidationReceipt.requestArtifactBytes !== task.driverRequest.requestArtifact.bytes
      ) {
        fail(
          "BROKER_PROTOCOL_DRIVER_VALIDATION",
          "driver-validation receipt differs from the signed audited driver request",
        );
      }
      if (driverValidationReceipt.recoveryClass !== task.recoveryClass) {
        fail(
          "BROKER_PROTOCOL_RECOVERY",
          "signed recovery class differs from the trusted driver validation receipt",
        );
      }
      const replayBinding = freezeCanonical({
        taskId: task.taskId,
        taskSha256: task.taskSha256,
        nonceBase64: task.nonceBase64,
        recoveryClass: task.recoveryClass,
        issuedAt: task.issuedAt,
        deadline: task.deadline,
        allowFresh,
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
      });
      assertExactKeys(replayBinding, replayBindingKeys, "broker replay binding");
      const decision = validateReplayDecision(
        await options.replayGuard.consume(replayBinding),
        replayBinding,
      );
      if (decision.disposition === "absent") {
        if (!allowFresh) {
          fail(
            "BROKER_PROTOCOL_DEADLINE",
            "broker task deadline expired while absent from the replay journal; insertion is forbidden",
          );
        }
        fail("BROKER_PROTOCOL_REPLAY", "fresh-eligible broker task was not journaled atomically");
      }
      if (decision.disposition === "fresh" && !allowFresh) {
        fail("BROKER_PROTOCOL_REPLAY", "expired broker task cannot receive a fresh journal entry");
      }
      const directive = recoveryDirective(task.recoveryClass, decision.disposition);
      const capability = freezeCanonical({
        schemaVersion: 1,
        kind: "windows-host-probe-broker-acceptance-capability",
        semanticKeySha256,
        physicalOperationKeySha256,
        coordinate: task.coordinate,
        producerActionId: task.action.producerActionId,
        brokerTaskSha256: task.taskSha256,
        brokerTaskNonceSha256: createHash("sha256")
          .update(decodeCanonicalBase64(task.nonceBase64, "broker task.nonceBase64", 32))
          .digest("hex"),
        brokerEnrollmentSha256: task.brokerEnrollmentSha256,
        brokerInstanceId: task.brokerInstanceId,
        brokerRole: task.brokerRole,
        expectedActor: task.expectedActor,
        mailboxAclSha256: authority.mailboxAclSha256,
        processSidSha256: authority.processSidSha256,
        bootIdSha256: authority.bootIdSha256,
        runnerSessionIdSha256: authority.runnerSessionIdSha256,
        executionAuthoritySha256: executionAuthority.authoritySha256,
        recoveryClass: task.recoveryClass,
        driverValidationReceiptSha256: driverValidationReceipt.receiptSha256,
        replayJournalDisposition:
          decision.disposition === "fresh" ? "accepted" : "idempotent-replay",
        replayJournalEntrySha256: decision.replayJournalEntrySha256,
      });
      const context = {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-accepted-task-context",
        task,
        driverValidationReceipt,
        capability,
        recoveryDirective: directive,
        contextSha256: deriveAcceptedContextDigest(task, capability, directive),
      };
      const acceptedContext = freezeCanonical(context);
      liveAcceptedContexts.set(acceptedContext, options.executionAuthorityLease);
      return acceptedContext;
    },
  );
}

function validateResultActor(value, brokerRole) {
  assertExactKeys(value, ["role", "identitySource", "identitySha256"], "broker result actor");
  if (
    value.role !== brokerRole ||
    !PROBE_BROKER_ROLES.includes(value.role) ||
    value.identitySource !== actorIdentitySources[value.role]
  ) {
    fail("BROKER_PROTOCOL_ACTOR", "broker result actor is not the broker's closed actor");
  }
  requireSha256(value.identitySha256, "broker result actor.identitySha256");
  return value;
}

function validateReferenceArray(value, label, { nonEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.length > PROBE_BROKER_MAX_REFERENCES ||
    (nonEmpty && value.length === 0)
  ) {
    fail("BROKER_PROTOCOL_ARTIFACT", `${label} must be a bounded artifact array`);
  }
  let previous = null;
  for (const [index, reference] of value.entries()) {
    validateArtifactReference(reference, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, reference.sha256) >= 0) {
      fail("BROKER_PROTOCOL_ARTIFACT", `${label} must be digest-sorted and unique`);
    }
    previous = reference.sha256;
  }
  return value;
}

function validateObserverTranscripts(value) {
  if (!Array.isArray(value) || value.length > PROBE_BROKER_MAX_REFERENCES) {
    fail("BROKER_PROTOCOL_OBSERVER", "observerTranscripts must be a bounded array");
  }
  let previous = null;
  const transcriptDigests = new Set();
  for (const [index, reference] of value.entries()) {
    const label = `broker result observerTranscripts[${index}]`;
    assertExactKeys(reference, ["blobPath", "bytes", "sha256", "transcriptSha256"], label);
    validateArtifactReference(
      {
        blobPath: reference.blobPath,
        bytes: reference.bytes,
        sha256: reference.sha256,
      },
      label,
    );
    requireSha256(reference.transcriptSha256, `${label}.transcriptSha256`);
    if (
      (previous !== null && compareUtf8(previous, reference.sha256) >= 0) ||
      transcriptDigests.has(reference.transcriptSha256)
    ) {
      fail(
        "BROKER_PROTOCOL_OBSERVER",
        "observerTranscripts must be digest-sorted with unique transcript identities",
      );
    }
    previous = reference.sha256;
    transcriptDigests.add(reference.transcriptSha256);
  }
  return value;
}

function validateDriverResult(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "driverId", "resultArtifact"],
    "broker result driverResult",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_DRIVER_RESULT_KIND
  ) {
    fail("BROKER_PROTOCOL_DRIVER", "broker result driverResult identity is invalid");
  }
  requireIdentifier(value.driverId, "broker result driverResult.driverId");
  validateArtifactReference(value.resultArtifact, "broker result driverResult.resultArtifact");
  return value;
}

function validateResultArtifactUnion(value) {
  const digests = new Set([value.driverResult.resultArtifact.sha256]);
  for (const reference of [...value.proofArtifacts, ...value.observerTranscripts]) {
    if (digests.has(reference.sha256)) {
      fail("BROKER_PROTOCOL_ARTIFACT", "broker result artifact categories contain a duplicate");
    }
    digests.add(reference.sha256);
  }
  if (value.pausedSessionReceipt !== null) {
    validateArtifactReference(value.pausedSessionReceipt, "broker result pausedSessionReceipt");
    const retained = value.proofArtifacts.find(
      (reference) => reference.sha256 === value.pausedSessionReceipt.sha256,
    );
    if (
      retained === undefined ||
      canonicalProbeJson(retained) !== canonicalProbeJson(value.pausedSessionReceipt)
    ) {
      fail(
        "BROKER_PROTOCOL_ARTIFACT",
        "pausedSessionReceipt must identify one retained proof artifact",
      );
    }
  }
}

function validateResultSnapshot(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest ? [...resultDraftKeys, "resultSha256"] : resultDraftKeys,
    "broker result",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_RESULT_KIND
  ) {
    fail("BROKER_PROTOCOL_RESULT_IDENTITY", "broker result identity is invalid");
  }
  for (const key of [
    "taskSha256",
    "brokerEnrollmentSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
  ]) {
    requireSha256(value[key], `broker result.${key}`);
  }
  requireIdentifier(value.brokerInstanceId, "broker result.brokerInstanceId");
  if (!PROBE_BROKER_ROLES.includes(value.brokerRole)) {
    fail("BROKER_PROTOCOL_BROKER", "broker result.brokerRole is invalid");
  }
  validateResultActor(value.actor, value.brokerRole);
  if (!PROBE_BROKER_RESULT_OUTCOMES.includes(value.outcome)) {
    fail("BROKER_PROTOCOL_OUTCOME", "broker result.outcome is invalid");
  }
  validateDriverResult(value.driverResult);
  validateReferenceArray(value.proofArtifacts, "broker result proofArtifacts", {
    nonEmpty: value.outcome === "SUCCEEDED",
  });
  validateObserverTranscripts(value.observerTranscripts);
  validateResultArtifactUnion(value);
  if (includeDigest) requireSha256(value.resultSha256, "broker result.resultSha256");
  return value;
}

function deriveResultDigestFromSnapshot(value) {
  const result = Object.fromEntries(resultDraftKeys.map((key) => [key, value[key]]));
  return createHash("sha256")
    .update(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-broker-result.v1",
        result,
      }),
      "utf8",
    )
    .digest("hex");
}

export function deriveProbeBrokerResultDigest(value) {
  const snapshot = cloneProtocolData(value, "broker result");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "resultSha256");
  validateResultSnapshot(snapshot, includeDigest);
  return deriveResultDigestFromSnapshot(snapshot);
}

export function validateProbeBrokerResult(value) {
  const snapshot = cloneProtocolData(value, "broker result");
  validateResultSnapshot(snapshot, true);
  if (snapshot.resultSha256 !== deriveResultDigestFromSnapshot(snapshot)) {
    fail("BROKER_PROTOCOL_RESULT_DIGEST", "broker result digest is invalid");
  }
  return freezeCanonical(snapshot);
}

export function createProbeBrokerResult(input) {
  const snapshot = cloneProtocolData(input, "broker result creation input");
  assertExactKeys(snapshot, resultCreateInputKeys, "broker result creation input");
  const draft = {
    schemaVersion: PROBE_BROKER_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_RESULT_KIND,
    ...snapshot,
  };
  validateResultSnapshot(draft, false);
  return validateProbeBrokerResult({
    ...draft,
    resultSha256: deriveResultDigestFromSnapshot(draft),
  });
}

function validateAcceptedTaskContext(value) {
  const snapshot = cloneProtocolData(value, "accepted broker task context");
  assertExactKeys(snapshot, acceptedContextKeys, "accepted broker task context");
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.kind !== "windows-host-probe-broker-accepted-task-context"
  ) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "accepted broker task context identity is invalid");
  }
  const task = validateProbeBrokerTask(snapshot.task);
  const driverValidationReceipt = validateProbeBrokerDriverValidationReceipt(
    snapshot.driverValidationReceipt,
  );
  const capability = snapshot.capability;
  assertExactKeys(capability, acceptanceCapabilityKeys, "broker acceptance capability");
  if (
    capability.schemaVersion !== 1 ||
    capability.kind !== "windows-host-probe-broker-acceptance-capability"
  ) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "broker acceptance capability identity is invalid");
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
    requireSha256(capability[key], `broker acceptance capability.${key}`);
  }
  requireIdentifier(capability.producerActionId, "broker acceptance capability.producerActionId");
  requireIdentifier(capability.brokerInstanceId, "broker acceptance capability.brokerInstanceId");
  validateCoordinate(capability.coordinate);
  validateExpectedActor(capability.expectedActor);
  if (
    !PROBE_BROKER_ROLES.includes(capability.brokerRole) ||
    !PROBE_BROKER_RECOVERY_CLASSES.includes(capability.recoveryClass) ||
    !["accepted", "idempotent-replay"].includes(capability.replayJournalDisposition)
  ) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "broker acceptance capability has an invalid disposition");
  }
  const nonceSha256 = createHash("sha256")
    .update(decodeCanonicalBase64(task.nonceBase64, "broker task.nonceBase64", 32))
    .digest("hex");
  if (
    capability.semanticKeySha256 !== deriveTaskSemanticKeyFromSnapshot(task) ||
    capability.physicalOperationKeySha256 !== deriveTaskPhysicalOperationKeyFromSnapshot(task) ||
    capability.brokerTaskSha256 !== task.taskSha256 ||
    capability.brokerTaskNonceSha256 !== nonceSha256 ||
    capability.producerActionId !== task.action.producerActionId ||
    capability.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    capability.brokerInstanceId !== task.brokerInstanceId ||
    capability.brokerRole !== task.brokerRole ||
    capability.mailboxAclSha256 !== task.mailboxAclSha256 ||
    capability.processSidSha256 !== task.processSidSha256 ||
    capability.bootIdSha256 !== task.bootIdSha256 ||
    capability.runnerSessionIdSha256 !== task.runnerSessionIdSha256 ||
    capability.recoveryClass !== task.recoveryClass ||
    capability.driverValidationReceiptSha256 !== driverValidationReceipt.receiptSha256 ||
    driverValidationReceipt.taskSha256 !== task.taskSha256 ||
    driverValidationReceipt.driverId !== task.driverRequest.driverId ||
    driverValidationReceipt.requestArtifactSha256 !== task.driverRequest.requestArtifact.sha256 ||
    driverValidationReceipt.requestArtifactBytes !== task.driverRequest.requestArtifact.bytes ||
    driverValidationReceipt.recoveryClass !== task.recoveryClass ||
    canonicalProbeJson(capability.coordinate) !== canonicalProbeJson(task.coordinate) ||
    canonicalProbeJson(capability.expectedActor) !== canonicalProbeJson(task.expectedActor)
  ) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "broker acceptance capability differs from its task");
  }
  const expectedDirective =
    capability.replayJournalDisposition === "accepted"
      ? "execute"
      : recoveryDirective(task.recoveryClass, "retained");
  if (snapshot.recoveryDirective !== expectedDirective) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "broker recovery directive differs from its journal state");
  }
  requireSha256(snapshot.contextSha256, "accepted broker task context digest");
  if (
    snapshot.contextSha256 !==
    deriveAcceptedContextDigest(task, capability, snapshot.recoveryDirective)
  ) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "accepted broker task context digest is invalid");
  }
  return freezeCanonical(snapshot);
}

// Driver request bytes remain opaque here. The selected driver's schema validator must validate
// the content-addressed blob after dereference and before any execution.
export function getProbeBrokerAcceptedContextExecutionAuthorityLease(acceptedContextValue) {
  if (!liveAcceptedContexts.has(acceptedContextValue)) {
    fail(
      "BROKER_PROTOCOL_ACCEPTANCE",
      "broker result requires a context rehydrated through the durable replay guard",
    );
  }
  validateAcceptedTaskContext(acceptedContextValue);
  const executionAuthorityLease = liveAcceptedContexts.get(acceptedContextValue);
  assertProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
  return executionAuthorityLease;
}

function validateResultForAcceptedContext(value, acceptedContextValue) {
  const acceptedContext = validateAcceptedTaskContext(acceptedContextValue);
  const { capability, task } = acceptedContext;
  const result = validateProbeBrokerResult(value);
  if (
    result.taskSha256 !== task.taskSha256 ||
    result.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    result.brokerInstanceId !== task.brokerInstanceId ||
    result.brokerRole !== task.brokerRole ||
    canonicalProbeJson(result.actor) !== canonicalProbeJson(task.expectedActor) ||
    result.driverResult.driverId !== task.driverRequest.driverId ||
    result.bootIdSha256 !== capability.bootIdSha256 ||
    result.runnerSessionIdSha256 !== capability.runnerSessionIdSha256
  ) {
    fail("BROKER_PROTOCOL_RESULT_BINDING", "broker result differs from its exact task binding");
  }
  if (task.execution.nativeTranscriptRequired && result.observerTranscripts.length === 0) {
    fail("BROKER_PROTOCOL_RESULT_BINDING", "broker result omitted its primary observer");
  }
  return result;
}

export async function validateProbeBrokerResultForTask(
  value,
  acceptedContextValue,
  executionAuthorityConfirmation,
) {
  const executionAuthorityLease =
    getProbeBrokerAcceptedContextExecutionAuthorityLease(acceptedContextValue);
  return withProbeBrokerExecutionAuthorityConfirmation(
    executionAuthorityLease,
    executionAuthorityConfirmation,
    "result-validation",
    () => validateResultForAcceptedContext(value, acceptedContextValue),
  );
}

export async function validateProbeBrokerResultForTaskUnderLiveAuthority(
  value,
  acceptedContextValue,
) {
  const executionAuthorityLease =
    getProbeBrokerAcceptedContextExecutionAuthorityLease(acceptedContextValue);
  return withProbeBrokerExecutionAuthorityLease(executionAuthorityLease, "result-validation", () =>
    validateResultForAcceptedContext(value, acceptedContextValue),
  );
}

function controllerAcceptanceInputFromResult(result, acceptedContextValue) {
  const { capability } = validateAcceptedTaskContext(acceptedContextValue);
  return validateProbeBrokerControllerAcceptanceInput({
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
  });
}

export async function createProbeBrokerControllerAcceptanceInput(
  value,
  acceptedContextValue,
  executionAuthorityConfirmation,
) {
  const result = await validateProbeBrokerResultForTask(
    value,
    acceptedContextValue,
    executionAuthorityConfirmation,
  );
  return controllerAcceptanceInputFromResult(result, acceptedContextValue);
}

export async function createProbeBrokerControllerAcceptanceInputUnderLiveAuthority(
  value,
  acceptedContextValue,
) {
  const result = await validateProbeBrokerResultForTaskUnderLiveAuthority(
    value,
    acceptedContextValue,
  );
  return controllerAcceptanceInputFromResult(result, acceptedContextValue);
}

export function validateProbeBrokerControllerAcceptanceInput(value) {
  const snapshot = cloneProtocolData(value, "broker controller acceptance input");
  assertExactKeys(snapshot, controllerAcceptanceInputKeys, "broker controller acceptance input");
  validateCoordinate(snapshot.coordinate);
  requireIdentifier(
    snapshot.producerActionId,
    "broker controller acceptance input.producerActionId",
  );
  requireIdentifier(
    snapshot.brokerInstanceId,
    "broker controller acceptance input.brokerInstanceId",
  );
  if (!PROBE_BROKER_ROLES.includes(snapshot.brokerRole)) {
    fail("BROKER_PROTOCOL_BROKER", "broker controller acceptance role is invalid");
  }
  validateExpectedActor(snapshot.expectedActor);
  for (const key of [
    "brokerTaskSha256",
    "brokerTaskNonceSha256",
    "brokerResultSha256",
    "brokerEnrollmentSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "replayJournalEntrySha256",
  ]) {
    requireSha256(snapshot[key], `broker controller acceptance input.${key}`);
  }
  if (!["accepted", "idempotent-replay"].includes(snapshot.replayJournalDisposition)) {
    fail("BROKER_PROTOCOL_ACCEPTANCE", "broker controller acceptance disposition is invalid");
  }
  return freezeCanonical(snapshot);
}

export function validateProbeBrokerControllerAcceptanceInputForTask(value, taskValue, resultValue) {
  const input = validateProbeBrokerControllerAcceptanceInput(value);
  const task = validateProbeBrokerTask(taskValue);
  const result = validateProbeBrokerResult(resultValue);
  const nonceSha256 = createHash("sha256")
    .update(decodeCanonicalBase64(task.nonceBase64, "broker task.nonceBase64", 32))
    .digest("hex");
  if (
    canonicalProbeJson(input.coordinate) !== canonicalProbeJson(task.coordinate) ||
    input.producerActionId !== task.action.producerActionId ||
    input.brokerTaskSha256 !== task.taskSha256 ||
    input.brokerTaskNonceSha256 !== nonceSha256 ||
    input.brokerResultSha256 !== result.resultSha256 ||
    input.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    input.brokerInstanceId !== task.brokerInstanceId ||
    input.brokerRole !== task.brokerRole ||
    canonicalProbeJson(input.expectedActor) !== canonicalProbeJson(task.expectedActor) ||
    input.mailboxAclSha256 !== task.mailboxAclSha256 ||
    input.processSidSha256 !== task.processSidSha256 ||
    input.bootIdSha256 !== task.bootIdSha256 ||
    input.runnerSessionIdSha256 !== task.runnerSessionIdSha256 ||
    result.taskSha256 !== task.taskSha256 ||
    result.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    result.brokerInstanceId !== task.brokerInstanceId ||
    result.brokerRole !== task.brokerRole ||
    canonicalProbeJson(result.actor) !== canonicalProbeJson(task.expectedActor) ||
    result.bootIdSha256 !== task.bootIdSha256 ||
    result.runnerSessionIdSha256 !== task.runnerSessionIdSha256
  ) {
    fail(
      "BROKER_PROTOCOL_CONTROLLER_ACCEPTANCE",
      "broker controller acceptance input differs from its task or result",
    );
  }
  return input;
}
