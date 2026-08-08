import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";
import { win32 } from "node:path";

import {
  decodeControllerOperationRequest,
  decodeControllerOperationResponse,
  encodeControllerOperationRequest,
} from "./controller/operation-codec.mjs";
import {
  CONTROLLER_PROTOCOL_SCHEMA_VERSION,
  CONTROLLER_REQUEST_KIND,
  deriveControllerRequestDigest,
  validateControllerRequest,
  verifyControllerResponse,
} from "./controller/protocol.mjs";
import { createControllerSpoolClient } from "./controller/spool.mjs";
import { openEvidenceStore, validateEvidenceRelativePath } from "./evidence-store.mjs";
import { getProbeActionMapping } from "./probe-action-map.mjs";
import {
  collectProbeControllerActionSignedArtifacts,
  createProbeControllerActionProvenance,
  probeControllerActionProvenancePaths,
  validateProbeControllerActionExecutionEvidence,
  validateProbeControllerActionExecutionReceipt,
  validateProbeControllerActionExecutionReceiptStructure,
  validateProbeControllerActionProvenance,
} from "./probe-controller-action-provenance.mjs";
import { createProbeControllerPreparedAuthority } from "./probe-controller-prepared-authority.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  createExternalCheckpointReplayRegistry,
  hashProbeCanonicalJson,
  validateExternalCheckpointEvidence,
} from "./probe-contract.mjs";
import { validateProbeRunAuthorizationClaimReceipt } from "./probe-run-authorization.mjs";
import {
  probeNativeActionPlanPath,
  validateProbeNativeActionPlan,
} from "./probe-native-action-plan.mjs";
import { validateNativeCommandTranscript } from "./native-client.mjs";
import { validatePreparedProbeContext } from "./probe-preflight.mjs";
import { PROBE_RUN_PLAN, PROBE_RUN_PLAN_SHA256 } from "./probe-runner.mjs";
import {
  createProbeRuntimeActionBindingFromPreparedAuthority,
  createProbeRuntimeActionBinding,
} from "./probe-runtime-action-intent.mjs";
import { getProbeScenarioDefinition } from "./probe-scenarios.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const controllerActionCommitKind = "windows-host-probe-controller-action-commit";
const controllerActionCommitKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "coordinate",
  "producerActionId",
  "receiptSha256",
  "provenanceSha256",
  "artifacts",
  "commitSha256",
]);
const controllerActionCommitDraftKeys = Object.freeze(
  controllerActionCommitKeys.filter((key) => key !== "commitSha256"),
);
export const PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE = "CONTROLLER_TRANSPORT_ACTION_INCOMPLETE";
const hardCutCheckpointRequestKeys = Object.freeze([
  "schemaVersion",
  "kind",
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
  "checkpointId",
  "sequence",
  "nonceSha256",
  "preCutStateSha256",
  "preCutBootIdSha256",
  "sourceVmSnapshotId",
  "continuationScopeSha256",
  "controllerIdentitySha256",
  "controllerPublicKeySha256",
  "controllerVersion",
  "action",
  "signatureAlgorithm",
  "signatureBase64",
  "requestSha256",
]);
const hardCutCheckpointReceiptKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "requestSha256",
  "controllerIdentitySha256",
  "controllerPublicKeySha256",
  "controllerVersion",
  "action",
  "powerCutAt",
  "bootStartedAt",
  "bootCompletedAt",
  "postBootVmSnapshotId",
  "preCutBootIdSha256",
  "postBootBootIdSha256",
  "artifactHashes",
  "signatureAlgorithm",
  "signatureBase64",
  "receiptSha256",
]);
const operationKindsByMethod = Object.freeze({
  verifyRunAuthorization: "run-authorization-claim",
  observeController: "controller-observation",
  recoverOrAcquireEvidenceQuiescence: "evidence-quiescence-acquire",
  renewEvidenceQuiescence: "evidence-quiescence-renew",
  captureQuiescedEvidenceSeal: "evidence-quiescence-capture",
  completeEvidenceQuiescence: "evidence-quiescence-complete",
  abandonEvidenceQuiescence: "evidence-quiescence-abandon",
  invokeScenarioAction: "scenario-action",
  observeCaptureDisposition: "capture-disposition-observation",
  signSourceTranscriptReceipt: "source-transcript-sign",
  claimHardCutRequest: "hard-cut-request-claim",
  readHardCutReceipt: "hard-cut-receipt-read",
});

export class ProbeControllerSpoolTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeControllerSpoolTransportError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeControllerSpoolTransportError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = [], label = "value") {
  if (!exactObject(value)) fail("CONTROLLER_TRANSPORT_SCHEMA", `${label} must be an object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !permitted.has(key)) {
      fail("CONTROLLER_TRANSPORT_SCHEMA", `${label} has an unexpected key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("CONTROLLER_TRANSPORT_SCHEMA", `${label}.${key} must be an enumerable data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("CONTROLLER_TRANSPORT_SCHEMA", `${label} is missing key: ${key}`);
    }
  }
}

function assertExactDataKeys(value, keys, label) {
  if (!exactObject(value)) fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} has an invalid field set`);
  }
  const sortedActual = actual.sort(compareUtf8);
  const sortedExpected = [...keys].sort(compareUtf8);
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} has an invalid field set`);
  }
  for (const key of sortedActual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} fields must be enumerable data`);
    }
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_TRANSPORT_AUTHORITY", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function controllerAuthority(loadedBootstrap) {
  if (!exactObject(loadedBootstrap)) {
    fail("CONTROLLER_TRANSPORT_BOOTSTRAP", "loadedBootstrap must be an object");
  }
  const bootstrap = loadedBootstrap.bootstrap;
  const candidate = loadedBootstrap.candidate;
  const authorization = loadedBootstrap.runAuthorization;
  const spool = bootstrap?.controllerSpool;
  if (
    !exactObject(bootstrap) ||
    !exactObject(candidate) ||
    !exactObject(authorization) ||
    !exactObject(spool) ||
    bootstrap.campaignId !== PROBE_CAMPAIGN_ID ||
    bootstrap.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    authorization.campaignId !== PROBE_CAMPAIGN_ID ||
    authorization.campaignRunId !== bootstrap.campaignRunId ||
    authorization.runPlanSha256 !== bootstrap.runPlanSha256 ||
    authorization.candidateSha256 !== candidate.candidateSha256
  ) {
    fail("CONTROLLER_TRANSPORT_BOOTSTRAP", "bootstrap authority bindings are inconsistent");
  }
  for (const [value, label] of [
    [candidate.candidateSha256, "candidateSha256"],
    [authorization.authorizationSha256, "runAuthorizationSha256"],
    [spool.identitySha256, "controllerIdentitySha256"],
    [spool.publicKeySha256, "controllerPublicKeySha256"],
  ]) {
    requireSha256(value, label);
  }
  if (
    typeof bootstrap.campaignRunId !== "string" ||
    bootstrap.campaignRunId.length === 0 ||
    typeof spool.root !== "string" ||
    spool.root.length === 0 ||
    typeof spool.version !== "string" ||
    spool.version.length === 0 ||
    !Array.isArray(loadedBootstrap.attestations) ||
    loadedBootstrap.attestations.length === 0
  ) {
    fail("CONTROLLER_TRANSPORT_BOOTSTRAP", "bootstrap authority is incomplete");
  }
  let publicKeyBytes;
  try {
    publicKeyBytes = Buffer.from(loadedBootstrap.controllerPublicKeySpkiDerBase64, "base64");
  } catch {
    fail("CONTROLLER_TRANSPORT_AUTHORITY", "controller public key is not canonical base64");
  }
  if (
    publicKeyBytes.length === 0 ||
    publicKeyBytes.toString("base64") !== loadedBootstrap.controllerPublicKeySpkiDerBase64
  ) {
    fail("CONTROLLER_TRANSPORT_AUTHORITY", "controller public key is not canonical base64");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    fail("CONTROLLER_TRANSPORT_AUTHORITY", "controller public key is not SPKI DER");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(publicKey.export({ format: "der", type: "spki" })).equals(publicKeyBytes) ||
    createHash("sha256").update(publicKeyBytes).digest("hex") !== spool.publicKeySha256
  ) {
    fail("CONTROLLER_TRANSPORT_AUTHORITY", "controller public key differs from bootstrap");
  }
  for (const attestation of loadedBootstrap.attestations) {
    if (
      attestation?.controller?.identitySha256 !== spool.identitySha256 ||
      attestation?.controller?.publicKeySha256 !== spool.publicKeySha256 ||
      attestation?.controller?.publicKeyArtifact?.sha256 !== spool.publicKeySha256 ||
      attestation?.controller?.version !== spool.version
    ) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "attestation controller authority differs");
    }
  }
  return Object.freeze({
    bootstrap,
    candidate,
    authorization,
    spool,
    publicKeyBytes,
  });
}

function requireStore(store, root, label) {
  if (
    !exactObject(store) ||
    store.root !== root ||
    typeof store.createDirectory !== "function" ||
    typeof store.writeBytes !== "function" ||
    typeof store.readArtifact !== "function" ||
    typeof store.list !== "function" ||
    typeof store.assertRootStable !== "function"
  ) {
    fail("CONTROLLER_TRANSPORT_STORE", `${label} does not preserve its bound root`);
  }
  return store;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("CONTROLLER_TRANSPORT_SCHEMA", `${label} must be a non-empty string`);
  }
  return value;
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function snapshotControllerOperationInput(value, label = "controller operation input") {
  const ancestors = new Set();
  let nodes = 0;

  function clone(current, path, depth) {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) {
      fail("CONTROLLER_TRANSPORT_INPUT", `${label} exceeds the supported JSON bounds`);
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail("CONTROLLER_TRANSPORT_INPUT", `${path} contains a non-finite number`);
      }
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      fail("CONTROLLER_TRANSPORT_INPUT", `${path} must be acyclic JSON data`);
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          fail("CONTROLLER_TRANSPORT_INPUT", `${path} must be a plain array`);
        }
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length + 1 ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" ||
                !/^(?:0|[1-9]\d*)$/u.test(key) ||
                Number(key) >= current.length),
          )
        ) {
          fail("CONTROLLER_TRANSPORT_INPUT", `${path} is sparse or has extra fields`);
        }
        const result = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
            fail(
              "CONTROLLER_TRANSPORT_INPUT",
              `${path}[${index}] must be an enumerable data property`,
            );
          }
          result.push(clone(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return result;
      }

      if (!exactObject(current)) {
        fail("CONTROLLER_TRANSPORT_INPUT", `${path} must be a plain object`);
      }
      const result = Object.create(Object.getPrototypeOf(current));
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string" || key === "__proto__") {
          fail("CONTROLLER_TRANSPORT_INPUT", `${path} has an unsafe field name`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("CONTROLLER_TRANSPORT_INPUT", `${path}.${key} must be an enumerable data property`);
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

  const snapshot = clone(value, label, 0);
  if (!exactObject(snapshot)) {
    fail("CONTROLLER_TRANSPORT_INPUT", `${label} must be a plain object`);
  }
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (Object.hasOwn(descriptor, "value")) pending.push(descriptor.value);
      }
      Object.freeze(current);
    }
  }
  return snapshot;
}

function projectControllerOperationPayload(input, label) {
  if (!exactObject(input)) {
    fail("CONTROLLER_TRANSPORT_INPUT", `${label} must be a plain object`);
  }
  if (!Object.hasOwn(input, "preparedContext")) return input;
  if (Object.hasOwn(input, "preparedAuthority")) {
    fail("CONTROLLER_TRANSPORT_INPUT", `${label} has conflicting prepared authority fields`);
  }
  const { preparedContext, ...rootFreeInput } = input;
  return snapshotControllerOperationInput(
    {
      ...rootFreeInput,
      preparedAuthority: createProbeControllerPreparedAuthority(preparedContext),
    },
    `${label} root-free payload`,
  );
}

