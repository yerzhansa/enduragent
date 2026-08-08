export const PROBE_CONTRACT_SCHEMA_VERSION: 1;
export const PROBE_CAMPAIGN_ID: "f01-f10-native-probe-v1";
export const PROBE_ENVIRONMENT_IDS: readonly ["win11-floor", "win11-current"];
export const PROBE_PATH_PROFILE_IDS: readonly ["ascii", "spaces-unicode"];
export const PROBE_SEGMENT_OUTCOMES: readonly ["PASS", "FAIL", "INCONCLUSIVE", "SKIP"];
export const PROBE_VERIFIER_IDS: readonly [
  "hard-cut-probe-verifier-v1",
  "native-probe-verifier-v1",
];

export type ProbeEnvironmentId = (typeof PROBE_ENVIRONMENT_IDS)[number];
export type ProbePathProfileId = (typeof PROBE_PATH_PROFILE_IDS)[number];
export type ProbeSegmentOutcome = (typeof PROBE_SEGMENT_OUTCOMES)[number];
export type ProbeAggregateStatus = Exclude<ProbeSegmentOutcome, "SKIP">;
export type ProbeVerifierId = (typeof PROBE_VERIFIER_IDS)[number];

export interface ProbeConditionalVariant {
  readonly variantId: string;
  readonly conditionId: string;
}

export interface ProbeCampaignRow {
  readonly rowId: string;
  readonly dependsOnRowIds: readonly string[];
  readonly claim: string;
  readonly stopCondition: string;
  readonly requiredVariantIds: readonly string[];
  readonly conditionalVariants: readonly ProbeConditionalVariant[];
}

export interface ProbeCampaignParameters {
  readonly f03PayloadBytes: {
    readonly port: readonly [128, 4096];
    readonly profile: readonly [4096, 262144, 1048576];
    readonly token: readonly [32, 4096];
    readonly vault: readonly [4096, 65536, 1048576];
  };
  readonly f04Race: {
    readonly durationMs: 30000;
    readonly minimumSwapCount: 10000;
    readonly operationWorkers: 8;
    readonly swapWorkers: 4;
  };
  readonly f06Replacement: {
    readonly defenderScanMode: "mpcmdrun-custom";
    readonly maxRetries: 8;
    readonly rapidReaderCount: 16;
    readonly retryBaseDelayMs: 25;
    readonly retryDeadlineMs: 3000;
    readonly retryMaximumDelayMs: 400;
  };
  readonly f07Durability: {
    readonly repetitionsPerHardCutCheckpoint: 5;
  };
  readonly f08UpgradeFence: {
    readonly capabilityBytes: 32;
    readonly connectTimeoutMs: 2000;
    readonly maxFrameBytes: 4096;
    readonly ordinaryStarterCount: 20;
    readonly ownershipSampleIntervalMs: 1;
    readonly raceIterations: 1000;
    readonly readTimeoutMs: 1000;
  };
  readonly f09Lifecycle: {
    readonly forcedTimeoutMs: 5000;
    readonly gracefulTimeoutMs: 5000;
    readonly pidPressureCount: 20000;
    readonly pidPressureDeadlineMs: 120000;
    readonly settleMs: 2000;
  };
  readonly f10Singleton: {
    readonly contentionTimeoutMs: 10000;
    readonly maxRetries: 8;
    readonly raceRounds: 100;
    readonly retryDeadlineMs: 3000;
    readonly starterCount: 32;
  };
}

export interface ProbeCampaignManifest {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-campaign";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly phase: "probe";
  readonly rowClosureClaimed: false;
  readonly environmentIds: readonly ProbeEnvironmentId[];
  readonly pathProfileIds: readonly ProbePathProfileId[];
  readonly requiredAttestationCapabilities: readonly string[];
  readonly parameters: ProbeCampaignParameters;
  readonly rows: readonly ProbeCampaignRow[];
}

export interface ProbeArtifactHash {
  readonly path: string;
  readonly sha256: string;
}

