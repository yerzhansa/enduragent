import type {
  ProbeArtifactHash,
  ProbeConditionalUnavailability,
  ProbeObservation,
  ProbeSegmentOutcome,
  ProbeVerificationMetric,
  ProbeVerifierId,
} from "./probe-contract.mjs";

export const PROBE_VERIFIER_SOURCE_PATH: "apps/desktop/scripts/windows-host-falsifier/probe-registry.mjs";

export class ProbeVerifierRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeFactAvailability {
  readonly status: "available" | "unavailable" | "unknown";
  readonly reason: string | null;
}

export interface ProbeRawFactEnvelope<Facts extends object> {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-raw-facts";
  readonly captureComplete: boolean;
  readonly availability: ProbeFactAvailability;
  readonly scenario: {
    readonly variantId: string;
    readonly definitionSha256: string;
    readonly evidenceSha256: string;
    readonly transcript: ProbeFactTranscript;
  };
  readonly facts: Facts;
}

export interface ProbeFactTranscript {
  readonly schemaVersion: 1;
  readonly kind:
    | "windows-host-probe-controller-transcript"
    | "windows-host-probe-native-transcript";
  readonly rowId: string;
  readonly variantId: string;
  readonly verifierDefinitionSha256: string;
  readonly commandIds: readonly string[];
  readonly sourceTranscriptSha256: string;
  readonly factsSha256: string;
  readonly captureSha256: string;
}

export interface ProbeF01Facts {
  readonly pathTopology:
    | "8dot3-short-name-alias"
    | "actual-component-case-alias"
    | "case-sensitive-directory"
    | "directory-junction-alias"
    | "distinct-homes"
    | "drive-letter-case-alias"
    | "long-path-alias"
    | "mapped-network-drive"
    | "ordinary-absolute-path"
    | "relocated-copy"
    | "removable-non-ntfs"
    | "renamed-home"
    | "reparse-chain-escape"
    | "spaces-unicode-path"
    | "subst-drive-alias"
    | "unc-path";
  readonly processRole: "daemon-and-main" | "main";
  readonly lifecycle: "reboot" | "restart" | "same-process";
  readonly credentialReadAttempted: boolean | null;
  readonly canonicalIdentitySha256: string | null;
  readonly comparisonIdentitySha256: string | null;
  readonly localPathSha256: string | null;
  readonly volumeIdentitySha256: string | null;
  readonly volumeFileSystem: "NTFS" | "exFAT" | "FAT32" | "other" | null;
  readonly volumeDriveType: "fixed" | "network" | "removable" | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
}

export interface ProbeF02Facts {
  readonly rootClass:
    | "authenticated-users"
    | "everyone"
    | "explicit-local-appdata"
    | "fresh-private"
    | "inherited-profile"
    | "invalid-empty"
    | "invalid-network"
    | "invalid-relative"
    | "invalid-removable"
    | "invalid-reparse-escape"
    | "invalid-roaming"
    | "owned-private"
    | "second-user"
    | "unrepairable-owner-deny"
    | "users";
  readonly actor: "current-user" | "second-user";
  readonly operation:
    | "create"
    | "delete"
    | "inspect"
    | "read"
    | "rename"
    | "repair"
    | "validate-root"
    | "write";
  readonly operationApplied: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly ownerSidSha256: string | null;
  readonly currentUserSidSha256: string | null;
  readonly inheritanceProtected: boolean | null;
  readonly broadPrincipalEffectiveMask: number | null;
  readonly currentUserEffectiveMask: number | null;
  readonly secondUserReadSucceeded: boolean | null;
  readonly secondUserWriteSucceeded: boolean | null;
  readonly securityDescriptorSha256: string | null;
}

export interface ProbeF03Facts {
  readonly payloadKind: "port" | "profile" | "token" | "vault";
  readonly targetTopology:
    | "absent"
    | "directory"
    | "existing-regular-file"
    | "hard-link"
    | "inspect-create-swap"
    | "junction-reparse"
    | "read-only-file"
    | "symlink";
  readonly operation: "create-private-file";
  readonly operationApplied: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly finalObjectType: "directory" | "other" | "regular-file" | "reparse-point" | null;
  readonly finalObjectIdentitySha256: string | null;
  readonly openedObjectIdentitySha256: string | null;
  readonly linkCount: number | null;
  readonly reparseTag: number | null;
  readonly writtenPayloadSha256: string | null;
  readonly readBackPayloadSha256: string | null;
  readonly securityDescriptorSha256: string | null;
  readonly ownerOnlyDacl: boolean | null;
  readonly testedPayloadBytes: readonly number[];
  readonly outsideMutationCount: number | null;
}

