import type {
  ProbeBrokerEnrollment,
  ProbePreparedBrokerEnrollment,
} from "./broker/mailbox-protocol.mjs";

export const NATIVE_PROTOCOL_VERSION: 1;
export const NATIVE_PREFLIGHT_OBSERVATION_SCHEMA_VERSION: 1;
export const NATIVE_BROKER_CONTEXT_SECURITY_PROFILE: "role-separated-immutable-file-mailbox-v1";
export const NATIVE_BROKER_JOURNAL_SECURITY_PROFILE: "role-separated-append-only-journal-v1";
export const NATIVE_BROKER_CONTEXT_KINDS: readonly [
  "windows-host-native-broker-storage-observed",
  "windows-host-native-broker-context-acquired",
  "windows-host-native-broker-context-revalidated",
  "windows-host-native-broker-context-released",
];

export const NATIVE_COMMANDS: readonly [
  "home-identity",
  "private-directory-ensure",
  "private-directory-inspect",
  "private-file-create",
  "secure-path-operation",
  "file-identity",
  "evidence-tree-seal",
  "durable-replace",
  "pipe-name-derive",
  "pipe-owner",
  "pipe-client",
  "pipe-foreign-precreate",
  "job-owner",
  "process-identity",
  "job-query",
];

export const NATIVE_CHILD_ENV_ALLOWLIST: readonly [
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
];

export type NativeCommand = (typeof NATIVE_COMMANDS)[number];
export type NativeSessionCommand = "pipe-owner" | "pipe-foreign-precreate" | "job-owner";
export type NativeSessionAction = "query" | "graceful" | "terminate" | "close";

export interface NativePreflightBinding {
  readonly campaignRunId: string;
  readonly candidateSha256: string;
  readonly preflightSha256: string;
  readonly executionBundleManifestSha256: string;
  readonly nativeHelperArtifactPath: string;
  readonly nativeHelperSha256: string;
  readonly nativeCandidateDigest: string;
  readonly nativeManifestSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
}

export interface NativeSourceIdentity {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface NativeBuildIdentity {
  readonly candidateDigest: string;
  readonly assemblySha256: string;
  readonly sourceBundleSha256: string;
  readonly toolchainDigest: string;
  readonly manifestSha256: string;
  readonly sources: readonly NativeSourceIdentity[];
  readonly toolchain: Readonly<Record<string, unknown>>;
}

export interface NativeBuild extends NativeBuildIdentity {
  readonly assemblyPath: string;
  readonly buildDirectory: string;
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
  readonly nativeHelperArtifactPath: string;
  readonly snapshotDirectory: string;
  readonly manifestPath: string;
}

export function describePrivateDirectoryCreationFailure(result: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrBytes: number;
  readonly stdoutMatchesNonce: boolean;
}): string | null;

export interface NativePreflightObservationFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-native-preflight-observation";
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly runnerUserSidSha256: string;
  readonly rootPathSha256: string;
  readonly rootSecuritySha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly volumeIdSha256: string;
  readonly localAbsolute: true;
  readonly interactiveSessionActive: true;
  readonly networkPath: false;
  readonly removableVolume: false;
  readonly reparsePoint: false;
  readonly nfcNormalized: true;
  readonly containsSpaces: boolean;
  readonly containsUnicode: boolean;
  readonly fileSystem: "NTFS";
  readonly driveType: "fixed";
  readonly nativeHelperSha256: string;
  readonly nativeCandidateDigest: string;
  readonly nativeManifestSha256: string;
  readonly sourceBundleSha256: string;
}

export interface NativePreflightObservation extends NativePreflightObservationFields {
  readonly observationSha256: string;
}

export interface NativePreflightTranscript {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-native-preflight-transcript";
  readonly binding: {
    readonly candidateRootSha256: string;
    readonly candidateDirectorySha256: string;
    readonly requestedRunRootSha256: string;
    readonly rootMutationCheck: "bounded-recursive-before-after-v1";
    readonly nativeHelperArtifactPath: string;
    readonly nativeHelperSha256: string;
    readonly nativeCandidateDigest: string;
    readonly nativeManifestSha256: string;
    readonly sourceBundleSha256: string;
    readonly pathProfileId: "ascii" | "spaces-unicode";
  };
  readonly observation: NativePreflightObservation;
  readonly termination: {
    readonly code: 0;
    readonly signal: null;
    readonly stderrBytes: 0;
  };
  readonly transcriptSha256: string;
}

