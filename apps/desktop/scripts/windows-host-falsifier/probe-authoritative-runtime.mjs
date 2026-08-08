import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  appendContinuation,
  closeContinuation,
  consumeContinuationReceipt,
  initializeContinuation,
  loadContinuation,
} from "./continuation.mjs";
import {
  PROBE_REGISTRY_SOURCE_PATH,
  createProbeFinalizerAdapters,
  createProbePreflightReaders,
} from "./probe-adapters.mjs";
import { validateProbeBrokerEnrollmentInventory } from "./broker/mailbox-protocol.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST,
  canonicalProbeJson,
  createExternalCheckpointReplayRegistry,
  deriveExternalCheckpointRequestDigest,
  hashProbeCanonicalJson,
  validateLabAttestation,
  validateProbeCandidateIdentity,
  validateExternalCheckpointEvidence,
  verifyExternalCheckpointRequestSignature,
} from "./probe-contract.mjs";
import {
  probeControllerActionAttestationPath,
  probeControllerActionProvenancePaths,
  validateProbeControllerActionAttestation,
  validateProbeControllerActionExecutionReceipt,
} from "./probe-controller-action-provenance.mjs";
import { probeControllerActionCommitMarkerPath } from "./probe-controller-spool-transport.mjs";
import {
  finalizeProbeCampaign,
  finalizeProbeSegment,
  probeSegmentArtifactPaths,
  verifyCommittedProbeSegment,
} from "./probe-finalizer.mjs";
import {
  deriveProbePreparationRequestDigest,
  prepareAuthoritativeProbeContext,
  validatePreparedProbeContext,
  validateProbePreparationTransaction,
} from "./probe-preflight.mjs";
import { getProbeTranscriptFactDefinition } from "./probe-registry.mjs";
import {
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
  deriveProbeWorkUpstreamSelectionDigests,
  getProbeRunWorkItem,
  validateProbeRunPlan,
} from "./probe-runner.mjs";
import {
  validateProbeRunAuthorization,
  validateProbeRunAuthorizationClaimReceipt,
  verifyProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";
import { createProbeRuntimeActionBinding } from "./probe-runtime-action-intent.mjs";
import {
  executeProbeScenario,
  executeProbeScenarioActionSlice,
  getProbeScenarioDefinition,
} from "./probe-scenarios.mjs";
import {
  deriveControllerSourceTranscriptReceiptDigest,
  reduceProbeSourceTranscript,
} from "./probe-transcript.mjs";
import { validateNativeCommandTranscript } from "./native-client.mjs";

export const PROBE_AUTHORITATIVE_RUNTIME_SCHEMA_VERSION = 1;

export { deriveProbeRuntimeScenarioOperationId } from "./probe-runtime-action-intent.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const checkpointRequestKeys = Object.freeze([
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

const retainedRunAuthorizationPath = "campaign/run-authorization.json";

export class ProbeAuthoritativeRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeAuthoritativeRuntimeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeAuthoritativeRuntimeError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = [], label = "value") {
  if (!exactObject(value)) fail("RUNTIME_SCHEMA", `${label} must be an object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !permitted.has(key)) {
      fail("RUNTIME_SCHEMA", `${label} has an unexpected key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("RUNTIME_SCHEMA", `${label}.${key} must be an enumerable data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("RUNTIME_SCHEMA", `${label} is missing key: ${key}`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") fail("RUNTIME_TRANSPORT", `${label} must be a function`);
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value) || value.length > 128) {
    fail("RUNTIME_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("RUNTIME_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseCanonicalObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("RUNTIME_CANONICAL", `${label} must be UTF-8 JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== Buffer.from(bytes).toString("utf8")) {
    fail("RUNTIME_CANONICAL", `${label} must be a canonical JSON object`);
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

async function ensureParentDirectories(store, path) {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    await createDirectoryIfAbsent(store, current);
  }
}

async function readOptionalArtifact(store, path) {
  try {
    return await store.readArtifact(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function retainExactBytes(store, path, bytes) {
  const retainedBytes = Buffer.from(bytes);
  await ensureParentDirectories(store, path);
  try {
    return await store.writeBytes(path, retainedBytes);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(path);
    if (!retained.bytes.equals(retainedBytes)) {
      fail("RUNTIME_ARTIFACT_COLLISION", `retained artifact differs: ${path}`);
    }
    return Object.freeze({ path: retained.path, sha256: retained.sha256 });
  }
}

async function retainExactCanonical(store, path, value) {
  return retainExactBytes(store, path, Buffer.from(canonicalProbeJson(value), "utf8"));
}

function requireEvidenceStore(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.root !== "string" ||
    typeof value.createDirectory !== "function" ||
    typeof value.writeBytes !== "function" ||
    typeof value.readArtifact !== "function" ||
    typeof value.verifyArtifactSet !== "function" ||
    typeof value.assertRootStable !== "function"
  ) {
    fail("RUNTIME_STORE", "resolveStore must return an EvidenceStore");
  }
  return value;
}

function validateCaptureDisposition(value) {
  assertExactKeys(value, ["captureComplete", "availability"], [], "capture disposition");
  if (typeof value.captureComplete !== "boolean") {
    fail("RUNTIME_CAPTURE", "captureComplete must be boolean");
  }
  assertExactKeys(value.availability, ["status", "reason"], [], "capture availability");
  if (!new Set(["available", "unavailable", "unknown"]).has(value.availability.status)) {
    fail("RUNTIME_CAPTURE", "capture availability status is invalid");
  }
  if (
    value.availability.reason !== null &&
    (typeof value.availability.reason !== "string" ||
      value.availability.reason.length === 0 ||
      value.availability.reason.length > 1024)
  ) {
    fail("RUNTIME_CAPTURE", "capture availability reason is invalid");
  }
  if (value.availability.status === "available" && value.availability.reason !== null) {
    fail("RUNTIME_CAPTURE", "available capture cannot carry a reason");
  }
  return deepFreeze({
    captureComplete: value.captureComplete,
    availability: {
      status: value.availability.status,
      reason: value.availability.reason,
    },
  });
}

function validateRuntimeConfig(config) {
  assertExactKeys(
    config,
    [
      "campaignRunId",
      "candidate",
      "attestations",
      "runAuthorization",
      "brokerEnrollments",
      "repositoryRoot",
      "lifecyclePolicy",
      "resolveStore",
      "resolvePreflightRequest",
      "nativeTransport",
      "brokerTransport",
      "controllerTransport",
      "now",
      "monotonicNow",
    ],
    ["binaryRoot", "readRepositoryIdentity"],
    "runtime config",
  );
  requireIdentifier(config.campaignRunId, "config.campaignRunId");
  if (typeof config.repositoryRoot !== "string" || config.repositoryRoot.length === 0) {
    fail("RUNTIME_CONFIG", "repositoryRoot must be a non-empty string");
  }
  if (
    config.binaryRoot !== undefined &&
    (typeof config.binaryRoot !== "string" || config.binaryRoot.length === 0)
  ) {
    fail("RUNTIME_CONFIG", "binaryRoot must be a non-empty string when supplied");
  }
  requireFunction(config.resolveStore, "config.resolveStore");
  requireFunction(config.resolvePreflightRequest, "config.resolvePreflightRequest");
  requireFunction(config.now, "config.now");
  requireFunction(config.monotonicNow, "config.monotonicNow");
  if (config.readRepositoryIdentity !== undefined) {
    requireFunction(config.readRepositoryIdentity, "config.readRepositoryIdentity");
  }
  assertExactKeys(
    config.nativeTransport,
    ["observeGuest", "invokeScenarioAction", "readNativeTranscript"],
    [],
    "native transport",
  );
  for (const key of ["observeGuest", "invokeScenarioAction", "readNativeTranscript"]) {
    requireFunction(config.nativeTransport[key], `config.nativeTransport.${key}`);
  }
  assertExactKeys(config.brokerTransport, ["observeBrokerMailbox"], [], "broker transport");
  requireFunction(
    config.brokerTransport.observeBrokerMailbox,
    "config.brokerTransport.observeBrokerMailbox",
  );
  assertExactKeys(
    config.controllerTransport,
    [
      "observeController",
      "verifyRunAuthorization",
      "recoverOrAcquireEvidenceQuiescence",
      "renewEvidenceQuiescence",
      "captureQuiescedEvidenceSeal",
      "completeEvidenceQuiescence",
      "abandonEvidenceQuiescence",
      "invokeScenarioAction",
      "verifyScenarioActionReceipt",
      "observeCaptureDisposition",
      "signSourceTranscriptReceipt",
      "claimHardCutRequest",
      "readHardCutReceipt",
      "verifyHardCutReceipt",
    ],
    [],
    "controller transport",
  );
  for (const key of [
    "observeController",
    "verifyRunAuthorization",
    "recoverOrAcquireEvidenceQuiescence",
    "renewEvidenceQuiescence",
    "captureQuiescedEvidenceSeal",
    "completeEvidenceQuiescence",
    "abandonEvidenceQuiescence",
    "invokeScenarioAction",
    "verifyScenarioActionReceipt",
    "observeCaptureDisposition",
    "signSourceTranscriptReceipt",
    "claimHardCutRequest",
    "readHardCutReceipt",
    "verifyHardCutReceipt",
  ]) {
    requireFunction(config.controllerTransport[key], `config.controllerTransport.${key}`);
  }
  return config;
}

function preparationPath(command) {
  return [
    "runtime",
    "prepared",
    command.campaignRunId,
    command.attemptId,
    command.environmentId,
    `${command.pathProfileId}.json`,
  ].join("/");
}

function runAuthorizationClaimPath(environmentId) {
  return `campaign/run-authorization-claims/${environmentId}.json`;
}

function workRuntimeBase(command) {
  return ["runtime", "work", command.campaignRunId, command.attemptId, command.workId].join("/");
}

function partialCapturePath(command, actionId) {
  return `${workRuntimeBase(command)}/actions/${actionId}.json`;
}

function dependencyPath(command) {
  return `${workRuntimeBase(command)}/dependencies.json`;
}

function continuationPointerPath(command, repetition) {
  return `${workRuntimeBase(command)}/continuations/${String(repetition).padStart(2, "0")}.json`;
}

function checkpointRequestPath(command) {
  return `${workRuntimeBase(command)}/hard-cuts/${String(command.repetition).padStart(2, "0")}-request.json`;
}

function checkpointResumePath(command) {
  return `${workRuntimeBase(command)}/hard-cuts/${String(command.repetition).padStart(2, "0")}-resume.json`;
}

function stagedCheckpointResultDirectory(command, request) {
  return `${workRuntimeBase(command)}/hard-cuts/staged/${request.requestSha256}`;
}

function stagedCheckpointResultPath(command, request, result) {
  return `${stagedCheckpointResultDirectory(command, request)}/${hashProbeCanonicalJson(result)}.json`;
}

function finalizationStartPath(command) {
  return `${workRuntimeBase(command)}/finalization-start.json`;
}

function ordinaryChainId(command) {
  return `chain-${hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-runtime-local-continuation.v1",
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
  }).slice(0, 32)}`;
}

function continuationScope(prepared, command, repetition, chainId) {
  return {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    labAttestationSha256: prepared.labAttestationSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    attemptId: prepared.attemptId,
    vmSnapshotId: prepared.vmSnapshotId,
    repetition,
    chainId,
  };
}

async function initializeOrLoadContinuation(store, scope, now) {
  await initializeContinuation({ store, scope, now });
  const chain = await loadContinuation({ store, chainId: scope.chainId });
  for (const [key, expected] of Object.entries(scope)) {
    if (chain.header[key] !== expected) {
      fail("RUNTIME_CONTINUATION_COLLISION", `continuation scope differs: ${scope.chainId}`);
    }
  }
  return chain;
}

async function appendOrRecoverContinuation(store, chainId, operationId, payload, now) {
  return appendContinuation({ store, chainId, operationId, payload, now });
}

async function closeOrRecoverContinuation(store, chainId, now) {
  return closeContinuation({ store, chainId, now });
}

async function retainContinuationPointer(store, command, repetition, chain) {
  const pointer = {
    schemaVersion: 1,
    kind: "windows-host-probe-runtime-continuation-pointer",
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    repetition,
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    headerSha256: chain.header.headerSha256,
  };
  await retainExactCanonical(store, continuationPointerPath(command, repetition), pointer);
  return deepFreeze(pointer);
}

async function loadContinuationPointer(
  store,
  command,
  repetition,
  { requireClosed, expectedClosureKind = null },
) {
  const path = continuationPointerPath(command, repetition);
  const artifact = await store.readArtifact(path);
  const pointer = parseCanonicalObject(artifact.bytes, `continuation pointer ${repetition}`);
  assertExactKeys(
    pointer,
    [
      "schemaVersion",
      "kind",
      "campaignRunId",
      "attemptId",
      "workId",
      "repetition",
      "chainId",
      "scopeSha256",
      "headerSha256",
    ],
    [],
    `continuation pointer ${repetition}`,
  );
  if (
    pointer.schemaVersion !== 1 ||
    pointer.kind !== "windows-host-probe-runtime-continuation-pointer" ||
    pointer.campaignRunId !== command.campaignRunId ||
    pointer.attemptId !== command.attemptId ||
    pointer.workId !== command.workId ||
    pointer.repetition !== repetition
  ) {
    fail("RUNTIME_CONTINUATION_COLLISION", `continuation pointer differs: ${path}`);
  }
  const chain = await loadContinuation({ store, chainId: pointer.chainId });
  if (
    chain.header.scopeSha256 !== pointer.scopeSha256 ||
    chain.header.headerSha256 !== pointer.headerSha256
  ) {
    fail("RUNTIME_CONTINUATION_COLLISION", `continuation differs: ${pointer.chainId}`);
  }
  if (requireClosed && chain.closure === null) {
    fail("RUNTIME_CONTINUATION_INCOMPLETE", `continuation is not closed: ${pointer.chainId}`);
  }
  const closureKind = chain.closure?.kind ?? null;
  if (
    (expectedClosureKind === "external" &&
      closureKind !== "windows-host-probe-consumed-external-receipt") ||
    (expectedClosureKind === "local" &&
      closureKind !== "windows-host-probe-local-continuation-receipt")
  ) {
    fail("RUNTIME_CONTINUATION_COLLISION", `continuation has another closure: ${pointer.chainId}`);
  }
  return { pointer: deepFreeze(pointer), chain };
}

async function loadContinuationPointers(store, command, count, expectedClosureKind) {
  const pointers = [];
  for (let repetition = 1; repetition <= count; repetition += 1) {
    const { pointer } = await loadContinuationPointer(store, command, repetition, {
      requireClosed: true,
      expectedClosureKind,
    });
    pointers.push(pointer);
  }
  return pointers;
}

async function verifyScenarioEvidence(store, paths, artifacts) {
  const prefix = `${paths.evidence}/`;
  const reserved = new Set([paths.sourceTranscript, paths.sourceTranscriptReceipt]);
  const declarations = [];
  for (const artifact of artifacts) {
    if (
      typeof artifact.path !== "string" ||
      !artifact.path.startsWith(prefix) ||
      reserved.has(artifact.path) ||
      artifact.path.startsWith(`${paths.nativeTranscripts}/`)
    ) {
      fail("RUNTIME_SCENARIO_EVIDENCE", "scenario evidence is outside its coordinate namespace");
    }
    requireSha256(artifact.sha256, `scenario evidence ${artifact.path}`);
    declarations.push({ path: artifact.path, sha256: artifact.sha256 });
  }
  await store.verifyArtifactSet(declarations);
  return declarations;
}

async function validatePartialCapture(value, rowId, variantId, actionId) {
  if (!exactObject(value) || !Array.isArray(value.commandEvents)) {
    fail("RUNTIME_ACTION_CAPTURE", `retained action capture is invalid: ${actionId}`);
  }
  const commandEvent = value.commandEvents.length === 0 ? null : value.commandEvents[0];
  if (value.commandEvents.length > 1) {
    fail("RUNTIME_ACTION_CAPTURE", `single action capture has multiple events: ${actionId}`);
  }
  const replay = () => ({
    actionId,
    commandEvent,
    evidenceArtifacts: value.evidenceArtifacts,
  });
  const validated = await executeProbeScenarioActionSlice({
    rowId,
    variantId,
    actionIds: [actionId],
    invokeNative: replay,
    invokeController: replay,
  });
  if (!canonicalEqual(value, validated)) {
    fail("RUNTIME_ACTION_CAPTURE", `retained action capture differs: ${actionId}`);
  }
  return validated;
}

function validateNativeActionAcknowledgment(value, operationId, resultArtifact, actionId) {
  assertExactKeys(
    value,
    ["operationId", "resultSha256"],
    [],
    `scenario action acknowledgment ${actionId}`,
  );
  if (value.operationId !== operationId) {
    fail("RUNTIME_ACTION_ACKNOWLEDGMENT", `scenario operation differs: ${actionId}`);
  }
  requireSha256(value.resultSha256, `scenario action acknowledgment ${actionId}.resultSha256`);
  if (value.resultSha256 !== resultArtifact.sha256) {
    fail("RUNTIME_ACTION_ACKNOWLEDGMENT", `scenario result digest differs: ${actionId}`);
  }
  return deepFreeze({ operationId: value.operationId, resultSha256: value.resultSha256 });
}

function validateControllerActionAcknowledgment(value, operationId, resultArtifact, actionId) {
  assertExactKeys(
    value,
    [
      "operationId",
      "resultSha256",
      "receiptSha256",
      "provenanceSha256",
      "actionAttestationSha256",
      "primaryObserverTranscriptSha256s",
    ],
    [],
    `controller scenario action acknowledgment ${actionId}`,
  );
  if (value.operationId !== operationId) {
    fail("RUNTIME_ACTION_ACKNOWLEDGMENT", `scenario operation differs: ${actionId}`);
  }
  for (const key of ["resultSha256", "receiptSha256", "provenanceSha256"]) {
    requireSha256(value[key], `controller scenario action acknowledgment ${actionId}.${key}`);
  }
  if (value.actionAttestationSha256 !== null) {
    requireSha256(
      value.actionAttestationSha256,
      `controller scenario action acknowledgment ${actionId}.actionAttestationSha256`,
    );
  }
  if (value.resultSha256 !== resultArtifact.sha256) {
    fail("RUNTIME_ACTION_ACKNOWLEDGMENT", `scenario result digest differs: ${actionId}`);
  }
  if (!Array.isArray(value.primaryObserverTranscriptSha256s)) {
    fail(
      "RUNTIME_ACTION_ACKNOWLEDGMENT",
      `scenario observer transcript identities are invalid: ${actionId}`,
    );
  }
  let previous = null;
  for (const [index, transcriptSha256] of value.primaryObserverTranscriptSha256s.entries()) {
    requireSha256(
      transcriptSha256,
      `controller scenario action acknowledgment ${actionId}.primaryObserverTranscriptSha256s[${index}]`,
    );
    if (previous !== null && compareUtf8(previous, transcriptSha256) >= 0) {
      fail(
        "RUNTIME_ACTION_ACKNOWLEDGMENT",
        `scenario observer transcript identities are not unique and ordered: ${actionId}`,
      );
    }
    previous = transcriptSha256;
  }
  return deepFreeze({
    operationId: value.operationId,
    resultSha256: value.resultSha256,
    receiptSha256: value.receiptSha256,
    provenanceSha256: value.provenanceSha256,
    actionAttestationSha256: value.actionAttestationSha256,
    primaryObserverTranscriptSha256s: [...value.primaryObserverTranscriptSha256s],
  });
}

async function executeOrLoadPartialCapture({
  store,
  preparedContext,
  command,
  actionId,
  invokeNative,
  invokeController,
  verifyController,
  paths,
  verifiedHardCutReceipt = null,
}) {
  const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
  const action = definition.actions.find((entry) => entry.actionId === actionId);
  if (action === undefined) {
    fail("RUNTIME_ACTION_CAPTURE", `scenario action is unknown: ${actionId}`);
  }
  const isHardCutAction =
    action.actor === "external-controller" && action.operation === "hard-cut-guest";
  if (verifiedHardCutReceipt !== null && !isHardCutAction) {
    fail(
      "RUNTIME_ACTION_AUTHORITY",
      "verifiedHardCutReceipt is reserved for the hard-cut receipt seam",
    );
  }
  const invocation = deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: command.rowId,
    variantId: command.variantId,
    planSha256: definition.planSha256,
    action,
  });
  const binding = createProbeRuntimeActionBinding({ command, invocation, preparedContext });
  await retainExactCanonical(store, binding.operationIntentPath, binding.intent);
  const resultPath = binding.operationResultPath;
  let resultArtifact = await readOptionalArtifact(store, resultPath);
  if (resultArtifact === null && isHardCutAction) {
    fail(
      "RUNTIME_ACTION_AUTHORITY",
      "hard-cut action result is absent from verified controller provenance",
    );
  }
  let controllerInvocationAcknowledgment = null;
  let verifiedControllerAcknowledgment = null;
  if (resultArtifact === null) {
    const seam = action.actor === "native-helper" ? invokeNative : invokeController;
    if (typeof seam !== "function") {
      fail("RUNTIME_TRANSPORT", `no authoritative transport was supplied for ${action.actor}`);
    }
    const acknowledgment = await seam(invocation, command);
    resultArtifact = await readOptionalArtifact(store, resultPath);
    if (resultArtifact === null) {
      fail(
        "RUNTIME_ACTION_RESULT_NOT_RETAINED",
        `scenario transport did not retain its result before returning: ${actionId}`,
      );
    }
    if (action.actor === "native-helper") {
      validateNativeActionAcknowledgment(
        acknowledgment,
        binding.operationId,
        resultArtifact,
        actionId,
      );
    } else {
      controllerInvocationAcknowledgment = acknowledgment;
    }
  }
  if (action.actor === "external-controller") {
    if (isHardCutAction) {
      if (verifiedHardCutReceipt === null) {
        fail(
          "RUNTIME_ACTION_AUTHORITY",
          "hard-cut actions require an offline-verified execution receipt",
        );
      }
      const receipt = validateProbeControllerActionExecutionReceipt(
        verifiedHardCutReceipt.actionExecutionReceipt,
      );
      if (
        receipt.producerActionId !== actionId ||
        receipt.operation.operationId !== binding.operationId ||
        receipt.actionResultArtifact.path !== binding.operationResultPath ||
        receipt.actionResultArtifact.sha256 !== resultArtifact.sha256
      ) {
        fail("RUNTIME_ACTION_AUTHORITY", `hard-cut receipt differs from action: ${actionId}`);
      }
      const verified = validateControllerActionAcknowledgment(
        verifiedHardCutReceipt.actionAcknowledgment,
        binding.operationId,
        resultArtifact,
        actionId,
      );
      const expectedObserverTranscriptSha256s = receipt.observerTranscripts
        .map(({ transcriptSha256 }) => transcriptSha256)
        .sort(compareUtf8);
      if (
        verified.receiptSha256 !== receipt.receiptSha256 ||
        !canonicalEqual(
          verified.primaryObserverTranscriptSha256s,
          expectedObserverTranscriptSha256s,
        )
      ) {
        fail(
          "RUNTIME_ACTION_ACKNOWLEDGMENT",
          `hard-cut acknowledgment differs from execution receipt: ${actionId}`,
        );
      }
      verifiedControllerAcknowledgment = verified;
    } else if (typeof verifyController !== "function") {
      fail(
        "RUNTIME_TRANSPORT",
        "ordinary external-controller actions require a read-only receipt verifier",
      );
    } else {
      const verified = validateControllerActionAcknowledgment(
        await verifyController(invocation, command),
        binding.operationId,
        resultArtifact,
        actionId,
      );
      if (controllerInvocationAcknowledgment !== null) {
        const invoked = validateControllerActionAcknowledgment(
          controllerInvocationAcknowledgment,
          binding.operationId,
          resultArtifact,
          actionId,
        );
        if (!canonicalEqual(invoked, verified)) {
          fail(
            "RUNTIME_ACTION_ACKNOWLEDGMENT",
            `scenario invocation and verification acknowledgments differ: ${actionId}`,
          );
        }
      }
      verifiedControllerAcknowledgment = verified;
    }
  }
  const actionResult = parseCanonicalObject(resultArtifact.bytes, `action result ${actionId}`);
  if (
    verifiedHardCutReceipt !== null &&
    !canonicalEqual(actionResult, verifiedHardCutReceipt.actionExecutionReceipt.actionResult)
  ) {
    fail("RUNTIME_ACTION_AUTHORITY", `hard-cut result differs from signed receipt: ${actionId}`);
  }
  const replay = () => actionResult;
  const capture = await executeProbeScenarioActionSlice({
    rowId: command.rowId,
    variantId: command.variantId,
    actionIds: [actionId],
    invokeNative: replay,
    invokeController: replay,
  });
  await verifyScenarioEvidence(store, paths, capture.evidenceArtifacts);
  const path = partialCapturePath(command, actionId);
  const retained = await readOptionalArtifact(store, path);
  if (retained !== null) {
    const retainedCapture = await validatePartialCapture(
      parseCanonicalObject(retained.bytes, `action capture ${actionId}`),
      command.rowId,
      command.variantId,
      actionId,
    );
    await verifyScenarioEvidence(store, paths, retainedCapture.evidenceArtifacts);
    if (!canonicalEqual(capture, retainedCapture)) {
      fail("RUNTIME_ACTION_CAPTURE", `action result differs from capture: ${actionId}`);
    }
    return deepFreeze({
      capture: retainedCapture,
      primaryObserverTranscriptSha256s:
        verifiedControllerAcknowledgment?.primaryObserverTranscriptSha256s ?? [],
      actionAttestationSha256: verifiedControllerAcknowledgment?.actionAttestationSha256 ?? null,
    });
  }
  await retainExactCanonical(store, path, capture);
  return deepFreeze({
    capture,
    primaryObserverTranscriptSha256s:
      verifiedControllerAcknowledgment?.primaryObserverTranscriptSha256s ?? [],
    actionAttestationSha256: verifiedControllerAcknowledgment?.actionAttestationSha256 ?? null,
  });
}

async function loadExistingPartialCapture(
  store,
  preparedContext,
  command,
  actionId,
  paths,
  verifyController,
) {
  const retained = await readOptionalArtifact(store, partialCapturePath(command, actionId));
  if (retained === null) return null;
  const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
  const action = definition.actions.find((entry) => entry.actionId === actionId);
  if (action === undefined) {
    fail("RUNTIME_ACTION_CAPTURE", `retained action is absent from the trusted plan: ${actionId}`);
  }
  if (definition.continuation.kind !== "external-hard-cut") {
    fail("RUNTIME_ACTION_CAPTURE", "cross-dispatch action recovery requires a hard-cut plan");
  }
  let originatingRepetition;
  if (action.phase === "setup") {
    originatingRepetition = 1;
  } else if (action.phase === "capture") {
    originatingRepetition = definition.continuation.repetitions;
  } else {
    originatingRepetition = action.parameters.repetition;
  }
  if (
    !Number.isSafeInteger(originatingRepetition) ||
    originatingRepetition < 1 ||
    originatingRepetition > definition.continuation.repetitions ||
    !Number.isSafeInteger(command.repetition) ||
    originatingRepetition > command.repetition
  ) {
    fail(
      "RUNTIME_ACTION_CAPTURE",
      `trusted action repetition is invalid for this recovery: ${actionId}`,
    );
  }
  const { repetition: _currentRepetition, ...commandWithoutRepetition } = command;
  const originatingCommand = { ...commandWithoutRepetition, repetition: originatingRepetition };
  const invocation = deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action,
  });
  const expectedBinding = createProbeRuntimeActionBinding({
    command: originatingCommand,
    invocation,
    preparedContext,
  });
  const retainedIntentArtifact = await readOptionalArtifact(
    store,
    expectedBinding.operationIntentPath,
  );
  if (retainedIntentArtifact === null) {
    fail("RUNTIME_ACTION_CAPTURE", `retained action capture has no intent: ${actionId}`);
  }
  const retainedIntent = parseCanonicalObject(
    retainedIntentArtifact.bytes,
    `retained action intent ${actionId}`,
  );
  if (!canonicalEqual(retainedIntent, expectedBinding.intent)) {
    fail(
      "RUNTIME_ACTION_CAPTURE",
      `retained action intent differs from its trusted originating repetition: ${actionId}`,
    );
  }
  return executeOrLoadPartialCapture({
    store,
    preparedContext,
    command: originatingCommand,
    actionId,
    paths,
    verifyController,
  });
}

