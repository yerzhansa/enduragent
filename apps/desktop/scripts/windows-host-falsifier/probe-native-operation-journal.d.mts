import type { NativeCommand } from "./native-client.mjs";
import type { ProbeNativeActionPlan } from "./probe-native-action-plan.mjs";

export const PROBE_NATIVE_OPERATION_JOURNAL_SCHEMA_VERSION: 1;
export const PROBE_NATIVE_OPERATION_INTENT_KIND: "windows-host-probe-native-operation-intent";
export const PROBE_NATIVE_OPERATION_TRANSITION_KIND: "windows-host-probe-native-operation-transition";
export const PROBE_NATIVE_OPERATION_RECOVERY_DECISION_KIND: "windows-host-probe-native-operation-recovery-decision";
export const PROBE_NATIVE_OPERATION_RECOVERY_CLASSES: readonly [
  "read-only-replay",
  "inspect-and-reconcile",
  "never-auto-replay",
];
export const PROBE_NATIVE_OPERATION_STATES: readonly [
  "claim",
  "effect-started",
  "transcript-retained",
  "terminal-result-retained",
];
export const PROBE_NATIVE_OPERATION_RECOVERY_DECISIONS: readonly [
  "CLAIM_BEFORE_EXECUTION",
  "EXECUTE",
  "RESUME_RETAINED_TRANSCRIPT",
  "REPLAY_READ_ONLY",
  "INSPECT_AND_RECONCILE",
  "INCONCLUSIVE",
  "RETURN_RETAINED_RESULT",
];

export type ProbeNativeOperationRecoveryClass =
  (typeof PROBE_NATIVE_OPERATION_RECOVERY_CLASSES)[number];
export type ProbeNativeOperationState = (typeof PROBE_NATIVE_OPERATION_STATES)[number];
export type ProbeNativeOperationRecoveryDecisionName =
  (typeof PROBE_NATIVE_OPERATION_RECOVERY_DECISIONS)[number];

export class ProbeNativeOperationJournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeNativeOperationIntentDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-native-operation-intent";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly operationId: string;
  readonly actionPlanSha256: string;
  readonly stepId: string;
  readonly command: NativeCommand;
  readonly inputSha256: string;
  readonly recoveryClass: ProbeNativeOperationRecoveryClass;
}

export interface ProbeNativeOperationIntent extends ProbeNativeOperationIntentDraft {
  readonly intentSha256: string;
}

export interface ProbeNativeOperationTransitionDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-native-operation-transition";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly sequence: number;
  readonly state: ProbeNativeOperationState;
  readonly artifactSha256: string | null;
  readonly previousRecordSha256: string | null;
}

export interface ProbeNativeOperationTransition extends ProbeNativeOperationTransitionDraft {
  readonly recordSha256: string;
}

export interface ProbeNativeOperationRetainedTranscriptReference {
  readonly transcriptSha256: string;
  readonly transitionRecordSha256: string;
}

export interface ProbeNativeOperationRecord {
  readonly operationId: string;
  readonly intent: ProbeNativeOperationIntent;
  readonly transitions: readonly ProbeNativeOperationTransition[];
  readonly currentState: ProbeNativeOperationState;
  readonly transcriptSha256: string | null;
  readonly retainedTranscript: ProbeNativeOperationRetainedTranscriptReference | null;
  readonly terminalResultSha256: string | null;
}

export interface ProbeNativeOperationRecoveryDecision {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-native-operation-recovery-decision";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly currentState: ProbeNativeOperationState | null;
  readonly recoveryClass: ProbeNativeOperationRecoveryClass;
  readonly decision: ProbeNativeOperationRecoveryDecisionName;
  readonly reason:
    | "unclaimed"
    | "claimed-without-effect"
    | "terminal-result-is-durable"
    | "retained-transcript-awaits-terminal-publication"
    | "read-only-effect-is-replayable"
    | "mutation-requires-inspection"
    | "automatic-replay-is-forbidden";
  readonly transcriptSha256: string | null;
  readonly retainedTranscript: ProbeNativeOperationRetainedTranscriptReference | null;
  readonly terminalResultSha256: string | null;
  readonly decisionSha256: string;
}

export interface ProbeNativeOperationJournalScan {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-native-operation-journal-scan";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly journalMode: "wal";
  readonly synchronous: "FULL";
  readonly operations: readonly ProbeNativeOperationRecord[];
  readonly incompleteOperationIds: readonly string[];
}

export type ProbeNativeOperationExecutionBatchAcquisition =
  | {
      readonly acquired: true;
      readonly records: readonly ProbeNativeOperationRecord[];
    }
  | {
      readonly acquired: false;
      readonly recoveries: readonly ProbeNativeOperationRecoveryDecision[];
    };

export type ProbeNativeOperationExecutionLeaseAcquisition =
  | {
      readonly acquired: true;
      release(): Promise<void>;
    }
  | {
      readonly acquired: false;
    };

export interface ProbeNativeOperationJournal {
  readonly root: string;
  readonly databasePath: string;
  acquireExecutionBatch(
    intents: readonly ProbeNativeOperationIntent[],
  ): Promise<ProbeNativeOperationExecutionBatchAcquisition>;
  tryAcquireExecutionLease(): Promise<ProbeNativeOperationExecutionLeaseAcquisition>;
  claimOperation(intent: ProbeNativeOperationIntent): Promise<{
    readonly created: boolean;
    readonly record: ProbeNativeOperationRecord;
    readonly recovery: ProbeNativeOperationRecoveryDecision;
  }>;
  recordEffectStarted(input: {
    readonly operationId: string;
    readonly intentSha256: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: ProbeNativeOperationRecord;
  }>;
  recordTranscriptRetained(input: {
    readonly operationId: string;
    readonly intentSha256: string;
    readonly artifactSha256: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: ProbeNativeOperationRecord;
  }>;
  recordTerminalResultRetained(input: {
    readonly operationId: string;
    readonly intentSha256: string;
    readonly artifactSha256: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: ProbeNativeOperationRecord;
  }>;
  decideRecovery(intent: ProbeNativeOperationIntent): Promise<ProbeNativeOperationRecoveryDecision>;
  readOperation(operationId: string): Promise<ProbeNativeOperationRecord | null>;
  scan(): Promise<ProbeNativeOperationJournalScan>;
  assertStorageStable(): Promise<void>;
  close(): Promise<void>;
}

export function deriveProbeNativeOperationIntentSha256(
  value: ProbeNativeOperationIntentDraft | ProbeNativeOperationIntent,
): string;
export function validateProbeNativeOperationIntent(value: unknown): ProbeNativeOperationIntent;
export function createProbeNativeOperationIntent(value: {
  readonly actionPlan: ProbeNativeActionPlan;
  readonly stepId: string;
  readonly inputSha256: string;
}): ProbeNativeOperationIntent;
export function deriveProbeNativeOperationTransitionSha256(
  value: ProbeNativeOperationTransitionDraft | ProbeNativeOperationTransition,
): string;
export function validateProbeNativeOperationTransition(
  value: unknown,
): ProbeNativeOperationTransition;
export function openProbeNativeOperationJournal(options: {
  readonly root: string;
  readonly limits?: {
    readonly maxOperations?: number;
  };
}): Promise<ProbeNativeOperationJournal>;
