import type {
  ProbeArtifactHash,
  ProbeCandidateIdentity,
  ProbeCampaignManifest,
  ProbeEnvironmentId,
  ProbeLabAttestation,
  ProbePathProfileId,
} from "./probe-contract.mjs";
import type {
  ProbeRunAuthorization,
  ProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";
import type {
  ProbeBrokerEnrollment,
  ProbeBrokerMailboxObservation,
  ProbePreparedBrokerEnrollment,
} from "./broker/mailbox-protocol.mjs";

export interface ProbeLifecycleMapping {
  readonly environmentId: ProbeEnvironmentId;
  readonly role: "floor" | "current";
  readonly windowsVersion: "24H2" | "25H2";
  readonly minimumBuild: number;
  readonly maximumBuild: number | null;
  readonly supportedFrom: string;
  readonly supportedUntil: string;
  readonly declaredSupported: true;
}

export interface ProbeLifecyclePolicy {
  readonly policyId: string;
  readonly evaluatedAt: string;
  readonly mappings: readonly ProbeLifecycleMapping[];
}

export interface ProbePreflightRequest {
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly vmSnapshotId: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly nativeHelperArtifactPath: string;
  readonly nativeCandidateDigest: string;
  readonly nativeManifestSha256: string;
  readonly nsisArtifactPath: string;
}

export interface ProbeRepositoryState {
  readonly repositoryCommit: string;
  readonly repositoryDirty: boolean;
  readonly sourceHashes: readonly ProbeArtifactHash[];
}

export interface ProbePathProfileObservation {
  readonly profileId: ProbePathProfileId;
  readonly rootPathSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly volumeIdSha256: string;
  readonly localAbsolute: boolean;
  readonly networkPath: boolean;
  readonly removableVolume: boolean;
  readonly reparsePoint: boolean;
  readonly nfcNormalized: boolean;
  readonly containsSpaces: boolean;
  readonly containsUnicode: boolean;
}

export interface ProbeGuestObservation {
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly host: ProbeLabAttestation["host"];
  readonly snapshot: ProbeLabAttestation["snapshot"];
  readonly runner: ProbeLabAttestation["runner"];
  readonly runtime: ProbeLabAttestation["runtime"];
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly pathProfile: ProbePathProfileObservation;
  readonly guestEvidence: ProbeArtifactHash;
}

export interface ProbeControllerActors {
  readonly powerControlActorSha256: string;
  readonly snapshotControlActorSha256: string;
  readonly remotePeerActorSha256: string;
  readonly secondUserSidSha256: string;
}

export interface ProbeExecutionActors extends ProbeControllerActors {
  readonly primaryStandardUserSidSha256: string;
}

export interface ProbeControllerObservation {
  readonly identitySha256: string;
  readonly publicKeySha256: string;
  readonly version: string;
  readonly vmSnapshotId: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly capabilities: ProbeLabAttestation["capabilities"];
  readonly actors: ProbeControllerActors;
  readonly controllerEvidence: ProbeArtifactHash;
  readonly publicKeyArtifact: ProbeArtifactHash;
}

export interface ProbeVerifiedArtifact extends ProbeArtifactHash {
  readonly bytes: Uint8Array;
  readonly stableRead: true;
  readonly regularFile: true;
}

export interface ProbePreparationTransaction {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-preparation-transaction";
  readonly requestSha256: string;
  readonly scopeSha256: string;
  readonly claimReceiptSha256: string;
  readonly preparedContext: PreparedProbeContext;
  readonly transactionSha256: string;
}

export interface ProbePreparationPersistence {
  readonly transaction: ProbePreparationTransaction;
  readonly reused: boolean;
}

export interface ProbePreflightReaders {
  readonly readPreparationTransaction: (
    requestSha256: string,
  ) => Promise<ProbePreparationTransaction | null>;
  readonly readRepositoryState: () => Promise<ProbeRepositoryState>;
  readonly observeGuest: (request: ProbePreflightRequest) => Promise<ProbeGuestObservation>;
  readonly observeController: (
    request: ProbePreflightRequest,
  ) => Promise<ProbeControllerObservation>;
  readonly observeBrokerMailbox: (
    enrollment: ProbeBrokerEnrollment,
    request: ProbePreflightRequest,
  ) => Promise<ProbeBrokerMailboxObservation>;
  readonly readVerifiedEvidenceArtifact: (
    reference: ProbeArtifactHash,
  ) => Promise<ProbeVerifiedArtifact>;
  readonly readVerifiedBinaryArtifact: (
    reference: ProbeArtifactHash,
  ) => Promise<ProbeVerifiedArtifact>;
  readonly persistPreparation: (
    transaction: ProbePreparationTransaction,
  ) => Promise<ProbePreparationPersistence>;
}

export interface ProbeExecutionBundleManifestFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-execution-bundle";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly labAttestationSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly authorization: {
    readonly runPlanSha256: string;
    readonly runAuthorizationSha256: string;
    readonly claimReceiptSha256: string;
    readonly operatorKeyId: string;
    readonly operatorPublicKeySha256: string;
    readonly trustStoreId: string;
    readonly trustStoreGeneration: number;
    readonly trustStoreSha256: string;
    readonly verifiedAt: string;
    readonly authorizationExpiresAt: string;
  };
  readonly repository: {
    readonly repositoryCommit: string;
    readonly sourceSetSha256: string;
  };
  readonly lifecyclePolicySha256: string;
  readonly trustedEvaluationAt: string;
  readonly vm: {
    readonly vmSnapshotId: string;
    readonly bootIdSha256: string;
    readonly runnerSessionIdSha256: string;
  };
  readonly runtime: ProbeLabAttestation["runtime"];
  readonly controller: {
    readonly identitySha256: string;
    readonly publicKeySha256: string;
    readonly publicKeyArtifact: ProbeArtifactHash;
    readonly version: string;
  };
  readonly actors: ProbeExecutionActors;
  readonly brokerEnrollments: readonly ProbePreparedBrokerEnrollment[];
  readonly evidenceArtifacts: readonly ProbeArtifactHash[];
  readonly binaries: {
    readonly nativeHelper: ProbeArtifactHash & {
      readonly machine: "x64";
      readonly nativeCandidateDigest: string;
      readonly nativeManifestSha256: string;
    };
    readonly nsis: ProbeArtifactHash;
  };
}

