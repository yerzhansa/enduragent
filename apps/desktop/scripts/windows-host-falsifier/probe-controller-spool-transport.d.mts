import type { EvidenceStore } from "./evidence-store.mjs";
import type {
  ProbeRuntimeActionInput,
  ProbeRuntimeControllerTransport,
  ProbeRuntimeHardCutReceiptReadInput,
} from "./probe-authoritative-runtime.mjs";
import type { LoadedProbeBootstrap } from "./probe-bootstrap.mjs";
import type { ControllerSpoolClient } from "./controller/spool.mjs";
import type {
  ControllerOperationRequestEnvelope,
  ControllerOperationResponseEnvelope,
} from "./controller/operation-codec.mjs";
import type { ControllerRequest, ControllerResponse } from "./controller/protocol.mjs";
import type { ProbeNativeActionPlan } from "./probe-native-action-plan.mjs";
import type { ProbeExternalCheckpointEvidence } from "./probe-contract.mjs";
import type {
  ProbeControllerActionCoordinate,
  ProbeControllerActionExecutionReceipt,
  ProbeControllerActionProvenance,
  ProbeControllerActionProvenanceRecord,
} from "./probe-controller-action-provenance.mjs";

export const PROBE_CONTROLLER_ACTION_INCOMPLETE_CODE: "CONTROLLER_TRANSPORT_ACTION_INCOMPLETE";

export class ProbeControllerSpoolTransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeControllerActionCommitMarker {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-action-commit";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly producerActionId: string;
  readonly receiptSha256: string;
  readonly provenanceSha256: string;
  readonly artifacts: readonly ProbeControllerActionProvenanceRecord[];
  readonly commitSha256: string;
}

export interface ProbeControllerScenarioActionReceiptAcknowledgment {
  readonly operationId: string;
  readonly resultSha256: string;
  readonly receiptSha256: string;
  readonly provenanceSha256: string;
  readonly actionAttestationSha256: string | null;
  readonly primaryObserverTranscriptSha256s: readonly string[];
}

export interface ProbeControllerHardCutReceiptResult {
  readonly checkpointEvidence: ProbeExternalCheckpointEvidence;
  readonly actionExecutionReceipt: ProbeControllerActionExecutionReceipt;
  readonly actionAcknowledgment: ProbeControllerScenarioActionReceiptAcknowledgment;
}

export interface ProbeControllerSpoolTransport extends Omit<
  ProbeRuntimeControllerTransport,
  "readHardCutReceipt"
> {
  readonly invokeScenarioAction: (
    input: ProbeRuntimeActionInput,
  ) => Promise<ProbeControllerScenarioActionReceiptAcknowledgment>;
  readonly verifyScenarioActionReceipt: (
    input: ProbeRuntimeActionInput,
  ) => Promise<ProbeControllerScenarioActionReceiptAcknowledgment>;
  readonly readHardCutReceipt: (
    input: ProbeRuntimeHardCutReceiptReadInput,
  ) => Promise<ProbeControllerHardCutReceiptResult>;
  readonly verifyHardCutReceipt: (
    input: ProbeRuntimeHardCutReceiptReadInput,
  ) => Promise<ProbeControllerHardCutReceiptResult>;
}

export function probeControllerActionCommitMarkerPath(input: {
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly producerActionId: string;
}): string;

export function readVerifiedControllerNativeActionPlan(options: {
  readonly store: EvidenceStore;
  readonly loadedBootstrap: LoadedProbeBootstrap;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly environmentId: string;
  readonly pathProfileId: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly consumerActionId: string;
}): Promise<{
  readonly plan: ProbeNativeActionPlan;
  readonly executionReceipt: ProbeControllerActionExecutionReceipt;
  readonly provenance: ProbeControllerActionProvenance;
  readonly commit: ProbeControllerActionCommitMarker;
  readonly request: ControllerRequest;
  readonly response: ControllerResponse;
  readonly operationRequest: ControllerOperationRequestEnvelope<"scenario-action">;
  readonly operationResponse: ControllerOperationResponseEnvelope<"scenario-action">;
}>;

export function createProbeControllerSpoolTransport(options: {
  readonly loadedBootstrap: LoadedProbeBootstrap;
  readonly resolveStore: (coordinate: {
    readonly campaignRunId: string;
    readonly environmentId: string;
    readonly pathProfileId: string;
  }) => EvidenceStore | Promise<EvidenceStore>;
  readonly openSpoolStore?: (options: {
    readonly root: string;
  }) => EvidenceStore | Promise<EvidenceStore>;
  readonly createSpoolClient?: (options: {
    readonly inboxStore: EvidenceStore;
    readonly outboxStore: EvidenceStore;
    readonly controllerIdentitySha256: string;
    readonly controllerVersion: string;
    readonly controllerPublicKeyBytes: Uint8Array;
  }) => ControllerSpoolClient;
}): Promise<ProbeControllerSpoolTransport>;
