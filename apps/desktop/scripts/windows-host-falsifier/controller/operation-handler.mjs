import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { validateNativeCommandTranscript } from "../native-client.mjs";
import { validateProbeControllerPreparedAuthority } from "../probe-controller-prepared-authority.mjs";
import {
  collectProbeControllerActionSignedArtifacts,
  validateProbeControllerActionExecutionEvidence,
  validateProbeControllerActionExecutionReceiptStructure,
} from "../probe-controller-action-provenance.mjs";
import {
  canonicalProbeJson,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
  hashProbeCanonicalJson,
} from "../probe-contract.mjs";
import { getProbeRunWorkItem } from "../probe-runner.mjs";
import { createProbeRuntimeActionBindingFromPreparedAuthority } from "../probe-runtime-action-intent.mjs";
import { getProbeScenarioDefinition } from "../probe-scenarios.mjs";
import {
  decodeControllerOperationRequest,
  encodeControllerOperationResponse,
} from "./operation-codec.mjs";
import {
  CONTROLLER_OPERATION_KINDS,
  CONTROLLER_RESPONSE_OUTCOMES,
  validateControllerRequest,
} from "./protocol.mjs";

const maximumArtifacts = 4096;
const operationKinds = new Set(CONTROLLER_OPERATION_KINDS);
const responseOutcomes = new Set(CONTROLLER_RESPONSE_OUTCOMES);

export class ControllerOperationHandlerError extends Error {
  constructor(code, message, { operationKind = null } = {}) {
    super(message);
    this.name = "ControllerOperationHandlerError";
    this.code = code;
    this.operationKind = operationKind;
  }
}

function fail(code, message, details) {
  throw new ControllerOperationHandlerError(code, message, details);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertExactDataKeys(
  value,
  keys,
  label,
  code = "CONTROLLER_OPERATION_HANDLER_SCHEMA",
  details,
) {
  if (!exactObject(value)) fail(code, `${label} must be a plain object`, details);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail(code, `${label} has an invalid field set`, details);
  }
  const sortedActual = actual.sort(compareUtf8);
  const sortedExpected = [...keys].sort(compareUtf8);
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(code, `${label} has an invalid field set`, details);
  }
  for (const key of sortedActual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(code, `${label} fields must be enumerable data`, details);
    }
  }
  return value;
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value) || value.length > maximumArtifacts) {
    fail("CONTROLLER_OPERATION_HANDLER_ARTIFACT", `${label} must be a bounded dense array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          !Object.hasOwn(value, Number(key))),
    )
  ) {
    fail("CONTROLLER_OPERATION_HANDLER_ARTIFACT", `${label} must be a bounded dense array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("CONTROLLER_OPERATION_HANDLER_ARTIFACT", `${label} must contain data entries`);
    }
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function deterministicControllerOperationId(
  preparedAuthority,
  coordinate,
  operationKind,
  sequence,
) {
  return `operation-${hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-spool-operation.v1",
    campaignId: preparedAuthority.campaignId,
    candidateSha256: preparedAuthority.candidateSha256,
    runAuthorizationSha256: preparedAuthority.runAuthorizationSha256,
    coordinate,
    operationKind,
    sequence,
  }).slice(0, 32)}`;
}

function actionEvidenceArtifacts(artifacts) {
  return artifacts.map(({ path, bytes }) => ({ path, bytes }));
}

function scenarioReceiptFail(code, message, operationKind = "scenario-action") {
  fail(code, message, { operationKind });
}

function hardCutReceiptFail(code, message) {
  scenarioReceiptFail(code, message, "hard-cut-receipt-read");
}

function actionEvidenceFailureCode(error, { attestation, observer, receipt }) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (
    code === "CONTROLLER_ACTION_COMMAND_BINDING" ||
    code === "CONTROLLER_ACTION_EVIDENCE" ||
    code.endsWith("_OBSERVER")
  ) {
    return observer;
  }
  if (code.includes("ATTESTATION") || code.includes("BROKER_ACCEPTANCE")) return attestation;
  return receipt;
}

