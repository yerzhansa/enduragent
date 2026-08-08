import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";
import type { EvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import { openEvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  decodeControllerOperationRequest,
  encodeControllerOperationResponse,
} from "../scripts/windows-host-falsifier/controller/operation-codec.mjs";
import {
  CONTROLLER_RESPONSE_KIND,
  deriveControllerResponseDigest,
  type ControllerRequest,
  type ControllerResponseDraft,
} from "../scripts/windows-host-falsifier/controller/protocol.mjs";
import {
  deriveNativePreflightObservationDigest,
  deriveNativePreflightTranscriptDigest,
  validateNativeCommandTranscript,
  validateNativePreflightObservation,
  validateNativePreflightTranscript,
  type NativeBuildIdentity,
  type NativeCommand,
  type NativeCommandTranscript,
  type NativePreflightBinding,
  type NativeRequestMap,
  type NativeResultMap,
} from "../scripts/windows-host-falsifier/native-client.mjs";
import type { LoadedProbeBootstrap } from "../scripts/windows-host-falsifier/probe-bootstrap.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeControllerSpoolTransport } from "../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs";
import {
  createProbeControllerActionAttestation,
  createProbeControllerActionExecutionReceipt,
  createProbeControllerBrokerAcceptance,
  probeControllerActionAttestationPath,
  probeControllerBrokerAcceptancePath,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { createProbeBrokerResult } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import { probeSegmentArtifactPaths } from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import {
  createProbeNativeActionPlan,
  deriveProbeNativeActionPlanStepOperationId,
  probeNativeActionPlanPath,
} from "../scripts/windows-host-falsifier/probe-native-action-plan.mjs";
import {
  createProbeNativeOperationIntent,
  openProbeNativeOperationJournal,
} from "../scripts/windows-host-falsifier/probe-native-operation-journal.mjs";
import {
  PROBE_NATIVE_LANE_DRIVER_KEYS,
  PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX,
  createProbeNativeLane,
  probeNativeLaneDriverKey,
  type ProbeNativeLaneRowDrivers,
} from "../scripts/windows-host-falsifier/probe-native-lane.mjs";
import {
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import {
  createProbeRuntimeActionBinding,
  createProbeRuntimeActionBindingFromPreparedAuthority,
} from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import {
  PROBE_SCENARIO_DEFINITIONS,
  getProbeScenarioDefinition,
} from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import type { ProbeTranscriptObservation } from "../scripts/windows-host-falsifier/probe-transcript.mjs";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value: unknown, newline = false) =>
  Buffer.from(`${canonicalProbeJson(value)}${newline ? "\n" : ""}`, "utf8");

async function ensureEvidenceDirectory(store: EvidenceStore, path: string) {
  let current = "";
  for (const segment of path.split("/")) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    try {
      await store.createDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function canonicalDigest(value: unknown) {
  return sha256(Buffer.from(JSON.stringify(JSON.parse(canonicalProbeJson(value))), "utf8"));
}

function preparedExecutionActors(primaryStandardUserSidSha256: string) {
  return {
    primaryStandardUserSidSha256,
    powerControlActorSha256: sha256("power-control-actor"),
    snapshotControlActorSha256: sha256("snapshot-control-actor"),
    remotePeerActorSha256: sha256("remote-peer-actor"),
    secondUserSidSha256: sha256("second-standard-user"),
  } as const;
}

const nativeCanonicalBytes = (value: unknown, newline = false) =>
  Buffer.from(`${JSON.stringify(JSON.parse(canonicalProbeJson(value)))}${newline ? "\n" : ""}`);

function contentReference(bytes: Uint8Array) {
  const digest = sha256(bytes);
  return { blobPath: `blobs/sha256/${digest}` as const, bytes: bytes.length, sha256: digest };
}

function preparedRequest<C extends NativeCommand>(
  command: C,
  request: Readonly<Record<string, unknown>>,
  operationId: string,
) {
  const requestFrame = {
    protocolVersion: 1 as const,
    requestId: `request-${operationId}`,
    command,
    context: { operationId },
    request,
  };
  return {
    command,
    operationId,
    requestId: requestFrame.requestId,
    timeoutMs: 30_000,
    requestFrame,
    requestFrameSha256: sha256(canonicalBytes(requestFrame)),
  };
}

function spoolStore(root: string): EvidenceStore {
  return {
    root,
    createDirectory: vi.fn(),
    writeBytes: vi.fn(),
    writeCanonicalJson: vi.fn(),
    readArtifact: vi.fn(),
    verifyArtifactSet: vi.fn(),
    scan: vi.fn(),
    list: vi.fn(),
    assertRootStable: vi.fn(async () => undefined),
  } as unknown as EvidenceStore;
}

function signedSuccessfulExchange(
  request: ControllerRequest,
  loadedBootstrap: LoadedProbeBootstrap,
  result: unknown,
  artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[],
) {
  const material = artifacts
    .map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes), sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const encoded = encodeControllerOperationResponse({
    operationKind: request.operation.kind,
    result,
    artifactBindings: material.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
  });
  const signed = material
    .map(({ bytes }) => ({ reference: contentReference(bytes), bytes }))
    .sort((left, right) => left.reference.sha256.localeCompare(right.reference.sha256));
  const draft: ControllerResponseDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_RESPONSE_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    requestSha256: request.requestSha256,
    outcome: "SUCCEEDED",
    payload: contentReference(encoded.bytes),
    artifacts: signed.map(({ reference }) => reference),
    controllerIdentitySha256: loadedBootstrap.bootstrap.controllerSpool.identitySha256,
    controllerVersion: loadedBootstrap.bootstrap.controllerSpool.version,
    controllerPublicKeySha256: loadedBootstrap.bootstrap.controllerSpool.publicKeySha256,
    signatureAlgorithm: "Ed25519",
  };
  const responseSha256 = deriveControllerResponseDigest(draft);
  return {
    response: {
      ...draft,
      signatureBase64: sign(
        null,
        Buffer.from(responseSha256, "hex"),
        controllerKeys.privateKey,
      ).toString("base64"),
      responseSha256,
    },
    payloadBytes: Buffer.from(encoded.bytes),
    artifacts: signed.map(({ reference, bytes }) => ({ reference, bytes: Buffer.from(bytes) })),
  };
}

function signedSuccessfulScenarioActionExchange(
  request: ControllerRequest,
  payloadBytes: Uint8Array,
  loadedBootstrap: LoadedProbeBootstrap,
  suppliedResult: {
    readonly actionId: string;
    readonly commandEvent: null;
    readonly evidenceArtifacts: readonly { readonly path: string; readonly sha256: string }[];
  },
  suppliedArtifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  runRootIdentity: string,
  brokerSessionBinding: {
    readonly bootIdSha256: string;
    readonly runnerSessionIdSha256: string;
  },
) {
  const decoded = decodeControllerOperationRequest(payloadBytes, {
    expectedOperationKind: "scenario-action",
  });
  const input = decoded.envelope.input as any;
  const runtimeActionBinding = createProbeRuntimeActionBindingFromPreparedAuthority({
    command: input.command,
    invocation: input.invocation,
    preparedAuthority: input.preparedAuthority,
  });
  const artifacts = suppliedArtifacts
    .filter(({ path }) => path !== runtimeActionBinding.operationResultPath)
    .map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }));
  let proofArtifacts = [...suppliedResult.evidenceArtifacts];
  if (proofArtifacts.length === 0) {
    const proofBytes = Buffer.from(`proof:${suppliedResult.actionId}`, "utf8");
    const proofPath = `${probeSegmentArtifactPaths(input.workItem).evidence}/controller-action-proof.json`;
    artifacts.push({ path: proofPath, bytes: proofBytes });
    proofArtifacts = [{ path: proofPath, sha256: sha256(proofBytes) }];
  }
  const nativeHelper = input.preparedAuthority.nativeHelper;
  const observerTranscript = createNativeTranscript(
    {
      campaignRunId: input.preparedAuthority.campaignRunId,
      candidateSha256: input.preparedAuthority.candidateSha256,
      preflightSha256: input.preparedAuthority.preflightSha256,
      executionBundleManifestSha256: input.preparedAuthority.executionBundleManifestSha256,
      nativeHelperArtifactPath: nativeHelper.artifactPath,
      nativeHelperSha256: nativeHelper.sha256,
      nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
      nativeManifestSha256: nativeHelper.nativeManifestSha256,
      evidenceRootObjectIdentitySha256: input.preparedAuthority.evidenceRootObjectIdentitySha256,
    },
    [
      {
        command: "home-identity",
        operationId: `observer-${input.invocation.action.actionId}`,
        request: { relativePath: "targets\\observer-home" },
        result: {
          canonicalHomeId: "observer-home-identity",
          objectIdentity: "volume-observer:object-observer",
          volumeIdentity: "volume-observer",
          finalPathSha256: sha256("observer-home-path"),
          fileSystem: "NTFS",
          driveType: "fixed",
          reparseTag: 0,
          linkCount: 1,
        },
      },
    ],
    runRootIdentity,
    "native-session-controller-observer",
  );
  const observerBytes = canonicalBytes(observerTranscript);
  const observerPath = `${probeSegmentArtifactPaths(input.workItem).evidence}/native-transcripts/${observerTranscript.transcriptSha256}.json`;
  artifacts.push({ path: observerPath, bytes: observerBytes });
  let brokerProof: { readonly path: string; readonly sha256: string } | null = null;
  const expectedActor = runtimeActionBinding.expectedActor;
  if (["primary-standard-user", "remote-peer", "second-user"].includes(expectedActor.role)) {
    const proof = proofArtifacts[0];
    const proofBytes = artifacts.find(({ path }) => path === proof.path)?.bytes;
    if (proofBytes === undefined) throw new Error("broker fixture proof bytes are missing");
    const brokerTaskSha256 = sha256(`broker-task:${suppliedResult.actionId}`);
    const brokerTaskNonceSha256 = sha256(`broker-nonce:${suppliedResult.actionId}`);
    const brokerResult = createProbeBrokerResult({
      taskSha256: brokerTaskSha256,
      brokerEnrollmentSha256: sha256(`broker-enrollment:${expectedActor.role}`),
      brokerInstanceId: `${expectedActor.role}-broker-one`,
      brokerRole: expectedActor.role as "primary-standard-user" | "remote-peer" | "second-user",
      actor: expectedActor as never,
      bootIdSha256: brokerSessionBinding.bootIdSha256,
      runnerSessionIdSha256: brokerSessionBinding.runnerSessionIdSha256,
      outcome: "SUCCEEDED",
      driverResult: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-result",
        driverId: runtimeActionBinding.execution.driverId,
        resultArtifact: contentReference(
          Buffer.from(`broker-driver-result:${suppliedResult.actionId}`, "utf8"),
        ),
      },
      proofArtifacts: [contentReference(proofBytes)],
      observerTranscripts: [
        {
          ...contentReference(observerBytes),
          transcriptSha256: observerTranscript.transcriptSha256,
        },
      ],
      pausedSessionReceipt: null,
    });
    const brokerResultBytes = canonicalBytes(brokerResult);
    brokerProof = {
      path: `${probeSegmentArtifactPaths(input.workItem).evidence}/proofs/${suppliedResult.actionId}.broker-result.json`,
      sha256: sha256(brokerResultBytes),
    };
    const brokerAcceptance = createProbeControllerBrokerAcceptance({
      coordinate: request.coordinate as never,
      producerActionId: suppliedResult.actionId,
      brokerTaskSha256,
      brokerTaskNonceSha256,
      brokerResultSha256: brokerResult.resultSha256,
      brokerEnrollmentSha256: brokerResult.brokerEnrollmentSha256,
      brokerInstanceId: brokerResult.brokerInstanceId,
      brokerRole: brokerResult.brokerRole,
      expectedActor: expectedActor as never,
      mailboxAclSha256: sha256(`broker-mailbox-acl:${expectedActor.role}`),
      processSidSha256: expectedActor.identitySha256,
      bootIdSha256: brokerResult.bootIdSha256,
      runnerSessionIdSha256: brokerResult.runnerSessionIdSha256,
      replayJournalDisposition: "accepted",
      replayJournalEntrySha256: sha256(`broker-replay:${suppliedResult.actionId}`),
    });
    const brokerAcceptanceBytes = canonicalBytes(brokerAcceptance);
    const brokerAcceptanceReference = {
      path: probeControllerBrokerAcceptancePath({
        coordinate: request.coordinate as never,
        producerActionId: suppliedResult.actionId,
      }),
      sha256: sha256(brokerAcceptanceBytes),
    };
    const observerCommands = observerTranscript.records
      .filter((record) => record.kind === "command")
      .map((record) => ({
        transcriptSha256: observerTranscript.transcriptSha256,
        sequence: record.sequence,
        commandId: record.command,
        requestFrameSha256: record.requestFrameSha256,
        responseFrameSha256: record.responseFrameSha256,
        ok: record.ok,
      }));
    const actionAttestation = createProbeControllerActionAttestation({
      candidateSha256: input.preparedAuthority.candidateSha256,
      executionBundleId: input.preparedAuthority.executionBundleId,
      executionBundleManifestSha256: input.preparedAuthority.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256:
        input.preparedAuthority.runAuthorizationClaimReceiptSha256,
      coordinate: request.coordinate as never,
      scenarioPlanSha256: input.invocation.planSha256,
      producerActionId: suppliedResult.actionId,
      operation: request.operation as never,
      runtimeActionIntentSha256: runtimeActionBinding.operationIntentSha256,
      execution: runtimeActionBinding.execution,
      expectedActor: expectedActor as never,
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
    const actionAttestationBytes = canonicalBytes(actionAttestation);
    const actionAttestationReference = {
      path: probeControllerActionAttestationPath({
        coordinate: request.coordinate as never,
        producerActionId: suppliedResult.actionId,
      }),
      sha256: sha256(actionAttestationBytes),
    };
    artifacts.push(
      { path: brokerProof.path, bytes: brokerResultBytes },
      { path: brokerAcceptanceReference.path, bytes: brokerAcceptanceBytes },
      { path: actionAttestationReference.path, bytes: actionAttestationBytes },
    );
    proofArtifacts.push(brokerProof, brokerAcceptanceReference, actionAttestationReference);
  }
  proofArtifacts.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const actionResult = { ...suppliedResult, evidenceArtifacts: proofArtifacts };
  const resultBytes = canonicalBytes(actionResult);
  const nativeActionPlans = artifacts
    .filter(({ path }) => path.includes("/driver-plans/"))
    .map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const receipt = createProbeControllerActionExecutionReceipt({
    candidateSha256: input.preparedAuthority.candidateSha256,
    executionBundleId: input.preparedAuthority.executionBundleId,
    executionBundleManifestSha256: input.preparedAuthority.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: input.preparedAuthority.runAuthorizationClaimReceiptSha256,
    coordinate: request.coordinate,
    scenarioPlanSha256: input.invocation.planSha256,
    producerActionId: input.invocation.action.actionId,
    operation: request.operation as never,
    intentSha256: runtimeActionBinding.operationIntentSha256,
    execution: runtimeActionBinding.execution,
    expectedActor: runtimeActionBinding.expectedActor,
    actionResult,
    actionResultArtifact: {
      path: runtimeActionBinding.operationResultPath,
      sha256: sha256(resultBytes),
    },
    proofArtifacts,
    observerTranscripts: [
      {
        path: observerPath,
        sha256: sha256(observerBytes),
        transcriptSha256: observerTranscript.transcriptSha256,
      },
    ],
    brokerProof,
    pausedSessionReceipt: null,
    nativeActionPlans,
  });
  return signedSuccessfulExchange(request, loadedBootstrap, receipt, [
    ...artifacts,
    { path: runtimeActionBinding.operationResultPath, bytes: resultBytes },
  ]);
}