export interface ProbeF04Facts {
  readonly pathTopology:
    | "ancestor-junction"
    | "concurrent-swap-loop"
    | "junction-chain"
    | "leaf-mount-point"
    | "leaf-symlink"
    | "normal-nested";
  readonly operation: "create" | "delete" | "quarantine" | "read" | "replace";
  readonly operationApplied: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly openedRootIdentitySha256: string | null;
  readonly finalRootIdentitySha256: string | null;
  readonly outsideMutationCount: number | null;
  readonly reparseTraversalCount: number | null;
  readonly swapCount: number | null;
  readonly durationMs: number | null;
  readonly operationWorkerCount: number | null;
  readonly swapWorkerCount: number | null;
  readonly beforeTreeSha256: string | null;
  readonly afterTreeSha256: string | null;
}

export interface ProbeF05Facts {
  readonly operation: "delete" | "quarantine" | "replace";
  readonly identityClass: "same-object" | "stale-identity";
  readonly lifetime: "hard-link" | "process-restart" | "same-process";
  readonly operationApplied: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly inspectedObjectIdentitySha256: string | null;
  readonly currentObjectIdentitySha256: string | null;
  readonly actedObjectIdentitySha256: string | null;
  readonly unrelatedMutationCount: number | null;
  readonly identityCheckCount: number | null;
  readonly processRestartObserved: boolean | null;
  readonly hardLinkAliasObserved: boolean | null;
}

export interface ProbeF06Facts {
  readonly context: "baseline" | "defender-scan" | "process-crash" | "rapid-readers" | "reboot";
  readonly checkpoint:
    | "after-flush"
    | "after-replace"
    | "before-replace"
    | "before-temp-write"
    | "during-replace"
    | "during-write";
  readonly shareMode: "share-allows-replace" | "share-denies-replace";
  readonly replaceDisposition: "committed" | "not-committed" | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly oldRecordSha256: string | null;
  readonly candidateRecordSha256: string | null;
  readonly observedRecordSha256s: readonly string[];
  readonly partialRecordCount: number | null;
  readonly missingRecordCount: number | null;
  readonly readerSampleCount: number | null;
  readonly remainingOwnedTempCount: number | null;
  readonly retryCount: number | null;
  readonly elapsedMs: number | null;
  readonly defenderScanObserved: boolean | null;
  readonly processCrashObserved: boolean | null;
  readonly rebootObserved: boolean | null;
}

export interface ProbeF07Facts {
  readonly cutKind: "hard-cut" | "none" | "process-kill";
  readonly checkpoint:
    | "file-flush"
    | "file-flush-capability"
    | "namespace-replace"
    | "parent-directory-handle-capability"
    | "parent-volume-flush"
    | "recovery-envelope-checksum"
    | "recovery-old-or-new-complete"
    | "temp-creation"
    | "truthful-commit-uncertain";
  readonly operationDisposition: "commit-uncertain" | "durably-committed" | "not-committed" | null;
  readonly oldRecordSha256: string | null;
  readonly candidateRecordSha256: string | null;
  readonly recoveredRecordSha256s: readonly string[];
  readonly recoveredCompleteCount: number | null;
  readonly recoveredTornCount: number | null;
  readonly recoveredMissingCount: number | null;
  readonly fileFlushSupported: boolean | null;
  readonly parentDirectoryFlushSupported: boolean | null;
  readonly signedReceiptSha256s: readonly string[];
  readonly verifiedReceiptSignatureCount: number | null;
  readonly verifiedReceiptBindingCount: number | null;
  readonly repetitionCount: number | null;
  readonly unprovableBoundaryObserved: boolean | null;
  readonly checksumMismatchCount: number | null;
}