function expectedNativeBinding(prepared) {
  return {
    campaignRunId: prepared.campaignRunId,
    candidateSha256: prepared.candidateSha256,
    preflightSha256: prepared.preflightSha256,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    nativeHelperArtifactPath: prepared.executionBundleManifest.binaries.nativeHelper.path,
    nativeHelperSha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
    nativeCandidateDigest:
      prepared.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
    nativeManifestSha256:
      prepared.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  };
}

function validateNativeTranscriptForPrepared(transcript, prepared, transcriptSha256) {
  if (transcript.transcriptSha256 !== transcriptSha256) {
    fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript digest differs from its command event");
  }
  if (transcript.termination === null) {
    fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript is not terminal");
  }
  for (const [key, expected] of Object.entries(expectedNativeBinding(prepared))) {
    if (transcript.binding[key] !== expected) {
      fail("RUNTIME_NATIVE_TRANSCRIPT", `native transcript ${key} differs from preflight`);
    }
  }
  if (
    sha256(Buffer.from(transcript.binding.runRootIdentity, "utf8")) !==
    prepared.pathProfileObservation.evidenceRootObjectIdentitySha256
  ) {
    fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript run root differs from preflight");
  }
  return transcript;
}

async function readAndValidateNativeTranscript(store, path, prepared, transcriptSha256) {
  const artifact = await store.readArtifact(path);
  const value = parseCanonicalObject(artifact.bytes, "native command transcript");
  const transcript = validateNativeCommandTranscript(value);
  validateNativeTranscriptForPrepared(transcript, prepared, transcriptSha256);
  if (artifact.sha256 !== sha256(artifact.bytes)) {
    fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript artifact digest is inconsistent");
  }
  return { artifact, transcript };
}

