import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NATIVE_PROTOCOL_VERSION } from "../scripts/windows-host-falsifier/native-client.mjs";
import { createProbeBrokerResult } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  collectProbeControllerActionSignedArtifacts,
  createProbeControllerActionAttestation,
  createProbeControllerActionExecutionReceipt,
  createProbeControllerBrokerAcceptance,
  probeControllerActionAttestationPath,
  probeControllerBrokerAcceptancePath,
  type ProbeControllerActionExecutionReceiptCreateInput,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { createProbeControllerPreparedAuthority } from "../scripts/windows-host-falsifier/probe-controller-prepared-authority.mjs";
import {
  ControllerOperationHandlerError,
  createControllerOperationHandler,
  type ControllerOperationDriver,
  type ControllerOperationDriverRegistry,
} from "../scripts/windows-host-falsifier/controller/operation-handler.mjs";
import {
  ControllerOperationCodecError,
  decodeControllerOperationResponse,
  encodeControllerOperationRequest,
} from "../scripts/windows-host-falsifier/controller/operation-codec.mjs";
import {
  CONTROLLER_OPERATION_KINDS,
  CONTROLLER_REQUEST_KIND,
  CONTROLLER_RESPONSE_OUTCOMES,
  deriveControllerRequestDigest,
  type ControllerOperationKind,
  type ControllerRequest,
  type ControllerRequestDraft,
} from "../scripts/windows-host-falsifier/controller/protocol.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeRuntimeActionBinding } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import {
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";

const candidateSha256 = "1".repeat(64);
const runPlanSha256 = PROBE_RUN_PLAN_SHA256;
const runAuthorizationSha256 = "3".repeat(64);
const runAuthorizationClaimSha256 = "4".repeat(64);
const controllerIdentitySha256 = "5".repeat(64);
const transcriptSha256 = "7".repeat(64);

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function reference(bytes: Uint8Array) {
  const digest = sha256(bytes);
  return {
    blobPath: `blobs/sha256/${digest}` as const,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

function requestFor(
  operationKind: ControllerOperationKind,
  payloadBytes: Uint8Array,
  intentSha256: string,
  overrides: {
    readonly payloadReferenceBytes?: Uint8Array;
    readonly signedOperationKind?: ControllerOperationKind;
    readonly candidateSha256?: string;
    readonly runAuthorizationSha256?: string;
    readonly runAuthorizationClaimSha256?: string | null;
    readonly coordinate?: ControllerRequestDraft["coordinate"];
    readonly operation?: ControllerRequestDraft["operation"];
    readonly controllerIdentitySha256?: string;
  } = {},
): ControllerRequest {
  const signedOperationKind = overrides.signedOperationKind ?? operationKind;
  const preparation = new Set<ControllerOperationKind>([
    "controller-observation",
    "run-authorization-claim",
  ]).has(signedOperationKind);
  const repeated = new Set<ControllerOperationKind>([
    "hard-cut-receipt-read",
    "hard-cut-request-claim",
  ]).has(signedOperationKind);
  const draft: ControllerRequestDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_REQUEST_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: overrides.candidateSha256 ?? candidateSha256,
    runPlanSha256,
    runAuthorizationSha256: overrides.runAuthorizationSha256 ?? runAuthorizationSha256,
    runAuthorizationClaimSha256:
      overrides.runAuthorizationClaimSha256 ??
      (signedOperationKind === "run-authorization-claim" ? null : runAuthorizationClaimSha256),
    coordinate:
      overrides.coordinate ??
      ({
        campaignRunId: "campaign-one",
        executionRunId: "execution-one",
        attemptId: "attempt-one",
        environmentId: "win11-floor",
        pathProfileId: "ascii",
        workId: preparation ? null : "work-one",
        rowId: preparation ? null : "F-01",
        variantId: preparation ? null : "ordinary-absolute-path",
        repetition: repeated ? 1 : null,
      } as const),
    operation:
      overrides.operation ??
      ({
        operationId: `${signedOperationKind}-one`,
        kind: signedOperationKind,
        sequence: 1,
      } as const),
    intentSha256,
    payload: reference(overrides.payloadReferenceBytes ?? payloadBytes),
    controllerIdentitySha256: overrides.controllerIdentitySha256 ?? controllerIdentitySha256,
  };
  return { ...draft, requestSha256: deriveControllerRequestDigest(draft) };
}

function reviseRequest(
  request: ControllerRequest,
  overrides: Partial<Omit<ControllerRequestDraft, "schemaVersion" | "kind">>,
): ControllerRequest {
  const { requestSha256: _requestSha256, ...draft } = request;
  const revised = { ...draft, ...overrides };
  return { ...revised, requestSha256: deriveControllerRequestDigest(revised) };
}

function exchangeInput(
  operationKind: ControllerOperationKind,
  input: unknown,
  recoveryRequired = false,
) {
  const encoded = encodeControllerOperationRequest({
    operationKind,
    input: controllerWireInput(input),
  });
  return {
    encoded,
    handlerInput: {
      request: requestFor(operationKind, encoded.bytes, encoded.intentSha256),
      payloadBytes: Buffer.from(encoded.bytes),
      recoveryRequired,
    },
  };
}

function controllerWireInput(input: unknown): unknown {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Object.hasOwn(input, "preparedContext")
  ) {
    return input;
  }
  const { preparedContext, ...wireInput } = input as Record<string, unknown> & {
    readonly preparedContext: unknown;
  };
  return {
    ...wireInput,
    preparedAuthority: createProbeControllerPreparedAuthority(preparedContext),
  };
}

function compactCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(compactCanonicalValue);
  if (typeof value !== "object") throw new Error("native transcript fixture is not JSON");
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .map((key) => [key, compactCanonicalValue(record[key])]),
  );
}

function compactCanonicalSha256(value: unknown) {
  return sha256(Buffer.from(JSON.stringify(compactCanonicalValue(value)), "utf8"));
}

