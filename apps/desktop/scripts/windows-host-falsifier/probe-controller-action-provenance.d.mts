import type { ProbeScenarioActionResult } from "./probe-scenarios.mjs";
import type { ProbeBrokerResult } from "./broker/protocol.mjs";

export const PROBE_CONTROLLER_ACTION_PROVENANCE_SCHEMA_VERSION: 1;
export const PROBE_CONTROLLER_ACTION_ATTESTATION_SCHEMA_VERSION: 1;
export const PROBE_CONTROLLER_BROKER_ACCEPTANCE_SCHEMA_VERSION: 1;

export class ProbeControllerActionProvenanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeControllerActionActorRole =
  | "primary-standard-user"
  | "controller"
  | "power-control"
  | "remote-peer"
  | "second-user";

export type ProbeControllerActionActorIdentitySource =
  | "actors.primaryStandardUserSidSha256"
  | "controller.identitySha256"
  | "actors.powerControlActorSha256"
  | "actors.remotePeerActorSha256"
  | "actors.secondUserSidSha256";

export interface ProbeControllerActionExpectedActor {
  readonly role: ProbeControllerActionActorRole;
  readonly identitySource: ProbeControllerActionActorIdentitySource;
  readonly identitySha256: string;
}

export type ProbeControllerActionActorSelector =
  | {
      readonly kind: "fixed";
      readonly role: ProbeControllerActionActorRole;
    }
  | {
      readonly kind: "parameter";
      readonly parameter: "actor";
      readonly roleByValue: Readonly<{
        readonly "current-user": "primary-standard-user";
        readonly "second-user": "second-user";
      }>;
    };

export interface ProbeControllerActionExecution {
  readonly actor: "external-controller";
  readonly operation: string;
  readonly locus:
    | "guest-native-helper"
    | "guest-standard-user-worker"
    | "guest-second-user-broker"
    | "controller-host"
    | "controller-remote-peer"
    | "controller-orchestrated-guest";
  readonly driverId: string;
  readonly disruptive: boolean;
  readonly nativeTranscriptRequired: boolean;
  readonly actorSelector: ProbeControllerActionActorSelector;
}

export interface ProbeControllerActionCoordinate {
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly environmentId: "win11-floor" | "win11-current";
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly rowId: `F-${string}`;
  readonly variantId: string;
  readonly repetition: number | null;
}

export interface ProbeControllerActionOperation {
  readonly operationId: string;
  readonly kind: "scenario-action";
  readonly sequence: number;
}

export interface ProbeControllerActionArtifactReference {
  readonly path: string;
  readonly sha256: string;
}

export interface ProbeControllerActionObserverTranscriptReference extends ProbeControllerActionArtifactReference {
  readonly transcriptSha256: string;
}

export interface ProbeControllerActionAttestationBroker {
  readonly brokerAcceptanceSha256: string;
  readonly brokerTaskSha256: string;
  readonly brokerTaskNonceSha256: string;
  readonly brokerResultSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: "primary-standard-user" | "remote-peer" | "second-user";
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly replayJournalDisposition: "accepted" | "idempotent-replay";
  readonly replayJournalEntrySha256: string;
}

export interface ProbeControllerActionAttestationObserverCommand {
  readonly transcriptSha256: string;
  readonly sequence: number;
  readonly commandId: string;
  readonly requestFrameSha256: string;
  readonly responseFrameSha256: string;
  readonly ok: boolean;
}

export interface ProbeControllerActionAttestationFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-action-attestation";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly scenarioPlanSha256: string;
  readonly producerActionId: string;
  readonly operation: ProbeControllerActionOperation;
  readonly runtimeActionIntentSha256: string;
  readonly execution: ProbeControllerActionExecution;
  readonly expectedActor: ProbeControllerActionExpectedActor;
  readonly broker: ProbeControllerActionAttestationBroker | null;
  readonly observerCommands: readonly ProbeControllerActionAttestationObserverCommand[];
}