function createNativeTranscript(
  preflightBinding: NativePreflightBinding,
  commands: readonly {
    readonly command: NativeCommand;
    readonly operationId: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly win32Code: number | null;
    };
  }[],
  runRootIdentity: string,
  nativeSessionId = "native-session-one",
): NativeCommandTranscript {
  const startupOperationId = "startup-operation-one";
  const startupRequestId = "startup-request-one";
  const startupContext = {
    campaignRunId: preflightBinding.campaignRunId,
    candidateSha256: preflightBinding.candidateSha256,
    preflightSha256: preflightBinding.preflightSha256,
    executionBundleManifestSha256: preflightBinding.executionBundleManifestSha256,
    nativeCandidateDigest: preflightBinding.nativeCandidateDigest,
    nativeManifestSha256: preflightBinding.nativeManifestSha256,
    nativeHelperSha256: preflightBinding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: preflightBinding.evidenceRootObjectIdentitySha256,
    nativeSessionId,
    operationId: startupOperationId,
  };
  const startupRequestFrameSha256 = canonicalDigest({
    protocolVersion: 1,
    requestId: startupRequestId,
    command: "native-binding-check",
    context: startupContext,
    request: {},
  });
  const startupHandshake = {
    protocolVersion: 1 as const,
    kind: "response" as const,
    requestId: startupRequestId,
    command: "native-binding-check" as const,
    context: {
      ...startupContext,
      requestFrameSha256: startupRequestFrameSha256,
      runRootIdentity,
    },
    ok: true as const,
    result: {
      ready: true as const,
      processId: 4242,
      nativeHelperSha256: preflightBinding.nativeHelperSha256,
      runRootIdentity,
      evidenceRootObjectIdentitySha256: preflightBinding.evidenceRootObjectIdentitySha256,
    },
  };
  const binding = {
    ...preflightBinding,
    nativeSessionId,
    runRootIdentity,
    startupHandshake,
    startupHandshakeSha256: canonicalDigest(startupHandshake),
  };
  const records = commands.map((entry, index) => {
    const requestId = `request-${index + 1}`;
    const context = {
      campaignRunId: binding.campaignRunId,
      candidateSha256: binding.candidateSha256,
      preflightSha256: binding.preflightSha256,
      executionBundleManifestSha256: binding.executionBundleManifestSha256,
      nativeCandidateDigest: binding.nativeCandidateDigest,
      nativeManifestSha256: binding.nativeManifestSha256,
      nativeHelperSha256: binding.nativeHelperSha256,
      evidenceRootObjectIdentitySha256: binding.evidenceRootObjectIdentitySha256,
      nativeSessionId,
      operationId: entry.operationId,
    };
    const requestFrameSha256 = canonicalDigest({
      protocolVersion: 1,
      requestId,
      command: entry.command,
      context,
      request: entry.request,
    });
    const outcome =
      entry.error === undefined
        ? { ok: true as const, result: entry.result }
        : { ok: false as const, error: entry.error };
    return {
      kind: "command" as const,
      sequence: index + 1,
      requestId,
      command: entry.command,
      operationId: entry.operationId,
      requestFrameSha256,
      nativeRequestFrameSha256: requestFrameSha256,
      requestFrameVerification: "recomputed" as const,
      responseFrameSha256: canonicalDigest({
        protocolVersion: 1,
        kind: "response",
        requestId,
        command: entry.command,
        context: { ...context, requestFrameSha256, runRootIdentity },
        ...outcome,
      }),
      request: entry.request,
      ...outcome,
    };
  });
  const payload = {
    schemaVersion: 1 as const,
    kind: "windows-host-native-command-transcript" as const,
    binding,
    records,
    termination: { mode: "clean-eof" as const, code: 0 as const, signal: null },
  };
  return validateNativeCommandTranscript({
    ...payload,
    transcriptSha256: canonicalDigest({
      domain: "enduragent.windows-host-native-command-transcript.v1",
      transcript: payload,
    }),
  });
}