function deriveScenarioCoordinate(
  input,
  runtimeActionBinding,
  {
    code = "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
    label = "successful scenario action input",
    operationKind = "scenario-action",
  } = {},
) {
  if (
    !exactObject(input) ||
    !exactObject(input.command) ||
    !exactObject(input.workItem) ||
    !exactObject(input.invocation) ||
    !exactObject(input.invocation.action) ||
    !exactObject(input.preparedAuthority)
  ) {
    scenarioReceiptFail(code, `${label} is incomplete`, operationKind);
  }
  let preparedAuthority;
  try {
    preparedAuthority = validateProbeControllerPreparedAuthority(input.preparedAuthority);
  } catch {
    scenarioReceiptFail(code, `${label} has invalid prepared authority`, operationKind);
  }
  const { command, invocation, workItem } = input;
  const coordinate = Object.freeze({
    campaignRunId: preparedAuthority.campaignRunId,
    executionRunId: preparedAuthority.executionRunId,
    attemptId: preparedAuthority.attemptId,
    workId: command.workId,
    environmentId: preparedAuthority.environmentId,
    pathProfileId: preparedAuthority.pathProfileId,
    rowId: invocation.rowId,
    variantId: invocation.variantId,
    repetition: runtimeActionBinding.intent.repetition,
  });
  const coordinateBindings = [
    [command.campaignRunId, coordinate.campaignRunId],
    [command.attemptId, coordinate.attemptId],
    [command.workId, coordinate.workId],
    [command.environmentId, coordinate.environmentId],
    [command.pathProfileId, coordinate.pathProfileId],
    [command.rowId, coordinate.rowId],
    [command.variantId, coordinate.variantId],
    [preparedAuthority.environmentId, coordinate.environmentId],
    [preparedAuthority.pathProfileId, coordinate.pathProfileId],
    [workItem.workId, coordinate.workId],
    [workItem.environmentId, coordinate.environmentId],
    [workItem.pathProfileId, coordinate.pathProfileId],
    [workItem.rowId, coordinate.rowId],
    [workItem.variantId, coordinate.variantId],
  ];
  if (coordinateBindings.some(([actual, expected]) => actual !== expected)) {
    scenarioReceiptFail(code, `${label} has conflicting coordinates`, operationKind);
  }
  return coordinate;
}

function deriveHardCutScenarioTrust(input) {
  if (
    !exactObject(input) ||
    !exactObject(input.command) ||
    !exactObject(input.workItem) ||
    !exactObject(input.preparedAuthority) ||
    !exactObject(input.request)
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt input is incomplete",
    );
  }
  let preparedAuthority;
  try {
    preparedAuthority = validateProbeControllerPreparedAuthority(input.preparedAuthority);
  } catch {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt input has invalid prepared authority",
    );
  }
  const { command, workItem } = input;
  let trustedWorkItem;
  let definition;
  try {
    trustedWorkItem = getProbeRunWorkItem({
      environmentId: command.environmentId,
      pathProfileId: command.pathProfileId,
      rowId: command.rowId,
      variantId: command.variantId,
    });
    definition = getProbeScenarioDefinition(command.rowId, command.variantId);
  } catch {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt has no frozen scenario authority",
    );
  }
  if (
    !canonicalEqual(workItem, trustedWorkItem) ||
    trustedWorkItem.requiresExternalCheckpoint !== true ||
    !Number.isSafeInteger(command.repetition) ||
    command.repetition < 1
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt differs from the frozen hard-cut work item",
    );
  }
  const actionId = `hard-cut-guest-r${command.repetition}`;
  const action = definition.actions.find(({ actionId: candidate }) => candidate === actionId);
  if (
    definition.continuation.kind !== "external-hard-cut" ||
    action === undefined ||
    action.actor !== "external-controller" ||
    action.operation !== "hard-cut-guest" ||
    action.parameters?.repetition !== command.repetition ||
    action.parameters?.checkpoint !== definition.continuation.checkpoint
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt has no frozen action for its repetition",
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
  let runtimeActionBinding;
  try {
    runtimeActionBinding = createProbeRuntimeActionBindingFromPreparedAuthority({
      command,
      invocation,
      preparedAuthority,
    });
  } catch {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt input has no valid runtime binding",
    );
  }
  const coordinate = deriveScenarioCoordinate(
    { ...input, invocation, preparedAuthority },
    runtimeActionBinding,
    {
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      label: "successful hard-cut receipt input",
      operationKind: "hard-cut-receipt-read",
    },
  );
  const checkpointBindings = [
    [input.request.campaignId, preparedAuthority.campaignId],
    [input.request.manifestSha256, preparedAuthority.manifestSha256],
    [input.request.candidateSha256, preparedAuthority.candidateSha256],
    [input.request.campaignRunId, coordinate.campaignRunId],
    [input.request.executionRunId, coordinate.executionRunId],
    [input.request.executionBundleId, preparedAuthority.executionBundleId],
    [input.request.executionBundleManifestSha256, preparedAuthority.executionBundleManifestSha256],
    [input.request.attemptId, coordinate.attemptId],
    [input.request.environmentId, coordinate.environmentId],
    [input.request.pathProfileId, coordinate.pathProfileId],
    [input.request.rowId, coordinate.rowId],
    [input.request.variantId, coordinate.variantId],
    [input.request.checkpointId, command.checkpointId],
    [input.request.sequence, coordinate.repetition],
    [command.executionRunId, coordinate.executionRunId],
    [command.executionBundleId, preparedAuthority.executionBundleId],
    [input.request.sourceVmSnapshotId, preparedAuthority.vmSnapshotId],
    [input.request.controllerIdentitySha256, preparedAuthority.controller.identitySha256],
    [input.request.controllerPublicKeySha256, preparedAuthority.controller.publicKeySha256],
    [input.request.controllerVersion, preparedAuthority.controller.version],
    [input.request.action, "hard-power-cut"],
    [input.request.requestSha256, deriveExternalCheckpointRequestDigest(input.request)],
  ];
  if (checkpointBindings.some(([actual, expected]) => actual !== expected)) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut receipt request differs from its runtime scope",
    );
  }
  return Object.freeze({
    action,
    coordinate,
    definition,
    invocation,
    preparedAuthority,
    runtimeActionBinding,
    trustedWorkItem,
  });
}