export interface ProbeControllerActionAttestation extends ProbeControllerActionAttestationFields {
  readonly attestationSha256: string;
}

export type ProbeControllerActionAttestationCreateInput = Omit<
  ProbeControllerActionAttestationFields,
  "schemaVersion" | "kind" | "campaignId" | "manifestSha256" | "runPlanSha256"
>;

export interface ProbeControllerBrokerAcceptanceFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-broker-acceptance";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly producerActionId: string;
  readonly brokerTaskSha256: string;
  readonly brokerTaskNonceSha256: string;
  readonly brokerResultSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: "primary-standard-user" | "remote-peer" | "second-user";
  readonly expectedActor: ProbeControllerActionExpectedActor;
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly replayJournalDisposition: "accepted" | "idempotent-replay";
  readonly replayJournalEntrySha256: string;
}

export interface ProbeControllerBrokerAcceptance extends ProbeControllerBrokerAcceptanceFields {
  readonly acceptanceSha256: string;
}

export type ProbeControllerBrokerAcceptanceCreateInput = Omit<
  ProbeControllerBrokerAcceptanceFields,
  "schemaVersion" | "kind" | "campaignId" | "manifestSha256" | "runPlanSha256"
>;

export interface ProbeControllerActionExecutionReceiptFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-action-execution-receipt";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly scenarioPlanSha256: string;
  readonly producerActionId: string;
  readonly operation: ProbeControllerActionOperation;
  readonly intentSha256: string;
  readonly execution: ProbeControllerActionExecution;
  readonly expectedActor: ProbeControllerActionExpectedActor;
  readonly actionResult: ProbeScenarioActionResult;
  readonly actionResultArtifact: ProbeControllerActionArtifactReference;
  readonly proofArtifacts: readonly ProbeControllerActionArtifactReference[];
  readonly observerTranscripts: readonly ProbeControllerActionObserverTranscriptReference[];
  readonly brokerProof: ProbeControllerActionArtifactReference | null;
  readonly pausedSessionReceipt: ProbeControllerActionArtifactReference | null;
  readonly nativeActionPlans: readonly ProbeControllerActionArtifactReference[];
}

export interface ProbeControllerActionExecutionReceipt extends ProbeControllerActionExecutionReceiptFields {
  readonly receiptSha256: string;
}

export type ProbeControllerActionExecutionReceiptCreateInput = Omit<
  ProbeControllerActionExecutionReceiptFields,
  "schemaVersion" | "kind" | "campaignId" | "manifestSha256" | "runPlanSha256"
>;

export interface ProbeControllerActionProvenanceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProbeControllerActionTrustedRecord {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProbeControllerActionProvenanceRecords {
  readonly executionReceipt: ProbeControllerActionProvenanceRecord;
  readonly controllerRequest: ProbeControllerActionProvenanceRecord;
  readonly operationRequest: ProbeControllerActionProvenanceRecord;
  readonly controllerResponse: ProbeControllerActionProvenanceRecord;
  readonly operationResponse: ProbeControllerActionProvenanceRecord;
}

export interface ProbeControllerActionTrustedRecords {
  readonly controllerRequest: ProbeControllerActionTrustedRecord;
  readonly operationRequest: ProbeControllerActionTrustedRecord;
  readonly controllerResponse: ProbeControllerActionTrustedRecord;
  readonly operationResponse: ProbeControllerActionTrustedRecord;
}

export interface ProbeControllerActionProvenanceFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-action-provenance";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly scenarioPlanSha256: string;
  readonly producerActionId: string;
  readonly operation: ProbeControllerActionOperation;
  readonly intentSha256: string;
  readonly receiptSha256: string;
  readonly records: ProbeControllerActionProvenanceRecords;
}

export interface ProbeControllerActionProvenance extends ProbeControllerActionProvenanceFields {
  readonly provenanceSha256: string;
}

