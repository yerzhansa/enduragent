import type {
  ProbeArtifactHash,
  ProbeSegmentOutcome,
  ProbeVerificationMetric,
  ProbeVerifierId,
} from "./probe-contract.mjs";
import type {
  ProbeRawFactEnvelope,
  ProbeRowFacts,
  ProbeTranscriptFactDefinition,
  ProbeVerifierDefinition,
  ProbeVerifiedFactsResult,
} from "./probe-registry.mjs";
import type {
  ProbeControllerSourceTranscriptReceipt,
  ProbeSourceTranscriptBinding,
  ProbeTranscriptControllerIdentity,
  ProbeTranscriptProducer,
  ProbeTranscriptFacts,
  TrustedProbeTranscriptDefinition,
} from "./probe-transcript.mjs";
import type { NativeCommandTranscript } from "./native-client.mjs";

export class ProbeVerifierIsolateError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface RetainedProbeVerifier {
  getDefinition(rowId: string, variantId: string): Promise<ProbeVerifierDefinition>;
  getTranscriptFactDefinition(
    rowId: string,
    variantId: string,
  ): Promise<ProbeTranscriptFactDefinition>;
  verify(input: {
    readonly rowId: string;
    readonly variantId: string;
    readonly rawFacts: ProbeRawFactEnvelope<ProbeRowFacts>;
    readonly artifactHashes: readonly ProbeArtifactHash[];
    readonly verifierSourceSha256: string;
  }): Promise<
    ProbeVerifiedFactsResult & {
      readonly outcome: ProbeSegmentOutcome;
      readonly verifierId: ProbeVerifierId;
      readonly verificationMetrics: readonly ProbeVerificationMetric[];
    }
  >;
  reduceTranscript(input: {
    readonly sourceTranscriptBytes: Uint8Array;
    readonly expectedBinding: ProbeSourceTranscriptBinding;
    readonly expectedProducer: ProbeTranscriptProducer;
    readonly expectedController: ProbeTranscriptControllerIdentity;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly controllerReceipt: ProbeControllerSourceTranscriptReceipt;
    readonly trustedNativeTranscriptBytes: readonly Uint8Array[];
    readonly trustedControllerActionAttestationBytes: readonly Uint8Array[];
    readonly trustedDefinition: TrustedProbeTranscriptDefinition;
  }): Promise<ProbeRawFactEnvelope<ProbeTranscriptFacts>>;
  validateNativeTranscript(bytes: Uint8Array): Promise<NativeCommandTranscript>;
}

export function loadRetainedProbeVerifier(options: {
  readonly registrySourceBytes: Uint8Array;
  readonly contractSourceBytes: Uint8Array;
  readonly transcriptSourceBytes?: Uint8Array;
  readonly nativeClientSourceBytes?: Uint8Array;
  readonly nativeManifestDigestSourceBytes?: Uint8Array;
  readonly nodeExecutable?: string;
  readonly timeoutMs?: number;
}): Promise<RetainedProbeVerifier>;

export function assertVerifierSourceDigests(options: {
  readonly registrySourceBytes: Uint8Array;
  readonly registrySourceSha256: string;
  readonly contractSourceBytes: Uint8Array;
  readonly contractSourceSha256: string;
}): void;