function nativeTranscriptFixture(
  preparedContext: ReturnType<typeof createPreparedContextFixture>,
  bindingOverrides: Readonly<Record<string, string>> = {},
  handshakeOnly = false,
) {
  const runRootIdentity = "volume-v1:controller-handler-root";
  const bindingFields = {
    campaignRunId: preparedContext.campaignRunId,
    candidateSha256: preparedContext.candidateSha256,
    preflightSha256: preparedContext.preflightSha256,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    nativeHelperArtifactPath: preparedContext.executionBundleManifest.binaries.nativeHelper.path,
    nativeHelperSha256: preparedContext.executionBundleManifest.binaries.nativeHelper.sha256,
    nativeCandidateDigest:
      preparedContext.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
    nativeManifestSha256:
      preparedContext.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256:
      preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    ...bindingOverrides,
    nativeSessionId: "native-controller-handler",
    runRootIdentity,
  };
  const operationId = "operation-native-startup";
  const requestId = "request-native-startup";
  const requestContext = {
    campaignRunId: bindingFields.campaignRunId,
    candidateSha256: bindingFields.candidateSha256,
    preflightSha256: bindingFields.preflightSha256,
    executionBundleManifestSha256: bindingFields.executionBundleManifestSha256,
    nativeCandidateDigest: bindingFields.nativeCandidateDigest,
    nativeManifestSha256: bindingFields.nativeManifestSha256,
    nativeHelperSha256: bindingFields.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: bindingFields.evidenceRootObjectIdentitySha256,
    nativeSessionId: bindingFields.nativeSessionId,
    operationId,
  };
  const requestFrameSha256 = compactCanonicalSha256({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId,
    command: "native-binding-check",
    context: requestContext,
    request: {},
  });
  const startupHandshake = {
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    command: "native-binding-check",
    context: { ...requestContext, requestFrameSha256, runRootIdentity },
    ok: true,
    result: {
      ready: true,
      processId: 1234,
      nativeHelperSha256: bindingFields.nativeHelperSha256,
      runRootIdentity,
      evidenceRootObjectIdentitySha256: bindingFields.evidenceRootObjectIdentitySha256,
    },
  };
  const commandOperationId = "operation-home-identity";
  const commandRequestId = "request-home-identity";
  const commandRequest = { relativePath: "home" };
  const commandRequestContext = {
    ...requestContext,
    operationId: commandOperationId,
  };
  const commandRequestFrameSha256 = compactCanonicalSha256({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId: commandRequestId,
    command: "home-identity",
    context: commandRequestContext,
    request: commandRequest,
  });
  const commandResult = {
    canonicalHomeId: "home-controller-handler",
    objectIdentity: "volume-v1:home-controller-handler",
    volumeIdentity: "volume-v1",
    finalPathSha256: "8".repeat(64),
    fileSystem: "NTFS",
    driveType: "fixed",
    reparseTag: 0,
    linkCount: 1,
  };
  const commandRecord = {
    kind: "command",
    sequence: 1,
    requestId: commandRequestId,
    command: "home-identity",
    operationId: commandOperationId,
    requestFrameSha256: commandRequestFrameSha256,
    nativeRequestFrameSha256: commandRequestFrameSha256,
    requestFrameVerification: "recomputed",
    responseFrameSha256: compactCanonicalSha256({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      kind: "response",
      requestId: commandRequestId,
      command: "home-identity",
      context: {
        ...commandRequestContext,
        requestFrameSha256: commandRequestFrameSha256,
        runRootIdentity,
      },
      ok: true,
      result: commandResult,
    }),
    ok: true,
    request: commandRequest,
    result: commandResult,
  };
  const payload = {
    schemaVersion: 1,
    kind: "windows-host-native-command-transcript",
    binding: {
      ...bindingFields,
      startupHandshake,
      startupHandshakeSha256: compactCanonicalSha256(startupHandshake),
    },
    records: handshakeOnly ? [] : [commandRecord],
    termination: { mode: "clean-eof", code: 0, signal: null },
  };
  return {
    ...payload,
    transcriptSha256: compactCanonicalSha256({
      domain: "enduragent.windows-host-native-command-transcript.v1",
      transcript: payload,
    }),
  };
}

function scenarioMaterial(
  options: {
    readonly receiptOverrides?: Partial<ProbeControllerActionExecutionReceiptCreateInput>;
    readonly observerBindingOverrides?: Readonly<Record<string, string>>;
    readonly handshakeOnlyObserver?: boolean;
    readonly requestOverrides?: Parameters<typeof requestFor>[3];
    readonly repetition?: number;
  } = {},
) {
  const workItem = PROBE_RUN_PLAN.work.find(
    ({ rowId, variantId }) => rowId === "F-01" && variantId === "f01-ordinary-absolute-path",
  );
  if (workItem === undefined) throw new Error("controller handler scenario fixture is missing");
  const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
  const action = definition.actions.find(({ actionId }) => actionId === "prepare-home-topology");
  if (action === undefined) throw new Error("controller handler action fixture is missing");
  const runRootIdentity = "volume-v1:controller-handler-root";
  const preparedContext = createPreparedContextFixture({
    candidateSha256,
    runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaimSha256,
    campaignRunId: "campaign-one",
    executionRunId: "execution-one",
    attemptId: "attempt-one",
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    evidenceRootObjectIdentitySha256: sha256(runRootIdentity),
  });
  const command = {
    campaignRunId: preparedContext.campaignRunId,
    attemptId: preparedContext.attemptId,
    workId: workItem.workId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    ...(options.repetition === undefined ? {} : { repetition: options.repetition }),
  };
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action,
  };
  const runtimeActionBinding = createProbeRuntimeActionBinding({
    command,
    invocation,
    preparedContext,
  });
  const coordinate = {
    campaignRunId: command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    rowId: command.rowId as `F-${string}`,
    variantId: command.variantId,
    repetition: runtimeActionBinding.intent.repetition,
  };
  const evidencePrefix = [
    "segments",
    coordinate.environmentId,
    coordinate.pathProfileId,
    coordinate.rowId.toLocaleLowerCase("en-US"),
    coordinate.variantId,
    "evidence",
  ].join("/");
  const proofBytes = Buffer.from("controller proof", "utf8");
  const proof = {
    path: `${evidencePrefix}/proofs/execution.json`,
    sha256: sha256(proofBytes),
  };
  const transcript = nativeTranscriptFixture(
    preparedContext,
    options.observerBindingOverrides,
    options.handshakeOnlyObserver,
  );
  const transcriptBytes = Buffer.from(canonicalProbeJson(transcript), "utf8");
  const observer = {
    path: `${evidencePrefix}/native-transcripts/${transcript.transcriptSha256}.json`,
    sha256: sha256(transcriptBytes),
    transcriptSha256: transcript.transcriptSha256,
  };
  const expectedActor = runtimeActionBinding.expectedActor;
  if (expectedActor.role !== "primary-standard-user") {
    throw new Error("controller handler scenario fixture expected a primary broker actor");
  }
  const brokerTaskSha256 = sha256("controller handler broker task");
  const brokerTaskNonceSha256 = sha256("controller handler broker nonce");
  const brokerResult = createProbeBrokerResult({
    taskSha256: brokerTaskSha256,
    brokerEnrollmentSha256: sha256("controller handler broker enrollment"),
    brokerInstanceId: "primary-broker-one",
    brokerRole: expectedActor.role,
    actor: expectedActor,
    bootIdSha256: preparedContext.bootIdSha256,
    runnerSessionIdSha256: preparedContext.runnerSessionIdSha256,
    outcome: "SUCCEEDED",
    driverResult: {
      schemaVersion: 1,
      kind: "windows-host-probe-broker-driver-result",
      driverId: runtimeActionBinding.execution.driverId,
      resultArtifact: reference(Buffer.from("controller handler broker driver result", "utf8")),
    },
    proofArtifacts: [reference(proofBytes)],
    observerTranscripts: [
      { ...reference(transcriptBytes), transcriptSha256: observer.transcriptSha256 },
    ],
    pausedSessionReceipt: null,
  });
  const brokerResultBytes = Buffer.from(canonicalProbeJson(brokerResult), "utf8");
  const brokerProof = {
    path: `${evidencePrefix}/proofs/${action.actionId}.broker-result.json`,
    sha256: sha256(brokerResultBytes),
  };
  const brokerAcceptance = createProbeControllerBrokerAcceptance({
    coordinate,
    producerActionId: action.actionId,
    brokerTaskSha256,
    brokerTaskNonceSha256,
    brokerResultSha256: brokerResult.resultSha256,
    brokerEnrollmentSha256: brokerResult.brokerEnrollmentSha256,
    brokerInstanceId: brokerResult.brokerInstanceId,
    brokerRole: brokerResult.brokerRole,
    expectedActor,
    mailboxAclSha256: sha256("controller handler broker mailbox acl"),
    processSidSha256: expectedActor.identitySha256,
    bootIdSha256: brokerResult.bootIdSha256,
    runnerSessionIdSha256: brokerResult.runnerSessionIdSha256,
    replayJournalDisposition: "accepted",
    replayJournalEntrySha256: sha256("controller handler broker replay journal"),
  });
  const brokerAcceptanceBytes = Buffer.from(canonicalProbeJson(brokerAcceptance), "utf8");
  const brokerAcceptanceReference = {
    path: probeControllerBrokerAcceptancePath({
      coordinate,
      producerActionId: action.actionId,
    }),
    sha256: sha256(brokerAcceptanceBytes),
  };
  const observerCommands = transcript.records
    .filter((record) => record.kind === "command")
    .map((record) => ({
      transcriptSha256: transcript.transcriptSha256,
      sequence: record.sequence,
      commandId: record.command,
      requestFrameSha256: record.requestFrameSha256,
      responseFrameSha256: record.responseFrameSha256,
      ok: record.ok,
    }));
  if (observerCommands.length === 0) {
    observerCommands.push({
      transcriptSha256: transcript.transcriptSha256,
      sequence: 1,
      commandId: "home-identity",
      requestFrameSha256: sha256("missing observer request"),
      responseFrameSha256: sha256("missing observer response"),
      ok: true,
    });
  }
  const actionAttestation = createProbeControllerActionAttestation({
    candidateSha256: preparedContext.candidateSha256,
    executionBundleId: preparedContext.executionBundleId,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate,
    scenarioPlanSha256: invocation.planSha256,
    producerActionId: action.actionId,
    operation: {
      operationId: runtimeActionBinding.operationId,
      kind: "scenario-action",
      sequence: action.sequence,
    },
    runtimeActionIntentSha256: runtimeActionBinding.operationIntentSha256,
    execution: runtimeActionBinding.execution,
    expectedActor,
    broker: {
      brokerAcceptanceSha256: brokerAcceptance.acceptanceSha256,
      brokerTaskSha256,
      brokerTaskNonceSha256,
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
    },
    observerCommands,
  });
  const actionAttestationBytes = Buffer.from(canonicalProbeJson(actionAttestation), "utf8");
  const actionAttestationReference = {
    path: probeControllerActionAttestationPath({
      coordinate,
      producerActionId: action.actionId,
    }),
    sha256: sha256(actionAttestationBytes),
  };
  const proofArtifacts = [
    proof,
    brokerProof,
    brokerAcceptanceReference,
    actionAttestationReference,
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const actionResult = {
    actionId: action.actionId,
    commandEvent: null,
    evidenceArtifacts: proofArtifacts,
  };
  const resultBytes = Buffer.from(canonicalProbeJson(actionResult), "utf8");
  const receipt = createProbeControllerActionExecutionReceipt({
    candidateSha256: preparedContext.candidateSha256,
    executionBundleId: preparedContext.executionBundleId,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate,
    scenarioPlanSha256: invocation.planSha256,
    producerActionId: action.actionId,
    operation: {
      operationId: runtimeActionBinding.operationId,
      kind: "scenario-action",
      sequence: action.sequence,
    },
    intentSha256: runtimeActionBinding.operationIntentSha256,
    execution: runtimeActionBinding.execution,
    expectedActor: runtimeActionBinding.expectedActor,
    actionResult,
    actionResultArtifact: {
      path: runtimeActionBinding.operationResultPath,
      sha256: sha256(resultBytes),
    },
    proofArtifacts,
    observerTranscripts: [observer],
    brokerProof,
    pausedSessionReceipt: null,
    nativeActionPlans: [],
    ...options.receiptOverrides,
  });
  const bytesByPath = new Map([
    [receipt.actionResultArtifact.path, resultBytes],
    [proof.path, proofBytes],
    [brokerProof.path, brokerResultBytes],
    [brokerAcceptanceReference.path, brokerAcceptanceBytes],
    [actionAttestationReference.path, actionAttestationBytes],
    [observer.path, transcriptBytes],
  ]);
  const artifacts = collectProbeControllerActionSignedArtifacts(receipt).map(({ path }) => {
    const bytes = bytesByPath.get(path);
    if (bytes === undefined) throw new Error(`scenario artifact fixture is missing: ${path}`);
    return { path, bytes: Buffer.from(bytes) };
  });
  const input = {
    command,
    workItem,
    preparedContext,
    operationId: runtimeActionBinding.operationId,
    operationIntentPath: runtimeActionBinding.operationIntentPath,
    operationResultPath: runtimeActionBinding.operationResultPath,
    execution: runtimeActionBinding.execution,
    invocation,
  };
  const encoded = encodeControllerOperationRequest({
    operationKind: "scenario-action",
    input: controllerWireInput(input),
  });
  const request = requestFor("scenario-action", encoded.bytes, encoded.intentSha256, {
    candidateSha256: preparedContext.candidateSha256,
    runAuthorizationClaimSha256: preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate,
    operation: receipt.operation,
    controllerIdentitySha256: preparedContext.executionBundleManifest.controller.identitySha256,
    ...options.requestOverrides,
  });
  return {
    actionAttestation,
    receipt,
    artifacts,
    input,
    handlerInput: {
      request,
      payloadBytes: Buffer.from(encoded.bytes),
      recoveryRequired: false,
    },
  };
}