async function retainNativeTranscripts({
  store,
  paths,
  prepared,
  command,
  workItem,
  commandEvents,
  additionalTranscriptSha256s = [],
  locallyRetainedTranscriptSha256s = [],
  nativeTransport,
}) {
  const digests = [
    ...new Set([
      ...commandEvents.flatMap((event) => event.nativeTranscriptSha256s),
      ...additionalTranscriptSha256s,
    ]),
  ].sort(compareUtf8);
  if (digests.length === 0) {
    fail("RUNTIME_NATIVE_TRANSCRIPT", "scenario capture has no native transcript identity");
  }
  const locallyRetained = new Set(locallyRetainedTranscriptSha256s);
  const transcripts = [];
  for (const transcriptSha256 of digests) {
    requireSha256(transcriptSha256, "native transcript identity");
    const path = `${paths.nativeTranscripts}/${transcriptSha256}.json`;
    let retained = await readOptionalArtifact(store, path);
    if (retained === null) {
      if (locallyRetained.has(transcriptSha256)) {
        fail(
          "RUNTIME_CONTROLLER_OBSERVER_TRANSCRIPT",
          "verified controller observer transcript is not retained locally",
        );
      }
      const bytes = await nativeTransport.readNativeTranscript(
        deepFreeze({
          transcriptSha256,
          command,
          workItem,
          preparedContext: prepared,
          evidenceRoot: store.root,
          retainedPath: path,
        }),
      );
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript transport returned no bytes");
      }
      const value = parseCanonicalObject(bytes, "native transcript transport bytes");
      const transcript = validateNativeCommandTranscript(value);
      validateNativeTranscriptForPrepared(transcript, prepared, transcriptSha256);
      await retainExactBytes(store, path, bytes);
      retained = await store.readArtifact(path);
    }
    const validated = await readAndValidateNativeTranscript(
      store,
      path,
      prepared,
      transcriptSha256,
    );
    transcripts.push(validated.transcript);
  }
  transcripts.sort((left, right) =>
    compareUtf8(left.binding.nativeSessionId, right.binding.nativeSessionId),
  );
  for (let index = 1; index < transcripts.length; index += 1) {
    if (
      compareUtf8(
        transcripts[index - 1].binding.nativeSessionId,
        transcripts[index].binding.nativeSessionId,
      ) >= 0
    ) {
      fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript sessions are not unique");
    }
  }
  return deepFreeze(
    transcripts.map((transcript) => {
      const commandRecords = transcript.records
        .filter((record) => record.kind === "command")
        .map((record) => ({
          command: record.command,
          requestFrameSha256: record.requestFrameSha256,
          responseFrameSha256: record.responseFrameSha256,
          ok: record.ok,
        }));
      if (commandRecords.length === 0) {
        fail("RUNTIME_NATIVE_TRANSCRIPT", "native transcript has no command records");
      }
      return {
        transcriptSha256: transcript.transcriptSha256,
        binding: transcript.binding,
        commandRecords,
      };
    }),
  );
}

function sourceTranscriptBinding(prepared, workItem, verifierSourceSha256) {
  return {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    labAttestationSha256: prepared.labAttestationSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    preflightSha256: prepared.preflightSha256,
    preparationScopeSha256: prepared.preparationScopeSha256,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    vmSnapshotId: prepared.vmSnapshotId,
    bootIdSha256: prepared.bootIdSha256,
    runnerSessionIdSha256: prepared.runnerSessionIdSha256,
    rootPathSha256: prepared.pathProfileObservation.rootPathSha256,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
    volumeIdSha256: prepared.pathProfileObservation.volumeIdSha256,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    verifierDefinitionSha256: workItem.verifierDefinitionSha256,
    verifierSourceSha256,
  };
}

function sourceTranscriptProducer(prepared, producerKind) {
  return producerKind === "native-helper"
    ? {
        kind: producerKind,
        identitySha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
      }
    : {
        kind: producerKind,
        identitySha256: prepared.executionBundleManifest.controller.identitySha256,
      };
}

function verifierSourceSha256(candidate) {
  const artifact = candidate.sourceHashes.find(
    (reference) => reference.path === PROBE_REGISTRY_SOURCE_PATH,
  );
  if (artifact === undefined) {
    fail("RUNTIME_CANDIDATE", "candidate has no probe registry source hash");
  }
  return artifact.sha256;
}

async function controllerPublicKey(store, prepared) {
  const reference = prepared.controllerPublicKeyArtifact;
  const artifact = await store.readArtifact(reference.path);
  if (artifact.sha256 !== reference.sha256) {
    fail("RUNTIME_CONTROLLER_KEY", "controller public key differs from preflight");
  }
  return artifact.bytes;
}

async function attestedControllerPublicKey(store, attestation) {
  const reference = attestation.controller.publicKeyArtifact;
  const artifact = await store.readArtifact(reference.path);
  if (artifact.sha256 !== reference.sha256) {
    fail("RUNTIME_CONTROLLER_KEY", "controller public key differs from attestation");
  }
  return artifact.bytes;
}

function trustedTranscriptDefinition(workItem, candidate) {
  const mapping = getProbeTranscriptFactDefinition(workItem.rowId, workItem.variantId);
  if (
    mapping.definitionSha256 !== workItem.verifierDefinitionSha256 ||
    mapping.mappingSha256 !== workItem.transcriptMappingSha256 ||
    mapping.transcriptKind !== workItem.transcriptKind ||
    !canonicalEqual(
      mapping.commands.map(({ commandId }) => commandId),
      workItem.transcriptCommandIds,
    )
  ) {
    fail("RUNTIME_REGISTRY_DRIFT", "work item differs from the trusted transcript mapping");
  }
  return {
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    definitionSha256: mapping.definitionSha256,
    verifierSourceSha256: verifierSourceSha256(candidate),
    transcriptKind: mapping.transcriptKind,
    commands: mapping.commands,
  };
}

function validateObserverNativeTranscriptSha256s(value, label) {
  if (!Array.isArray(value)) {
    fail("RUNTIME_CONTROLLER_OBSERVER_TRANSCRIPT", `${label} must be an array`);
  }
  let previous = null;
  for (const [index, transcriptSha256] of value.entries()) {
    requireSha256(transcriptSha256, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, transcriptSha256) >= 0) {
      fail(
        "RUNTIME_CONTROLLER_OBSERVER_TRANSCRIPT",
        `${label} must be strictly UTF-8 sorted and unique`,
      );
    }
    previous = transcriptSha256;
  }
  return [...value];
}

function actionForSourceCommand(definition, event) {
  const matches = definition.actions.filter(
    ({ capture }) =>
      capture !== null &&
      capture.sequence === event.sequence &&
      capture.commandId === event.commandId,
  );
  if (matches.length !== 1) {
    fail(
      "RUNTIME_ACTION_ATTESTATION",
      "source command does not identify exactly one frozen producing action",
    );
  }
  return matches[0];
}

async function loadControllerActionAttestationBytes({
  store,
  prepared,
  workItem,
  sourceTranscript,
}) {
  if (!Array.isArray(sourceTranscript.commandEvents)) {
    fail("RUNTIME_ACTION_ATTESTATION", "source transcript command events are invalid");
  }
  const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
  const seen = new Set();
  const bytes = [];
  for (const event of sourceTranscript.commandEvents) {
    if (event.actionAttestationSha256 === null) continue;
    requireSha256(
      event.actionAttestationSha256,
      `source command ${event.commandId} action attestation`,
    );
    if (seen.has(event.actionAttestationSha256)) {
      fail("RUNTIME_ACTION_ATTESTATION", "source transcript reuses an action attestation");
    }
    const action = actionForSourceCommand(definition, event);
    if (action.actor !== "external-controller") {
      fail("RUNTIME_ACTION_ATTESTATION", "native producing action names controller authority");
    }
    const repetition = workItem.requiresExternalCheckpoint
      ? action.phase === "setup"
        ? 1
        : action.phase === "capture"
          ? workItem.continuationRepetitions
          : action.parameters.repetition
      : null;
    const coordinate = {
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      attemptId: prepared.attemptId,
      workId: workItem.workId,
      environmentId: workItem.environmentId,
      pathProfileId: workItem.pathProfileId,
      rowId: workItem.rowId,
      variantId: workItem.variantId,
      repetition,
    };
    const path = probeControllerActionAttestationPath({
      coordinate,
      producerActionId: action.actionId,
    });
    const artifact = await store.readArtifact(path);
    const attestation = validateProbeControllerActionAttestation(
      parseCanonicalObject(artifact.bytes, "controller action attestation"),
    );
    if (attestation.attestationSha256 !== event.actionAttestationSha256) {
      fail(
        "RUNTIME_ACTION_ATTESTATION",
        "retained producing-action attestation differs from the source command",
      );
    }
    if (
      attestation.producerActionId !== action.actionId ||
      !canonicalEqual(attestation.coordinate, coordinate)
    ) {
      fail(
        "RUNTIME_ACTION_ATTESTATION",
        "retained producing-action attestation differs from the frozen action authority",
      );
    }
    seen.add(event.actionAttestationSha256);
    bytes.push(Buffer.from(artifact.bytes));
  }
  return bytes;
}

async function reduceRuntimeSourceTranscript({
  store,
  prepared,
  candidate,
  workItem,
  sourceTranscriptBytes,
  controllerReceipt,
  nativeTranscripts,
}) {
  const definition = trustedTranscriptDefinition(workItem, candidate);
  const controller = prepared.executionBundleManifest.controller;
  const sourceTranscript = parseCanonicalObject(sourceTranscriptBytes, "source transcript");
  const controllerActionAttestationBytes = await loadControllerActionAttestationBytes({
    store,
    prepared,
    workItem,
    sourceTranscript,
  });
  return reduceProbeSourceTranscript({
    sourceTranscriptBytes,
    expectedBinding: sourceTranscriptBinding(prepared, workItem, definition.verifierSourceSha256),
    expectedProducer: sourceTranscriptProducer(
      prepared,
      definition.transcriptKind === "windows-host-probe-native-transcript"
        ? "native-helper"
        : "external-controller",
    ),
    expectedController: {
      identitySha256: controller.identitySha256,
      publicKeySha256: controller.publicKeySha256,
      version: controller.version,
    },
    controllerPublicKeyBytes: await controllerPublicKey(store, prepared),
    controllerReceipt,
    trustedNativeTranscripts: nativeTranscripts,
    trustedControllerActionAttestationBytes: controllerActionAttestationBytes,
    trustedDefinition: definition,
  });
}