function observation(factKey: string, value: unknown): ProbeTranscriptObservation {
  if (value === null) return { factKey, valueKind: "null", value };
  if (typeof value === "boolean") return { factKey, valueKind: "boolean", value };
  if (typeof value === "number") return { factKey, valueKind: "number", value };
  return { factKey, valueKind: "string", value: String(value) };
}

function createDrivers(order: string[]) {
  return Object.fromEntries(
    PROBE_NATIVE_LANE_DRIVER_KEYS.map((key) => {
      const [rowId, actionId] = key.split(":") as [string, string];
      const definition = PROBE_SCENARIO_DEFINITIONS.find((entry) => entry.rowId === rowId);
      const action = definition?.actions.find((entry) => entry.actionId === actionId);
      if (action?.capture === null || action?.capture === undefined) {
        throw new Error(`missing native action ${key}`);
      }
      return [
        key,
        {
          rowId,
          actionId,
          operation: action.operation,
          driverId: `driver-${rowId.toLowerCase()}-${actionId}`,
          captureCommandId: action.capture.commandId,
          factKeys: action.capture.factKeys,
          validateActionPlan: ({
            plan,
          }: {
            readonly plan: ReturnType<typeof createProbeNativeActionPlan>;
          }) => {
            order.push("validate-plan");
            return { plan, primaryStepId: plan.steps[0].stepId };
          },
          projectActionResult: ({ input, primaryRecord }: any) => {
            order.push("project-result");
            const result = primaryRecord.result as NativeResultMap["home-identity"];
            const parameters = input.invocation.action.parameters;
            const values: Readonly<Record<string, unknown>> = {
              canonicalIdentitySha256: sha256(result.canonicalHomeId),
              comparisonIdentitySha256: sha256(result.canonicalHomeId),
              credentialReadAttempted: false,
              lifecycle: parameters.lifecycle,
              localPathSha256: result.finalPathSha256,
              pathTopology: parameters.pathTopology,
              processRole: parameters.processRole,
              reasonCode: null,
              volumeDriveType: result.driveType,
              volumeFileSystem: result.fileSystem,
              volumeIdentitySha256: sha256(result.volumeIdentity),
              win32Error: null,
            };
            return {
              observations: action.capture.factKeys.map((factKey) =>
                observation(factKey, values[factKey]),
              ),
            };
          },
        },
      ];
    }),
  ) as unknown as ProbeNativeLaneRowDrivers;
}

async function fixture({
  rowId = "F-01",
  variantId = "f01-ordinary-absolute-path",
}: { readonly rowId?: string; readonly variantId?: string } = {}) {
  const createdRoot = await mkdtemp(join(tmpdir(), "enduragent-native-lane-"));
  const root = await realpath(createdRoot);
  roots.push(root);
  const evidence = await openEvidenceStore({ root });
  const candidateRoot = "C:\\candidate";
  const candidateDirectory = "C:\\candidate\\bin";
  const assemblySha256 = sha256("native-assembly");
  const candidateDigest = sha256("native-candidate");
  const manifestSha256 = sha256("native-manifest");
  const sourceBundleSha256 = sha256("native-sources");
  const toolchainDigest = sha256("native-toolchain");
  const nativeHelperArtifactPath = "bin/windows-host-falsifier-native.exe";
  const build: NativeBuildIdentity & {
    readonly candidateRoot: string;
    readonly candidateDirectory: string;
    readonly nativeHelperArtifactPath: string;
  } = {
    candidateDigest,
    assemblySha256,
    sourceBundleSha256,
    toolchainDigest,
    manifestSha256,
    sources: [],
    toolchain: {},
    candidateRoot,
    candidateDirectory,
    nativeHelperArtifactPath,
  };
  const runnerUserSidSha256 = sha256("runner-user");
  const volumeIdSha256 = sha256("volume");
  const runRootIdentity = "volume-v1:root-v1";
  const rootIdentitySha256 = sha256(runRootIdentity);
  const observationFields = {
    schemaVersion: 1 as const,
    kind: "windows-host-native-preflight-observation" as const,
    pathProfileId: "ascii" as const,
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
    runnerUserSidSha256,
    rootPathSha256: sha256(root),
    rootSecuritySha256: sha256("root-security"),
    evidenceRootObjectIdentitySha256: rootIdentitySha256,
    volumeIdSha256,
    localAbsolute: true as const,
    interactiveSessionActive: true as const,
    networkPath: false as const,
    removableVolume: false as const,
    reparsePoint: false as const,
    nfcNormalized: true as const,
    containsSpaces: false,
    containsUnicode: false,
    fileSystem: "NTFS" as const,
    driveType: "fixed" as const,
    nativeHelperSha256: assemblySha256,
    nativeCandidateDigest: candidateDigest,
    nativeManifestSha256: manifestSha256,
    sourceBundleSha256,
  };
  const nativeObservation = validateNativePreflightObservation({
    ...observationFields,
    observationSha256: deriveNativePreflightObservationDigest(observationFields),
  });
  const preflightDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-native-preflight-transcript" as const,
    binding: {
      candidateRootSha256: sha256(candidateRoot),
      candidateDirectorySha256: sha256(candidateDirectory),
      requestedRunRootSha256: sha256(root),
      rootMutationCheck: "bounded-recursive-before-after-v1" as const,
      nativeHelperArtifactPath,
      nativeHelperSha256: assemblySha256,
      nativeCandidateDigest: candidateDigest,
      nativeManifestSha256: manifestSha256,
      sourceBundleSha256,
      pathProfileId: "ascii" as const,
    },
    observation: nativeObservation,
    termination: { code: 0 as const, signal: null, stderrBytes: 0 as const },
  };
  const preflightTranscript = validateNativePreflightTranscript({
    ...preflightDraft,
    transcriptSha256: deriveNativePreflightTranscriptDigest(preflightDraft),
  });
  const preflightBytes = nativeCanonicalBytes(preflightTranscript, true);
  const publicKeySha256 = sha256(controllerPublicKeyBytes);
  const controller = {
    identitySha256: sha256("controller"),
    publicKeySha256,
    publicKeyArtifact: {
      path: "attestations/controller-public-key.spki.der",
      sha256: publicKeySha256,
    },
    version: "1.2.3",
  } as const;
  const workItem = PROBE_RUN_PLAN.work.find(
    (entry) =>
      entry.environmentId === "win11-floor" &&
      entry.pathProfileId === "ascii" &&
      entry.rowId === rowId &&
      entry.variantId === variantId,
  );
  if (workItem === undefined) throw new Error(`${rowId}:${variantId} work item is missing`);
  const attestation = {
    environmentId: workItem.environmentId,
    attestationSha256: sha256("attestation:floor"),
    host: { testVolumeIdSha256: volumeIdSha256 },
    snapshot: { vmSnapshotId: "snapshot-floor" },
    runner: { interactiveSessionOwnerSidSha256: runnerUserSidSha256 },
    runtime: { powershellVersion: "7.5.0" },
    controller,
    controllerEvidence: {
      path: "attestations/floor-controller.json",
      sha256: sha256("controller-evidence:floor"),
    },
    guestEvidenceByPathProfile: [
      {
        pathProfileId: "ascii",
        artifact: {
          path: "attestations/floor-ascii-native-preflight.json",
          sha256: sha256(preflightBytes),
        },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: {
          path: "attestations/floor-spaces-unicode-native-preflight.json",
          sha256: sha256("unused-spaces-unicode-preflight"),
        },
      },
    ],
  } as const;
  const candidateSha256 = sha256("candidate");
  const loadedBootstrap = {
    bootstrapSha256: sha256("bootstrap"),
    bootstrap: {
      schemaVersion: 1,
      kind: "windows-host-probe-bootstrap",
      campaignId: PROBE_CAMPAIGN_ID,
      campaignRunId: "campaign-one",
      runPlanSha256: PROBE_RUN_PLAN_SHA256,
      controllerSpool: {
        root: "\\\\controller-host\\enduragent-spool\\campaign-one",
        identitySha256: controller.identitySha256,
        publicKeySha256,
        version: controller.version,
      },
      candidateBinaries: {
        nativeHelperArtifactPath,
        nsisArtifactPath: "bin/enduragent-setup.exe",
      },
      binaryRoot: candidateRoot,
      nativeCandidateManifest: {
        path: "manifests/native-candidate.json",
        sha256: manifestSha256,
      },
      evidenceRoots: [
        {
          environmentId: workItem.environmentId,
          pathProfileId: workItem.pathProfileId,
          root,
        },
      ],
    },
    candidate: { candidateSha256 },
    nativeCandidateManifest: {
      candidateDigest,
      assembly: { sha256: assemblySha256 },
      sourceBundleSha256,
      toolchainDigest,
    },
    attestations: [attestation],
    runAuthorization: {
      campaignId: PROBE_CAMPAIGN_ID,
      manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
      campaignRunId: "campaign-one",
      runPlanSha256: PROBE_RUN_PLAN_SHA256,
      candidateSha256,
      authorizationSha256: sha256("authorization"),
    },
    controllerPublicKeySpkiDerBase64: Buffer.from(controllerPublicKeyBytes).toString("base64"),
  } as unknown as LoadedProbeBootstrap;
  const context = {
    loadedBootstrap,
    nativeBuild: build,
    resolveStore: vi.fn(async () => evidence),
    metadata: {},
  } as never;
  const preflightInput = {
    command: {
      campaignRunId: loadedBootstrap.bootstrap.campaignRunId,
      executionRunId: "execution-one",
      executionBundleId: "bundle-one",
      attemptId: "attempt-one",
      environmentId: workItem.environmentId,
      pathProfileId: workItem.pathProfileId,
    },
    candidate: loadedBootstrap.candidate,
    attestation,
    evidenceRoot: root,
  } as never;
  return {
    root,
    evidence,
    build,
    context,
    loadedBootstrap,
    attestation,
    workItem,
    preflightInput,
    nativeObservation,
    preflightTranscript,
    preflightBytes,
    runRootIdentity,
    rootIdentitySha256,
  };
}