function rebuildScenarioEvidence(
  material: ReturnType<typeof scenarioMaterial>,
  proofArtifacts: readonly { readonly path: string; readonly sha256: string }[],
  byteOverrides: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  const base = material.receipt;
  const actionResult = { ...base.actionResult, evidenceArtifacts: proofArtifacts };
  const resultBytes = Buffer.from(canonicalProbeJson(actionResult), "utf8");
  const input: ProbeControllerActionExecutionReceiptCreateInput = {
    candidateSha256: base.candidateSha256,
    executionBundleId: base.executionBundleId,
    executionBundleManifestSha256: base.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: base.runAuthorizationClaimReceiptSha256,
    coordinate: base.coordinate,
    scenarioPlanSha256: base.scenarioPlanSha256,
    producerActionId: base.producerActionId,
    operation: base.operation,
    intentSha256: base.intentSha256,
    execution: base.execution,
    expectedActor: base.expectedActor,
    actionResult,
    actionResultArtifact: {
      path: base.actionResultArtifact.path,
      sha256: sha256(resultBytes),
    },
    proofArtifacts,
    observerTranscripts: base.observerTranscripts,
    brokerProof: base.brokerProof,
    pausedSessionReceipt: base.pausedSessionReceipt,
    nativeActionPlans: base.nativeActionPlans,
  };
  const receipt = createProbeControllerActionExecutionReceipt(input);
  const availableBytes = new Map(
    material.artifacts.map(({ path, bytes }) => [path, Buffer.from(bytes)] as const),
  );
  for (const [path, bytes] of byteOverrides) availableBytes.set(path, Buffer.from(bytes));
  availableBytes.set(receipt.actionResultArtifact.path, resultBytes);
  const artifacts = collectProbeControllerActionSignedArtifacts(receipt).map(({ path }) => {
    const bytes = availableBytes.get(path);
    if (bytes === undefined) throw new Error(`rebuilt scenario artifact is missing: ${path}`);
    return { path, bytes };
  });
  return { receipt, artifacts };
}

