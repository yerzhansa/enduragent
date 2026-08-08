export const RESULT_SCHEMA_VERSION: 1;
export const EXPERIMENT_PHASES: readonly ["probe", "implementation", "package", "release"];
export const EXPERIMENT_STATUSES: readonly ["PASS", "FAIL", "INCONCLUSIVE"];
export const FOUNDATION_OUTCOMES: readonly [
  "foundation-succeeded",
  "foundation-failed",
  "foundation-inconclusive",
];
export const FOUNDATION_DISPOSAL_STATES: readonly ["external-runner-disposal-required"];
export const EXPERIMENT_IDS: readonly string[];

export type ExperimentPhase = (typeof EXPERIMENT_PHASES)[number];
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type FoundationOutcome = (typeof FOUNDATION_OUTCOMES)[number];

export interface ObservedWindowsHost {
  readonly platform: string;
  readonly processArchitecture: string;
  readonly machineArchitecture: string;
  readonly windowsEdition: string;
  readonly osCaption: string;
  readonly osVersion: string;
  readonly osBuild: string;
  readonly productType: string;
  readonly fileSystem: string;
  readonly elevated: boolean | null;
  readonly userSid: string;
  readonly defenderAntivirusEnabled: boolean | null;
  readonly defenderRealtimeProtectionEnabled: boolean | null;
  readonly uacDefault: boolean | null;
  readonly developerModeEnabled: boolean | null;
  readonly toolchain: WindowsToolchainIdentity;
  readonly localAppData: string;
}

export interface CommonWindowsToolchainIdentity {
  readonly nodeVersion: string;
  readonly electronVersion: string;
  readonly electronBuilderVersion: string;
  readonly updaterVersion: string;
}

export interface FoundationWindowsToolchainIdentity extends CommonWindowsToolchainIdentity {
  readonly nsis: { readonly state: "not-invoked"; readonly version: null };
}

export interface AuthoritativeWindowsToolchainIdentity extends CommonWindowsToolchainIdentity {
  readonly nsis: { readonly state: "observed"; readonly version: string };
}

export type WindowsToolchainIdentity =
  | FoundationWindowsToolchainIdentity
  | AuthoritativeWindowsToolchainIdentity;

export interface RetainedWindowsEnvironmentFields {
  readonly platform: string;
  readonly processArchitecture: string;
  readonly machineArchitecture: string;
  readonly windowsEdition: string;
  readonly osCaption: string;
  readonly osVersion: string;
  readonly osBuild: string;
  readonly productType: string;
  readonly fileSystem: string;
  readonly elevated: boolean | null;
  readonly userSidSha256: string;
  readonly defenderAntivirusEnabled: boolean | null;
  readonly defenderRealtimeProtectionEnabled: boolean | null;
  readonly uacDefault: boolean | null;
  readonly developerModeEnabled: boolean | null;
}

export interface AuthoritativeWindowsEnvironment extends RetainedWindowsEnvironmentFields {
  readonly environmentKind: "controlled-windows-11-vm";
  readonly vmImageId: string;
  readonly vmSnapshotId: string;
  readonly toolchain: AuthoritativeWindowsToolchainIdentity;
}

export interface FoundationWindowsEnvironment extends RetainedWindowsEnvironmentFields {
  readonly environmentKind: "github-hosted-runner";
  readonly runnerImage: string;
  readonly runnerImageVersion: string;
  readonly hostPolicyExceptions: readonly string[];
  readonly toolchain: FoundationWindowsToolchainIdentity;
}

export interface RunIdentity {
  readonly runId: string;
  readonly repositoryCommit: string;
  readonly repositoryDirty: boolean;
  readonly scriptSha256: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly monotonicDurationMs: number;
}

export interface Observation {
  readonly step: string;
  readonly expected: string;
  readonly actual: string;
  readonly evidenceRef: string | null;
}

export interface ArtifactHash {
  readonly path: string;
  readonly sha256: string;
}

export interface ExperimentRecord {
  readonly schemaVersion: 1;
  readonly kind: "experiment";
  readonly authority: "native";
  readonly id: string;
  readonly phase: ExperimentPhase;
  readonly status: ExperimentStatus;
  readonly claim: string;
  readonly environment: AuthoritativeWindowsEnvironment;
  readonly run: RunIdentity;
  readonly observations: readonly Observation[];
  readonly stopConditionTriggered: boolean;
  readonly selectedMechanism?: string;
  readonly artifactHashes: readonly ArtifactHash[];
}

