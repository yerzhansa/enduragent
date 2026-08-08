import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "./probe-contract.mjs";
import { validateProbeBrokerResult } from "./broker/protocol.mjs";
import { validateEvidenceRelativePath } from "./evidence-store.mjs";
import { validateNativeCommandTranscript } from "./native-client.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "./probe-runner.mjs";

export const PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION = 1;
export const PROBE_CONTROLLER_ACTION_ATTESTATION_SCHEMA_VERSION = 1;
export const PROBE_CONTROLLER_BROKER_ACCEPTANCE_SCHEMA_VERSION = 1;

const receiptKind = "windows-host-probe-controller-action-execution-receipt";
const provenanceKind = "windows-host-probe-controller-action-provenance";
const actionAttestationKind = "windows-host-probe-controller-action-attestation";
const brokerAcceptanceKind = "windows-host-probe-controller-broker-acceptance";
const maximumReferences = 4096;
const maximumJsonDepth = 64;
const maximumJsonNodes = 50_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const actorIdentitySources = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  controller: "controller.identitySha256",
  "power-control": "actors.powerControlActorSha256",
  "remote-peer": "actors.remotePeerActorSha256",
  "second-user": "actors.secondUserSidSha256",
});
const brokerActorRoles = Object.freeze(["primary-standard-user", "remote-peer", "second-user"]);
const executionLoci = Object.freeze([
  "guest-native-helper",
  "guest-standard-user-worker",
  "guest-second-user-broker",
  "controller-host",
  "controller-remote-peer",
  "controller-orchestrated-guest",
]);
const receiptKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "executionBundleId",
  "executionBundleManifestSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "scenarioPlanSha256",
  "producerActionId",
  "operation",
  "intentSha256",
  "execution",
  "expectedActor",
  "actionResult",
  "actionResultArtifact",
  "proofArtifacts",
  "observerTranscripts",
  "brokerProof",
  "pausedSessionReceipt",
  "nativeActionPlans",
  "receiptSha256",
]);
const receiptDraftKeys = Object.freeze(receiptKeys.filter((key) => key !== "receiptSha256"));
const receiptCreateInputKeys = Object.freeze(
  receiptDraftKeys.filter(
    (key) =>
      !["schemaVersion", "kind", "campaignId", "manifestSha256", "runPlanSha256"].includes(key),
  ),
);
const provenanceKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "executionBundleId",
  "executionBundleManifestSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "scenarioPlanSha256",
  "producerActionId",
  "operation",
  "intentSha256",
  "receiptSha256",
  "records",
  "provenanceSha256",
]);
const provenanceDraftKeys = Object.freeze(
  provenanceKeys.filter((key) => key !== "provenanceSha256"),
);
const provenanceRecordKeys = Object.freeze([
  "executionReceipt",
  "controllerRequest",
  "operationRequest",
  "controllerResponse",
  "operationResponse",
]);
const provenanceInputRecordKeys = Object.freeze(
  provenanceRecordKeys.filter((key) => key !== "executionReceipt"),
);
const actionAttestationKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "executionBundleId",
  "executionBundleManifestSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "scenarioPlanSha256",
  "producerActionId",
  "operation",
  "runtimeActionIntentSha256",
  "execution",
  "expectedActor",
  "broker",
  "observerCommands",
  "attestationSha256",
]);
const actionAttestationDraftKeys = Object.freeze(
  actionAttestationKeys.filter((key) => key !== "attestationSha256"),
);
const actionAttestationCreateInputKeys = Object.freeze(
  actionAttestationDraftKeys.filter(
    (key) =>
      !["schemaVersion", "kind", "campaignId", "manifestSha256", "runPlanSha256"].includes(key),
  ),
);
const actionAttestationBrokerKeys = Object.freeze([
  "brokerAcceptanceSha256",
  "brokerTaskSha256",
  "brokerTaskNonceSha256",
  "brokerResultSha256",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "mailboxAclSha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "replayJournalDisposition",
  "replayJournalEntrySha256",
]);
const actionAttestationObserverCommandKeys = Object.freeze([
  "transcriptSha256",
  "sequence",
  "commandId",
  "requestFrameSha256",
  "responseFrameSha256",
  "ok",
]);
const brokerAcceptanceKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
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
  "acceptanceSha256",
]);
const brokerAcceptanceDraftKeys = Object.freeze(
  brokerAcceptanceKeys.filter((key) => key !== "acceptanceSha256"),
);
const brokerAcceptanceCreateInputKeys = Object.freeze(
  brokerAcceptanceDraftKeys.filter(
    (key) =>
      !["schemaVersion", "kind", "campaignId", "manifestSha256", "runPlanSha256"].includes(key),
  ),
);

export class ProbeControllerActionProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeControllerActionProvenanceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeControllerActionProvenanceError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function cloneCanonicalData(value, label) {
  const ancestors = new Set();
  let nodes = 0;