export interface ProbeCandidateDigestFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-candidate";
  readonly repositoryCommit: string;
  readonly sourceHashes: readonly ProbeArtifactHash[];
  readonly binaryHashes: readonly ProbeArtifactHash[];
  readonly compiler: {
    readonly provider: "Microsoft.CSharp.CSharpCodeProvider";
    readonly codeDomProviderAssemblyVersion: string;
    readonly cscFileVersion: string;
    readonly cscSha256: string;
    readonly outputType: "ConsoleApplication";
    readonly platform: "x64";
  };
  readonly toolchain: {
    readonly nodeVersion: string;
    readonly electronVersion: string;
    readonly electronBuilderVersion: string;
    readonly updaterVersion: string;
    readonly nsisVersion: string;
    readonly powerShellVersion: string;
    readonly powerShellEdition: "Desktop";
    readonly powerShellExecutableSha256: string;
    readonly clrVersion: string;
    readonly runtimeDirectorySha256Before: string;
    readonly runtimeDirectorySha256After: string;
    readonly runtimeRelativeInventory: readonly string[];
  };
  readonly buildFlags: readonly string[];
  readonly referencedAssemblies: readonly string[];
  readonly configurationSha256: string;
}

export interface ProbeCandidateIdentity extends ProbeCandidateDigestFields {
  readonly candidateSha256: string;
}

export interface ProbeLabCapabilities {
  readonly bootCompleteObservation: boolean;
  readonly defaultUac: boolean;
  readonly defenderRealtimeEnabled: boolean;
  readonly developerModeDisabled: boolean;
  readonly externalAbruptPower: boolean;
  readonly externalSnapshotRestore: boolean;
  readonly immutableSnapshotIdentity: boolean;
  readonly interactiveStandardUserSession: boolean;
  readonly isolatedNatAndHostOnlyNetwork: boolean;
  readonly nativeWindows11X64: boolean;
  readonly ntfsSystemAndTestVolumes: boolean;
  readonly remoteWindowsPeer: boolean;
  readonly runnerIdentityPinned: boolean;
  readonly secondStandardUser: boolean;
  readonly standardUserNonElevated: boolean;
}

export interface ProbeLabAttestation {
  readonly schemaVersion: 1;
  readonly kind: "sanitized-windows-11-lab-attestation";
  readonly environmentId: ProbeEnvironmentId;
  readonly attestationSha256: string;
  readonly sanitized: true;
  readonly host: {
    readonly windowsEdition: string;
    readonly osCaption: string;
    readonly windowsVersion: string;
    readonly osBuild: string;
    readonly patchLevel: string;
    readonly productType: "workstation";
    readonly machineArchitecture: "x64";
    readonly processArchitecture: "x64";
    readonly systemVolumeFileSystem: "NTFS";
    readonly systemVolumeIdSha256: string;
    readonly testVolumeFileSystem: "NTFS";
    readonly testVolumeIdSha256: string;
    readonly standardUserSidSha256: string;
    readonly elevated: false;
    readonly defenderRealtimeEnabled: true;
    readonly uacDefault: true;
    readonly developerModeEnabled: false;
  };
  readonly snapshot: {
    readonly vmImageId: string;
    readonly vmImageSha256: string;
    readonly vmSnapshotId: string;
    readonly cleanImageVersion: string;
  };
  readonly runner: {
    readonly version: string;
    readonly labels: readonly string[];
    readonly interactiveSessionOwnerSidSha256: string;
  };
  readonly runtime: {
    readonly nodeVersion: string;
    readonly powerShellVersion: string;
    readonly powerShellEdition: "Desktop";
    readonly powerShellExecutableSha256: string;
    readonly clrVersion: string;
    readonly electronVersion: string;
    readonly electronBuilderVersion: string;
    readonly updaterVersion: string;
    readonly nsisVersion: string;
    readonly nsisExecutableSha256: string;
  };
  readonly controller: {
    readonly identitySha256: string;
    readonly publicKeySha256: string;
    readonly publicKeyArtifact: ProbeArtifactHash;
    readonly version: string;
  };
  readonly capabilities: ProbeLabCapabilities;
  readonly guestEvidenceByPathProfile: readonly [
    {
      readonly pathProfileId: "ascii";
      readonly artifact: ProbeArtifactHash;
    },
    {
      readonly pathProfileId: "spaces-unicode";
      readonly artifact: ProbeArtifactHash;
    },
  ];
  readonly controllerEvidence: ProbeArtifactHash;
}

export interface ProbeObservation {
  readonly step: string;
  readonly expected: string;
  readonly actual: string;
  readonly evidenceRef: string;
}

export interface ProbeConditionalUnavailability {
  readonly conditionId: string;
  readonly observedUnavailable: true;
  readonly reason: string;
}

export interface ProbeVerificationMetric {
  readonly name: string;
  readonly unit: string;
  readonly value: string | number | boolean;
}

export interface ProbeVerifierBinding {
  readonly verifierId: ProbeVerifierId;
  readonly verifierSourceSha256: string;
}