function frozenScenarioActionRepetition(definition, action) {
  if (definition.continuation.kind !== "external-hard-cut") return null;
  let repetition;
  if (action.phase === "setup") repetition = 1;
  else if (action.phase === "capture") repetition = definition.continuation.repetitions;
  else repetition = action.parameters?.repetition;
  if (
    !Number.isSafeInteger(repetition) ||
    repetition < 1 ||
    repetition > definition.continuation.repetitions
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "scenario action has no frozen repetition authority",
    );
  }
  return repetition;
}

function validateHardCutReceiptBinding(receiptValue, input, request) {
  let receipt;
  try {
    receipt = validateProbeControllerActionExecutionReceiptStructure(receiptValue);
  } catch (error) {
    hardCutReceiptFail(
      actionEvidenceFailureCode(error, {
        attestation: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ATTESTATION",
        observer: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_OBSERVER",
        receipt: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RECEIPT",
      }),
      "successful hard-cut result has no action execution receipt",
    );
  }
  const { action, coordinate, definition, preparedAuthority, runtimeActionBinding } =
    deriveHardCutScenarioTrust(input);
  const expectedReceiptFields = {
    candidateSha256: preparedAuthority.candidateSha256,
    executionBundleId: preparedAuthority.executionBundleId,
    executionBundleManifestSha256: preparedAuthority.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: preparedAuthority.runAuthorizationClaimReceiptSha256,
    coordinate,
    scenarioPlanSha256: definition.planSha256,
    producerActionId: action.actionId,
    operation: {
      operationId: runtimeActionBinding.operationId,
      kind: "scenario-action",
      sequence: action.sequence,
    },
    intentSha256: runtimeActionBinding.operationIntentSha256,
    execution: runtimeActionBinding.execution,
    expectedActor: runtimeActionBinding.expectedActor,
  };
  for (const [key, expected] of Object.entries(expectedReceiptFields)) {
    if (!canonicalEqual(receipt[key], expected)) {
      hardCutReceiptFail(
        "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
        `successful hard-cut action receipt ${key} differs from its trusted input`,
      );
    }
  }
  if (
    receipt.actionResultArtifact.path !== runtimeActionBinding.operationResultPath ||
    receipt.actionResult.actionId !== action.actionId
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
      "successful hard-cut action result differs from its trusted action",
    );
  }
  if (
    request.candidateSha256 !== receipt.candidateSha256 ||
    request.runAuthorizationClaimSha256 !== receipt.runAuthorizationClaimReceiptSha256 ||
    !canonicalEqual(request.coordinate, receipt.coordinate)
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_REQUEST",
      "successful hard-cut action receipt differs from its signed read request",
    );
  }
  return receipt;
}