  function clone(current, path, depth) {
    nodes += 1;
    if (nodes > maximumJsonNodes || depth > maximumJsonDepth) {
      fail("CONTROLLER_ACTION_BOUND", `${label} exceeds its structural bound`);
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        fail("CONTROLLER_ACTION_JSON", `${path} must be a canonical number`);
      }
      return current;
    }
    if (typeof current === "string") {
      if (
        !isWellFormedString(current) ||
        current !== current.normalize("NFC") ||
        current.includes("\0") ||
        Buffer.byteLength(current, "utf8") > 64 * 1024
      ) {
        fail("CONTROLLER_ACTION_JSON", `${path} must be a bounded NFC string`);
      }
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      fail("CONTROLLER_ACTION_JSON", `${path} must be acyclic JSON data`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          fail("CONTROLLER_ACTION_JSON", `${path} must be a plain array`);
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          fail("CONTROLLER_ACTION_JSON", `${path} has an invalid length`);
        }
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.length !== length + 1 ||
          ownKeys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length),
          )
        ) {
          fail("CONTROLLER_ACTION_JSON", `${path} must be a dense undecorated array`);
        }
        const result = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
            fail("CONTROLLER_ACTION_JSON", `${path}[${index}] must be enumerable data`);
          }
          result.push(clone(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return result;
      }
      if (!exactObject(current)) {
        fail("CONTROLLER_ACTION_JSON", `${path} must be a plain object`);
      }
      const result = {};
      for (const key of Reflect.ownKeys(current)) {
        if (
          typeof key !== "string" ||
          key === "__proto__" ||
          !isWellFormedString(key) ||
          key !== key.normalize("NFC") ||
          Buffer.byteLength(key, "utf8") > 256
        ) {
          fail("CONTROLLER_ACTION_JSON", `${path} has an invalid field name`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("CONTROLLER_ACTION_JSON", `${path}.${key} must be enumerable data`);
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, `${path}.${key}`, depth + 1),
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  }

  return clone(value, label, 0);
}

function deepFreeze(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (Object.hasOwn(descriptor, "value")) pending.push(descriptor.value);
      }
      Object.freeze(current);
    }
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) {
    fail("CONTROLLER_ACTION_SCHEMA", `${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("CONTROLLER_ACTION_SCHEMA", `${label} has an invalid field set`);
  }
  actual.sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("CONTROLLER_ACTION_SCHEMA", `${label} has an invalid field set`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("CONTROLLER_ACTION_SCHEMA", `${label}.${key} must be enumerable data`);
    }
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_ACTION_SHA256", `${label} must be lowercase 64-hex`);
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
    fail("CONTROLLER_ACTION_IDENTIFIER", `${label} must be a bounded protocol identifier`);
  }
  return value;
}

function requireArtifactPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value !== value.normalize("NFC")
  ) {
    fail("CONTROLLER_ACTION_PATH", `${label} must be a bounded relative slash path`);
  }
  if (value.split("/").some((part) => Buffer.byteLength(part, "utf8") > 255)) {
    fail("CONTROLLER_ACTION_PATH", `${label} contains an unsafe path segment`);
  }
  try {
    validateEvidenceRelativePath(value);
  } catch {
    fail("CONTROLLER_ACTION_PATH", `${label} contains an unsafe path segment`);
  }
  return value;
}

function rawCanonicalSha256(value) {
  return createHash("sha256").update(canonicalProbeJson(value), "utf8").digest("hex");
}

function rawCanonicalBytes(value) {
  return Buffer.byteLength(canonicalProbeJson(value), "utf8");
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
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
    "controller action coordinate",
  );
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    requireIdentifier(value[key], `controller action coordinate.${key}`);
  }
  if (!new Set(["win11-floor", "win11-current"]).has(value.environmentId)) {
    fail("CONTROLLER_ACTION_COORDINATE", "controller action environmentId is invalid");
  }
  if (!new Set(["ascii", "spaces-unicode"]).has(value.pathProfileId)) {
    fail("CONTROLLER_ACTION_COORDINATE", "controller action pathProfileId is invalid");
  }
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("CONTROLLER_ACTION_COORDINATE", "controller action rowId is invalid");
  }
  if (
    value.repetition !== null &&
    (!Number.isSafeInteger(value.repetition) || value.repetition < 1)
  ) {
    fail("CONTROLLER_ACTION_COORDINATE", "controller action repetition is invalid");
  }
  return value;
}

function validateOperation(value) {
  assertExactKeys(value, ["operationId", "kind", "sequence"], "controller action operation");
  requireIdentifier(value.operationId, "controller action operation.operationId");
  if (value.kind !== "scenario-action") {
    fail("CONTROLLER_ACTION_OPERATION", "controller action operation kind is invalid");
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    fail("CONTROLLER_ACTION_OPERATION", "controller action operation sequence is invalid");
  }
  return value;
}

function validateActorSelector(value) {
  if (!exactObject(value)) {
    fail("CONTROLLER_ACTION_EXECUTION", "execution.actorSelector must be a plain object");
  }
  if (value.kind === "fixed") {
    assertExactKeys(value, ["kind", "role"], "execution.actorSelector");
    if (!Object.hasOwn(actorIdentitySources, value.role)) {
      fail("CONTROLLER_ACTION_EXECUTION", "execution.actorSelector role is invalid");
    }
    return value;
  }
  assertExactKeys(value, ["kind", "parameter", "roleByValue"], "execution.actorSelector");
  if (value.kind !== "parameter" || value.parameter !== "actor") {
    fail("CONTROLLER_ACTION_EXECUTION", "execution.actorSelector parameter is invalid");
  }
  assertExactKeys(
    value.roleByValue,
    ["current-user", "second-user"],
    "execution.actorSelector.roleByValue",
  );
  if (
    value.roleByValue["current-user"] !== "primary-standard-user" ||
    value.roleByValue["second-user"] !== "second-user"
  ) {
    fail("CONTROLLER_ACTION_EXECUTION", "execution.actorSelector values are invalid");
  }
  return value;
}

function validateExecution(value, expectedActor) {
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
    "controller action execution",
  );
  if (value.actor !== "external-controller") {
    fail("CONTROLLER_ACTION_EXECUTION", "receipt is not for an external-controller action");
  }
  requireIdentifier(value.operation, "controller action execution.operation");
  requireIdentifier(value.driverId, "controller action execution.driverId");
  if (!executionLoci.includes(value.locus)) {
    fail("CONTROLLER_ACTION_EXECUTION", "controller action execution.locus is invalid");
  }
  if (
    typeof value.disruptive !== "boolean" ||
    typeof value.nativeTranscriptRequired !== "boolean"
  ) {
    fail("CONTROLLER_ACTION_EXECUTION", "controller action execution flags are invalid");
  }
  const selector = validateActorSelector(value.actorSelector);
  if (selector.kind === "fixed" && selector.role !== expectedActor.role) {
    fail("CONTROLLER_ACTION_ACTOR", "fixed actor selector differs from expectedActor");
  }
  if (
    selector.kind === "parameter" &&
    !Object.values(selector.roleByValue).includes(expectedActor.role)
  ) {
    fail("CONTROLLER_ACTION_ACTOR", "parameter actor selector cannot select expectedActor");
  }
  const allowedLoci = {
    "primary-standard-user": ["guest-standard-user-worker", "controller-orchestrated-guest"],
    controller: ["controller-host"],
    "power-control": ["controller-host"],
    "remote-peer": ["controller-remote-peer"],
    "second-user": ["guest-second-user-broker"],
  };
  if (selector.kind === "parameter") {
    if (
      value.operation !== "exercise-directory-access" ||
      value.locus !== "controller-orchestrated-guest"
    ) {
      fail("CONTROLLER_ACTION_EXECUTION", "parameter actor routing is not the frozen F-02 action");
    }
  } else if (!allowedLoci[expectedActor.role]?.includes(value.locus)) {
    fail("CONTROLLER_ACTION_EXECUTION", "execution locus differs from expectedActor");
  }
  if (value.disruptive && !["controller", "power-control"].includes(expectedActor.role)) {
    fail("CONTROLLER_ACTION_EXECUTION", "guest actor cannot own a disruptive action");
  }
  return value;
}

function validateExpectedActor(value) {
  assertExactKeys(
    value,
    ["role", "identitySource", "identitySha256"],
    "controller action expectedActor",
  );
  if (
    !Object.hasOwn(actorIdentitySources, value.role) ||
    value.identitySource !== actorIdentitySources[value.role]
  ) {
    fail("CONTROLLER_ACTION_ACTOR", "controller action expectedActor is not closed");
  }
  requireSha256(value.identitySha256, "controller action expectedActor.identitySha256");
  return value;
}

function validateArtifactReference(value, label) {
  assertExactKeys(value, ["path", "sha256"], label);
  requireArtifactPath(value.path, `${label}.path`);
  requireSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateReferenceArray(value, label, { nonEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.length > maximumReferences ||
    (nonEmpty && value.length === 0)
  ) {
    fail("CONTROLLER_ACTION_ARTIFACT", `${label} must be a bounded artifact array`);
  }
  let previous = null;
  const foldedPaths = new Set();
  const digests = new Set();
  for (const [index, reference] of value.entries()) {
    validateArtifactReference(reference, `${label}[${index}]`);
    const foldedPath = reference.path.toLocaleLowerCase("en-US");
    if (
      (previous !== null && compareUtf8(previous, reference.path) >= 0) ||
      foldedPaths.has(foldedPath) ||
      digests.has(reference.sha256)
    ) {
      fail("CONTROLLER_ACTION_ARTIFACT", `${label} contains a path or digest collision`);
    }
    previous = reference.path;
    foldedPaths.add(foldedPath);
    digests.add(reference.sha256);
  }
  return value;
}

function validateObserverReference(value, label) {
  assertExactKeys(value, ["path", "sha256", "transcriptSha256"], label);
  requireArtifactPath(value.path, `${label}.path`);
  requireSha256(value.sha256, `${label}.sha256`);
  requireSha256(value.transcriptSha256, `${label}.transcriptSha256`);
  return value;
}

function validateObserverArray(value) {
  if (!Array.isArray(value) || value.length > maximumReferences) {
    fail("CONTROLLER_ACTION_OBSERVER", "observerTranscripts must be a bounded array");
  }
  let previous = null;
  const foldedPaths = new Set();
  const artifactDigests = new Set();
  const transcriptDigests = new Set();
  for (const [index, reference] of value.entries()) {
    validateObserverReference(reference, `observerTranscripts[${index}]`);
    const foldedPath = reference.path.toLocaleLowerCase("en-US");
    if (
      (previous !== null && compareUtf8(previous, reference.path) >= 0) ||
      foldedPaths.has(foldedPath) ||
      artifactDigests.has(reference.sha256) ||
      transcriptDigests.has(reference.transcriptSha256)
    ) {
      fail(
        "CONTROLLER_ACTION_OBSERVER",
        "observerTranscripts contains a path, artifact digest, or transcript digest collision",
      );
    }
    previous = reference.path;
    foldedPaths.add(foldedPath);
    artifactDigests.add(reference.sha256);
    transcriptDigests.add(reference.transcriptSha256);
  }
  return value;
}

function hasExactReference(references, expected) {
  return references.some(
    (reference) => reference.path === expected.path && reference.sha256 === expected.sha256,
  );
}

function validateOptionalProofReference(value, proofs, label) {
  if (value === null) return null;
  validateArtifactReference(value, label);
  if (!hasExactReference(proofs, value)) {
    fail("CONTROLLER_ACTION_PROOF", `${label} is not present in proofArtifacts`);
  }
  return value;
}

function validateActionAttestationBroker(value, expectedActor) {
  assertExactKeys(value, actionAttestationBrokerKeys, "controller action attestation broker");
  for (const key of [
    "brokerAcceptanceSha256",
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
    requireSha256(value[key], `controller action attestation broker.${key}`);
  }
  requireIdentifier(
    value.brokerInstanceId,
    "controller action attestation broker.brokerInstanceId",
  );
  if (!brokerActorRoles.includes(value.brokerRole) || value.brokerRole !== expectedActor.role) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_BROKER",
      "controller action attestation broker role differs from its expected actor",
    );
  }
  if (!new Set(["accepted", "idempotent-replay"]).has(value.replayJournalDisposition)) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_BROKER",
      "controller action attestation replay journal disposition is invalid",
    );
  }
  return value;
}

function validateActionAttestationObserverCommands(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumReferences) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_OBSERVER",
      "controller action attestation observerCommands must be a bounded non-empty array",
    );
  }
  let previous = null;
  const framePairs = new Set();
  for (const [index, command] of value.entries()) {
    const label = `controller action attestation observerCommands[${index}]`;
    assertExactKeys(command, actionAttestationObserverCommandKeys, label);
    requireSha256(command.transcriptSha256, `${label}.transcriptSha256`);
    if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
      fail("CONTROLLER_ACTION_ATTESTATION_OBSERVER", `${label}.sequence is invalid`);
    }
    requireIdentifier(command.commandId, `${label}.commandId`);
    requireSha256(command.requestFrameSha256, `${label}.requestFrameSha256`);
    requireSha256(command.responseFrameSha256, `${label}.responseFrameSha256`);
    if (typeof command.ok !== "boolean") {
      fail("CONTROLLER_ACTION_ATTESTATION_OBSERVER", `${label}.ok must be boolean`);
    }
    const orderKey = `${command.transcriptSha256}\0${String(command.sequence).padStart(16, "0")}`;
    const frameKey = [
      command.transcriptSha256,
      command.commandId,
      command.requestFrameSha256,
      command.responseFrameSha256,
    ].join("\0");
    if ((previous !== null && compareUtf8(previous, orderKey) >= 0) || framePairs.has(frameKey)) {
      fail(
        "CONTROLLER_ACTION_ATTESTATION_OBSERVER",
        "controller action attestation observer commands are not ordered and unique",
      );
    }
    previous = orderKey;
    framePairs.add(frameKey);
  }
  return value;
}

function actionAttestationDigestPayload(value) {
  return Object.fromEntries(actionAttestationDraftKeys.map((key) => [key, value[key]]));
}

function deriveActionAttestationDigestFromSnapshot(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-action-attestation.v1",
    attestation: actionAttestationDigestPayload(value),
  });
}

function validateActionAttestationSnapshot(value, includeDigest, verifyDigest = true) {
  assertExactKeys(
    value,
    includeDigest ? actionAttestationKeys : actionAttestationDraftKeys,
    "controller action attestation",
  );
  if (
    value.schemaVersion !== PROBE_CONTROLLER_ACTION_ATTESTATION_SCHEMA_VERSION ||
    value.kind !== actionAttestationKind ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_IDENTITY",
      "controller action attestation identity is invalid",
    );
  }
  for (const key of [
    "candidateSha256",
    "executionBundleManifestSha256",
    "runAuthorizationClaimReceiptSha256",
    "scenarioPlanSha256",
    "runtimeActionIntentSha256",
  ]) {
    requireSha256(value[key], `controller action attestation.${key}`);
  }
  requireIdentifier(value.executionBundleId, "controller action attestation.executionBundleId");
  requireIdentifier(value.producerActionId, "controller action attestation.producerActionId");
  validateCoordinate(value.coordinate);
  validateOperation(value.operation);
  const expectedActor = validateExpectedActor(value.expectedActor);
  validateExecution(value.execution, expectedActor);
  if (brokerActorRoles.includes(expectedActor.role)) {
    if (value.broker === null) {
      fail(
        "CONTROLLER_ACTION_ATTESTATION_BROKER",
        "brokered controller action attestation requires broker acceptance evidence",
      );
    }
    validateActionAttestationBroker(value.broker, expectedActor);
  } else if (value.broker !== null) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_BROKER",
      "direct controller action attestation cannot carry broker acceptance evidence",
    );
  }
  validateActionAttestationObserverCommands(value.observerCommands);
  if (includeDigest) {
    requireSha256(value.attestationSha256, "controller action attestation.attestationSha256");
    if (
      verifyDigest &&
      value.attestationSha256 !== deriveActionAttestationDigestFromSnapshot(value)
    ) {
      fail(
        "CONTROLLER_ACTION_ATTESTATION_DIGEST",
        "controller action attestation digest is invalid",
      );
    }
  }
  return value;
}

export function deriveProbeControllerActionAttestationDigest(value) {
  const snapshot = cloneCanonicalData(value, "controller action attestation");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "attestationSha256");
  validateActionAttestationSnapshot(snapshot, includeDigest, false);
  return deriveActionAttestationDigestFromSnapshot(snapshot);
}

export function validateProbeControllerActionAttestation(value) {
  const snapshot = cloneCanonicalData(value, "controller action attestation");
  validateActionAttestationSnapshot(snapshot, true);
  return deepFreeze(snapshot);
}

export function createProbeControllerActionAttestation(input) {
  const snapshot = cloneCanonicalData(input, "controller action attestation creation input");
  assertExactKeys(
    snapshot,
    actionAttestationCreateInputKeys,
    "controller action attestation creation input",
  );
  const draft = {
    schemaVersion: PROBE_CONTROLLER_ACTION_ATTESTATION_SCHEMA_VERSION,
    kind: actionAttestationKind,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    ...snapshot,
  };
  validateActionAttestationSnapshot(draft, false);
  return validateProbeControllerActionAttestation({
    ...draft,
    attestationSha256: deriveActionAttestationDigestFromSnapshot(draft),
  });
}

function brokerAcceptanceDigestPayload(value) {
  return Object.fromEntries(brokerAcceptanceDraftKeys.map((key) => [key, value[key]]));
}

function deriveBrokerAcceptanceDigestFromSnapshot(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-broker-acceptance.v1",
    acceptance: brokerAcceptanceDigestPayload(value),
  });
}

function validateBrokerAcceptanceSnapshot(value, includeDigest, verifyDigest = true) {
  assertExactKeys(
    value,
    includeDigest ? brokerAcceptanceKeys : brokerAcceptanceDraftKeys,
    "controller broker acceptance",
  );
  if (
    value.schemaVersion !== PROBE_CONTROLLER_BROKER_ACCEPTANCE_SCHEMA_VERSION ||
    value.kind !== brokerAcceptanceKind ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail(
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_IDENTITY",
      "controller broker acceptance identity is invalid",
    );
  }
  validateCoordinate(value.coordinate);
  requireIdentifier(value.producerActionId, "controller broker acceptance.producerActionId");
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
    requireSha256(value[key], `controller broker acceptance.${key}`);
  }
  requireIdentifier(value.brokerInstanceId, "controller broker acceptance.brokerInstanceId");
  const expectedActor = validateExpectedActor(value.expectedActor);
  const sidBoundRole = new Set(["primary-standard-user", "second-user"]).has(expectedActor.role);
  if (
    !brokerActorRoles.includes(value.brokerRole) ||
    value.brokerRole !== expectedActor.role ||
    (sidBoundRole && value.processSidSha256 !== expectedActor.identitySha256)
  ) {
    fail(
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_ACTOR",
      "controller broker acceptance role or process identity differs from its expected actor",
    );
  }
  if (!new Set(["accepted", "idempotent-replay"]).has(value.replayJournalDisposition)) {
    fail(
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_REPLAY",
      "controller broker acceptance replay disposition is invalid",
    );
  }
  if (includeDigest) {
    requireSha256(value.acceptanceSha256, "controller broker acceptance.acceptanceSha256");
    if (
      verifyDigest &&
      value.acceptanceSha256 !== deriveBrokerAcceptanceDigestFromSnapshot(value)
    ) {
      fail(
        "CONTROLLER_ACTION_BROKER_ACCEPTANCE_DIGEST",
        "controller broker acceptance digest is invalid",
      );
    }
  }
  return value;
}

export function deriveProbeControllerBrokerAcceptanceDigest(value) {
  const snapshot = cloneCanonicalData(value, "controller broker acceptance");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "acceptanceSha256");
  validateBrokerAcceptanceSnapshot(snapshot, includeDigest, false);
  return deriveBrokerAcceptanceDigestFromSnapshot(snapshot);
}

export function validateProbeControllerBrokerAcceptance(value) {
  const snapshot = cloneCanonicalData(value, "controller broker acceptance");
  validateBrokerAcceptanceSnapshot(snapshot, true);
  return deepFreeze(snapshot);
}

export function createProbeControllerBrokerAcceptance(input) {
  const snapshot = cloneCanonicalData(input, "controller broker acceptance creation input");
  assertExactKeys(
    snapshot,
    brokerAcceptanceCreateInputKeys,
    "controller broker acceptance creation input",
  );
  const draft = {
    schemaVersion: PROBE_CONTROLLER_BROKER_ACCEPTANCE_SCHEMA_VERSION,
    kind: brokerAcceptanceKind,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    ...snapshot,
  };
  validateBrokerAcceptanceSnapshot(draft, false);
  return validateProbeControllerBrokerAcceptance({
    ...draft,
    acceptanceSha256: deriveBrokerAcceptanceDigestFromSnapshot(draft),
  });
}

export function probeControllerActionAttestationPath(input) {
  const snapshot = cloneCanonicalData(input, "controller action attestation path input");
  assertExactKeys(
    snapshot,
    ["coordinate", "producerActionId"],
    "controller action attestation path input",
  );
  validateCoordinate(snapshot.coordinate);
  requireIdentifier(
    snapshot.producerActionId,
    "controller action attestation path input.producerActionId",
  );
  return requireArtifactPath(
    [
      "segments",
      snapshot.coordinate.environmentId,
      snapshot.coordinate.pathProfileId,
      snapshot.coordinate.rowId.toLocaleLowerCase("en-US"),
      snapshot.coordinate.variantId,
      "evidence",
      "action-attestations",
      snapshot.coordinate.campaignRunId,
      snapshot.coordinate.executionRunId,
      snapshot.coordinate.attemptId,
      snapshot.coordinate.workId,
      snapshot.coordinate.repetition === null
        ? "ordinary"
        : `repetition-${String(snapshot.coordinate.repetition).padStart(4, "0")}`,
      `${snapshot.producerActionId}.json`,
    ].join("/"),
    "controller action attestation path",
  );
}

export function probeControllerBrokerAcceptancePath(input) {
  const snapshot = cloneCanonicalData(input, "controller broker acceptance path input");
  assertExactKeys(
    snapshot,
    ["coordinate", "producerActionId"],
    "controller broker acceptance path input",
  );
  validateCoordinate(snapshot.coordinate);
  requireIdentifier(
    snapshot.producerActionId,
    "controller broker acceptance path input.producerActionId",
  );
  return requireArtifactPath(
    [
      "segments",
      snapshot.coordinate.environmentId,
      snapshot.coordinate.pathProfileId,
      snapshot.coordinate.rowId.toLocaleLowerCase("en-US"),
      snapshot.coordinate.variantId,
      "evidence",
      "broker-acceptances",
      snapshot.coordinate.campaignRunId,
      snapshot.coordinate.executionRunId,
      snapshot.coordinate.attemptId,
      snapshot.coordinate.workId,
      snapshot.coordinate.repetition === null
        ? "ordinary"
        : `repetition-${String(snapshot.coordinate.repetition).padStart(4, "0")}`,
      `${snapshot.producerActionId}.json`,
    ].join("/"),
    "controller broker acceptance path",
  );
}

function expectedActionResultPath(receipt) {
  return [
    "runtime",
    "work",
    receipt.coordinate.campaignRunId,
    receipt.coordinate.attemptId,
    receipt.coordinate.workId,
    "action-results",
    `${receipt.producerActionId}.json`,
  ].join("/");
}

function validateCommandObservation(value, index) {
  const label = `controller action commandEvent.observations[${index}]`;
  assertExactKeys(value, ["factKey", "valueKind", "value"], label);
  if (
    typeof value.factKey !== "string" ||
    value.factKey.length > 128 ||
    !/^[A-Za-z][A-Za-z0-9]*$/u.test(value.factKey)
  ) {
    fail("CONTROLLER_ACTION_RESULT", `${label}.factKey is invalid`);
  }
  const scalarKinds = {
    null: null,
    boolean: "boolean",
    number: "number",
    string: "string",
  };
  if (Object.hasOwn(scalarKinds, value.valueKind)) {
    const expectedType = scalarKinds[value.valueKind];
    if (
      (expectedType === null && value.value !== null) ||
      (expectedType !== null && typeof value.value !== expectedType)
    ) {
      fail("CONTROLLER_ACTION_RESULT", `${label}.value differs from valueKind`);
    }
    return value;
  }
  const arrayKinds = {
    "boolean-array": "boolean",
    "number-array": "number",
    "string-array": "string",
  };
  const expectedType = arrayKinds[value.valueKind];
  if (
    expectedType === undefined ||
    !Array.isArray(value.value) ||
    value.value.length > maximumReferences ||
    value.value.some((entry) => typeof entry !== expectedType)
  ) {
    fail("CONTROLLER_ACTION_RESULT", `${label}.value differs from valueKind`);
  }
  return value;
}

function validateCommandEvent(value) {
  assertExactKeys(
    value,
    [
      "sequence",
      "producerKind",
      "commandId",
      "requestSha256",
      "responseSha256",
      "nativeTranscriptSha256s",
      "observations",
    ],
    "controller action commandEvent",
  );
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    fail("CONTROLLER_ACTION_RESULT", "controller action commandEvent.sequence is invalid");
  }
  if (value.producerKind !== "external-controller") {
    fail("CONTROLLER_ACTION_RESULT", "controller action commandEvent producer is invalid");
  }
  requireIdentifier(value.commandId, "controller action commandEvent.commandId");
  requireSha256(value.requestSha256, "controller action commandEvent.requestSha256");
  requireSha256(value.responseSha256, "controller action commandEvent.responseSha256");
  if (
    !Array.isArray(value.nativeTranscriptSha256s) ||
    value.nativeTranscriptSha256s.length === 0 ||
    value.nativeTranscriptSha256s.length > maximumReferences
  ) {
    fail(
      "CONTROLLER_ACTION_RESULT",
      "controller action commandEvent native transcripts are invalid",
    );
  }
  let previousDigest = null;
  for (const [index, digest] of value.nativeTranscriptSha256s.entries()) {
    requireSha256(digest, `controller action commandEvent.nativeTranscriptSha256s[${index}]`);
    if (previousDigest !== null && compareUtf8(previousDigest, digest) >= 0) {
      fail(
        "CONTROLLER_ACTION_RESULT",
        "controller action commandEvent native transcripts are not sorted and unique",
      );
    }
    previousDigest = digest;
  }
  if (
    !Array.isArray(value.observations) ||
    value.observations.length === 0 ||
    value.observations.length > maximumReferences
  ) {
    fail("CONTROLLER_ACTION_RESULT", "controller action commandEvent observations are invalid");
  }
  const factKeys = new Set();
  for (const [index, observation] of value.observations.entries()) {
    validateCommandObservation(observation, index);
    if (factKeys.has(observation.factKey)) {
      fail("CONTROLLER_ACTION_RESULT", "controller action commandEvent repeats a fact");
    }
    factKeys.add(observation.factKey);
  }
  return value;
}

function validateActionResult(value, producerActionId) {
  assertExactKeys(
    value,
    ["actionId", "commandEvent", "evidenceArtifacts"],
    "controller action actionResult",
  );
  if (value.actionId !== producerActionId) {
    fail("CONTROLLER_ACTION_RESULT", "actionResult.actionId differs from producerActionId");
  }
  if (value.commandEvent !== null) validateCommandEvent(value.commandEvent);
  validateReferenceArray(value.evidenceArtifacts, "actionResult.evidenceArtifacts", {
    nonEmpty: true,
  });
  return value;
}

function validateNativePlanPaths(receipt) {
  const prefix =
    [
      "runtime",
      "work",
      receipt.coordinate.campaignRunId,
      receipt.coordinate.attemptId,
      receipt.coordinate.workId,
      "driver-plans",
    ].join("/") + "/";
  for (const reference of receipt.nativeActionPlans) {
    if (!reference.path.startsWith(prefix) || !reference.path.endsWith(".json")) {
      fail("CONTROLLER_ACTION_PLAN", "native action plan path is not in the bound work namespace");
    }
    const consumerActionId = reference.path.slice(prefix.length, -".json".length);
    requireIdentifier(consumerActionId, "native action plan consumerActionId");
  }
}

function validateSegmentEvidencePaths(receipt) {
  const prefix =
    [
      "segments",
      receipt.coordinate.environmentId,
      receipt.coordinate.pathProfileId,
      receipt.coordinate.rowId.toLocaleLowerCase("en-US"),
      receipt.coordinate.variantId,
      "evidence",
    ].join("/") + "/";
  if (receipt.proofArtifacts.some((reference) => !reference.path.startsWith(prefix))) {
    fail("CONTROLLER_ACTION_PROOF", "proof artifact escapes the bound segment evidence namespace");
  }
  const transcriptPrefix = `${prefix}native-transcripts/`;
  for (const reference of receipt.observerTranscripts) {
    if (reference.path !== `${transcriptPrefix}${reference.transcriptSha256}.json`) {
      fail(
        "CONTROLLER_ACTION_OBSERVER",
        "observer transcript is not digest-addressed in the bound segment namespace",
      );
    }
  }
}

function buildSignedArtifactUnion(receipt) {
  const categories = [
    [receipt.actionResultArtifact],
    receipt.proofArtifacts,
    receipt.observerTranscripts,
    receipt.nativeActionPlans,
  ];
  const result = [];
  const foldedPaths = new Set();
  const digests = new Set();
  for (const references of categories) {
    for (const reference of references) {
      const foldedPath = reference.path.toLocaleLowerCase("en-US");
      if (foldedPaths.has(foldedPath) || digests.has(reference.sha256)) {
        fail("CONTROLLER_ACTION_ARTIFACT", "signed artifact union contains a collision");
      }
      foldedPaths.add(foldedPath);
      digests.add(reference.sha256);
      result.push({ path: reference.path, sha256: reference.sha256 });
      if (result.length > maximumReferences) {
        fail("CONTROLLER_ACTION_ARTIFACT", "signed artifact union exceeds its bound");
      }
    }
  }
  result.sort((left, right) => compareUtf8(left.path, right.path));
  return deepFreeze(result);
}

function validateReceiptSnapshot(value, includeDigest, verifyDigest = true) {
  assertExactKeys(
    value,
    includeDigest ? receiptKeys : receiptDraftKeys,
    "controller action receipt",
  );
  if (
    value.schemaVersion !== PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION ||
    value.kind !== receiptKind ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail("CONTROLLER_ACTION_IDENTITY", "controller action receipt identity is invalid");
  }
  for (const key of [
    "candidateSha256",
    "executionBundleManifestSha256",
    "runAuthorizationClaimReceiptSha256",
    "scenarioPlanSha256",
    "intentSha256",
  ]) {
    requireSha256(value[key], `controller action receipt.${key}`);
  }
  requireIdentifier(value.executionBundleId, "controller action receipt.executionBundleId");
  requireIdentifier(value.producerActionId, "controller action receipt.producerActionId");
  validateCoordinate(value.coordinate);
  validateOperation(value.operation);
  const expectedActor = validateExpectedActor(value.expectedActor);
  validateExecution(value.execution, expectedActor);
  validateActionResult(value.actionResult, value.producerActionId);
  validateArtifactReference(value.actionResultArtifact, "actionResultArtifact");
  if (
    value.actionResultArtifact.path !== expectedActionResultPath(value) ||
    value.actionResultArtifact.sha256 !== rawCanonicalSha256(value.actionResult)
  ) {
    fail("CONTROLLER_ACTION_RESULT", "actionResultArtifact differs from the canonical result");
  }
  validateReferenceArray(value.proofArtifacts, "proofArtifacts", { nonEmpty: true });
  if (!canonicalEqual(value.proofArtifacts, value.actionResult.evidenceArtifacts)) {
    fail("CONTROLLER_ACTION_PROOF", "proofArtifacts differ from actionResult evidence");
  }
  validateObserverArray(value.observerTranscripts);
  validateReferenceArray(value.nativeActionPlans, "nativeActionPlans");
  validateSegmentEvidencePaths(value);
  validateOptionalProofReference(value.brokerProof, value.proofArtifacts, "brokerProof");
  validateOptionalProofReference(
    value.pausedSessionReceipt,
    value.proofArtifacts,
    "pausedSessionReceipt",
  );
  if (brokerActorRoles.includes(expectedActor.role)) {
    if (value.brokerProof === null || value.observerTranscripts.length === 0) {
      fail(
        "CONTROLLER_ACTION_BROKER",
        "external actor requires broker proof and observer transcript",
      );
    }
  } else if (value.brokerProof !== null) {
    fail("CONTROLLER_ACTION_BROKER", "non-broker actor must not claim broker proof");
  }
  if (value.execution.nativeTranscriptRequired && value.observerTranscripts.length === 0) {
    fail(
      "CONTROLLER_ACTION_OBSERVER",
      "native-transcript-required action omitted its observer transcript",
    );
  }
  if (value.actionResult.commandEvent !== null) {
    const observerTranscriptSha256s = value.observerTranscripts
      .map((reference) => reference.transcriptSha256)
      .sort(compareUtf8);
    if (
      !canonicalEqual(
        value.actionResult.commandEvent.nativeTranscriptSha256s,
        observerTranscriptSha256s,
      )
    ) {
      fail(
        "CONTROLLER_ACTION_OBSERVER",
        "commandEvent native transcript identities differ from observerTranscripts",
      );
    }
  }
  validateNativePlanPaths(value);
  buildSignedArtifactUnion(value);
  if (includeDigest) {
    requireSha256(value.receiptSha256, "controller action receipt.receiptSha256");
    if (verifyDigest && value.receiptSha256 !== deriveReceiptDigestFromSnapshot(value)) {
      fail("CONTROLLER_ACTION_DIGEST", "controller action receipt digest is invalid");
    }
  }
  return value;
}

function receiptDigestPayload(value) {
  return Object.fromEntries(receiptDraftKeys.map((key) => [key, value[key]]));
}

function deriveReceiptDigestFromSnapshot(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-action-execution-receipt.v1",
    receipt: receiptDigestPayload(value),
  });
}

export function deriveProbeControllerActionExecutionReceiptDigest(value) {
  const snapshot = cloneCanonicalData(value, "controller action receipt");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "receiptSha256");
  validateReceiptSnapshot(snapshot, includeDigest, false);
  return deriveReceiptDigestFromSnapshot(snapshot);
}

function validateReceiptStructure(value) {
  const snapshot = cloneCanonicalData(value, "controller action receipt");
  validateReceiptSnapshot(snapshot, true);
  return deepFreeze(snapshot);
}

export function validateProbeControllerActionExecutionReceiptStructure(value) {
  return validateReceiptStructure(value);
}

function parseCanonicalArtifact(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("CONTROLLER_ACTION_EVIDENCE", `${label} is not UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("CONTROLLER_ACTION_EVIDENCE", `${label} is not JSON`);
  }
  let canonical;
  try {
    canonical = canonicalProbeJson(value);
  } catch {
    fail("CONTROLLER_ACTION_EVIDENCE", `${label} is not canonical JSON data`);
  }
  if (canonical !== text) {
    fail("CONTROLLER_ACTION_EVIDENCE", `${label} bytes are not canonical probe JSON`);
  }
  return value;
}

