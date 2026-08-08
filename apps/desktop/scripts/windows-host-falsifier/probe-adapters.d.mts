import type { EvidenceStore } from "./evidence-store.mjs";
import type {
  ProbeBrokerEnrollment,
  ProbeBrokerMailboxObservation,
} from "./broker/mailbox-protocol.mjs";
import type { ProbeArtifactHash, ProbeCandidateIdentity } from "./probe-contract.mjs";
import type {
  ControllerEvidenceSealReceipt,
  NativeEvidenceSeal,
  ProbeFinalizerAdapters,
  ProbeFinalizerSealBinding,
} from "./probe-finalizer.mjs";
import type {
  ProbeFinalizationIntent,
  ProbeQuiescenceAbandonmentReceipt,
  ProbeQuiescenceCompletionReceipt,
  ProbeQuiescenceLeaseReceipt,
  ProbeSegmentProof,
} from "./probe-finalization-lease.mjs";
import type {
  ProbeControllerObservation,
  ProbeGuestObservation,
  ProbePreparationPersistence,
  ProbePreparationTransaction,
  ProbePreflightReaders,
  ProbePreflightRequest,
  ProbeRepositoryState,
  ProbeVerifiedArtifact,
} from "./probe-preflight.mjs";

export const PROBE_CONTRACT_SOURCE_PATH: string;
export const PROBE_REGISTRY_SOURCE_PATH: string;
export const PROBE_TRANSCRIPT_SOURCE_PATH: string;
export const NATIVE_CLIENT_SOURCE_PATH: string;
export const NATIVE_MANIFEST_DIGEST_SOURCE_PATH: string;
export const PROBE_VERIFIER_SOURCE_PATHS: readonly string[];

export class ProbeAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeRepositoryIdentity {
  readonly repositoryCommit: string;
  readonly repositoryDirty: boolean;
}

export type ProbeRepositoryIdentityReader = (
  repositoryRoot: string,
) => Promise<ProbeRepositoryIdentity>;

export type ProbeFilesystemArtifactReader = (
  reference: ProbeArtifactHash,
) => Promise<ProbeVerifiedArtifact>;

export interface ProbeCandidateSourceReaders {
  readonly readContractSource: () => Promise<Uint8Array>;
  readonly readVerifierSource: () => Promise<Uint8Array>;
  readonly readTranscriptSource: () => Promise<Uint8Array>;
  readonly readNativeClientSource: () => Promise<Uint8Array>;
  readonly readNativeManifestDigestSource: () => Promise<Uint8Array>;
}

export interface ProbeGuestObserverInput {
  readonly request: ProbePreflightRequest;
  readonly evidenceRoot: string;
}

export type ProbeGuestObserver = (input: ProbeGuestObserverInput) => Promise<ProbeGuestObservation>;

export interface ProbeBrokerMailboxObserverInput {
  readonly enrollment: ProbeBrokerEnrollment;
  readonly request: ProbePreflightRequest;
  readonly evidenceRoot: string;
}

export type ProbeBrokerMailboxObserver = (
  input: ProbeBrokerMailboxObserverInput,
) => Promise<ProbeBrokerMailboxObservation>;

export interface ProbePreflightControllerTransport {
  readonly observeController: (input: {
    readonly request: ProbePreflightRequest;
    readonly evidenceRoot: string;
  }) => Promise<ProbeControllerObservation>;
}

export interface ProbeFinalizerControllerTransport {
  readonly recoverOrAcquireEvidenceQuiescence: (input: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly evidenceRoot: string;
  }) => Promise<{
    readonly acquisitionReceipt: ProbeQuiescenceLeaseReceipt;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly completionReceipt: ProbeQuiescenceCompletionReceipt | null;
  }>;
  readonly renewEvidenceQuiescence: (input: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly previousLeaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly purpose: "capture" | "completion";
    readonly evidenceRoot: string;
  }) => Promise<ProbeQuiescenceLeaseReceipt>;
  readonly captureQuiescedEvidenceSeal: (input: {
    readonly binding: ProbeFinalizerSealBinding;
    readonly evidenceRoot: string;
  }) => Promise<{
    readonly nativeSeal: NativeEvidenceSeal;
    readonly controllerReceipt: ControllerEvidenceSealReceipt;
  }>;
  readonly completeEvidenceQuiescence: (input: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly evidenceCaptureReceiptSha256: string;
    readonly segmentProof: ProbeSegmentProof;
    readonly evidenceRoot: string;
  }) => Promise<ProbeQuiescenceCompletionReceipt>;
  readonly abandonEvidenceQuiescence: (input: {
    readonly finalizationIntent: ProbeFinalizationIntent;
    readonly leaseReceipt: ProbeQuiescenceLeaseReceipt;
    readonly reasonCode: string;
    readonly evidenceRoot: string;
  }) => Promise<ProbeQuiescenceAbandonmentReceipt>;
}

export interface ProbeControllerTransport
  extends ProbePreflightControllerTransport, ProbeFinalizerControllerTransport {}

export function createProbeFilesystemArtifactReader(options: {
  readonly root: string;
  readonly maximumArtifactBytes?: number;
}): Promise<ProbeFilesystemArtifactReader>;

export function createProbeEvidenceStoreArtifactReader(options: {
  readonly store: EvidenceStore;
}): ProbeFilesystemArtifactReader;

export function readProbeCandidateSourceHashes(options: {
  readonly repositoryRoot: string;
  readonly sourceHashes: readonly ProbeArtifactHash[];
}): Promise<readonly ProbeArtifactHash[]>;

export function createProbeCandidateSourceReaders(options: {
  readonly repositoryRoot: string;
}): Promise<ProbeCandidateSourceReaders>;

export function createProbeRepositoryStateReader(options: {
  readonly repositoryRoot: string;
  readonly sourceHashes: readonly ProbeArtifactHash[];
  readonly readRepositoryIdentity?: ProbeRepositoryIdentityReader;
}): Promise<() => Promise<ProbeRepositoryState>>;

export function createProbePreparationTransactionPersistence(options: {
  readonly store: EvidenceStore;
}): (transaction: ProbePreparationTransaction) => Promise<ProbePreparationPersistence>;

export function createProbePreparationTransactionReader(options: {
  readonly store: EvidenceStore;
}): (requestSha256: string) => Promise<ProbePreparationTransaction | null>;

export function createProbePreflightReaders(options: {
  readonly store: EvidenceStore;
  readonly repositoryRoot: string;
  readonly binaryRoot?: string;
  readonly candidate: Pick<ProbeCandidateIdentity, "sourceHashes">;
  readonly observeGuest: ProbeGuestObserver;
  readonly observeBrokerMailbox: ProbeBrokerMailboxObserver;
  readonly controllerTransport: ProbePreflightControllerTransport;
  readonly readRepositoryIdentity?: ProbeRepositoryIdentityReader;
}): Promise<ProbePreflightReaders>;

export function createProbeFinalizerAdapters(options: {
  readonly store: EvidenceStore;
  readonly repositoryRoot: string;
  readonly candidate: Pick<ProbeCandidateIdentity, "sourceHashes">;
  readonly controllerTransport: ProbeFinalizerControllerTransport;
  readonly readRepositoryIdentity?: ProbeRepositoryIdentityReader;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}): Promise<ProbeFinalizerAdapters>;