function sourceTranscriptReceiptFields(sourceTranscript, sourceTranscriptSha256, prepared) {
  const controller = prepared.executionBundleManifest.controller;
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-controller-source-transcript-receipt",
    sourceTranscriptSha256,
    bindingSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-source-transcript-binding.v1",
      binding: sourceTranscript.binding,
    }),
    producerKind: sourceTranscript.producer.kind,
    producerIdentitySha256: sourceTranscript.producer.identitySha256,
    nativeTranscriptSetSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-native-transcript-set.v1",
      nativeTranscripts: sourceTranscript.nativeTranscripts,
    }),
    controllerIdentitySha256: controller.identitySha256,
    controllerPublicKeySha256: controller.publicKeySha256,
    controllerVersion: controller.version,
    signatureAlgorithm: "Ed25519",
  };
}

async function signAndVerifySourceTranscriptReceipt({
  store,
  prepared,
  candidate,
  command,
  workItem,
  sourceTranscript,
  sourceTranscriptBytes,
  nativeTranscripts,
  controllerTransport,
}) {
  const sourceTranscriptSha256 = sha256(sourceTranscriptBytes);
  const receiptFields = sourceTranscriptReceiptFields(
    sourceTranscript,
    sourceTranscriptSha256,
    prepared,
  );
  const receiptSha256 = deriveControllerSourceTranscriptReceiptDigest(receiptFields);
  const signed = await controllerTransport.signSourceTranscriptReceipt(
    deepFreeze({
      receiptSha256,
      receiptFields,
      sourceTranscriptSha256,
      command,
      workItem,
      preparedContext: prepared,
      evidenceRoot: store.root,
    }),
  );
  assertExactKeys(signed, ["signatureBase64"], [], "source transcript signature result");
  if (typeof signed.signatureBase64 !== "string" || signed.signatureBase64.length === 0) {
    fail("RUNTIME_TRANSCRIPT_SIGNATURE", "source transcript signer returned no signature");
  }
  const controllerReceipt = deepFreeze({
    ...receiptFields,
    signatureBase64: signed.signatureBase64,
    receiptSha256,
  });
  await reduceRuntimeSourceTranscript({
    store,
    prepared,
    candidate,
    workItem,
    sourceTranscriptBytes,
    controllerReceipt,
    nativeTranscripts,
  });
  return controllerReceipt;
}

async function retainSourceTranscript({
  store,
  paths,
  prepared,
  candidate,
  command,
  workItem,
  capture,
  actionCaptures,
  disposition,
  primaryObserverTranscriptSha256s,
  nativeTransport,
  controllerTransport,
}) {
  await verifyScenarioEvidence(store, paths, capture.evidenceArtifacts);
  const observerNativeTranscriptSha256s = validateObserverNativeTranscriptSha256s(
    primaryObserverTranscriptSha256s,
    "verified controller observer transcript identities",
  );
  const nativeTranscripts = await retainNativeTranscripts({
    store,
    paths,
    prepared,
    command,
    workItem,
    commandEvents: capture.commandEvents,
    additionalTranscriptSha256s: observerNativeTranscriptSha256s,
    locallyRetainedTranscriptSha256s: observerNativeTranscriptSha256s,
    nativeTransport,
  });
  const definition = trustedTranscriptDefinition(workItem, candidate);
  const producerKind =
    definition.transcriptKind === "windows-host-probe-native-transcript"
      ? "native-helper"
      : "external-controller";
  if (capture.transcriptProducerKind !== producerKind) {
    fail("RUNTIME_TRANSCRIPT", "scenario producer differs from the trusted transcript mapping");
  }
  const producingActionAttestations = collectProducingActionAttestations(actionCaptures);
  const sourceCommandEvents = capture.commandEvents.map((event) => {
    const key = commandEventIdentity(event);
    if (!producingActionAttestations.has(key)) {
      fail("RUNTIME_ACTION_ATTESTATION", "scenario command event has no producing action");
    }
    return {
      ...event,
      actionAttestationSha256: producingActionAttestations.get(key),
      nativeTranscriptSha256s: [...event.nativeTranscriptSha256s],
    };
  });
  const sourceTranscript = deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-source-transcript",
    producer: sourceTranscriptProducer(prepared, producerKind),
    binding: sourceTranscriptBinding(prepared, workItem, definition.verifierSourceSha256),
    nativeTranscripts: nativeTranscripts.map(({ transcriptSha256, binding }) => ({
      transcriptSha256,
      binding,
    })),
    observerNativeTranscriptSha256s,
    captureComplete: disposition.captureComplete,
    availability: disposition.availability,
    commandEvents: sourceCommandEvents,
  });
  const sourceTranscriptBytes = Buffer.from(canonicalProbeJson(sourceTranscript), "utf8");
  const controllerReceipt = await signAndVerifySourceTranscriptReceipt({
    store,
    prepared,
    candidate,
    command,
    workItem,
    sourceTranscript,
    sourceTranscriptBytes,
    nativeTranscripts,
    controllerTransport,
  });
  const sourceArtifact = await retainExactBytes(
    store,
    paths.sourceTranscript,
    sourceTranscriptBytes,
  );
  const receiptArtifact = await retainExactCanonical(
    store,
    paths.sourceTranscriptReceipt,
    controllerReceipt,
  );
  return deepFreeze({
    sourceTranscriptSha256: sourceArtifact.sha256,
    sourceTranscriptReceiptSha256: receiptArtifact.sha256,
    nativeTranscriptSha256s: nativeTranscripts.map(({ transcriptSha256 }) => transcriptSha256),
  });
}

async function recoverSourceTranscript({
  store,
  paths,
  prepared,
  candidate,
  command,
  workItem,
  verifyExternalActionSet,
  nativeTransport,
  controllerTransport,
}) {
  const sourceArtifact = await readOptionalArtifact(store, paths.sourceTranscript);
  const receiptArtifact = await readOptionalArtifact(store, paths.sourceTranscriptReceipt);
  if (sourceArtifact === null && receiptArtifact === null) return null;
  if (sourceArtifact === null) {
    fail("RUNTIME_TRANSCRIPT_INCOMPLETE", "source transcript retention is incomplete");
  }
  const sourceTranscript = parseCanonicalObject(sourceArtifact.bytes, "source transcript");
  if (!Array.isArray(sourceTranscript.commandEvents)) {
    fail("RUNTIME_TRANSCRIPT", "source transcript commandEvents must be an array");
  }
  if (!Array.isArray(sourceTranscript.nativeTranscripts)) {
    fail("RUNTIME_TRANSCRIPT", "source transcript nativeTranscripts must be an array");
  }
  const observerNativeTranscriptSha256s = validateObserverNativeTranscriptSha256s(
    sourceTranscript.observerNativeTranscriptSha256s,
    "retained source observer transcript identities",
  );
  if (typeof verifyExternalActionSet === "function") {
    const verifiedObserverNativeTranscriptSha256s = validateObserverNativeTranscriptSha256s(
      await verifyExternalActionSet(),
      "reverified controller observer transcript identities",
    );
    if (!canonicalEqual(observerNativeTranscriptSha256s, verifiedObserverNativeTranscriptSha256s)) {
      fail(
        "RUNTIME_CONTROLLER_OBSERVER_TRANSCRIPT",
        "retained source observer classification differs from verified action provenance",
      );
    }
  }
  const nativeTranscripts = await retainNativeTranscripts({
    store,
    paths,
    prepared,
    command,
    workItem,
    commandEvents: sourceTranscript.commandEvents,
    additionalTranscriptSha256s: sourceTranscript.nativeTranscripts.map(
      ({ transcriptSha256 }) => transcriptSha256,
    ),
    locallyRetainedTranscriptSha256s: observerNativeTranscriptSha256s,
    nativeTransport,
  });
  let retainedReceipt = receiptArtifact;
  if (retainedReceipt === null) {
    const controllerReceipt = await signAndVerifySourceTranscriptReceipt({
      store,
      prepared,
      candidate,
      command,
      workItem,
      sourceTranscript,
      sourceTranscriptBytes: sourceArtifact.bytes,
      nativeTranscripts,
      controllerTransport,
    });
    await retainExactCanonical(store, paths.sourceTranscriptReceipt, controllerReceipt);
    retainedReceipt = await store.readArtifact(paths.sourceTranscriptReceipt);
  } else {
    const controllerReceipt = parseCanonicalObject(
      retainedReceipt.bytes,
      "source transcript receipt",
    );
    await reduceRuntimeSourceTranscript({
      store,
      prepared,
      candidate,
      workItem,
      sourceTranscriptBytes: sourceArtifact.bytes,
      controllerReceipt,
      nativeTranscripts,
    });
  }
  return deepFreeze({
    sourceTranscriptSha256: sourceArtifact.sha256,
    sourceTranscriptReceiptSha256: retainedReceipt.sha256,
    nativeTranscriptSha256s: nativeTranscripts.map(({ transcriptSha256 }) => transcriptSha256),
  });
}

function validatePreparedForCommand(prepared, command, candidate, attestation) {
  const validated = validatePreparedProbeContext(prepared);
  if (
    validated.campaignRunId !== command.campaignRunId ||
    validated.attemptId !== command.attemptId ||
    validated.environmentId !== command.environmentId ||
    validated.pathProfileId !== command.pathProfileId ||
    validated.candidateSha256 !== candidate.candidateSha256 ||
    validated.labAttestationSha256 !== attestation.attestationSha256
  ) {
    fail("RUNTIME_PREPARED_BINDING", "prepared context differs from the runner command");
  }
  if (
    command.command === "prepare" &&
    (validated.executionRunId !== command.executionRunId ||
      validated.executionBundleId !== command.executionBundleId)
  ) {
    fail("RUNTIME_PREPARED_BINDING", "prepared context differs from the prepare command");
  }
  return validated;
}

function validatePreflightRequestForCommand(request, command) {
  if (
    !exactObject(request) ||
    request.campaignRunId !== command.campaignRunId ||
    request.executionRunId !== command.executionRunId ||
    request.executionBundleId !== command.executionBundleId ||
    request.attemptId !== command.attemptId ||
    request.environmentId !== command.environmentId ||
    request.pathProfileId !== command.pathProfileId
  ) {
    fail("RUNTIME_PREFLIGHT_REQUEST", "preflight request differs from the prepare command");
  }
  return request;
}

function requireScenarioCapabilities(definition, attestation) {
  for (const capabilityId of definition.prerequisites.attestationCapabilityIds) {
    if (!Object.hasOwn(attestation.capabilities, capabilityId)) {
      fail("RUNTIME_CAPABILITY", `scenario requires unknown capability: ${capabilityId}`);
    }
    if (attestation.capabilities[capabilityId] !== true) {
      fail("RUNTIME_CAPABILITY", `scenario capability is unavailable: ${capabilityId}`);
    }
  }
}

function validateCheckpointRequest(
  request,
  {
    command,
    prepared,
    attestation,
    chain,
    preCutStateSha256,
    expectedPreCutBootIdSha256,
    controllerPublicKeyBytes,
  },
) {
  assertExactKeys(request, checkpointRequestKeys, [], "hard-cut request");
  const expected = {
    schemaVersion: 1,
    kind: "windows-host-probe-hard-cut-request",
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    checkpointId: command.checkpointId,
    sequence: command.repetition,
    sourceVmSnapshotId: prepared.vmSnapshotId,
    continuationScopeSha256: chain.header.scopeSha256,
    controllerIdentitySha256: attestation.controller.identitySha256,
    controllerPublicKeySha256: attestation.controller.publicKeySha256,
    controllerVersion: attestation.controller.version,
    action: "hard-power-cut",
    signatureAlgorithm: "Ed25519",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (request[key] !== value) {
      fail("RUNTIME_CHECKPOINT_REQUEST", `hard-cut request has another ${key}`);
    }
  }
  for (const key of ["nonceSha256", "preCutStateSha256", "preCutBootIdSha256", "requestSha256"]) {
    requireSha256(request[key], `hard-cut request ${key}`);
  }
  if (request.preCutStateSha256 !== preCutStateSha256) {
    fail("RUNTIME_CHECKPOINT_REQUEST", "hard-cut request differs from retained pre-cut state");
  }
  if (request.requestSha256 !== deriveExternalCheckpointRequestDigest(request)) {
    fail("RUNTIME_CHECKPOINT_REQUEST", "hard-cut request digest is invalid");
  }
  if (request.preCutBootIdSha256 !== expectedPreCutBootIdSha256) {
    fail("RUNTIME_CHECKPOINT_BOOT_CHAIN", "hard-cut request breaks the verified boot chain");
  }
  verifyExternalCheckpointRequestSignature(request, controllerPublicKeyBytes);
  return deepFreeze(request);
}

function hardCutPreStateSha256(command, capture) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-runtime-hard-cut-pre-state.v1",
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    repetition: command.repetition,
    capture,
  });
}

function runtimeCheckpointSegment(prepared, command) {
  return {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    provenance: {
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      executionBundleId: prepared.executionBundleId,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      attemptId: prepared.attemptId,
      vmSnapshotId: prepared.vmSnapshotId,
      bootIdSha256: prepared.bootIdSha256,
    },
  };
}

function runtimeContinuationReference(chain, checkpointEvidence) {
  requireSha256(chain.previousEntrySha256, "hard-cut continuation terminal entry");
  return {
    repetition: chain.header.repetition,
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    headerSha256: chain.header.headerSha256,
    terminalEntrySha256: chain.previousEntrySha256,
    receiptSha256: checkpointEvidence.receipt.receiptSha256,
  };
}

function verifyRuntimeCheckpointEvidence({
  prepared,
  command,
  chain,
  checkpointEvidence,
  attestation,
  controllerPublicKeyBytes,
  expectedPreCutBootIdSha256,
}) {
  return validateExternalCheckpointEvidence(checkpointEvidence, {
    segment: runtimeCheckpointSegment(prepared, command),
    continuation: runtimeContinuationReference(chain, checkpointEvidence),
    repetition: command.repetition,
    replayRegistry: createExternalCheckpointReplayRegistry(),
    expectedController: attestation.controller,
    controllerPublicKeyBytes,
    expectedPreCutBootIdSha256,
  });
}