function validateActionEvidenceArtifacts(value) {
  if (!Array.isArray(value) || value.length > maximumReferences) {
    fail("CONTROLLER_ACTION_EVIDENCE", "controller action artifacts must be a bounded array");
  }
  const byPath = new Map();
  const foldedPaths = new Set();
  const digests = new Set();
  for (const [index, artifact] of value.entries()) {
    const label = `controller action artifacts[${index}]`;
    assertExactKeys(artifact, ["path", "bytes"], label);
    requireArtifactPath(artifact.path, `${label}.path`);
    if (!(artifact.bytes instanceof Uint8Array)) {
      fail("CONTROLLER_ACTION_EVIDENCE", `${label}.bytes must be a Uint8Array`);
    }
    const retained = Buffer.from(artifact.bytes);
    const digest = createHash("sha256").update(retained).digest("hex");
    const foldedPath = artifact.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(foldedPath) || digests.has(digest)) {
      fail(
        "CONTROLLER_ACTION_EVIDENCE",
        "controller action artifacts contain a path or digest collision",
      );
    }
    foldedPaths.add(foldedPath);
    digests.add(digest);
    byPath.set(artifact.path, Object.freeze({ bytes: retained, sha256: digest }));
  }
  return byPath;
}

function requireEvidenceArtifact(reference, artifactsByPath, label) {
  const artifact = artifactsByPath.get(reference.path);
  if (artifact === undefined || artifact.sha256 !== reference.sha256) {
    fail("CONTROLLER_ACTION_EVIDENCE", `${label} has no exact retained artifact bytes`);
  }
  return artifact.bytes;
}

