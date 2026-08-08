import type { EvidenceStore } from "./evidence-store.mjs";
import type {
  ProbeCampaignManifest,
  ProbeCandidateIdentity,
  ProbeEnvironmentId,
  ProbeLabAttestation,
  ProbePathProfileId,
  ProbeSegmentRecord,
} from "./probe-contract.mjs";
import type { PreparedProbeContext, ProbeRepositoryState } from "./probe-preflight.mjs";
import type {
  ProbeFinalizationIntent,
  ProbeQuiescenceAbandonmentReceipt,
  ProbeQuiescenceCompletionReceipt,
  ProbeQuiescenceLeaseReceipt,
  ProbeSegmentCommitMarker,
  ProbeSegmentProof,
} from "./probe-finalization-lease.mjs";
import type {
  ProbeRunAuthorization,
  ProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";

export class ProbeFinalizerError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface NativeEvidenceSeal {
  readonly mode: "exact-paths";
  readonly rootObjectIdentity: string;
  readonly entryCount: number;
  readonly entries: readonly {
    readonly path: string;
    readonly type: "file";
    readonly bytes: number;
    readonly sha256: string;
    readonly objectIdentity: string;
  }[];
  readonly totalBytes: number;
  readonly setSha256: string;
}

export interface ControllerEvidenceSealReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-evidence-seal-receipt";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly runAuthorizationSha256: string;
  readonly finalizationOperationSha256: string;
  readonly quiescenceLeaseId: string;
  readonly quiescenceLeaseEpoch: number;
  readonly quiescenceRenewalSequence: number;
  readonly quiescenceLeaseReceiptSha256: string;
  readonly quiescenceActorSetSha256: string;
  readonly quiescenceAcquiredAt: string;
  readonly quiescenceLeaseExpiresAt: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly nativeSealSha256: string;
  readonly actorsQuiesced: true;
  readonly capturedAt: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeSegmentArtifactPaths {
  readonly base: string;
  readonly rawFacts: string;
  readonly evidence: string;
  readonly sourceTranscript: string;
  readonly sourceTranscriptReceipt: string;
  readonly nativeTranscripts: string;
  readonly preparedContext: string;
  readonly finalizationIntent: string;
  readonly quiescenceAcquisitionReceipt: string;
  readonly quiescenceCaptureLeaseReceipt: string;
  readonly nativeSeal: string;
  readonly controllerSealReceipt: string;
  readonly segment: string;
  readonly quiescenceCompletionLeaseReceipt: string;
  readonly quiescenceCompletionReceipt: string;
  readonly segmentCommit: string;
  readonly quiescenceAbandonmentReceipt: string;
}

export interface ProbeFinalizerSealBinding {
  readonly finalizationIntent: ProbeFinalizationIntent;
  readonly quiescenceLease: ProbeQuiescenceLeaseReceipt;
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly exactArtifactPaths: readonly string[];
}

export interface ProbeFinalizerAdapters {
  readonly readRepositoryState: () => Promise<ProbeRepositoryState>;
  readonly readVerifierSource: () => Promise<Uint8Array>;
  readonly readContractSource: () => Promise<Uint8Array>;
  readonly readTranscriptSource: () => Promise<Uint8Array>;
  readonly readNativeClientSource: () => Promise<Uint8Array>;
  readonly readNativeManifestDigestSource: () => Promise<Uint8Array>;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly recoverOrAcquireEvidenceQuiescence: (request: {
    readonly finalizationIntent: ProbeFinalizationIntent;
  }) => Promise<{
    readonly acquisitionReceipt: ProbeQuiescenceLeaseReceipt;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly completionReceipt: ProbeQuiescenceCompletionReceipt | null;
  }>;
  readonly renewEvidenceQuiescence: (request: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly previousLeaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly purpose: "capture" | "completion";
  }) => Promise<ProbeQuiescenceLeaseReceipt>;
  readonly captureQuiescedEvidenceSeal: (binding: ProbeFinalizerSealBinding) => Promise<{
    readonly nativeSeal: NativeEvidenceSeal;
    readonly controllerReceipt: ControllerEvidenceSealReceipt;
  }>;
  readonly completeEvidenceQuiescence: (request: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly evidenceCaptureReceiptSha256: string;
    readonly segmentProof: ProbeSegmentProof;
  }) => Promise<ProbeQuiescenceCompletionReceipt>;
  readonly abandonEvidenceQuiescence: (request: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly reasonCode: string;
  }) => Promise<ProbeQuiescenceAbandonmentReceipt>;
}