async function actionFixture({
  mutating = false,
  tamperIntentExecution = false,
}: { readonly mutating?: boolean; readonly tamperIntentExecution?: boolean } = {}) {
  const selected = mutating
    ? {
        rowId: "F-02",
        variantId: "f02-create-private-directory",
        producerActionId: "prepare-directory-root",
        consumerActionId: "capture-directory-ensure",
        steps: [
          {
            sequence: 1,
            stepId: "ensure-directory",
            command: "private-directory-ensure",
            request: {
              relativePath: "targets/private-directory/fresh-private",
              action: "create",
            },
            timeoutMs: 30_000,
            recoveryClass: "inspect-and-reconcile",
          },
        ],
      }
    : {
        rowId: "F-01",
        variantId: "f01-ordinary-absolute-path",
        producerActionId: "prepare-home-topology",
        consumerActionId: "capture-home-identity",
        steps: [
          {
            sequence: 1,
            stepId: "observe-home-primary",
            command: "home-identity",
            request: { relativePath: "targets/home" },
            timeoutMs: 30_000,
            recoveryClass: "read-only-replay",
          },
          {
            sequence: 2,
            stepId: "observe-home-comparison",
            command: "home-identity",
            request: { relativePath: "targets/home-comparison" },
            timeoutMs: 30_000,
            recoveryClass: "read-only-replay",
          },
        ],
      };
  const value = await fixture({ rowId: selected.rowId, variantId: selected.variantId });
  const order: string[] = [];
  const definition = getProbeScenarioDefinition(value.workItem.rowId, value.workItem.variantId);
  const producer = definition.actions.find(
    ({ actionId }) => actionId === selected.producerActionId,
  );
  const consumer = definition.actions.find(
    ({ actionId }) => actionId === selected.consumerActionId,
  );
  if (producer === undefined || consumer === undefined) {
    throw new Error(`${selected.rowId} handoff is missing`);
  }
  const command = {
    campaignRunId: value.loadedBootstrap.bootstrap.campaignRunId,
    attemptId: "attempt-one",
    workId: value.workItem.workId,
    environmentId: value.workItem.environmentId,
    pathProfileId: value.workItem.pathProfileId,
    rowId: value.workItem.rowId,
    variantId: value.workItem.variantId,
    repetition: 1,
    planSha256: PROBE_RUN_PLAN_SHA256,
  };
  const preparedContext = createPreparedContextFixture({
    campaignRunId: command.campaignRunId,
    executionRunId: "execution-one",
    executionBundleId: "bundle-one",
    attemptId: command.attemptId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    candidateSha256: value.loadedBootstrap.candidate.candidateSha256,
    labAttestationSha256: value.attestation.attestationSha256,
    runAuthorizationSha256: value.loadedBootstrap.runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: sha256("claim-receipt"),
    vmSnapshotId: value.attestation.snapshot.vmSnapshotId,
    bootIdSha256: value.preflightTranscript.observation.bootIdSha256,
    runnerSessionIdSha256: value.preflightTranscript.observation.runnerSessionIdSha256,
    preflightRootPathSha256: value.preflightTranscript.observation.rootPathSha256,
    evidenceRootObjectIdentitySha256: value.rootIdentitySha256,
    volumeIdSha256: value.preflightTranscript.observation.volumeIdSha256,
    controller: value.attestation.controller,
    actors: preparedExecutionActors(value.preflightTranscript.observation.runnerUserSidSha256),
    nativeHelper: {
      path: value.build.nativeHelperArtifactPath,
      sha256: value.build.assemblySha256,
      nativeCandidateDigest: value.build.candidateDigest,
      nativeManifestSha256: value.build.manifestSha256,
    },
    nsis: {
      path: value.loadedBootstrap.bootstrap.candidateBinaries.nsisArtifactPath,
      sha256: sha256("nsis"),
    },
  });
  const producerInvocation = {
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: producer,
  } as const;
  const invocation = {
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: consumer,
  } as const;
  const producerBinding = createProbeRuntimeActionBinding({
    command,
    invocation: producerInvocation,
    preparedContext,
  });
  const nativeBinding = createProbeRuntimeActionBinding({ command, invocation, preparedContext });
  const nativeOperationId = nativeBinding.operationId;
  const plan = createProbeNativeActionPlan({
    candidateSha256: preparedContext.candidateSha256,
    campaignRunId: command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    scenarioPlanSha256: definition.planSha256,
    producerActionId: producer.actionId,
    consumerActionId: consumer.actionId,
    operationId: nativeOperationId,
    evidenceRootObjectIdentitySha256: value.rootIdentitySha256,
    steps: selected.steps,
    prerequisiteEvidence: [],
  });
  const planPath = probeNativeActionPlanPath({
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    consumerActionId: consumer.actionId,
  });
  const producerResultPath = producerBinding.operationResultPath;
  const producerResult = {
    actionId: producer.actionId,
    commandEvent: null,
    evidenceArtifacts: [],
  };
  const exchange = vi.fn(
    async ({ request, payloadBytes }: { request: ControllerRequest; payloadBytes: Uint8Array }) => {
      const decoded = decodeControllerOperationRequest(payloadBytes, {
        expectedOperationKind: "scenario-action",
      });
      expect(decoded.envelope.input.invocation.action.actionId).toBe(producer.actionId);
      return signedSuccessfulScenarioActionExchange(
        request,
        payloadBytes,
        value.loadedBootstrap,
        producerResult,
        [
          { path: planPath, bytes: canonicalBytes(plan) },
          { path: producerResultPath, bytes: canonicalBytes(producerResult) },
        ],
        value.runRootIdentity,
        {
          bootIdSha256: preparedContext.bootIdSha256,
          runnerSessionIdSha256: preparedContext.runnerSessionIdSha256,
        },
      );
    },
  );
  const controllerTransport = await createProbeControllerSpoolTransport({
    loadedBootstrap: value.loadedBootstrap,
    resolveStore: vi.fn(async () => value.evidence),
    openSpoolStore: vi.fn(async ({ root }: { root: string }) => spoolStore(root)),
    createSpoolClient: vi.fn(() => ({ exchange })),
  });
  await ensureEvidenceDirectory(
    value.evidence,
    producerBinding.operationIntentPath.slice(
      0,
      producerBinding.operationIntentPath.lastIndexOf("/"),
    ),
  );
  await value.evidence.writeBytes(
    producerBinding.operationIntentPath,
    canonicalBytes(producerBinding.intent),
  );
  await controllerTransport.invokeScenarioAction({
    command,
    workItem: value.workItem,
    preparedContext,
    evidenceRoot: value.root,
    operationId: producerBinding.operationId,
    operationIntentPath: producerBinding.operationIntentPath,
    operationResultPath: producerResultPath,
    execution: producerBinding.execution,
    invocation: producerInvocation,
  } as never);
  const execution = nativeBinding.execution;
  const operationIntentPath = nativeBinding.operationIntentPath;
  const operationResultPath = nativeBinding.operationResultPath;
  await ensureEvidenceDirectory(
    value.evidence,
    operationIntentPath.slice(0, operationIntentPath.lastIndexOf("/")),
  );
  await value.evidence.writeBytes(
    operationIntentPath,
    canonicalBytes(
      tamperIntentExecution
        ? {
            ...nativeBinding.intent,
            execution: { ...execution, driverId: "substituted-driver" },
          }
        : nativeBinding.intent,
    ),
  );
  const nativeInput = {
    command,
    workItem: value.workItem,
    preparedContext,
    evidenceRoot: value.root,
    operationId: nativeOperationId,
    operationIntentPath,
    operationResultPath,
    invocation,
    candidate: value.loadedBootstrap.candidate,
    attestation: value.attestation,
    execution,
    transportAuthority: "injected-authoritative-lab",
  } as const;
  return {
    value,
    order,
    command,
    preparedContext,
    plan,
    invocation,
    consumer,
    operationIntentPath,
    operationResultPath,
    nativeOperationId,
    nativeInput,
  };
}