function validateProvenanceReference(value, label) {
  assertExactDataKeys(value, ["path", "bytes", "sha256"], label);
  validateEvidenceRelativePath(value.path);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label}.bytes is invalid`);
  }
  requireSha256(value.sha256, `${label}.sha256`);
  return Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
}

export function probeControllerActionCommitMarkerPath(input) {
  return `${probeControllerActionProvenancePaths(input).stem}.commit.json`;
}

function actionCommitReference(path, bytes) {
  validateEvidenceRelativePath(path);
  const retained = Buffer.from(bytes);
  return Object.freeze({ path, bytes: retained.length, sha256: sha256(retained) });
}

function actionCommitDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-action-commit.v1",
    commit: Object.fromEntries(controllerActionCommitDraftKeys.map((key) => [key, value[key]])),
  });
}

function validateControllerActionCommitMarker(value) {
  assertExactDataKeys(value, controllerActionCommitKeys, "controller action commit marker");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== controllerActionCommitKind ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller action commit identity is invalid");
  }
  for (const [digest, label] of [
    [value.candidateSha256, "candidateSha256"],
    [value.receiptSha256, "receiptSha256"],
    [value.provenanceSha256, "provenanceSha256"],
    [value.commitSha256, "commitSha256"],
  ]) {
    requireSha256(digest, `controller action commit ${label}`);
  }
  assertExactDataKeys(
    value.coordinate,
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
    "controller action commit coordinate",
  );
  for (const [entry, label] of [
    [value.coordinate.campaignRunId, "campaignRunId"],
    [value.coordinate.executionRunId, "executionRunId"],
    [value.coordinate.attemptId, "attemptId"],
    [value.coordinate.workId, "workId"],
    [value.coordinate.environmentId, "environmentId"],
    [value.coordinate.pathProfileId, "pathProfileId"],
    [value.coordinate.rowId, "rowId"],
    [value.coordinate.variantId, "variantId"],
    [value.producerActionId, "producerActionId"],
  ]) {
    requireString(entry, `controller action commit ${label}`);
  }
  if (
    value.coordinate.repetition !== null &&
    (!Number.isSafeInteger(value.coordinate.repetition) || value.coordinate.repetition < 1)
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller action commit repetition is invalid");
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 7 ||
    value.artifacts.length > 8192
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller action commit artifacts are invalid");
  }
  let previousPath = null;
  const foldedPaths = new Set();
  const digests = new Set();
  const artifacts = value.artifacts.map((reference, index) => {
    const validated = validateProvenanceReference(
      reference,
      `controller action commit artifacts[${index}]`,
    );
    const foldedPath = validated.path.toLocaleLowerCase("en-US");
    if (
      (previousPath !== null && compareUtf8(previousPath, validated.path) >= 0) ||
      foldedPaths.has(foldedPath) ||
      digests.has(validated.sha256)
    ) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        "controller action commit artifacts collide or are unordered",
      );
    }
    previousPath = validated.path;
    foldedPaths.add(foldedPath);
    digests.add(validated.sha256);
    return validated;
  });
  const marker = Object.freeze({ ...value, artifacts: Object.freeze(artifacts) });
  if (marker.commitSha256 !== actionCommitDigest(marker)) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller action commit digest is invalid");
  }
  return marker;
}

function createControllerActionCommitMarker({ receipt, provenance, artifacts }) {
  const sortedArtifacts = artifacts
    .map(({ path, bytes }) => actionCommitReference(path, bytes))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const draft = {
    schemaVersion: 1,
    kind: controllerActionCommitKind,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: receipt.candidateSha256,
    coordinate: receipt.coordinate,
    producerActionId: receipt.producerActionId,
    receiptSha256: receipt.receiptSha256,
    provenanceSha256: provenance.provenanceSha256,
    artifacts: sortedArtifacts,
  };
  return validateControllerActionCommitMarker({
    ...draft,
    commitSha256: actionCommitDigest(draft),
  });
}

function coordinateKey(environmentId, pathProfileId, rowId, variantId) {
  return `${environmentId}\0${pathProfileId}\0${rowId}\0${variantId}`;
}

function stripEvidenceRoot(input) {
  if (!exactObject(input) || !Object.hasOwn(input, "evidenceRoot")) {
    fail("CONTROLLER_TRANSPORT_INPUT", "controller operation input must bind evidenceRoot");
  }
  const evidenceRoot = requireString(input.evidenceRoot, "controller operation evidenceRoot");
  const { evidenceRoot: _evidenceRoot, ...payloadInput } = input;
  return Object.freeze({ evidenceRoot, payloadInput });
}

function preparationScope(input) {
  const request = input?.request;
  if (!exactObject(request)) {
    fail("CONTROLLER_TRANSPORT_COORDINATE", "preparation operation must contain a request");
  }
  return Object.freeze({
    coordinate: Object.freeze({
      campaignRunId: request.campaignRunId,
      executionRunId: request.executionRunId,
      attemptId: request.attemptId,
      environmentId: request.environmentId,
      pathProfileId: request.pathProfileId,
      workId: null,
      rowId: null,
      variantId: null,
      repetition: null,
    }),
    claimSha256: null,
  });
}

function requireMatchingWorkScope(input, includeScenarioRepetition = false) {
  const command = input?.command;
  const workItem = input?.workItem;
  const prepared = input?.preparedContext;
  if (!exactObject(command) || !exactObject(workItem) || !exactObject(prepared)) {
    fail("CONTROLLER_TRANSPORT_COORDINATE", "work operation has an incomplete runtime scope");
  }
  if (
    command.campaignRunId !== prepared.campaignRunId ||
    command.attemptId !== prepared.attemptId ||
    command.workId !== workItem.workId ||
    command.environmentId !== workItem.environmentId ||
    command.pathProfileId !== workItem.pathProfileId ||
    command.rowId !== workItem.rowId ||
    command.variantId !== workItem.variantId ||
    prepared.environmentId !== workItem.environmentId ||
    prepared.pathProfileId !== workItem.pathProfileId
  ) {
    fail("CONTROLLER_TRANSPORT_COORDINATE", "runtime work scope has conflicting coordinates");
  }
  return Object.freeze({
    coordinate: Object.freeze({
      campaignRunId: command.campaignRunId,
      executionRunId: prepared.executionRunId,
      attemptId: command.attemptId,
      environmentId: workItem.environmentId,
      pathProfileId: workItem.pathProfileId,
      workId: workItem.workId,
      rowId: workItem.rowId,
      variantId: workItem.variantId,
      repetition:
        includeScenarioRepetition &&
        Number.isSafeInteger(command.repetition) &&
        command.repetition > 0
          ? command.repetition
          : null,
    }),
    claimSha256: requireSha256(
      prepared.runAuthorizationClaimReceiptSha256,
      "preparedContext.runAuthorizationClaimReceiptSha256",
    ),
  });
}

function finalizationScope(input, workByCoordinate) {
  const intent = input?.finalizationIntent ?? input?.binding?.finalizationIntent;
  if (!exactObject(intent)) {
    fail("CONTROLLER_TRANSPORT_COORDINATE", "finalizer operation has no finalization intent");
  }
  const workItem = workByCoordinate.get(
    coordinateKey(intent.environmentId, intent.pathProfileId, intent.rowId, intent.variantId),
  );
  if (workItem === undefined) {
    fail("CONTROLLER_TRANSPORT_COORDINATE", "finalization intent has no canonical run-plan work");
  }
  return Object.freeze({
    coordinate: Object.freeze({
      campaignRunId: intent.campaignRunId,
      executionRunId: intent.executionRunId,
      attemptId: intent.attemptId,
      environmentId: intent.environmentId,
      pathProfileId: intent.pathProfileId,
      workId: workItem.workId,
      rowId: intent.rowId,
      variantId: intent.variantId,
      repetition: null,
    }),
    claimSha256: requireSha256(
      intent.runAuthorizationClaimReceiptSha256,
      "finalizationIntent.runAuthorizationClaimReceiptSha256",
    ),
  });
}

function operationSequence(method, input) {
  if (method === "renewEvidenceQuiescence") {
    const prior = input?.previousLeaseReceipt?.renewalSequence;
    if (!Number.isSafeInteger(prior) || prior < 0) {
      fail("CONTROLLER_TRANSPORT_SEQUENCE", "previous renewal sequence is invalid");
    }
    return prior + 1;
  }
  if (method === "invokeScenarioAction") {
    const sequence = input?.invocation?.action?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail("CONTROLLER_TRANSPORT_SEQUENCE", "scenario action sequence is invalid");
    }
    return sequence;
  }
  if (method === "claimHardCutRequest" || method === "readHardCutReceipt") {
    const repetition = input?.command?.repetition;
    if (!Number.isSafeInteger(repetition) || repetition < 1) {
      fail("CONTROLLER_TRANSPORT_SEQUENCE", "hard-cut repetition is invalid");
    }
    return repetition;
  }
  return 1;
}

function deterministicOperationId(authority, coordinate, operationKind, sequence) {
  return `operation-${sha256(
    canonicalProbeJson({
      domain: "enduragent.windows-host-probe-controller-spool-operation.v1",
      campaignId: PROBE_CAMPAIGN_ID,
      candidateSha256: authority.candidate.candidateSha256,
      runAuthorizationSha256: authority.authorization.authorizationSha256,
      coordinate,
      operationKind,
      sequence,
    }),
  ).slice(0, 32)}`;
}

function parseCanonicalObject(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("CONTROLLER_TRANSPORT_CANONICAL", `${label} is not UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("CONTROLLER_TRANSPORT_CANONICAL", `${label} is not JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== text) {
    fail("CONTROLLER_TRANSPORT_CANONICAL", `${label} is not canonical JSON`);
  }
  return value;
}

async function ensureParentDirectories(store, relativePath) {
  const segments = validateEvidenceRelativePath(relativePath).split("/");
  segments.pop();
  let current = "";
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    try {
      await store.createDirectory(current);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function retainExactBytes(store, path, bytes, expectedSha256, label) {
  validateEvidenceRelativePath(path);
  const retainedBytes = Buffer.from(bytes);
  if (sha256(retainedBytes) !== expectedSha256) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} bytes differ from the signed digest`);
  }
  await store.assertRootStable();
  await ensureParentDirectories(store, path);
  try {
    const retained = await store.writeBytes(path, retainedBytes);
    if (retained?.path !== path || retained?.sha256 !== expectedSha256) {
      fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} publication acknowledgment differs`);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(path);
    if (
      retained?.path !== path ||
      retained?.size !== retainedBytes.length ||
      retained?.sha256 !== expectedSha256 ||
      !Buffer.from(retained?.bytes ?? []).equals(retainedBytes)
    ) {
      fail("CONTROLLER_TRANSPORT_COLLISION", `${label} replay differs from retained evidence`);
    }
  }
  await store.assertRootStable();
  return Object.freeze({ path, sha256: expectedSha256 });
}

function requireArtifactReference(value, label) {
  if (!exactObject(value)) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} must be an artifact reference`);
  }
  validateEvidenceRelativePath(value.path);
  requireSha256(value.sha256, `${label}.sha256`);
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

function requireExactReferenceSet(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} must be an artifact set`);
  }
  const normalize = (entries, entryLabel) =>
    entries
      .map((entry, index) => requireArtifactReference(entry, `${entryLabel}[${index}]`))
      .sort((left, right) => compareUtf8(left.path, right.path));
  const normalizedActual = normalize(actual, `${label} actual`);
  const normalizedExpected = normalize(expected, `${label} expected`);
  if (!canonicalEqual(normalizedActual, normalizedExpected)) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} differs from the signed bindings`);
  }
  return normalizedActual;
}

function requireExactOrderedReferences(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} must be an artifact set`);
  }
  const normalizedActual = actual.map((entry, index) =>
    requireArtifactReference(entry, `${label} actual[${index}]`),
  );
  const normalizedExpected = expected.map((entry, index) =>
    requireArtifactReference(entry, `${label} expected[${index}]`),
  );
  if (!canonicalEqual(normalizedActual, normalizedExpected)) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} differs from the signed receipt`);
  }
  return Object.freeze(normalizedActual);
}

function validateScenarioActionReceiptBinding(receiptValue, trusted) {
  const receipt = validateProbeControllerActionExecutionReceiptStructure(receiptValue);
  const expected = {
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: trusted.authority.candidate.candidateSha256,
    executionBundleId: trusted.preparedContext.executionBundleId,
    executionBundleManifestSha256: trusted.preparedContext.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: trusted.preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate: trusted.coordinate,
    scenarioPlanSha256: trusted.definition.planSha256,
    producerActionId: trusted.action.actionId,
    operation: trusted.operation,
    intentSha256: trusted.runtimeActionBinding.operationIntentSha256,
    execution: trusted.runtimeActionBinding.execution,
    expectedActor: trusted.runtimeActionBinding.expectedActor,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!canonicalEqual(receipt[key], expectedValue)) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO_RECEIPT",
        `scenario action receipt ${key} differs from trusted runtime authority`,
      );
    }
  }
  if (
    receipt.actionResultArtifact.path !== trusted.runtimeActionBinding.operationResultPath ||
    receipt.actionResult.actionId !== trusted.action.actionId
  ) {
    fail(
      "CONTROLLER_TRANSPORT_SCENARIO_RECEIPT",
      "scenario action receipt result differs from the trusted action",
    );
  }
  return receipt;
}

function scenarioActionAcknowledgment(receipt, provenance, verified) {
  const primaryObserverTranscriptSha256s = Object.freeze(
    receipt.observerTranscripts.map(({ transcriptSha256 }) => transcriptSha256).sort(compareUtf8),
  );
  return Object.freeze({
    operationId: receipt.operation.operationId,
    resultSha256: receipt.actionResultArtifact.sha256,
    receiptSha256: receipt.receiptSha256,
    provenanceSha256: provenance.provenanceSha256,
    actionAttestationSha256: verified.actionAttestation?.attestationSha256 ?? null,
    primaryObserverTranscriptSha256s,
  });
}

function hardCutReceiptResult(checkpointEvidence, receipt, provenance, verified) {
  return Object.freeze({
    checkpointEvidence,
    actionExecutionReceipt: receipt,
    actionAcknowledgment: scenarioActionAcknowledgment(receipt, provenance, verified),
  });
}

function retainedRecordInput(bytes) {
  const retained = Buffer.from(bytes);
  return Object.freeze({ bytes: retained.length, sha256: sha256(retained) });
}

function validateScenarioObserverTranscripts(receipt, artifactsBySha256, preparedContext) {
  const nativeHelper = preparedContext.executionBundleManifest.binaries.nativeHelper;
  const expectedBinding = {
    campaignRunId: preparedContext.campaignRunId,
    candidateSha256: preparedContext.candidateSha256,
    preflightSha256: preparedContext.preflightSha256,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    nativeHelperArtifactPath: nativeHelper.path,
    nativeHelperSha256: nativeHelper.sha256,
    nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
    nativeManifestSha256: nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256:
      preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
  };
  for (const [index, reference] of receipt.observerTranscripts.entries()) {
    const bytes = artifactsBySha256.get(reference.sha256);
    if (bytes === undefined || sha256(bytes) !== reference.sha256) {
      fail(
        "CONTROLLER_TRANSPORT_OBSERVER",
        `scenario observer transcript[${index}] bytes differ from its signed reference`,
      );
    }
    const transcript = validateNativeCommandTranscript(
      parseCanonicalObject(bytes, `scenario observer transcript[${index}]`),
    );
    if (
      transcript.transcriptSha256 !== reference.transcriptSha256 ||
      !reference.path.endsWith(`/${transcript.transcriptSha256}.json`) ||
      !transcript.records.some(({ kind }) => kind === "command") ||
      transcript.termination === null ||
      Object.entries(expectedBinding).some(
        ([key, expected]) => transcript.binding[key] !== expected,
      ) ||
      sha256(Buffer.from(transcript.binding.runRootIdentity, "utf8")) !==
        expectedBinding.evidenceRootObjectIdentitySha256
    ) {
      fail(
        "CONTROLLER_TRANSPORT_OBSERVER",
        `scenario observer transcript[${index}] differs from its prepared runtime binding`,
      );
    }
  }
}