export interface ProbeF08Facts {
  readonly primaryEndpointSha256: string | null;
  readonly comparisonEndpointSha256: string | null;
  readonly independentEndpointSha256: string | null;
  readonly canonicalHomeInputSha256: string | null;
  readonly endpointName: string | null;
  readonly endpointSuffix: string | null;
  readonly derivationDomain: string | null;
  readonly appId: string | null;
  readonly processRole: "controller" | "daemon" | "main" | null;
  readonly endpointGrammarValid: boolean | null;
  readonly rawIdentitySubstringPresent: boolean | null;
  readonly connectionAccepted: boolean | null;
  readonly authenticated: boolean | null;
  readonly clientKind:
    | "correct-successor"
    | "duplicate-attempt"
    | "foreign-precreator"
    | "ordinary-starter"
    | "remote-client"
    | "second-user"
    | "wrong-capability"
    | null;
  readonly clientDecision: "designated" | "refused" | "reserved" | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly ownerSidSha256: string | null;
  readonly standardUserSidSha256: string | null;
  readonly firstInstanceHeld: boolean | null;
  readonly maxConcurrentOwners: number | null;
  readonly ownershipSampleCount: number | null;
  readonly raceIterations: number | null;
  readonly ordinaryStarterCount: number | null;
  readonly crashReleased: boolean | null;
  readonly admittedSuccessorCount: number | null;
  readonly observedFrameBytes: number | null;
  readonly connectElapsedMs: number | null;
  readonly readElapsedMs: number | null;
  readonly restartObserved: boolean | null;
  readonly rebootObserved: boolean | null;
  readonly handoffCheckpoint:
    | "after-capability-consumption"
    | "after-successor-admission"
    | "before-accept"
    | "during-frame-read"
    | "n-to-n-plus-one"
    | null;
  readonly collisionInjected: boolean | null;
  readonly collisionRefused: boolean | null;
  readonly neitherWindowCount: number | null;
}

export interface ProbeF09Facts {
  readonly processCreatedSuspended: boolean | null;
  readonly jobAssignedBeforeResume: boolean | null;
  readonly mainPid: number | null;
  readonly mainCreationTimeSha256: string | null;
  readonly observedCreationTimeSha256: string | null;
  readonly descendantCount: number | null;
  readonly survivingDescendantCount: number | null;
  readonly unrelatedProcessSurvived: boolean | null;
  readonly gracefulStopElapsedMs: number | null;
  readonly forcedStopElapsedMs: number | null;
  readonly readyObserved: boolean | null;
  readonly shutdownAcknowledged: boolean | null;
  readonly forcedTerminationUsed: boolean | null;
  readonly outerJobPresent: boolean | null;
  readonly breakawayAllowed: boolean | null;
  readonly nestedAssignmentSucceeded: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly pidPressureCount: number | null;
  readonly pidReuseMisbindCount: number | null;
  readonly osShutdownNotificationObserved: boolean | null;
  readonly startFrameSent: boolean | null;
  readonly mainProcessCrashObserved: boolean | null;
  readonly daemonCrashAfterReadyObserved: boolean | null;
  readonly grandchildSpawned: boolean | null;
  readonly hangBeforeReadyObserved: boolean | null;
  readonly normalReadyShutdownObserved: boolean | null;
  readonly explicitQuitObserved: boolean | null;
  readonly uninstallDrainObserved: boolean | null;
  readonly updateDrainObserved: boolean | null;
  readonly unrelatedSafetyProbeObserved: boolean | null;
}

export interface ProbeF10Facts {
  readonly starterCount: number | null;
  readonly raceRounds: number | null;
  readonly successfulWriterCount: number | null;
  readonly simultaneousWriterMax: number | null;
  readonly databaseWriterCount: number | null;
  readonly portOwnerCount: number | null;
  readonly homeIdentitySha256: string | null;
  readonly comparisonHomeIdentitySha256: string | null;
  readonly listenerAuthenticated: boolean | null;
  readonly listenerCompatible: boolean | null;
  readonly listenerResponsive: boolean | null;
  readonly starterAdmitted: boolean | null;
  readonly win32Error: number | null;
  readonly reasonCode: string | null;
  readonly staleLockReclaimed: boolean | null;
  readonly stalePortFileReclaimed: boolean | null;
  readonly readOnlyMutationCount: number | null;
  readonly secondUserAccessSucceeded: boolean | null;
  readonly pidCreationMatches: boolean | null;
  readonly retryCount: number | null;
  readonly elapsedMs: number | null;
  readonly defenderShareDenyObserved: boolean | null;
  readonly crashCheckpointReached: boolean | null;
  readonly crashCheckpoint: string | null;
  readonly recoveryWriterCount: number | null;
  readonly protocolRelation: "compatible" | "newer" | "older" | "unknown" | null;
  readonly unmanagedPeerGuidanceEmitted: boolean | null;
  readonly healthyPeerObserved: boolean | null;
  readonly foreignListenerObserved: boolean | null;
  readonly unresponsiveListenerObserved: boolean | null;
  readonly databaseSentinelObserved: boolean | null;
  readonly distinctHomeControlObserved: boolean | null;
  readonly staleLockIdentityProved: boolean | null;
  readonly stalePortIdentityProved: boolean | null;
  readonly readOnlyToolingObserved: boolean | null;
  readonly secondElectronActivationObserved: boolean | null;
  readonly activationRoutedToExistingInstance: boolean | null;
  readonly secondUserProbeObserved: boolean | null;
  readonly pidReusePressureObserved: boolean | null;
  readonly unmanagedPeerObserved: boolean | null;
  readonly mixedAliasRaceObserved: boolean | null;
  readonly simultaneousElectronLaunchObserved: boolean | null;
}