export interface ProbeContinuationReference {
  readonly repetition: number;
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly headerSha256: string;
  readonly terminalEntrySha256: string;
  readonly receiptSha256: string;
}

export interface ProbeExternalCheckpointRequest {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-hard-cut-request";
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
  readonly checkpointId: string;
  readonly sequence: number;
  readonly nonceSha256: string;
  readonly preCutStateSha256: string;
  readonly preCutBootIdSha256: string;
  readonly sourceVmSnapshotId: string;
  readonly continuationScopeSha256: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly action: "hard-power-cut";
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly requestSha256: string;
}

export interface ProbeExternalCheckpointReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-hard-cut-receipt";
  readonly requestSha256: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly action: "hard-power-cut";
  readonly powerCutAt: string;
  readonly bootStartedAt: string;
  readonly bootCompletedAt: string;
  readonly postBootVmSnapshotId: string;
  readonly preCutBootIdSha256: string;
  readonly postBootBootIdSha256: string;
  readonly artifactHashes: readonly ProbeArtifactHash[];
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export interface ProbeExternalCheckpointEvidence {
  readonly request: ProbeExternalCheckpointRequest;
  readonly receipt: ProbeExternalCheckpointReceipt;
}

export interface ProbeExternalCheckpointReplayRegistry {
  readonly nonces: Set<string>;
  readonly requests: Set<string>;
  readonly receipts: Set<string>;
}

export interface ProbeSegmentRecord {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-segment";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly labAttestationSha256: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly phase: "probe";
  readonly outcome: ProbeSegmentOutcome;
  readonly mechanismId: string;
  readonly mechanismDefinitionSha256: string;
  readonly upstreamSelectionDigests: readonly string[];
  readonly verifierId: ProbeVerifierId;
  readonly verifierSourceSha256: string;
  readonly verificationMetrics: readonly ProbeVerificationMetric[];
  readonly verificationInputSha256: string;
  readonly outcomeEvidenceSha256: string;
  readonly observations: readonly ProbeObservation[];
  readonly artifactHashes: readonly ProbeArtifactHash[];
  readonly unavailability: ProbeConditionalUnavailability | null;
  readonly provenance: {
    readonly campaignRunId: string;
    readonly executionRunId: string;
    readonly executionBundleId: string;
    readonly executionBundleManifestSha256: string;
    readonly attemptId: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly monotonicDurationMs: number;
    readonly vmSnapshotId: string;
    readonly bootIdSha256: string;
    readonly externalCheckpoints: readonly ProbeExternalCheckpointEvidence[];
  };
  readonly continuations: readonly ProbeContinuationReference[];
  readonly segmentSha256: string;
  readonly rowClosureClaimed: false;
}

export interface ProbeSegmentCoordinate {
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly variantId: string;
}

