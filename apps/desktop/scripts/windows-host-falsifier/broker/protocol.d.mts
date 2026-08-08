import type { ProbeActionActorSelector, ProbeActionExecutionLocus } from "../probe-action-map.mjs";
import type {
  ProbeBrokerExecutionAuthorityConfirmation,
  ProbeBrokerExecutionAuthorityLease,
} from "./execution-authority.mjs";

export const PROBE_BROKER_PROTOCOL_SCHEMA_VERSION: 1;
export const PROBE_BROKER_TASK_KIND: "windows-host-probe-broker-task";
export const PROBE_BROKER_RESULT_KIND: "windows-host-probe-broker-result";
export const PROBE_BROKER_DRIVER_REQUEST_KIND: "windows-host-probe-broker-driver-request";
export const PROBE_BROKER_DRIVER_RESULT_KIND: "windows-host-probe-broker-driver-result";
export const PROBE_BROKER_ROLES: readonly ["primary-standard-user", "second-user", "remote-peer"];
export const PROBE_BROKER_RECOVERY_CLASSES: readonly [
  "read-only-replay",
  "inspect-and-reconcile",
  "never-auto-replay",
];
export const PROBE_BROKER_RESULT_OUTCOMES: readonly ["FAILED", "INCONCLUSIVE", "SUCCEEDED"];
export const PROBE_BROKER_MAX_CANONICAL_BYTES: number;
export const PROBE_BROKER_MAX_ARTIFACT_BYTES: number;
export const PROBE_BROKER_MAX_REFERENCES: number;
export const PROBE_BROKER_MAX_DEPTH: number;
export const PROBE_BROKER_TASK_MAX_TTL_MS: 600000;

export class ProbeBrokerProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeBrokerRole = (typeof PROBE_BROKER_ROLES)[number];
export type ProbeBrokerRecoveryClass = (typeof PROBE_BROKER_RECOVERY_CLASSES)[number];
export type ProbeBrokerResultOutcome = (typeof PROBE_BROKER_RESULT_OUTCOMES)[number];

export type ProbeBrokerActorIdentitySource =
  | "actors.primaryStandardUserSidSha256"
  | "actors.secondUserSidSha256"
  | "actors.remotePeerActorSha256";

export interface ProbeBrokerActorIdentity {
  readonly role: ProbeBrokerRole;
  readonly identitySource: ProbeBrokerActorIdentitySource;
  readonly identitySha256: string;
}

export interface ProbeBrokerScenarioCoordinate {
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

export interface ProbeBrokerExecutionMapping {
  readonly actor: "external-controller";
  readonly operation: string;
  readonly locus: ProbeActionExecutionLocus;
  readonly driverId: string;
  readonly disruptive: boolean;
  readonly nativeTranscriptRequired: boolean;
  readonly actorSelector: ProbeActionActorSelector;
}

export interface ProbeBrokerActionBinding {
  readonly scenarioPlanSha256: string;
  readonly producerActionId: string;
  readonly operationId: string;
  readonly sequence: number;
}

export type ProbeBrokerActorSelectorInput = null | {
  readonly parameter: "actor";
  readonly value: "current-user" | "second-user";
};

export interface ProbeBrokerArtifactReference {
  readonly blobPath: `blobs/sha256/${string}`;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProbeBrokerObserverTranscriptReference extends ProbeBrokerArtifactReference {
  readonly transcriptSha256: string;
}

export interface ProbeBrokerDriverRequest {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-driver-request";
  readonly driverId: string;
  /** Opaque transport reference; validate dereferenced bytes with the selected driver's schema. */
  readonly requestArtifact: ProbeBrokerArtifactReference;
}

export interface ProbeBrokerDriverResult {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-driver-result";
  readonly driverId: string;
  readonly resultArtifact: ProbeBrokerArtifactReference;
}

export interface ProbeBrokerTaskDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-task";
  readonly taskId: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeBrokerScenarioCoordinate;
  readonly runtimeActionIntentSha256: string;
  readonly action: ProbeBrokerActionBinding;
  readonly execution: ProbeBrokerExecutionMapping;
  readonly actorSelectorInput: ProbeBrokerActorSelectorInput;
  readonly expectedActor: ProbeBrokerActorIdentity;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly driverRequest: ProbeBrokerDriverRequest;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
  readonly issuedAt: string;
  readonly deadline: string;
  readonly nonceBase64: string;
  readonly signatureAlgorithm: "Ed25519";
}

export interface ProbeBrokerTask extends ProbeBrokerTaskDraft {
  readonly taskSha256: string;
  readonly signatureBase64: string;
}

export type ProbeBrokerTaskCreateInput = Omit<
  ProbeBrokerTaskDraft,
  | "schemaVersion"
  | "kind"
  | "campaignId"
  | "manifestSha256"
  | "runPlanSha256"
  | "signatureAlgorithm"
>;

export interface ProbeBrokerTaskSignatureVerificationOptions {
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly expectedControllerIdentitySha256: string;
}

export interface ProbeBrokerDriverValidationReceiptDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-driver-validation-receipt";
  readonly taskSha256: string;
  readonly driverId: string;
  readonly requestArtifactSha256: string;
  readonly requestArtifactBytes: number;
  readonly requestSchemaSha256: string;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
}