function deriveScenarioTrust(input) {
  if (
    !exactObject(input) ||
    !exactObject(input.command) ||
    !exactObject(input.workItem) ||
    !exactObject(input.invocation) ||
    !exactObject(input.invocation.action) ||
    !exactObject(input.preparedAuthority)
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "scenario action input is incomplete",
    );
  }
  let preparedAuthority;
  try {
    preparedAuthority = validateProbeControllerPreparedAuthority(input.preparedAuthority);
  } catch {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "scenario action input has invalid prepared authority",
    );
  }
  let trustedWorkItem;
  let definition;
  try {
    trustedWorkItem = getProbeRunWorkItem({
      environmentId: input.command.environmentId,
      pathProfileId: input.command.pathProfileId,
      rowId: input.command.rowId,
      variantId: input.command.variantId,
    });
    definition = getProbeScenarioDefinition(input.command.rowId, input.command.variantId);
  } catch {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "scenario action input has no frozen scenario authority",
    );
  }
  const action = definition.actions.find(
    ({ actionId }) => actionId === input.invocation.action.actionId,
  );
  const invocation =
    action === undefined
      ? null
      : Object.freeze({
          schemaVersion: 1,
          kind: "windows-host-probe-scenario-action-invocation",
          rowId: definition.rowId,
          variantId: definition.variantId,
          planSha256: definition.planSha256,
          action,
        });
  if (
    !canonicalEqual(input.workItem, trustedWorkItem) ||
    invocation === null ||
    action.actor !== "external-controller" ||
    !canonicalEqual(input.invocation, invocation) ||
    (Object.hasOwn(input.command, "repetition") ? input.command.repetition : null) !==
      frozenScenarioActionRepetition(definition, action)
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "scenario action input differs from the frozen work item or action",
    );
  }
  let runtimeActionBinding;
  try {
    runtimeActionBinding = createProbeRuntimeActionBindingFromPreparedAuthority({
      command: input.command,
      invocation,
      preparedAuthority,
    });
  } catch {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "successful scenario action input has no valid runtime binding",
    );
  }
  const coordinate = deriveScenarioCoordinate(
    { ...input, invocation, preparedAuthority },
    runtimeActionBinding,
  );
  if (
    input.operationId !== runtimeActionBinding.operationId ||
    input.operationIntentPath !== runtimeActionBinding.operationIntentPath ||
    input.operationResultPath !== runtimeActionBinding.operationResultPath ||
    !exactObject(input.execution) ||
    !canonicalEqual(input.execution, runtimeActionBinding.execution)
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "successful scenario action input differs from its independently derived runtime binding",
    );
  }
  return Object.freeze({
    action,
    coordinate,
    definition,
    invocation,
    preparedAuthority,
    runtimeActionBinding,
    trustedWorkItem,
  });
}

function validateScenarioDispatchAuthority(input, request) {
  const trusted = deriveScenarioTrust(input);
  const preparedAuthority = trusted.preparedAuthority;
  const expectedOperation = Object.freeze({
    operationId: trusted.runtimeActionBinding.operationId,
    kind: "scenario-action",
    sequence: trusted.action.sequence,
  });
  const requestBindings = [
    [request.campaignId, preparedAuthority.campaignId],
    [request.manifestSha256, preparedAuthority.manifestSha256],
    [request.runPlanSha256, preparedAuthority.runPlanSha256],
    [request.candidateSha256, preparedAuthority.candidateSha256],
    [request.runAuthorizationSha256, preparedAuthority.runAuthorizationSha256],
    [request.runAuthorizationClaimSha256, preparedAuthority.runAuthorizationClaimReceiptSha256],
    [request.controllerIdentitySha256, preparedAuthority.controller.identitySha256],
  ];
  if (
    requestBindings.some(([actual, expected]) => actual !== expected) ||
    !canonicalEqual(request.coordinate, trusted.coordinate) ||
    !canonicalEqual(request.operation, expectedOperation)
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST",
      "scenario action request differs from its frozen runtime authority",
    );
  }
  return Object.freeze({
    ...input,
    preparedAuthority,
    workItem: trusted.trustedWorkItem,
    invocation: trusted.invocation,
    operationId: trusted.runtimeActionBinding.operationId,
    operationIntentPath: trusted.runtimeActionBinding.operationIntentPath,
    operationResultPath: trusted.runtimeActionBinding.operationResultPath,
    execution: trusted.runtimeActionBinding.execution,
  });
}