function collectObserverCommandEvidence(receipt, artifactsByPath) {
  const commands = [];
  for (const [index, reference] of receipt.observerTranscripts.entries()) {
    const bytes = requireEvidenceArtifact(
      reference,
      artifactsByPath,
      `controller action observerTranscripts[${index}]`,
    );
    let transcript;
    try {
      transcript = validateNativeCommandTranscript(
        parseCanonicalArtifact(bytes, `controller action observerTranscripts[${index}]`),
      );
    } catch (error) {
      if (error instanceof ProbeControllerActionProvenanceError) throw error;
      fail(
        "CONTROLLER_ACTION_EVIDENCE",
        `controller action observerTranscripts[${index}] is not a valid native transcript`,
      );
    }
    if (transcript.transcriptSha256 !== reference.transcriptSha256) {
      fail(
        "CONTROLLER_ACTION_EVIDENCE",
        `controller action observerTranscripts[${index}] identity differs from its receipt`,
      );
    }
    for (const record of transcript.records) {
      if (record.kind !== "command") continue;
      commands.push({
        transcriptSha256: transcript.transcriptSha256,
        sequence: record.sequence,
        commandId: record.command,
        requestFrameSha256: record.requestFrameSha256,
        responseFrameSha256: record.responseFrameSha256,
        ok: record.ok,
      });
    }
  }
  commands.sort((left, right) => {
    const transcriptOrder = compareUtf8(left.transcriptSha256, right.transcriptSha256);
    return transcriptOrder === 0 ? left.sequence - right.sequence : transcriptOrder;
  });
  if (commands.length === 0) {
    if (receipt.observerTranscripts.length !== 0) {
      fail(
        "CONTROLLER_ACTION_COMMAND_BINDING",
        "controller action observer evidence contains no retained command records",
      );
    }
    return deepFreeze(commands);
  }
  validateActionAttestationObserverCommands(commands);
  const event = receipt.actionResult.commandEvent;
  if (event !== null) {
    for (const transcriptSha256 of event.nativeTranscriptSha256s) {
      const matches = commands.filter(
        (command) =>
          command.transcriptSha256 === transcriptSha256 &&
          command.commandId === event.commandId &&
          command.requestFrameSha256 === event.requestSha256 &&
          command.responseFrameSha256 === event.responseSha256,
      );
      if (matches.length !== 1) {
        fail(
          "CONTROLLER_ACTION_COMMAND_BINDING",
          "external-controller command event does not match its retained observer command frames",
        );
      }
    }
  }
  return deepFreeze(commands);
}