export function deriveNativePreflightObservationDigest(
  value: NativePreflightObservationFields | NativePreflightObservation,
): string;
export function validateNativePreflightObservation(value: unknown): NativePreflightObservation;
export function deriveNativePreflightTranscriptDigest(
  value: Omit<NativePreflightTranscript, "transcriptSha256"> | NativePreflightTranscript,
): string;
export function validateNativePreflightTranscript(value: unknown): NativePreflightTranscript;
export function observeNativePreflight(options: {
  readonly runRoot: string;
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly build: NativeBuildIdentity;
  readonly observation: NativePreflightObservation;
  readonly transcript: NativePreflightTranscript;
  readonly transcriptBytes: Uint8Array;
}>;

export interface StagedContentSource {
  readonly kind: "staged-file";
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DeterministicContentSource {
  readonly kind: "deterministic";
  readonly seedHex: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type NativeContentSource = StagedContentSource | DeterministicContentSource;
export type EvidenceTreeSealMode = "entries" | "digest-only" | "exact-paths";

interface EvidenceTreeSealRequestBase {
  readonly relativePath: string;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export type EvidenceTreeSealRequest = EvidenceTreeSealRequestBase &
  (
    | { readonly mode?: "entries" | "digest-only"; readonly exactPaths?: never }
    | { readonly mode: "exact-paths"; readonly exactPaths: readonly string[] }
  );

export interface EvidenceTreeSealEntry {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly bytes: number;
  readonly sha256: string | null;
  readonly objectIdentity: string;
}

export interface EvidenceTreeSealDigest {
  readonly mode: "digest-only";
  readonly rootObjectIdentity: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly treeSha256: string;
}

export interface EvidenceTreeSealWithEntries {
  readonly mode: "entries";
  readonly rootObjectIdentity: string;
  readonly entryCount: number;
  readonly entries: readonly EvidenceTreeSealEntry[];
  readonly totalBytes: number;
  readonly treeSha256: string;
}

export interface EvidenceArtifactSetSeal {
  readonly mode: "exact-paths";
  readonly rootObjectIdentity: string;
  readonly entryCount: number;
  readonly entries: readonly (EvidenceTreeSealEntry & {
    readonly type: "file";
    readonly sha256: string;
  })[];
  readonly totalBytes: number;
  readonly setSha256: string;
}

export type EvidenceSealResult =
  | EvidenceTreeSealDigest
  | EvidenceTreeSealWithEntries
  | EvidenceArtifactSetSeal;

export interface NativeRequestMap {
  readonly "home-identity": { readonly path: string } | { readonly relativePath: string };
  readonly "private-directory-ensure": {
    readonly relativePath: string;
    readonly action: "create" | "repair";
  };
  readonly "private-directory-inspect": { readonly relativePath: string };
  readonly "private-file-create": {
    readonly root?: string;
    readonly relativePath: string;
    readonly contentSource: NativeContentSource;
  };
  readonly "secure-path-operation": {
    readonly root?: string;
    readonly relativePath: string;
    readonly operation: "read" | "create" | "replace" | "quarantine" | "delete";
    readonly expectedIdentity?: string;
    readonly destinationRelativePath?: string;
    readonly contentSource?: NativeContentSource;
  };
  readonly "file-identity": { readonly root?: string; readonly relativePath: string };
  readonly "evidence-tree-seal": EvidenceTreeSealRequest;
  readonly "durable-replace": {
    readonly root?: string;
    readonly relativePath: string;
    readonly tempRelativePath: string;
    readonly checkpoint:
      | "before-temp"
      | "during-write"
      | "after-file-flush"
      | "before-rename"
      | "during-rename"
      | "after-rename";
    readonly retry: {
      readonly maxAttempts: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
      readonly deadlineMs: number;
    };
    readonly contentSource: NativeContentSource;
  };
  readonly "pipe-name-derive": { readonly appId: string; readonly canonicalHomeId: string };
  readonly "pipe-owner": {
    readonly pipeName: string;
    readonly capabilityHex: string;
    readonly bindingHex: string;
    readonly maxFrameBytes: number;
    readonly connectDeadlineMs: number;
    readonly readDeadlineMs: number;
  };
  readonly "pipe-client": NativeRequestMap["pipe-owner"] & {
    readonly role: "ordinary" | "successor";
  };
  readonly "pipe-foreign-precreate": {
    readonly pipeName: string;
    readonly maxFrameBytes: number;
  };
  readonly "job-owner": {
    readonly scenario:
      | "normal"
      | "hung"
      | "grandchild"
      | "crash-before-ready"
      | "crash-after-ready";
    readonly deadlines: {
      readonly startMs: number;
      readonly gracefulMs: number;
      readonly forceMs: number;
    };
  };
  readonly "process-identity": { readonly pid: number };
  readonly "job-query": { readonly pid: number; readonly creationTimeSha256: string };
}

export interface HomeIdentityResult {
  readonly canonicalHomeId: string;
  readonly objectIdentity: string;
  readonly volumeIdentity: string;
  readonly finalPathSha256: string;
  readonly fileSystem: "NTFS";
  readonly driveType: "fixed";
  readonly reparseTag: number;
  readonly linkCount: number;
}

export interface PrivateDirectoryResult {
  readonly objectIdentity: string;
  readonly ownerSidSha256: string;
  readonly protectedAcl: boolean;
  readonly principals: readonly ("current-user" | "System" | "Administrators")[];
  readonly unexpectedAceCount: number;
  readonly sddlSha256: string;
}

export interface SecurePathResult {
  readonly outcome: "completed" | "refused" | "not-committed";
  readonly objectIdentity: string | null;
  readonly contentSha256: string | null;
  readonly win32Code: number | null;
  readonly reasonCode: string | null;
}

export interface NativeProcessEntry {
  readonly pid: number;
  readonly creationTimeSha256: string | null;
}

export interface NativeResultMap {
  readonly "home-identity": HomeIdentityResult;
  readonly "private-directory-ensure": PrivateDirectoryResult;
  readonly "private-directory-inspect": PrivateDirectoryResult;
  readonly "private-file-create": {
    readonly objectIdentity: string;
    readonly linkCount: number;
    readonly bytesWritten: number;
    readonly sddlSha256: string;
  };
  readonly "secure-path-operation": SecurePathResult;
  readonly "file-identity": { readonly objectIdentity: string; readonly linkCount: number };
  readonly "evidence-tree-seal": EvidenceSealResult;
  readonly "durable-replace": {
    readonly outcome: "committed" | "commit-uncertain" | "not-committed";
    readonly retries: number;
    readonly errorCode: string | null;
    readonly oldOrNewDigest: string;
  };
  readonly "pipe-name-derive": { readonly pipeName: string; readonly suffix: string };
  readonly "pipe-owner": {
    readonly sessionId: string;
    readonly state: "ready";
    readonly ownerSidSha256: string;
    readonly pipeNameSha256: string;
  };
  readonly "pipe-client": {
    readonly decision: "designated" | "reserved" | "collision-refused" | "refused";
    readonly responseSha256: string;
  };
  readonly "pipe-foreign-precreate": { readonly sessionId: string; readonly state: "ready" };
  readonly "job-owner": {
    readonly sessionId: string;
    readonly state: "running";
    readonly pid: number;
    readonly creationTimeSha256: string;
    readonly assignedBeforeResume: true;
    readonly insideOuterJob: boolean;
  };
  readonly "process-identity": {
    readonly exists: boolean;
    readonly pid: number;
    readonly creationTimeSha256: string | null;
    readonly running: boolean;
    readonly exitCode: number | null;
  };
  readonly "job-query": {
    readonly exists: boolean;
    readonly identityMatches: boolean;
    readonly running: boolean;
    readonly exitCode: number | null;
  };
}

export type NativeSessionControlResult =
  | {
      readonly sessionId: string;
      readonly state: "ready" | "stopping";
      readonly capabilityConsumed: boolean;
    }
  | { readonly sessionId: string; readonly state: "ready" | "closed" }
  | {
      readonly sessionId: string;
      readonly running: boolean;
      readonly identityMatches: boolean;
      readonly assigned: boolean;
      readonly processes: readonly NativeProcessEntry[];
    }
  | {
      readonly sessionId: string;
      readonly outcome: "exited" | "graceful-unsupported" | "terminated" | "termination-failed";
      readonly identityMatches: boolean;
    }
  | { readonly sessionId: string; readonly outcome: "closed" };

export interface NativeMessageContext {
  readonly campaignRunId: string;
  readonly candidateSha256: string;
  readonly preflightSha256: string;
  readonly executionBundleManifestSha256: string;
  readonly nativeCandidateDigest: string;
  readonly nativeManifestSha256: string;
  readonly nativeHelperSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly nativeSessionId: string;
  readonly operationId: string;
  readonly runRootIdentity: string;
}

export interface NativeRequestFrame<C extends NativeCommand = NativeCommand> {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly command: C;
  readonly context: Omit<NativeMessageContext, "runRootIdentity">;
  readonly request: Readonly<Record<string, unknown>>;
}

export interface NativePreparedRequest<C extends NativeCommand = NativeCommand> {
  readonly command: C;
  readonly operationId: string;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly requestFrame: NativeRequestFrame<C>;
  readonly requestFrameSha256: string;
}

export interface NativeCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly win32Code: number | null;
}

export type NativeExecutionOutcome<C extends NativeCommand = NativeCommand> =
  | {
      readonly command: C;
      readonly operationId: string;
      readonly ok: true;
      readonly result: NativeResultMap[C];
    }
  | {
      readonly command: C;
      readonly operationId: string;
      readonly ok: false;
      readonly error: NativeCommandFailure;
    };

export interface NativePreparedFrameTransmission<
  C extends NativeCommand = NativeCommand,
> extends NativePreparedRequest<C> {
  readonly frameBytes: Uint8Array;
  readonly record: boolean;
}

export interface NativeStartupHandshake {
  readonly protocolVersion: 1;
  readonly kind: "response";
  readonly requestId: string;
  readonly command: "native-binding-check";
  readonly context: NativeMessageContext & { readonly requestFrameSha256: string };
  readonly ok: true;
  readonly result: {
    readonly ready: true;
    readonly processId: number;
    readonly nativeHelperSha256: string;
    readonly runRootIdentity: string;
    readonly evidenceRootObjectIdentitySha256: string;
  };
}

export interface NativeEvent {
  readonly protocolVersion: 1;
  readonly kind: "event";
  readonly sessionId: string;
  readonly context: NativeMessageContext;
  readonly sequence: number;
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface NativeCommandTranscriptRecord {
  readonly kind: "command";
  readonly sequence: number;
  readonly requestId: string;
  readonly command: NativeCommand | "session-control";
  readonly operationId: string;
  readonly requestFrameSha256: string;
  readonly nativeRequestFrameSha256: string;
  readonly requestFrameVerification: "recomputed" | "native-receipt";
  readonly responseFrameSha256: string;
  readonly ok: boolean;
  readonly request: Readonly<Record<string, unknown>> | NativePipeTranscriptRequest;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly win32Code: number | null;
  };
}

export interface NativePipeTranscriptRequest {
  readonly pipeName: string;
  readonly capabilitySha256: string;
  readonly bindingSha256: string;
  readonly role?: "ordinary" | "successor";
  readonly maxFrameBytes: number;
  readonly connectDeadlineMs: number;
  readonly readDeadlineMs: number;
}

export interface NativeEventTranscriptRecord {
  readonly kind: "event";
  readonly sequence: number;
  readonly resourceSessionId: string;
  readonly resourceCommand: NativeSessionCommand;
  readonly operationId: string;
  readonly event: string;
  readonly eventSequence: number;
  readonly eventFrameSha256: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type NativeTranscriptTermination =
  | { readonly mode: "clean-eof"; readonly code: 0; readonly signal: null }
  | {
      readonly mode: "expected-termination";
      readonly code: number | null;
      readonly signal: string | null;
      readonly expectedCode: number | null;
      readonly expectedSignal: string | null;
      readonly killSignal: "SIGTERM" | "SIGKILL";
    };

export interface NativeCommandTranscript {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-native-command-transcript";
  readonly binding: NativePreflightBinding & {
    readonly nativeSessionId: string;
    readonly runRootIdentity: string;
    readonly startupHandshake: NativeStartupHandshake;
    readonly startupHandshakeSha256: string;
  };
  readonly records: readonly (NativeCommandTranscriptRecord | NativeEventTranscriptRecord)[];
  readonly termination: NativeTranscriptTermination | null;
  readonly transcriptSha256: string;
}

export interface NativeExitExpectation {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface NativeCompletedChannel {
  readonly exit: NativeExitExpectation;
  readonly transcript: NativeCommandTranscript;
}

export interface NativeChannelTransport {
  readonly nativeSessionId: string;
  readonly closed: boolean;
  readonly exit: Promise<NativeExitExpectation>;
  sendPrepared<C extends NativeCommand>(
    prepared: NativePreparedFrameTransmission<C>,
    options: { readonly resolveCommandFailure: true },
  ): Promise<
    | { readonly ok: true; readonly result: NativeResultMap[C] }
    | { readonly ok: false; readonly error: NativeCommandFailure }
  >;
  send(
    command: "session-control",
    request: { readonly sessionId: string; readonly action: NativeSessionAction },
    operationId: string,
    timeoutMs: number,
  ): Promise<NativeSessionControlResult>;
  nextEvent(timeoutMs: number): Promise<NativeEvent | null>;
  snapshotTranscript(): NativeCommandTranscript;
  finish(timeoutMs: number): Promise<NativeExitExpectation>;
  terminateExpected(options: {
    readonly expectedExit: NativeExitExpectation;
    readonly killSignal: "SIGTERM" | "SIGKILL";
    readonly timeoutMs: number;
  }): Promise<NativeExitExpectation>;
}

export type NativeBrokerContextReceiptKind = (typeof NATIVE_BROKER_CONTEXT_KINDS)[number];

export interface NativeBrokerContextReceipt {
  readonly protocolVersion: 1;
  readonly kind: NativeBrokerContextReceiptKind;
  readonly sequence: number;
  readonly challengeSha256: string;
  readonly previousReceiptSha256: string | null;
  readonly mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1";
  readonly nativeHelperSha256: string;
  readonly mailboxRequestedPathSha256: string;
  readonly mailboxPathSha256: string;
  readonly mailboxRootObjectIdentitySha256: string;
  readonly mailboxVolumeIdSha256: string;
  readonly mailboxOwnerSidSha256: string;
  readonly mailboxAclSha256: string;
  readonly processSidSha256: string;
  readonly authenticationLuidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly mailboxFileSystem: "NTFS";
  readonly mailboxDriveType: "fixed";
  readonly mailboxLocalAbsolute: true;
  readonly mailboxNetworkPath: false;
  readonly mailboxReparsePoint: false;
  readonly journalSecurityProfile: "role-separated-append-only-journal-v1";
  readonly journalRootRequestedPathSha256: string;
  readonly journalRootPathSha256: string;
  readonly journalRootObjectIdentitySha256: string;
  readonly journalVolumeIdSha256: string;
  readonly journalRootOwnerSidSha256: string;
  readonly journalRootAclSha256: string;
  readonly journalDatabasePathSha256: string;
  readonly journalDatabaseObjectIdentitySha256: string;
  readonly journalDatabaseOwnerSidSha256: string;
  readonly journalDatabaseAclSha256: string;
  readonly journalTransportIdentitySha256: string;
  readonly journalFileSystem: "NTFS";
  readonly journalDriveType: "fixed";
  readonly journalLocalAbsolute: true;
  readonly journalNetworkPath: false;
  readonly journalReparsePoint: false;
  readonly interactiveSessionActive: true;
  readonly nativeObservationSha256: string;
  readonly receiptSha256: string;
}

export interface NativeBrokerContextInitFrame {
  readonly protocolVersion: 1;
  readonly kind: "init";
  readonly sequence: 1;
  readonly challengeSha256: string;
  readonly previousReceiptSha256: null;
  readonly mailboxPath: string;
  readonly mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1";
  readonly expectedMailboxAclSha256: string;
  readonly journalRoot: string;
  readonly journalSecurityProfile: "role-separated-append-only-journal-v1";
  readonly expectedJournalRootAclSha256: string;
  readonly expectedJournalDatabaseAclSha256: string;
}

export interface NativeBrokerStorageObservationFrame extends Omit<
  NativeBrokerContextInitFrame,
  "kind"
> {
  readonly kind: "observe";
}

export interface NativeBrokerContextControlFrame {
  readonly protocolVersion: 1;
  readonly kind: "revalidate" | "release";
  readonly sequence: number;
  readonly challengeSha256: string;
  readonly previousReceiptSha256: string;
}

export type NativeBrokerContextFrame =
  | NativeBrokerContextInitFrame
  | NativeBrokerContextControlFrame;

export interface NativeBrokerContextProtocol {
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly nativeHelperSha256: string;
  acquire(): Promise<
    NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-context-acquired";
    }
  >;
  revalidate(): Promise<
    NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-context-revalidated";
    }
  >;
  release(): Promise<{
    readonly receipt: NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-context-released";
    };
    readonly exit: NativeExitExpectation;
  }>;
  wait(): Promise<NativeExitExpectation>;
  isLive(): boolean;
}

export interface NativeBrokerStorageObservationProtocol {
  readonly brokerEnrollment: ProbeBrokerEnrollment;
  readonly nativeHelperSha256: string;
  observe(): Promise<
    NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-storage-observed";
    }
  >;
}

export interface NativeBrokerContextChannel {
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly build: NativeBuildIdentity;
  readonly acquired: NativeBrokerContextReceipt & {
    readonly kind: "windows-host-native-broker-context-acquired";
  };
  revalidate(): Promise<
    NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-context-revalidated";
    }
  >;
  release(): Promise<{
    readonly receipt: NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-context-released";
    };
    readonly exit: NativeExitExpectation;
  }>;
  wait(): Promise<NativeExitExpectation>;
  isLive(): boolean;
}