export type ProbeRowFacts =
  | ProbeF01Facts
  | ProbeF02Facts
  | ProbeF03Facts
  | ProbeF04Facts
  | ProbeF05Facts
  | ProbeF06Facts
  | ProbeF07Facts
  | ProbeF08Facts
  | ProbeF09Facts
  | ProbeF10Facts;

export interface ProbeMechanismDefinition {
  readonly schemaVersion: 1;
  readonly mechanismId: string;
  readonly primitive: string;
  readonly guarantees: readonly string[];
}

export interface ProbeVerifierDefinition {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-verifier-definition";
  readonly rowId: string;
  readonly variantId: string;
  readonly verifierId: ProbeVerifierId;
  readonly sourceArtifactPath: typeof PROBE_VERIFIER_SOURCE_PATH;
  readonly rawFactSchemaId: string;
  readonly transcriptKind:
    | "windows-host-probe-controller-transcript"
    | "windows-host-probe-native-transcript";
  readonly transcriptCommandIds: readonly string[];
  readonly conditionId: string | null;
  readonly mechanismId: string;
  readonly mechanismDefinition: ProbeMechanismDefinition;
  readonly expectation: Readonly<Record<string, unknown>>;
  readonly definitionSha256: string;
}

export interface ProbeTranscriptFactCommandDefinition {
  readonly commandId: string;
  readonly factKeys: readonly string[];
}

export interface ProbeTranscriptFactDefinition {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-transcript-fact-definition";
  readonly rowId: string;
  readonly variantId: string;
  readonly definitionSha256: string;
  readonly rawFactSchemaId: string;
  readonly transcriptKind:
    | "windows-host-probe-controller-transcript"
    | "windows-host-probe-native-transcript";
  readonly commands: readonly ProbeTranscriptFactCommandDefinition[];
  readonly mappingSha256: string;
}

export interface ProbeVerifiedFactsResult {
  readonly verifierId: ProbeVerifierId;
  readonly verifierSourceSha256: string;
  readonly verifierDefinitionSha256: string;
  readonly verifierInputSha256: string;
  readonly rawFactsSha256: string;
  readonly outcome: ProbeSegmentOutcome;
  readonly observations: readonly ProbeObservation[];
  readonly verificationMetrics: readonly ProbeVerificationMetric[];
  readonly unavailability: ProbeConditionalUnavailability | null;
  readonly mechanismId: string;
  readonly mechanismDefinition: ProbeMechanismDefinition;
}

export const PROBE_VERIFIER_DEFINITIONS: readonly ProbeVerifierDefinition[];
export const PROBE_TRANSCRIPT_FACT_DEFINITIONS: readonly ProbeTranscriptFactDefinition[];

export function getProbeVerifierDefinition(
  rowId: string,
  variantId: string,
): ProbeVerifierDefinition;

export function getProbeTranscriptFactDefinition(
  rowId: string,
  variantId: string,
): ProbeTranscriptFactDefinition;

export function verifyProbeFacts(input: {
  readonly rowId: string;
  readonly variantId: string;
  readonly rawFacts: ProbeRawFactEnvelope<ProbeRowFacts>;
  readonly artifactHashes: readonly ProbeArtifactHash[];
  readonly verifierSourceSha256: string;
}): ProbeVerifiedFactsResult;