function validateHardCutDispatchAuthority(input, request) {
  const trusted = deriveHardCutScenarioTrust(input);
  const preparedAuthority = trusted.preparedAuthority;
  const requestBindings = [
    [request.campaignId, preparedAuthority.campaignId],
    [request.manifestSha256, preparedAuthority.manifestSha256],
    [request.runPlanSha256, preparedAuthority.runPlanSha256],
    [request.candidateSha256, preparedAuthority.candidateSha256],
    [request.runAuthorizationSha256, preparedAuthority.runAuthorizationSha256],
    [request.runAuthorizationClaimSha256, preparedAuthority.runAuthorizationClaimReceiptSha256],
    [request.controllerIdentitySha256, preparedAuthority.controller.identitySha256],
    [request.operation.kind, "hard-cut-receipt-read"],
    [request.operation.sequence, trusted.coordinate.repetition],
    [
      request.operation.operationId,
      deterministicControllerOperationId(
        preparedAuthority,
        trusted.coordinate,
        "hard-cut-receipt-read",
        trusted.coordinate.repetition,
      ),
    ],
  ];
  if (
    requestBindings.some(([actual, expected]) => actual !== expected) ||
    !canonicalEqual(request.coordinate, trusted.coordinate)
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_REQUEST",
      "hard-cut read request differs from its frozen runtime authority",
    );
  }
  return Object.freeze({ ...input, preparedAuthority, workItem: trusted.trustedWorkItem });
}

function validateScenarioReceiptBinding(receiptValue, input, request) {
  let receipt;
  try {
    receipt = validateProbeControllerActionExecutionReceiptStructure(receiptValue);
  } catch (error) {
    scenarioReceiptFail(
      actionEvidenceFailureCode(error, {
        attestation: "CONTROLLER_OPERATION_HANDLER_SCENARIO_ATTESTATION",
        observer: "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
        receipt: "CONTROLLER_OPERATION_HANDLER_SCENARIO_RECEIPT",
      }),
      "successful scenario action result is not an execution receipt",
    );
  }
  const { runtimeActionBinding, coordinate, preparedAuthority } = deriveScenarioTrust(input);
  const expectedOperation = Object.freeze({
    operationId: runtimeActionBinding.operationId,
    kind: "scenario-action",
    sequence: input.invocation.action.sequence,
  });
  const expectedReceiptFields = {
    candidateSha256: preparedAuthority.candidateSha256,
    executionBundleId: preparedAuthority.executionBundleId,
    executionBundleManifestSha256: preparedAuthority.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: preparedAuthority.runAuthorizationClaimReceiptSha256,
    coordinate,
    scenarioPlanSha256: input.invocation.planSha256,
    producerActionId: input.invocation.action.actionId,
    operation: expectedOperation,
    intentSha256: runtimeActionBinding.operationIntentSha256,
    execution: runtimeActionBinding.execution,
    expectedActor: runtimeActionBinding.expectedActor,
  };
  for (const [key, expected] of Object.entries(expectedReceiptFields)) {
    if (!canonicalEqual(receipt[key], expected)) {
      scenarioReceiptFail(
        "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
        `successful scenario action receipt ${key} differs from its trusted input`,
      );
    }
  }
  if (
    receipt.actionResultArtifact.path !== runtimeActionBinding.operationResultPath ||
    receipt.actionResult.actionId !== input.invocation.action.actionId
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      "successful scenario action result differs from its trusted action",
    );
  }
  if (
    request.candidateSha256 !== receipt.candidateSha256 ||
    request.runAuthorizationClaimSha256 !== receipt.runAuthorizationClaimReceiptSha256 ||
    !canonicalEqual(request.coordinate, receipt.coordinate) ||
    !canonicalEqual(request.operation, receipt.operation)
  ) {
    scenarioReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST",
      "successful scenario action receipt differs from its signed request",
    );
  }
  return Object.freeze({ receipt, runtimeActionBinding });
}

function parseObserverTranscript(
  bytes,
  {
    code = "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
    label = "scenario action observer transcript",
    operationKind = "scenario-action",
  } = {},
) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    scenarioReceiptFail(code, `${label} is not UTF-8`, operationKind);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    scenarioReceiptFail(code, `${label} is not JSON`, operationKind);
  }
  try {
    return validateNativeCommandTranscript(value);
  } catch {
    scenarioReceiptFail(code, `${label} is invalid`, operationKind);
  }
}