function hardCutMaterial(
  options: {
    readonly repetition?: number;
    readonly receiptActionRepetition?: number;
    readonly receiptOverrides?: Partial<ProbeControllerActionExecutionReceiptCreateInput>;
    readonly observerBindingOverrides?: Readonly<Record<string, string>>;
    readonly handshakeOnlyObserver?: boolean;
  } = {},
) {
  const repetition = options.repetition ?? 2;
  const receiptActionRepetition = options.receiptActionRepetition ?? repetition;
  const workItem = PROBE_RUN_PLAN.work.find(
    ({ variantId }) => variantId === "f07-hard-cut-after-file-flush",
  );
  if (workItem === undefined) throw new Error("controller handler hard-cut fixture is missing");
  const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
  const action = definition.actions.find(
    ({ actionId }) => actionId === `hard-cut-guest-r${receiptActionRepetition}`,
  );
  if (action === undefined) throw new Error("controller handler hard-cut action is missing");
  const runRootIdentity = "volume-v1:controller-handler-root";
  const preparedContext = createPreparedContextFixture({
    candidateSha256,
    runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaimSha256,
    campaignRunId: "campaign-one",
    executionRunId: "execution-one",
    attemptId: "attempt-one",
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    evidenceRootObjectIdentitySha256: sha256(runRootIdentity),
  });
  const command = {
    campaignRunId: preparedContext.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    executionBundleId: preparedContext.executionBundleId,
    attemptId: preparedContext.attemptId,
    workId: workItem.workId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    repetition,
    checkpointId: `checkpoint-${repetition}`,
    chainId: `chain-${repetition}`,
  };
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action,
  };
  const runtimeActionBinding = createProbeRuntimeActionBinding({
    command,
    invocation,
    preparedContext,
  });
  const coordinate = {
    campaignRunId: command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    rowId: command.rowId as `F-${string}`,
    variantId: command.variantId,
    repetition: command.repetition,
  };
  const evidencePrefix = [
    "segments",
    coordinate.environmentId,
    coordinate.pathProfileId,
    coordinate.rowId.toLocaleLowerCase("en-US"),
    coordinate.variantId,
    "evidence",
  ].join("/");
  const proofBytes = Buffer.from(`hard-cut checkpoint proof r${repetition}`, "utf8");
  const proof = {
    path: `${evidencePrefix}/hard-cut-receipt-r${repetition}.json`,
    sha256: sha256(proofBytes),
  };
  const checkpointRequestFields = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-request" as const,
    campaignId: preparedContext.campaignId,
    manifestSha256: preparedContext.manifestSha256,
    candidateSha256: preparedContext.candidateSha256,
    campaignRunId: preparedContext.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    executionBundleId: preparedContext.executionBundleId,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    attemptId: preparedContext.attemptId,
    environmentId: preparedContext.environmentId,
    pathProfileId: preparedContext.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    checkpointId: command.checkpointId,
    sequence: repetition,
    nonceSha256: sha256(`hard-cut-nonce-${repetition}`),
    preCutStateSha256: sha256(`hard-cut-state-${repetition}`),
    preCutBootIdSha256: sha256(`pre-cut-boot-${repetition}`),
    sourceVmSnapshotId: preparedContext.vmSnapshotId,
    continuationScopeSha256: sha256(`continuation-scope-${repetition}`),
    controllerIdentitySha256: preparedContext.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: preparedContext.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: preparedContext.executionBundleManifest.controller.version,
    action: "hard-power-cut" as const,
    signatureAlgorithm: "Ed25519" as const,
  };
  const checkpointRequest = {
    ...checkpointRequestFields,
    signatureBase64: "AQ==",
    requestSha256: deriveExternalCheckpointRequestDigest(checkpointRequestFields),
  };
  const checkpointReceiptFields = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-receipt" as const,
    requestSha256: checkpointRequest.requestSha256,
    controllerIdentitySha256: checkpointRequest.controllerIdentitySha256,
    controllerPublicKeySha256: checkpointRequest.controllerPublicKeySha256,
    controllerVersion: checkpointRequest.controllerVersion,
    action: "hard-power-cut" as const,
    powerCutAt: "2026-08-07T00:00:02.000Z",
    bootStartedAt: "2026-08-07T00:00:03.000Z",
    bootCompletedAt: "2026-08-07T00:00:04.000Z",
    postBootVmSnapshotId: `post-boot-snapshot-${repetition}`,
    preCutBootIdSha256: checkpointRequest.preCutBootIdSha256,
    postBootBootIdSha256: sha256(`post-cut-boot-${repetition}`),
    artifactHashes: [proof],
    signatureAlgorithm: "Ed25519" as const,
  };
  const checkpointReceipt = {
    ...checkpointReceiptFields,
    signatureBase64: "Ag==",
    receiptSha256: deriveExternalCheckpointReceiptDigest(checkpointReceiptFields),
  };
  const transcript = nativeTranscriptFixture(
    preparedContext,
    options.observerBindingOverrides,
    options.handshakeOnlyObserver,
  );
  const transcriptBytes = Buffer.from(canonicalProbeJson(transcript), "utf8");
  const observer = {
    path: `${evidencePrefix}/native-transcripts/${transcript.transcriptSha256}.json`,
    sha256: sha256(transcriptBytes),
    transcriptSha256: transcript.transcriptSha256,
  };
  const actionResult = {
    actionId: action.actionId,
    commandEvent: null,
    evidenceArtifacts: [proof],
  };
  const resultBytes = Buffer.from(canonicalProbeJson(actionResult), "utf8");
  const actionExecutionReceipt = createProbeControllerActionExecutionReceipt({
    candidateSha256: preparedContext.candidateSha256,
    executionBundleId: preparedContext.executionBundleId,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: preparedContext.runAuthorizationClaimReceiptSha256,
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
    actionResult,
    actionResultArtifact: {
      path: runtimeActionBinding.operationResultPath,
      sha256: sha256(resultBytes),
    },
    proofArtifacts: [proof],
    observerTranscripts: [observer],
    brokerProof: null,
    pausedSessionReceipt: null,
    nativeActionPlans: [],
    ...options.receiptOverrides,
  });
  const bytesByPath = new Map([
    [actionExecutionReceipt.actionResultArtifact.path, resultBytes],
    [proof.path, proofBytes],
    [observer.path, transcriptBytes],
  ]);
  const artifacts = collectProbeControllerActionSignedArtifacts(actionExecutionReceipt).map(
    ({ path }) => {
      const bytes = bytesByPath.get(path);
      if (bytes === undefined) throw new Error(`hard-cut artifact fixture is missing: ${path}`);
      return { path, bytes: Buffer.from(bytes) };
    },
  );
  const input = {
    command,
    workItem,
    preparedContext,
    request: checkpointRequest,
  };
  const encoded = encodeControllerOperationRequest({
    operationKind: "hard-cut-receipt-read",
    input: controllerWireInput(input),
  });
  const outerOperation = {
    operationId: `operation-${hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-controller-spool-operation.v1",
      campaignId: preparedContext.campaignId,
      candidateSha256: preparedContext.candidateSha256,
      runAuthorizationSha256: preparedContext.runAuthorizationSha256,
      coordinate,
      operationKind: "hard-cut-receipt-read",
      sequence: repetition,
    }).slice(0, 32)}`,
    kind: "hard-cut-receipt-read" as const,
    sequence: repetition,
  };
  const signedRequest = requestFor("hard-cut-receipt-read", encoded.bytes, encoded.intentSha256, {
    candidateSha256: preparedContext.candidateSha256,
    runAuthorizationClaimSha256: preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate,
    operation: outerOperation,
    controllerIdentitySha256: preparedContext.executionBundleManifest.controller.identitySha256,
  });
  return {
    actionExecutionReceipt,
    artifacts,
    input,
    checkpointEvidence: {
      request: checkpointRequest,
      receipt: checkpointReceipt,
    },
    handlerInput: {
      request: signedRequest,
      payloadBytes: Buffer.from(encoded.bytes),
      recoveryRequired: false,
    },
  };
}

function successfulDriver(): ControllerOperationDriver {
  return vi.fn(async ({ input, recoveryRequired }) => ({
    outcome: "SUCCEEDED",
    result: { input, recoveryRequired },
    artifacts: [],
  }));
}