export class NativeClientError extends Error {
  readonly code: string;
  readonly win32Code?: number;
  readonly requiresProcessExit?: true;
  constructor(code: string, message: string);
}

export function buildNativeChildEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  bindings?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>>;

export function resolveNativeWindowsToolPaths(
  base: Readonly<Record<string, string | undefined>>,
  loadedSystemLibraries: readonly string[],
): Readonly<{
  systemRoot: string;
  system32: string;
  powerShellExecutable: string;
}>;

export function buildNativeToolEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  tempDirectory: string,
  loadedSystemLibraries: readonly string[],
): Readonly<{
  SystemRoot: string;
  WINDIR: string;
  PATH: string;
  TEMP: string;
  TMP: string;
}>;

export function validateNativeEvidenceSeal(value: unknown): EvidenceSealResult;
export function validateNativeCommandResult<C extends NativeCommand>(
  command: C,
  value: unknown,
): NativeResultMap[C];
export function validateNativeCommandTranscript(value: unknown): NativeCommandTranscript;
export function deriveNativeBrokerContextObservationDigest(
  value: Omit<NativeBrokerContextReceipt, "nativeObservationSha256" | "receiptSha256"> &
    Partial<Pick<NativeBrokerContextReceipt, "nativeObservationSha256" | "receiptSha256">>,
): string;
export function deriveNativeBrokerContextReceiptDigest(
  value: Omit<NativeBrokerContextReceipt, "receiptSha256"> &
    Partial<Pick<NativeBrokerContextReceipt, "receiptSha256">>,
): string;
export function validateNativeBrokerContextReceipt(value: unknown): NativeBrokerContextReceipt;
export function createNativeBrokerStorageObservationProtocol(options: {
  readonly brokerEnrollment: ProbeBrokerEnrollment;
  readonly nativeHelperSha256: string;
  readonly exchange: (
    frame: NativeBrokerStorageObservationFrame,
    timeoutMs: number,
  ) => NativeBrokerContextReceipt | Promise<NativeBrokerContextReceipt>;
  readonly waitForExit: (
    timeoutMs: number,
  ) => NativeExitExpectation | Promise<NativeExitExpectation>;
  readonly terminate: () => unknown | Promise<unknown>;
  readonly requestTimeoutMs?: number;
}): NativeBrokerStorageObservationProtocol;
export function createNativeBrokerContextProtocol(options: {
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly nativeHelperSha256: string;
  readonly exchange: (
    frame: NativeBrokerContextFrame,
    timeoutMs: number,
  ) => NativeBrokerContextReceipt | Promise<NativeBrokerContextReceipt>;
  readonly waitForExit: (
    timeoutMs: number,
  ) => NativeExitExpectation | Promise<NativeExitExpectation>;
  readonly terminate: () => unknown | Promise<unknown>;
  readonly isOpen: () => boolean;
  readonly requestTimeoutMs?: number;
}): NativeBrokerContextProtocol;