export interface ProbeBrokerDriverValidationReceipt extends ProbeBrokerDriverValidationReceiptDraft {
  readonly receiptSha256: string;
}

export type ProbeBrokerDriverValidationReceiptCreateInput = Omit<
  ProbeBrokerDriverValidationReceiptDraft,
  "schemaVersion" | "kind"
>;

export interface ProbeBrokerDriverValidationRequest {
  readonly taskSha256: string;
  readonly driverId: string;
  readonly execution: ProbeBrokerExecutionMapping;
  readonly requestArtifact: ProbeBrokerArtifactReference;
}

export interface ProbeBrokerReplayBinding {
  readonly taskId: string;
  readonly taskSha256: string;
  readonly nonceBase64: string;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
  readonly issuedAt: string;
  readonly deadline: string;
  readonly allowFresh: boolean;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly controllerIdentitySha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly candidateSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeBrokerScenarioCoordinate;
  readonly runtimeActionIntentSha256: string;
  readonly operationId: string;
  readonly producerActionId: string;
}

export type ProbeBrokerReplayJournalDecision =
  | {
      readonly disposition: "absent";
      readonly semanticKeySha256: string;
      readonly physicalOperationKeySha256: string;
    }
  | {
      readonly disposition: "fresh" | "retained";
      readonly semanticKeySha256: string;
      readonly physicalOperationKeySha256: string;
      readonly taskSha256: string;
      readonly replayJournalEntrySha256: string;
    }
  | {
      readonly disposition: "equivocation";
      readonly semanticKeySha256: string;
      readonly physicalOperationKeySha256: string;
      readonly retainedTaskSha256: string;
      readonly replayJournalEntrySha256: string;
    };

export interface ProbeBrokerReplayGuard {
  readonly consume: (
    binding: ProbeBrokerReplayBinding,
  ) => ProbeBrokerReplayJournalDecision | Promise<ProbeBrokerReplayJournalDecision>;
}

export interface ProbeBrokerTaskAcceptanceOptions extends ProbeBrokerTaskSignatureVerificationOptions {
  readonly executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  readonly validateDriverRequest: (
    request: ProbeBrokerDriverValidationRequest,
  ) => ProbeBrokerDriverValidationReceipt | Promise<ProbeBrokerDriverValidationReceipt>;
  readonly verificationInstant: Date;
  readonly replayGuard: ProbeBrokerReplayGuard;
}

export type ProbeBrokerRecoveryDirective =
  | "execute"
  | "replay"
  | "reconcile"
  | "manual-intervention";

export interface ProbeBrokerAcceptanceCapability {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-acceptance-capability";
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly coordinate: ProbeBrokerScenarioCoordinate;
  readonly producerActionId: string;
  readonly brokerTaskSha256: string;
  readonly brokerTaskNonceSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly expectedActor: ProbeBrokerActorIdentity;
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly executionAuthoritySha256: string;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
  readonly driverValidationReceiptSha256: string;
  readonly replayJournalDisposition: "accepted" | "idempotent-replay";
  readonly replayJournalEntrySha256: string;
}

declare const acceptedProbeBrokerTaskContext: unique symbol;
/**
 * Live context minted after durable journal acceptance. After a restart, pass its signed task
 * through acceptProbeBrokerTask again so the journal can return an exact retained decision.
 */
export interface ProbeAcceptedBrokerTaskContext {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-accepted-task-context";
  readonly task: ProbeBrokerTask;
  readonly driverValidationReceipt: ProbeBrokerDriverValidationReceipt;
  readonly capability: ProbeBrokerAcceptanceCapability;
  readonly recoveryDirective: ProbeBrokerRecoveryDirective;
  readonly contextSha256: string;
  readonly [acceptedProbeBrokerTaskContext]: true;
}