describe("Windows host probe native lane", () => {
  it("closes the row-driver registry and binds live preflight evidence exactly once", async () => {
    const value = await fixture();
    const order: string[] = [];
    const observePreflight = vi.fn(async () => ({
      build: value.build,
      observation: value.nativeObservation,
      transcript: value.preflightTranscript,
      transcriptBytes: value.preflightBytes,
    }));
    const drivers = createDrivers(order);
    expect(() => createProbeNativeLane(value.context, { rowDrivers: {} } as never)).toThrowError(
      expect.objectContaining({ code: "NATIVE_LANE_DRIVER_REGISTRY" }),
    );
    expect(PROBE_NATIVE_LANE_DRIVER_KEYS).toEqual([
      "F-01:capture-home-identity",
      "F-02:capture-directory-ensure",
      "F-02:capture-directory-inspection",
      "F-03:capture-private-file-create",
      "F-03:capture-target-identity",
      "F-04:capture-evidence-tree-seal",
      "F-04:capture-secure-path-operation",
      "F-05:capture-handle-bound-mutation",
      "F-05:capture-inspected-identity",
    ]);
    expect(probeNativeLaneDriverKey("F-01", "capture-home-identity")).toBe(
      "F-01:capture-home-identity",
    );
    expect(() => probeNativeLaneDriverKey("F-10", "missing")).toThrowError(
      expect.objectContaining({ code: "NATIVE_LANE_DRIVER_MISSING" }),
    );

    const bound = createProbeNativeLane(value.context, { rowDrivers: drivers, observePreflight });
    const [first, second] = await Promise.all([
      bound.resolvePreflightRequest(value.preflightInput),
      bound.resolvePreflightRequest(value.preflightInput),
    ]);
    expect(first).toEqual(second);
    expect(observePreflight).toHaveBeenCalledTimes(1);
    await expect(
      value.evidence.readArtifact(value.attestation.guestEvidenceByPathProfile[0].artifact.path),
    ).resolves.toMatchObject({ bytes: value.preflightBytes });
    await expect(
      bound.transport.observeGuest({
        request: {
          ...first,
          nativeCandidateDigest: value.build.candidateDigest,
          nativeManifestSha256: value.build.manifestSha256,
        },
        evidenceRoot: value.root,
      }),
    ).resolves.toMatchObject({
      pathProfile: { evidenceRootObjectIdentitySha256: value.rootIdentitySha256 },
    });
    await expect(
      bound.resolvePreflightRequest({
        ...value.preflightInput,
        evidenceRoot: `${value.root}-other`,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_EVIDENCE_ROOT" });
  });

  it.each([
    `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/transcripts/poison.json`,
    "Runtime/Native-Operation-Journals/transcripts/poison.json",
    "runtime\\native-operation-journals\\transcripts\\poison.json",
  ])("rejects reserved guest evidence before retaining bytes: %s", async (artifactPath) => {
    const value = await fixture();
    const guestEvidenceByPathProfile = value.attestation.guestEvidenceByPathProfile.map((entry) =>
      entry.pathProfileId === value.workItem.pathProfileId
        ? { ...entry, artifact: { ...entry.artifact, path: artifactPath } }
        : entry,
    );
    const attestation = { ...value.attestation, guestEvidenceByPathProfile };
    const loadedBootstrap = {
      ...value.loadedBootstrap,
      attestations: [attestation],
    };
    const context = { ...value.context, loadedBootstrap };
    const observePreflight = vi.fn(async () => ({
      build: value.build,
      observation: value.nativeObservation,
      transcript: value.preflightTranscript,
      transcriptBytes: value.preflightBytes,
    }));
    const lane = createProbeNativeLane(context as never, {
      rowDrivers: createDrivers([]),
      observePreflight,
    });

    await expect(
      lane.resolvePreflightRequest({
        ...value.preflightInput,
        attestation,
      } as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_RESERVED_PATH" });
    expect(observePreflight).toHaveBeenCalledTimes(1);
    await expect(value.evidence.scan()).resolves.toMatchObject({ artifacts: [] });
  });

  it("accepts a runtime-shaped intent and recovers its retained transcript after restart", async () => {
    const value = await fixture();
    const order: string[] = [];
    const definition = getProbeScenarioDefinition(value.workItem.rowId, value.workItem.variantId);
    const producer = definition.actions.find(
      ({ actionId }) => actionId === "prepare-home-topology",
    );
    const consumer = definition.actions.find(
      ({ actionId }) => actionId === "capture-home-identity",
    );
    if (producer === undefined || consumer === undefined)
      throw new Error("F-01 handoff is missing");
    const command = {
      campaignRunId: value.loadedBootstrap.bootstrap.campaignRunId,
      attemptId: "attempt-one",
      workId: value.workItem.workId,
      environmentId: value.workItem.environmentId,
      pathProfileId: value.workItem.pathProfileId,
      rowId: value.workItem.rowId,
      variantId: value.workItem.variantId,
      repetition: 1,
      planSha256: PROBE_RUN_PLAN_SHA256,
    };
    const preparedContext = createPreparedContextFixture({
      campaignRunId: command.campaignRunId,
      executionRunId: "execution-one",
      executionBundleId: "bundle-one",
      attemptId: command.attemptId,
      environmentId: command.environmentId,
      pathProfileId: command.pathProfileId,
      candidateSha256: value.loadedBootstrap.candidate.candidateSha256,
      labAttestationSha256: value.attestation.attestationSha256,
      runAuthorizationSha256: value.loadedBootstrap.runAuthorization.authorizationSha256,
      runAuthorizationClaimReceiptSha256: sha256("claim-receipt"),
      vmSnapshotId: value.attestation.snapshot.vmSnapshotId,
      bootIdSha256: value.preflightTranscript.observation.bootIdSha256,
      runnerSessionIdSha256: value.preflightTranscript.observation.runnerSessionIdSha256,
      preflightRootPathSha256: value.preflightTranscript.observation.rootPathSha256,
      evidenceRootObjectIdentitySha256: value.rootIdentitySha256,
      volumeIdSha256: value.preflightTranscript.observation.volumeIdSha256,
      controller: value.attestation.controller,
      actors: preparedExecutionActors(value.preflightTranscript.observation.runnerUserSidSha256),
      nativeHelper: {
        path: value.build.nativeHelperArtifactPath,
        sha256: value.build.assemblySha256,
        nativeCandidateDigest: value.build.candidateDigest,
        nativeManifestSha256: value.build.manifestSha256,
      },
      nsis: {
        path: value.loadedBootstrap.bootstrap.candidateBinaries.nsisArtifactPath,
        sha256: sha256("nsis"),
      },
    });
    const producerInvocation = {
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action: producer,
    } as const;
    const producerBinding = createProbeRuntimeActionBinding({
      command,
      invocation: producerInvocation,
      preparedContext,
    });
    const nativeOperationId = deriveProbeRuntimeScenarioOperationId(command, consumer.actionId);
    const plan = createProbeNativeActionPlan({
      candidateSha256: preparedContext.candidateSha256,
      campaignRunId: command.campaignRunId,
      executionRunId: preparedContext.executionRunId,
      attemptId: command.attemptId,
      workId: command.workId,
      environmentId: command.environmentId,
      pathProfileId: command.pathProfileId,
      rowId: command.rowId,
      variantId: command.variantId,
      scenarioPlanSha256: definition.planSha256,
      producerActionId: producer.actionId,
      consumerActionId: consumer.actionId,
      operationId: nativeOperationId,
      evidenceRootObjectIdentitySha256: value.rootIdentitySha256,
      steps: [
        {
          sequence: 1,
          stepId: "observe-home-primary",
          command: "home-identity",
          request: { relativePath: "targets/home" },
          timeoutMs: 30_000,
          recoveryClass: "read-only-replay",
        },
        {
          sequence: 2,
          stepId: "observe-home-comparison",
          command: "home-identity",
          request: { relativePath: "targets/home-comparison" },
          timeoutMs: 30_000,
          recoveryClass: "read-only-replay",
        },
      ],
      prerequisiteEvidence: [],
    });
    const planPath = probeNativeActionPlanPath({
      campaignRunId: command.campaignRunId,
      attemptId: command.attemptId,
      workId: command.workId,
      consumerActionId: consumer.actionId,
    });
    const producerResultPath = producerBinding.operationResultPath;
    const producerResult = {
      actionId: producer.actionId,
      commandEvent: null,
      evidenceArtifacts: [],
    };
    const exchange = vi.fn(
      async ({
        request,
        payloadBytes,
      }: {
        request: ControllerRequest;
        payloadBytes: Uint8Array;
      }) => {
        const decoded = decodeControllerOperationRequest(payloadBytes, {
          expectedOperationKind: "scenario-action",
        });
        expect(decoded.envelope.input.invocation.action.actionId).toBe(producer.actionId);
        return signedSuccessfulScenarioActionExchange(
          request,
          payloadBytes,
          value.loadedBootstrap,
          producerResult,
          [
            { path: planPath, bytes: canonicalBytes(plan) },
            { path: producerResultPath, bytes: canonicalBytes(producerResult) },
          ],
          value.runRootIdentity,
          {
            bootIdSha256: preparedContext.bootIdSha256,
            runnerSessionIdSha256: preparedContext.runnerSessionIdSha256,
          },
        );
      },
    );
    const controllerTransport = await createProbeControllerSpoolTransport({
      loadedBootstrap: value.loadedBootstrap,
      resolveStore: vi.fn(async () => value.evidence),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => spoolStore(root)),
      createSpoolClient: vi.fn(() => ({ exchange })),
    });
    await ensureEvidenceDirectory(
      value.evidence,
      producerBinding.operationIntentPath.slice(
        0,
        producerBinding.operationIntentPath.lastIndexOf("/"),
      ),
    );
    await value.evidence.writeBytes(
      producerBinding.operationIntentPath,
      canonicalBytes(producerBinding.intent),
    );
    await controllerTransport.invokeScenarioAction({
      command,
      workItem: value.workItem,
      preparedContext,
      evidenceRoot: value.root,
      operationId: producerBinding.operationId,
      operationIntentPath: producerBinding.operationIntentPath,
      operationResultPath: producerResultPath,
      execution: producerBinding.execution,
      invocation: producerInvocation,
    } as never);

    const invocation = {
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action: consumer,
    } as const;
    const nativeBinding = createProbeRuntimeActionBinding({
      command,
      invocation,
      preparedContext,
    });
    const execution = nativeBinding.execution;
    const operationIntentPath = nativeBinding.operationIntentPath;
    const operationResultPath = nativeBinding.operationResultPath;
    await ensureEvidenceDirectory(
      value.evidence,
      operationIntentPath.slice(0, operationIntentPath.lastIndexOf("/")),
    );
    await value.evidence.writeBytes(operationIntentPath, canonicalBytes(nativeBinding.intent));
    const homeResult: NativeResultMap["home-identity"] = {
      canonicalHomeId: "home-identity-one",
      objectIdentity: "volume-one:object-one",
      volumeIdentity: "volume-one",
      finalPathSha256: sha256("final-home-path"),
      fileSystem: "NTFS",
      driveType: "fixed",
      reparseTag: 0,
      linkCount: 1,
    };
    let durableTranscript: NativeCommandTranscript | undefined;
    const openNativeChannel = vi.fn(
      async ({ preflightBinding }: { preflightBinding: NativePreflightBinding }) => {
        order.push("open-channel");
        const executed: {
          command: NativeCommand;
          operationId: string;
          request: Readonly<Record<string, unknown>>;
          result: Readonly<Record<string, unknown>>;
        }[] = [];
        return {
          nativeSessionId: "native-session-one",
          build: value.build,
          preflightBinding,
          prepare: async <C extends NativeCommand>(
            nativeCommand: C,
            request: NativeRequestMap[C],
            options: { operationId?: string } = {},
          ) => {
            const operationId = options.operationId ?? "missing-operation";
            const normalizedRequest = {
              ...request,
              ...(Object.hasOwn(request, "relativePath")
                ? {
                    relativePath: String(
                      (request as { relativePath: string }).relativePath,
                    ).replaceAll("/", "\\"),
                  }
                : {}),
            };
            return preparedRequest(nativeCommand, normalizedRequest, operationId);
          },
          executePrepared: async (prepared: {
            readonly command: NativeCommand;
            readonly operationId: string;
            readonly requestFrame: { readonly request: Readonly<Record<string, unknown>> };
          }) => {
            order.push(`execute:${prepared.operationId}`);
            executed.push({
              command: prepared.command,
              operationId: prepared.operationId,
              request: prepared.requestFrame.request,
              result: homeResult,
            });
            return {
              command: prepared.command,
              operationId: prepared.operationId,
              ok: true,
              result: homeResult,
            };
          },
          close: async () => {
            order.push("close-channel");
            durableTranscript = createNativeTranscript(
              preflightBinding,
              executed,
              value.runRootIdentity,
            );
            return { exit: { code: 0, signal: null }, transcript: durableTranscript };
          },
        } as never;
      },
    );
    const drivers = createDrivers(order);
    const lane = createProbeNativeLane(value.context, { rowDrivers: drivers, openNativeChannel });
    const nativeInput = {
      command,
      workItem: value.workItem,
      preparedContext,
      evidenceRoot: value.root,
      operationId: nativeOperationId,
      operationIntentPath,
      operationResultPath,
      invocation,
      candidate: value.loadedBootstrap.candidate,
      attestation: value.attestation,
      execution,
      transportAuthority: "injected-authoritative-lab",
    } as never;
    const first = await lane.transport.invokeScenarioAction(nativeInput);
    expect(first.operationId).toBe(nativeOperationId);
    expect(order.indexOf("validate-plan")).toBeLessThan(order.indexOf("open-channel"));
    expect(openNativeChannel).toHaveBeenCalledTimes(1);
    expect(order.filter((entry) => entry.startsWith("execute:"))).toEqual(
      plan.steps.map(
        (step) => `execute:${deriveProbeNativeActionPlanStepOperationId(plan, step.stepId)}`,
      ),
    );
    expect(durableTranscript).toBeDefined();

    const result = JSON.parse(
      (await value.evidence.readArtifact(operationResultPath)).bytes.toString("utf8"),
    );
    const projectionPath = `${probeSegmentArtifactPaths(value.workItem).evidence}/native-actions/${consumer.actionId}.json`;
    expect(result.evidenceArtifacts).toHaveLength(1);
    expect(result.evidenceArtifacts[0].path).toBe(projectionPath);
    const projection = JSON.parse(
      (await value.evidence.readArtifact(projectionPath)).bytes.toString("utf8"),
    );
    expect(projection).toMatchObject({
      kind: "windows-host-probe-native-action-projection-receipt",
      actionPlanSha256: plan.actionPlanSha256,
      nativeTranscriptSha256: durableTranscript?.transcriptSha256,
      stepResults: [{ stepId: plan.steps[0].stepId }, { stepId: plan.steps[1].stepId }],
    });
    expect(projection.controllerPlanAuthoritySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(projectionPath.startsWith(PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX)).toBe(false);

    const restarted = createProbeNativeLane(value.context, {
      rowDrivers: drivers,
      openNativeChannel,
    });
    await expect(restarted.transport.invokeScenarioAction(nativeInput)).resolves.toEqual(first);
    expect(openNativeChannel).toHaveBeenCalledTimes(1);
    const transcriptPath = `${probeSegmentArtifactPaths(value.workItem).nativeTranscripts}/${durableTranscript?.transcriptSha256}.json`;
    const bytes = await restarted.transport.readNativeTranscript({
      command,
      workItem: value.workItem,
      preparedContext,
      evidenceRoot: value.root,
      transcriptSha256: durableTranscript?.transcriptSha256,
      retainedPath: transcriptPath,
    } as never);
    expect(bytes).toEqual(canonicalBytes(durableTranscript));
    expect(validateNativeCommandTranscript(JSON.parse(bytes.toString("utf8")))).toEqual(
      durableTranscript,
    );
  });

  it.each([
    { failure: "shape", code: "NATIVE_LANE_EXECUTION" },
    { failure: "build", code: "NATIVE_LANE_CANDIDATE_BINDING" },
  ])(
    "closes once when the opened native channel has invalid $failure",
    async ({ failure, code }) => {
      const setup = await actionFixture();
      const close = vi.fn(async () => undefined);
      const prepare = vi.fn();
      const executePrepared = vi.fn();
      const channel =
        failure === "shape"
          ? { build: setup.value.build, close }
          : {
              build: { ...setup.value.build, assemblySha256: sha256("mismatched-assembly") },
              prepare,
              executePrepared,
              close,
            };
      const openNativeChannel = vi.fn(async () => channel);
      const lane = createProbeNativeLane(setup.value.context, {
        rowDrivers: createDrivers(setup.order),
        openNativeChannel: openNativeChannel as never,
      });

      await expect(
        lane.transport.invokeScenarioAction(setup.nativeInput as never),
      ).rejects.toMatchObject({ code });
      expect(openNativeChannel).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(executePrepared).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a substituted execution mapping before opening a channel or journal", async () => {
    const setup = await actionFixture();
    const openNativeChannel = vi.fn();
    const expectedExecution = getProbeActionMapping(setup.invocation);
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel,
    });

    await expect(
      lane.transport.invokeScenarioAction({
        ...setup.nativeInput,
        execution: { ...expectedExecution, driverId: "substituted-driver" },
      } as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_ACTION_EXECUTION" });
    expect(openNativeChannel).not.toHaveBeenCalled();
    const scan = await setup.value.evidence.scan();
    expect(
      scan.artifacts.filter(({ path }) =>
        path
          .toLocaleLowerCase("en-US")
          .startsWith(PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX.toLocaleLowerCase("en-US")),
      ),
    ).toEqual([]);
  });

  it("rejects a tampered execution mapping in the retained runtime intent", async () => {
    const setup = await actionFixture({ tamperIntentExecution: true });
    const openNativeChannel = vi.fn();
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel,
    });

    await expect(
      lane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_ACTION_INTENT" });
    expect(openNativeChannel).not.toHaveBeenCalled();
    const scan = await setup.value.evidence.scan();
    expect(
      scan.artifacts.filter(({ path }) =>
        path.startsWith(PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX),
      ),
    ).toEqual([]);
  });

  it("continues after a validated native command failure outcome", async () => {
    const setup = await actionFixture();
    const homeResult: NativeResultMap["home-identity"] = {
      canonicalHomeId: "home-identity-one",
      objectIdentity: "volume-one:object-one",
      volumeIdentity: "volume-one",
      finalPathSha256: sha256("final-home-path"),
      fileSystem: "NTFS",
      driveType: "fixed",
      reparseTag: 0,
      linkCount: 1,
    };
    const commandFailure = {
      code: "NATIVE_EXPECTED_REFUSAL",
      message: "comparison path was unavailable",
      win32Code: 5,
    };
    const executed: {
      command: NativeCommand;
      operationId: string;
      request: Readonly<Record<string, unknown>>;
      result?: Readonly<Record<string, unknown>>;
      error?: typeof commandFailure;
    }[] = [];
    const executePrepared = vi.fn(async (prepared: ReturnType<typeof preparedRequest>) => {
      const outcome =
        executed.length === 0
          ? { ok: true as const, result: homeResult }
          : { ok: false as const, error: commandFailure };
      executed.push({
        command: prepared.command,
        operationId: prepared.operationId,
        request: prepared.requestFrame.request,
        ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
      });
      return { command: prepared.command, operationId: prepared.operationId, ...outcome };
    });
    const openNativeChannel = vi.fn(
      async ({ preflightBinding }: { preflightBinding: NativePreflightBinding }) => ({
        build: setup.value.build,
        prepare: async <C extends NativeCommand>(
          command: C,
          request: NativeRequestMap[C],
          options: { readonly operationId: string },
        ) =>
          preparedRequest(
            command,
            {
              ...request,
              relativePath: String((request as { relativePath: string }).relativePath).replaceAll(
                "/",
                "\\",
              ),
            },
            options.operationId,
          ),
        executePrepared,
        close: async () => ({
          exit: { code: 0, signal: null },
          transcript: createNativeTranscript(
            preflightBinding,
            executed,
            setup.value.runRootIdentity,
          ),
        }),
      }),
    );
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });

    await expect(
      lane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).resolves.toMatchObject({ operationId: setup.nativeOperationId });
    expect(executePrepared).toHaveBeenCalledTimes(2);
    expect(executed.map(({ error }) => error?.code ?? null)).toEqual([null, commandFailure.code]);
  });

  it("rejects a terminal native transcript whose planned commands are reordered", async () => {
    const setup = await actionFixture();
    const homeResult: NativeResultMap["home-identity"] = {
      canonicalHomeId: "home-identity-one",
      objectIdentity: "volume-one:object-one",
      volumeIdentity: "volume-one",
      finalPathSha256: sha256("final-home-path"),
      fileSystem: "NTFS",
      driveType: "fixed",
      reparseTag: 0,
      linkCount: 1,
    };
    const executed: {
      command: NativeCommand;
      operationId: string;
      request: Readonly<Record<string, unknown>>;
      result: NativeResultMap["home-identity"];
    }[] = [];
    const openNativeChannel = vi.fn(
      async ({ preflightBinding }: { preflightBinding: NativePreflightBinding }) => ({
        build: setup.value.build,
        prepare: async <C extends NativeCommand>(
          command: C,
          request: NativeRequestMap[C],
          options: { readonly operationId: string },
        ) =>
          preparedRequest(
            command,
            {
              ...request,
              relativePath: String((request as { relativePath: string }).relativePath).replaceAll(
                "/",
                "\\",
              ),
            },
            options.operationId,
          ),
        executePrepared: async (prepared: ReturnType<typeof preparedRequest>) => {
          executed.push({
            command: prepared.command,
            operationId: prepared.operationId,
            request: prepared.requestFrame.request,
            result: homeResult,
          });
          return {
            command: prepared.command,
            operationId: prepared.operationId,
            ok: true as const,
            result: homeResult,
          };
        },
        close: async () => ({
          exit: { code: 0, signal: null },
          transcript: createNativeTranscript(
            preflightBinding,
            [...executed].reverse(),
            setup.value.runRootIdentity,
          ),
        }),
      }),
    );
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });

    await expect(
      lane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_TRANSCRIPT_COMMAND" });
    expect(executed).toHaveLength(setup.plan.steps.length);
  });

  it("rejects a reordered retained transcript before resuming journal publication", async () => {
    const setup = await actionFixture();
    const homeResult: NativeResultMap["home-identity"] = {
      canonicalHomeId: "home-identity-one",
      objectIdentity: "volume-one:object-one",
      volumeIdentity: "volume-one",
      finalPathSha256: sha256("final-home-path"),
      fileSystem: "NTFS",
      driveType: "fixed",
      reparseTag: 0,
      linkCount: 1,
    };
    const intents = setup.plan.steps.map((step) => {
      const operationId = deriveProbeNativeActionPlanStepOperationId(setup.plan, step.stepId);
      return createProbeNativeOperationIntent({
        actionPlan: setup.plan,
        stepId: step.stepId,
        inputSha256: hashProbeCanonicalJson({
          domain: "enduragent.windows-host-probe-native-lane-step-input.v1",
          actionPlanSha256: setup.plan.actionPlanSha256,
          runtimeOperationId: setup.nativeOperationId,
          nativeOperationId: operationId,
          stepId: step.stepId,
          command: step.command,
          request: step.request,
          preparedContextSha256: setup.preparedContext.preflightSha256,
        }),
      });
    });
    const preflightBinding: NativePreflightBinding = {
      campaignRunId: setup.preparedContext.campaignRunId,
      candidateSha256: setup.preparedContext.candidateSha256,
      preflightSha256: setup.preparedContext.preflightSha256,
      executionBundleManifestSha256: setup.preparedContext.executionBundleManifestSha256,
      nativeHelperArtifactPath:
        setup.preparedContext.executionBundleManifest.binaries.nativeHelper.path,
      nativeHelperSha256:
        setup.preparedContext.executionBundleManifest.binaries.nativeHelper.sha256,
      nativeCandidateDigest:
        setup.preparedContext.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
      nativeManifestSha256:
        setup.preparedContext.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
      evidenceRootObjectIdentitySha256:
        setup.preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    };
    const reorderedTranscript = createNativeTranscript(
      preflightBinding,
      setup.plan.steps
        .map((step, index) => ({
          command: step.command,
          operationId: intents[index].operationId,
          request: {
            ...step.request,
            relativePath: String(
              (step.request as { readonly relativePath: string }).relativePath,
            ).replaceAll("/", "\\"),
          },
          result: homeResult,
        }))
        .reverse(),
      setup.value.runRootIdentity,
    );
    const transcriptPath = `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/transcripts/${reorderedTranscript.transcriptSha256}.json`;
    await ensureEvidenceDirectory(
      setup.value.evidence,
      transcriptPath.slice(0, transcriptPath.lastIndexOf("/")),
    );
    await setup.value.evidence.writeBytes(transcriptPath, canonicalBytes(reorderedTranscript));
    const journalRoot = `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`;
    await ensureEvidenceDirectory(setup.value.evidence, journalRoot);
    const journal = await openProbeNativeOperationJournal({
      root: join(setup.value.root, ...journalRoot.split("/")),
    });
    try {
      await journal.acquireExecutionBatch(intents);
      for (const intent of intents) {
        await journal.recordEffectStarted({
          operationId: intent.operationId,
          intentSha256: intent.intentSha256,
        });
        await journal.recordTranscriptRetained({
          operationId: intent.operationId,
          intentSha256: intent.intentSha256,
          artifactSha256: reorderedTranscript.transcriptSha256,
        });
      }
    } finally {
      await journal.close();
    }
    const openNativeChannel = vi.fn();
    const restartedLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel,
    });

    await expect(
      restartedLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_TRANSCRIPT_COMMAND" });
    expect(openNativeChannel).not.toHaveBeenCalled();
  });

  it("allows only one independent lane to execute a mutating native batch", async () => {
    const setup = await actionFixture({ mutating: true });
    const transportFailure = new Error("mutating native transport disconnected");
    let beginExecution!: () => void;
    let releaseExecution!: () => void;
    const executionBegan = new Promise<void>((resolve) => {
      beginExecution = resolve;
    });
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const executePrepared = vi.fn(async () => {
      beginExecution();
      await executionReleased;
      throw transportFailure;
    });
    const close = vi.fn(async () => undefined);
    const openNativeChannel = vi.fn(async () => ({
      build: setup.value.build,
      prepare: vi.fn(
        async (
          command: NativeCommand,
          request: Readonly<Record<string, unknown>>,
          options: { readonly operationId: string },
        ) => preparedRequest(command, request, options.operationId),
      ),
      executePrepared,
      transcript: vi.fn(() => {
        throw transportFailure;
      }),
      close,
    }));
    const firstLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });
    const secondLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });

    const owner = firstLane.transport.invokeScenarioAction(setup.nativeInput as never);
    await executionBegan;
    await expect(
      secondLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_EXECUTION_BUSY" });
    expect(openNativeChannel).toHaveBeenCalledTimes(1);
    expect(executePrepared).toHaveBeenCalledTimes(1);

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      const scan = await journal.scan();
      expect(scan.operations).toHaveLength(1);
      expect(scan.operations[0]).toMatchObject({ currentState: "effect-started" });
      expect(scan.operations[0].transitions.map(({ state }) => state)).toEqual([
        "claim",
        "effect-started",
      ]);
    } finally {
      await journal.close();
    }

    releaseExecution();
    await expect(owner).rejects.toBe(transportFailure);
    expect(openNativeChannel).toHaveBeenCalledTimes(1);
    expect(executePrepared).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      secondLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_RECONCILIATION_REQUIRED" });
    expect(openNativeChannel).toHaveBeenCalledTimes(1);
    expect(executePrepared).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an exact existing claim without opening another channel", async () => {
    const setup = await actionFixture({ mutating: true });
    const interruptedBeforeOpen = new Error("channel construction interrupted");
    const ownerOpenNativeChannel = vi.fn(async () => {
      throw interruptedBeforeOpen;
    });
    const ownerLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: ownerOpenNativeChannel as never,
    });

    await expect(ownerLane.transport.invokeScenarioAction(setup.nativeInput as never)).rejects.toBe(
      interruptedBeforeOpen,
    );
    expect(ownerOpenNativeChannel).toHaveBeenCalledTimes(1);

    const retryOpenNativeChannel = vi.fn();
    const retryLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: retryOpenNativeChannel,
    });
    await expect(
      retryLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_INCONCLUSIVE" });
    expect(retryOpenNativeChannel).not.toHaveBeenCalled();

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      const operationId = deriveProbeNativeActionPlanStepOperationId(
        setup.plan,
        setup.plan.steps[0].stepId,
      );
      await expect(journal.readOperation(operationId)).resolves.toMatchObject({
        currentState: "claim",
        transitions: [{ state: "claim" }],
      });
    } finally {
      await journal.close();
    }
  });

  it("leaves a step claimed when native request preparation fails before send", async () => {
    const setup = await actionFixture();
    const preparationFailure = new Error("native request normalization failed");
    const prepare = vi.fn(async () => {
      throw preparationFailure;
    });
    const executePrepared = vi.fn();
    const close = vi.fn(async () => undefined);
    const openNativeChannel = vi.fn(async () => ({
      build: setup.value.build,
      prepare,
      executePrepared,
      close,
    }));
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });

    await expect(lane.transport.invokeScenarioAction(setup.nativeInput as never)).rejects.toBe(
      preparationFailure,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(executePrepared).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      const scan = await journal.scan();
      expect(scan.operations).toHaveLength(setup.plan.steps.length);
      expect(scan.operations.map(({ currentState }) => currentState)).toEqual(
        setup.plan.steps.map(() => "claim"),
      );
      expect(scan.operations.flatMap(({ transitions }) => transitions)).toHaveLength(
        setup.plan.steps.length,
      );
    } finally {
      await journal.close();
    }
  });

  it("rejects a malformed prepared request before recording an effect", async () => {
    const setup = await actionFixture();
    const step = setup.plan.steps[0];
    const operationId = deriveProbeNativeActionPlanStepOperationId(setup.plan, step.stepId);
    const prepare = vi.fn(async () => ({
      ...preparedRequest(step.command, step.request, operationId),
      requestFrameSha256: sha256("prepared-request").toUpperCase(),
    }));
    const executePrepared = vi.fn();
    const close = vi.fn(async () => undefined);
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: vi.fn(async () => ({
        build: setup.value.build,
        prepare,
        executePrepared,
        close,
      })) as never,
    });

    await expect(
      lane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_PREPARED_REQUEST" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(executePrepared).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      await expect(journal.readOperation(operationId)).resolves.toMatchObject({
        currentState: "claim",
        transitions: [{ state: "claim" }],
      });
    } finally {
      await journal.close();
    }
  });

  it("aborts a multi-step channel after a transport rejection without starting later steps", async () => {
    const setup = await actionFixture();
    const transportFailure = new Error("native transport disconnected");
    const executePrepared = vi.fn(async () => {
      throw transportFailure;
    });
    const close = vi.fn(async () => undefined);
    const openNativeChannel = vi.fn(async () => ({
      build: setup.value.build,
      prepare: vi.fn(
        async (
          command: NativeCommand,
          request: Readonly<Record<string, unknown>>,
          options: { readonly operationId: string },
        ) => preparedRequest(command, request, options.operationId),
      ),
      executePrepared,
      transcript: vi.fn(() => {
        throw transportFailure;
      }),
      close,
    }));
    const lane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: openNativeChannel as never,
    });

    await expect(lane.transport.invokeScenarioAction(setup.nativeInput as never)).rejects.toBe(
      transportFailure,
    );
    expect(executePrepared).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      const firstOperationId = deriveProbeNativeActionPlanStepOperationId(
        setup.plan,
        setup.plan.steps[0].stepId,
      );
      const secondOperationId = deriveProbeNativeActionPlanStepOperationId(
        setup.plan,
        setup.plan.steps[1].stepId,
      );
      await expect(journal.readOperation(firstOperationId)).resolves.toMatchObject({
        currentState: "effect-started",
      });
      await expect(journal.readOperation(secondOperationId)).resolves.toMatchObject({
        currentState: "claim",
      });
    } finally {
      await journal.close();
    }
  });

  it("replays a read-only effect-started prefix and executes its claimed remainder after restart", async () => {
    const setup = await actionFixture();
    const interrupted = new Error("native process exited after accepting the first request");
    let markEffectStarted!: () => void;
    let releaseInterruptedExecution!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    const interruptedExecutionReleased = new Promise<void>((resolve) => {
      releaseInterruptedExecution = resolve;
    });
    const firstExecute = vi.fn(async () => {
      markEffectStarted();
      await interruptedExecutionReleased;
      throw interrupted;
    });
    const firstLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: vi.fn(async () => ({
        build: setup.value.build,
        prepare: async (
          command: NativeCommand,
          request: Readonly<Record<string, unknown>>,
          options: { readonly operationId: string },
        ) => preparedRequest(command, request, options.operationId),
        executePrepared: firstExecute,
        close: vi.fn(async () => undefined),
      })) as never,
    });

    const originalExecution = firstLane.transport.invokeScenarioAction(setup.nativeInput as never);
    await effectStarted;
    const concurrentOpenNativeChannel = vi.fn();
    const concurrentLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: concurrentOpenNativeChannel,
    });
    await expect(
      concurrentLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).rejects.toMatchObject({ code: "NATIVE_LANE_EXECUTION_BUSY" });
    expect(concurrentOpenNativeChannel).not.toHaveBeenCalled();
    releaseInterruptedExecution();
    await expect(originalExecution).rejects.toBe(interrupted);
    expect(firstExecute).toHaveBeenCalledTimes(1);

    const homeResult: NativeResultMap["home-identity"] = {
      canonicalHomeId: "home-identity-one",
      objectIdentity: "volume-one:object-one",
      volumeIdentity: "volume-one",
      finalPathSha256: sha256("final-home-path"),
      fileSystem: "NTFS",
      driveType: "fixed",
      reparseTag: 0,
      linkCount: 1,
    };
    const replayed: {
      command: NativeCommand;
      operationId: string;
      request: Readonly<Record<string, unknown>>;
      result: NativeResultMap["home-identity"];
    }[] = [];
    const restartOpenNativeChannel = vi.fn(
      async ({ preflightBinding }: { preflightBinding: NativePreflightBinding }) => ({
        build: setup.value.build,
        prepare: async <C extends NativeCommand>(
          command: C,
          request: NativeRequestMap[C],
          options: { readonly operationId: string },
        ) =>
          preparedRequest(
            command,
            {
              ...request,
              relativePath: String((request as { relativePath: string }).relativePath).replaceAll(
                "/",
                "\\",
              ),
            },
            options.operationId,
          ),
        executePrepared: async (prepared: ReturnType<typeof preparedRequest>) => {
          replayed.push({
            command: prepared.command,
            operationId: prepared.operationId,
            request: prepared.requestFrame.request,
            result: homeResult,
          });
          return {
            command: prepared.command,
            operationId: prepared.operationId,
            ok: true as const,
            result: homeResult,
          };
        },
        close: async () => ({
          exit: { code: 0, signal: null },
          transcript: createNativeTranscript(
            preflightBinding,
            replayed,
            setup.value.runRootIdentity,
          ),
        }),
      }),
    );
    const restartedLane = createProbeNativeLane(setup.value.context, {
      rowDrivers: createDrivers(setup.order),
      openNativeChannel: restartOpenNativeChannel as never,
    });

    await expect(
      restartedLane.transport.invokeScenarioAction(setup.nativeInput as never),
    ).resolves.toMatchObject({ operationId: setup.nativeOperationId });
    expect(restartOpenNativeChannel).toHaveBeenCalledTimes(1);
    expect(replayed.map(({ operationId }) => operationId)).toEqual(
      setup.plan.steps.map((step) =>
        deriveProbeNativeActionPlanStepOperationId(setup.plan, step.stepId),
      ),
    );

    const journal = await openProbeNativeOperationJournal({
      root: join(
        setup.value.root,
        ...`${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`.split("/"),
      ),
    });
    try {
      const scan = await journal.scan();
      expect(scan.operations).toHaveLength(setup.plan.steps.length);
      expect(scan.operations.map(({ currentState }) => currentState)).toEqual(
        setup.plan.steps.map(() => "terminal-result-retained"),
      );
    } finally {
      await journal.close();
    }
  });
});
