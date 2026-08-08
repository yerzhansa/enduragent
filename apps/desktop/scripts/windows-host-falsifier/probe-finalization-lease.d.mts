export const PROBE_FINALIZATION_INTENT_SCHEMA_VERSION: 1;
export const PROBE_QUIESCENCE_LEASE_SCHEMA_VERSION: 1;

export class ProbeFinalizationLeaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeFinalizationIntent {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-finalization-intent";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly environmentId: string;
  readonly pathProfileId: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly continuationChainIds: readonly string[];
  readonly upstreamSelectionDigests: readonly string[];
  readonly startedAt: string;
  readonly finalizationOperationSha256: string;
}

export interface ProbeControllerIdentity {
  readonly identitySha256: string;
  readonly publicKeySha256: string;
  readonly version: string;
}

export interface ProbeQuiescenceLeaseReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-quiescence-lease-receipt";
  readonly finalizationOperationSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly renewalSequence: number;
  readonly actorSetSha256: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly state: "active";
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeSegmentProof {
  readonly segmentPath: string;
  readonly segmentSha256: string;
  readonly segmentArtifactSha256: string;
  readonly verificationInputSha256: string;
  readonly outcomeEvidenceSha256: string;
}

export interface ProbeQuiescenceCompletionReceipt extends ProbeSegmentProof {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-quiescence-completion-receipt";
  readonly finalizationOperationSha256: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly leaseReceiptSha256: string;
  readonly evidenceCaptureReceiptSha256: string;
  readonly completedAt: string;
  readonly state: "completed";
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeQuiescenceAbandonmentReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-quiescence-abandonment-receipt";
  readonly finalizationOperationSha256: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly leaseReceiptSha256: string;
  readonly reasonCode: string;
  readonly abandonedAt: string;
  readonly state: "abandoned";
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeSegmentCommitMarker extends ProbeSegmentProof {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-segment-commit";
  readonly finalizationOperationSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly acquisitionReceiptSha256: string;
  readonly finalLeaseReceiptSha256: string;
  readonly evidenceCaptureReceiptSha256: string;
  readonly completionReceiptSha256: string;
  readonly commitSha256: string;
}

export function deriveProbeFinalizationOperationDigest(
  value: Omit<ProbeFinalizationIntent, "finalizationOperationSha256"> | ProbeFinalizationIntent,
): string;
export function deriveProbeQuiescenceLeaseReceiptDigest(
  value:
    | Omit<ProbeQuiescenceLeaseReceipt, "receiptSha256" | "signatureBase64">
    | ProbeQuiescenceLeaseReceipt,
): string;
export function deriveProbeQuiescenceCompletionReceiptDigest(
  value:
    | Omit<ProbeQuiescenceCompletionReceipt, "receiptSha256" | "signatureBase64">
    | ProbeQuiescenceCompletionReceipt,
): string;
export function deriveProbeQuiescenceAbandonmentReceiptDigest(
  value:
    | Omit<ProbeQuiescenceAbandonmentReceipt, "receiptSha256" | "signatureBase64">
    | ProbeQuiescenceAbandonmentReceipt,
): string;
export function deriveProbeSegmentCommitDigest(
  value: Omit<ProbeSegmentCommitMarker, "commitSha256"> | ProbeSegmentCommitMarker,
): string;
export function validateProbeFinalizationIntent(value: unknown): ProbeFinalizationIntent;
export function validateProbeQuiescenceLeaseReceipt(value: unknown): ProbeQuiescenceLeaseReceipt;
export function verifyProbeQuiescenceLeaseReceipt(
  value: unknown,
  options: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly expectedController: ProbeControllerIdentity;
  },
): ProbeQuiescenceLeaseReceipt;
export function verifyProbeQuiescenceLeaseTransition(
  value: unknown,
  options: {
    readonly previousReceipt: ProbeQuiescenceLeaseReceipt;
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly expectedController: ProbeControllerIdentity;
  },
): ProbeQuiescenceLeaseReceipt;
export function validateProbeQuiescenceCompletionReceipt(
  value: unknown,
): ProbeQuiescenceCompletionReceipt;
export function verifyProbeQuiescenceCompletionReceipt(
  value: unknown,
  options: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly evidenceCaptureReceiptSha256: string;
    readonly segmentProof: ProbeSegmentProof;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly expectedController: ProbeControllerIdentity;
  },
): ProbeQuiescenceCompletionReceipt;
export function validateProbeQuiescenceAbandonmentReceipt(
  value: unknown,
): ProbeQuiescenceAbandonmentReceipt;
export function verifyProbeQuiescenceAbandonmentReceipt(
  value: unknown,
  options: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly expectedController: ProbeControllerIdentity;
  },
): ProbeQuiescenceAbandonmentReceipt;
export function validateProbeSegmentCommitMarker(value: unknown): ProbeSegmentCommitMarker;
export function verifyProbeSegmentCommitMarker(
  value: unknown,
  options: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly acquisitionReceipt: ProbeQuiescenceLeaseReceipt;
    readonly finalLeaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly completionReceipt: ProbeQuiescenceCompletionReceipt;
  },
): ProbeSegmentCommitMarker;