export interface ProbeBrokerControllerAcceptanceInput {
  readonly coordinate: ProbeBrokerScenarioCoordinate;
  readonly producerActionId: string;
  readonly brokerTaskSha256: string;
  readonly brokerTaskNonceSha256: string;
  readonly brokerResultSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly expectedActor: ProbeBrokerActorIdentity;
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly replayJournalDisposition: "accepted" | "idempotent-replay";
  readonly replayJournalEntrySha256: string;
}

export interface ProbeBrokerResultDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-result";
  readonly taskSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly actor: ProbeBrokerActorIdentity;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly outcome: ProbeBrokerResultOutcome;
  readonly driverResult: ProbeBrokerDriverResult;
  readonly proofArtifacts: readonly ProbeBrokerArtifactReference[];
  readonly observerTranscripts: readonly ProbeBrokerObserverTranscriptReference[];
  readonly pausedSessionReceipt: ProbeBrokerArtifactReference | null;
}

export interface ProbeBrokerResult extends ProbeBrokerResultDraft {
  readonly resultSha256: string;
}

export type ProbeBrokerResultCreateInput = Omit<ProbeBrokerResultDraft, "schemaVersion" | "kind">;

export function deriveProbeBrokerTaskDigest(value: ProbeBrokerTaskDraft | ProbeBrokerTask): string;
export function createProbeBrokerTask(
  input: ProbeBrokerTaskCreateInput,
  signTaskDigest: (taskDigest: Uint8Array) => Uint8Array,
): ProbeBrokerTask;
export function validateProbeBrokerTask(value: unknown): ProbeBrokerTask;
export function deriveProbeBrokerTaskSemanticKeySha256(value: ProbeBrokerTask): string;
export function deriveProbeBrokerTaskPhysicalOperationKeySha256(value: ProbeBrokerTask): string;
export function verifyProbeBrokerTaskSignature(
  value: unknown,
  options: ProbeBrokerTaskSignatureVerificationOptions,
): ProbeBrokerTask;
export function deriveProbeBrokerDriverValidationReceiptDigest(
  value: ProbeBrokerDriverValidationReceiptDraft | ProbeBrokerDriverValidationReceipt,
): string;
export function createProbeBrokerDriverValidationReceipt(
  input: ProbeBrokerDriverValidationReceiptCreateInput,
): ProbeBrokerDriverValidationReceipt;
export function validateProbeBrokerDriverValidationReceipt(
  value: unknown,
): ProbeBrokerDriverValidationReceipt;
export function acceptProbeBrokerTask(
  value: unknown,
  options: ProbeBrokerTaskAcceptanceOptions,
): Promise<ProbeAcceptedBrokerTaskContext>;

export function deriveProbeBrokerResultDigest(
  value: ProbeBrokerResultDraft | ProbeBrokerResult,
): string;
export function createProbeBrokerResult(input: ProbeBrokerResultCreateInput): ProbeBrokerResult;
export function validateProbeBrokerResult(value: unknown): ProbeBrokerResult;
export function getProbeBrokerAcceptedContextExecutionAuthorityLease(
  acceptedContext: ProbeAcceptedBrokerTaskContext,
): ProbeBrokerExecutionAuthorityLease;

/**
 * Requires a fresh confirmation from the exact live authority lease bound during durable task
 * acceptance, then validates result-to-task and authenticated local boot/session binding.
 */
export function validateProbeBrokerResultForTask(
  value: unknown,
  acceptedContext: ProbeAcceptedBrokerTaskContext,
  executionAuthorityConfirmation: ProbeBrokerExecutionAuthorityConfirmation,
): Promise<ProbeBrokerResult>;
export function validateProbeBrokerResultForTaskUnderLiveAuthority(
  value: unknown,
  acceptedContext: ProbeAcceptedBrokerTaskContext,
): Promise<ProbeBrokerResult>;
export function createProbeBrokerControllerAcceptanceInput(
  value: unknown,
  acceptedContext: ProbeAcceptedBrokerTaskContext,
  executionAuthorityConfirmation: ProbeBrokerExecutionAuthorityConfirmation,
): Promise<ProbeBrokerControllerAcceptanceInput>;
export function createProbeBrokerControllerAcceptanceInputUnderLiveAuthority(
  value: unknown,
  acceptedContext: ProbeAcceptedBrokerTaskContext,
): Promise<ProbeBrokerControllerAcceptanceInput>;
export function validateProbeBrokerControllerAcceptanceInput(
  value: unknown,
): ProbeBrokerControllerAcceptanceInput;
export function validateProbeBrokerControllerAcceptanceInputForTask(
  value: unknown,
  task: ProbeBrokerTask,
  result: ProbeBrokerResult,
): ProbeBrokerControllerAcceptanceInput;