function validateAttestationReceiptBinding(attestation, receipt) {
  const expected = {
    campaignId: receipt.campaignId,
    manifestSha256: receipt.manifestSha256,
    runPlanSha256: receipt.runPlanSha256,
    candidateSha256: receipt.candidateSha256,
    executionBundleId: receipt.executionBundleId,
    executionBundleManifestSha256: receipt.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: receipt.runAuthorizationClaimReceiptSha256,
    coordinate: receipt.coordinate,
    scenarioPlanSha256: receipt.scenarioPlanSha256,
    producerActionId: receipt.producerActionId,
    operation: receipt.operation,
    runtimeActionIntentSha256: receipt.intentSha256,
    execution: receipt.execution,
    expectedActor: receipt.expectedActor,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!canonicalEqual(attestation[key], expectedValue)) {
      fail(
        "CONTROLLER_ACTION_ATTESTATION_BINDING",
        `controller action attestation ${key} differs from its execution receipt`,
      );
    }
  }
}

function validateReceiptActionAttestation(receipt, artifactsByPath, observerCommands, required) {
  const attestationPath = probeControllerActionAttestationPath({
    coordinate: receipt.coordinate,
    producerActionId: receipt.producerActionId,
  });
  const attestationReference = receipt.proofArtifacts.find(
    (reference) => reference.path === attestationPath,
  );
  if (attestationReference === undefined) {
    if (required) {
      fail(
        "CONTROLLER_ACTION_ATTESTATION_REQUIRED",
        "controller action omitted its deterministic action attestation",
      );
    }
    return null;
  }
  const attestationBytes = requireEvidenceArtifact(
    attestationReference,
    artifactsByPath,
    "controller action attestation",
  );
  const attestation = validateProbeControllerActionAttestation(
    parseCanonicalArtifact(attestationBytes, "controller action attestation"),
  );
  validateAttestationReceiptBinding(attestation, receipt);
  if (!canonicalEqual(attestation.observerCommands, observerCommands)) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_OBSERVER",
      "controller action attestation differs from its observer commands",
    );
  }
  return attestation;
}