function validateScenarioObserverArtifacts(
  receipt,
  artifacts,
  preparedAuthority,
  {
    code = "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
    label = "scenario action observer transcript",
    operationKind = "scenario-action",
  } = {},
) {
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const expectedBinding = {
    campaignRunId: preparedAuthority.campaignRunId,
    candidateSha256: preparedAuthority.candidateSha256,
    preflightSha256: preparedAuthority.preflightSha256,
    executionBundleManifestSha256: preparedAuthority.executionBundleManifestSha256,
    nativeHelperArtifactPath: preparedAuthority.nativeHelper.artifactPath,
    nativeHelperSha256: preparedAuthority.nativeHelper.sha256,
    nativeCandidateDigest: preparedAuthority.nativeHelper.nativeCandidateDigest,
    nativeManifestSha256: preparedAuthority.nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256: preparedAuthority.evidenceRootObjectIdentitySha256,
  };
  const transcriptPrefix = [
    "segments",
    receipt.coordinate.environmentId,
    receipt.coordinate.pathProfileId,
    receipt.coordinate.rowId.toLocaleLowerCase("en-US"),
    receipt.coordinate.variantId,
    "evidence",
    "native-transcripts",
  ].join("/");
  for (const reference of receipt.observerTranscripts) {
    const artifact = artifactsByPath.get(reference.path);
    if (artifact === undefined || artifact.sha256 !== reference.sha256) {
      scenarioReceiptFail(code, `${label} has no exact raw artifact`, operationKind);
    }
    const transcript = parseObserverTranscript(artifact.bytes, { code, label, operationKind });
    const expectedPath = `${transcriptPrefix}/${transcript.transcriptSha256}.json`;
    if (
      transcript.transcriptSha256 !== reference.transcriptSha256 ||
      reference.path !== expectedPath ||
      transcript.termination === null ||
      !transcript.records.some((record) => record.kind === "command") ||
      sha256(Buffer.from(transcript.binding.runRootIdentity, "utf8")) !==
        expectedBinding.evidenceRootObjectIdentitySha256 ||
      Object.entries(expectedBinding).some(
        ([key, expected]) => transcript.binding[key] !== expected,
      )
    ) {
      scenarioReceiptFail(
        code,
        `${label} differs from its receipt or prepared binding`,
        operationKind,
      );
    }
  }
}

function validateActionReceiptSigningMaterials(
  receipt,
  artifacts,
  preparedAuthority,
  { artifactCode, label, observerCode, operationKind, resultCode },
) {
  const resultArtifact = artifacts.find(({ path }) => path === receipt.actionResultArtifact.path);
  const canonicalResultBytes = Buffer.from(canonicalProbeJson(receipt.actionResult), "utf8");
  if (
    resultArtifact !== undefined &&
    !Buffer.from(resultArtifact.bytes).equals(canonicalResultBytes)
  ) {
    scenarioReceiptFail(
      resultCode,
      `${label} result artifact differs from its canonical receipt result`,
      operationKind,
    );
  }
  const expectedArtifacts = collectProbeControllerActionSignedArtifacts(receipt);
  if (
    artifacts.length !== expectedArtifacts.length ||
    artifacts.some(
      (artifact, index) =>
        artifact.path !== expectedArtifacts[index].path ||
        artifact.sha256 !== expectedArtifacts[index].sha256,
    )
  ) {
    scenarioReceiptFail(
      artifactCode,
      `${label} driver artifacts differ from its signed receipt`,
      operationKind,
    );
  }
  if (resultArtifact === undefined) {
    scenarioReceiptFail(artifactCode, `${label} driver omitted its result artifact`, operationKind);
  }
  try {
    validateProbeControllerActionExecutionEvidence({
      receipt,
      artifacts: actionEvidenceArtifacts(artifacts),
    });
  } catch (error) {
    scenarioReceiptFail(
      actionEvidenceFailureCode(error, {
        attestation:
          operationKind === "scenario-action"
            ? "CONTROLLER_OPERATION_HANDLER_SCENARIO_ATTESTATION"
            : "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ATTESTATION",
        observer: observerCode,
        receipt: artifactCode,
      }),
      `${label} evidence does not prove its action receipt`,
      operationKind,
    );
  }
  validateScenarioObserverArtifacts(receipt, artifacts, preparedAuthority, {
    code: observerCode,
    label: `${label} observer transcript`,
    operationKind,
  });
  return receipt;
}

function validateScenarioSigningMaterials(result, artifacts, input, request) {
  const { receipt } = validateScenarioReceiptBinding(result, input, request);
  return validateActionReceiptSigningMaterials(receipt, artifacts, input.preparedAuthority, {
    artifactCode: "CONTROLLER_OPERATION_HANDLER_SCENARIO_ARTIFACT",
    label: "scenario action",
    observerCode: "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
    operationKind: "scenario-action",
    resultCode: "CONTROLLER_OPERATION_HANDLER_SCENARIO_RESULT",
  });
}