function registry(
  overrides: Partial<Record<ControllerOperationKind, ControllerOperationDriver>> = {},
): ControllerOperationDriverRegistry {
  return Object.fromEntries(
    CONTROLLER_OPERATION_KINDS.map((operationKind) => [
      operationKind,
      overrides[operationKind] ?? successfulDriver(),
    ]),
  ) as ControllerOperationDriverRegistry;
}

describe("Windows host probe controller operation handler", () => {
  it("requires an exact exhaustive data-property driver registry", () => {
    const complete = registry();
    const { "scenario-action": _missing, ...missing } = complete;
    expect(() =>
      createControllerOperationHandler(missing as ControllerOperationDriverRegistry),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_HANDLER_REGISTRY" }));
    expect(() =>
      createControllerOperationHandler({
        ...complete,
        unexpected: successfulDriver(),
      } as ControllerOperationDriverRegistry),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_HANDLER_REGISTRY" }));
    expect(() =>
      createControllerOperationHandler({
        ...complete,
        "scenario-action": null,
      } as unknown as ControllerOperationDriverRegistry),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_HANDLER_REGISTRY" }));

    const accessor = Object.fromEntries(Object.entries(complete));
    Object.defineProperty(accessor, "scenario-action", {
      enumerable: true,
      get: () => successfulDriver(),
    });
    expect(() =>
      createControllerOperationHandler(accessor as ControllerOperationDriverRegistry),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_HANDLER_REGISTRY" }));
  });

  it("dispatches every non-receipt operation kind exclusively and preserves deterministic recovery replay", async () => {
    for (const operationKind of CONTROLLER_OPERATION_KINDS.filter(
      (kind) => kind !== "scenario-action" && kind !== "hard-cut-receipt-read",
    )) {
      const alphaBytes = Buffer.from(`alpha:${operationKind}`, "utf8");
      const zetaBytes = Buffer.from(`zeta:${operationKind}`, "utf8");
      const selectedDriver = vi.fn(async (driverInput) => {
        expect(Object.isFrozen(driverInput)).toBe(true);
        expect(Object.isFrozen(driverInput.request)).toBe(true);
        expect(Object.isFrozen(driverInput.input)).toBe(true);
        return {
          outcome: "SUCCEEDED" as const,
          result: {
            accepted: operationKind,
          },
          artifacts: [
            { path: "zeta/evidence.bin", bytes: zetaBytes },
            { path: "alpha/évidence.json", bytes: alphaBytes },
          ],
        };
      });
      const drivers = registry({ [operationKind]: selectedDriver });
      const handler = createControllerOperationHandler(drivers);
      const initial = exchangeInput(operationKind, { operationKind, value: 7 }, false);
      const recovery = exchangeInput(operationKind, { operationKind, value: 7 }, true);

      const first = await handler(initial.handlerInput);
      const replay = await handler(recovery.handlerInput);

      expect(selectedDriver).toHaveBeenCalledTimes(2);
      expect(selectedDriver.mock.calls.map(([value]) => value.recoveryRequired)).toEqual([
        false,
        true,
      ]);
      for (const otherKind of CONTROLLER_OPERATION_KINDS) {
        if (otherKind !== operationKind) expect(drivers[otherKind]).not.toHaveBeenCalled();
      }
      expect(first.outcome).toBe("SUCCEEDED");
      expect(first.artifactBytes.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual([
        `alpha:${operationKind}`,
        `zeta:${operationKind}`,
      ]);
      expect(replay.artifactBytes.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual([
        `alpha:${operationKind}`,
        `zeta:${operationKind}`,
      ]);

      const decoded = decodeControllerOperationResponse(first.payloadBytes, {
        expectedOperationKind: operationKind,
        outcome: first.outcome,
        artifacts: first.artifactBytes
          .map((bytes) => reference(bytes))
          .sort((left, right) => left.sha256.localeCompare(right.sha256)),
      });
      expect(decoded.envelope.artifactBindings).toEqual([
        { path: "alpha/évidence.json", sha256: sha256(alphaBytes) },
        { path: "zeta/evidence.bin", sha256: sha256(zetaBytes) },
      ]);
      expect(decoded.envelope.result).toEqual({
        accepted: operationKind,
      });
      expect(Buffer.from(first.payloadBytes).equals(Buffer.from(replay.payloadBytes))).toBe(true);
    }
  });

  it("signs a successful scenario action only when its receipt and raw evidence are exact", async () => {
    const material = scenarioMaterial();
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt,
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    const handled = await handler(material.handlerInput);

    expect(handled.outcome).toBe("SUCCEEDED");
    expect(selected).toHaveBeenCalledOnce();
    const decoded = decodeControllerOperationResponse(handled.payloadBytes, {
      expectedOperationKind: "scenario-action",
      outcome: handled.outcome,
      artifacts: handled.artifactBytes
        .map((bytes) => reference(bytes))
        .sort((left, right) => left.sha256.localeCompare(right.sha256)),
    });
    expect(decoded.envelope.result).toEqual(material.receipt);
    expect(decoded.envelope.artifactBindings).toEqual(
      collectProbeControllerActionSignedArtifacts(material.receipt),
    );
  });

  it("refuses to elevate a raw broker result without controller broker acceptance", async () => {
    const material = scenarioMaterial();
    const proofArtifacts = material.receipt.proofArtifacts.filter(
      ({ path }) => !path.includes("/broker-acceptances/"),
    );
    const rebuilt = rebuildScenarioEvidence(material, proofArtifacts);
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: rebuilt.receipt,
      artifacts: rebuilt.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_ATTESTATION",
    });
    expect(selected).toHaveBeenCalledOnce();
  });

  it("rejects unrelated same-run action attestation and observer reuse before signing", async () => {
    const expected = scenarioMaterial();
    const attestationReference = expected.receipt.proofArtifacts.find(({ path }) =>
      path.includes("/action-attestations/"),
    );
    if (attestationReference === undefined)
      throw new Error("action attestation fixture is missing");
    const attestation = expected.actionAttestation;
    const unrelatedAttestation = createProbeControllerActionAttestation({
      candidateSha256: attestation.candidateSha256,
      executionBundleId: attestation.executionBundleId,
      executionBundleManifestSha256: attestation.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256: attestation.runAuthorizationClaimReceiptSha256,
      coordinate: { ...attestation.coordinate, repetition: 1 },
      scenarioPlanSha256: attestation.scenarioPlanSha256,
      producerActionId: attestation.producerActionId,
      operation: attestation.operation,
      runtimeActionIntentSha256: attestation.runtimeActionIntentSha256,
      execution: attestation.execution,
      expectedActor: attestation.expectedActor,
      broker: attestation.broker,
      observerCommands: attestation.observerCommands,
    });
    const unrelatedAttestationBytes = Buffer.from(canonicalProbeJson(unrelatedAttestation), "utf8");
    const reusedReference = {
      path: attestationReference.path,
      sha256: sha256(unrelatedAttestationBytes),
    };
    const proofArtifacts = expected.receipt.proofArtifacts.map((reference) =>
      reference.path === attestationReference.path ? reusedReference : reference,
    );
    const rebuilt = rebuildScenarioEvidence(
      expected,
      proofArtifacts,
      new Map([[reusedReference.path, unrelatedAttestationBytes]]),
    );
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: rebuilt.receipt,
      artifacts: rebuilt.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(expected.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_ATTESTATION",
    });
    expect(selected).toHaveBeenCalledOnce();
  });

  it("rejects frozen scenario drift before invoking the physical action driver", async () => {
    const material = scenarioMaterial();
    const action = material.input.invocation.action;
    const driftedInputs = [
      {
        ...material.input,
        invocation: {
          ...material.input.invocation,
          action: {
            ...action,
            parameters: { ...action.parameters, pathTopology: "substituted-topology" },
          },
        },
      },
      {
        ...material.input,
        invocation: {
          ...material.input.invocation,
          action: { ...action, prerequisiteActionIds: ["planted-prerequisite"] },
        },
      },
      {
        ...material.input,
        invocation: {
          ...material.input.invocation,
          action: { ...action, sequence: action.sequence + 1 },
        },
      },
      {
        ...material.input,
        workItem: { ...material.input.workItem, continuationRepetitions: 99 },
      },
      {
        ...material.input,
        command: { ...material.input.command, repetition: 1 },
      },
    ];

    for (const input of driftedInputs) {
      const encoded = encodeControllerOperationRequest({
        operationKind: "scenario-action",
        input: controllerWireInput(input),
      });
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: material.receipt,
        artifacts: material.artifacts,
      }));
      const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

      await expect(
        handler({
          ...material.handlerInput,
          request: requestFor("scenario-action", encoded.bytes, encoded.intentSha256, {
            candidateSha256: material.handlerInput.request.candidateSha256,
            runAuthorizationClaimSha256: material.handlerInput.request.runAuthorizationClaimSha256,
            coordinate: material.handlerInput.request.coordinate,
            operation: material.handlerInput.request.operation,
          }),
          payloadBytes: encoded.bytes,
        }),
      ).rejects.toMatchObject({
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      });
      expect(selected).not.toHaveBeenCalled();
    }
  });

  it("rejects a tampered root-free prepared authority before invoking the driver", async () => {
    const material = scenarioMaterial();
    const wireInput = controllerWireInput(material.input) as {
      readonly preparedAuthority: Readonly<Record<string, unknown>>;
    };
    const encoded = encodeControllerOperationRequest({
      operationKind: "scenario-action",
      input: {
        ...wireInput,
        preparedAuthority: {
          ...wireInput.preparedAuthority,
          candidateSha256: "8".repeat(64),
        },
      },
    });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt,
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(
      handler({
        ...material.handlerInput,
        request: requestFor("scenario-action", encoded.bytes, encoded.intentSha256, {
          candidateSha256: material.handlerInput.request.candidateSha256,
          runAuthorizationClaimSha256: material.handlerInput.request.runAuthorizationClaimSha256,
          coordinate: material.handlerInput.request.coordinate,
          operation: material.handlerInput.request.operation,
          controllerIdentitySha256: material.handlerInput.request.controllerIdentitySha256,
        }),
        payloadBytes: encoded.bytes,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST" });
    expect(selected).not.toHaveBeenCalled();
  });

  it("rejects a bare successful scenario result at the signing gateway", async () => {
    const material = scenarioMaterial();
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt.actionResult,
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_RECEIPT",
    });
  });

  it("rejects successful receipts with substituted runtime intent, actor, or operation", async () => {
    const valid = scenarioMaterial();
    const substitutions = [
      {
        material: scenarioMaterial({ receiptOverrides: { intentSha256: "8".repeat(64) } }),
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      },
      {
        material: scenarioMaterial({
          receiptOverrides: {
            expectedActor: {
              ...valid.receipt.expectedActor,
              identitySha256: "8".repeat(64),
            },
          },
        }),
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING",
      },
      {
        material: scenarioMaterial({
          receiptOverrides: {
            operation: {
              ...valid.receipt.operation,
              operationId: "operation-substituted",
            },
          },
        }),
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST",
      },
      {
        material: scenarioMaterial({
          receiptOverrides: {
            operation: {
              ...valid.receipt.operation,
              sequence: valid.receipt.operation.sequence + 1,
            },
          },
        }),
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST",
      },
    ];

    for (const { material, code } of substitutions) {
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: material.receipt,
        artifacts: material.artifacts,
      }));
      const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));
      await expect(handler(material.handlerInput)).rejects.toMatchObject({
        code,
      });
    }
  });

  it("rejects a successful receipt when its request authority is substituted", async () => {
    const valid = scenarioMaterial();
    const coordinate = {
      ...valid.handlerInput.request.coordinate,
      repetition: valid.handlerInput.request.coordinate.repetition! + 1,
    };
    const substitutions = [
      scenarioMaterial({ requestOverrides: { candidateSha256: "8".repeat(64) } }),
      scenarioMaterial({ requestOverrides: { runAuthorizationSha256: "8".repeat(64) } }),
      scenarioMaterial({ requestOverrides: { runAuthorizationClaimSha256: "8".repeat(64) } }),
      scenarioMaterial({ requestOverrides: { coordinate } }),
      scenarioMaterial({
        requestOverrides: {
          operation: { ...valid.receipt.operation, operationId: "operation-request-substituted" },
        },
      }),
    ];

    for (const material of substitutions) {
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: material.receipt,
        artifacts: material.artifacts,
      }));
      const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));
      await expect(handler(material.handlerInput)).rejects.toMatchObject({
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST",
      });
      expect(selected).not.toHaveBeenCalled();
    }
  });

  it("rejects missing and extra successful scenario artifacts", async () => {
    const material = scenarioMaterial();
    const artifactSets = [
      material.artifacts.slice(1),
      [
        ...material.artifacts,
        { path: "runtime/unclaimed-evidence.bin", bytes: Buffer.from("unclaimed", "utf8") },
      ],
    ];

    for (const artifacts of artifactSets) {
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: material.receipt,
        artifacts,
      }));
      const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));
      await expect(handler(material.handlerInput)).rejects.toMatchObject({
        code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_ARTIFACT",
      });
    }
  });

  it("rejects non-canonical action-result artifact bytes before signing", async () => {
    const material = scenarioMaterial();
    const artifacts = material.artifacts.map((artifact) =>
      artifact.path === material.receipt.actionResultArtifact.path
        ? { ...artifact, bytes: Buffer.from("{}\n", "utf8") }
        : artifact,
    );
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt,
      artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_RESULT",
    });
  });

  it("rejects a semantically valid observer transcript bound to another prepared context", async () => {
    const material = scenarioMaterial({
      observerBindingOverrides: { candidateSha256: "8".repeat(64) },
    });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt,
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
    });
  });

  it("rejects a handshake-only scenario observer transcript", async () => {
    const material = scenarioMaterial({ handshakeOnlyObserver: true });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: material.receipt,
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER",
    });
  });

  it("signs a successful hard-cut read only with a separately bound action receipt", async () => {
    const material = hardCutMaterial();
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    const handled = await handler(material.handlerInput);

    expect(handled.outcome).toBe("SUCCEEDED");
    expect(material.handlerInput.request.operation.kind).toBe("hard-cut-receipt-read");
    expect(material.actionExecutionReceipt.operation.kind).toBe("scenario-action");
    expect(material.handlerInput.request.operation.operationId).not.toBe(
      material.actionExecutionReceipt.operation.operationId,
    );
    const decoded = decodeControllerOperationResponse(handled.payloadBytes, {
      expectedOperationKind: "hard-cut-receipt-read",
      outcome: handled.outcome,
      artifacts: handled.artifactBytes
        .map((bytes) => reference(bytes))
        .sort((left, right) => left.sha256.localeCompare(right.sha256)),
    });
    expect(decoded.envelope.result).toEqual({
      checkpointEvidence: material.checkpointEvidence,
      actionExecutionReceipt: material.actionExecutionReceipt,
    });
    expect(decoded.envelope.artifactBindings).toEqual(
      collectProbeControllerActionSignedArtifacts(material.actionExecutionReceipt),
    );
  });

  it("rejects frozen hard-cut work drift before invoking the physical receipt driver", async () => {
    const material = hardCutMaterial();
    const input = {
      ...material.input,
      workItem: { ...material.input.workItem, continuationRepetitions: 99 },
    };
    const encoded = encodeControllerOperationRequest({
      operationKind: "hard-cut-receipt-read",
      input: controllerWireInput(input),
    });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(
      handler({
        ...material.handlerInput,
        request: requestFor("hard-cut-receipt-read", encoded.bytes, encoded.intentSha256, {
          candidateSha256: material.handlerInput.request.candidateSha256,
          runAuthorizationClaimSha256: material.handlerInput.request.runAuthorizationClaimSha256,
          coordinate: material.handlerInput.request.coordinate,
          operation: material.handlerInput.request.operation,
        }),
        payloadBytes: encoded.bytes,
      }),
    ).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
    });
    expect(selected).not.toHaveBeenCalled();
  });

  it("rejects the legacy unsigned hard-cut action result", async () => {
    const material = hardCutMaterial();
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        hardCutActionResult: material.actionExecutionReceipt.actionResult,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RECEIPT",
      operationKind: "hard-cut-receipt-read",
    });
  });

  it("rejects a hard-cut action receipt for another repetition", async () => {
    const material = hardCutMaterial({ repetition: 2, receiptActionRepetition: 1 });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
    });
  });

  it("rejects hard-cut checkpoint evidence that answers another request", async () => {
    const material = hardCutMaterial();
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: {
          ...material.checkpointEvidence,
          request: {
            ...material.checkpointEvidence.request,
            checkpointId: "checkpoint-substituted",
          },
        },
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
    });
  });

  it("rejects a hard-cut action receipt with a substituted runtime binding", async () => {
    const material = hardCutMaterial({
      receiptOverrides: { intentSha256: "8".repeat(64) },
    });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING",
    });
  });

  it("rejects hard-cut action authority substituted in the outer signed request", async () => {
    const material = hardCutMaterial();
    const coordinate = {
      ...material.handlerInput.request.coordinate,
      repetition: material.handlerInput.request.coordinate.repetition! + 1,
    };
    const requests = [
      reviseRequest(material.handlerInput.request, { candidateSha256: "8".repeat(64) }),
      reviseRequest(material.handlerInput.request, { runAuthorizationSha256: "8".repeat(64) }),
      reviseRequest(material.handlerInput.request, {
        runAuthorizationClaimSha256: "8".repeat(64),
      }),
      reviseRequest(material.handlerInput.request, { coordinate }),
      reviseRequest(material.handlerInput.request, {
        operation: {
          ...material.handlerInput.request.operation,
          operationId: "operation-substituted",
        },
      }),
    ];
    for (const request of requests) {
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: {
          checkpointEvidence: material.checkpointEvidence,
          actionExecutionReceipt: material.actionExecutionReceipt,
        },
        artifacts: material.artifacts,
      }));
      const handler = createControllerOperationHandler(
        registry({ "hard-cut-receipt-read": selected }),
      );

      await expect(handler({ ...material.handlerInput, request })).rejects.toMatchObject({
        code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_REQUEST",
      });
      expect(selected).not.toHaveBeenCalled();
    }
  });

  it("rejects hard-cut action evidence that differs from the checkpoint receipt", async () => {
    const material = hardCutMaterial();
    const substitutedProof = {
      path: material.checkpointEvidence.receipt.artifactHashes[0].path.replace(
        ".json",
        "-substituted.json",
      ),
      sha256: "8".repeat(64),
    };
    const checkpointReceiptDraft = {
      ...material.checkpointEvidence.receipt,
      artifactHashes: [substitutedProof],
    };
    const checkpointReceipt = {
      ...checkpointReceiptDraft,
      receiptSha256: deriveExternalCheckpointReceiptDigest(checkpointReceiptDraft),
    };
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: {
          request: material.checkpointEvidence.request,
          receipt: checkpointReceipt,
        },
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT",
    });
  });

  it("rejects missing and extra hard-cut signed artifacts", async () => {
    const material = hardCutMaterial();
    const artifactSets = [
      material.artifacts.slice(1),
      [
        ...material.artifacts,
        { path: "runtime/unclaimed-hard-cut.bin", bytes: Buffer.from("unclaimed hard-cut") },
      ],
    ];
    for (const artifacts of artifactSets) {
      const selected = vi.fn(async () => ({
        outcome: "SUCCEEDED" as const,
        result: {
          checkpointEvidence: material.checkpointEvidence,
          actionExecutionReceipt: material.actionExecutionReceipt,
        },
        artifacts,
      }));
      const handler = createControllerOperationHandler(
        registry({ "hard-cut-receipt-read": selected }),
      );

      await expect(handler(material.handlerInput)).rejects.toMatchObject({
        code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ARTIFACT",
      });
    }
  });

  it("rejects non-canonical hard-cut action-result artifact bytes", async () => {
    const material = hardCutMaterial();
    const artifacts = material.artifacts.map((artifact) =>
      artifact.path === material.actionExecutionReceipt.actionResultArtifact.path
        ? { ...artifact, bytes: Buffer.from("{}\n", "utf8") }
        : artifact,
    );
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RESULT",
    });
  });

  it("rejects a hard-cut observer transcript bound to another prepared context", async () => {
    const material = hardCutMaterial({
      observerBindingOverrides: { candidateSha256: "8".repeat(64) },
    });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_OBSERVER",
    });
  });

  it("rejects a handshake-only hard-cut observer transcript", async () => {
    const material = hardCutMaterial({ handshakeOnlyObserver: true });
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: {
        checkpointEvidence: material.checkpointEvidence,
        actionExecutionReceipt: material.actionExecutionReceipt,
      },
      artifacts: material.artifacts,
    }));
    const handler = createControllerOperationHandler(
      registry({ "hard-cut-receipt-read": selected }),
    );

    await expect(handler(material.handlerInput)).rejects.toMatchObject({
      code: "CONTROLLER_OPERATION_HANDLER_HARD_CUT_OBSERVER",
    });
  });

  it("preserves bare error results for unsuccessful hard-cut reads", async () => {
    for (const outcome of ["FAILED", "INCONCLUSIVE"] as const) {
      const { handlerInput } = hardCutMaterial();
      const selected = vi.fn(async () => ({
        outcome,
        result: { error: outcome.toLocaleLowerCase("en-US") },
        artifacts: [],
      }));
      const handler = createControllerOperationHandler(
        registry({ "hard-cut-receipt-read": selected }),
      );

      const handled = await handler(handlerInput);
      expect(JSON.parse(Buffer.from(handled.payloadBytes).toString("utf8"))).toEqual({
        schemaVersion: 1,
        kind: "windows-host-probe-controller-operation-response",
        operationKind: "hard-cut-receipt-read",
        result: { error: outcome.toLocaleLowerCase("en-US") },
        artifactBindings: [],
      });
    }
  });

  it("preserves bare error results for unsuccessful scenario outcomes", async () => {
    for (const outcome of ["FAILED", "INCONCLUSIVE"] as const) {
      const { handlerInput } = scenarioMaterial();
      const selected = vi.fn(async () => ({
        outcome,
        result: { error: outcome.toLocaleLowerCase("en-US") },
        artifacts: [],
      }));
      const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));

      const handled = await handler(handlerInput);
      expect(JSON.parse(Buffer.from(handled.payloadBytes).toString("utf8"))).toEqual({
        schemaVersion: 1,
        kind: "windows-host-probe-controller-operation-response",
        operationKind: "scenario-action",
        result: { error: outcome.toLocaleLowerCase("en-US") },
        artifactBindings: [],
      });
    }
  });

  it("accepts each declared outcome while keeping the operation response canonical", async () => {
    for (const outcome of CONTROLLER_RESPONSE_OUTCOMES) {
      const selected = vi.fn(async () => ({ outcome, result: { outcome }, artifacts: [] }));
      const handler = createControllerOperationHandler(
        registry({ "capture-disposition-observation": selected }),
      );
      const { handlerInput } = exchangeInput("capture-disposition-observation", { value: 1 });
      const handled = await handler(handlerInput);
      expect(handled.outcome).toBe(outcome);
      expect(JSON.parse(Buffer.from(handled.payloadBytes).toString("utf8"))).toEqual({
        schemaVersion: 1,
        kind: "windows-host-probe-controller-operation-response",
        operationKind: "capture-disposition-observation",
        result: { outcome },
        artifactBindings: [],
      });
    }
  });

  it("fails before driver dispatch when payload binding, operation kind, or intent differs", async () => {
    const selected = successfulDriver();
    const handler = createControllerOperationHandler(registry({ "scenario-action": selected }));
    const encoded = encodeControllerOperationRequest({
      operationKind: "scenario-action",
      input: { actionId: "one" },
    });

    await expect(
      handler({
        request: requestFor("scenario-action", encoded.bytes, encoded.intentSha256, {
          payloadReferenceBytes: Buffer.from("another payload", "utf8"),
        }),
        payloadBytes: encoded.bytes,
        recoveryRequired: false,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_HANDLER_PAYLOAD_BINDING" });

    await expect(
      handler({
        request: requestFor("scenario-action", encoded.bytes, "6".repeat(64)),
        payloadBytes: encoded.bytes,
        recoveryRequired: false,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_HANDLER_INTENT" });

    const otherKind = encodeControllerOperationRequest({
      operationKind: "controller-observation",
      input: { actionId: "one" },
    });
    await expect(
      handler({
        request: requestFor("scenario-action", otherKind.bytes, otherKind.intentSha256),
        payloadBytes: otherKind.bytes,
        recoveryRequired: true,
      }),
    ).rejects.toBeInstanceOf(ControllerOperationCodecError);
    expect(selected).not.toHaveBeenCalled();
  });

  it("rejects malformed handler and driver results without producing spool output", async () => {
    const { handlerInput } = exchangeInput("capture-disposition-observation", { value: 1 });
    const invalidResults: readonly {
      readonly value: unknown;
      readonly code: string;
    }[] = [
      {
        value: { outcome: "SUCCEEDED", result: null, artifacts: [], extra: true },
        code: "CONTROLLER_OPERATION_HANDLER_DRIVER_RESULT",
      },
      {
        value: { outcome: "SUCCEEDED", result: null },
        code: "CONTROLLER_OPERATION_HANDLER_DRIVER_RESULT",
      },
      {
        value: { outcome: "UNKNOWN", result: null, artifacts: [] },
        code: "CONTROLLER_OPERATION_HANDLER_OUTCOME",
      },
      {
        value: { outcome: "SUCCEEDED", result: null, artifacts: "none" },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: Object.assign([], { unexpected: true }),
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: Object.assign([], { length: 1 }),
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: [{ path: "evidence/one.bin", bytes: Buffer.from("one"), extra: true }],
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: [{ path: "evidence/one.bin", bytes: "not-bytes" }],
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: [
            { path: "Evidence/one.bin", bytes: Buffer.from("one") },
            { path: "evidence/ONE.bin", bytes: Buffer.from("two") },
          ],
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT_PATH_COLLISION",
      },
      {
        value: {
          outcome: "SUCCEEDED",
          result: null,
          artifacts: [
            { path: "evidence/one.bin", bytes: Buffer.from("same") },
            { path: "evidence/two.bin", bytes: Buffer.from("same") },
          ],
        },
        code: "CONTROLLER_OPERATION_HANDLER_ARTIFACT_DIGEST_COLLISION",
      },
    ];

    for (const invalid of invalidResults) {
      const selected = vi.fn(async () => invalid.value) as unknown as ControllerOperationDriver;
      const handler = createControllerOperationHandler(
        registry({ "capture-disposition-observation": selected }),
      );
      await expect(handler(handlerInput)).rejects.toMatchObject({ code: invalid.code });
      expect(selected).toHaveBeenCalledOnce();
    }

    const selected = successfulDriver();
    const handler = createControllerOperationHandler(
      registry({ "capture-disposition-observation": selected }),
    );
    await expect(
      handler({ ...handlerInput, unexpected: true } as typeof handlerInput),
    ).rejects.toBeInstanceOf(ControllerOperationHandlerError);
    await expect(
      handler({ ...handlerInput, recoveryRequired: "yes" } as unknown as typeof handlerInput),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_HANDLER_INPUT" });
  });

  it("delegates canonical JSON and safe-path validation to the operation codec", async () => {
    const cases: readonly unknown[] = [
      { outcome: "SUCCEEDED", result: { invalid: undefined }, artifacts: [] },
      {
        outcome: "SUCCEEDED",
        result: null,
        artifacts: [{ path: "../escape.bin", bytes: Buffer.from("escape") }],
      },
      {
        outcome: "SUCCEEDED",
        result: null,
        artifacts: [{ path: "evidence/CON", bytes: Buffer.from("reserved") }],
      },
      {
        outcome: "SUCCEEDED",
        result: null,
        artifacts: [{ path: "evidence/not-normalized-e\u0301.json", bytes: Buffer.from("nfd") }],
      },
    ];
    const { handlerInput } = exchangeInput("capture-disposition-observation", { value: 1 });
    for (const value of cases) {
      const selected = vi.fn(async () => value) as unknown as ControllerOperationDriver;
      const handler = createControllerOperationHandler(
        registry({ "capture-disposition-observation": selected }),
      );
      await expect(handler(handlerInput)).rejects.toBeInstanceOf(ControllerOperationCodecError);
    }
  });

  it("copies registry selections and artifact bytes across asynchronous boundaries", async () => {
    const originalBytes = Buffer.from("immutable evidence", "utf8");
    const selected = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      result: { retained: true },
      artifacts: [{ path: "evidence/result.bin", bytes: originalBytes }],
    }));
    const drivers = registry({ "capture-disposition-observation": selected });
    const handler = createControllerOperationHandler(drivers);
    drivers["capture-disposition-observation"] = vi.fn() as ControllerOperationDriver;
    const { handlerInput } = exchangeInput("capture-disposition-observation", { value: 1 });

    const handled = await handler(handlerInput);
    originalBytes.fill(0);

    expect(selected).toHaveBeenCalledOnce();
    expect(Buffer.from(handled.artifactBytes[0]).toString("utf8")).toBe("immutable evidence");
  });

  it("propagates driver failures and never falls through to another operation driver", async () => {
    const failure = new Error("controller backend unavailable");
    const selected = vi.fn(async () => {
      throw failure;
    });
    const drivers = registry({ "source-transcript-sign": selected });
    const handler = createControllerOperationHandler(drivers);
    const { handlerInput } = exchangeInput("source-transcript-sign", { transcriptSha256 });

    await expect(handler(handlerInput)).rejects.toBe(failure);
    expect(selected).toHaveBeenCalledOnce();
    for (const operationKind of CONTROLLER_OPERATION_KINDS) {
      if (operationKind !== "source-transcript-sign") {
        expect(drivers[operationKind]).not.toHaveBeenCalled();
      }
    }
  });
});
