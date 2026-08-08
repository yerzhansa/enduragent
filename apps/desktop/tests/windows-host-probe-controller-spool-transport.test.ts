import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";
import type { EvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import type { LoadedProbeBootstrap } from "../scripts/windows-host-falsifier/probe-bootstrap.mjs";
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
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  createProbeControllerActionAttestation,
  createProbeControllerActionExecutionReceipt,
  createProbeControllerActionProvenance,
  createProbeControllerBrokerAcceptance,
  collectProbeControllerActionSignedArtifacts,
  probeControllerActionAttestationPath,
  probeControllerActionProvenancePaths,
  probeControllerBrokerAcceptancePath,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { createProbeBrokerResult } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE,
  createProbeControllerSpoolTransport,
  probeControllerActionCommitMarkerPath,
  readVerifiedControllerNativeActionPlan,
} from "../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { probeSegmentArtifactPaths } from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import {
  createProbeNativeActionPlan,
  probeNativeActionPlanPath,
} from "../scripts/windows-host-falsifier/probe-native-action-plan.mjs";
import { deriveProbeRunAuthorizationClaimReceiptDigest } from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import {
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { createProbeRuntimeActionBinding } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});

function store(root: string): EvidenceStore {
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

function memoryStore(root: string) {
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  let failBeforeWriteIndex: number | null = null;
  const value = {
    root,
    createDirectory: vi.fn(async () => undefined),
    writeBytes: vi.fn(async (path: string, supplied: Uint8Array | string) => {
      if (failBeforeWriteIndex === writes.length) {
        throw Object.assign(new Error("injected retention crash"), { code: "EIO" });
      }
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const bytes = Buffer.from(supplied);
      files.set(path, bytes);
      writes.push(path);
      return { path, sha256: sha256(bytes) };
    }),
    writeCanonicalJson: vi.fn(),
    readArtifact: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { path, bytes: Buffer.from(bytes), size: bytes.length, sha256: sha256(bytes) };
    }),
    verifyArtifactSet: vi.fn(),
    scan: vi.fn(),
    list: vi.fn(async (relativePath: string) => {
      const prefix = relativePath.length === 0 ? "" : `${relativePath}/`;
      const entries = new Map<string, "directory" | "file">();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const remainder = path.slice(prefix.length);
        const separator = remainder.indexOf("/");
        const name = separator === -1 ? remainder : remainder.slice(0, separator);
        if (name.length !== 0) entries.set(name, separator === -1 ? "file" : "directory");
      }
      return [...entries].map(([name, kind]) => ({ name, kind }));
    }),
    assertRootStable: vi.fn(async () => undefined),
  } as unknown as EvidenceStore;
  return {
    value,
    files,
    writes,
    seed(path: string, bytes: Uint8Array | string) {
      files.set(path, Buffer.from(bytes));
    },
    failBeforeWrite(index: number | null) {
      failBeforeWriteIndex = index;
    },
  };
}

function contentReference(bytes: Uint8Array) {
  const digest = sha256(bytes);
  return { blobPath: `blobs/sha256/${digest}` as const, bytes: bytes.length, sha256: digest };
}

function signedExchange(
  request: ControllerRequest,
  loadedBootstrap: LoadedProbeBootstrap,
  payloadBytes: Uint8Array,
  signed: readonly {
    readonly reference: ReturnType<typeof contentReference>;
    readonly bytes: Uint8Array;
  }[],
) {
  const draft: ControllerResponseDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_RESPONSE_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    requestSha256: request.requestSha256,
    outcome: "SUCCEEDED",
    payload: contentReference(payloadBytes),
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
    payloadBytes: Buffer.from(payloadBytes),
    artifacts: signed.map(({ reference, bytes }) => ({
      reference,
      bytes: Buffer.from(bytes),
    })),
  };
}

function successfulExchange(
  request: ControllerRequest,
  loadedBootstrap: LoadedProbeBootstrap,
  result: unknown,
  artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[] = [],
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
  return signedExchange(request, loadedBootstrap, encoded.bytes, signed);
}

function nativeCanonicalDigest(value: unknown) {
  return sha256(JSON.stringify(JSON.parse(canonicalProbeJson(value))));
}

function createObserverTranscript(
  preparedContext: ReturnType<typeof createPreparedContextFixture>,
  candidateSha256 = preparedContext.candidateSha256,
) {
  const nativeHelper = preparedContext.executionBundleManifest.binaries.nativeHelper;
  const runRootIdentity = "evidence-root-object";
  if (
    sha256(runRootIdentity) !==
    preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256
  ) {
    throw new Error("observer transcript fixture root identity differs from prepared context");
  }
  const nativeSessionId = "native-session-controller-observer";
  const operationId = "operation-controller-observer-startup";
  const requestId = "request-controller-observer-startup";
  const startupContext = {
    campaignRunId: preparedContext.campaignRunId,
    candidateSha256,
    preflightSha256: preparedContext.preflightSha256,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
    nativeManifestSha256: nativeHelper.nativeManifestSha256,
    nativeHelperSha256: nativeHelper.sha256,
    evidenceRootObjectIdentitySha256:
      preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    nativeSessionId,
    operationId,
  };
  const requestFrameSha256 = nativeCanonicalDigest({
    protocolVersion: 1,
    requestId,
    command: "native-binding-check",
    context: startupContext,
    request: {},
  });
  const startupHandshake = {
    protocolVersion: 1 as const,
    kind: "response" as const,
    requestId,
    command: "native-binding-check" as const,
    context: { ...startupContext, requestFrameSha256, runRootIdentity },
    ok: true as const,
    result: {
      ready: true as const,
      processId: 4242,
      nativeHelperSha256: nativeHelper.sha256,
      runRootIdentity,
      evidenceRootObjectIdentitySha256:
        preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    },
  };
  const binding = {
    campaignRunId: preparedContext.campaignRunId,
    candidateSha256,
    preflightSha256: preparedContext.preflightSha256,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    nativeHelperArtifactPath: nativeHelper.path,
    nativeHelperSha256: nativeHelper.sha256,
    nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
    nativeManifestSha256: nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256:
      preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    nativeSessionId,
    runRootIdentity,
    startupHandshake,
    startupHandshakeSha256: nativeCanonicalDigest(startupHandshake),
  };
  const commandOperationId = "operation-controller-observer-command";
  const commandRequestId = "request-controller-observer-command";
  const command = "home-identity";
  const request = { relativePath: "targets\\home" };
  const commandContext = {
    campaignRunId: preparedContext.campaignRunId,
    candidateSha256,
    preflightSha256: preparedContext.preflightSha256,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
    nativeManifestSha256: nativeHelper.nativeManifestSha256,
    nativeHelperSha256: nativeHelper.sha256,
    evidenceRootObjectIdentitySha256:
      preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
    nativeSessionId,
    operationId: commandOperationId,
  };
  const commandRequestFrameSha256 = nativeCanonicalDigest({
    protocolVersion: 1,
    requestId: commandRequestId,
    command,
    context: commandContext,
    request,
  });
  const result = {
    canonicalHomeId: "home-fixture",
    objectIdentity: "home-object-fixture",
    volumeIdentity: "volume-fixture",
    finalPathSha256: sha256("home-final-path"),
    fileSystem: "NTFS",
    driveType: "fixed",
    reparseTag: 0,
    linkCount: 1,
  };
  const commandRecord = {
    kind: "command" as const,
    sequence: 1,
    requestId: commandRequestId,
    command,
    operationId: commandOperationId,
    requestFrameSha256: commandRequestFrameSha256,
    nativeRequestFrameSha256: commandRequestFrameSha256,
    requestFrameVerification: "recomputed" as const,
    responseFrameSha256: nativeCanonicalDigest({
      protocolVersion: 1,
      kind: "response",
      requestId: commandRequestId,
      command,
      context: {
        ...commandContext,
        requestFrameSha256: commandRequestFrameSha256,
        runRootIdentity,
      },
      ok: true,
      result,
    }),
    ok: true as const,
    request,
    result,
  };
  const payload = {
    schemaVersion: 1 as const,
    kind: "windows-host-native-command-transcript" as const,
    binding,
    records: [commandRecord],
    termination: { mode: "clean-eof" as const, code: 0 as const, signal: null },
  };
  return {
    ...payload,
    transcriptSha256: nativeCanonicalDigest({
      domain: "enduragent.windows-host-native-command-transcript.v1",
      transcript: payload,
    }),
  };
}