function validateExchangeArtifacts(exchange, response) {
  if (!exactObject(exchange) || !Array.isArray(exchange.artifacts)) {
    fail("CONTROLLER_TRANSPORT_RESPONSE", "spool exchange returned an invalid artifact set");
  }
  const signed = response?.artifacts;
  if (!Array.isArray(signed) || signed.length !== exchange.artifacts.length) {
    fail("CONTROLLER_TRANSPORT_RESPONSE", "spool exchange artifact count differs");
  }
  const bySha256 = new Map();
  for (const [index, artifact] of exchange.artifacts.entries()) {
    const reference = artifact?.reference;
    const bytes = Buffer.from(artifact?.bytes ?? []);
    if (
      !exactObject(reference) ||
      reference.sha256 !== sha256(bytes) ||
      reference.bytes !== bytes.length ||
      reference.blobPath !== `blobs/sha256/${reference.sha256}` ||
      !canonicalEqual(reference, signed[index]) ||
      bySha256.has(reference.sha256)
    ) {
      fail("CONTROLLER_TRANSPORT_RESPONSE", "spool exchange artifact bytes differ");
    }
    bySha256.set(reference.sha256, bytes);
  }
  return bySha256;
}

async function retainBindings(store, bindings, artifactsBySha256, label) {
  for (const [index, binding] of bindings.entries()) {
    const bytes = artifactsBySha256.get(binding.sha256);
    if (bytes === undefined) {
      fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} binding has no signed bytes`);
    }
    await retainExactBytes(store, binding.path, bytes, binding.sha256, `${label}[${index}]`);
  }
}

function requireNoBindings(bindings, method) {
  if (bindings.length !== 0) {
    fail("CONTROLLER_TRANSPORT_ARTIFACT", `${method} must not return artifact bindings`);
  }
}

async function retainReferences(store, references, artifactsBySha256, label) {
  for (const [index, reference] of references.entries()) {
    const bytes = artifactsBySha256.get(reference.sha256);
    if (bytes === undefined) {
      fail("CONTROLLER_TRANSPORT_ARTIFACT", `${label} reference has no signed bytes`);
    }
    await retainExactBytes(store, reference.path, bytes, reference.sha256, `${label}[${index}]`);
  }
}

function validateControllerProducedNativeActionPlans(exchanged, input, actionId) {
  const planBindings = exchanged.bindings.filter(({ path }) => path.includes("/driver-plans/"));
  if (planBindings.length === 0) return Object.freeze([]);
  const definition = getProbeScenarioDefinition(input.command.rowId, input.command.variantId);
  const producer = definition.actions.find(({ actionId: id }) => id === actionId);
  const rootIdentity =
    input.preparedContext?.pathProfileObservation?.evidenceRootObjectIdentitySha256;
  if (
    producer?.actor !== "external-controller" ||
    !["setup", "transition"].includes(producer.phase) ||
    !canonicalEqual(input.invocation?.action, producer) ||
    typeof rootIdentity !== "string"
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller-produced native action plans have no valid producer or root binding",
    );
  }
  const consumerActionIds = new Set();
  const materials = planBindings.map((binding) => {
    const bytes = exchanged.artifactsBySha256.get(binding.sha256);
    if (bytes === undefined) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        "native action plan binding has no controller-bound bytes",
      );
    }
    const plan = validateProbeNativeActionPlan(
      parseCanonicalObject(bytes, "controller-produced native action plan"),
    );
    const expectedPath = probeNativeActionPlanPath({
      campaignRunId: input.command.campaignRunId,
      attemptId: input.command.attemptId,
      workId: input.command.workId,
      consumerActionId: plan.consumerActionId,
    });
    const consumer = definition.actions.find(({ actionId: id }) => id === plan.consumerActionId);
    const expectedProducer = definition.actions
      .slice(0, (consumer?.sequence ?? 1) - 1)
      .filter(({ actor }) => actor === "external-controller")
      .at(-1);
    let consumerBinding;
    try {
      consumerBinding = createProbeRuntimeActionBinding({
        command: input.command,
        invocation: { ...input.invocation, action: consumer },
        preparedContext: input.preparedContext,
      });
    } catch {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        "controller-produced native action plan cannot derive its frozen consumer binding",
      );
    }
    if (
      binding.path !== expectedPath ||
      consumer?.actor !== "native-helper" ||
      producer.sequence >= consumer.sequence ||
      expectedProducer?.actionId !== producer.actionId ||
      consumerActionIds.has(plan.consumerActionId) ||
      plan.campaignRunId !== input.command.campaignRunId ||
      plan.executionRunId !== input.preparedContext.executionRunId ||
      plan.attemptId !== input.command.attemptId ||
      plan.workId !== input.command.workId ||
      plan.environmentId !== input.command.environmentId ||
      plan.pathProfileId !== input.command.pathProfileId ||
      plan.rowId !== input.command.rowId ||
      plan.variantId !== input.command.variantId ||
      plan.scenarioPlanSha256 !== definition.planSha256 ||
      plan.producerActionId !== producer.actionId ||
      plan.consumerActionId !== consumer.actionId ||
      plan.operationId !== consumerBinding.operationId ||
      plan.candidateSha256 !== input.preparedContext.candidateSha256 ||
      plan.candidateSha256 !== exchanged.request.candidateSha256 ||
      plan.evidenceRootObjectIdentitySha256 !== rootIdentity
    ) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        "controller-produced native action plan belongs to another action or coordinate",
      );
    }
    consumerActionIds.add(plan.consumerActionId);
    return Object.freeze({ binding, bytes: Buffer.from(bytes), plan });
  });
  materials.sort((left, right) => compareUtf8(left.binding.path, right.binding.path));
  return Object.freeze(materials);
}

async function retainControllerNativeActionPlan({ store, planMaterial }) {
  const plan = planMaterial.plan;
  const planPath = probeNativeActionPlanPath({
    campaignRunId: plan.campaignRunId,
    attemptId: plan.attemptId,
    workId: plan.workId,
    consumerActionId: plan.consumerActionId,
  });
  if (planPath !== planMaterial.binding.path) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "native action plan path changed before retention");
  }
  const bytes = Buffer.from(planMaterial.bytes);
  await retainExactBytes(
    store,
    planPath,
    bytes,
    planMaterial.binding.sha256,
    "controller native action plan",
  );
  return plan;
}

async function readRetainedArtifact(store, path, expected, label) {
  validateEvidenceRelativePath(path);
  await store.assertRootStable();
  let artifact;
  try {
    artifact = await store.readArtifact(path);
  } catch {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} is missing`);
  }
  const bytes = Buffer.from(artifact?.bytes ?? []);
  const digest = sha256(bytes);
  if (
    artifact?.path !== path ||
    artifact?.size !== bytes.length ||
    artifact?.sha256 !== digest ||
    (expected !== null &&
      (expected.path !== path || expected.bytes !== bytes.length || expected.sha256 !== digest))
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} differs from retained provenance`);
  }
  await store.assertRootStable();
  return Object.freeze({ path, bytes, size: bytes.length, sha256: digest });
}

async function assertUniqueRetainedPath(store, path, label) {
  const segments = validateEvidenceRelativePath(path).split("/");
  const leaf = segments.pop();
  const parent = segments.join("/");
  await store.assertRootStable();
  let entries;
  try {
    entries = await store.list(parent);
  } catch {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} directory cannot be inspected`);
  }
  if (!Array.isArray(entries)) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} directory listing is invalid`);
  }
  const foldedLeaf = leaf.toLocaleLowerCase("en-US");
  const matches = entries.filter(
    (entry) =>
      exactObject(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLocaleLowerCase("en-US") === foldedLeaf,
  );
  if (matches.length !== 1 || matches[0].name !== leaf || matches[0].kind !== "file") {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} is missing or case-colliding`);
  }
  await store.assertRootStable();
}

function actionRetentionIncomplete(label) {
  fail(
    PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE,
    `${label} is incomplete and requires exact controller response replay`,
  );
}

