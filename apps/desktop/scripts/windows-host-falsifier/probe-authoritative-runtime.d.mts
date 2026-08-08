import type { EvidenceStore } from "./evidence-store.mjs";
import type {
  ProbeBrokerEnrollment,
  ProbeBrokerMailboxObservation,
} from "./broker/mailbox-protocol.mjs";
import type { ProbeActionMapping } from "./probe-action-map.mjs";
import type { ProbeControllerActionExecutionReceipt } from "./probe-controller-action-provenance.mjs";
import type { ProbeControllerTransport } from "./probe-adapters.mjs";
import type {
  ProbeCandidateIdentity,
  ProbeExternalCheckpointEvidence,
  ProbeExternalCheckpointRequest,
  ProbeLabAttestation,
  ProbeSegmentOutcome,
} from "./probe-contract.mjs";
import type { VerifiedProbeCampaignResult } from "./probe-finalizer.mjs";
import type {
  PreparedProbeContext,
  ProbeControllerObservation,
  ProbeGuestObservation,
  ProbeLifecyclePolicy,
  ProbePreflightRequest,
} from "./probe-preflight.mjs";
import type {
  ProbeRunWorkItem,
  ProbeRunnerCampaignFinalizeDispatchInput,
  ProbeRunnerContinuationCommand,
  ProbeRunnerFinalizeSegmentCommand,
  ProbeRunnerPrepareCommand,
  ProbeRunnerPrepareDispatchInput,
  ProbeRunnerSegmentCommand,
  ProbeRunnerWorkDispatchInput,
} from "./probe-runner.mjs";
import type {
  ProbeRunAuthorization,
  ProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";
import type {
  ProbeScenarioActionInvocation,
  ProbeScenarioActionResult,
  ProbeScenarioCapture,
} from "./probe-scenarios.mjs";

export const PROBE_AUTHORITATIVE_RUNTIME_SCHEMA_VERSION: 1;

export class ProbeAuthoritativeRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function deriveProbeRuntimeScenarioOperationId(
  command: Pick<ProbeRuntimeWorkCommand, "campaignRunId" | "attemptId" | "workId"> & {
    readonly repetition?: number;
  },
  actionId: string,
): string;

export interface ProbeRuntimeCoordinate {
  readonly campaignRunId: string;
  readonly environmentId: string;
  readonly pathProfileId: string;
}

export interface ProbeRuntimeDependencies {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-runtime-dependencies";
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly dependsOnRowIds: readonly string[];
  readonly upstreamSelectionDigests: readonly string[];
}

export type ProbeRuntimeWorkCommand =
  | ProbeRunnerSegmentCommand
  | ProbeRunnerContinuationCommand
  | ProbeRunnerFinalizeSegmentCommand;

export interface ProbeRuntimeActionInput {
  readonly command: ProbeRuntimeWorkCommand;
  readonly workItem: ProbeRunWorkItem;
  readonly preparedContext: PreparedProbeContext;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
  readonly dependencies: ProbeRuntimeDependencies;
  readonly evidenceRoot: string;
  readonly transportAuthority: "injected-authoritative-lab";
  readonly operationId: string;
  readonly operationIntentPath: string;
  readonly operationResultPath: string;
  readonly execution: ProbeActionMapping;
  readonly checkpointEvidence:
    | ProbeExternalCheckpointEvidence
    | Readonly<Record<string, unknown>>
    | null;
  readonly invocation: ProbeScenarioActionInvocation;
}

export interface ProbeRuntimeActionAcknowledgment {
  readonly operationId: string;
  readonly resultSha256: string;
}

export interface ProbeRuntimeControllerActionAcknowledgment extends ProbeRuntimeActionAcknowledgment {
  readonly receiptSha256: string;
  readonly provenanceSha256: string;
  readonly actionAttestationSha256: string | null;
  readonly primaryObserverTranscriptSha256s: readonly string[];
}

export interface ProbeRuntimeNativeTranscriptReadInput {
  readonly transcriptSha256: string;
  readonly command: ProbeRuntimeWorkCommand;
  readonly workItem: ProbeRunWorkItem;
  readonly preparedContext: PreparedProbeContext;
  readonly evidenceRoot: string;
  readonly retainedPath: string;
}

export interface ProbeRuntimeNativeTransport {
  readonly observeGuest: (input: {
    readonly request: ProbePreflightRequest;
    readonly evidenceRoot: string;
  }) => Promise<ProbeGuestObservation>;
  readonly invokeScenarioAction: (
    input: ProbeRuntimeActionInput,
  ) => ProbeRuntimeActionAcknowledgment | Promise<ProbeRuntimeActionAcknowledgment>;
  readonly readNativeTranscript: (
    input: ProbeRuntimeNativeTranscriptReadInput,
  ) => Uint8Array | Promise<Uint8Array>;
}

export interface ProbeRuntimeBrokerTransport {
  readonly observeBrokerMailbox: (input: {
    readonly enrollment: ProbeBrokerEnrollment;
    readonly request: ProbePreflightRequest;
    readonly evidenceRoot: string;
  }) => Promise<ProbeBrokerMailboxObservation>;
}

export interface ProbeRuntimeCaptureDisposition {
  readonly captureComplete: boolean;
  readonly availability: {
    readonly status: "available" | "unavailable" | "unknown";
    readonly reason: string | null;
  };
}

export interface ProbeRuntimeHardCutRequestInput {
  readonly command: ProbeRunnerContinuationCommand;
  readonly workItem: ProbeRunWorkItem;
  readonly preparedContext: PreparedProbeContext;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
  readonly dependencies: ProbeRuntimeDependencies;
  readonly continuation: {
    readonly chainId: string;
    readonly scopeSha256: string;
    readonly headerSha256: string;
    readonly terminalEntrySha256: string;
  };
  readonly preCutStateSha256: string;
  readonly preCutBootIdSha256: string;
  readonly evidenceRoot: string;
}

export interface ProbeRuntimeHardCutReceiptReadInput {
  readonly command: ProbeRunnerContinuationCommand;
  readonly workItem: ProbeRunWorkItem;
  readonly preparedContext: PreparedProbeContext;
  readonly attestation: ProbeLabAttestation;
  readonly request: ProbeExternalCheckpointRequest;
  readonly dependencies: ProbeRuntimeDependencies;
  readonly evidenceRoot: string;
}

export interface ProbeRuntimeHardCutReceiptReadResult {
  readonly checkpointEvidence: ProbeExternalCheckpointEvidence;
  readonly actionExecutionReceipt: ProbeControllerActionExecutionReceipt;
  readonly actionAcknowledgment: ProbeRuntimeControllerActionAcknowledgment;
}

export interface ProbeRuntimeControllerTransport extends ProbeControllerTransport {
  readonly verifyRunAuthorization: (input: {
    readonly runAuthorization: ProbeRunAuthorization;
    readonly request: ProbePreflightRequest;
    readonly candidateSha256: string;
    readonly campaignRunId: string;
    readonly attestations: readonly ProbeLabAttestation[];
    readonly currentAttestation: ProbeLabAttestation;
    readonly evidenceRootObjectIdentitySha256: string;
    readonly evidenceRoot: string;
  }) => ProbeRunAuthorizationClaimReceipt | Promise<ProbeRunAuthorizationClaimReceipt>;
  readonly invokeScenarioAction: (
    input: ProbeRuntimeActionInput,
  ) =>
    | ProbeRuntimeControllerActionAcknowledgment
    | Promise<ProbeRuntimeControllerActionAcknowledgment>;
  readonly verifyScenarioActionReceipt: (
    input: ProbeRuntimeActionInput,
  ) =>
    | ProbeRuntimeControllerActionAcknowledgment
    | Promise<ProbeRuntimeControllerActionAcknowledgment>;
  readonly observeCaptureDisposition: (input: {
    readonly command: ProbeRuntimeWorkCommand;
    readonly workItem: ProbeRunWorkItem;
    readonly preparedContext: PreparedProbeContext;
    readonly candidate: ProbeCandidateIdentity;
    readonly attestation: ProbeLabAttestation;
    readonly dependencies: ProbeRuntimeDependencies;
    readonly capture: ProbeScenarioCapture;
    readonly checkpointEvidence?: readonly ProbeExternalCheckpointEvidence[];
    readonly evidenceRoot: string;
  }) => ProbeRuntimeCaptureDisposition | Promise<ProbeRuntimeCaptureDisposition>;
  readonly signSourceTranscriptReceipt: (input: {
    readonly receiptSha256: string;
    readonly receiptFields: Readonly<Record<string, unknown>>;
    readonly sourceTranscriptSha256: string;
    readonly command: ProbeRuntimeWorkCommand;
    readonly workItem: ProbeRunWorkItem;
    readonly preparedContext: PreparedProbeContext;
    readonly evidenceRoot: string;
  }) => { readonly signatureBase64: string } | Promise<{ readonly signatureBase64: string }>;
  readonly claimHardCutRequest: (
    input: ProbeRuntimeHardCutRequestInput,
  ) => ProbeExternalCheckpointRequest | Promise<ProbeExternalCheckpointRequest>;
  readonly readHardCutReceipt: (
    input: ProbeRuntimeHardCutReceiptReadInput,
  ) => ProbeRuntimeHardCutReceiptReadResult | Promise<ProbeRuntimeHardCutReceiptReadResult>;
  readonly verifyHardCutReceipt: (
    input: ProbeRuntimeHardCutReceiptReadInput,
  ) => ProbeRuntimeHardCutReceiptReadResult | Promise<ProbeRuntimeHardCutReceiptReadResult>;
}

export interface ProbeAuthoritativeRuntimeConfig {
  readonly campaignRunId: string;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestations: readonly ProbeLabAttestation[];
  readonly runAuthorization: ProbeRunAuthorization;
  readonly brokerEnrollments: readonly ProbeBrokerEnrollment[];
  readonly repositoryRoot: string;
  readonly binaryRoot?: string;
  readonly lifecyclePolicy: ProbeLifecyclePolicy;
  readonly resolveStore: (
    coordinate: ProbeRuntimeCoordinate,
  ) => EvidenceStore | Promise<EvidenceStore>;
  readonly resolvePreflightRequest: (input: {
    readonly command: ProbeRunnerPrepareCommand;
    readonly candidate: ProbeCandidateIdentity;
    readonly attestation: ProbeLabAttestation;
    readonly evidenceRoot: string;
  }) => ProbePreflightRequest | Promise<ProbePreflightRequest>;
  readonly nativeTransport: ProbeRuntimeNativeTransport;
  readonly brokerTransport: ProbeRuntimeBrokerTransport;
  readonly controllerTransport: ProbeRuntimeControllerTransport;
  readonly readRepositoryIdentity?: (repositoryRoot: string) => Promise<{
    readonly repositoryCommit: string;
    readonly repositoryDirty: boolean;
  }>;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
}

export interface ProbeRuntimePreparedResult {
  readonly kind: "windows-host-probe-runtime-prepared";
  readonly authority: "attested-preflight";
  readonly path: string;
  readonly preflightSha256: string;
  readonly recovered: boolean;
}

export interface ProbeRuntimeSegmentCaptureResult {
  readonly kind: "windows-host-probe-runtime-segment-capture";
  readonly authority: "retained-signed-transcript";
  readonly workId: string;
  readonly recovered: boolean;
  readonly sourceTranscriptSha256: string;
  readonly sourceTranscriptReceiptSha256: string;
  readonly nativeTranscriptSha256s: readonly string[];
}

export interface ProbeRuntimeHardCutRequestResult {
  readonly kind: "windows-host-probe-runtime-hard-cut-request";
  readonly authority:
    | "external-controller-action-required"
    | "external-controller-action-pending"
    | "verified-external-controller-receipt";
  readonly transportMode:
    | "request-only-no-disruptive-action"
    | "pending-action-no-repeat"
    | "resume-required-no-action"
    | "completed-no-action";
  readonly workId: string;
  readonly repetition: number;
  readonly actionRequired: boolean;
  readonly requestPath: string;
  readonly requestSha256: string;
  readonly request: ProbeExternalCheckpointRequest;
  readonly recovered: boolean;
}

export interface ProbeRuntimeHardCutResumeResult {
  readonly kind: "windows-host-probe-runtime-hard-cut-resume";
  readonly authority: "verified-external-controller-receipt";
  readonly transportMode: "receipt-read-only";
  readonly workId: string;
  readonly repetition: number;
  readonly receiptSha256: string;
  readonly captureReady: boolean;
  readonly sourceTranscriptSha256?: string;
  readonly sourceTranscriptReceiptSha256?: string;
  readonly nativeTranscriptSha256s?: readonly string[];
}

export interface ProbeRuntimeFinalizedSegmentResult {
  readonly kind: "windows-host-probe-runtime-finalized-segment";
  readonly authority: "verified-artifact-finalizer";
  readonly workId: string;
  readonly path: string;
  readonly commitPath: string;
  readonly segmentSha256: string;
  readonly outcome: ProbeSegmentOutcome;
}

export interface ProbeRuntimeFinalizedCampaignResult {
  readonly kind: "windows-host-probe-runtime-finalized-campaign";
  readonly authority: "verified-artifact-finalizer";
  readonly sourceCount: number;
  readonly result: VerifiedProbeCampaignResult;
}

export interface ProbeAuthoritativeRuntime {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-authoritative-runtime";
  readonly authority: "verified-artifact-composition";
  readonly scenarioTransportMode: "injected-authoritative-lab";
  readonly scenarioRetryContract: "durable-operation-result-before-return";
  readonly operationMappingStatus: "audited-action-map-bundled";
  readonly disruptiveActionBoundary: "external-controller-request-and-receipt-only";
  readonly finalizerAdapterMode: "composed-authoritative-adapters";
  readonly prepare: (input: ProbeRunnerPrepareDispatchInput) => Promise<ProbeRuntimePreparedResult>;
  readonly segment: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerSegmentCommand>,
  ) => Promise<ProbeRuntimeSegmentCaptureResult>;
  readonly checkpoint: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerContinuationCommand>,
  ) => Promise<ProbeRuntimeHardCutRequestResult>;
  readonly resume: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerContinuationCommand>,
  ) => Promise<ProbeRuntimeHardCutResumeResult>;
  readonly finalizeSegment: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerFinalizeSegmentCommand>,
  ) => Promise<ProbeRuntimeFinalizedSegmentResult>;
  readonly finalizeCampaign: (
    input: ProbeRunnerCampaignFinalizeDispatchInput,
  ) => Promise<ProbeRuntimeFinalizedCampaignResult>;
}

export function createProbeAuthoritativeRuntime(
  configuration: ProbeAuthoritativeRuntimeConfig,
): ProbeAuthoritativeRuntime;