export function buildNativeHelper(options: {
  runRoot: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<NativeBuild>;

export function resolveNativeCandidateArtifactPath(options: {
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
  readonly assemblyPath: string;
}): string;

export function loadNativeHelper(options: {
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
}): Promise<NativeBuild>;

export function openNativeBrokerContextChannel(options: {
  readonly build: NativeBuild;
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<NativeBrokerContextChannel>;

export function observeNativeBrokerStorage(options: {
  readonly build: NativeBuild;
  readonly brokerEnrollment: ProbeBrokerEnrollment;
  readonly requestTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<
  Readonly<{
    brokerEnrollment: ProbeBrokerEnrollment;
    build: NativeBuildIdentity;
    observation: NativeBrokerContextReceipt & {
      readonly kind: "windows-host-native-broker-storage-observed";
    };
  }>
>;

interface NativeExecutionOptions {
  readonly runRoot: string;
  readonly preflightBinding: NativePreflightBinding;
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
  readonly signal?: AbortSignal;
}

export interface NativeChannel {
  readonly nativeSessionId: string;
  readonly build: NativeBuildIdentity;
  readonly preflightBinding: NativePreflightBinding;
  prepare<C extends NativeCommand>(
    command: C,
    request: NativeRequestMap[C],
    options?: { readonly timeoutMs?: number; readonly operationId?: string },
  ): Promise<NativePreparedRequest<C>>;
  executePrepared<C extends NativeCommand>(
    prepared: NativePreparedRequest<C>,
  ): Promise<NativeExecutionOutcome<C>>;
  execute<C extends NativeCommand>(
    command: C,
    request: NativeRequestMap[C],
    options?: { readonly timeoutMs?: number; readonly operationId?: string },
  ): Promise<{
    readonly command: C;
    readonly operationId: string;
    readonly result: NativeResultMap[C];
  }>;
  control(
    sessionId: string,
    action: NativeSessionAction,
    options?: { readonly timeoutMs?: number; readonly operationId?: string },
  ): Promise<{ readonly operationId: string; readonly result: NativeSessionControlResult }>;
  nextEvent(options?: { readonly timeoutMs?: number }): Promise<NativeEvent | null>;
  transcript(): NativeCommandTranscript;
  close(options?: { readonly timeoutMs?: number }): Promise<NativeCompletedChannel>;
  terminateExpected(options: {
    readonly expectedExit: NativeExitExpectation;
    readonly killSignal?: "SIGTERM" | "SIGKILL";
    readonly timeoutMs?: number;
  }): Promise<NativeCompletedChannel>;
  wait(): Promise<NativeExitExpectation>;
}

export function createNativeChannelApi(options: {
  readonly build: NativeBuild;
  readonly transport: NativeChannelTransport;
  readonly runRoot: string;
  readonly preflightBinding: NativePreflightBinding;
  readonly requestTimeoutMs?: number;
}): NativeChannel;

export function openNativeChannel(
  options: NativeExecutionOptions & {
    readonly requestTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
  },
): Promise<NativeChannel>;

export function invokeNative<C extends NativeCommand>(
  options: NativeExecutionOptions & {
    readonly command: C;
    readonly request: NativeRequestMap[C];
    readonly operationId?: string;
    readonly timeoutMs?: number;
  },
): Promise<{
  readonly command: C;
  readonly operationId: string;
  readonly result: NativeResultMap[C];
  readonly build: NativeBuildIdentity;
  readonly transcript: NativeCommandTranscript;
}>;

export interface RunningNativeSession<C extends NativeSessionCommand = NativeSessionCommand> {
  readonly command: C;
  readonly operationId: string;
  readonly sessionId: string;
  readonly initial: NativeResultMap[C];
  readonly build: NativeBuildIdentity;
  transcript(): NativeCommandTranscript;
  nextEvent(options?: { readonly timeoutMs?: number }): Promise<NativeEvent | null>;
  control(
    action: NativeSessionAction,
    options?: { readonly timeoutMs?: number },
  ): Promise<NativeSessionControlResult>;
  close(options?: { readonly timeoutMs?: number }): Promise<NativeCommandTranscript>;
  terminateExpected(options: {
    readonly expectedExit: NativeExitExpectation;
    readonly killSignal?: "SIGTERM" | "SIGKILL";
    readonly timeoutMs?: number;
  }): Promise<NativeCommandTranscript>;
  wait(): Promise<NativeExitExpectation>;
}

export function startNativeSession<C extends NativeSessionCommand>(
  options: NativeExecutionOptions & {
    readonly command: C;
    readonly request: NativeRequestMap[C];
    readonly operationId?: string;
    readonly timeoutMs?: number;
    readonly totalTimeoutMs?: number;
  },
): Promise<RunningNativeSession<C>>;