async function readControllerActionCommitMarker(store, path, label) {
  const segments = validateEvidenceRelativePath(path).split("/");
  const leaf = segments.pop();
  const parent = segments.join("/");
  await store.assertRootStable();
  let entries;
  try {
    entries = await store.list(parent);
  } catch (error) {
    if (error?.code === "ENOENT") actionRetentionIncomplete(label);
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} directory cannot be inspected`);
  }
  if (!Array.isArray(entries)) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} directory listing is invalid`);
  }
  const foldedLeaf = leaf.toLocaleLowerCase("en-US");
  const matches = entries.filter(
    (entry) =>
      exactObject(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLocaleLowerCase("en-US") === foldedLeaf,
  );
  if (matches.length === 0) actionRetentionIncomplete(label);
  if (matches.length !== 1 || matches[0].name !== leaf || matches[0].kind !== "file") {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} is case-colliding`);
  }
  let artifact;
  try {
    artifact = await store.readArtifact(path);
  } catch (error) {
    if (error?.code === "ENOENT") actionRetentionIncomplete(label);
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} cannot be read`);
  }
  const bytes = Buffer.from(artifact?.bytes ?? []);
  const digest = sha256(bytes);
  if (artifact?.path !== path || artifact?.size !== bytes.length || artifact?.sha256 !== digest) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} bytes are invalid`);
  }
  const marker = validateControllerActionCommitMarker(parseCanonicalObject(bytes, label));
  await store.assertRootStable();
  return Object.freeze({ marker, bytes, sha256: digest });
}

async function readControllerNativeActionPlanCandidate(store, path) {
  const segments = validateEvidenceRelativePath(path).split("/");
  const leaf = segments.pop();
  const parent = segments.join("/");
  await store.assertRootStable();
  let entries;
  try {
    entries = await store.list(parent);
  } catch (error) {
    if (error?.code === "ENOENT") actionRetentionIncomplete("controller native action plan");
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller native action plan directory cannot be inspected",
    );
  }
  if (!Array.isArray(entries)) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller native action plan directory listing is invalid",
    );
  }
  const foldedLeaf = leaf.toLocaleLowerCase("en-US");
  const matches = entries.filter(
    (entry) =>
      exactObject(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLocaleLowerCase("en-US") === foldedLeaf,
  );
  if (matches.length === 0) actionRetentionIncomplete("controller native action plan");
  if (matches.length !== 1 || matches[0].name !== leaf || matches[0].kind !== "file") {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller native action plan is case-colliding");
  }
  let artifact;
  try {
    artifact = await store.readArtifact(path);
  } catch (error) {
    if (error?.code === "ENOENT") actionRetentionIncomplete("controller native action plan");
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller native action plan cannot be read");
  }
  const bytes = Buffer.from(artifact?.bytes ?? []);
  const digest = sha256(bytes);
  if (artifact?.path !== path || artifact?.size !== bytes.length || artifact?.sha256 !== digest) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller native action plan bytes are invalid");
  }
  await store.assertRootStable();
  return Object.freeze({ path, bytes, size: bytes.length, sha256: digest });
}

async function verifyControllerActionCommitArtifacts(store, marker, label) {
  const artifacts = new Map();
  for (const [index, reference] of marker.artifacts.entries()) {
    await assertUniqueRetainedPath(store, reference.path, `${label} artifact[${index}]`);
    const retained = await readRetainedArtifact(
      store,
      reference.path,
      reference,
      `${label} artifact[${index}]`,
    );
    artifacts.set(reference.path, retained);
  }
  return artifacts;
}

async function assertPublishableExactPath(store, path, bytes, expectedSha256, label) {
  const segments = validateEvidenceRelativePath(path).split("/");
  const leaf = segments.pop();
  const parent = segments.join("/");
  await store.assertRootStable();
  let entries;
  try {
    entries = await store.list(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await store.assertRootStable();
      return;
    }
    fail("CONTROLLER_TRANSPORT_COLLISION", `${label} directory cannot be inspected`);
  }
  if (!Array.isArray(entries)) {
    fail("CONTROLLER_TRANSPORT_COLLISION", `${label} directory listing is invalid`);
  }
  const foldedLeaf = leaf.toLocaleLowerCase("en-US");
  const matches = entries.filter(
    (entry) =>
      exactObject(entry) &&
      typeof entry.name === "string" &&
      entry.name.toLocaleLowerCase("en-US") === foldedLeaf,
  );
  if (matches.length === 0) {
    await store.assertRootStable();
    return;
  }
  if (matches.length !== 1 || matches[0].name !== leaf || matches[0].kind !== "file") {
    fail("CONTROLLER_TRANSPORT_COLLISION", `${label} is case-colliding`);
  }
  const retained = await store.readArtifact(path);
  const expectedBytes = Buffer.from(bytes);
  if (
    retained?.path !== path ||
    retained?.size !== expectedBytes.length ||
    retained?.sha256 !== expectedSha256 ||
    !Buffer.from(retained?.bytes ?? []).equals(expectedBytes)
  ) {
    fail("CONTROLLER_TRANSPORT_COLLISION", `${label} replay differs from retained evidence`);
  }
  await store.assertRootStable();
}

function sameCoordinate(actual, expected) {
  return [
    "campaignRunId",
    "executionRunId",
    "attemptId",
    "workId",
    "environmentId",
    "pathProfileId",
    "rowId",
    "variantId",
  ].every((key) => actual?.[key] === expected[key]);
}

export async function readVerifiedControllerNativeActionPlan(options) {
  assertExactDataKeys(
    options,
    [
      "store",
      "loadedBootstrap",
      "campaignRunId",
      "executionRunId",
      "attemptId",
      "workId",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "consumerActionId",
    ],
    "verified controller native action plan options",
  );
  const store = requireStore(
    options.store,
    options.store?.root,
    "native action plan evidence store",
  );
  const authority = controllerAuthority(options.loadedBootstrap);
  const expectedCoordinate = Object.freeze({
    campaignRunId: options.campaignRunId,
    executionRunId: options.executionRunId,
    attemptId: options.attemptId,
    workId: options.workId,
    environmentId: options.environmentId,
    pathProfileId: options.pathProfileId,
    rowId: options.rowId,
    variantId: options.variantId,
  });
  for (const [entry, label] of Object.entries({
    ...expectedCoordinate,
    consumerActionId: options.consumerActionId,
  })) {
    requireString(entry, `verified controller native action plan ${label}`);
  }
  const requestedPlanPath = probeNativeActionPlanPath({
    campaignRunId: options.campaignRunId,
    attemptId: options.attemptId,
    workId: options.workId,
    consumerActionId: options.consumerActionId,
  });
  let retainedPlan;
  try {
    retainedPlan = await readControllerNativeActionPlanCandidate(store, requestedPlanPath);
  } catch (error) {
    if (error?.code !== PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE) throw error;
    let frozenDefinition;
    try {
      frozenDefinition = getProbeScenarioDefinition(
        expectedCoordinate.rowId,
        expectedCoordinate.variantId,
      );
    } catch {
      throw error;
    }
    const frozenConsumer = frozenDefinition.actions.find(
      ({ actionId }) => actionId === options.consumerActionId,
    );
    const frozenProducer = frozenDefinition.actions
      .slice(0, (frozenConsumer?.sequence ?? 1) - 1)
      .filter(({ actor }) => actor === "external-controller")
      .at(-1);
    if (frozenConsumer?.actor !== "native-helper" || frozenProducer === undefined) throw error;
    try {
      await readControllerActionCommitMarker(
        store,
        probeControllerActionCommitMarkerPath({
          campaignRunId: options.campaignRunId,
          attemptId: options.attemptId,
          workId: options.workId,
          producerActionId: frozenProducer.actionId,
        }),
        "controller action commit marker",
      );
    } catch (commitError) {
      if (commitError?.code === PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE) throw error;
      throw commitError;
    }
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "committed controller native action plan is missing");
  }
  const plan = validateProbeNativeActionPlan(
    parseCanonicalObject(retainedPlan.bytes, "retained controller native action plan"),
  );
  const canonicalPlanPath = probeNativeActionPlanPath({
    campaignRunId: plan.campaignRunId,
    attemptId: plan.attemptId,
    workId: plan.workId,
    consumerActionId: plan.consumerActionId,
  });
  let definition;
  try {
    definition = getProbeScenarioDefinition(expectedCoordinate.rowId, expectedCoordinate.variantId);
  } catch {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller-bound native action plan has no frozen scenario",
    );
  }
  const trustedConsumer = definition.actions.find(
    ({ actionId }) => actionId === plan.consumerActionId,
  );
  const trustedProducer = definition.actions.find(
    ({ actionId }) => actionId === plan.producerActionId,
  );
  const expectedProducer = definition.actions
    .slice(0, (trustedConsumer?.sequence ?? 1) - 1)
    .filter(({ actor }) => actor === "external-controller")
    .at(-1);
  if (
    canonicalPlanPath !== requestedPlanPath ||
    plan.consumerActionId !== options.consumerActionId ||
    plan.campaignRunId !== expectedCoordinate.campaignRunId ||
    plan.executionRunId !== expectedCoordinate.executionRunId ||
    plan.attemptId !== expectedCoordinate.attemptId ||
    plan.workId !== expectedCoordinate.workId ||
    plan.environmentId !== expectedCoordinate.environmentId ||
    plan.pathProfileId !== expectedCoordinate.pathProfileId ||
    plan.rowId !== expectedCoordinate.rowId ||
    plan.variantId !== expectedCoordinate.variantId ||
    plan.scenarioPlanSha256 !== definition.planSha256 ||
    plan.candidateSha256 !== authority.candidate.candidateSha256 ||
    trustedConsumer?.actor !== "native-helper" ||
    trustedProducer?.actor !== "external-controller" ||
    !["setup", "transition"].includes(trustedProducer.phase) ||
    expectedProducer?.actionId !== trustedProducer.actionId ||
    trustedProducer.sequence >= trustedConsumer.sequence
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller-bound native action plan belongs to another action or coordinate",
    );
  }

  const paths = probeControllerActionProvenancePaths({
    campaignRunId: plan.campaignRunId,
    attemptId: plan.attemptId,
    workId: plan.workId,
    producerActionId: plan.producerActionId,
  });
  const commitPath = probeControllerActionCommitMarkerPath({
    campaignRunId: plan.campaignRunId,
    attemptId: plan.attemptId,
    workId: plan.workId,
    producerActionId: plan.producerActionId,
  });
  const retainedCommit = await readControllerActionCommitMarker(
    store,
    commitPath,
    "controller action commit marker",
  );
  const commit = retainedCommit.marker;
  if (
    !sameCoordinate(commit.coordinate, expectedCoordinate) ||
    commit.candidateSha256 !== authority.candidate.candidateSha256 ||
    commit.producerActionId !== plan.producerActionId
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller action commit belongs to another producer or coordinate",
    );
  }
  const committedArtifacts = await verifyControllerActionCommitArtifacts(
    store,
    commit,
    "controller action commit",
  );
  const committedPlan = committedArtifacts.get(requestedPlanPath);
  if (
    committedPlan?.sha256 !== retainedPlan.sha256 ||
    committedPlan?.size !== retainedPlan.size ||
    !committedPlan.bytes.equals(retainedPlan.bytes)
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller action commit does not bind the retained native action plan",
    );
  }
  const requiredActionRecords = {
    provenance: paths.provenance,
    executionReceipt: paths.receipt,
    controllerRequest: paths.controllerRequest,
    operationRequest: paths.operationRequest,
    controllerResponse: paths.controllerResponse,
    operationResponse: paths.operationResponse,
  };
  const retainedRecords = {};
  for (const [key, path] of Object.entries(requiredActionRecords)) {
    const artifact = committedArtifacts.get(path);
    if (artifact === undefined) {
      fail("CONTROLLER_TRANSPORT_PROVENANCE", `controller action commit omits ${key}`);
    }
    retainedRecords[key] = artifact;
  }
  const receiptStructure = validateProbeControllerActionExecutionReceiptStructure(
    parseCanonicalObject(
      retainedRecords.executionReceipt.bytes,
      "retained controller action execution receipt",
    ),
  );
  const signedArtifacts = collectProbeControllerActionSignedArtifacts(receiptStructure);
  const evidenceArtifacts = signedArtifacts.map((reference) => {
    const retained = committedArtifacts.get(reference.path);
    if (retained?.sha256 !== reference.sha256) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        "controller action commit omits signed execution evidence",
      );
    }
    return Object.freeze({ path: reference.path, bytes: retained.bytes });
  });
  const executionReceipt = validateProbeControllerActionExecutionReceipt(
    receiptStructure,
    evidenceArtifacts,
  );
  const provenance = validateProbeControllerActionProvenance(
    parseCanonicalObject(retainedRecords.provenance.bytes, "retained controller action provenance"),
    {
      receipt: executionReceipt,
      records: {
        controllerRequest: retainedRecordInput(retainedRecords.controllerRequest.bytes),
        operationRequest: retainedRecordInput(retainedRecords.operationRequest.bytes),
        controllerResponse: retainedRecordInput(retainedRecords.controllerResponse.bytes),
        operationResponse: retainedRecordInput(retainedRecords.operationResponse.bytes),
      },
      artifacts: evidenceArtifacts,
    },
  );
  if (
    !sameCoordinate(executionReceipt.coordinate, expectedCoordinate) ||
    executionReceipt.candidateSha256 !== authority.candidate.candidateSha256 ||
    executionReceipt.scenarioPlanSha256 !== definition.planSha256 ||
    executionReceipt.producerActionId !== plan.producerActionId ||
    provenance.producerActionId !== plan.producerActionId ||
    commit.receiptSha256 !== executionReceipt.receiptSha256 ||
    commit.provenanceSha256 !== provenance.provenanceSha256
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller action provenance belongs to another producer or coordinate",
    );
  }

  const request = validateControllerRequest(
    parseCanonicalObject(retainedRecords.controllerRequest.bytes, "retained controller request"),
  );
  if (
    request.operation.kind !== "scenario-action" ||
    !canonicalEqual(request.operation, executionReceipt.operation) ||
    request.candidateSha256 !== authority.candidate.candidateSha256 ||
    request.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    request.runAuthorizationSha256 !== authority.authorization.authorizationSha256 ||
    request.runAuthorizationClaimSha256 !== executionReceipt.runAuthorizationClaimReceiptSha256 ||
    request.coordinate.campaignRunId !== authority.bootstrap.campaignRunId ||
    request.controllerIdentitySha256 !== authority.spool.identitySha256 ||
    !canonicalEqual(request.coordinate, executionReceipt.coordinate)
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "retained controller request binding differs");
  }
  const operationRequestBytes = retainedRecords.operationRequest.bytes;
  if (
    request.payload.sha256 !== sha256(operationRequestBytes) ||
    request.payload.bytes !== operationRequestBytes.length ||
    request.payload.blobPath !== `blobs/sha256/${request.payload.sha256}`
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "retained operation request payload differs");
  }
  const operationRequest = decodeControllerOperationRequest(operationRequestBytes, {
    expectedOperationKind: "scenario-action",
  });
  if (operationRequest.intentSha256 !== request.intentSha256) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "retained operation request intent differs");
  }
  const producerInput = operationRequest.envelope.input;
  const producerAction = producerInput?.invocation?.action;
  const command = producerInput?.command;
  const workItem = producerInput?.workItem;
  const preparedAuthority = producerInput?.preparedAuthority;
  const trustedProducerInvocation = Object.freeze({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: trustedProducer,
  });
  const trustedConsumerInvocation = Object.freeze({
    ...trustedProducerInvocation,
    action: trustedConsumer,
  });
  let producerBinding;
  let consumerBinding;
  try {
    producerBinding = createProbeRuntimeActionBindingFromPreparedAuthority({
      command,
      invocation: trustedProducerInvocation,
      preparedAuthority,
    });
    consumerBinding = createProbeRuntimeActionBindingFromPreparedAuthority({
      command,
      invocation: trustedConsumerInvocation,
      preparedAuthority,
    });
  } catch {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "retained operation request cannot derive frozen action bindings",
    );
  }
  const operationBindingMismatch = [
    ["producer action", exactObject(producerAction)],
    ["producer invocation", canonicalEqual(producerInput?.invocation, trustedProducerInvocation)],
    ["producer execution", canonicalEqual(producerInput?.execution, producerBinding.execution)],
    ["producer operation id", producerInput?.operationId === producerBinding.operationId],
    [
      "producer intent path",
      producerInput?.operationIntentPath === producerBinding.operationIntentPath,
    ],
    [
      "producer result path",
      producerInput?.operationResultPath === producerBinding.operationResultPath,
    ],
    ["campaign run", command?.campaignRunId === expectedCoordinate.campaignRunId],
    ["attempt", command?.attemptId === expectedCoordinate.attemptId],
    ["work", command?.workId === expectedCoordinate.workId],
    ["environment", command?.environmentId === expectedCoordinate.environmentId],
    ["path profile", command?.pathProfileId === expectedCoordinate.pathProfileId],
    ["row", command?.rowId === expectedCoordinate.rowId],
    ["variant", command?.variantId === expectedCoordinate.variantId],
    ["work item", workItem?.workId === expectedCoordinate.workId],
    ["execution run", preparedAuthority?.executionRunId === expectedCoordinate.executionRunId],
    ["candidate", preparedAuthority?.candidateSha256 === authority.candidate.candidateSha256],
    [
      "execution bundle",
      preparedAuthority?.executionBundleId === executionReceipt.executionBundleId,
    ],
    [
      "execution bundle manifest",
      preparedAuthority?.executionBundleManifestSha256 ===
        executionReceipt.executionBundleManifestSha256,
    ],
    [
      "run authorization claim",
      preparedAuthority?.runAuthorizationClaimReceiptSha256 ===
        executionReceipt.runAuthorizationClaimReceiptSha256,
    ],
    ["request operation id", request.operation.operationId === producerBinding.operationId],
    ["request operation sequence", request.operation.sequence === trustedProducer.sequence],
    ["runtime intent", executionReceipt.intentSha256 === producerBinding.operationIntentSha256],
    ["receipt execution", canonicalEqual(executionReceipt.execution, producerBinding.execution)],
    [
      "receipt actor",
      canonicalEqual(executionReceipt.expectedActor, producerBinding.expectedActor),
    ],
    ["receipt action", executionReceipt.actionResult.actionId === trustedProducer.actionId],
    ["consumer operation id", plan.operationId === consumerBinding.operationId],
    [
      "evidence root identity",
      plan.evidenceRootObjectIdentitySha256 === preparedAuthority?.evidenceRootObjectIdentitySha256,
    ],
  ].find(([, matches]) => !matches)?.[0];
  if (operationBindingMismatch !== undefined) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      `retained operation request ${operationBindingMismatch} binding differs`,
    );
  }

  const response = verifyControllerResponse(
    parseCanonicalObject(
      retainedRecords.controllerResponse.bytes,
      "retained signed controller response",
    ),
    {
      request,
      controllerIdentitySha256: authority.spool.identitySha256,
      controllerVersion: authority.spool.version,
      controllerPublicKeyBytes: authority.publicKeyBytes,
    },
  );
  const operationResponseBytes = retainedRecords.operationResponse.bytes;
  if (
    response.outcome !== "SUCCEEDED" ||
    response.payload.sha256 !== sha256(operationResponseBytes) ||
    response.payload.bytes !== operationResponseBytes.length ||
    response.payload.blobPath !== `blobs/sha256/${response.payload.sha256}`
  ) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "retained operation response payload differs");
  }
  const operationResponse = decodeControllerOperationResponse(operationResponseBytes, {
    expectedOperationKind: "scenario-action",
    outcome: response.outcome,
    artifacts: response.artifacts,
  });
  const extractedExecutionReceipt = validateProbeControllerActionExecutionReceipt(
    operationResponse.envelope.result,
    evidenceArtifacts,
  );
  if (!canonicalEqual(extractedExecutionReceipt, executionReceipt)) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "retained execution receipt differs from the signed operation response",
    );
  }
  requireExactOrderedReferences(
    operationResponse.envelope.artifactBindings,
    signedArtifacts,
    "retained controller action artifact bindings",
  );
  const expectedPlanReference = Object.freeze({
    path: requestedPlanPath,
    sha256: retainedPlan.sha256,
  });
  const receiptPlanBindings = executionReceipt.nativeActionPlans.filter(
    ({ path }) => path === requestedPlanPath,
  );
  const operationPlanBindings = operationResponse.envelope.artifactBindings.filter(
    ({ path }) => path === requestedPlanPath,
  );
  if (
    receiptPlanBindings.length !== 1 ||
    !canonicalEqual(receiptPlanBindings[0], expectedPlanReference) ||
    operationPlanBindings.length !== 1 ||
    !canonicalEqual(operationPlanBindings[0], expectedPlanReference)
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "signed controller response does not bind the exact native action plan",
    );
  }
  const planReference = response.artifacts.find(
    ({ sha256: digest }) => digest === expectedPlanReference.sha256,
  );
  if (planReference?.bytes !== retainedPlan.size) {
    fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller-bound native action plan size differs");
  }
  const expectedCommitArtifacts = [
    ...Object.values(requiredActionRecords),
    ...signedArtifacts.map(({ path }) => path),
  ].map((path) => {
    const artifact = committedArtifacts.get(path);
    if (artifact === undefined) {
      fail("CONTROLLER_TRANSPORT_PROVENANCE", "controller action commit is incomplete");
    }
    return Object.freeze({ path, bytes: artifact.bytes });
  });
  const expectedCommit = createControllerActionCommitMarker({
    receipt: executionReceipt,
    provenance,
    artifacts: expectedCommitArtifacts,
  });
  if (
    !canonicalEqual(commit, expectedCommit) ||
    !canonicalEqual(producerAction, trustedProducer) ||
    !canonicalEqual(
      producerInput?.execution,
      getProbeActionMapping(trustedProducer.actor, trustedProducer.operation),
    ) ||
    operationResponse.envelope.result?.actionResult?.actionId !== trustedProducer.actionId ||
    plan.producerActionId !== trustedProducer.actionId ||
    plan.consumerActionId !== trustedConsumer.actionId ||
    executionReceipt.producerActionId !== trustedProducer.actionId
  ) {
    fail(
      "CONTROLLER_TRANSPORT_PROVENANCE",
      "controller-bound native action plan belongs to another action or coordinate",
    );
  }
  return Object.freeze({
    plan,
    executionReceipt,
    provenance,
    commit,
    request,
    response,
    operationRequest: operationRequest.envelope,
    operationResponse: operationResponse.envelope,
  });
}

export async function createProbeControllerSpoolTransport(options) {
  assertExactKeys(
    options,
    ["loadedBootstrap", "resolveStore"],
    ["openSpoolStore", "createSpoolClient"],
    "controller spool transport options",
  );
  if (typeof options.resolveStore !== "function") {
    fail("CONTROLLER_TRANSPORT_STORE", "resolveStore must be a function");
  }
  const authority = controllerAuthority(options.loadedBootstrap);
  const openSpoolStore =
    options.openSpoolStore === undefined ? openEvidenceStore : options.openSpoolStore;
  const createSpoolClient =
    options.createSpoolClient === undefined
      ? createControllerSpoolClient
      : options.createSpoolClient;
  if (typeof openSpoolStore !== "function" || typeof createSpoolClient !== "function") {
    fail("CONTROLLER_TRANSPORT_FACTORY", "spool factories must be functions");
  }
  const inboxRoot = win32.join(authority.spool.root, "guest-to-controller");
  const outboxRoot = win32.join(authority.spool.root, "controller-to-guest");
  const inboxStore = requireStore(
    await openSpoolStore({ root: inboxRoot }),
    inboxRoot,
    "guest-to-controller store",
  );
  const outboxStore = requireStore(
    await openSpoolStore({ root: outboxRoot }),
    outboxRoot,
    "controller-to-guest store",
  );
  await inboxStore.assertRootStable();
  await outboxStore.assertRootStable();
  const client = createSpoolClient({
    inboxStore,
    outboxStore,
    controllerIdentitySha256: authority.spool.identitySha256,
    controllerVersion: authority.spool.version,
    controllerPublicKeyBytes: authority.publicKeyBytes,
  });
  if (!exactObject(client) || typeof client.exchange !== "function") {
    fail("CONTROLLER_TRANSPORT_CLIENT", "spool client must expose exchange");
  }

  const attestationByEnvironment = new Map();
  for (const attestation of options.loadedBootstrap.attestations) {
    if (
      typeof attestation?.environmentId !== "string" ||
      attestationByEnvironment.has(attestation.environmentId)
    ) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "bootstrap attestations have invalid environments");
    }
    attestationByEnvironment.set(attestation.environmentId, attestation);
  }
  const workByCoordinate = new Map(
    PROBE_RUN_PLAN.work.map((workItem) => [
      coordinateKey(
        workItem.environmentId,
        workItem.pathProfileId,
        workItem.rowId,
        workItem.variantId,
      ),
      workItem,
    ]),
  );

  async function resolveBoundStore(coordinate, evidenceRoot) {
    if (coordinate.campaignRunId !== authority.bootstrap.campaignRunId) {
      fail("CONTROLLER_TRANSPORT_COORDINATE", "operation belongs to another campaign run");
    }
    const store = requireStore(
      await options.resolveStore({
        campaignRunId: coordinate.campaignRunId,
        environmentId: coordinate.environmentId,
        pathProfileId: coordinate.pathProfileId,
      }),
      evidenceRoot,
      "resolved evidence store",
    );
    await store.assertRootStable();
    return store;
  }

  function requireAttestation(environmentId) {
    const attestation = attestationByEnvironment.get(environmentId);
    if (attestation === undefined) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "operation environment has no attestation");
    }
    return attestation;
  }

  async function readRetainedClaim(store, environmentId) {
    const path = `campaign/run-authorization-claims/${environmentId}.json`;
    const artifact = await store.readArtifact(path);
    const claim = validateProbeRunAuthorizationClaimReceipt(
      parseCanonicalObject(artifact.bytes, "retained run authorization claim"),
    );
    const attestation = requireAttestation(environmentId);
    if (
      artifact.path !== path ||
      artifact.sha256 !== sha256(artifact.bytes) ||
      claim.campaignRunId !== authority.bootstrap.campaignRunId ||
      claim.environmentId !== environmentId ||
      claim.candidateSha256 !== authority.candidate.candidateSha256 ||
      claim.authorizationSha256 !== authority.authorization.authorizationSha256 ||
      claim.labAttestationSha256 !== attestation.attestationSha256 ||
      claim.controllerIdentitySha256 !== authority.spool.identitySha256 ||
      claim.controllerPublicKeySha256 !== authority.spool.publicKeySha256 ||
      claim.controllerVersion !== authority.spool.version
    ) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "retained authorization claim differs from bootstrap");
    }
    return claim.receiptSha256;
  }

  function operationScope(method, payloadInput) {
    if (method === "verifyRunAuthorization" || method === "observeController") {
      return preparationScope(payloadInput);
    }
    if (
      method === "recoverOrAcquireEvidenceQuiescence" ||
      method === "renewEvidenceQuiescence" ||
      method === "captureQuiescedEvidenceSeal" ||
      method === "completeEvidenceQuiescence" ||
      method === "abandonEvidenceQuiescence"
    ) {
      return finalizationScope(payloadInput, workByCoordinate);
    }
    const scoped = requireMatchingWorkScope(payloadInput, method === "invokeScenarioAction");
    const trustedWorkItem = workByCoordinate.get(
      coordinateKey(
        scoped.coordinate.environmentId,
        scoped.coordinate.pathProfileId,
        scoped.coordinate.rowId,
        scoped.coordinate.variantId,
      ),
    );
    if (trustedWorkItem === undefined || !canonicalEqual(payloadInput.workItem, trustedWorkItem)) {
      fail(
        "CONTROLLER_TRANSPORT_COORDINATE",
        "runtime work scope differs from the frozen run plan",
      );
    }
    return scoped;
  }

  async function trustScenarioActionInput(unsafeInput, label) {
    const input = snapshotControllerOperationInput(unsafeInput, label);
    if (
      !exactObject(input) ||
      !exactObject(input.command) ||
      !exactObject(input.workItem) ||
      !exactObject(input.invocation) ||
      !exactObject(input.preparedContext)
    ) {
      fail("CONTROLLER_TRANSPORT_SCENARIO", "scenario invocation is incomplete");
    }
    const preparedContext = validatePreparedProbeContext(input.preparedContext);
    const { evidenceRoot, payloadInput } = stripEvidenceRoot(input);
    const scoped = operationScope("invokeScenarioAction", payloadInput);
    const coordinate = scoped.coordinate;
    const attestation = requireAttestation(coordinate.environmentId);
    if (
      preparedContext.campaignRunId !== authority.bootstrap.campaignRunId ||
      preparedContext.candidateSha256 !== authority.candidate.candidateSha256 ||
      preparedContext.runPlanSha256 !== authority.bootstrap.runPlanSha256 ||
      preparedContext.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
      preparedContext.runAuthorizationSha256 !== authority.authorization.authorizationSha256 ||
      preparedContext.runAuthorizationClaimReceiptSha256 !== scoped.claimSha256 ||
      preparedContext.labAttestationSha256 !== attestation.attestationSha256 ||
      preparedContext.executionBundleManifest.controller.identitySha256 !==
        authority.spool.identitySha256 ||
      preparedContext.executionBundleManifest.controller.publicKeySha256 !==
        authority.spool.publicKeySha256 ||
      preparedContext.executionBundleManifest.controller.version !== authority.spool.version ||
      !canonicalEqual(
        preparedContext.controllerPublicKeyArtifact,
        attestation.controller.publicKeyArtifact,
      )
    ) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        "scenario prepared context differs from bootstrap authority",
      );
    }

    let definition;
    try {
      definition = getProbeScenarioDefinition(coordinate.rowId, coordinate.variantId);
    } catch {
      fail("CONTROLLER_TRANSPORT_SCENARIO", "scenario invocation has no trusted definition");
    }
    const actionId = input.invocation?.action?.actionId;
    const action = definition.actions.find(({ actionId: id }) => id === actionId);
    const invocation =
      action === undefined
        ? null
        : {
            schemaVersion: 1,
            kind: "windows-host-probe-scenario-action-invocation",
            rowId: definition.rowId,
            variantId: definition.variantId,
            planSha256: definition.planSha256,
            action,
          };
    if (
      invocation === null ||
      action.actor !== "external-controller" ||
      !canonicalEqual(input.invocation, invocation)
    ) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        "scenario invocation differs from the trusted scenario definition",
      );
    }
    const runtimeActionBinding = createProbeRuntimeActionBinding({
      command: input.command,
      invocation,
      preparedContext,
    });
    if (
      !exactObject(input.execution) ||
      !canonicalEqual(input.execution, runtimeActionBinding.execution) ||
      input.operationId !== runtimeActionBinding.operationId ||
      input.operationIntentPath !== runtimeActionBinding.operationIntentPath ||
      input.operationResultPath !== runtimeActionBinding.operationResultPath
    ) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        "scenario execution identity differs from the independently derived runtime binding",
      );
    }
    validateEvidenceRelativePath(runtimeActionBinding.operationIntentPath);
    validateEvidenceRelativePath(runtimeActionBinding.operationResultPath);
    const operation = Object.freeze({
      operationId: runtimeActionBinding.operationId,
      kind: "scenario-action",
      sequence: action.sequence,
    });
    const store = await resolveBoundStore(coordinate, evidenceRoot);
    let retainedIntent;
    try {
      await assertUniqueRetainedPath(
        store,
        runtimeActionBinding.operationIntentPath,
        "runtime action intent",
      );
      const artifact = await readRetainedArtifact(
        store,
        runtimeActionBinding.operationIntentPath,
        null,
        "runtime action intent",
      );
      retainedIntent = parseCanonicalObject(artifact.bytes, "runtime action intent");
    } catch {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        "runtime action intent is not retained exactly before controller verification",
      );
    }
    if (!canonicalEqual(retainedIntent, runtimeActionBinding.intent)) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        "runtime action intent differs from the canonical controller binding",
      );
    }
    return Object.freeze({
      authority,
      input,
      payloadInput,
      evidenceRoot,
      store,
      preparedContext,
      definition,
      action,
      invocation,
      runtimeActionBinding,
      coordinate,
      operation,
    });
  }

  async function trustHardCutReceiptInput(unsafeInput, label) {
    const input = snapshotControllerOperationInput(unsafeInput, label);
    if (
      !exactObject(input.command) ||
      !exactObject(input.workItem) ||
      !exactObject(input.preparedContext) ||
      !exactObject(input.attestation) ||
      !exactObject(input.request)
    ) {
      fail("CONTROLLER_TRANSPORT_HARD_CUT", "hard-cut receipt input is incomplete");
    }
    const preparedContext = validatePreparedProbeContext(input.preparedContext);
    const { evidenceRoot, payloadInput } = stripEvidenceRoot(input);
    const scoped = operationScope("readHardCutReceipt", payloadInput);
    const repetition = input.command.repetition;
    if (!Number.isSafeInteger(repetition) || repetition < 1) {
      fail("CONTROLLER_TRANSPORT_HARD_CUT", "hard-cut repetition is invalid");
    }
    const coordinate = Object.freeze({ ...scoped.coordinate, repetition });
    const attestation = requireAttestation(coordinate.environmentId);
    if (
      !canonicalEqual(input.attestation, attestation) ||
      preparedContext.campaignRunId !== authority.bootstrap.campaignRunId ||
      preparedContext.candidateSha256 !== authority.candidate.candidateSha256 ||
      preparedContext.runPlanSha256 !== authority.bootstrap.runPlanSha256 ||
      preparedContext.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
      preparedContext.runAuthorizationSha256 !== authority.authorization.authorizationSha256 ||
      preparedContext.runAuthorizationClaimReceiptSha256 !== scoped.claimSha256 ||
      preparedContext.labAttestationSha256 !== attestation.attestationSha256 ||
      preparedContext.executionBundleManifest.controller.identitySha256 !==
        authority.spool.identitySha256 ||
      preparedContext.executionBundleManifest.controller.publicKeySha256 !==
        authority.spool.publicKeySha256 ||
      preparedContext.executionBundleManifest.controller.version !== authority.spool.version ||
      !canonicalEqual(
        preparedContext.controllerPublicKeyArtifact,
        attestation.controller.publicKeyArtifact,
      )
    ) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT",
        "hard-cut prepared context differs from bootstrap authority",
      );
    }

    let definition;
    try {
      definition = getProbeScenarioDefinition(coordinate.rowId, coordinate.variantId);
    } catch {
      fail("CONTROLLER_TRANSPORT_HARD_CUT", "hard-cut input has no trusted scenario definition");
    }
    const actionId = `hard-cut-guest-r${repetition}`;
    const action = definition.actions.find(({ actionId: id }) => id === actionId);
    if (
      definition.continuation.kind !== "external-hard-cut" ||
      action?.actor !== "external-controller" ||
      action.operation !== "hard-cut-guest" ||
      action.parameters?.repetition !== repetition ||
      action.parameters?.checkpoint !== definition.continuation.checkpoint
    ) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT",
        "hard-cut action differs from the frozen scenario definition",
      );
    }
    const invocation = Object.freeze({
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action,
    });
    const runtimeActionBinding = createProbeRuntimeActionBinding({
      command: input.command,
      invocation,
      preparedContext,
    });
    validateEvidenceRelativePath(runtimeActionBinding.operationIntentPath);
    validateEvidenceRelativePath(runtimeActionBinding.operationResultPath);
    const operation = Object.freeze({
      operationId: runtimeActionBinding.operationId,
      kind: "scenario-action",
      sequence: action.sequence,
    });
    const outerOperation = Object.freeze({
      operationId: deterministicOperationId(
        authority,
        coordinate,
        operationKindsByMethod.readHardCutReceipt,
        repetition,
      ),
      kind: operationKindsByMethod.readHardCutReceipt,
      sequence: repetition,
    });
    const store = await resolveBoundStore(coordinate, evidenceRoot);
    const scenarioInput = Object.freeze({
      ...input,
      invocation,
      execution: runtimeActionBinding.execution,
      operationId: runtimeActionBinding.operationId,
      operationIntentPath: runtimeActionBinding.operationIntentPath,
      operationResultPath: runtimeActionBinding.operationResultPath,
    });
    return Object.freeze({
      authority,
      input,
      payloadInput,
      evidenceRoot,
      store,
      preparedContext,
      attestation,
      definition,
      action,
      invocation,
      scenarioInput,
      runtimeActionBinding,
      coordinate,
      operation,
      outerOperation,
    });
  }

  async function exchangeOperation(method, unsafeInput) {
    const suppliedInput = snapshotControllerOperationInput(
      unsafeInput,
      `${method} controller operation input`,
    );
    const operationKind = operationKindsByMethod[method];
    const { evidenceRoot, payloadInput } = stripEvidenceRoot(suppliedInput);
    const controllerPayloadInput = projectControllerOperationPayload(
      payloadInput,
      `${method} controller operation input`,
    );
    const runtimeActionBinding =
      method === "invokeScenarioAction"
        ? createProbeRuntimeActionBinding({
            command: suppliedInput.command,
            invocation: suppliedInput.invocation,
            preparedContext: suppliedInput.preparedContext,
          })
        : null;
    const scoped = operationScope(method, payloadInput);
    const coordinate = {
      ...scoped.coordinate,
      repetition:
        method === "claimHardCutRequest" || method === "readHardCutReceipt"
          ? suppliedInput.command.repetition
          : scoped.coordinate.repetition,
    };
    const store = await resolveBoundStore(coordinate, evidenceRoot);
    if (runtimeActionBinding !== null) {
      let retainedIntent;
      try {
        const artifact = await readRetainedArtifact(
          store,
          runtimeActionBinding.operationIntentPath,
          null,
          "runtime action intent",
        );
        retainedIntent = parseCanonicalObject(artifact.bytes, "runtime action intent");
      } catch {
        fail(
          "CONTROLLER_TRANSPORT_SCENARIO",
          "runtime action intent is not retained exactly before controller exchange",
        );
      }
      if (!canonicalEqual(retainedIntent, runtimeActionBinding.intent)) {
        fail(
          "CONTROLLER_TRANSPORT_SCENARIO",
          "runtime action intent differs from the canonical controller binding",
        );
      }
    }
    const runAuthorizationClaimSha256 =
      method === "verifyRunAuthorization"
        ? null
        : method === "observeController"
          ? await readRetainedClaim(store, coordinate.environmentId)
          : scoped.claimSha256;
    const encoded = encodeControllerOperationRequest({
      operationKind,
      input: controllerPayloadInput,
    });
    const sequence = operationSequence(method, suppliedInput);
    const operationId =
      runtimeActionBinding !== null
        ? runtimeActionBinding.operationId
        : deterministicOperationId(authority, coordinate, operationKind, sequence);
    const payloadSha256 = sha256(encoded.bytes);
    const draft = {
      schemaVersion: CONTROLLER_PROTOCOL_SCHEMA_VERSION,
      kind: CONTROLLER_REQUEST_KIND,
      campaignId: PROBE_CAMPAIGN_ID,
      manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
      candidateSha256: authority.candidate.candidateSha256,
      runPlanSha256: PROBE_RUN_PLAN_SHA256,
      runAuthorizationSha256: authority.authorization.authorizationSha256,
      runAuthorizationClaimSha256,
      coordinate,
      operation: { operationId, kind: operationKind, sequence },
      intentSha256: encoded.intentSha256,
      payload: {
        blobPath: `blobs/sha256/${payloadSha256}`,
        bytes: encoded.bytes.length,
        sha256: payloadSha256,
      },
      controllerIdentitySha256: authority.spool.identitySha256,
    };
    const request = validateControllerRequest({
      ...draft,
      requestSha256: deriveControllerRequestDigest(draft),
    });
    const exchange = await client.exchange({ request, payloadBytes: encoded.bytes });
    const response = verifyControllerResponse(exchange?.response, {
      request,
      controllerIdentitySha256: authority.spool.identitySha256,
      controllerVersion: authority.spool.version,
      controllerPublicKeyBytes: authority.publicKeyBytes,
    });
    const responsePayload = Buffer.from(exchange?.payloadBytes ?? []);
    if (
      response.payload.sha256 !== sha256(responsePayload) ||
      response.payload.bytes !== responsePayload.length ||
      response.payload.blobPath !== `blobs/sha256/${response.payload.sha256}`
    ) {
      fail("CONTROLLER_TRANSPORT_RESPONSE", "controller response payload bytes differ");
    }
    const artifactsBySha256 = validateExchangeArtifacts(exchange, response);
    const decoded = decodeControllerOperationResponse(responsePayload, {
      expectedOperationKind: operationKind,
      outcome: response.outcome,
      artifacts: response.artifacts,
    });
    return Object.freeze({
      method,
      operationId,
      store,
      suppliedInput,
      controllerPayloadInput,
      request,
      requestPayload: Buffer.from(encoded.bytes),
      response,
      responsePayload: Buffer.from(responsePayload),
      result: decoded.envelope.result,
      bindings: decoded.envelope.artifactBindings,
      artifactsBySha256,
    });
  }

  function validateScenarioControllerRequest(request, operationRequestBytes, trusted) {
    const operationRequest = decodeControllerOperationRequest(operationRequestBytes, {
      expectedOperationKind: "scenario-action",
    });
    if (
      request.campaignId !== PROBE_CAMPAIGN_ID ||
      request.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
      request.candidateSha256 !== authority.candidate.candidateSha256 ||
      request.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
      request.runAuthorizationSha256 !== authority.authorization.authorizationSha256 ||
      request.runAuthorizationClaimSha256 !==
        trusted.preparedContext.runAuthorizationClaimReceiptSha256 ||
      request.controllerIdentitySha256 !== authority.spool.identitySha256 ||
      !canonicalEqual(request.coordinate, trusted.coordinate) ||
      !canonicalEqual(request.operation, trusted.operation) ||
      request.payload.sha256 !== sha256(operationRequestBytes) ||
      request.payload.bytes !== operationRequestBytes.length ||
      request.payload.blobPath !== `blobs/sha256/${request.payload.sha256}` ||
      request.intentSha256 !== operationRequest.intentSha256 ||
      !canonicalEqual(
        operationRequest.envelope.input,
        projectControllerOperationPayload(
          trusted.payloadInput,
          "trusted scenario controller operation input",
        ),
      )
    ) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO_REQUEST",
        "signed scenario controller request differs from trusted runtime input",
      );
    }
    return operationRequest.envelope;
  }

  function validateHardCutControllerRequest(request, operationRequestBytes, trusted) {
    const operationRequest = decodeControllerOperationRequest(operationRequestBytes, {
      expectedOperationKind: operationKindsByMethod.readHardCutReceipt,
    });
    if (
      request.campaignId !== PROBE_CAMPAIGN_ID ||
      request.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
      request.candidateSha256 !== authority.candidate.candidateSha256 ||
      request.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
      request.runAuthorizationSha256 !== authority.authorization.authorizationSha256 ||
      request.runAuthorizationClaimSha256 !==
        trusted.preparedContext.runAuthorizationClaimReceiptSha256 ||
      request.controllerIdentitySha256 !== authority.spool.identitySha256 ||
      !canonicalEqual(request.coordinate, trusted.coordinate) ||
      !canonicalEqual(request.operation, trusted.outerOperation) ||
      request.payload.sha256 !== sha256(operationRequestBytes) ||
      request.payload.bytes !== operationRequestBytes.length ||
      request.payload.blobPath !== `blobs/sha256/${request.payload.sha256}` ||
      request.intentSha256 !== operationRequest.intentSha256 ||
      !canonicalEqual(
        operationRequest.envelope.input,
        projectControllerOperationPayload(
          trusted.payloadInput,
          "trusted hard-cut controller operation input",
        ),
      )
    ) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_REQUEST",
        "signed hard-cut controller request differs from trusted runtime input",
      );
    }
    return operationRequest.envelope;
  }

  function validateHardCutCheckpointEvidence(value, trusted) {
    const checkpointEvidence = snapshotControllerOperationInput(
      value,
      "hard-cut checkpoint evidence",
    );
    assertExactKeys(checkpointEvidence, ["request", "receipt"], [], "hard-cut checkpoint evidence");
    assertExactKeys(
      checkpointEvidence.request,
      hardCutCheckpointRequestKeys,
      [],
      "hard-cut checkpoint request",
    );
    assertExactKeys(
      checkpointEvidence.receipt,
      hardCutCheckpointReceiptKeys,
      [],
      "hard-cut checkpoint receipt",
    );
    if (!canonicalEqual(checkpointEvidence.request, trusted.input.request)) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_CHECKPOINT",
        "hard-cut checkpoint evidence answers another request",
      );
    }
    const request = checkpointEvidence.request;
    const expectedRequest = {
      campaignId: PROBE_CAMPAIGN_ID,
      manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
      candidateSha256: authority.candidate.candidateSha256,
      campaignRunId: trusted.coordinate.campaignRunId,
      executionRunId: trusted.coordinate.executionRunId,
      executionBundleId: trusted.preparedContext.executionBundleId,
      executionBundleManifestSha256: trusted.preparedContext.executionBundleManifestSha256,
      attemptId: trusted.coordinate.attemptId,
      environmentId: trusted.coordinate.environmentId,
      pathProfileId: trusted.coordinate.pathProfileId,
      rowId: trusted.coordinate.rowId,
      variantId: trusted.coordinate.variantId,
      checkpointId: trusted.action.parameters.checkpoint,
      sequence: trusted.coordinate.repetition,
      sourceVmSnapshotId: trusted.preparedContext.vmSnapshotId,
      controllerIdentitySha256: authority.spool.identitySha256,
      controllerPublicKeySha256: authority.spool.publicKeySha256,
      controllerVersion: authority.spool.version,
      action: "hard-power-cut",
    };
    if (Object.entries(expectedRequest).some(([key, expected]) => request[key] !== expected)) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_CHECKPOINT",
        "hard-cut checkpoint request differs from the frozen action authority",
      );
    }
    validateExternalCheckpointEvidence(checkpointEvidence, {
      segment: {
        campaignId: PROBE_CAMPAIGN_ID,
        manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
        candidateSha256: authority.candidate.candidateSha256,
        environmentId: trusted.coordinate.environmentId,
        pathProfileId: trusted.coordinate.pathProfileId,
        rowId: trusted.coordinate.rowId,
        variantId: trusted.coordinate.variantId,
        provenance: {
          campaignRunId: trusted.coordinate.campaignRunId,
          executionRunId: trusted.coordinate.executionRunId,
          executionBundleId: trusted.preparedContext.executionBundleId,
          executionBundleManifestSha256: trusted.preparedContext.executionBundleManifestSha256,
          attemptId: trusted.coordinate.attemptId,
          vmSnapshotId: trusted.preparedContext.vmSnapshotId,
        },
      },
      continuation: {
        scopeSha256: request.continuationScopeSha256,
        receiptSha256: checkpointEvidence.receipt.receiptSha256,
      },
      repetition: trusted.coordinate.repetition,
      replayRegistry: createExternalCheckpointReplayRegistry(),
      expectedController: trusted.attestation.controller,
      controllerPublicKeyBytes: authority.publicKeyBytes,
      expectedPreCutBootIdSha256: request.preCutBootIdSha256,
    });
    return checkpointEvidence;
  }

  function validateSignedActionMaterials(exchanged, trusted, receiptValue, inputForPlans, label) {
    const receiptStructure = validateScenarioActionReceiptBinding(receiptValue, trusted);
    const signedArtifacts = collectProbeControllerActionSignedArtifacts(receiptStructure);
    requireExactOrderedReferences(
      exchanged.bindings,
      signedArtifacts,
      `${label} artifact bindings`,
    );
    const evidenceArtifacts = signedArtifacts.map((reference) => {
      const bytes = exchanged.artifactsBySha256.get(reference.sha256);
      if (bytes === undefined) {
        fail(
          "CONTROLLER_TRANSPORT_ARTIFACT",
          `${label} signed artifact has no exact controller bytes`,
        );
      }
      return Object.freeze({ path: reference.path, bytes: Buffer.from(bytes) });
    });
    const verifiedEvidence = validateProbeControllerActionExecutionEvidence({
      receipt: receiptStructure,
      artifacts: evidenceArtifacts,
    });
    const receipt = verifiedEvidence.receipt;
    validateScenarioObserverTranscripts(
      receipt,
      exchanged.artifactsBySha256,
      trusted.preparedContext,
    );
    const planMaterials = validateControllerProducedNativeActionPlans(
      exchanged,
      inputForPlans,
      trusted.action.actionId,
    );
    requireExactOrderedReferences(
      receipt.nativeActionPlans,
      planMaterials.map(({ binding }) => binding),
      `${label} native plan materials`,
    );
    const resultBytes = exchanged.artifactsBySha256.get(receipt.actionResultArtifact.sha256);
    const expectedResultBytes = Buffer.from(canonicalProbeJson(receipt.actionResult), "utf8");
    if (resultBytes === undefined || !Buffer.from(resultBytes).equals(expectedResultBytes)) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO",
        `${label} result artifact is not exact canonical result`,
      );
    }
    const recordBytes = Object.freeze({
      controllerRequest: Buffer.from(canonicalProbeJson(exchanged.request), "utf8"),
      operationRequest: Buffer.from(exchanged.requestPayload),
      controllerResponse: Buffer.from(canonicalProbeJson(exchanged.response), "utf8"),
      operationResponse: Buffer.from(exchanged.responsePayload),
    });
    const records = Object.freeze(
      Object.fromEntries(
        Object.entries(recordBytes).map(([key, bytes]) => [key, retainedRecordInput(bytes)]),
      ),
    );
    const provenance = createProbeControllerActionProvenance({
      receipt,
      records,
      artifacts: evidenceArtifacts,
    });
    return Object.freeze({
      receipt,
      signedArtifacts,
      evidenceArtifacts,
      verifiedEvidence,
      planMaterials,
      resultBytes: Buffer.from(resultBytes),
      recordBytes,
      records,
      provenance,
    });
  }

  function validateScenarioSignedMaterials(exchanged, trusted) {
    if (exchanged.response.outcome !== "SUCCEEDED") {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO_RECEIPT",
        "scenario action did not return a successful signed receipt",
      );
    }
    validateScenarioControllerRequest(exchanged.request, exchanged.requestPayload, trusted);
    return validateSignedActionMaterials(
      exchanged,
      trusted,
      exchanged.result,
      trusted.input,
      "scenario action",
    );
  }

  function validateHardCutSignedMaterials(exchanged, trusted) {
    if (exchanged.response.outcome !== "SUCCEEDED") {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_RECEIPT",
        "hard-cut read did not return a successful signed receipt",
      );
    }
    validateHardCutControllerRequest(exchanged.request, exchanged.requestPayload, trusted);
    assertExactKeys(
      exchanged.result,
      ["checkpointEvidence", "actionExecutionReceipt"],
      [],
      "hard-cut signed result",
    );
    const checkpointEvidence = validateHardCutCheckpointEvidence(
      exchanged.result.checkpointEvidence,
      trusted,
    );
    const validated = validateSignedActionMaterials(
      exchanged,
      trusted,
      exchanged.result.actionExecutionReceipt,
      trusted.scenarioInput,
      "hard-cut action",
    );
    if (
      !canonicalEqual(
        validated.receipt.proofArtifacts,
        checkpointEvidence.receipt.artifactHashes,
      ) ||
      !canonicalEqual(
        validated.receipt.actionResult.evidenceArtifacts,
        checkpointEvidence.receipt.artifactHashes,
      )
    ) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_CHECKPOINT",
        "hard-cut action proof set differs from the signed checkpoint receipt",
      );
    }
    return Object.freeze({
      ...validated,
      checkpointEvidence,
      actionExecutionReceipt: validated.receipt,
    });
  }

  async function readCompleteControllerActionCommit(trusted, paths, label) {
    const retained = await readControllerActionCommitMarker(
      trusted.store,
      `${paths.stem}.commit.json`,
      `${label} commit marker`,
    );
    const commit = retained.marker;
    if (
      commit.candidateSha256 !== authority.candidate.candidateSha256 ||
      commit.producerActionId !== trusted.action.actionId ||
      !canonicalEqual(commit.coordinate, trusted.coordinate)
    ) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        `${label} commit marker belongs to another action or coordinate`,
      );
    }
    const artifacts = await verifyControllerActionCommitArtifacts(
      trusted.store,
      commit,
      `${label} commit marker`,
    );
    return Object.freeze({ commit, artifacts });
  }

  function validateCompleteControllerActionCommit(complete, paths, validated, label) {
    const requiredPaths = [
      paths.provenance,
      paths.receipt,
      paths.controllerRequest,
      paths.operationRequest,
      paths.controllerResponse,
      paths.operationResponse,
      ...validated.signedArtifacts.map(({ path }) => path),
    ];
    const artifacts = requiredPaths.map((path) => {
      const retained = complete.artifacts.get(path);
      if (retained === undefined) {
        fail("CONTROLLER_TRANSPORT_PROVENANCE", `${label} commit marker is incomplete`);
      }
      return Object.freeze({ path, bytes: retained.bytes });
    });
    const expected = createControllerActionCommitMarker({
      receipt: validated.receipt,
      provenance: validated.provenance,
      artifacts,
    });
    if (!canonicalEqual(complete.commit, expected)) {
      fail(
        "CONTROLLER_TRANSPORT_PROVENANCE",
        `${label} commit marker differs from the complete signed action`,
      );
    }
    return expected;
  }

  async function retainScenarioSignedMaterials(exchanged, trusted, validated) {
    const resultReference = validated.receipt.actionResultArtifact;
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: trusted.coordinate.campaignRunId,
      attemptId: trusted.coordinate.attemptId,
      workId: trusted.coordinate.workId,
      producerActionId: trusted.action.actionId,
    });
    const receiptBytes = Buffer.from(canonicalProbeJson(validated.receipt), "utf8");
    const provenanceBytes = Buffer.from(canonicalProbeJson(validated.provenance), "utf8");
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: trusted.coordinate.campaignRunId,
      attemptId: trusted.coordinate.attemptId,
      workId: trusted.coordinate.workId,
      producerActionId: trusted.action.actionId,
    });
    const signedArtifactMaterials = validated.signedArtifacts.map((reference) => {
      const bytes = exchanged.artifactsBySha256.get(reference.sha256);
      if (bytes === undefined) {
        fail(
          "CONTROLLER_TRANSPORT_ARTIFACT",
          "scenario signed artifact has no exact controller bytes",
        );
      }
      return Object.freeze({ path: reference.path, bytes: Buffer.from(bytes) });
    });
    const actionRecordMaterials = [
      { path: paths.provenance, bytes: provenanceBytes },
      { path: paths.receipt, bytes: receiptBytes },
      ...["controllerRequest", "operationRequest", "controllerResponse", "operationResponse"].map(
        (key) => ({
          path: validated.provenance.records[key].path,
          bytes: validated.recordBytes[key],
        }),
      ),
    ];
    const commit = createControllerActionCommitMarker({
      receipt: validated.receipt,
      provenance: validated.provenance,
      artifacts: [...actionRecordMaterials, ...signedArtifactMaterials],
    });
    const commitBytes = Buffer.from(canonicalProbeJson(commit), "utf8");
    await assertPublishableExactPath(
      trusted.store,
      paths.provenance,
      provenanceBytes,
      sha256(provenanceBytes),
      "scenario action provenance",
    );
    await assertPublishableExactPath(
      trusted.store,
      resultReference.path,
      validated.resultBytes,
      resultReference.sha256,
      "scenario result",
    );
    await assertPublishableExactPath(
      trusted.store,
      commitPath,
      commitBytes,
      sha256(commitBytes),
      "scenario action commit marker",
    );
    const nativePlanKeys = new Set(
      validated.receipt.nativeActionPlans.map(({ path, sha256: digest }) => `${path}\0${digest}`),
    );
    const proofAndObserverArtifacts = validated.signedArtifacts.filter(
      ({ path, sha256: digest }) =>
        (path !== resultReference.path || digest !== resultReference.sha256) &&
        !nativePlanKeys.has(`${path}\0${digest}`),
    );
    await retainReferences(
      trusted.store,
      proofAndObserverArtifacts,
      exchanged.artifactsBySha256,
      "scenario signed artifact",
    );

    for (const key of [
      "controllerRequest",
      "operationRequest",
      "controllerResponse",
      "operationResponse",
    ]) {
      const record = validated.provenance.records[key];
      await retainExactBytes(
        trusted.store,
        record.path,
        validated.recordBytes[key],
        record.sha256,
        `scenario action ${key}`,
      );
    }
    await retainExactBytes(
      trusted.store,
      paths.receipt,
      receiptBytes,
      sha256(receiptBytes),
      "scenario action execution receipt",
    );
    await retainExactBytes(
      trusted.store,
      paths.provenance,
      provenanceBytes,
      sha256(provenanceBytes),
      "scenario action provenance",
    );
    for (const planMaterial of validated.planMaterials) {
      await retainControllerNativeActionPlan({ store: trusted.store, planMaterial });
    }
    await retainExactBytes(
      trusted.store,
      resultReference.path,
      validated.resultBytes,
      resultReference.sha256,
      "scenario result",
    );
    await retainExactBytes(
      trusted.store,
      commitPath,
      commitBytes,
      sha256(commitBytes),
      "scenario action commit marker",
    );
  }

  async function assertHardCutSignedMaterialsPublishable(exchanged, trusted, validated) {
    if (validated.planMaterials.length !== 0) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_RECEIPT",
        "the frozen hard-cut action cannot publish native action plans",
      );
    }
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: trusted.coordinate.campaignRunId,
      attemptId: trusted.coordinate.attemptId,
      workId: trusted.coordinate.workId,
      producerActionId: trusted.action.actionId,
    });
    const receiptBytes = Buffer.from(canonicalProbeJson(validated.receipt), "utf8");
    const provenanceBytes = Buffer.from(canonicalProbeJson(validated.provenance), "utf8");
    const targets = new Map();
    for (const reference of validated.signedArtifacts) {
      const bytes = exchanged.artifactsBySha256.get(reference.sha256);
      if (bytes === undefined) {
        fail(
          "CONTROLLER_TRANSPORT_ARTIFACT",
          "hard-cut signed artifact has no exact controller bytes",
        );
      }
      targets.set(reference.path, {
        bytes: Buffer.from(bytes),
        sha256: reference.sha256,
        label: "hard-cut signed artifact",
      });
    }
    for (const key of [
      "controllerRequest",
      "operationRequest",
      "controllerResponse",
      "operationResponse",
    ]) {
      const record = validated.provenance.records[key];
      targets.set(record.path, {
        bytes: validated.recordBytes[key],
        sha256: record.sha256,
        label: `hard-cut action ${key}`,
      });
    }
    targets.set(paths.receipt, {
      bytes: receiptBytes,
      sha256: sha256(receiptBytes),
      label: "hard-cut action execution receipt",
    });
    targets.set(paths.provenance, {
      bytes: provenanceBytes,
      sha256: sha256(provenanceBytes),
      label: "hard-cut action provenance",
    });
    for (const [path, target] of targets) {
      await assertPublishableExactPath(
        trusted.store,
        path,
        target.bytes,
        target.sha256,
        target.label,
      );
    }
  }

  async function verifyRunAuthorization(unsafeInput) {
    const input = snapshotControllerOperationInput(
      unsafeInput,
      "verifyRunAuthorization controller operation input",
    );
    const attestation = requireAttestation(input.request.environmentId);
    if (
      input.runAuthorization?.authorizationSha256 !== authority.authorization.authorizationSha256 ||
      input.candidateSha256 !== authority.candidate.candidateSha256 ||
      input.campaignRunId !== authority.bootstrap.campaignRunId ||
      input.currentAttestation?.attestationSha256 !== attestation.attestationSha256 ||
      input.currentAttestation?.controller?.publicKeyArtifact?.path !==
        attestation.controller.publicKeyArtifact.path ||
      input.currentAttestation?.controller?.publicKeyArtifact?.sha256 !==
        authority.spool.publicKeySha256
    ) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "authorization attestation differs from bootstrap");
    }
    const exchanged = await exchangeOperation("verifyRunAuthorization", input);
    requireNoBindings(exchanged.bindings, "verifyRunAuthorization");
    await retainExactBytes(
      exchanged.store,
      attestation.controller.publicKeyArtifact.path,
      authority.publicKeyBytes,
      authority.spool.publicKeySha256,
      "controller public key",
    );
    return exchanged.result;
  }

  async function observeController(unsafeInput) {
    const input = snapshotControllerOperationInput(
      unsafeInput,
      "observeController controller operation input",
    );
    const exchanged = await exchangeOperation("observeController", input);
    const result = exchanged.result;
    const attestation = requireAttestation(input.request.environmentId);
    if (
      result?.identitySha256 !== authority.spool.identitySha256 ||
      result?.publicKeySha256 !== authority.spool.publicKeySha256 ||
      result?.version !== authority.spool.version ||
      !canonicalEqual(result?.controllerEvidence, attestation.controllerEvidence) ||
      !canonicalEqual(result?.publicKeyArtifact, attestation.controller.publicKeyArtifact)
    ) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "controller observation differs from attestation");
    }
    requireExactReferenceSet(
      exchanged.bindings,
      [result.controllerEvidence, result.publicKeyArtifact],
      "controller observation artifacts",
    );
    const keyBytes = exchanged.artifactsBySha256.get(result.publicKeyArtifact.sha256);
    if (keyBytes === undefined || !Buffer.from(keyBytes).equals(authority.publicKeyBytes)) {
      fail("CONTROLLER_TRANSPORT_AUTHORITY", "observed controller key differs from bootstrap");
    }
    await retainBindings(
      exchanged.store,
      exchanged.bindings,
      exchanged.artifactsBySha256,
      "controller observation artifact",
    );
    return result;
  }

  async function verifyScenarioActionReceipt(unsafeInput) {
    const trusted = await trustScenarioActionInput(
      unsafeInput,
      "verifyScenarioActionReceipt controller operation input",
    );
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: trusted.coordinate.campaignRunId,
      attemptId: trusted.coordinate.attemptId,
      workId: trusted.coordinate.workId,
      producerActionId: trusted.action.actionId,
    });
    const complete = await readCompleteControllerActionCommit(trusted, paths, "scenario action");
    const deterministicPaths = {
      provenance: paths.provenance,
      receipt: paths.receipt,
      controllerRequest: paths.controllerRequest,
      operationRequest: paths.operationRequest,
      controllerResponse: paths.controllerResponse,
      operationResponse: paths.operationResponse,
    };
    const retained = {};
    for (const [key, path] of Object.entries(deterministicPaths)) {
      await assertUniqueRetainedPath(trusted.store, path, `scenario action ${key}`);
      retained[key] = await readRetainedArtifact(
        trusted.store,
        path,
        null,
        `scenario action ${key}`,
      );
    }

    const retainedReceipt = validateScenarioActionReceiptBinding(
      parseCanonicalObject(retained.receipt.bytes, "retained scenario action receipt"),
      trusted,
    );
    const request = validateControllerRequest(
      parseCanonicalObject(retained.controllerRequest.bytes, "retained controller request"),
    );
    validateScenarioControllerRequest(request, retained.operationRequest.bytes, trusted);
    const response = verifyControllerResponse(
      parseCanonicalObject(
        retained.controllerResponse.bytes,
        "retained signed controller response",
      ),
      {
        request,
        controllerIdentitySha256: authority.spool.identitySha256,
        controllerVersion: authority.spool.version,
        controllerPublicKeyBytes: authority.publicKeyBytes,
      },
    );
    if (
      response.outcome !== "SUCCEEDED" ||
      response.payload.sha256 !== retained.operationResponse.sha256 ||
      response.payload.bytes !== retained.operationResponse.size ||
      response.payload.blobPath !== `blobs/sha256/${response.payload.sha256}`
    ) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO_RESPONSE",
        "retained signed controller response payload differs",
      );
    }
    const operationResponse = decodeControllerOperationResponse(retained.operationResponse.bytes, {
      expectedOperationKind: "scenario-action",
      outcome: response.outcome,
      artifacts: response.artifacts,
    });
    const responseReceipt = validateScenarioActionReceiptBinding(
      operationResponse.envelope.result,
      trusted,
    );
    if (!canonicalEqual(responseReceipt, retainedReceipt)) {
      fail(
        "CONTROLLER_TRANSPORT_SCENARIO_RECEIPT",
        "retained execution receipt differs from the signed operation response",
      );
    }
    const signedArtifacts = collectProbeControllerActionSignedArtifacts(responseReceipt);
    requireExactOrderedReferences(
      operationResponse.envelope.artifactBindings,
      signedArtifacts,
      "retained scenario action artifact bindings",
    );
    const responseArtifactsBySha256 = new Map(
      response.artifacts.map((reference) => [reference.sha256, reference]),
    );
    const artifactsBySha256 = new Map();
    for (const [index, reference] of signedArtifacts.entries()) {
      await assertUniqueRetainedPath(
        trusted.store,
        reference.path,
        `scenario signed artifact[${index}]`,
      );
      const signedReference = responseArtifactsBySha256.get(reference.sha256);
      if (
        signedReference === undefined ||
        signedReference.blobPath !== `blobs/sha256/${reference.sha256}`
      ) {
        fail(
          "CONTROLLER_TRANSPORT_ARTIFACT",
          "retained scenario artifact has no exact signed response reference",
        );
      }
      const artifact = await readRetainedArtifact(
        trusted.store,
        reference.path,
        {
          path: reference.path,
          bytes: signedReference.bytes,
          sha256: reference.sha256,
        },
        `scenario signed artifact[${index}]`,
      );
      artifactsBySha256.set(reference.sha256, artifact.bytes);
    }
    const reconstructedExchange = Object.freeze({
      request,
      requestPayload: Buffer.from(retained.operationRequest.bytes),
      response,
      responsePayload: Buffer.from(retained.operationResponse.bytes),
      result: responseReceipt,
      bindings: operationResponse.envelope.artifactBindings,
      artifactsBySha256,
    });
    const validated = validateScenarioSignedMaterials(reconstructedExchange, trusted);
    const provenance = validateProbeControllerActionProvenance(
      parseCanonicalObject(retained.provenance.bytes, "retained scenario action provenance"),
      {
        receipt: validated.receipt,
        records: validated.records,
        artifacts: validated.evidenceArtifacts,
      },
    );
    validateCompleteControllerActionCommit(complete, paths, validated, "scenario action");
    return scenarioActionAcknowledgment(validated.receipt, provenance, validated.verifiedEvidence);
  }

  async function invokeScenarioAction(unsafeInput) {
    const trusted = await trustScenarioActionInput(
      unsafeInput,
      "invokeScenarioAction controller operation input",
    );
    const exchanged = await exchangeOperation("invokeScenarioAction", trusted.input);
    const validated = validateScenarioSignedMaterials(exchanged, trusted);
    await retainScenarioSignedMaterials(exchanged, trusted, validated);
    return verifyScenarioActionReceipt(trusted.input);
  }

  async function verifyHardCutReceipt(unsafeInput) {
    const trusted = await trustHardCutReceiptInput(
      unsafeInput,
      "verifyHardCutReceipt controller operation input",
    );
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: trusted.coordinate.campaignRunId,
      attemptId: trusted.coordinate.attemptId,
      workId: trusted.coordinate.workId,
      producerActionId: trusted.action.actionId,
    });
    const complete = await readCompleteControllerActionCommit(trusted, paths, "hard-cut action");
    const deterministicPaths = {
      provenance: paths.provenance,
      receipt: paths.receipt,
      controllerRequest: paths.controllerRequest,
      operationRequest: paths.operationRequest,
      controllerResponse: paths.controllerResponse,
      operationResponse: paths.operationResponse,
    };
    const retained = {};
    for (const [key, path] of Object.entries(deterministicPaths)) {
      await assertUniqueRetainedPath(trusted.store, path, `hard-cut action ${key}`);
      retained[key] = await readRetainedArtifact(
        trusted.store,
        path,
        null,
        `hard-cut action ${key}`,
      );
    }

    const retainedReceipt = validateScenarioActionReceiptBinding(
      parseCanonicalObject(retained.receipt.bytes, "retained hard-cut action receipt"),
      trusted,
    );
    const request = validateControllerRequest(
      parseCanonicalObject(
        retained.controllerRequest.bytes,
        "retained hard-cut controller request",
      ),
    );
    validateHardCutControllerRequest(request, retained.operationRequest.bytes, trusted);
    const response = verifyControllerResponse(
      parseCanonicalObject(
        retained.controllerResponse.bytes,
        "retained signed hard-cut controller response",
      ),
      {
        request,
        controllerIdentitySha256: authority.spool.identitySha256,
        controllerVersion: authority.spool.version,
        controllerPublicKeyBytes: authority.publicKeyBytes,
      },
    );
    if (
      response.outcome !== "SUCCEEDED" ||
      response.payload.sha256 !== retained.operationResponse.sha256 ||
      response.payload.bytes !== retained.operationResponse.size ||
      response.payload.blobPath !== `blobs/sha256/${response.payload.sha256}`
    ) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_RESPONSE",
        "retained signed hard-cut response payload differs",
      );
    }
    const operationResponse = decodeControllerOperationResponse(retained.operationResponse.bytes, {
      expectedOperationKind: operationKindsByMethod.readHardCutReceipt,
      outcome: response.outcome,
      artifacts: response.artifacts,
    });
    assertExactKeys(
      operationResponse.envelope.result,
      ["checkpointEvidence", "actionExecutionReceipt"],
      [],
      "retained hard-cut signed result",
    );
    const responseReceipt = validateScenarioActionReceiptBinding(
      operationResponse.envelope.result.actionExecutionReceipt,
      trusted,
    );
    if (!canonicalEqual(responseReceipt, retainedReceipt)) {
      fail(
        "CONTROLLER_TRANSPORT_HARD_CUT_RECEIPT",
        "retained hard-cut action receipt differs from the signed operation response",
      );
    }
    const signedArtifacts = collectProbeControllerActionSignedArtifacts(responseReceipt);
    requireExactOrderedReferences(
      operationResponse.envelope.artifactBindings,
      signedArtifacts,
      "retained hard-cut action artifact bindings",
    );
    const responseArtifactsBySha256 = new Map(
      response.artifacts.map((reference) => [reference.sha256, reference]),
    );
    const artifactsBySha256 = new Map();
    for (const [index, reference] of signedArtifacts.entries()) {
      await assertUniqueRetainedPath(
        trusted.store,
        reference.path,
        `hard-cut signed artifact[${index}]`,
      );
      const signedReference = responseArtifactsBySha256.get(reference.sha256);
      if (
        signedReference === undefined ||
        signedReference.blobPath !== `blobs/sha256/${reference.sha256}`
      ) {
        fail(
          "CONTROLLER_TRANSPORT_ARTIFACT",
          "retained hard-cut artifact has no exact signed response reference",
        );
      }
      const artifact = await readRetainedArtifact(
        trusted.store,
        reference.path,
        {
          path: reference.path,
          bytes: signedReference.bytes,
          sha256: reference.sha256,
        },
        `hard-cut signed artifact[${index}]`,
      );
      artifactsBySha256.set(reference.sha256, artifact.bytes);
    }
    const reconstructedExchange = Object.freeze({
      request,
      requestPayload: Buffer.from(retained.operationRequest.bytes),
      response,
      responsePayload: Buffer.from(retained.operationResponse.bytes),
      result: operationResponse.envelope.result,
      bindings: operationResponse.envelope.artifactBindings,
      artifactsBySha256,
    });
    const validated = validateHardCutSignedMaterials(reconstructedExchange, trusted);
    const provenance = validateProbeControllerActionProvenance(
      parseCanonicalObject(retained.provenance.bytes, "retained hard-cut action provenance"),
      {
        receipt: validated.receipt,
        records: validated.records,
        artifacts: validated.evidenceArtifacts,
      },
    );
    validateCompleteControllerActionCommit(complete, paths, validated, "hard-cut action");
    return hardCutReceiptResult(
      validated.checkpointEvidence,
      validated.receipt,
      provenance,
      validated.verifiedEvidence,
    );
  }

  async function readHardCutReceipt(unsafeInput) {
    const trusted = await trustHardCutReceiptInput(
      unsafeInput,
      "readHardCutReceipt controller operation input",
    );
    const exchanged = await exchangeOperation("readHardCutReceipt", trusted.input);
    const validated = validateHardCutSignedMaterials(exchanged, trusted);
    await assertHardCutSignedMaterialsPublishable(exchanged, trusted, validated);
    await retainScenarioSignedMaterials(exchanged, trusted, validated);
    return verifyHardCutReceipt(trusted.input);
  }

  async function direct(method, input) {
    const exchanged = await exchangeOperation(method, input);
    requireNoBindings(exchanged.bindings, method);
    return exchanged.result;
  }

  return Object.freeze({
    observeController,
    verifyRunAuthorization,
    recoverOrAcquireEvidenceQuiescence: (input) =>
      direct("recoverOrAcquireEvidenceQuiescence", input),
    renewEvidenceQuiescence: (input) => direct("renewEvidenceQuiescence", input),
    captureQuiescedEvidenceSeal: (input) => direct("captureQuiescedEvidenceSeal", input),
    completeEvidenceQuiescence: (input) => direct("completeEvidenceQuiescence", input),
    abandonEvidenceQuiescence: (input) => direct("abandonEvidenceQuiescence", input),
    invokeScenarioAction,
    verifyScenarioActionReceipt,
    observeCaptureDisposition: (input) => direct("observeCaptureDisposition", input),
    signSourceTranscriptReceipt: (input) => direct("signSourceTranscriptReceipt", input),
    claimHardCutRequest: (input) => direct("claimHardCutRequest", input),
    readHardCutReceipt,
    verifyHardCutReceipt,
  });
}