function validateBrokerAttestation(receipt, artifactsByPath, attestation) {
  const brokerResultBytes = requireEvidenceArtifact(
    receipt.brokerProof,
    artifactsByPath,
    "controller action brokerProof",
  );
  let brokerResult;
  try {
    brokerResult = validateProbeBrokerResult(
      parseCanonicalArtifact(brokerResultBytes, "controller action brokerProof"),
    );
  } catch (error) {
    if (error instanceof ProbeControllerActionProvenanceError) throw error;
    fail("CONTROLLER_ACTION_ATTESTATION_BROKER", "brokerProof is not a valid broker result");
  }
  const acceptancePath = probeControllerBrokerAcceptancePath({
    coordinate: receipt.coordinate,
    producerActionId: receipt.producerActionId,
  });
  const acceptanceReference = receipt.proofArtifacts.find(
    (reference) => reference.path === acceptancePath,
  );
  if (acceptanceReference === undefined) {
    fail(
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_REQUIRED",
      "brokered controller action omitted its deterministic broker acceptance",
    );
  }
  const acceptanceBytes = requireEvidenceArtifact(
    acceptanceReference,
    artifactsByPath,
    "controller broker acceptance",
  );
  const brokerAcceptance = validateProbeControllerBrokerAcceptance(
    parseCanonicalArtifact(acceptanceBytes, "controller broker acceptance"),
  );
  const expectedBroker = {
    brokerAcceptanceSha256: brokerAcceptance.acceptanceSha256,
    brokerTaskSha256: brokerResult.taskSha256,
    brokerTaskNonceSha256: brokerAcceptance.brokerTaskNonceSha256,
    brokerResultSha256: brokerResult.resultSha256,
    brokerEnrollmentSha256: brokerResult.brokerEnrollmentSha256,
    brokerInstanceId: brokerResult.brokerInstanceId,
    brokerRole: brokerResult.brokerRole,
    mailboxAclSha256: brokerAcceptance.mailboxAclSha256,
    processSidSha256: brokerAcceptance.processSidSha256,
    bootIdSha256: brokerResult.bootIdSha256,
    runnerSessionIdSha256: brokerResult.runnerSessionIdSha256,
    replayJournalDisposition: brokerAcceptance.replayJournalDisposition,
    replayJournalEntrySha256: brokerAcceptance.replayJournalEntrySha256,
  };
  if (
    brokerResult.outcome !== "SUCCEEDED" ||
    brokerResult.driverResult.driverId !== receipt.execution.driverId ||
    !canonicalEqual(brokerResult.actor, receipt.expectedActor) ||
    brokerAcceptance.coordinate.campaignRunId !== receipt.coordinate.campaignRunId ||
    !canonicalEqual(brokerAcceptance.coordinate, receipt.coordinate) ||
    brokerAcceptance.producerActionId !== receipt.producerActionId ||
    brokerAcceptance.brokerTaskSha256 !== brokerResult.taskSha256 ||
    brokerAcceptance.brokerResultSha256 !== brokerResult.resultSha256 ||
    brokerAcceptance.brokerEnrollmentSha256 !== brokerResult.brokerEnrollmentSha256 ||
    brokerAcceptance.brokerInstanceId !== brokerResult.brokerInstanceId ||
    brokerAcceptance.brokerRole !== brokerResult.brokerRole ||
    brokerAcceptance.bootIdSha256 !== brokerResult.bootIdSha256 ||
    brokerAcceptance.runnerSessionIdSha256 !== brokerResult.runnerSessionIdSha256 ||
    !canonicalEqual(brokerAcceptance.expectedActor, receipt.expectedActor) ||
    !canonicalEqual(attestation.broker, expectedBroker)
  ) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_BINDING",
      "controller action attestation differs from its broker result or observer commands",
    );
  }
  const brokerObservers = brokerResult.observerTranscripts
    .map(({ sha256: digest, transcriptSha256 }) => ({ sha256: digest, transcriptSha256 }))
    .sort((left, right) => compareUtf8(left.transcriptSha256, right.transcriptSha256));
  const receiptObservers = receipt.observerTranscripts
    .map(({ sha256: digest, transcriptSha256 }) => ({ sha256: digest, transcriptSha256 }))
    .sort((left, right) => compareUtf8(left.transcriptSha256, right.transcriptSha256));
  if (!canonicalEqual(brokerObservers, receiptObservers)) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_OBSERVER",
      "broker result observer identities differ from the action receipt",
    );
  }
  return Object.freeze({ attestation, brokerAcceptance, brokerResult });
}