function actionResultFromPartialCapture(capture) {
  return deepFreeze({
    actionId: capture.actionIds[0],
    commandEvent: capture.commandEvents.length === 0 ? null : capture.commandEvents[0],
    evidenceArtifacts: capture.evidenceArtifacts,
  });
}

async function composeScenarioCapture(definition, captures) {
  const captureByActionId = new Map();
  for (const capture of captures) {
    if (capture.actionIds.length !== 1 || captureByActionId.has(capture.actionIds[0])) {
      fail("RUNTIME_ACTION_CAPTURE", "scenario partial captures are not an exact action set");
    }
    captureByActionId.set(capture.actionIds[0], capture);
  }
  if (
    captureByActionId.size !== definition.actions.length ||
    definition.actions.some(({ actionId }) => !captureByActionId.has(actionId))
  ) {
    fail("RUNTIME_ACTION_CAPTURE", "scenario partial captures do not close the action plan");
  }
  const replay = (invocation) =>
    actionResultFromPartialCapture(captureByActionId.get(invocation.action.actionId));
  return executeProbeScenario({
    rowId: definition.rowId,
    variantId: definition.variantId,
    invokeNative: replay,
    invokeController: replay,
  });
}

function collectPrimaryObserverTranscriptSha256s(actionCaptures) {
  return [
    ...new Set(
      actionCaptures.flatMap(
        ({ primaryObserverTranscriptSha256s }) => primaryObserverTranscriptSha256s,
      ),
    ),
  ].sort(compareUtf8);
}

function commandEventIdentity(event) {
  return `${event.sequence}\0${event.commandId}`;
}

function collectProducingActionAttestations(actionCaptures) {
  const attestations = new Map();
  for (const actionCapture of actionCaptures) {
    for (const event of actionCapture.capture.commandEvents) {
      const key = commandEventIdentity(event);
      if (attestations.has(key)) {
        fail("RUNTIME_ACTION_ATTESTATION", "scenario command event has multiple producing actions");
      }
      const digest = actionCapture.actionAttestationSha256;
      if (event.producerKind === "external-controller") {
        requireSha256(digest, `controller command event ${event.commandId} action attestation`);
      } else if (digest !== null) {
        fail(
          "RUNTIME_ACTION_ATTESTATION",
          "native command event cannot inherit a controller action attestation",
        );
      }
      attestations.set(key, digest);
    }
  }
  return attestations;
}

async function reverifyOrdinaryExternalActionSet({
  store,
  preparedContext,
  command,
  definition,
  paths,
  verifyController,
}) {
  if (definition.continuation.kind === "external-hard-cut") {
    fail(
      "RUNTIME_ACTION_AUTHORITY",
      "ordinary action receipt recovery cannot authorize the hard-cut continuation seam",
    );
  }
  const verified = [];
  for (const action of definition.actions) {
    if (action.actor !== "external-controller") continue;
    verified.push(
      await executeOrLoadPartialCapture({
        store,
        preparedContext,
        command,
        actionId: action.actionId,
        paths,
        verifyController,
      }),
    );
  }
  return collectPrimaryObserverTranscriptSha256s(verified);
}

function validateHardCutReadResult(value, request, command) {
  assertExactKeys(
    value,
    ["checkpointEvidence", "actionExecutionReceipt", "actionAcknowledgment"],
    [],
    "hard-cut receipt read result",
  );
  assertExactKeys(
    value.checkpointEvidence,
    ["request", "receipt"],
    [],
    "hard-cut checkpoint evidence",
  );
  if (!canonicalEqual(value.checkpointEvidence.request, request)) {
    fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut receipt answers another request");
  }
  const checkpointReceipt = value.checkpointEvidence.receipt;
  if (!exactObject(checkpointReceipt) || !Array.isArray(checkpointReceipt.artifactHashes)) {
    fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut receipt has no artifact hash set");
  }
  const actionExecutionReceipt = validateProbeControllerActionExecutionReceipt(
    value.actionExecutionReceipt,
  );
  const expectedActionId = `hard-cut-guest-r${command.repetition}`;
  if (
    actionExecutionReceipt.producerActionId !== expectedActionId ||
    actionExecutionReceipt.actionResult.actionId !== expectedActionId ||
    actionExecutionReceipt.coordinate.campaignRunId !== command.campaignRunId ||
    actionExecutionReceipt.coordinate.attemptId !== command.attemptId ||
    actionExecutionReceipt.coordinate.workId !== command.workId ||
    actionExecutionReceipt.coordinate.environmentId !== command.environmentId ||
    actionExecutionReceipt.coordinate.pathProfileId !== command.pathProfileId ||
    actionExecutionReceipt.coordinate.rowId !== command.rowId ||
    actionExecutionReceipt.coordinate.variantId !== command.variantId ||
    actionExecutionReceipt.coordinate.repetition !== command.repetition
  ) {
    fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut action receipt names another coordinate");
  }
  for (const artifact of checkpointReceipt.artifactHashes) {
    if (!exactObject(artifact) || typeof artifact.path !== "string") {
      fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut evidence declaration is invalid");
    }
    requireSha256(artifact.sha256, `hard-cut evidence ${artifact.path}`);
  }
  if (
    !canonicalEqual(actionExecutionReceipt.proofArtifacts, checkpointReceipt.artifactHashes) ||
    !canonicalEqual(
      actionExecutionReceipt.actionResult.evidenceArtifacts,
      checkpointReceipt.artifactHashes,
    )
  ) {
    fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut action proof differs from checkpoint receipt");
  }
  const actionAcknowledgment = validateControllerActionAcknowledgment(
    value.actionAcknowledgment,
    actionExecutionReceipt.operation.operationId,
    actionExecutionReceipt.actionResultArtifact,
    expectedActionId,
  );
  const observerTranscriptSha256s = actionExecutionReceipt.observerTranscripts
    .map(({ transcriptSha256 }) => transcriptSha256)
    .sort(compareUtf8);
  if (
    actionAcknowledgment.receiptSha256 !== actionExecutionReceipt.receiptSha256 ||
    !canonicalEqual(
      actionAcknowledgment.primaryObserverTranscriptSha256s,
      observerTranscriptSha256s,
    )
  ) {
    fail("RUNTIME_CHECKPOINT_RECEIPT", "hard-cut acknowledgment differs from signed receipt");
  }
  return deepFreeze({
    checkpointEvidence: value.checkpointEvidence,
    actionExecutionReceipt,
    actionAcknowledgment,
  });
}

function hardCutReceiptReadInput({
  command,
  workItem,
  prepared,
  attestation,
  request,
  dependencies,
  evidenceRoot,
}) {
  return deepFreeze({
    command,
    workItem,
    preparedContext: prepared,
    attestation,
    request,
    dependencies,
    evidenceRoot,
  });
}

async function verifyHardCutTransportResult({
  store,
  command,
  readInput,
  verifyHardCutReceipt,
  expected = null,
}) {
  const verified = validateHardCutReadResult(
    await verifyHardCutReceipt(readInput),
    readInput.request,
    command,
  );
  if (expected !== null && !canonicalEqual(expected, verified)) {
    fail(
      "RUNTIME_CHECKPOINT_EQUIVOCATION",
      "retained hard-cut record differs from offline-verified controller authority",
    );
  }
  await store.verifyArtifactSet(verified.checkpointEvidence.receipt.artifactHashes);
  return verified;
}

async function retainedHardCutAuthorityState(store, command) {
  const coordinate = {
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    producerActionId: `hard-cut-guest-r${command.repetition}`,
  };
  const paths = probeControllerActionProvenancePaths(coordinate);
  const authorityPaths = [
    paths.receipt,
    paths.provenance,
    paths.controllerRequest,
    paths.operationRequest,
    paths.controllerResponse,
    paths.operationResponse,
  ];
  const commit = await readOptionalArtifact(
    store,
    probeControllerActionCommitMarkerPath(coordinate),
  );
  if (commit !== null) return "complete";
  for (const path of authorityPaths) {
    if ((await readOptionalArtifact(store, path)) !== null) return "partial";
  }
  return "absent";
}

async function recoverStagedHardCutResult({
  store,
  command,
  request,
  readInput,
  verifyHardCutReceipt,
}) {
  const directory = stagedCheckpointResultDirectory(command, request);
  let entries;
  try {
    entries = await store.list(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const validResults = [];
  for (const entry of entries) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name);
    if (entry.kind !== "file" || match === null) {
      fail("RUNTIME_CHECKPOINT_RECOVERY", "staged hard-cut directory is malformed");
    }
    const artifact = await store.readArtifact(`${directory}/${entry.name}`);
    const staged = validateHardCutReadResult(
      parseCanonicalObject(artifact.bytes, "staged hard-cut receipt read result"),
      request,
      command,
    );
    if (hashProbeCanonicalJson(staged) !== match[1]) {
      fail("RUNTIME_CHECKPOINT_RECOVERY", "staged hard-cut result has another identity");
    }
    validResults.push(
      await verifyHardCutTransportResult({
        store,
        command,
        readInput,
        verifyHardCutReceipt,
        expected: staged,
      }),
    );
  }
  if (validResults.length > 1) {
    fail(
      "RUNTIME_CHECKPOINT_EQUIVOCATION",
      "multiple signed hard-cut results claim the same request",
    );
  }
  return validResults[0] ?? null;
}

async function readHardCutResult({
  store,
  command,
  workItem,
  prepared,
  attestation,
  chain,
  request,
  dependencies,
  readHardCutReceipt,
  verifyHardCutReceipt,
}) {
  const path = checkpointResumePath(command);
  const readInput = hardCutReceiptReadInput({
    command,
    workItem,
    prepared,
    attestation,
    request,
    dependencies,
    evidenceRoot: store.root,
  });
  const retained = await readOptionalArtifact(store, path);
  if (retained !== null) {
    const retainedValue = validateHardCutReadResult(
      parseCanonicalObject(retained.bytes, "hard-cut receipt read result"),
      request,
      command,
    );
    const value = await verifyHardCutTransportResult({
      store,
      command,
      readInput,
      verifyHardCutReceipt,
      expected: retainedValue,
    });
    const staged = await recoverStagedHardCutResult({
      store,
      command,
      request,
      readInput,
      verifyHardCutReceipt,
    });
    if (staged === null || !canonicalEqual(staged, value)) {
      fail("RUNTIME_CHECKPOINT_RECOVERY", "retained hard-cut resume has no exact staged authority");
    }
    return { value, retained: true, path, readInput };
  }
  if (chain.closure !== null) {
    if (chain.closure.kind !== "windows-host-probe-consumed-external-receipt") {
      fail("RUNTIME_CHECKPOINT_RECOVERY", "hard-cut continuation has a local closure");
    }
    const value = await recoverStagedHardCutResult({
      store,
      command,
      request,
      readInput,
      verifyHardCutReceipt,
    });
    if (value === null) {
      fail(
        "RUNTIME_CHECKPOINT_RECOVERY",
        "closed hard-cut continuation has no staged controller result",
      );
    }
    if (!canonicalEqual(value.checkpointEvidence, chain.closure.checkpointEvidence)) {
      fail("RUNTIME_CHECKPOINT_RECOVERY", "staged result differs from continuation closure");
    }
    return { value, retained: false, path, readInput };
  }
  const staged = await recoverStagedHardCutResult({
    store,
    command,
    request,
    readInput,
    verifyHardCutReceipt,
  });
  if (staged !== null) return { value: staged, retained: false, path, readInput };
  let value;
  if ((await retainedHardCutAuthorityState(store, command)) === "complete") {
    value = await verifyHardCutTransportResult({
      store,
      command,
      readInput,
      verifyHardCutReceipt,
    });
  } else {
    const invoked = validateHardCutReadResult(
      await readHardCutReceipt(readInput),
      request,
      command,
    );
    value = await verifyHardCutTransportResult({
      store,
      command,
      readInput,
      verifyHardCutReceipt,
      expected: invoked,
    });
  }
  await retainExactCanonical(store, stagedCheckpointResultPath(command, request, value), value);
  return { value, retained: false, path, readInput };
}

async function verifyRetainedHardCutRecord({
  store,
  command,
  workItem,
  prepared,
  attestation,
  dependencies,
  verifyHardCutReceipt,
}) {
  const artifact = await store.readArtifact(checkpointResumePath(command));
  const retained = parseCanonicalObject(artifact.bytes, `hard-cut resume ${command.repetition}`);
  const request = retained.checkpointEvidence?.request;
  const validated = validateHardCutReadResult(retained, request, command);
  const readInput = hardCutReceiptReadInput({
    command,
    workItem,
    prepared,
    attestation,
    request,
    dependencies,
    evidenceRoot: store.root,
  });
  const verified = await verifyHardCutTransportResult({
    store,
    command,
    readInput,
    verifyHardCutReceipt,
    expected: validated,
  });
  const staged = await recoverStagedHardCutResult({
    store,
    command,
    request,
    readInput,
    verifyHardCutReceipt,
  });
  if (staged === null || !canonicalEqual(staged, verified)) {
    fail("RUNTIME_CHECKPOINT_RECOVERY", "retained hard-cut resume has no exact staged authority");
  }
  return verified;
}