export function probeSegmentArtifactPaths(input: {
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
}): ProbeSegmentArtifactPaths;

export function deriveControllerEvidenceSealReceiptDigest(
  value:
    | Omit<ControllerEvidenceSealReceipt, "receiptSha256" | "signatureBase64">
    | ControllerEvidenceSealReceipt,
): string;

export function verifyControllerEvidenceSealReceipt(
  receipt: ControllerEvidenceSealReceipt,
  options: {
    readonly preparedContext: PreparedProbeContext;
    readonly nativeSeal: NativeEvidenceSeal;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly rowId: string;
    readonly variantId: string;
    readonly runAuthorization: ProbeRunAuthorization;
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly quiescenceLease: ProbeQuiescenceLeaseReceipt;
  },
): ControllerEvidenceSealReceipt;

export function finalizeProbeSegment(options: {
  readonly store: EvidenceStore;
  readonly preparedContext: PreparedProbeContext;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
  readonly runAuthorization: ProbeRunAuthorization;
  readonly runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt;
  readonly rowId: string;
  readonly variantId: string;
  readonly continuationChainIds: readonly string[];
  readonly upstreamSelectionDigests: readonly string[];
  readonly provenance: {
    readonly startedAt: string;
    readonly startedMonotonicMs: number;
  };
  readonly adapters: ProbeFinalizerAdapters;
}): Promise<{
  readonly segment: ProbeSegmentRecord;
  readonly path: string;
  readonly commit: ProbeSegmentCommitMarker;
  readonly commitPath: string;
}>;

export function verifyFinalizedProbeSegment(options: {
  readonly store: EvidenceStore;
  readonly segmentPath: string;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
}): Promise<ProbeSegmentRecord>;

export function verifyCommittedProbeSegment(options: {
  readonly store: EvidenceStore;
  readonly commitPath: string;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestation: ProbeLabAttestation;
}): Promise<{
  readonly segment: ProbeSegmentRecord;
  readonly path: string;
  readonly commit: ProbeSegmentCommitMarker;
  readonly commitPath: string;
  readonly runAuthorization: ProbeRunAuthorization;
  readonly runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt;
}>;

export interface VerifiedProbeCampaignResult {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-campaign-result";
  readonly authority: "verified-artifact-finalizer";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly phase: "probe";
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly selectionEligible: boolean;
  readonly rowClosureClaimed: false;
  readonly issues: readonly Readonly<Record<string, unknown>>[];
  readonly rowResults: readonly Readonly<Record<string, unknown>>[];
  readonly analysisSha256: string;
  readonly verifiedSegmentDigests: readonly string[];
  readonly campaignResultSha256: string;
}

export function finalizeProbeCampaign(options: {
  readonly manifest: ProbeCampaignManifest;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestations: readonly ProbeLabAttestation[];
  readonly segmentSources: readonly {
    readonly store: EvidenceStore;
    readonly commitPath: string;
  }[];
}): Promise<VerifiedProbeCampaignResult>;

export function readDefaultProbeVerifierSource(): Promise<Buffer>;
export function readDefaultProbeContractSource(): Promise<Buffer>;
export function readDefaultProbeTranscriptSource(): Promise<Buffer>;
export function readDefaultNativeClientSource(): Promise<Buffer>;
export function readDefaultNativeManifestDigestSource(): Promise<Buffer>;