export function validateProbeControllerActionExecutionEvidence(input) {
  assertExactKeys(input, ["receipt", "artifacts"], "controller action execution evidence");
  const receipt = validateReceiptStructure(input.receipt);
  const artifactsByPath = validateActionEvidenceArtifacts(input.artifacts);
  const observerCommands = collectObserverCommandEvidence(receipt, artifactsByPath);
  const brokeredAction = brokerActorRoles.includes(receipt.expectedActor.role);
  const actionAttestation = validateReceiptActionAttestation(
    receipt,
    artifactsByPath,
    observerCommands,
    brokeredAction || receipt.actionResult.commandEvent !== null,
  );
  let brokerAcceptance = null;
  let brokerResult = null;
  if (brokeredAction) {
    const brokered = validateBrokerAttestation(receipt, artifactsByPath, actionAttestation);
    brokerAcceptance = brokered.brokerAcceptance;
    brokerResult = brokered.brokerResult;
  }
  return deepFreeze({
    receipt,
    actionAttestation,
    brokerAcceptance,
    brokerResult,
    observerCommands,
  });
}

export function validateProbeControllerActionExecutionReceipt(value, artifacts) {
  const receipt = validateReceiptStructure(value);
  if (artifacts !== undefined) {
    return validateProbeControllerActionExecutionEvidence({ receipt, artifacts }).receipt;
  }
  if (
    brokerActorRoles.includes(receipt.expectedActor.role) ||
    receipt.actionResult.commandEvent !== null
  ) {
    fail(
      "CONTROLLER_ACTION_ATTESTATION_REQUIRED",
      "controller action receipt requires its retained attestation evidence",
    );
  }
  return receipt;
}

export function createProbeControllerActionExecutionReceipt(input, artifacts) {
  const snapshot = cloneCanonicalData(input, "controller action receipt creation input");
  assertExactKeys(snapshot, receiptCreateInputKeys, "controller action receipt creation input");
  const draft = {
    schemaVersion: PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION,
    kind: receiptKind,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    ...snapshot,
  };
  validateReceiptSnapshot(draft, false);
  const receipt = {
    ...draft,
    receiptSha256: deriveReceiptDigestFromSnapshot(draft),
  };
  return artifacts === undefined
    ? validateReceiptStructure(receipt)
    : validateProbeControllerActionExecutionReceipt(receipt, artifacts);
}

export function collectProbeControllerActionSignedArtifacts(value) {
  const receipt = validateReceiptStructure(value);
  return buildSignedArtifactUnion(receipt);
}

export function probeControllerActionProvenancePaths(input) {
  const snapshot = cloneCanonicalData(input, "controller action provenance path input");
  assertExactKeys(
    snapshot,
    ["campaignRunId", "attemptId", "workId", "producerActionId"],
    "controller action provenance path input",
  );
  for (const key of ["campaignRunId", "attemptId", "workId", "producerActionId"]) {
    requireIdentifier(snapshot[key], `controller action provenance path input.${key}`);
  }
  const stem = [
    "runtime",
    "work",
    snapshot.campaignRunId,
    snapshot.attemptId,
    snapshot.workId,
    "action-provenance",
    snapshot.producerActionId,
  ].join("/");
  const paths = {
    stem,
    provenance: `${stem}.json`,
    receipt: `${stem}.receipt.json`,
    controllerRequest: `${stem}.controller-request.json`,
    operationRequest: `${stem}.operation-request.json`,
    controllerResponse: `${stem}.controller-response.json`,
    operationResponse: `${stem}.operation-response.json`,
  };
  for (const [key, path] of Object.entries(paths)) {
    requireArtifactPath(path, `controller action provenance path.${key}`);
  }
  return deepFreeze(paths);
}