function validateHardCutSigningMaterials(result, artifacts, input, request) {
  assertExactDataKeys(
    result,
    ["checkpointEvidence", "actionExecutionReceipt"],
    "successful hard-cut result",
    "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RECEIPT",
    { operationKind: "hard-cut-receipt-read" },
  );
  assertExactDataKeys(
    result.checkpointEvidence,
    ["request", "receipt"],
    "successful hard-cut checkpoint evidence",
    "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RECEIPT",
    { operationKind: "hard-cut-receipt-read" },
  );
  if (!canonicalEqual(result.checkpointEvidence.request, input.request)) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
      "successful hard-cut checkpoint evidence answers another request",
    );
  }
  const checkpointReceipt = assertExactDataKeys(
    result.checkpointEvidence.receipt,
    [
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
    ],
    "successful hard-cut checkpoint receipt",
    "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
    { operationKind: "hard-cut-receipt-read" },
  );
  let checkpointReceiptDigestValid = false;
  try {
    checkpointReceiptDigestValid =
      checkpointReceipt.receiptSha256 === deriveExternalCheckpointReceiptDigest(checkpointReceipt);
  } catch {
    checkpointReceiptDigestValid = false;
  }
  if (
    checkpointReceipt.schemaVersion !== 1 ||
    checkpointReceipt.kind !== "windows-host-probe-hard-cut-receipt" ||
    checkpointReceipt.requestSha256 !== input.request.requestSha256 ||
    checkpointReceipt.controllerIdentitySha256 !== input.request.controllerIdentitySha256 ||
    checkpointReceipt.controllerPublicKeySha256 !== input.request.controllerPublicKeySha256 ||
    checkpointReceipt.controllerVersion !== input.request.controllerVersion ||
    checkpointReceipt.action !== "hard-power-cut" ||
    checkpointReceipt.preCutBootIdSha256 !== input.request.preCutBootIdSha256 ||
    checkpointReceipt.signatureAlgorithm !== "Ed25519" ||
    !checkpointReceiptDigestValid ||
    !Array.isArray(checkpointReceipt.artifactHashes)
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
      "successful hard-cut checkpoint receipt is not bound to the requested checkpoint",
    );
  }
  const receipt = validateHardCutReceiptBinding(result.actionExecutionReceipt, input, request);
  if (
    !canonicalEqual(receipt.actionResult.evidenceArtifacts, checkpointReceipt.artifactHashes) ||
    !canonicalEqual(receipt.proofArtifacts, checkpointReceipt.artifactHashes)
  ) {
    hardCutReceiptFail(
      "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
      "successful hard-cut action evidence differs from its checkpoint receipt",
    );
  }
  validateActionReceiptSigningMaterials(receipt, artifacts, input.preparedAuthority, {
    artifactCode: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ARTIFACT",
    label: "hard-cut action",
    observerCode: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_OBSERVER",
    operationKind: "hard-cut-receipt-read",
    resultCode: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RESULT",
  });
  return Object.freeze({
    checkpointEvidence: result.checkpointEvidence,
    actionExecutionReceipt: receipt,
  });
}

function validateDriverRegistry(value) {
  assertExactDataKeys(
    value,
    CONTROLLER_OPERATION_KINDS,
    "controller operation driver registry",
    "CONTROLLER_OPERATION_HANDLER_REGISTRY",
  );
  const drivers = Object.create(null);
  for (const operationKind of CONTROLLER_OPERATION_KINDS) {
    if (typeof value[operationKind] !== "function") {
      fail(
        "CONTROLLER_OPERATION_HANDLER_REGISTRY",
        `controller operation driver ${operationKind} must be a function`,
        { operationKind },
      );
    }
    drivers[operationKind] = value[operationKind];
  }
  return Object.freeze(drivers);
}

function validateHandlerInput(value) {
  assertExactDataKeys(
    value,
    ["request", "payloadBytes", "recoveryRequired"],
    "controller operation handler input",
  );
  if (!(value.payloadBytes instanceof Uint8Array)) {
    fail(
      "CONTROLLER_OPERATION_HANDLER_INPUT",
      "controller operation handler payloadBytes must be bytes",
    );
  }
  if (typeof value.recoveryRequired !== "boolean") {
    fail(
      "CONTROLLER_OPERATION_HANDLER_INPUT",
      "controller operation handler recoveryRequired must be boolean",
    );
  }
  const request = validateControllerRequest(value.request);
  const payloadBytes = Buffer.from(value.payloadBytes);
  if (
    payloadBytes.byteLength !== request.payload.bytes ||
    sha256(payloadBytes) !== request.payload.sha256
  ) {
    fail(
      "CONTROLLER_OPERATION_HANDLER_PAYLOAD_BINDING",
      "controller operation payload differs from its signed request reference",
      { operationKind: request.operation.kind },
    );
  }
  return Object.freeze({
    request,
    payloadBytes,
    recoveryRequired: value.recoveryRequired,
  });
}