export interface ProbeControllerActionProvenanceTrustedInput {
  readonly receipt: ProbeControllerActionExecutionReceipt;
  readonly records: ProbeControllerActionTrustedRecords;
  readonly artifacts?: readonly ProbeControllerActionEvidenceArtifact[];
}

export interface ProbeControllerActionEvidenceArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ProbeControllerActionExecutionEvidence {
  readonly receipt: ProbeControllerActionExecutionReceipt;
  readonly actionAttestation: ProbeControllerActionAttestation | null;
  readonly brokerAcceptance: ProbeControllerBrokerAcceptance | null;
  readonly brokerResult: ProbeBrokerResult | null;
  readonly observerCommands: readonly ProbeControllerActionAttestationObserverCommand[];
}

export interface ProbeControllerActionProvenancePaths {
  readonly stem: string;
  readonly provenance: string;
  readonly receipt: string;
  readonly controllerRequest: string;
  readonly operationRequest: string;
  readonly controllerResponse: string;
  readonly operationResponse: string;
}

export function deriveProbeControllerActionExecutionReceiptDigest(
  value: ProbeControllerActionExecutionReceiptFields | ProbeControllerActionExecutionReceipt,
): string;
export function validateProbeControllerActionExecutionReceipt(
  value: unknown,
  artifacts?: readonly ProbeControllerActionEvidenceArtifact[],
): ProbeControllerActionExecutionReceipt;
export function validateProbeControllerActionExecutionReceiptStructure(
  value: unknown,
): ProbeControllerActionExecutionReceipt;
export function createProbeControllerActionExecutionReceipt(
  input: ProbeControllerActionExecutionReceiptCreateInput,
  artifacts?: readonly ProbeControllerActionEvidenceArtifact[],
): ProbeControllerActionExecutionReceipt;
export function deriveProbeControllerActionAttestationDigest(
  value: ProbeControllerActionAttestationFields | ProbeControllerActionAttestation,
): string;
export function validateProbeControllerActionAttestation(
  value: unknown,
): ProbeControllerActionAttestation;
export function createProbeControllerActionAttestation(
  input: ProbeControllerActionAttestationCreateInput,
): ProbeControllerActionAttestation;
export function deriveProbeControllerBrokerAcceptanceDigest(
  value: ProbeControllerBrokerAcceptanceFields | ProbeControllerBrokerAcceptance,
): string;
export function validateProbeControllerBrokerAcceptance(
  value: unknown,
): ProbeControllerBrokerAcceptance;
export function createProbeControllerBrokerAcceptance(
  input: ProbeControllerBrokerAcceptanceCreateInput,
): ProbeControllerBrokerAcceptance;
export function probeControllerActionAttestationPath(input: {
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly producerActionId: string;
}): string;
export function probeControllerBrokerAcceptancePath(input: {
  readonly coordinate: ProbeControllerActionCoordinate;
  readonly producerActionId: string;
}): string;
export function validateProbeControllerActionExecutionEvidence(input: {
  readonly receipt: unknown;
  readonly artifacts: readonly ProbeControllerActionEvidenceArtifact[];
}): ProbeControllerActionExecutionEvidence;
export function collectProbeControllerActionSignedArtifacts(
  value: unknown,
): readonly ProbeControllerActionArtifactReference[];
export function probeControllerActionProvenancePaths(input: {
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly producerActionId: string;
}): ProbeControllerActionProvenancePaths;
export function deriveProbeControllerActionProvenanceDigest(
  value: ProbeControllerActionProvenanceFields | ProbeControllerActionProvenance,
): string;
export function createProbeControllerActionProvenance(
  input: ProbeControllerActionProvenanceTrustedInput,
): ProbeControllerActionProvenance;
export function validateProbeControllerActionProvenance(
  value: unknown,
  trustedInput: ProbeControllerActionProvenanceTrustedInput,
): ProbeControllerActionProvenance;