export interface ProbeExecutionBundleManifest extends ProbeExecutionBundleManifestFields {
  readonly executionBundleManifestSha256: string;
}

export interface PreparedProbeContextFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-prepared-context";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly labAttestationSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly vmSnapshotId: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly lifecyclePolicySha256: string;
  readonly trustedEvaluationAt: string;
  readonly controllerPublicKeyArtifact: ProbeArtifactHash;
  readonly pathProfileObservation: ProbePathProfileObservation;
  readonly executionBundleManifest: ProbeExecutionBundleManifest;
  readonly preparationScopeSha256: string;
  readonly preparationClaimReceiptSha256: string;
}

export interface PreparedProbeContext extends PreparedProbeContextFields {
  readonly preflightSha256: string;
}

export class ProbePreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function deriveProbeExecutionBundleManifestDigest(
  value: ProbeExecutionBundleManifestFields | ProbeExecutionBundleManifest,
): string;
export function deriveProbePreparationScopeDigest(
  value: Omit<
    PreparedProbeContextFields,
    "preparationScopeSha256" | "preparationClaimReceiptSha256"
  >,
): string;
export function deriveProbePreparationClaimReceiptDigest(scopeSha256: string): string;
export function deriveProbePreparationRequestDigest(request: ProbePreflightRequest): string;
export function derivePreparedProbeContextDigest(
  value: PreparedProbeContextFields | PreparedProbeContext,
): string;
export function deriveProbePreparationTransactionDigest(
  value: Omit<ProbePreparationTransaction, "transactionSha256"> | ProbePreparationTransaction,
): string;
export function validatePreparedProbeContext(value: unknown): PreparedProbeContext;
export function validateProbePreparationTransaction(value: unknown): ProbePreparationTransaction;
export function prepareAuthoritativeProbeContext(input: {
  readonly manifest: ProbeCampaignManifest;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
  readonly runAuthorization: ProbeRunAuthorization;
  readonly runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt;
  readonly request: ProbePreflightRequest;
  readonly lifecyclePolicy: ProbeLifecyclePolicy;
  readonly brokerEnrollments: readonly ProbeBrokerEnrollment[];
  readonly readers: ProbePreflightReaders;
  readonly now: () => Date;
}): Promise<PreparedProbeContext>;
