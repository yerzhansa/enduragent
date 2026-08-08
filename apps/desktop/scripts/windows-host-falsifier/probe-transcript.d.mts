import type { ProbeEnvironmentId, ProbePathProfileId } from "./probe-contract.mjs";
import type { NativeStartupHandshake } from "./native-client.mjs";
import type { ProbeFactAvailability, ProbeRawFactEnvelope } from "./probe-registry.mjs";

export class ProbeTranscriptError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeTranscriptProducerKind = "native-helper" | "external-controller";

export interface ProbeTranscriptProducer {
  readonly kind: ProbeTranscriptProducerKind;
  readonly identitySha256: string;
}

export interface ProbeTranscriptControllerIdentity {
  readonly identitySha256: string;
  readonly publicKeySha256: string;
  readonly version: string;
}

export interface ProbeControllerSourceTranscriptReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-source-transcript-receipt";
  readonly sourceTranscriptSha256: string;
  readonly bindingSha256: string;
  readonly producerKind: ProbeTranscriptProducerKind;
  readonly producerIdentitySha256: string;
  readonly nativeTranscriptSetSha256: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeSourceTranscriptBinding {
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly labAttestationSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly preflightSha256: string;
  readonly preparationScopeSha256: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly vmSnapshotId: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly rootPathSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly volumeIdSha256: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly verifierDefinitionSha256: string;
  readonly verifierSourceSha256: string;
}

export interface ProbeNativeTranscriptBinding {
  readonly campaignRunId: string;
  readonly candidateSha256: string;
  readonly preflightSha256: string;
  readonly executionBundleManifestSha256: string;
  readonly nativeHelperArtifactPath: string;
  readonly nativeHelperSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly nativeCandidateDigest: string;
  readonly nativeManifestSha256: string;
  readonly nativeSessionId: string;
  readonly runRootIdentity: string;
  readonly startupHandshake: NativeStartupHandshake;
  readonly startupHandshakeSha256: string;
}

export interface ProbeNativeTranscriptIdentity {
  readonly transcriptSha256: string;
  readonly binding: ProbeNativeTranscriptBinding;
}

export interface ProbeTrustedNativeTranscriptEvidence extends ProbeNativeTranscriptIdentity {
  readonly commandRecords: readonly {
    readonly command: string;
    readonly requestFrameSha256: string;
    readonly responseFrameSha256: string;
    readonly ok: boolean;
  }[];
}

export type ProbeTranscriptPrimitive = null | boolean | number | string;
export type ProbeTranscriptFactValue =
  | ProbeTranscriptPrimitive
  | readonly boolean[]
  | readonly number[]
  | readonly string[];

export interface ProbeTranscriptObservation {
  readonly factKey: string;
  readonly valueKind:
    | "null"
    | "boolean"
    | "number"
    | "string"
    | "boolean-array"
    | "number-array"
    | "string-array";
  readonly value: ProbeTranscriptFactValue;
}

export interface ProbeTranscriptCommandEvent {
  readonly sequence: number;
  readonly producerKind: ProbeTranscriptProducerKind;
  readonly actionAttestationSha256: string | null;
  readonly commandId: string;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly nativeTranscriptSha256s: readonly string[];
  readonly observations: readonly ProbeTranscriptObservation[];
}

export interface ProbeSourceTranscript {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-source-transcript";
  readonly producer: ProbeTranscriptProducer;
  readonly binding: ProbeSourceTranscriptBinding;
  readonly nativeTranscripts: readonly ProbeNativeTranscriptIdentity[];
  readonly observerNativeTranscriptSha256s: readonly string[];
  readonly captureComplete: boolean;
  readonly availability: ProbeFactAvailability;
  readonly commandEvents: readonly ProbeTranscriptCommandEvent[];
}

export interface ProbeTranscriptCommandDefinition {
  readonly commandId: string;
  readonly factKeys: readonly string[];
}

export interface TrustedProbeTranscriptDefinition {
  readonly rowId: string;
  readonly variantId: string;
  readonly definitionSha256: string;
  readonly verifierSourceSha256: string;
  readonly transcriptKind:
    | "windows-host-probe-controller-transcript"
    | "windows-host-probe-native-transcript";
  readonly commands: readonly ProbeTranscriptCommandDefinition[];
}

export type ProbeTranscriptFacts = Readonly<Record<string, ProbeTranscriptFactValue>>;

export function deriveControllerSourceTranscriptReceiptDigest(
  value:
    | Omit<ProbeControllerSourceTranscriptReceipt, "signatureBase64" | "receiptSha256">
    | ProbeControllerSourceTranscriptReceipt,
): string;

export function reduceProbeSourceTranscript(input: {
  readonly sourceTranscriptBytes: Uint8Array;
  readonly expectedBinding: ProbeSourceTranscriptBinding;
  readonly expectedProducer: ProbeTranscriptProducer;
  readonly expectedController: ProbeTranscriptControllerIdentity;
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly controllerReceipt: ProbeControllerSourceTranscriptReceipt;
  readonly trustedNativeTranscripts: readonly ProbeTrustedNativeTranscriptEvidence[];
  readonly trustedControllerActionAttestationBytes: readonly Uint8Array[];
  readonly trustedDefinition: TrustedProbeTranscriptDefinition;
}): ProbeRawFactEnvelope<ProbeTranscriptFacts>;