export interface ProbeRowResult {
  readonly rowId: string;
  readonly claim: string;
  readonly stopCondition: string;
  readonly status: ProbeAggregateStatus;
  readonly stopConditionTriggered: boolean;
  readonly selectedMechanism: string | null;
  readonly mechanismDefinitionSha256: string | null;
  readonly verifierBindings: readonly ProbeVerifierBinding[];
  readonly verificationInputSha256: string | null;
  readonly rowEvidenceSha256: string | null;
  readonly upstreamSelectionDigests: readonly string[];
  readonly selectionDigest: string | null;
  readonly blockedByRowIds: readonly string[];
  readonly environmentEvidenceRefs: readonly {
    readonly environmentId: ProbeEnvironmentId;
    readonly pathProfileId: ProbePathProfileId;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly expectedSegmentCount: number;
  readonly observedSegmentCount: number;
  readonly missingSegments: readonly ProbeSegmentCoordinate[];
  readonly inconclusiveSegments: readonly ProbeSegmentCoordinate[];
  readonly skippedConditionalSegments: readonly ProbeSegmentCoordinate[];
  readonly rowClosureClaimed: false;
}

export interface ProbeCampaignIssue {
  readonly code: "UNPINNED_VERSION" | "MISSING_ATTESTATION" | "UNAVAILABLE_REQUIRED_CAPABILITY";
  readonly detail: string;
}

export interface ProbeCampaignResult {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-campaign-analysis";
  readonly authority: "unverified-record-analysis";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly phase: "probe";
  readonly status: ProbeAggregateStatus;
  readonly selectionEligible: boolean;
  readonly rowClosureClaimed: false;
  readonly issues: readonly ProbeCampaignIssue[];
  readonly rowResults: readonly ProbeRowResult[];
}

export class ProbeContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export const PROBE_CAMPAIGN_MANIFEST: ProbeCampaignManifest;
export const PROBE_CAMPAIGN_MANIFEST_SHA256: string;

export function canonicalProbeJson(value: unknown): string;
export function hashProbeCanonicalJson(value: unknown): string;
export function deriveCandidateDigest(
  value: ProbeCandidateDigestFields | ProbeCandidateIdentity,
): string;
export function deriveLabAttestationDigest(
  value: Omit<ProbeLabAttestation, "attestationSha256"> | ProbeLabAttestation,
): string;
export function deriveProbeSegmentDigest(
  value: Omit<ProbeSegmentRecord, "segmentSha256"> | ProbeSegmentRecord,
): string;
export function deriveProbeOutcomeEvidenceDigest(
  value: Pick<
    ProbeSegmentRecord,
    | "outcome"
    | "observations"
    | "artifactHashes"
    | "unavailability"
    | "verifierId"
    | "verifierSourceSha256"
    | "verificationInputSha256"
  >,
): string;
export function deriveProbeVerificationInputDigest(
  value: Pick<
    ProbeSegmentRecord,
    | "campaignId"
    | "manifestSha256"
    | "candidateSha256"
    | "environmentId"
    | "pathProfileId"
    | "rowId"
    | "variantId"
    | "artifactHashes"
    | "verificationMetrics"
    | "verifierId"
    | "verifierSourceSha256"
  >,
): string;
export function deriveProbeRowVerificationInputDigest(
  rowId: string,
  inputDigests: readonly string[],
): string;
export function deriveProbeRowEvidenceDigest(value: {
  readonly rowId: string;
  readonly terminalSegmentDigests: readonly string[];
  readonly attestationDigests: readonly string[];
  readonly executionBundleManifestDigests: readonly string[];
}): string;
export function deriveProbeSelectionDigest(value: {
  readonly rowId: string;
  readonly candidateSha256: string;
  readonly mechanismId: string;
  readonly mechanismDefinitionSha256: string;
  readonly upstreamSelectionDigests: readonly string[];
  readonly verifierBindings: readonly ProbeVerifierBinding[];
  readonly verificationInputSha256: string;
  readonly rowEvidenceSha256: string;
}): string;
export function deriveProbeContinuationScopeDigest(value: {
  readonly campaignId: string;
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly attemptId: string;
  readonly repetition: number;
  readonly chainId: string;
}): string;
export function deriveExternalCheckpointRequestDigest(
  value:
    | Omit<ProbeExternalCheckpointRequest, "requestSha256" | "signatureBase64">
    | ProbeExternalCheckpointRequest,
): string;
export function deriveExternalCheckpointReceiptDigest(
  value:
    | Omit<ProbeExternalCheckpointReceipt, "receiptSha256" | "signatureBase64">
    | ProbeExternalCheckpointReceipt,
): string;
export function verifyExternalCheckpointReceiptSignature(
  receipt: ProbeExternalCheckpointReceipt,
  controllerPublicKeyBytes: Uint8Array,
): ProbeExternalCheckpointReceipt;
export function verifyExternalCheckpointRequestSignature(
  request: ProbeExternalCheckpointRequest,
  controllerPublicKeyBytes: Uint8Array,
): ProbeExternalCheckpointRequest;
export function createExternalCheckpointReplayRegistry(): ProbeExternalCheckpointReplayRegistry;
export function validateExternalCheckpointEvidence(
  pair: ProbeExternalCheckpointEvidence,
  options: {
    readonly segment: ProbeSegmentRecord;
    readonly continuation: ProbeContinuationReference;
    readonly repetition: number;
    readonly replayRegistry: ProbeExternalCheckpointReplayRegistry;
    readonly expectedController?: ProbeLabAttestation["controller"] | null;
    readonly controllerPublicKeyBytes?: Uint8Array | null;
    readonly expectedPreCutBootIdSha256?: string | null;
  },
): ProbeExternalCheckpointEvidence;
export function validateProbeCampaignManifest(value: unknown): ProbeCampaignManifest;
export function validateProbeCandidateIdentity(value: unknown): ProbeCandidateIdentity;
export function validateLabAttestation(value: unknown): ProbeLabAttestation;
export function validateProbeSegmentRecord(value: unknown): ProbeSegmentRecord;
export function analyzeProbeCampaignRecords(input: {
  readonly manifest: unknown;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestations: readonly ProbeLabAttestation[];
  readonly segments: readonly ProbeSegmentRecord[];
}): ProbeCampaignResult;