function successfulScenarioActionExchange(
  request: ControllerRequest,
  loadedBootstrap: LoadedProbeBootstrap,
  inputs: Pick<
    ReturnType<typeof operationInputs>,
    | "command"
    | "workItem"
    | "preparedContext"
    | "invocation"
    | "runtimeActionBinding"
    | "operationResultPath"
  >,
  suppliedResult: {
    readonly actionId: string;
    readonly commandEvent: null;
    readonly evidenceArtifacts: readonly { readonly path: string; readonly sha256: string }[];
  },
  suppliedArtifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[] = [],
  options: {
    readonly receiptCandidateSha256?: string;
    readonly observerCandidateSha256?: string;
    readonly observerWithoutCommand?: boolean;
  } = {},
) {
  const artifacts = suppliedArtifacts
    .filter(({ path }) => path !== inputs.operationResultPath)
    .map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) }));
  let proofArtifacts = [...suppliedResult.evidenceArtifacts];
  if (proofArtifacts.length === 0) {
    const bytes = Buffer.from(`proof:${suppliedResult.actionId}`, "utf8");
    const path = `${probeSegmentArtifactPaths(inputs.workItem).evidence}/controller-action-proof.json`;
    artifacts.push({ path, bytes });
    proofArtifacts = [{ path, sha256: sha256(bytes) }];
  }
  let observerTranscript = createObserverTranscript(
    inputs.preparedContext,
    options.observerCandidateSha256,
  );
  if (options.observerWithoutCommand === true) {
    const { transcriptSha256: _transcriptSha256, ...transcriptPayload } = observerTranscript;
    const withoutCommand = { ...transcriptPayload, records: [] };
    observerTranscript = {
      ...withoutCommand,
      transcriptSha256: nativeCanonicalDigest({
        domain: "enduragent.windows-host-native-command-transcript.v1",
        transcript: withoutCommand,
      }),
    };
  }
  const observerBytes = Buffer.from(canonicalProbeJson(observerTranscript), "utf8");
  const observerPath = `${probeSegmentArtifactPaths(inputs.workItem).evidence}/native-transcripts/${observerTranscript.transcriptSha256}.json`;
  artifacts.push({ path: observerPath, bytes: observerBytes });
  let brokerProof: { readonly path: string; readonly sha256: string } | null = null;
  const expectedActor = inputs.runtimeActionBinding.expectedActor;
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
      bootIdSha256: inputs.preparedContext.bootIdSha256,
      runnerSessionIdSha256: inputs.preparedContext.runnerSessionIdSha256,
      outcome: "SUCCEEDED",
      driverResult: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-result",
        driverId: inputs.runtimeActionBinding.execution.driverId,
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
    const brokerResultBytes = Buffer.from(canonicalProbeJson(brokerResult), "utf8");
    brokerProof = {
      path: `${probeSegmentArtifactPaths(inputs.workItem).evidence}/proofs/${suppliedResult.actionId}.broker-result.json`,
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
    const brokerAcceptanceBytes = Buffer.from(canonicalProbeJson(brokerAcceptance), "utf8");
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
    if (observerCommands.length === 0) {
      observerCommands.push({
        transcriptSha256: observerTranscript.transcriptSha256,
        sequence: 1,
        commandId: "home-identity",
        requestFrameSha256: sha256("missing observer request"),
        responseFrameSha256: sha256("missing observer response"),
        ok: true,
      });
    }
    const actionAttestation = createProbeControllerActionAttestation({
      candidateSha256: inputs.preparedContext.candidateSha256,
      executionBundleId: inputs.preparedContext.executionBundleId,
      executionBundleManifestSha256: inputs.preparedContext.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256: inputs.preparedContext.runAuthorizationClaimReceiptSha256,
      coordinate: request.coordinate as never,
      scenarioPlanSha256: inputs.invocation.planSha256,
      producerActionId: suppliedResult.actionId,
      operation: request.operation as never,
      runtimeActionIntentSha256: inputs.runtimeActionBinding.operationIntentSha256,
      execution: inputs.runtimeActionBinding.execution as never,
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
    const actionAttestationBytes = Buffer.from(canonicalProbeJson(actionAttestation), "utf8");
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
  const resultBytes = Buffer.from(canonicalProbeJson(actionResult), "utf8");
  const nativeActionPlans = artifacts
    .filter(({ path }) => path.includes("/driver-plans/"))
    .map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const receipt = createProbeControllerActionExecutionReceipt({
    candidateSha256: options.receiptCandidateSha256 ?? loadedBootstrap.candidate.candidateSha256,
    executionBundleId: inputs.preparedContext.executionBundleId,
    executionBundleManifestSha256: inputs.preparedContext.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: inputs.preparedContext.runAuthorizationClaimReceiptSha256,
    coordinate: request.coordinate,
    scenarioPlanSha256: inputs.invocation.planSha256,
    producerActionId: inputs.invocation.action.actionId,
    operation: request.operation as {
      readonly operationId: string;
      readonly kind: "scenario-action";
      readonly sequence: number;
    },
    intentSha256: inputs.runtimeActionBinding.operationIntentSha256,
    execution: inputs.runtimeActionBinding.execution as never,
    expectedActor: inputs.runtimeActionBinding.expectedActor as never,
    actionResult,
    actionResultArtifact: { path: inputs.operationResultPath, sha256: sha256(resultBytes) },
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
  return successfulExchange(request, loadedBootstrap, receipt, [
    ...artifacts,
    { path: inputs.operationResultPath, bytes: resultBytes },
  ]);
}

function bootstrapFixture(): LoadedProbeBootstrap {
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
  const candidateSha256 = sha256("candidate");
  const authorizationSha256 = sha256("authorization");
  const attestation = (environmentId: "win11-floor" | "win11-current") => ({
    environmentId,
    attestationSha256: sha256(`attestation:${environmentId}`),
    controller,
    controllerEvidence: {
      path: `attestations/${environmentId}-controller.json`,
      sha256: sha256(`controller-evidence:${environmentId}`),
    },
  });
  return {
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
    },
    candidate: { candidateSha256 },
    attestations: [attestation("win11-floor"), attestation("win11-current")],
    runAuthorization: {
      campaignId: PROBE_CAMPAIGN_ID,
      manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
      campaignRunId: "campaign-one",
      runPlanSha256: PROBE_RUN_PLAN_SHA256,
      candidateSha256,
      authorizationSha256,
    },
    controllerPublicKeySpkiDerBase64: Buffer.from(controllerPublicKeyBytes).toString("base64"),
  } as unknown as LoadedProbeBootstrap;
}

function claimFixture(loaded: LoadedProbeBootstrap) {
  const attestation = loaded.attestations[0];
  const fields = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization-claim-receipt" as const,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: loaded.candidate.candidateSha256,
    campaignRunId: loaded.bootstrap.campaignRunId,
    environmentId: attestation.environmentId,
    labAttestationSha256: attestation.attestationSha256,
    evidenceRootObjectIdentitySha256: sha256("evidence-root-object"),
    authorizationSha256: loaded.runAuthorization.authorizationSha256,
    operatorKeyId: "operator-one",
    operatorPublicKeySha256: sha256("operator-key"),
    trustStoreId: "trust-store-one",
    trustStoreGeneration: 1,
    trustStoreSha256: sha256("trust-store"),
    verifiedAt: "2026-08-07T00:00:00.000Z",
    authorizationExpiresAt: "2026-08-08T00:00:00.000Z",
    controllerIdentitySha256: loaded.bootstrap.controllerSpool.identitySha256,
    controllerPublicKeySha256: loaded.bootstrap.controllerSpool.publicKeySha256,
    controllerVersion: loaded.bootstrap.controllerSpool.version,
    signatureAlgorithm: "Ed25519" as const,
    signatureBase64: Buffer.alloc(64, 1).toString("base64"),
  };
  return {
    ...fields,
    receiptSha256: deriveProbeRunAuthorizationClaimReceiptDigest(fields),
  };
}

function operationInputs(loaded: LoadedProbeBootstrap, evidenceRoot: string) {
  const workItem = PROBE_RUN_PLAN.work[0];
  const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
  const action = definition.actions.find(({ actor }) => actor === "external-controller");
  if (action === undefined) throw new Error("test work item has no controller action");
  const claim = claimFixture(loaded);
  const request = {
    campaignRunId: loaded.bootstrap.campaignRunId,
    executionRunId: "execution-one",
    executionBundleId: "bundle-one",
    attemptId: "attempt-one",
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    vmSnapshotId: "snapshot-one",
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner"),
    nativeHelperArtifactPath: "bin/native-helper.exe",
    nsisArtifactPath: "bin/nsis.exe",
  };
  const preparedContext = createPreparedContextFixture({
    campaignRunId: request.campaignRunId,
    executionRunId: request.executionRunId,
    executionBundleId: request.executionBundleId,
    attemptId: request.attemptId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    candidateSha256: loaded.candidate.candidateSha256,
    labAttestationSha256: loaded.attestations[0].attestationSha256,
    runPlanSha256: loaded.bootstrap.runPlanSha256,
    runAuthorizationSha256: loaded.runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: claim.receiptSha256,
    vmSnapshotId: request.vmSnapshotId,
    bootIdSha256: request.bootIdSha256,
    runnerSessionIdSha256: request.runnerSessionIdSha256,
    evidenceRootObjectIdentitySha256: claim.evidenceRootObjectIdentitySha256,
    controller: loaded.attestations[0].controller,
    nativeHelper: {
      path: request.nativeHelperArtifactPath,
      sha256: sha256("native-helper"),
      nativeCandidateDigest: sha256("native-candidate"),
      nativeManifestSha256: sha256("native-manifest"),
    },
    nsis: { path: request.nsisArtifactPath, sha256: sha256("nsis") },
  });
  const command = {
    campaignRunId: request.campaignRunId,
    attemptId: request.attemptId,
    workId: workItem.workId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    repetition: 3,
  };
  const finalizationIntent = {
    campaignRunId: request.campaignRunId,
    executionRunId: request.executionRunId,
    attemptId: request.attemptId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    runAuthorizationClaimReceiptSha256: claim.receiptSha256,
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
  return {
    workItem,
    claim,
    request,
    preparedContext,
    command,
    finalizationIntent,
    invocation,
    runtimeActionBinding,
    operationResultPath: runtimeActionBinding.operationResultPath,
    evidenceRoot,
  };
}

function nativePlanInputs(loaded: LoadedProbeBootstrap, evidenceRoot: string) {
  const base = operationInputs(loaded, evidenceRoot);
  const definition = getProbeScenarioDefinition(base.workItem.rowId, base.workItem.variantId);
  const producer = definition.actions.find(({ actionId }) => actionId === "prepare-home-topology");
  const consumer = definition.actions.find(({ actionId }) => actionId === "capture-home-identity");
  if (producer === undefined || consumer === undefined) {
    throw new Error("F-01 native plan actions are missing");
  }
  const rootIdentitySha256 = sha256("evidence-root-object");
  const preparedContext = base.preparedContext;
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: producer,
  };
  const consumerBinding = createProbeRuntimeActionBinding({
    command: base.command,
    invocation: { ...invocation, action: consumer },
    preparedContext,
  });
  const operationResultPath = [
    "runtime",
    "work",
    base.command.campaignRunId,
    base.command.attemptId,
    base.command.workId,
    "action-results",
    `${producer.actionId}.json`,
  ].join("/");
  const plan = createProbeNativeActionPlan({
    candidateSha256: loaded.candidate.candidateSha256,
    campaignRunId: base.command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    attemptId: base.command.attemptId,
    workId: base.command.workId,
    environmentId: base.command.environmentId,
    pathProfileId: base.command.pathProfileId,
    rowId: base.command.rowId,
    variantId: base.command.variantId,
    scenarioPlanSha256: definition.planSha256,
    producerActionId: producer.actionId,
    consumerActionId: consumer.actionId,
    operationId: consumerBinding.operationId,
    evidenceRootObjectIdentitySha256: rootIdentitySha256,
    steps: [
      {
        sequence: 1,
        stepId: "observe-home",
        command: "home-identity",
        request: { relativePath: "targets/home" },
        timeoutMs: 30_000,
        recoveryClass: "read-only-replay",
      },
    ],
    prerequisiteEvidence: [],
  });
  const planPath = probeNativeActionPlanPath({
    campaignRunId: plan.campaignRunId,
    attemptId: plan.attemptId,
    workId: plan.workId,
    consumerActionId: plan.consumerActionId,
  });
  return {
    ...base,
    preparedContext,
    invocation,
    operationResultPath,
    definition,
    producer,
    consumer,
    plan,
    planPath,
  };
}

function restoreFiles(target: Map<string, Buffer>, source: Map<string, Buffer>) {
  target.clear();
  for (const [path, bytes] of source) target.set(path, Buffer.from(bytes));
}

function rebuildNativePlan(
  plan: ReturnType<typeof createProbeNativeActionPlan>,
  changes: Partial<{
    producerActionId: string;
    consumerActionId: string;
    operationId: string;
  }>,
) {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    campaignId: _campaignId,
    manifestSha256: _manifestSha256,
    runPlanSha256: _runPlanSha256,
    actionPlanSha256: _actionPlanSha256,
    ...input
  } = plan;
  return createProbeNativeActionPlan({ ...input, ...changes });
}

async function nativePlanFixtureHarness() {
  const loadedBootstrap = bootstrapFixture();
  const evidenceRoot = "C:\\probe-plan-evidence";
  const evidence = memoryStore(evidenceRoot);
  const inputs = nativePlanInputs(loadedBootstrap, evidenceRoot);
  evidence.seed(
    inputs.runtimeActionBinding.operationIntentPath,
    canonicalProbeJson(inputs.runtimeActionBinding.intent),
  );
  const exchange = vi.fn(
    async ({ request }: { request: ControllerRequest; payloadBytes: Uint8Array }) => {
      const result = {
        actionId: inputs.producer.actionId,
        commandEvent: null,
        evidenceArtifacts: [],
      };
      return successfulScenarioActionExchange(request, loadedBootstrap, inputs, result, [
        { path: inputs.planPath, bytes: Buffer.from(canonicalProbeJson(inputs.plan), "utf8") },
      ]);
    },
  );
  const transport = await createProbeControllerSpoolTransport({
    loadedBootstrap,
    resolveStore: vi.fn(async () => evidence.value),
    openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
    createSpoolClient: vi.fn(() => ({ exchange })),
  });
  const actionInput = {
    command: inputs.command,
    workItem: inputs.workItem,
    preparedContext: inputs.preparedContext,
    evidenceRoot,
    operationId: inputs.runtimeActionBinding.operationId,
    operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
    operationResultPath: inputs.operationResultPath,
    execution: getProbeActionMapping(inputs.invocation),
    invocation: inputs.invocation,
  } as const;
  const verificationOptions = {
    store: evidence.value,
    loadedBootstrap,
    campaignRunId: inputs.command.campaignRunId,
    executionRunId: inputs.preparedContext.executionRunId,
    attemptId: inputs.command.attemptId,
    workId: inputs.command.workId,
    environmentId: inputs.command.environmentId,
    pathProfileId: inputs.command.pathProfileId,
    rowId: inputs.command.rowId,
    variantId: inputs.command.variantId,
    consumerActionId: inputs.consumer.actionId,
  };
  return {
    loadedBootstrap,
    evidence,
    inputs,
    exchange,
    transport,
    actionInput,
    verificationOptions,
  };
}

async function retainedNativePlanFixture() {
  const fixture = await nativePlanFixtureHarness();
  const acknowledgment = await fixture.transport.invokeScenarioAction(fixture.actionInput as never);
  return { ...fixture, acknowledgment };
}

async function interruptedNativePlanFixture(failBeforeWriteIndex: number) {
  const fixture = await nativePlanFixtureHarness();
  fixture.evidence.failBeforeWrite(failBeforeWriteIndex);
  let failure: unknown;
  try {
    await fixture.transport.invokeScenarioAction(fixture.actionInput as never);
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) throw new Error("expected an injected retention crash");
  return { ...fixture, failure };
}

function hardCutInputs(loaded: LoadedProbeBootstrap, evidenceRoot: string, repetition = 3) {
  const workItem = PROBE_RUN_PLAN.work.find(
    ({ rowId, variantId, environmentId, pathProfileId }) =>
      rowId === "F-07" &&
      variantId === "f07-hard-cut-after-file-flush" &&
      environmentId === "win11-floor" &&
      pathProfileId === "ascii",
  );
  if (workItem === undefined) throw new Error("hard-cut work fixture is missing");
  const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
  const action = definition.actions.find(
    ({ actionId }) => actionId === `hard-cut-guest-r${repetition}`,
  );
  if (action === undefined) throw new Error("hard-cut action fixture is missing");
  const claim = claimFixture(loaded);
  const preparedContext = createPreparedContextFixture({
    campaignRunId: loaded.bootstrap.campaignRunId,
    executionRunId: "execution-hard-cut",
    executionBundleId: "bundle-hard-cut",
    attemptId: "attempt-hard-cut",
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    candidateSha256: loaded.candidate.candidateSha256,
    labAttestationSha256: loaded.attestations[0].attestationSha256,
    runPlanSha256: loaded.bootstrap.runPlanSha256,
    runAuthorizationSha256: loaded.runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: claim.receiptSha256,
    vmSnapshotId: "snapshot-hard-cut",
    bootIdSha256: sha256("hard-cut-prepared-boot"),
    runnerSessionIdSha256: sha256("hard-cut-runner"),
    evidenceRootObjectIdentitySha256: claim.evidenceRootObjectIdentitySha256,
    controller: loaded.attestations[0].controller,
    nativeHelper: {
      path: "bin/native-helper.exe",
      sha256: sha256("native-helper"),
      nativeCandidateDigest: sha256("native-candidate"),
      nativeManifestSha256: sha256("native-manifest"),
    },
    nsis: { path: "bin/nsis.exe", sha256: sha256("nsis") },
  });
  const command = {
    campaignRunId: loaded.bootstrap.campaignRunId,
    attemptId: preparedContext.attemptId,
    workId: workItem.workId,
    environmentId: workItem.environmentId,
    pathProfileId: workItem.pathProfileId,
    rowId: workItem.rowId,
    variantId: workItem.variantId,
    repetition,
    checkpointId: definition.continuation.checkpoint,
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
  const checkpointRequestFields = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-request" as const,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: loaded.candidate.candidateSha256,
    campaignRunId: command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    executionBundleId: preparedContext.executionBundleId,
    executionBundleManifestSha256: preparedContext.executionBundleManifestSha256,
    attemptId: command.attemptId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    checkpointId: definition.continuation.checkpoint,
    sequence: repetition,
    nonceSha256: sha256(`hard-cut-nonce:${repetition}`),
    preCutStateSha256: sha256(`hard-cut-pre-state:${repetition}`),
    preCutBootIdSha256: sha256(`hard-cut-pre-boot:${repetition}`),
    sourceVmSnapshotId: preparedContext.vmSnapshotId,
    continuationScopeSha256: sha256(`hard-cut-continuation:${repetition}`),
    controllerIdentitySha256: loaded.bootstrap.controllerSpool.identitySha256,
    controllerPublicKeySha256: loaded.bootstrap.controllerSpool.publicKeySha256,
    controllerVersion: loaded.bootstrap.controllerSpool.version,
    action: "hard-power-cut" as const,
    signatureAlgorithm: "Ed25519" as const,
  };
  const requestSha256 = deriveExternalCheckpointRequestDigest(checkpointRequestFields);
  const checkpointRequest = {
    ...checkpointRequestFields,
    signatureBase64: sign(
      null,
      Buffer.from(requestSha256, "hex"),
      controllerKeys.privateKey,
    ).toString("base64"),
    requestSha256,
  };
  const proofBytes = Buffer.from(`hard-cut-proof:${repetition}`, "utf8");
  const proof = {
    path: `${probeSegmentArtifactPaths(workItem).evidence}/hard-cut-r${repetition}.json`,
    sha256: sha256(proofBytes),
  };
  const checkpointReceiptFields = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-receipt" as const,
    requestSha256,
    controllerIdentitySha256: loaded.bootstrap.controllerSpool.identitySha256,
    controllerPublicKeySha256: loaded.bootstrap.controllerSpool.publicKeySha256,
    controllerVersion: loaded.bootstrap.controllerSpool.version,
    action: "hard-power-cut" as const,
    powerCutAt: "2026-08-07T01:00:00.000Z",
    bootStartedAt: "2026-08-07T01:00:01.000Z",
    bootCompletedAt: "2026-08-07T01:00:02.000Z",
    postBootVmSnapshotId: `snapshot-hard-cut-post-r${repetition}`,
    preCutBootIdSha256: checkpointRequest.preCutBootIdSha256,
    postBootBootIdSha256: sha256(`hard-cut-post-boot:${repetition}`),
    artifactHashes: [proof],
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveExternalCheckpointReceiptDigest(checkpointReceiptFields);
  const checkpointReceipt = {
    ...checkpointReceiptFields,
    signatureBase64: sign(
      null,
      Buffer.from(receiptSha256, "hex"),
      controllerKeys.privateKey,
    ).toString("base64"),
    receiptSha256,
  };
  const checkpointEvidence = { request: checkpointRequest, receipt: checkpointReceipt };
  const observerTranscript = createObserverTranscript(preparedContext);
  const observerBytes = Buffer.from(canonicalProbeJson(observerTranscript), "utf8");
  const observerPath = `${probeSegmentArtifactPaths(workItem).evidence}/native-transcripts/${observerTranscript.transcriptSha256}.json`;
  const actionResult = {
    actionId: action.actionId,
    commandEvent: null,
    evidenceArtifacts: [proof],
  };
  const resultBytes = Buffer.from(canonicalProbeJson(actionResult), "utf8");
  const coordinate = {
    campaignRunId: command.campaignRunId,
    executionRunId: preparedContext.executionRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    environmentId: command.environmentId,
    pathProfileId: command.pathProfileId,
    rowId: command.rowId,
    variantId: command.variantId,
    repetition,
  };
  const actionExecutionReceipt = createProbeControllerActionExecutionReceipt({
    candidateSha256: loaded.candidate.candidateSha256,
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
    execution: runtimeActionBinding.execution as never,
    expectedActor: runtimeActionBinding.expectedActor as never,
    actionResult,
    actionResultArtifact: {
      path: runtimeActionBinding.operationResultPath,
      sha256: sha256(resultBytes),
    },
    proofArtifacts: [proof],
    observerTranscripts: [
      {
        path: observerPath,
        sha256: sha256(observerBytes),
        transcriptSha256: observerTranscript.transcriptSha256,
      },
    ],
    brokerProof: null,
    pausedSessionReceipt: null,
    nativeActionPlans: [],
  });
  const artifacts = [
    { path: proof.path, bytes: proofBytes },
    { path: observerPath, bytes: observerBytes },
    { path: runtimeActionBinding.operationResultPath, bytes: resultBytes },
  ];
  const readInput = {
    command,
    workItem,
    preparedContext,
    attestation: loaded.attestations[0],
    request: checkpointRequest,
    dependencies: {},
    evidenceRoot,
  };
  return {
    workItem,
    definition,
    action,
    preparedContext,
    command,
    invocation,
    runtimeActionBinding,
    checkpointEvidence,
    actionExecutionReceipt,
    artifacts,
    readInput,
  };
}

async function retainedHardCutFixture(repetition = 3) {
  const loadedBootstrap = bootstrapFixture();
  const evidenceRoot = "C:\\probe-hard-cut-evidence";
  const evidence = memoryStore(evidenceRoot);
  const inputs = hardCutInputs(loadedBootstrap, evidenceRoot, repetition);
  const exchange = vi.fn(async ({ request }: { request: ControllerRequest }) =>
    successfulExchange(
      request,
      loadedBootstrap,
      {
        checkpointEvidence: inputs.checkpointEvidence,
        actionExecutionReceipt: inputs.actionExecutionReceipt,
      },
      inputs.artifacts,
    ),
  );
  const transport = await createProbeControllerSpoolTransport({
    loadedBootstrap,
    resolveStore: vi.fn(async () => evidence.value),
    openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
    createSpoolClient: vi.fn(() => ({ exchange })),
  });
  const result = await transport.readHardCutReceipt(inputs.readInput as never);
  return { loadedBootstrap, evidence, inputs, exchange, transport, result };
}

describe("probe controller spool transport", () => {
  it("opens only the fixed existing spool children and exposes the exact runtime surface", async () => {
    const loadedBootstrap = bootstrapFixture();
    const openedRoots: string[] = [];
    const openSpoolStore = vi.fn(async ({ root }: { root: string }) => {
      openedRoots.push(root);
      return store(root);
    });
    const createSpoolClient = vi.fn(() => ({ exchange: vi.fn() }));

    const transport = await createProbeControllerSpoolTransport({
      loadedBootstrap,
      resolveStore: vi.fn(),
      openSpoolStore,
      createSpoolClient,
    });

    expect(openedRoots).toEqual([
      win32.join(loadedBootstrap.bootstrap.controllerSpool.root, "guest-to-controller"),
      win32.join(loadedBootstrap.bootstrap.controllerSpool.root, "controller-to-guest"),
    ]);
    expect(Object.keys(transport).sort()).toEqual(
      [
        "abandonEvidenceQuiescence",
        "captureQuiescedEvidenceSeal",
        "claimHardCutRequest",
        "completeEvidenceQuiescence",
        "invokeScenarioAction",
        "observeCaptureDisposition",
        "observeController",
        "readHardCutReceipt",
        "recoverOrAcquireEvidenceQuiescence",
        "renewEvidenceQuiescence",
        "signSourceTranscriptReceipt",
        "verifyRunAuthorization",
        "verifyHardCutReceipt",
        "verifyScenarioActionReceipt",
      ].sort(),
    );
    expect(createSpoolClient).toHaveBeenCalledOnce();
  });

  it("rejects explicit-null spool factories before opening external state", async () => {
    const loadedBootstrap = bootstrapFixture();
    const resolveStore = vi.fn();
    const openSpoolStore = vi.fn();
    const createSpoolClient = vi.fn();

    await expect(
      createProbeControllerSpoolTransport({
        loadedBootstrap,
        resolveStore,
        openSpoolStore: null,
        createSpoolClient,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_FACTORY" });
    await expect(
      createProbeControllerSpoolTransport({
        loadedBootstrap,
        resolveStore,
        openSpoolStore,
        createSpoolClient: null,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_FACTORY" });
    expect(openSpoolStore).not.toHaveBeenCalled();
    expect(createSpoolClient).not.toHaveBeenCalled();
    expect(resolveStore).not.toHaveBeenCalled();
  });

  it("rejects accessor, hidden, and symbolic construction fields without evaluating them", async () => {
    const loadedBootstrap = bootstrapFixture();
    const openSpoolStore = vi.fn();
    const createSpoolClient = vi.fn();
    let accessorReads = 0;

    const accessor = {
      loadedBootstrap,
      resolveStore: vi.fn(),
      openSpoolStore,
      createSpoolClient,
    };
    Object.defineProperty(accessor, "resolveStore", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return vi.fn();
      },
    });

    const hidden = {
      loadedBootstrap,
      resolveStore: vi.fn(),
      openSpoolStore,
      createSpoolClient,
    };
    Object.defineProperty(hidden, "openSpoolStore", {
      enumerable: false,
      value: openSpoolStore,
    });

    const symbolic = {
      loadedBootstrap,
      resolveStore: vi.fn(),
      openSpoolStore,
      createSpoolClient,
    } as Record<PropertyKey, unknown>;
    symbolic[Symbol("unexpected-factory")] = vi.fn();

    for (const options of [accessor, hidden, symbolic]) {
      await expect(createProbeControllerSpoolTransport(options as never)).rejects.toMatchObject({
        code: "CONTROLLER_TRANSPORT_SCHEMA",
      });
    }
    expect(accessorReads).toBe(0);
    expect(openSpoolStore).not.toHaveBeenCalled();
    expect(createSpoolClient).not.toHaveBeenCalled();
  });

  it("maps all runtime methods to exact operations, coordinates, sequences, and claim authority", async () => {
    const loadedBootstrap = bootstrapFixture();
    const evidenceRoot = "C:\\probe-evidence";
    const evidence = memoryStore(evidenceRoot);
    const inputs = operationInputs(loadedBootstrap, evidenceRoot);
    evidence.seed(
      inputs.runtimeActionBinding.operationIntentPath,
      canonicalProbeJson(inputs.runtimeActionBinding.intent),
    );
    evidence.seed(
      `campaign/run-authorization-claims/${inputs.workItem.environmentId}.json`,
      canonicalProbeJson(inputs.claim),
    );
    const requests: ControllerRequest[] = [];
    const publicKeyBytes = Buffer.from(loadedBootstrap.controllerPublicKeySpkiDerBase64, "base64");
    const controllerEvidenceBytes = Buffer.from(
      `controller-evidence:${inputs.workItem.environmentId}`,
    );
    let scenarioEvidenceBytes = Buffer.from("scenario-evidence");
    let scenarioMode: "normal" | "escape" | "order" = "normal";
    const scenarioEvidencePath = `${probeSegmentArtifactPaths(inputs.workItem).evidence}/controller-observation.json`;
    const hardCutBytes = Buffer.from("hard-cut-evidence");
    const hardCutEvidence = {
      path: `${probeSegmentArtifactPaths(inputs.workItem).evidence}/hard-cut.json`,
      sha256: sha256(hardCutBytes),
    };
    const exchange = vi.fn(
      async ({
        request,
        payloadBytes,
      }: {
        request: ControllerRequest;
        payloadBytes: Uint8Array;
      }) => {
        requests.push(request);
        const decoded = decodeControllerOperationRequest(payloadBytes, {
          expectedOperationKind: request.operation.kind,
        });
        expect(decoded.envelope.input).not.toHaveProperty("evidenceRoot");
        if (
          new Set([
            "scenario-action",
            "capture-disposition-observation",
            "source-transcript-sign",
            "hard-cut-request-claim",
            "hard-cut-receipt-read",
          ]).has(request.operation.kind)
        ) {
          expect(decoded.envelope.input).toHaveProperty("preparedAuthority");
          expect(decoded.envelope.input).not.toHaveProperty("preparedContext");
          const wirePayload = canonicalProbeJson(decoded.envelope.input);
          expect(wirePayload).not.toContain("mailboxRoot");
          expect(wirePayload).not.toContain("journalRoot");
          expect(wirePayload).not.toMatch(/(?:[A-Za-z]:[\\/]|file:|^[/\\])/u);
        }
        if (request.operation.kind === "controller-observation") {
          const attestation = loadedBootstrap.attestations[0];
          return successfulExchange(
            request,
            loadedBootstrap,
            {
              identitySha256: loadedBootstrap.bootstrap.controllerSpool.identitySha256,
              publicKeySha256: loadedBootstrap.bootstrap.controllerSpool.publicKeySha256,
              version: loadedBootstrap.bootstrap.controllerSpool.version,
              controllerEvidence: attestation.controllerEvidence,
              publicKeyArtifact: attestation.controller.publicKeyArtifact,
            },
            [
              { path: attestation.controllerEvidence.path, bytes: controllerEvidenceBytes },
              { path: attestation.controller.publicKeyArtifact.path, bytes: publicKeyBytes },
            ],
          );
        }
        if (request.operation.kind === "scenario-action") {
          if (scenarioMode === "order") {
            const firstBytes = Buffer.from("first");
            const secondBytes = Buffer.from("second");
            const firstReference = contentReference(firstBytes);
            const secondReference = contentReference(secondBytes);
            const signed = [
              { reference: firstReference, bytes: firstBytes },
              { reference: secondReference, bytes: secondBytes },
            ].sort((left, right) =>
              Buffer.from(left.reference.sha256).compare(Buffer.from(right.reference.sha256)),
            );
            const payloadBytes = Buffer.from(
              canonicalProbeJson({
                schemaVersion: 1,
                kind: "windows-host-probe-controller-operation-response",
                operationKind: request.operation.kind,
                result: {
                  actionId: inputs.invocation.action.actionId,
                  commandEvent: null,
                  evidenceArtifacts: [],
                },
                artifactBindings: [
                  { path: "z/artifact", sha256: firstReference.sha256 },
                  { path: "a/artifact", sha256: secondReference.sha256 },
                ],
              }),
            );
            return signedExchange(request, loadedBootstrap, payloadBytes, signed);
          }
          if (scenarioMode === "escape") {
            const escapedBytes = Buffer.from("escaped");
            const escapedReference = contentReference(escapedBytes);
            const payloadBytes = Buffer.from(
              canonicalProbeJson({
                schemaVersion: 1,
                kind: "windows-host-probe-controller-operation-response",
                operationKind: request.operation.kind,
                result: {
                  actionId: inputs.invocation.action.actionId,
                  commandEvent: null,
                  evidenceArtifacts: [{ path: "../escape", sha256: escapedReference.sha256 }],
                },
                artifactBindings: [{ path: "../escape", sha256: escapedReference.sha256 }],
              }),
            );
            return signedExchange(request, loadedBootstrap, payloadBytes, [
              { reference: escapedReference, bytes: escapedBytes },
            ]);
          }
          const scenarioEvidence = {
            path: scenarioEvidencePath,
            sha256: sha256(scenarioEvidenceBytes),
          };
          const result = {
            actionId: inputs.invocation.action.actionId,
            commandEvent: null,
            evidenceArtifacts: [scenarioEvidence],
          };
          return successfulScenarioActionExchange(request, loadedBootstrap, inputs, result, [
            { path: scenarioEvidence.path, bytes: scenarioEvidenceBytes },
          ]);
        }
        if (request.operation.kind === "hard-cut-receipt-read") {
          return successfulExchange(
            request,
            loadedBootstrap,
            {
              checkpointEvidence: {
                receipt: { artifactHashes: [hardCutEvidence] },
              },
              hardCutActionResult: { evidenceArtifacts: [hardCutEvidence] },
            },
            [{ path: hardCutEvidence.path, bytes: hardCutBytes }],
          );
        }
        return successfulExchange(request, loadedBootstrap, {
          operationKind: request.operation.kind,
        });
      },
    );
    const createSpoolClient = vi.fn(() => ({ exchange }));
    const transport = await createProbeControllerSpoolTransport({
      loadedBootstrap,
      resolveStore: vi.fn(async () => evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient,
    });
    const work = {
      command: inputs.command,
      workItem: inputs.workItem,
      preparedContext: inputs.preparedContext,
      evidenceRoot,
    };

    await transport.verifyRunAuthorization({
      runAuthorization: loadedBootstrap.runAuthorization,
      request: inputs.request,
      candidateSha256: loadedBootstrap.candidate.candidateSha256,
      campaignRunId: loadedBootstrap.bootstrap.campaignRunId,
      attestations: loadedBootstrap.attestations,
      currentAttestation: loadedBootstrap.attestations[0],
      evidenceRootObjectIdentitySha256: sha256("evidence-root-object"),
      evidenceRoot,
    });
    await transport.observeController({ request: inputs.request, evidenceRoot });
    await transport.recoverOrAcquireEvidenceQuiescence({
      finalizationIntent: inputs.finalizationIntent,
      evidenceRoot,
    } as never);
    await transport.renewEvidenceQuiescence({
      finalizationIntent: inputs.finalizationIntent,
      previousLeaseReceipt: { renewalSequence: 4 },
      purpose: "capture",
      evidenceRoot,
    } as never);
    await transport.captureQuiescedEvidenceSeal({
      binding: { finalizationIntent: inputs.finalizationIntent },
      evidenceRoot,
    } as never);
    await transport.completeEvidenceQuiescence({
      finalizationIntent: inputs.finalizationIntent,
      evidenceRoot,
    } as never);
    await transport.abandonEvidenceQuiescence({
      finalizationIntent: inputs.finalizationIntent,
      evidenceRoot,
    } as never);
    const acknowledgment = await transport.invokeScenarioAction({
      ...work,
      operationId: inputs.runtimeActionBinding.operationId,
      operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
      operationResultPath: inputs.operationResultPath,
      execution: getProbeActionMapping(inputs.invocation),
      invocation: inputs.invocation,
    } as never);
    await transport.observeCaptureDisposition(work as never);
    await transport.signSourceTranscriptReceipt({
      ...work,
      receiptSha256: sha256("receipt"),
    } as never);
    await transport.claimHardCutRequest(work as never);

    expect(requests.map(({ operation }) => operation.kind)).toEqual([
      "run-authorization-claim",
      "controller-observation",
      "evidence-quiescence-acquire",
      "evidence-quiescence-renew",
      "evidence-quiescence-capture",
      "evidence-quiescence-complete",
      "evidence-quiescence-abandon",
      "scenario-action",
      "capture-disposition-observation",
      "source-transcript-sign",
      "hard-cut-request-claim",
    ]);
    expect(requests.slice(0, 2).map(({ coordinate }) => coordinate.workId)).toEqual([null, null]);
    expect(requests.slice(2).map(({ coordinate }) => coordinate.workId)).toEqual(
      Array(9).fill(inputs.workItem.workId),
    );
    expect(requests.map(({ coordinate }) => coordinate.repetition)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      3,
      null,
      null,
      3,
    ]);
    expect(requests.map(({ operation }) => operation.sequence)).toEqual([
      1, 1, 1, 5, 1, 1, 1, 1, 1, 1, 3,
    ]);
    expect(requests[0].runAuthorizationClaimSha256).toBeNull();
    expect(
      requests
        .slice(1)
        .every((request) => request.runAuthorizationClaimSha256 === inputs.claim.receiptSha256),
    ).toBe(true);
    expect(requests[7].operation.operationId).toBe(inputs.runtimeActionBinding.operationId);
    expect(acknowledgment.operationId).toBe(inputs.runtimeActionBinding.operationId);
    expect(evidence.writes.indexOf(scenarioEvidencePath)).toBeLessThan(
      evidence.writes.indexOf(inputs.operationResultPath),
    );
    expect(createSpoolClient.mock.calls[0][0]).toMatchObject({
      controllerIdentitySha256: loadedBootstrap.bootstrap.controllerSpool.identitySha256,
      controllerVersion: loadedBootstrap.bootstrap.controllerSpool.version,
    });
    expect(Buffer.from(createSpoolClient.mock.calls[0][0].controllerPublicKeyBytes)).toEqual(
      publicKeyBytes,
    );

    const firstSign = requests[9];
    await transport.signSourceTranscriptReceipt({
      ...work,
      receiptSha256: sha256("changed-payload"),
    } as never);
    const changedSign = requests.at(-1)!;
    expect(changedSign.operation.operationId).toBe(firstSign.operation.operationId);
    expect(changedSign.intentSha256).not.toBe(firstSign.intentSha256);

    await expect(
      transport.invokeScenarioAction({
        ...work,
        operationId: inputs.runtimeActionBinding.operationId,
        operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
        operationResultPath: inputs.operationResultPath,
        execution: getProbeActionMapping(inputs.invocation),
        invocation: inputs.invocation,
      } as never),
    ).resolves.toEqual(acknowledgment);
    scenarioEvidenceBytes = Buffer.from("conflicting-scenario-evidence");
    await expect(
      transport.invokeScenarioAction({
        ...work,
        operationId: inputs.runtimeActionBinding.operationId,
        operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
        operationResultPath: inputs.operationResultPath,
        execution: getProbeActionMapping(inputs.invocation),
        invocation: inputs.invocation,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_COLLISION" });
    scenarioMode = "escape";
    await expect(
      transport.invokeScenarioAction({
        ...work,
        operationId: inputs.runtimeActionBinding.operationId,
        operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
        operationResultPath: inputs.operationResultPath,
        execution: getProbeActionMapping(inputs.invocation),
        invocation: inputs.invocation,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_PATH" });
    scenarioMode = "order";
    await expect(
      transport.invokeScenarioAction({
        ...work,
        operationId: inputs.runtimeActionBinding.operationId,
        operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
        operationResultPath: inputs.operationResultPath,
        execution: getProbeActionMapping(inputs.invocation),
        invocation: inputs.invocation,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_ORDER" });

    const restarted = await createProbeControllerSpoolTransport({
      loadedBootstrap,
      resolveStore: vi.fn(async () => evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient,
    });
    await restarted.observeController({ request: inputs.request, evidenceRoot });
    expect(requests.at(-1)?.runAuthorizationClaimSha256).toBe(inputs.claim.receiptSha256);
  });

  it("retains a signed hard-cut action authority and verifies it offline without exchange", async () => {
    const fixture = await retainedHardCutFixture();
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.action.actionId,
    });
    const provenance = JSON.parse(
      Buffer.from(fixture.evidence.files.get(paths.provenance)!).toString("utf8"),
    );
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.action.actionId,
    });
    expect(Object.isFrozen(fixture.result)).toBe(true);
    expect(Object.isFrozen(fixture.result.checkpointEvidence)).toBe(true);
    expect(Object.isFrozen(fixture.result.actionExecutionReceipt)).toBe(true);
    expect(Object.isFrozen(fixture.result.actionAcknowledgment)).toBe(true);
    expect(fixture.result).toEqual({
      checkpointEvidence: fixture.inputs.checkpointEvidence,
      actionExecutionReceipt: fixture.inputs.actionExecutionReceipt,
      actionAcknowledgment: {
        operationId: fixture.inputs.runtimeActionBinding.operationId,
        resultSha256: fixture.inputs.actionExecutionReceipt.actionResultArtifact.sha256,
        receiptSha256: fixture.inputs.actionExecutionReceipt.receiptSha256,
        provenanceSha256: provenance.provenanceSha256,
        actionAttestationSha256: null,
        primaryObserverTranscriptSha256s:
          fixture.inputs.actionExecutionReceipt.observerTranscripts.map(
            ({ transcriptSha256 }) => transcriptSha256,
          ),
      },
    });
    expect(fixture.evidence.writes.at(-1)).toBe(commitPath);
    const ordered = [
      fixture.inputs.actionExecutionReceipt.proofArtifacts[0].path,
      fixture.inputs.actionExecutionReceipt.observerTranscripts[0].path,
      paths.controllerRequest,
      paths.operationRequest,
      paths.controllerResponse,
      paths.operationResponse,
      paths.receipt,
      paths.provenance,
      fixture.inputs.runtimeActionBinding.operationResultPath,
      commitPath,
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(fixture.evidence.writes.indexOf(ordered[index - 1])).toBeLessThan(
        fixture.evidence.writes.indexOf(ordered[index]),
      );
    }
    expect(fixture.exchange).toHaveBeenCalledOnce();
    const offlineExchange = vi.fn();
    const offline = await createProbeControllerSpoolTransport({
      loadedBootstrap: fixture.loadedBootstrap,
      resolveStore: vi.fn(async () => fixture.evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient: vi.fn(() => ({ exchange: offlineExchange })),
    });
    await expect(offline.verifyHardCutReceipt(fixture.inputs.readInput as never)).resolves.toEqual(
      fixture.result,
    );
    expect(offlineExchange).not.toHaveBeenCalled();
  });

  it("rejects signed hard-cut legacy results, checkpoint mismatches, wrong actions, and inexact artifacts", async () => {
    const loadedBootstrap = bootstrapFixture();
    const evidenceRoot = "C:\\probe-hard-cut-attacks";
    const trusted = hardCutInputs(loadedBootstrap, evidenceRoot, 3);
    const otherRepetition = hardCutInputs(loadedBootstrap, evidenceRoot, 2);
    const extraBytes = Buffer.from("extra-hard-cut-artifact", "utf8");
    const mismatchedProof = {
      path: `${probeSegmentArtifactPaths(trusted.workItem).evidence}/mismatched-proof.json`,
      sha256: sha256(extraBytes),
    };
    const mismatchedActionResult = {
      ...trusted.actionExecutionReceipt.actionResult,
      evidenceArtifacts: [mismatchedProof],
    };
    const mismatchedResultBytes = Buffer.from(canonicalProbeJson(mismatchedActionResult), "utf8");
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      campaignId: _campaignId,
      manifestSha256: _manifestSha256,
      runPlanSha256: _runPlanSha256,
      receiptSha256: _receiptSha256,
      ...trustedReceiptInput
    } = trusted.actionExecutionReceipt;
    const mismatchedProofReceipt = createProbeControllerActionExecutionReceipt({
      ...trustedReceiptInput,
      actionResult: mismatchedActionResult,
      actionResultArtifact: {
        path: trusted.runtimeActionBinding.operationResultPath,
        sha256: sha256(mismatchedResultBytes),
      },
      proofArtifacts: [mismatchedProof],
    });
    const observerArtifact = trusted.artifacts.find(
      ({ path }) => path === trusted.actionExecutionReceipt.observerTranscripts[0].path,
    )!;
    const attacks = [
      {
        result: {
          checkpointEvidence: trusted.checkpointEvidence,
          hardCutActionResult: trusted.actionExecutionReceipt.actionResult,
        },
        artifacts: trusted.artifacts,
      },
      {
        result: {
          checkpointEvidence: otherRepetition.checkpointEvidence,
          actionExecutionReceipt: trusted.actionExecutionReceipt,
        },
        artifacts: trusted.artifacts,
      },
      {
        result: {
          checkpointEvidence: trusted.checkpointEvidence,
          actionExecutionReceipt: otherRepetition.actionExecutionReceipt,
        },
        artifacts: otherRepetition.artifacts,
      },
      {
        result: {
          checkpointEvidence: trusted.checkpointEvidence,
          actionExecutionReceipt: trusted.actionExecutionReceipt,
        },
        artifacts: trusted.artifacts.slice(0, -1),
      },
      {
        result: {
          checkpointEvidence: trusted.checkpointEvidence,
          actionExecutionReceipt: trusted.actionExecutionReceipt,
        },
        artifacts: [
          ...trusted.artifacts,
          {
            path: `${probeSegmentArtifactPaths(trusted.workItem).evidence}/extra.json`,
            bytes: extraBytes,
          },
        ],
      },
      {
        result: {
          checkpointEvidence: trusted.checkpointEvidence,
          actionExecutionReceipt: mismatchedProofReceipt,
        },
        artifacts: [
          { path: mismatchedProof.path, bytes: extraBytes },
          observerArtifact,
          { path: trusted.runtimeActionBinding.operationResultPath, bytes: mismatchedResultBytes },
        ],
      },
    ];
    for (const attack of attacks) {
      const evidence = memoryStore(evidenceRoot);
      const exchange = vi.fn(async ({ request }: { request: ControllerRequest }) =>
        successfulExchange(request, loadedBootstrap, attack.result, attack.artifacts),
      );
      const transport = await createProbeControllerSpoolTransport({
        loadedBootstrap,
        resolveStore: vi.fn(async () => evidence.value),
        openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
        createSpoolClient: vi.fn(() => ({ exchange })),
      });
      await expect(transport.readHardCutReceipt(trusted.readInput as never)).rejects.toBeDefined();
      expect(exchange).toHaveBeenCalledOnce();
      expect(evidence.files.has(trusted.runtimeActionBinding.operationResultPath)).toBe(false);
    }
  });

  it("offline hard-cut verification rejects planted results, every changed raw record, equivocation, and cross-repetition swaps", async () => {
    const fixture = await retainedHardCutFixture(3);
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.action.actionId,
    });
    const baseline = new Map(
      [...fixture.evidence.files].map(([path, bytes]) => [path, Buffer.from(bytes)]),
    );
    const exchangeCount = fixture.exchange.mock.calls.length;
    const expectRejected = async () => {
      await expect(
        fixture.transport.verifyHardCutReceipt(fixture.inputs.readInput as never),
      ).rejects.toBeDefined();
      expect(fixture.exchange).toHaveBeenCalledTimes(exchangeCount);
      restoreFiles(fixture.evidence.files, baseline);
    };

    fixture.evidence.files.delete(paths.provenance);
    await expectRejected();

    for (const path of [
      paths.controllerRequest,
      paths.operationRequest,
      paths.controllerResponse,
      paths.operationResponse,
    ]) {
      fixture.evidence.files.set(path, Buffer.from(`tampered:${path}`, "utf8"));
      await expectRejected();
    }

    const other = hardCutInputs(fixture.loadedBootstrap, fixture.evidence.value.root, 2);
    fixture.evidence.files.set(
      paths.receipt,
      Buffer.from(canonicalProbeJson(other.actionExecutionReceipt), "utf8"),
    );
    await expectRejected();

    const retainedRequest = JSON.parse(
      Buffer.from(baseline.get(paths.controllerRequest)!).toString("utf8"),
    ) as ControllerRequest;
    const equivocatedProofBytes = Buffer.from("equivocated-hard-cut-proof", "utf8");
    const equivocatedProof = {
      path: `${probeSegmentArtifactPaths(fixture.inputs.workItem).evidence}/equivocated-hard-cut-proof.json`,
      sha256: sha256(equivocatedProofBytes),
    };
    const {
      signatureBase64: _checkpointSignatureBase64,
      receiptSha256: _checkpointReceiptSha256,
      ...checkpointReceiptFields
    } = fixture.inputs.checkpointEvidence.receipt;
    const equivocatedCheckpointFields = {
      ...checkpointReceiptFields,
      artifactHashes: [equivocatedProof],
    };
    const equivocatedCheckpointSha256 = deriveExternalCheckpointReceiptDigest(
      equivocatedCheckpointFields,
    );
    const equivocatedCheckpointReceipt = {
      ...equivocatedCheckpointFields,
      signatureBase64: sign(
        null,
        Buffer.from(equivocatedCheckpointSha256, "hex"),
        controllerKeys.privateKey,
      ).toString("base64"),
      receiptSha256: equivocatedCheckpointSha256,
    };
    const equivocatedActionResult = {
      ...fixture.inputs.actionExecutionReceipt.actionResult,
      evidenceArtifacts: [equivocatedProof],
    };
    const equivocatedResultBytes = Buffer.from(canonicalProbeJson(equivocatedActionResult), "utf8");
    const {
      schemaVersion: _actionSchemaVersion,
      kind: _actionKind,
      campaignId: _actionCampaignId,
      manifestSha256: _actionManifestSha256,
      runPlanSha256: _actionRunPlanSha256,
      receiptSha256: _actionReceiptSha256,
      ...actionReceiptInput
    } = fixture.inputs.actionExecutionReceipt;
    const equivocatedActionReceipt = createProbeControllerActionExecutionReceipt({
      ...actionReceiptInput,
      actionResult: equivocatedActionResult,
      actionResultArtifact: {
        path: fixture.inputs.runtimeActionBinding.operationResultPath,
        sha256: sha256(equivocatedResultBytes),
      },
      proofArtifacts: [equivocatedProof],
    });
    const observerArtifact = fixture.inputs.artifacts.find(
      ({ path }) => path === fixture.inputs.actionExecutionReceipt.observerTranscripts[0].path,
    )!;
    const equivocated = successfulExchange(
      retainedRequest,
      fixture.loadedBootstrap,
      {
        checkpointEvidence: {
          request: fixture.inputs.checkpointEvidence.request,
          receipt: equivocatedCheckpointReceipt,
        },
        actionExecutionReceipt: equivocatedActionReceipt,
      },
      [
        { path: equivocatedProof.path, bytes: equivocatedProofBytes },
        observerArtifact,
        {
          path: fixture.inputs.runtimeActionBinding.operationResultPath,
          bytes: equivocatedResultBytes,
        },
      ],
    );
    fixture.evidence.files.set(
      paths.controllerResponse,
      Buffer.from(canonicalProbeJson(equivocated.response), "utf8"),
    );
    fixture.evidence.files.set(paths.operationResponse, Buffer.from(equivocated.payloadBytes));
    await expectRejected();
  });

  it("rejects controller-signed receipts with substituted trusted bindings or observer semantics", async () => {
    const loadedBootstrap = bootstrapFixture();
    const evidenceRoot = "C:\\probe-receipt-attacks";
    const evidence = memoryStore(evidenceRoot);
    const inputs = operationInputs(loadedBootstrap, evidenceRoot);
    evidence.seed(
      inputs.runtimeActionBinding.operationIntentPath,
      canonicalProbeJson(inputs.runtimeActionBinding.intent),
    );
    let mode: "receipt" | "observer" | "handshake-only" = "receipt";
    const exchange = vi.fn(async ({ request }: { request: ControllerRequest }) =>
      successfulScenarioActionExchange(
        request,
        loadedBootstrap,
        inputs,
        {
          actionId: inputs.invocation.action.actionId,
          commandEvent: null,
          evidenceArtifacts: [],
        },
        [],
        mode === "receipt"
          ? { receiptCandidateSha256: sha256("substituted-candidate") }
          : mode === "observer"
            ? { observerCandidateSha256: sha256("substituted-observer-candidate") }
            : { observerWithoutCommand: true },
      ),
    );
    const transport = await createProbeControllerSpoolTransport({
      loadedBootstrap,
      resolveStore: vi.fn(async () => evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient: vi.fn(() => ({ exchange })),
    });
    const input = {
      command: inputs.command,
      workItem: inputs.workItem,
      preparedContext: inputs.preparedContext,
      evidenceRoot,
      operationId: inputs.runtimeActionBinding.operationId,
      operationIntentPath: inputs.runtimeActionBinding.operationIntentPath,
      operationResultPath: inputs.operationResultPath,
      execution: inputs.runtimeActionBinding.execution,
      invocation: inputs.invocation,
    };

    await expect(transport.invokeScenarioAction(input as never)).rejects.toMatchObject({
      code: "CONTROLLER_TRANSPORT_SCENARIO_RECEIPT",
    });
    mode = "observer";
    await expect(transport.invokeScenarioAction(input as never)).rejects.toMatchObject({
      code: "CONTROLLER_TRANSPORT_OBSERVER",
    });
    mode = "handshake-only";
    await expect(transport.invokeScenarioAction(input as never)).rejects.toMatchObject({
      code: "CONTROLLER_ACTION_COMMAND_BINDING",
    });
    expect(evidence.writes).toEqual([]);
  });

  it("retains controller-bound native plans with deterministic restart-verifiable provenance", async () => {
    const fixture = await retainedNativePlanFixture();
    const actionPaths = probeControllerActionProvenancePaths({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.producer.actionId,
    });
    const receipt = JSON.parse(
      Buffer.from(fixture.evidence.files.get(actionPaths.receipt)!).toString("utf8"),
    );
    const actionProvenance = JSON.parse(
      Buffer.from(fixture.evidence.files.get(actionPaths.provenance)!).toString("utf8"),
    );
    const actionAttestationPath = probeControllerActionAttestationPath({
      coordinate: receipt.coordinate,
      producerActionId: receipt.producerActionId,
    });
    const actionAttestation = JSON.parse(
      Buffer.from(fixture.evidence.files.get(actionAttestationPath)!).toString("utf8"),
    );
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.producer.actionId,
    });
    expect(commitPath).toBe(
      `runtime/work/${fixture.inputs.command.campaignRunId}/${fixture.inputs.command.attemptId}/${fixture.inputs.command.workId}/action-provenance/${fixture.inputs.producer.actionId}.commit.json`,
    );
    expect(fixture.evidence.files.has(fixture.inputs.planPath)).toBe(true);
    expect(fixture.evidence.files.has(commitPath)).toBe(true);
    const legacyPlanStem = fixture.inputs.planPath.slice(0, -".json".length);
    for (const suffix of [
      ".provenance.json",
      ".controller-request.json",
      ".operation-request.json",
      ".controller-response.json",
      ".operation-response.json",
    ]) {
      expect(fixture.evidence.files.has(`${legacyPlanStem}${suffix}`)).toBe(false);
    }
    expect(Object.isFrozen(fixture.acknowledgment)).toBe(true);
    expect(Object.isFrozen(fixture.acknowledgment.primaryObserverTranscriptSha256s)).toBe(true);
    expect(fixture.acknowledgment).toEqual({
      operationId: fixture.inputs.runtimeActionBinding.operationId,
      resultSha256: receipt.actionResultArtifact.sha256,
      receiptSha256: receipt.receiptSha256,
      provenanceSha256: actionProvenance.provenanceSha256,
      actionAttestationSha256: actionAttestation.attestationSha256,
      primaryObserverTranscriptSha256s: receipt.observerTranscripts.map(
        ({ transcriptSha256 }: { transcriptSha256: string }) => transcriptSha256,
      ),
    });
    expect(fixture.evidence.writes.at(-1)).toBe(commitPath);
    const orderedSignedArtifacts = [
      ...receipt.proofArtifacts.map(({ path }: { path: string }) => path),
      ...receipt.observerTranscripts.map(({ path }: { path: string }) => path),
    ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const orderedActionPaths = [
      ...orderedSignedArtifacts,
      actionPaths.controllerRequest,
      actionPaths.operationRequest,
      actionPaths.controllerResponse,
      actionPaths.operationResponse,
      actionPaths.receipt,
      actionPaths.provenance,
      fixture.inputs.planPath,
      fixture.inputs.operationResultPath,
      commitPath,
    ];
    for (let index = 1; index < orderedActionPaths.length; index += 1) {
      expect(fixture.evidence.writes.indexOf(orderedActionPaths[index - 1])).toBeLessThan(
        fixture.evidence.writes.indexOf(orderedActionPaths[index]),
      );
    }
    const verified = await readVerifiedControllerNativeActionPlan(fixture.verificationOptions);
    expect(verified.plan).toEqual(fixture.inputs.plan);
    expect(verified.executionReceipt.nativeActionPlans).toContainEqual({
      path: fixture.inputs.planPath,
      sha256: sha256(canonicalProbeJson(fixture.inputs.plan)),
    });
    expect(verified.commit.artifacts).toContainEqual({
      path: fixture.inputs.planPath,
      bytes: Buffer.byteLength(canonicalProbeJson(fixture.inputs.plan)),
      sha256: sha256(canonicalProbeJson(fixture.inputs.plan)),
    });
    expect(verified.response.signatureBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(verified.operationRequest.input.invocation.action).toEqual(fixture.inputs.producer);
    expect(verified.operationResponse.artifactBindings).toContainEqual({
      path: fixture.inputs.planPath,
      sha256: sha256(canonicalProbeJson(fixture.inputs.plan)),
    });

    const offlineExchange = vi.fn();
    const offlineRestart = await createProbeControllerSpoolTransport({
      loadedBootstrap: fixture.loadedBootstrap,
      resolveStore: vi.fn(async () => fixture.evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient: vi.fn(() => ({ exchange: offlineExchange })),
    });
    await expect(
      offlineRestart.verifyScenarioActionReceipt(fixture.actionInput as never),
    ).resolves.toEqual(fixture.acknowledgment);
    expect(offlineExchange).not.toHaveBeenCalled();

    const restarted = await createProbeControllerSpoolTransport({
      loadedBootstrap: fixture.loadedBootstrap,
      resolveStore: vi.fn(async () => fixture.evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient: vi.fn(() => ({ exchange: fixture.exchange })),
    });
    await expect(
      restarted.invokeScenarioAction({
        command: fixture.inputs.command,
        workItem: fixture.inputs.workItem,
        preparedContext: fixture.inputs.preparedContext,
        evidenceRoot: fixture.evidence.value.root,
        operationId: fixture.inputs.runtimeActionBinding.operationId,
        operationIntentPath: fixture.inputs.runtimeActionBinding.operationIntentPath,
        operationResultPath: fixture.inputs.operationResultPath,
        execution: getProbeActionMapping(fixture.inputs.invocation),
        invocation: fixture.inputs.invocation,
      } as never),
    ).resolves.toEqual(fixture.acknowledgment);
    await expect(
      readVerifiedControllerNativeActionPlan(fixture.verificationOptions),
    ).resolves.toMatchObject({ plan: fixture.inputs.plan });
  });

  it("publishes the action commit last and repairs every interrupted boundary by exact replay", async () => {
    const baseline = await retainedNativePlanFixture();
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: baseline.inputs.command.campaignRunId,
      attemptId: baseline.inputs.command.attemptId,
      workId: baseline.inputs.command.workId,
      producerActionId: baseline.inputs.producer.actionId,
    });
    expect(baseline.evidence.writes.at(-1)).toBe(commitPath);

    for (let index = 0; index < baseline.evidence.writes.length; index += 1) {
      const interrupted = await interruptedNativePlanFixture(index);
      expect(interrupted.evidence.files.has(commitPath)).toBe(false);
      await expect(
        interrupted.transport.verifyScenarioActionReceipt(interrupted.actionInput as never),
      ).rejects.toMatchObject({ code: PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE });
      await expect(
        readVerifiedControllerNativeActionPlan(interrupted.verificationOptions),
      ).rejects.toMatchObject({ code: PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE });

      interrupted.evidence.failBeforeWrite(null);
      await expect(
        interrupted.transport.invokeScenarioAction(interrupted.actionInput as never),
      ).resolves.toEqual(baseline.acknowledgment);
      expect(interrupted.exchange).toHaveBeenCalledTimes(2);
      expect(interrupted.evidence.files.has(commitPath)).toBe(true);
      expect(interrupted.evidence.writes.at(-1)).toBe(commitPath);
    }
  });

  it("rejects a native plan with a noncanonical consumer operation before action commit", async () => {
    const fixture = await nativePlanFixtureHarness();
    const invalidPlan = rebuildNativePlan(fixture.inputs.plan, {
      operationId: "operation-substituted",
    });
    fixture.exchange.mockImplementationOnce(async ({ request }: { request: ControllerRequest }) =>
      successfulScenarioActionExchange(
        request,
        fixture.loadedBootstrap,
        fixture.inputs,
        {
          actionId: fixture.inputs.producer.actionId,
          commandEvent: null,
          evidenceArtifacts: [],
        },
        [
          {
            path: fixture.inputs.planPath,
            bytes: Buffer.from(canonicalProbeJson(invalidPlan), "utf8"),
          },
        ],
      ),
    );

    await expect(
      fixture.transport.invokeScenarioAction(fixture.actionInput as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_PROVENANCE" });
    expect(fixture.evidence.writes).toEqual([]);
  });

  it("rejects missing or substituted scenario execution mappings before exchange", async () => {
    const fixture = await retainedNativePlanFixture();
    const expected = getProbeActionMapping(fixture.inputs.invocation);
    const base = {
      command: fixture.inputs.command,
      workItem: fixture.inputs.workItem,
      preparedContext: fixture.inputs.preparedContext,
      evidenceRoot: fixture.evidence.value.root,
      operationId: fixture.inputs.runtimeActionBinding.operationId,
      operationIntentPath: fixture.inputs.runtimeActionBinding.operationIntentPath,
      operationResultPath: fixture.inputs.operationResultPath,
      invocation: fixture.inputs.invocation,
    };
    const exchangeCount = fixture.exchange.mock.calls.length;

    await expect(fixture.transport.invokeScenarioAction(base as never)).rejects.toMatchObject({
      code: "CONTROLLER_TRANSPORT_SCENARIO",
    });
    await expect(
      fixture.transport.invokeScenarioAction({
        ...base,
        execution: { ...expected, driverId: `${expected.driverId}-substituted` },
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_SCENARIO" });
    await expect(
      fixture.transport.invokeScenarioAction({
        ...base,
        execution: expected,
        invocation: {
          ...fixture.inputs.invocation,
          action: {
            ...fixture.inputs.invocation.action,
            parameters: { substituted: true },
          },
        },
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_SCENARIO" });
    await expect(
      fixture.transport.invokeScenarioAction({
        ...base,
        execution: expected,
        invocation: { ...fixture.inputs.invocation, planSha256: sha256("substituted-plan") },
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_SCENARIO" });
    for (const substitution of [
      { operationId: "operation-substituted" },
      { operationIntentPath: "runtime/work/substituted-intent.json" },
      { operationResultPath: "runtime/work/substituted-result.json" },
    ]) {
      await expect(
        fixture.transport.invokeScenarioAction({
          ...base,
          ...substitution,
          execution: expected,
        } as never),
      ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_SCENARIO" });
    }
    const substitutedWorkId = "work-substituted";
    await expect(
      fixture.transport.invokeScenarioAction({
        ...base,
        command: { ...fixture.inputs.command, workId: substitutedWorkId },
        workItem: { ...fixture.inputs.workItem, workId: substitutedWorkId },
        operationResultPath: [
          "runtime",
          "work",
          fixture.inputs.command.campaignRunId,
          fixture.inputs.command.attemptId,
          substitutedWorkId,
          "action-results",
          `${fixture.inputs.invocation.action.actionId}.json`,
        ].join("/"),
        execution: expected,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_COORDINATE" });

    fixture.evidence.files.set(
      fixture.inputs.runtimeActionBinding.operationIntentPath,
      Buffer.from(
        canonicalProbeJson({
          ...fixture.inputs.runtimeActionBinding.intent,
          operationId: "operation-substituted",
        }),
        "utf8",
      ),
    );
    await expect(
      fixture.transport.invokeScenarioAction({
        ...base,
        execution: expected,
      } as never),
    ).rejects.toMatchObject({ code: "CONTROLLER_TRANSPORT_SCENARIO" });
    expect(fixture.exchange).toHaveBeenCalledTimes(exchangeCount);
  });

  it("rejects stateful operation input accessors without reading or exchanging them", async () => {
    const fixture = await retainedNativePlanFixture();
    const expected = getProbeActionMapping(fixture.inputs.invocation);
    const input = {
      command: fixture.inputs.command,
      workItem: fixture.inputs.workItem,
      preparedContext: fixture.inputs.preparedContext,
      evidenceRoot: fixture.evidence.value.root,
      operationId: fixture.inputs.runtimeActionBinding.operationId,
      operationIntentPath: fixture.inputs.runtimeActionBinding.operationIntentPath,
      operationResultPath: fixture.inputs.operationResultPath,
      invocation: fixture.inputs.invocation,
      execution: expected,
    };
    let accessorReads = 0;
    Object.defineProperty(input, "execution", {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        return accessorReads === 1
          ? expected
          : { ...expected, driverId: `${expected.driverId}-substituted` };
      },
    });
    const exchangeCount = fixture.exchange.mock.calls.length;

    await expect(fixture.transport.invokeScenarioAction(input as never)).rejects.toMatchObject({
      code: "CONTROLLER_TRANSPORT_INPUT",
    });
    expect(accessorReads).toBe(0);
    expect(fixture.exchange).toHaveBeenCalledTimes(exchangeCount);
  });

  it("retains and independently verifies multiple native plans produced by one controller action", async () => {
    const loadedBootstrap = bootstrapFixture();
    const evidenceRoot = "C:\\probe-multiple-plan-evidence";
    const evidence = memoryStore(evidenceRoot);
    const base = operationInputs(loadedBootstrap, evidenceRoot);
    const workItem = PROBE_RUN_PLAN.work.find(
      ({ rowId, variantId }) => rowId === "F-03" && variantId === "f03-port-absent",
    );
    if (workItem === undefined) throw new Error("F-03 multiple-plan work item is missing");
    const definition = getProbeScenarioDefinition(workItem.rowId, workItem.variantId);
    const producer = definition.actions.find(
      ({ actionId }) => actionId === "prepare-private-file-target",
    );
    const consumers = definition.actions.filter(({ actionId }) =>
      ["capture-target-identity", "capture-private-file-create"].includes(actionId),
    );
    if (producer === undefined || consumers.length !== 2) {
      throw new Error("F-03 multiple-plan actions are missing");
    }
    const command = {
      ...base.command,
      workId: workItem.workId,
      rowId: workItem.rowId,
      variantId: workItem.variantId,
    };
    const rootIdentitySha256 =
      base.preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256;
    const preparedContext = base.preparedContext;
    const invocation = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-scenario-action-invocation" as const,
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action: producer,
    };
    const runtimeActionBinding = createProbeRuntimeActionBinding({
      command,
      invocation,
      preparedContext,
    });
    const operationResultPath = runtimeActionBinding.operationResultPath;
    evidence.seed(
      runtimeActionBinding.operationIntentPath,
      canonicalProbeJson(runtimeActionBinding.intent),
    );
    const plans = consumers.map((consumer, index) => {
      const consumerBinding = createProbeRuntimeActionBinding({
        command,
        invocation: { ...invocation, action: consumer },
        preparedContext,
      });
      return createProbeNativeActionPlan({
        candidateSha256: loadedBootstrap.candidate.candidateSha256,
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
        operationId: consumerBinding.operationId,
        evidenceRootObjectIdentitySha256: rootIdentitySha256,
        steps: [
          {
            sequence: 1,
            stepId: `execute-consumer-${index + 1}`,
            command: consumer.capture!.commandId,
            request: { relativePath: "targets/private-file" },
            timeoutMs: 30_000,
            recoveryClass: index === 0 ? "read-only-replay" : "never-auto-replay",
          },
        ],
        prerequisiteEvidence: [],
      });
    });
    const result = {
      actionId: producer.actionId,
      commandEvent: null,
      evidenceArtifacts: [],
    };
    const exchange = vi.fn(
      async ({ request }: { request: ControllerRequest; payloadBytes: Uint8Array }) =>
        successfulScenarioActionExchange(
          request,
          loadedBootstrap,
          {
            command,
            workItem,
            preparedContext,
            invocation,
            runtimeActionBinding,
            operationResultPath,
          },
          result,
          plans.map((plan) => ({
            path: probeNativeActionPlanPath({
              campaignRunId: plan.campaignRunId,
              attemptId: plan.attemptId,
              workId: plan.workId,
              consumerActionId: plan.consumerActionId,
            }),
            bytes: Buffer.from(canonicalProbeJson(plan), "utf8"),
          })),
        ),
    );
    const transport = await createProbeControllerSpoolTransport({
      loadedBootstrap,
      resolveStore: vi.fn(async () => evidence.value),
      openSpoolStore: vi.fn(async ({ root }: { root: string }) => store(root)),
      createSpoolClient: vi.fn(() => ({ exchange })),
    });
    await expect(
      transport.invokeScenarioAction({
        command,
        workItem,
        preparedContext,
        evidenceRoot,
        operationId: runtimeActionBinding.operationId,
        operationIntentPath: runtimeActionBinding.operationIntentPath,
        operationResultPath,
        execution: getProbeActionMapping(invocation),
        invocation,
      } as never),
    ).resolves.toBeDefined();

    for (const plan of plans) {
      const options = {
        store: evidence.value,
        loadedBootstrap,
        campaignRunId: command.campaignRunId,
        executionRunId: preparedContext.executionRunId,
        attemptId: command.attemptId,
        workId: command.workId,
        environmentId: command.environmentId,
        pathProfileId: command.pathProfileId,
        rowId: command.rowId,
        variantId: command.variantId,
        consumerActionId: plan.consumerActionId,
      };
      await expect(readVerifiedControllerNativeActionPlan(options)).resolves.toMatchObject({
        plan,
      });
      const planPath = probeNativeActionPlanPath({
        campaignRunId: command.campaignRunId,
        attemptId: command.attemptId,
        workId: command.workId,
        consumerActionId: plan.consumerActionId,
      });
      expect(evidence.files.has(planPath)).toBe(true);
      const legacyPlanStem = planPath.slice(0, -".json".length);
      for (const suffix of [
        ".provenance.json",
        ".controller-request.json",
        ".operation-request.json",
        ".controller-response.json",
        ".operation-response.json",
      ]) {
        expect(evidence.files.has(`${legacyPlanStem}${suffix}`)).toBe(false);
      }
    }
    const actionPaths = probeControllerActionProvenancePaths({
      campaignRunId: command.campaignRunId,
      attemptId: command.attemptId,
      workId: command.workId,
      producerActionId: producer.actionId,
    });
    const actionProvenance = JSON.parse(
      Buffer.from(evidence.files.get(actionPaths.provenance)!).toString("utf8"),
    );
    expect(Object.keys(actionProvenance.records).sort()).toEqual([
      "controllerRequest",
      "controllerResponse",
      "executionReceipt",
      "operationRequest",
      "operationResponse",
    ]);
    for (const path of [
      actionPaths.provenance,
      actionPaths.receipt,
      actionPaths.controllerRequest,
      actionPaths.operationRequest,
      actionPaths.controllerResponse,
      actionPaths.operationResponse,
    ]) {
      expect(evidence.writes.filter((written) => written === path)).toHaveLength(1);
    }
  });

  it("offline-verifies every retained byte and rejects missing, substituted, case-colliding, or counterfeit action records without exchange", async () => {
    const fixture = await retainedNativePlanFixture();
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.producer.actionId,
    });
    const baseline = new Map(
      [...fixture.evidence.files].map(([path, bytes]) => [path, Buffer.from(bytes)]),
    );
    const exchangeCount = fixture.exchange.mock.calls.length;
    const expectRejected = async () => {
      await expect(
        fixture.transport.verifyScenarioActionReceipt(fixture.actionInput as never),
      ).rejects.toBeDefined();
      expect(fixture.exchange).toHaveBeenCalledTimes(exchangeCount);
      restoreFiles(fixture.evidence.files, baseline);
    };

    const intentPath = fixture.inputs.runtimeActionBinding.operationIntentPath;
    const intentSeparator = intentPath.lastIndexOf("/");
    const intentAlias = `${intentPath.slice(0, intentSeparator + 1)}${intentPath
      .slice(intentSeparator + 1)
      .toUpperCase()}`;
    fixture.evidence.files.set(intentAlias, Buffer.from(baseline.get(intentPath)!));
    await expectRejected();

    fixture.evidence.files.delete(fixture.inputs.operationResultPath);
    await expectRejected();

    fixture.evidence.files.set(
      fixture.inputs.operationResultPath,
      Buffer.from(canonicalProbeJson({ substituted: true }), "utf8"),
    );
    await expectRejected();

    fixture.evidence.files.set(
      `${fixture.inputs.operationResultPath.slice(0, -".json".length)}.JSON`,
      Buffer.from(baseline.get(fixture.inputs.operationResultPath)!),
    );
    await expectRejected();

    fixture.evidence.files.delete(paths.provenance);
    await expectRejected();

    const retainedProvenance = JSON.parse(
      Buffer.from(baseline.get(paths.provenance)!).toString("utf8"),
    );
    fixture.evidence.files.set(
      paths.provenance,
      Buffer.from(
        canonicalProbeJson({
          ...retainedProvenance,
          provenanceSha256: sha256("substituted-provenance"),
        }),
        "utf8",
      ),
    );
    await expectRejected();

    fixture.evidence.files.set(
      `${paths.provenance.slice(0, -".json".length)}.JSON`,
      Buffer.from(baseline.get(paths.provenance)!),
    );
    await expectRejected();

    const retainedResponse = JSON.parse(
      Buffer.from(baseline.get(paths.controllerResponse)!).toString("utf8"),
    );
    const counterfeitResponseBytes = Buffer.from(
      canonicalProbeJson({
        ...retainedResponse,
        signatureBase64: Buffer.alloc(64, 7).toString("base64"),
      }),
      "utf8",
    );
    const receipt = JSON.parse(Buffer.from(baseline.get(paths.receipt)!).toString("utf8"));
    const record = (bytes: Buffer) => ({
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    const counterfeitProvenance = createProbeControllerActionProvenance({
      receipt,
      records: {
        controllerRequest: record(Buffer.from(baseline.get(paths.controllerRequest)!)),
        operationRequest: record(Buffer.from(baseline.get(paths.operationRequest)!)),
        controllerResponse: record(counterfeitResponseBytes),
        operationResponse: record(Buffer.from(baseline.get(paths.operationResponse)!)),
      },
      artifacts: collectProbeControllerActionSignedArtifacts(receipt).map(({ path }) => ({
        path,
        bytes: Buffer.from(baseline.get(path)!),
      })),
    });
    fixture.evidence.files.set(paths.controllerResponse, counterfeitResponseBytes);
    fixture.evidence.files.set(
      paths.provenance,
      Buffer.from(canonicalProbeJson(counterfeitProvenance), "utf8"),
    );
    await expectRejected();
  });

  it("fails closed on missing, swapped, cross-coordinate, duplicate, or counterfeit action authority", async () => {
    const fixture = await retainedNativePlanFixture();
    const actionPaths = probeControllerActionProvenancePaths({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.producer.actionId,
    });
    const provenancePath = actionPaths.provenance;
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: fixture.inputs.command.campaignRunId,
      attemptId: fixture.inputs.command.attemptId,
      workId: fixture.inputs.command.workId,
      producerActionId: fixture.inputs.producer.actionId,
    });
    const baseline = new Map(
      [...fixture.evidence.files].map(([path, bytes]) => [path, Buffer.from(bytes)]),
    );
    const baselineProvenance = JSON.parse(
      Buffer.from(baseline.get(provenancePath)!).toString("utf8"),
    );
    const expectRejected = async () => {
      await expect(
        readVerifiedControllerNativeActionPlan(fixture.verificationOptions),
      ).rejects.toBeDefined();
      restoreFiles(fixture.evidence.files, baseline);
    };

    fixture.evidence.files.delete(commitPath);
    await expect(
      readVerifiedControllerNativeActionPlan(fixture.verificationOptions),
    ).rejects.toMatchObject({ code: PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE });
    restoreFiles(fixture.evidence.files, baseline);

    const changedConsumerPlan = rebuildNativePlan(fixture.inputs.plan, {
      consumerActionId: "capture-home-identity-swapped",
    });
    fixture.evidence.files.set(
      fixture.inputs.planPath,
      Buffer.from(canonicalProbeJson(changedConsumerPlan), "utf8"),
    );
    await expectRejected();

    const changedProducerPlan = rebuildNativePlan(fixture.inputs.plan, {
      producerActionId: "prepare-home-topology-swapped",
    });
    fixture.evidence.files.set(
      fixture.inputs.planPath,
      Buffer.from(canonicalProbeJson(changedProducerPlan), "utf8"),
    );
    await expectRejected();

    fixture.evidence.files.delete(provenancePath);
    await expectRejected();

    fixture.evidence.files.set(fixture.inputs.planPath, Buffer.from("changed plan", "utf8"));
    await expectRejected();

    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          coordinate: { ...baselineProvenance.coordinate, workId: "work-cross-coordinate" },
        }),
        "utf8",
      ),
    );
    await expectRejected();

    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          records: {
            ...baselineProvenance.records,
            operationRequest: {
              ...baselineProvenance.records.operationRequest,
              sha256: baselineProvenance.records.controllerRequest.sha256,
            },
          },
        }),
        "utf8",
      ),
    );
    await expectRejected();

    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          records: {
            ...baselineProvenance.records,
            operationRequest: {
              ...baselineProvenance.records.operationRequest,
              path: baselineProvenance.records.controllerRequest.path.toUpperCase(),
            },
          },
        }),
        "utf8",
      ),
    );
    await expectRejected();

    const provenanceSeparator = provenancePath.lastIndexOf("/");
    const provenanceAlias = `${provenancePath.slice(0, provenanceSeparator + 1)}${provenancePath
      .slice(provenanceSeparator + 1)
      .toUpperCase()}`;
    fixture.evidence.files.set(provenanceAlias, Buffer.from(baseline.get(provenancePath)!));
    await expectRejected();

    const planSeparator = fixture.inputs.planPath.lastIndexOf("/");
    const planAlias = `${fixture.inputs.planPath.slice(0, planSeparator + 1)}${fixture.inputs.planPath
      .slice(planSeparator + 1)
      .toUpperCase()}`;
    fixture.evidence.files.set(planAlias, Buffer.from(baseline.get(fixture.inputs.planPath)!));
    await expectRejected();

    const responsePath = baselineProvenance.records.controllerResponse.path;
    const retainedResponse = JSON.parse(Buffer.from(baseline.get(responsePath)!).toString("utf8"));
    const counterfeitResponseBytes = Buffer.from(
      canonicalProbeJson({
        ...retainedResponse,
        signatureBase64: Buffer.alloc(64, 9).toString("base64"),
      }),
      "utf8",
    );
    fixture.evidence.files.set(responsePath, counterfeitResponseBytes);
    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          records: {
            ...baselineProvenance.records,
            controllerResponse: {
              path: responsePath,
              bytes: counterfeitResponseBytes.length,
              sha256: sha256(counterfeitResponseBytes),
            },
          },
        }),
        "utf8",
      ),
    );
    await expectRejected();

    const operationResponsePath = baselineProvenance.records.operationResponse.path;
    const changedOperationResponse = Buffer.from(canonicalProbeJson({ changed: true }), "utf8");
    fixture.evidence.files.set(operationResponsePath, changedOperationResponse);
    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          records: {
            ...baselineProvenance.records,
            operationResponse: {
              path: operationResponsePath,
              bytes: changedOperationResponse.length,
              sha256: sha256(changedOperationResponse),
            },
          },
        }),
        "utf8",
      ),
    );
    await expectRejected();

    const baselineOperationResponse = JSON.parse(
      Buffer.from(baseline.get(operationResponsePath)!).toString("utf8"),
    );
    const resultBinding = baselineOperationResponse.artifactBindings.find(
      ({ path }: { path: string }) => path === fixture.inputs.operationResultPath,
    );
    const resultBytes = Buffer.from(baseline.get(fixture.inputs.operationResultPath)!);
    const responseWithoutPlanPayload = encodeControllerOperationResponse({
      operationKind: "scenario-action",
      result: baselineOperationResponse.result,
      artifactBindings: [resultBinding],
    }).bytes;
    const retainedRequest = JSON.parse(
      Buffer.from(baseline.get(baselineProvenance.records.controllerRequest.path)!).toString(
        "utf8",
      ),
    ) as ControllerRequest;
    const responseWithoutPlan = signedExchange(
      retainedRequest,
      fixture.loadedBootstrap,
      responseWithoutPlanPayload,
      [{ reference: contentReference(resultBytes), bytes: resultBytes }],
    );
    const responseWithoutPlanBytes = Buffer.from(
      canonicalProbeJson(responseWithoutPlan.response),
      "utf8",
    );
    fixture.evidence.files.set(responsePath, responseWithoutPlanBytes);
    fixture.evidence.files.set(operationResponsePath, Buffer.from(responseWithoutPlanPayload));
    fixture.evidence.files.set(
      provenancePath,
      Buffer.from(
        canonicalProbeJson({
          ...baselineProvenance,
          controllerResponseSha256: responseWithoutPlan.response.responseSha256,
          records: {
            ...baselineProvenance.records,
            controllerResponse: {
              path: responsePath,
              bytes: responseWithoutPlanBytes.length,
              sha256: sha256(responseWithoutPlanBytes),
            },
            operationResponse: {
              path: operationResponsePath,
              bytes: responseWithoutPlanPayload.length,
              sha256: sha256(responseWithoutPlanPayload),
            },
          },
        }),
        "utf8",
      ),
    );
    await expectRejected();
  });
});