export interface FoundationRecord {
  readonly schemaVersion: 1;
  readonly kind: "ci-foundation";
  readonly authority: "non-authoritative";
  readonly outcome: FoundationOutcome;
  readonly operationQuiesced: boolean;
  readonly disposalState: "external-runner-disposal-required";
  readonly failureCode: string | null;
  readonly claim: string;
  readonly environment: FoundationWindowsEnvironment;
  readonly run: RunIdentity;
  readonly observations: readonly Observation[];
  readonly artifactHashes: readonly ArtifactHash[];
}

export class FalsifierError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function canonicalJson(value: unknown): string;
export function validateExperimentRecord(value: unknown): ExperimentRecord;
export function validateFoundationRecord(value: unknown): FoundationRecord;
export function validateRunId(value: unknown): string;
export function resolveWindowsChild(root: string, candidate: string): string;
export function validateLocalAppDataPath(value: unknown): string;
export function assessAuthoritativeHost(
  observed: ObservedWindowsHost,
): { readonly accepted: true } | { readonly accepted: false; readonly reasons: readonly string[] };
export function assessCiFoundationHost(
  observed: ObservedWindowsHost,
  options?: { readonly githubHostedRunnerAttested?: boolean },
):
  | { readonly accepted: true; readonly exceptions: readonly string[] }
  | { readonly accepted: false; readonly reasons: readonly string[] };
export function redactText(
  value: unknown,
  options?: { readonly sentinel?: string; readonly replacements?: readonly string[] },
): string;
export function bufferContainsSentinel(bytes: Uint8Array, sentinel: string): boolean;
export function scanTreeForSentinel(
  root: string,
  sentinel: string,
): Promise<{ readonly files: number; readonly bytes: number }>;
export function hashStableArtifact(
  evidenceRoot: string,
  relativePath: string,
  options?: { readonly sentinel?: string },
): Promise<ArtifactHash>;
export function classifyFoundationFinalizationError(error: unknown): {
  readonly outcome: "foundation-failed" | "foundation-inconclusive";
  readonly failureCode: string;
};
export function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  options: { readonly timeoutMs: number; readonly quiescenceMs?: number },
): Promise<
  | { readonly state: "completed"; readonly value: T }
  | { readonly state: "rejected"; readonly error: unknown }
  | { readonly state: "timed-out"; readonly quiesced: boolean }
>;
export function resolveFoundationToolchainIdentity(options?: {
  readonly nodeVersion?: string;
}): Promise<FoundationWindowsToolchainIdentity>;
export function observeWindowsHost(options?: {
  readonly localAppData?: string;
}): Promise<ObservedWindowsHost & { readonly toolchain: FoundationWindowsToolchainIdentity }>;
export function retainedFoundationEnvironment(
  observed: ObservedWindowsHost & { readonly toolchain: FoundationWindowsToolchainIdentity },
  provenance: {
    readonly runnerImage: string;
    readonly runnerImageVersion: string;
    readonly hostPolicyExceptions: readonly string[];
  },
): FoundationWindowsEnvironment;
export function retainedAuthoritativeEnvironment(
  observed: ObservedWindowsHost & { readonly toolchain: AuthoritativeWindowsToolchainIdentity },
  provenance: { readonly vmImageId: string; readonly vmSnapshotId: string },
): AuthoritativeWindowsEnvironment;
export function attestGitHubHostedRunner(
  provenance: { readonly runnerImage: string; readonly runnerImageVersion: string },
  environment?: Readonly<Record<string, string | undefined>>,
): boolean;
export function runCiFoundation(options: {
  readonly runId: string;
  readonly runnerImage: string;
  readonly runnerImageVersion: string;
  readonly observedHost?: ObservedWindowsHost & {
    readonly toolchain: FoundationWindowsToolchainIdentity;
  };
  readonly wallNow?: () => Date;
  readonly monotonicNow?: () => number;
  readonly randomBytesFn?: (length: number) => Uint8Array;
  readonly timeoutMs?: number;
  readonly quiescenceMs?: number;
  readonly selfTestOperation?: (input: {
    readonly signal: AbortSignal;
    readonly controlScratch: string;
    readonly stagedArtifactPath: string;
    readonly scratchPath: string;
    readonly sentinel: string;
  }) => Promise<unknown> | unknown;
}): Promise<{ readonly record: FoundationRecord; readonly evidenceDirectory: string }>;