function validateDriverResult(value, operationKind, input, request) {
  assertExactDataKeys(
    value,
    ["outcome", "result", "artifacts"],
    "controller operation driver result",
    "CONTROLLER_OPERATION_HANDLER_DRIVER_RESULT",
  );
  if (!responseOutcomes.has(value.outcome)) {
    fail("CONTROLLER_OPERATION_HANDLER_OUTCOME", "controller operation driver outcome is invalid", {
      operationKind,
    });
  }
  assertDenseArray(value.artifacts, "controller operation driver artifacts");

  const foldedPaths = new Set();
  const artifactDigests = new Set();
  const artifacts = value.artifacts.map((artifact, index) => {
    assertExactDataKeys(
      artifact,
      ["path", "bytes"],
      `controller operation driver artifacts[${index}]`,
      "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
    );
    if (typeof artifact.path !== "string" || !(artifact.bytes instanceof Uint8Array)) {
      fail(
        "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
        `controller operation driver artifacts[${index}] is invalid`,
        { operationKind },
      );
    }
    const foldedPath = artifact.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(foldedPath)) {
      fail(
        "CONTROLLER_OPERATION_HANDLER_ARTIFACT_PATH_COLLISION",
        "controller operation artifact paths collide case-insensitively",
        { operationKind },
      );
    }
    const bytes = Buffer.from(artifact.bytes);
    const digest = sha256(bytes);
    if (artifactDigests.has(digest)) {
      fail(
        "CONTROLLER_OPERATION_HANDLER_ARTIFACT_DIGEST_COLLISION",
        "controller operation artifacts must have unique byte digests",
        { operationKind },
      );
    }
    foldedPaths.add(foldedPath);
    artifactDigests.add(digest);
    return Object.freeze({ path: artifact.path, bytes, sha256: digest });
  });
  artifacts.sort((left, right) => compareUtf8(left.path, right.path));

  let result = value.result;
  if (value.outcome === "SUCCEEDED") {
    if (operationKind === "scenario-action") {
      result = validateScenarioSigningMaterials(value.result, artifacts, input, request);
    } else if (operationKind === "hard-cut-receipt-read") {
      result = validateHardCutSigningMaterials(value.result, artifacts, input, request);
    }
  }

  const encoded = encodeControllerOperationResponse({
    operationKind,
    result,
    artifactBindings: artifacts.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
  });
  const responsePayloadSha256 = sha256(encoded.bytes);
  if (artifactDigests.has(responsePayloadSha256)) {
    fail(
      "CONTROLLER_OPERATION_HANDLER_PAYLOAD_ARTIFACT_COLLISION",
      "controller operation response payload collides with an artifact digest",
      { operationKind },
    );
  }
  return Object.freeze({
    outcome: value.outcome,
    payloadBytes: Buffer.from(encoded.bytes),
    artifactBytes: Object.freeze(artifacts.map(({ bytes }) => Buffer.from(bytes))),
  });
}

export function createControllerOperationHandler(driverRegistry) {
  const drivers = validateDriverRegistry(driverRegistry);
  return async function handleControllerOperation(value) {
    const handled = validateHandlerInput(value);
    const operationKind = handled.request.operation.kind;
    if (!operationKinds.has(operationKind)) {
      fail(
        "CONTROLLER_OPERATION_HANDLER_OPERATION_KIND",
        "controller operation request kind is invalid",
      );
    }
    const decoded = decodeControllerOperationRequest(handled.payloadBytes, {
      expectedOperationKind: operationKind,
    });
    if (decoded.intentSha256 !== handled.request.intentSha256) {
      fail(
        "CONTROLLER_OPERATION_HANDLER_INTENT",
        "controller operation payload differs from its signed intent",
        { operationKind },
      );
    }
    let trustedInput = decoded.envelope.input;
    if (operationKind === "scenario-action") {
      trustedInput = validateScenarioDispatchAuthority(trustedInput, handled.request);
    } else if (operationKind === "hard-cut-receipt-read") {
      trustedInput = validateHardCutDispatchAuthority(trustedInput, handled.request);
    }
    const driverInput = Object.freeze({
      request: handled.request,
      input: trustedInput,
      recoveryRequired: handled.recoveryRequired,
    });
    return validateDriverResult(
      await drivers[operationKind](driverInput),
      operationKind,
      trustedInput,
      handled.request,
    );
  };
}