async function expectedPreCutBootIdForRepetition({
  store,
  prepared,
  attestation,
  command,
  workItem,
  dependencies,
  paths,
  verifyHardCutReceipt,
  controllerPublicKeyBytes,
}) {
  let expectedPreCutBootIdSha256 = prepared.bootIdSha256;
  for (let repetition = 1; repetition < command.repetition; repetition += 1) {
    const { pointer, chain } = await loadContinuationPointer(store, command, repetition, {
      requireClosed: true,
      expectedClosureKind: "external",
    });
    const repetitionCommand = {
      ...command,
      repetition,
      checkpointId: `checkpoint-${repetition}`,
      chainId: pointer.chainId,
    };
    const validated = await verifyRetainedHardCutRecord({
      store,
      command: repetitionCommand,
      workItem,
      prepared,
      attestation,
      dependencies,
      verifyHardCutReceipt,
    });
    verifyRuntimeCheckpointEvidence({
      prepared,
      command: repetitionCommand,
      chain,
      checkpointEvidence: validated.checkpointEvidence,
      attestation,
      controllerPublicKeyBytes,
      expectedPreCutBootIdSha256,
    });
    await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command: repetitionCommand,
      actionId: `hard-cut-guest-r${repetition}`,
      paths,
      verifiedHardCutReceipt: validated,
    });
    expectedPreCutBootIdSha256 = validated.checkpointEvidence.receipt.postBootBootIdSha256;
  }
  return expectedPreCutBootIdSha256;
}

async function ensureFinalizationStart(store, command, now) {
  const path = finalizationStartPath(command);
  const retained = await readOptionalArtifact(store, path);
  if (retained !== null) {
    const value = parseCanonicalObject(retained.bytes, "finalization start");
    assertExactKeys(
      value,
      ["schemaVersion", "kind", "campaignRunId", "attemptId", "workId", "startedAt"],
      [],
      "finalization start",
    );
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "windows-host-probe-runtime-finalization-start" ||
      value.campaignRunId !== command.campaignRunId ||
      value.attemptId !== command.attemptId ||
      value.workId !== command.workId ||
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt))
    ) {
      fail("RUNTIME_FINALIZATION_START", "retained finalization start differs");
    }
    return value;
  }
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    fail("RUNTIME_CLOCK", "runtime clock returned an invalid finalization instant");
  }
  const value = {
    schemaVersion: 1,
    kind: "windows-host-probe-runtime-finalization-start",
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    startedAt: instant.toISOString(),
  };
  await retainExactCanonical(store, path, value);
  return deepFreeze(value);
}

function currentMonotonic(monotonicNow) {
  const value = monotonicNow();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("RUNTIME_CLOCK", "runtime monotonic clock returned an invalid value");
  }
  return value;
}