function validateRecordInput(value, label) {
  assertExactKeys(value, ["bytes", "sha256"], label);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("CONTROLLER_ACTION_RECORD", `${label}.bytes is invalid`);
  }
  requireSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateProvenanceRecord(value, label) {
  assertExactKeys(value, ["path", "bytes", "sha256"], label);
  requireArtifactPath(value.path, `${label}.path`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("CONTROLLER_ACTION_RECORD", `${label}.bytes is invalid`);
  }
  requireSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateRecordSet(records, expectedPaths) {
  assertExactKeys(records, provenanceRecordKeys, "controller action provenance records");
  const foldedPaths = new Set();
  const digests = new Set();
  for (const key of provenanceRecordKeys) {
    const reference = validateProvenanceRecord(records[key], `provenance records.${key}`);
    if (reference.path !== expectedPaths[key === "executionReceipt" ? "receipt" : key]) {
      fail("CONTROLLER_ACTION_RECORD", `provenance records.${key} path is not deterministic`);
    }
    const foldedPath = reference.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(foldedPath) || digests.has(reference.sha256)) {
      fail("CONTROLLER_ACTION_RECORD", "controller action provenance records collide");
    }
    foldedPaths.add(foldedPath);
    digests.add(reference.sha256);
  }
  return records;
}

function receiptBinding(receipt) {
  return {
    campaignId: receipt.campaignId,
    manifestSha256: receipt.manifestSha256,
    runPlanSha256: receipt.runPlanSha256,
    candidateSha256: receipt.candidateSha256,
    executionBundleId: receipt.executionBundleId,
    executionBundleManifestSha256: receipt.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: receipt.runAuthorizationClaimReceiptSha256,
    coordinate: receipt.coordinate,
    scenarioPlanSha256: receipt.scenarioPlanSha256,
    producerActionId: receipt.producerActionId,
    operation: receipt.operation,
    intentSha256: receipt.intentSha256,
    receiptSha256: receipt.receiptSha256,
  };
}

function provenanceDigestPayload(value) {
  return Object.fromEntries(provenanceDraftKeys.map((key) => [key, value[key]]));
}

function deriveProvenanceDigestFromSnapshot(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-action-provenance.v1",
    provenance: provenanceDigestPayload(value),
  });
}

function validateProvenanceSnapshot(value, includeDigest, verifyDigest = true) {
  assertExactKeys(
    value,
    includeDigest ? provenanceKeys : provenanceDraftKeys,
    "controller action provenance",
  );
  if (
    value.schemaVersion !== PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION ||
    value.kind !== provenanceKind ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail("CONTROLLER_ACTION_IDENTITY", "controller action provenance identity is invalid");
  }
  for (const key of [
    "candidateSha256",
    "executionBundleManifestSha256",
    "runAuthorizationClaimReceiptSha256",
    "scenarioPlanSha256",
    "intentSha256",
    "receiptSha256",
  ]) {
    requireSha256(value[key], `controller action provenance.${key}`);
  }
  requireIdentifier(value.executionBundleId, "controller action provenance.executionBundleId");
  requireIdentifier(value.producerActionId, "controller action provenance.producerActionId");
  validateCoordinate(value.coordinate);
  validateOperation(value.operation);
  const paths = probeControllerActionProvenancePaths({
    campaignRunId: value.coordinate.campaignRunId,
    attemptId: value.coordinate.attemptId,
    workId: value.coordinate.workId,
    producerActionId: value.producerActionId,
  });
  validateRecordSet(value.records, paths);
  if (includeDigest) {
    requireSha256(value.provenanceSha256, "controller action provenance.provenanceSha256");
    if (verifyDigest && value.provenanceSha256 !== deriveProvenanceDigestFromSnapshot(value)) {
      fail("CONTROLLER_ACTION_DIGEST", "controller action provenance digest is invalid");
    }
  }
  return value;
}

export function deriveProbeControllerActionProvenanceDigest(value) {
  const snapshot = cloneCanonicalData(value, "controller action provenance");
  const includeDigest = exactObject(snapshot) && Object.hasOwn(snapshot, "provenanceSha256");
  validateProvenanceSnapshot(snapshot, includeDigest, false);
  return deriveProvenanceDigestFromSnapshot(snapshot);
}

function snapshotTrustedProvenanceInput(input) {
  const hasArtifacts = exactObject(input) && Object.hasOwn(input, "artifacts");
  assertExactKeys(
    input,
    hasArtifacts ? ["receipt", "records", "artifacts"] : ["receipt", "records"],
    "trusted controller action provenance input",
  );
  const snapshot = cloneCanonicalData(
    { receipt: input.receipt, records: input.records },
    "trusted controller action provenance input",
  );
  assertExactKeys(
    snapshot.records,
    provenanceInputRecordKeys,
    "trusted controller action provenance records",
  );
  for (const key of provenanceInputRecordKeys) {
    validateRecordInput(snapshot.records[key], `trusted provenance records.${key}`);
  }
  if (hasArtifacts) validateActionEvidenceArtifacts(input.artifacts);
  const artifacts = hasArtifacts
    ? input.artifacts.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }))
    : undefined;
  return Object.freeze(artifacts === undefined ? snapshot : { ...snapshot, artifacts });
}

function expectedProvenanceRecords(receipt, records) {
  const paths = probeControllerActionProvenancePaths({
    campaignRunId: receipt.coordinate.campaignRunId,
    attemptId: receipt.coordinate.attemptId,
    workId: receipt.coordinate.workId,
    producerActionId: receipt.producerActionId,
  });
  return {
    executionReceipt: {
      path: paths.receipt,
      bytes: rawCanonicalBytes(receipt),
      sha256: rawCanonicalSha256(receipt),
    },
    controllerRequest: { path: paths.controllerRequest, ...records.controllerRequest },
    operationRequest: { path: paths.operationRequest, ...records.operationRequest },
    controllerResponse: { path: paths.controllerResponse, ...records.controllerResponse },
    operationResponse: { path: paths.operationResponse, ...records.operationResponse },
  };
}

export function createProbeControllerActionProvenance(input) {
  const trusted = snapshotTrustedProvenanceInput(input);
  const receipt = validateProbeControllerActionExecutionReceipt(trusted.receipt, trusted.artifacts);
  const draft = {
    schemaVersion: PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION,
    kind: provenanceKind,
    ...receiptBinding(receipt),
    records: expectedProvenanceRecords(receipt, trusted.records),
  };
  validateProvenanceSnapshot(draft, false);
  return validateProbeControllerActionProvenance(
    { ...draft, provenanceSha256: deriveProvenanceDigestFromSnapshot(draft) },
    trusted,
  );
}

export function validateProbeControllerActionProvenance(value, trustedInput) {
  const trusted = snapshotTrustedProvenanceInput(trustedInput);
  const receipt = validateProbeControllerActionExecutionReceipt(trusted.receipt, trusted.artifacts);
  const snapshot = cloneCanonicalData(value, "controller action provenance");
  validateProvenanceSnapshot(snapshot, true);
  const expectedBinding = receiptBinding(receipt);
  for (const [key, expected] of Object.entries(expectedBinding)) {
    if (!canonicalEqual(snapshot[key], expected)) {
      fail("CONTROLLER_ACTION_BINDING", `controller action provenance ${key} differs from receipt`);
    }
  }
  const expectedRecords = expectedProvenanceRecords(receipt, trusted.records);
  if (!canonicalEqual(snapshot.records, expectedRecords)) {
    fail(
      "CONTROLLER_ACTION_BINDING",
      "controller action provenance records differ from trusted bytes",
    );
  }
  return deepFreeze(snapshot);
}