export function createProbeAuthoritativeRuntime(configuration) {
  const suppliedConfig = validateRuntimeConfig(configuration);
  if (!Array.isArray(suppliedConfig.attestations)) {
    fail("RUNTIME_ATTESTATION", "attestations must be an array");
  }
  const config = Object.freeze({
    ...suppliedConfig,
    attestations: Object.freeze([...suppliedConfig.attestations]),
    runAuthorization: deepFreeze(
      JSON.parse(
        canonicalProbeJson(validateProbeRunAuthorization(suppliedConfig.runAuthorization)),
      ),
    ),
    brokerEnrollments: validateProbeBrokerEnrollmentInventory(suppliedConfig.brokerEnrollments),
    lifecyclePolicy: deepFreeze(JSON.parse(canonicalProbeJson(suppliedConfig.lifecyclePolicy))),
    nativeTransport: Object.freeze({ ...suppliedConfig.nativeTransport }),
    controllerTransport: Object.freeze({ ...suppliedConfig.controllerTransport }),
  });
  const candidate = deepFreeze(
    JSON.parse(canonicalProbeJson(validateProbeCandidateIdentity(config.candidate))),
  );
  const attestationByEnvironment = new Map();
  for (const rawAttestation of config.attestations) {
    const attestation = deepFreeze(
      JSON.parse(canonicalProbeJson(validateLabAttestation(rawAttestation))),
    );
    if (attestationByEnvironment.has(attestation.environmentId)) {
      fail("RUNTIME_ATTESTATION", "attestations contain a duplicate environment");
    }
    attestationByEnvironment.set(attestation.environmentId, attestation);
  }
  for (const environmentId of PROBE_CAMPAIGN_MANIFEST.environmentIds) {
    if (!attestationByEnvironment.has(environmentId)) {
      fail("RUNTIME_ATTESTATION", `attestation is missing for ${environmentId}`);
    }
  }
  const authorizedAttestations = [...attestationByEnvironment.values()]
    .map(({ environmentId, attestationSha256 }) => ({ environmentId, attestationSha256 }))
    .sort((left, right) =>
      Buffer.from(left.environmentId).compare(Buffer.from(right.environmentId)),
    );
  if (
    config.runAuthorization.candidateSha256 !== candidate.candidateSha256 ||
    config.runAuthorization.campaignRunId !== config.campaignRunId ||
    config.runAuthorization.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    !canonicalEqual(config.runAuthorization.attestations, authorizedAttestations)
  ) {
    fail("RUNTIME_RUN_AUTHORIZATION", "run authorization differs from the configured run");
  }
  validateProbeRunPlan(PROBE_RUN_PLAN);

  const stores = new Map();
  const preflightReaders = new Map();
  const finalizerAdapters = new Map();

  function assertCampaign(command) {
    if (command.campaignRunId !== config.campaignRunId) {
      fail("RUNTIME_CAMPAIGN", "runner command belongs to another configured campaign run");
    }
  }

  function assertDispatchPlan(plan) {
    const validated = validateProbeRunPlan(plan);
    if (!canonicalEqual(validated, PROBE_RUN_PLAN)) {
      fail("RUNTIME_DISPATCH_PLAN", "runner dispatch plan differs from the frozen run plan");
    }
  }

  function trustedDispatchWorkItem(command, plan, suppliedWorkItem) {
    assertDispatchPlan(plan);
    const trustedWorkItem = getProbeRunWorkItem(command);
    if (
      command.workId !== trustedWorkItem.workId ||
      !canonicalEqual(suppliedWorkItem, trustedWorkItem)
    ) {
      fail("RUNTIME_DISPATCH_WORK_ITEM", "runner work item differs from the frozen run plan");
    }
    return trustedWorkItem;
  }

  function getAttestation(environmentId) {
    const attestation = attestationByEnvironment.get(environmentId);
    if (attestation === undefined) {
      fail("RUNTIME_ATTESTATION", `no attestation is configured for ${environmentId}`);
    }
    return attestation;
  }

  async function resolveStore(environmentId, pathProfileId) {
    const key = `${environmentId}\0${pathProfileId}`;
    let promise = stores.get(key);
    if (promise === undefined) {
      promise = Promise.resolve(
        config.resolveStore(
          deepFreeze({
            campaignRunId: config.campaignRunId,
            environmentId,
            pathProfileId,
          }),
        ),
      ).then(requireEvidenceStore);
      stores.set(key, promise);
    }
    const store = await promise;
    await store.assertRootStable();
    return store;
  }

  async function readersFor(store) {
    let promise = preflightReaders.get(store);
    if (promise === undefined) {
      promise = createProbePreflightReaders({
        store,
        repositoryRoot: config.repositoryRoot,
        binaryRoot: config.binaryRoot,
        candidate,
        observeGuest: config.nativeTransport.observeGuest,
        observeBrokerMailbox: config.brokerTransport.observeBrokerMailbox,
        controllerTransport: config.controllerTransport,
        readRepositoryIdentity: config.readRepositoryIdentity,
      });
      preflightReaders.set(store, promise);
    }
    return promise;
  }

  async function verifyRetainedRunAuthorizationClaim(store, attestation, claim) {
    return verifyProbeRunAuthorizationClaimReceipt(claim, {
      authorization: config.runAuthorization,
      attestation,
      controllerPublicKeyBytes: await attestedControllerPublicKey(store, attestation),
      evidenceRootObjectIdentitySha256: claim.evidenceRootObjectIdentitySha256,
    });
  }

  async function loadRunAuthorizationClaim(store, attestation) {
    const artifact = await store.readArtifact(runAuthorizationClaimPath(attestation.environmentId));
    const claim = validateProbeRunAuthorizationClaimReceipt(
      parseCanonicalObject(artifact.bytes, "run authorization claim"),
    );
    await verifyRetainedRunAuthorizationClaim(store, attestation, claim);
    return claim;
  }

  async function runAuthorizationClaimForPreparation({ store, attestation, request, readers }) {
    await retainExactCanonical(store, retainedRunAuthorizationPath, config.runAuthorization);
    const claimPath = runAuthorizationClaimPath(attestation.environmentId);
    const retained = await readOptionalArtifact(store, claimPath);
    if (retained !== null) {
      const claim = validateProbeRunAuthorizationClaimReceipt(
        parseCanonicalObject(retained.bytes, "run authorization claim"),
      );
      await verifyRetainedRunAuthorizationClaim(store, attestation, claim);
      return { claim, readers };
    }
    const requestSha256 = deriveProbePreparationRequestDigest(request);
    const transactionValue = await readers.readPreparationTransaction(requestSha256);
    if (transactionValue !== null) {
      validateProbePreparationTransaction(transactionValue);
      fail(
        "RUNTIME_RUN_AUTHORIZATION_CLAIM",
        "retained preparation transaction has no retained authorization claim",
      );
    }
    const guestObservation = await readers.observeGuest(request);
    const evidenceRootObjectIdentitySha256 =
      guestObservation?.pathProfile?.evidenceRootObjectIdentitySha256;
    requireSha256(
      evidenceRootObjectIdentitySha256,
      "guest observation evidence root object identity",
    );
    const controllerVerificationInput = deepFreeze({
      runAuthorization: config.runAuthorization,
      request,
      candidateSha256: candidate.candidateSha256,
      campaignRunId: config.campaignRunId,
      attestations: [...attestationByEnvironment.values()],
      currentAttestation: attestation,
      evidenceRootObjectIdentitySha256,
      evidenceRoot: store.root,
    });
    const claim = validateProbeRunAuthorizationClaimReceipt(
      await config.controllerTransport.verifyRunAuthorization(controllerVerificationInput),
    );
    verifyProbeRunAuthorizationClaimReceipt(claim, {
      authorization: config.runAuthorization,
      attestation,
      controllerPublicKeyBytes: await attestedControllerPublicKey(store, attestation),
      evidenceRootObjectIdentitySha256,
    });
    await retainExactCanonical(store, claimPath, claim);
    return {
      claim,
      readers: Object.freeze({
        ...readers,
        observeGuest: async (candidateRequest) => {
          if (!canonicalEqual(candidateRequest, request)) {
            fail("RUNTIME_PREFLIGHT_REQUEST", "memoized guest observation has another request");
          }
          return guestObservation;
        },
      }),
    };
  }

  async function finalizersFor(store) {
    let promise = finalizerAdapters.get(store);
    if (promise === undefined) {
      promise = createProbeFinalizerAdapters({
        store,
        repositoryRoot: config.repositoryRoot,
        candidate,
        controllerTransport: config.controllerTransport,
        readRepositoryIdentity: config.readRepositoryIdentity,
        now: config.now,
        monotonicNow: config.monotonicNow,
      });
      finalizerAdapters.set(store, promise);
    }
    return promise;
  }

  async function loadPrepared(command) {
    assertCampaign(command);
    const store = await resolveStore(command.environmentId, command.pathProfileId);
    const artifact = await store.readArtifact(preparationPath(command));
    const prepared = validatePreparedForCommand(
      parseCanonicalObject(artifact.bytes, "prepared runtime context"),
      command,
      candidate,
      getAttestation(command.environmentId),
    );
    return { store, prepared, attestation: getAttestation(command.environmentId) };
  }

  async function collectSegmentSources() {
    const sources = [];
    for (const workItem of PROBE_RUN_PLAN.work) {
      const store = await resolveStore(workItem.environmentId, workItem.pathProfileId);
      const commitPath = probeSegmentArtifactPaths(workItem).segmentCommit;
      if ((await readOptionalArtifact(store, commitPath)) !== null) {
        sources.push({ store, commitPath });
      }
    }
    return sources;
  }

  async function finalizeCampaignPrefix() {
    return finalizeProbeCampaign({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate,
      attestations: [...attestationByEnvironment.values()],
      segmentSources: await collectSegmentSources(),
    });
  }

  async function ensureDependencies(store, command, workItem) {
    const path = dependencyPath(command);
    let upstreamSelectionDigests = [];
    if (workItem.dependsOnRowIds.length > 0) {
      upstreamSelectionDigests = deriveProbeWorkUpstreamSelectionDigests(
        await finalizeCampaignPrefix(),
        workItem,
      );
    }
    const record = {
      schemaVersion: 1,
      kind: "windows-host-probe-runtime-dependencies",
      campaignRunId: command.campaignRunId,
      attemptId: command.attemptId,
      workId: command.workId,
      dependsOnRowIds: workItem.dependsOnRowIds,
      upstreamSelectionDigests,
    };
    await retainExactCanonical(store, path, record);
    return deepFreeze(record);
  }

  function scenarioSeams({
    store,
    prepared,
    attestation,
    command,
    workItem,
    dependencies,
    checkpointEvidence = null,
  }) {
    const invoke = (transport, invocation, actionCommand = command) => {
      const binding = createProbeRuntimeActionBinding({
        command: actionCommand,
        invocation,
        preparedContext: prepared,
      });
      return transport(
        deepFreeze({
          command: actionCommand,
          workItem,
          preparedContext: prepared,
          candidate,
          attestation,
          dependencies,
          evidenceRoot: store.root,
          transportAuthority: "injected-authoritative-lab",
          checkpointEvidence,
          operationId: binding.operationId,
          operationIntentPath: binding.operationIntentPath,
          operationResultPath: binding.operationResultPath,
          execution: binding.execution,
          invocation,
        }),
      );
    };
    return {
      invokeNative: (invocation, actionCommand) =>
        invoke(config.nativeTransport.invokeScenarioAction, invocation, actionCommand),
      invokeController: (invocation, actionCommand) =>
        invoke(config.controllerTransport.invokeScenarioAction, invocation, actionCommand),
      verifyController: (invocation, actionCommand) =>
        invoke(config.controllerTransport.verifyScenarioActionReceipt, invocation, actionCommand),
    };
  }

  async function reverifyHardCutActionSet({
    store,
    prepared,
    attestation,
    command,
    workItem,
    dependencies,
    paths,
  }) {
    const pointers = await loadContinuationPointers(
      store,
      command,
      workItem.continuationRepetitions,
      "external",
    );
    const controllerPublicKeyBytes = await controllerPublicKey(store, prepared);
    const actionCaptures = [];
    const checkpointEvidence = [];
    let expectedPreCutBootIdSha256 = prepared.bootIdSha256;
    for (let repetition = 1; repetition <= workItem.continuationRepetitions; repetition += 1) {
      const repetitionCommand = {
        ...command,
        repetition,
        checkpointId: `checkpoint-${repetition}`,
        chainId: pointers[repetition - 1].chainId,
      };
      const { chain } = await loadContinuationPointer(store, repetitionCommand, repetition, {
        requireClosed: true,
        expectedClosureKind: "external",
      });
      const verified = await verifyRetainedHardCutRecord({
        store,
        command: repetitionCommand,
        workItem,
        prepared,
        attestation,
        dependencies,
        verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      });
      verifyRuntimeCheckpointEvidence({
        prepared,
        command: repetitionCommand,
        chain,
        checkpointEvidence: verified.checkpointEvidence,
        attestation,
        controllerPublicKeyBytes,
        expectedPreCutBootIdSha256,
      });
      actionCaptures.push(
        await executeOrLoadPartialCapture({
          store,
          preparedContext: prepared,
          command: repetitionCommand,
          actionId: `hard-cut-guest-r${repetition}`,
          paths,
          verifiedHardCutReceipt: verified,
        }),
      );
      checkpointEvidence.push(verified.checkpointEvidence);
      expectedPreCutBootIdSha256 = verified.checkpointEvidence.receipt.postBootBootIdSha256;
    }
    return deepFreeze({ actionCaptures, checkpointEvidence });
  }

  async function prepare({ command, plan }) {
    assertDispatchPlan(plan);
    assertCampaign(command);
    const store = await resolveStore(command.environmentId, command.pathProfileId);
    const attestation = getAttestation(command.environmentId);
    const path = preparationPath(command);
    const retained = await readOptionalArtifact(store, path);
    if (retained !== null) {
      validatePreparedForCommand(
        parseCanonicalObject(retained.bytes, "prepared runtime context"),
        command,
        candidate,
        attestation,
      );
    }
    const request = validatePreflightRequestForCommand(
      await config.resolvePreflightRequest(
        deepFreeze({
          command,
          candidate,
          attestation,
          evidenceRoot: store.root,
        }),
      ),
      command,
    );
    const authority = await runAuthorizationClaimForPreparation({
      store,
      attestation,
      request,
      readers: await readersFor(store),
    });
    const prepared = await prepareAuthoritativeProbeContext({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate,
      attestation,
      runAuthorization: config.runAuthorization,
      runAuthorizationClaim: authority.claim,
      request,
      lifecyclePolicy: config.lifecyclePolicy,
      brokerEnrollments: config.brokerEnrollments,
      readers: authority.readers,
      now: config.now,
    });
    validatePreparedForCommand(prepared, command, candidate, attestation);
    await retainExactCanonical(store, path, prepared);
    return deepFreeze({
      kind: "windows-host-probe-runtime-prepared",
      authority: "attested-preflight",
      path,
      preflightSha256: prepared.preflightSha256,
      recovered: retained !== null,
    });
  }

  async function ensureOrdinaryContinuation(store, prepared, command, transcript) {
    const chainId = ordinaryChainId(command);
    const scope = continuationScope(prepared, command, 1, chainId);
    const chain = await initializeOrLoadContinuation(store, scope, config.now);
    await retainContinuationPointer(store, command, 1, chain);
    await appendOrRecoverContinuation(
      store,
      chainId,
      "retain-scenario-capture",
      {
        event: "scenario-capture-retained",
        sourceTranscriptSha256: transcript.sourceTranscriptSha256,
      },
      config.now,
    );
    return closeOrRecoverContinuation(store, chainId, config.now);
  }

  async function segment({ command, plan, workItem: suppliedWorkItem }) {
    const workItem = trustedDispatchWorkItem(command, plan, suppliedWorkItem);
    const { store, prepared, attestation } = await loadPrepared(command);
    const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
    requireScenarioCapabilities(definition, attestation);
    const dependencies = await ensureDependencies(store, command, workItem);
    const paths = probeSegmentArtifactPaths(workItem);
    const seams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
    });
    const recovered = await recoverSourceTranscript({
      store,
      paths,
      prepared,
      candidate,
      command,
      workItem,
      verifyExternalActionSet: workItem.requiresExternalCheckpoint
        ? async () =>
            collectPrimaryObserverTranscriptSha256s(
              (
                await reverifyHardCutActionSet({
                  store,
                  prepared,
                  attestation,
                  command,
                  workItem,
                  dependencies,
                  paths,
                })
              ).actionCaptures,
            )
        : () =>
            reverifyOrdinaryExternalActionSet({
              store,
              preparedContext: prepared,
              command,
              definition,
              paths,
              verifyController: seams.verifyController,
            }),
      nativeTransport: config.nativeTransport,
      controllerTransport: config.controllerTransport,
    });
    if (recovered !== null) {
      if (workItem.requiresExternalCheckpoint) {
        await loadContinuationPointers(
          store,
          command,
          workItem.continuationRepetitions,
          "external",
        );
      } else {
        await ensureOrdinaryContinuation(store, prepared, command, recovered);
      }
      return deepFreeze({
        kind: "windows-host-probe-runtime-segment-capture",
        authority: "retained-signed-transcript",
        workId: command.workId,
        recovered: true,
        ...recovered,
      });
    }
    if (workItem.requiresExternalCheckpoint) {
      fail(
        "RUNTIME_HARD_CUT_PENDING",
        "hard-cut segment capture requires five exact checkpoint/resume cycles",
      );
    }
    const actionCaptures = [];
    for (const action of definition.actions) {
      actionCaptures.push(
        await executeOrLoadPartialCapture({
          store,
          preparedContext: prepared,
          command,
          actionId: action.actionId,
          ...seams,
          paths,
        }),
      );
    }
    const capture = await composeScenarioCapture(
      definition,
      actionCaptures.map(({ capture }) => capture),
    );
    const disposition = validateCaptureDisposition(
      await config.controllerTransport.observeCaptureDisposition(
        deepFreeze({
          command,
          workItem,
          preparedContext: prepared,
          candidate,
          attestation,
          dependencies,
          capture,
          evidenceRoot: store.root,
        }),
      ),
    );
    const transcript = await retainSourceTranscript({
      store,
      paths,
      prepared,
      candidate,
      command,
      workItem,
      capture,
      actionCaptures,
      disposition,
      primaryObserverTranscriptSha256s: collectPrimaryObserverTranscriptSha256s(actionCaptures),
      nativeTransport: config.nativeTransport,
      controllerTransport: config.controllerTransport,
    });
    await ensureOrdinaryContinuation(store, prepared, command, transcript);
    return deepFreeze({
      kind: "windows-host-probe-runtime-segment-capture",
      authority: "retained-signed-transcript",
      workId: command.workId,
      recovered: false,
      ...transcript,
    });
  }

  async function requireRetainedActionCapture(
    store,
    preparedContext,
    command,
    actionId,
    paths,
    verifyController,
  ) {
    const capture = await loadExistingPartialCapture(
      store,
      preparedContext,
      command,
      actionId,
      paths,
      verifyController,
    );
    if (capture === null) {
      fail("RUNTIME_ACTION_CAPTURE_MISSING", `required action capture is absent: ${actionId}`);
    }
    return capture;
  }

  async function checkpoint({ command, plan, workItem: suppliedWorkItem }) {
    const workItem = trustedDispatchWorkItem(command, plan, suppliedWorkItem);
    const { store, prepared, attestation } = await loadPrepared(command);
    if (!workItem.requiresExternalCheckpoint) {
      fail("RUNTIME_CHECKPOINT_COORDINATE", "checkpoint requires external continuation work");
    }
    const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
    requireScenarioCapabilities(definition, attestation);
    const dependencies = await ensureDependencies(store, command, workItem);
    const paths = probeSegmentArtifactPaths(workItem);
    const controllerPublicKeyBytes = await controllerPublicKey(store, prepared);
    const seams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
    });
    if (command.repetition === 1) {
      await executeOrLoadPartialCapture({
        store,
        preparedContext: prepared,
        command,
        actionId: "prepare-durability-target",
        ...seams,
        paths,
      });
    } else {
      await loadContinuationPointer(store, command, command.repetition - 1, {
        requireClosed: true,
        expectedClosureKind: "external",
      });
      await requireRetainedActionCapture(
        store,
        prepared,
        command,
        `start-guest-after-hard-cut-r${command.repetition - 1}`,
        paths,
        seams.verifyController,
      );
      await requireRetainedActionCapture(
        store,
        prepared,
        command,
        `inspect-durability-after-hard-cut-r${command.repetition - 1}`,
        paths,
        seams.verifyController,
      );
      await requireRetainedActionCapture(
        store,
        prepared,
        command,
        "prepare-durability-target",
        paths,
        seams.verifyController,
      );
    }
    const actionId = `start-durability-operation-r${command.repetition}`;
    const preCutCapture = await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command,
      actionId,
      ...seams,
      paths,
    });
    const scope = continuationScope(prepared, command, command.repetition, command.chainId);
    const chain = await initializeOrLoadContinuation(store, scope, config.now);
    if (
      chain.closure !== null &&
      chain.closure.kind !== "windows-host-probe-consumed-external-receipt"
    ) {
      fail("RUNTIME_CONTINUATION_COLLISION", "hard-cut continuation has a local closure");
    }
    await retainContinuationPointer(store, command, command.repetition, chain);
    const preCutStateSha256 = hardCutPreStateSha256(command, preCutCapture.capture);
    const expectedPreCutBootIdSha256 = await expectedPreCutBootIdForRepetition({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
      paths,
      verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      controllerPublicKeyBytes,
    });
    await appendOrRecoverContinuation(
      store,
      command.chainId,
      "retain-hard-cut-request",
      {
        event: "hard-cut-request-ready",
        checkpointId: command.checkpointId,
        preCutStateSha256,
      },
      config.now,
    );
    const requestPath = checkpointRequestPath(command);
    const retained = await readOptionalArtifact(store, requestPath);
    let request;
    if (retained !== null) {
      request = validateCheckpointRequest(
        parseCanonicalObject(retained.bytes, "hard-cut request"),
        {
          command,
          prepared,
          attestation,
          chain,
          preCutStateSha256,
          expectedPreCutBootIdSha256,
          controllerPublicKeyBytes,
        },
      );
    } else {
      const controllerClaimInput = deepFreeze({
        command,
        workItem,
        preparedContext: prepared,
        candidate,
        attestation,
        dependencies,
        continuation: {
          chainId: chain.header.chainId,
          scopeSha256: chain.header.scopeSha256,
          headerSha256: chain.header.headerSha256,
          terminalEntrySha256: (await loadContinuation({ store, chainId: command.chainId }))
            .previousEntrySha256,
        },
        preCutStateSha256,
        preCutBootIdSha256: expectedPreCutBootIdSha256,
        evidenceRoot: store.root,
      });
      request = validateCheckpointRequest(
        await config.controllerTransport.claimHardCutRequest(controllerClaimInput),
        {
          command,
          prepared,
          attestation,
          chain,
          preCutStateSha256,
          expectedPreCutBootIdSha256,
          controllerPublicKeyBytes,
        },
      );
    }
    if (retained === null) await retainExactCanonical(store, requestPath, request);
    const latestChain = await loadContinuation({ store, chainId: command.chainId });
    if (
      latestChain.header.scopeSha256 !== chain.header.scopeSha256 ||
      latestChain.header.headerSha256 !== chain.header.headerSha256 ||
      (latestChain.closure !== null &&
        latestChain.closure.kind !== "windows-host-probe-consumed-external-receipt")
    ) {
      fail("RUNTIME_CONTINUATION_COLLISION", "hard-cut continuation changed authority");
    }
    let pendingResume = null;
    if (latestChain.closure === null) {
      const readInput = hardCutReceiptReadInput({
        command,
        workItem,
        prepared,
        attestation,
        request,
        dependencies,
        evidenceRoot: store.root,
      });
      pendingResume = await recoverStagedHardCutResult({
        store,
        command,
        request,
        readInput,
        verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      });
      if (
        pendingResume === null &&
        (await retainedHardCutAuthorityState(store, command)) === "complete"
      ) {
        pendingResume = await verifyHardCutTransportResult({
          store,
          command,
          readInput,
          verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
        });
        await retainExactCanonical(
          store,
          stagedCheckpointResultPath(command, request, pendingResume),
          pendingResume,
        );
      }
      if (pendingResume !== null) {
        verifyRuntimeCheckpointEvidence({
          prepared,
          command,
          chain: latestChain,
          checkpointEvidence: pendingResume.checkpointEvidence,
          attestation,
          controllerPublicKeyBytes,
          expectedPreCutBootIdSha256,
        });
      }
    }
    const actionRequired =
      latestChain.closure === null && pendingResume === null && retained === null;
    const actionPendingWithoutReceipt =
      latestChain.closure === null && pendingResume === null && retained !== null;
    if (latestChain.closure !== null) {
      const completed = await verifyRetainedHardCutRecord({
        store,
        command,
        workItem,
        prepared,
        attestation,
        dependencies,
        verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      });
      if (
        !canonicalEqual(latestChain.closure.checkpointEvidence.request, request) ||
        !canonicalEqual(latestChain.closure.checkpointEvidence, completed.checkpointEvidence)
      ) {
        fail("RUNTIME_CHECKPOINT_RECOVERY", "continuation closure answers another request");
      }
      verifyRuntimeCheckpointEvidence({
        prepared,
        command,
        chain: latestChain,
        checkpointEvidence: completed.checkpointEvidence,
        attestation,
        controllerPublicKeyBytes,
        expectedPreCutBootIdSha256,
      });
      await executeOrLoadPartialCapture({
        store,
        preparedContext: prepared,
        command,
        actionId: `hard-cut-guest-r${command.repetition}`,
        paths,
        verifiedHardCutReceipt: completed,
      });
      await consumeContinuationReceipt({
        store,
        chainId: command.chainId,
        checkpointEvidence: completed.checkpointEvidence,
        expectedController: attestation.controller,
        controllerPublicKeyBytes,
        now: config.now,
      });
    }
    return deepFreeze({
      kind: "windows-host-probe-runtime-hard-cut-request",
      authority: actionRequired
        ? "external-controller-action-required"
        : actionPendingWithoutReceipt
          ? "external-controller-action-pending"
          : "verified-external-controller-receipt",
      transportMode: actionRequired
        ? "request-only-no-disruptive-action"
        : actionPendingWithoutReceipt
          ? "pending-action-no-repeat"
          : latestChain.closure === null
            ? "resume-required-no-action"
            : "completed-no-action",
      workId: command.workId,
      repetition: command.repetition,
      actionRequired,
      requestPath,
      requestSha256: request.requestSha256,
      request,
      recovered: retained !== null || pendingResume !== null,
    });
  }

  async function resume({ command, plan, workItem: suppliedWorkItem }) {
    const workItem = trustedDispatchWorkItem(command, plan, suppliedWorkItem);
    const { store, prepared, attestation } = await loadPrepared(command);
    if (!workItem.requiresExternalCheckpoint) {
      fail("RUNTIME_CHECKPOINT_COORDINATE", "resume requires external continuation work");
    }
    const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
    requireScenarioCapabilities(definition, attestation);
    const dependencies = await ensureDependencies(store, command, workItem);
    const paths = probeSegmentArtifactPaths(workItem);
    const recoverySeams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
    });
    await requireRetainedActionCapture(
      store,
      prepared,
      command,
      "prepare-durability-target",
      paths,
      recoverySeams.verifyController,
    );
    const preCutCapture = await requireRetainedActionCapture(
      store,
      prepared,
      command,
      `start-durability-operation-r${command.repetition}`,
      paths,
      recoverySeams.verifyController,
    );
    const { chain } = await loadContinuationPointer(store, command, command.repetition, {
      requireClosed: false,
    });
    const preCutStateSha256 = hardCutPreStateSha256(command, preCutCapture.capture);
    const controllerPublicKeyBytes = await controllerPublicKey(store, prepared);
    const expectedPreCutBootIdSha256 = await expectedPreCutBootIdForRepetition({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
      paths,
      verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      controllerPublicKeyBytes,
    });
    const requestArtifact = await store.readArtifact(checkpointRequestPath(command));
    const request = validateCheckpointRequest(
      parseCanonicalObject(requestArtifact.bytes, "hard-cut request"),
      {
        command,
        prepared,
        attestation,
        chain,
        preCutStateSha256,
        expectedPreCutBootIdSha256,
        controllerPublicKeyBytes,
      },
    );
    const read = await readHardCutResult({
      store,
      command,
      workItem,
      prepared,
      attestation,
      chain,
      request,
      dependencies,
      readHardCutReceipt: (input) => config.controllerTransport.readHardCutReceipt(input),
      verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
    });
    const readResult = read.value;
    verifyRuntimeCheckpointEvidence({
      prepared,
      command,
      chain,
      checkpointEvidence: readResult.checkpointEvidence,
      attestation,
      controllerPublicKeyBytes,
      expectedPreCutBootIdSha256,
    });
    const hardCutActionId = `hard-cut-guest-r${command.repetition}`;
    await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command,
      actionId: hardCutActionId,
      paths,
      verifiedHardCutReceipt: readResult,
    });
    await retainExactCanonical(store, read.path, readResult);
    const consumed = await consumeContinuationReceipt({
      store,
      chainId: command.chainId,
      checkpointEvidence: readResult.checkpointEvidence,
      expectedController: attestation.controller,
      controllerPublicKeyBytes,
      now: config.now,
    });
    const seams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
      checkpointEvidence: readResult.checkpointEvidence,
    });
    await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command,
      actionId: `start-guest-after-hard-cut-r${command.repetition}`,
      ...seams,
      paths,
    });
    await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command,
      actionId: `inspect-durability-after-hard-cut-r${command.repetition}`,
      ...seams,
      paths,
    });
    if (command.repetition < workItem.continuationRepetitions) {
      return deepFreeze({
        kind: "windows-host-probe-runtime-hard-cut-resume",
        authority: "verified-external-controller-receipt",
        transportMode: "receipt-read-only",
        workId: command.workId,
        repetition: command.repetition,
        receiptSha256: consumed.continuation.receiptSha256,
        captureReady: false,
      });
    }
    const pointers = await loadContinuationPointers(
      store,
      command,
      workItem.continuationRepetitions,
      "external",
    );
    const checkpointEvidence = [];
    const hardCutCaptures = new Map();
    let expectedBootIdSha256 = prepared.bootIdSha256;
    for (let repetition = 1; repetition <= workItem.continuationRepetitions; repetition += 1) {
      const repetitionCommand = {
        ...command,
        repetition,
        checkpointId: `checkpoint-${repetition}`,
        chainId: pointers[repetition - 1].chainId,
      };
      const { chain: repetitionChain } = await loadContinuationPointer(
        store,
        repetitionCommand,
        repetition,
        { requireClosed: true, expectedClosureKind: "external" },
      );
      const verified = await verifyRetainedHardCutRecord({
        store,
        command: repetitionCommand,
        workItem,
        prepared,
        attestation,
        dependencies,
        verifyHardCutReceipt: (input) => config.controllerTransport.verifyHardCutReceipt(input),
      });
      verifyRuntimeCheckpointEvidence({
        prepared,
        command: repetitionCommand,
        chain: repetitionChain,
        checkpointEvidence: verified.checkpointEvidence,
        attestation,
        controllerPublicKeyBytes,
        expectedPreCutBootIdSha256: expectedBootIdSha256,
      });
      const actionId = `hard-cut-guest-r${repetition}`;
      hardCutCaptures.set(
        actionId,
        await executeOrLoadPartialCapture({
          store,
          preparedContext: prepared,
          command: repetitionCommand,
          actionId,
          paths,
          verifiedHardCutReceipt: verified,
        }),
      );
      checkpointEvidence.push(verified.checkpointEvidence);
      expectedBootIdSha256 = verified.checkpointEvidence.receipt.postBootBootIdSha256;
    }
    const finalSeams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
      checkpointEvidence: deepFreeze({ repetitions: checkpointEvidence }),
    });
    await executeOrLoadPartialCapture({
      store,
      preparedContext: prepared,
      command,
      actionId: "capture-durability-campaign",
      ...finalSeams,
      paths,
    });
    const actionCaptures = [];
    for (const action of definition.actions) {
      const verifiedHardCutCapture = hardCutCaptures.get(action.actionId);
      actionCaptures.push(
        verifiedHardCutCapture ??
          (await requireRetainedActionCapture(
            store,
            prepared,
            command,
            action.actionId,
            paths,
            recoverySeams.verifyController,
          )),
      );
    }
    const capture = await composeScenarioCapture(
      definition,
      actionCaptures.map(({ capture }) => capture),
    );
    let transcript = await recoverSourceTranscript({
      store,
      paths,
      prepared,
      candidate,
      command,
      workItem,
      verifyExternalActionSet: () => collectPrimaryObserverTranscriptSha256s(actionCaptures),
      nativeTransport: config.nativeTransport,
      controllerTransport: config.controllerTransport,
    });
    if (transcript === null) {
      const disposition = validateCaptureDisposition(
        await config.controllerTransport.observeCaptureDisposition(
          deepFreeze({
            command,
            workItem,
            preparedContext: prepared,
            candidate,
            attestation,
            dependencies,
            capture,
            checkpointEvidence,
            evidenceRoot: store.root,
          }),
        ),
      );
      transcript = await retainSourceTranscript({
        store,
        paths,
        prepared,
        candidate,
        command,
        workItem,
        capture,
        actionCaptures,
        disposition,
        primaryObserverTranscriptSha256s: collectPrimaryObserverTranscriptSha256s(actionCaptures),
        nativeTransport: config.nativeTransport,
        controllerTransport: config.controllerTransport,
      });
    }
    return deepFreeze({
      kind: "windows-host-probe-runtime-hard-cut-resume",
      authority: "verified-external-controller-receipt",
      transportMode: "receipt-read-only",
      workId: command.workId,
      repetition: command.repetition,
      receiptSha256: consumed.continuation.receiptSha256,
      captureReady: true,
      ...transcript,
    });
  }

  async function finalizeSegment({ command, plan, workItem: suppliedWorkItem }) {
    const workItem = trustedDispatchWorkItem(command, plan, suppliedWorkItem);
    const { store, prepared, attestation } = await loadPrepared(command);
    const definition = getProbeScenarioDefinition(command.rowId, command.variantId);
    requireScenarioCapabilities(definition, attestation);
    const paths = probeSegmentArtifactPaths(workItem);
    const dependencies = await ensureDependencies(store, command, workItem);
    const seams = scenarioSeams({
      store,
      prepared,
      attestation,
      command,
      workItem,
      dependencies,
    });
    const transcript = await recoverSourceTranscript({
      store,
      paths,
      prepared,
      candidate,
      command,
      workItem,
      verifyExternalActionSet: workItem.requiresExternalCheckpoint
        ? async () =>
            collectPrimaryObserverTranscriptSha256s(
              (
                await reverifyHardCutActionSet({
                  store,
                  prepared,
                  attestation,
                  command,
                  workItem,
                  dependencies,
                  paths,
                })
              ).actionCaptures,
            )
        : () =>
            reverifyOrdinaryExternalActionSet({
              store,
              preparedContext: prepared,
              command,
              definition,
              paths,
              verifyController: seams.verifyController,
            }),
      nativeTransport: config.nativeTransport,
      controllerTransport: config.controllerTransport,
    });
    if (transcript === null) {
      fail("RUNTIME_TRANSCRIPT_INCOMPLETE", "segment cannot finalize without a transcript");
    }
    const pointers = await loadContinuationPointers(
      store,
      command,
      workItem.continuationRepetitions,
      workItem.requiresExternalCheckpoint ? "external" : "local",
    );
    const start = await ensureFinalizationStart(store, command, config.now);
    const runAuthorizationClaim = await loadRunAuthorizationClaim(store, attestation);
    const finalized = await finalizeProbeSegment({
      store,
      preparedContext: prepared,
      candidate,
      attestation,
      runAuthorization: config.runAuthorization,
      runAuthorizationClaim,
      rowId: command.rowId,
      variantId: command.variantId,
      continuationChainIds: pointers.map(({ chainId }) => chainId),
      upstreamSelectionDigests: dependencies.upstreamSelectionDigests,
      provenance: {
        startedAt: start.startedAt,
        startedMonotonicMs: currentMonotonic(config.monotonicNow),
      },
      adapters: await finalizersFor(store),
    });
    const verified = await verifyCommittedProbeSegment({
      store,
      commitPath: finalized.commitPath,
      candidate,
      attestation,
    });
    if (
      verified.segment.segmentSha256 !== finalized.segment.segmentSha256 ||
      verified.commit.commitSha256 !== finalized.commit.commitSha256
    ) {
      fail("RUNTIME_FINALIZATION_VERIFY", "post-write segment verification differs");
    }
    return deepFreeze({
      kind: "windows-host-probe-runtime-finalized-segment",
      authority: "verified-artifact-finalizer",
      workId: command.workId,
      path: verified.path,
      commitPath: verified.commitPath,
      segmentSha256: verified.segment.segmentSha256,
      outcome: verified.segment.outcome,
    });
  }

  async function finalizeCampaign({ command, plan }) {
    assertDispatchPlan(plan);
    assertCampaign(command);
    const segmentSources = await collectSegmentSources();
    const result = await finalizeProbeCampaign({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate,
      attestations: [...attestationByEnvironment.values()],
      segmentSources,
    });
    return deepFreeze({
      kind: "windows-host-probe-runtime-finalized-campaign",
      authority: "verified-artifact-finalizer",
      sourceCount: segmentSources.length,
      result,
    });
  }

  return deepFreeze({
    schemaVersion: PROBE_AUTHORITATIVE_RUNTIME_SCHEMA_VERSION,
    kind: "windows-host-probe-authoritative-runtime",
    authority: "verified-artifact-composition",
    scenarioTransportMode: "injected-authoritative-lab",
    scenarioRetryContract: "durable-operation-result-before-return",
    operationMappingStatus: "audited-action-map-bundled",
    disruptiveActionBoundary: "external-controller-request-and-receipt-only",
    finalizerAdapterMode: "composed-authoritative-adapters",
    prepare,
    segment,
    checkpoint,
    resume,
    finalizeSegment,
    finalizeCampaign,
  });
}
