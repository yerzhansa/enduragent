import type {
  ProbeAcceptedBrokerTaskContext,
  ProbeBrokerAcceptanceCapability,
  ProbeBrokerControllerAcceptanceInput,
  ProbeBrokerDriverValidationReceipt,
  ProbeBrokerDriverValidationRequest,
  ProbeBrokerRecoveryClass,
  ProbeBrokerRecoveryDirective,
  ProbeBrokerResult,
  ProbeBrokerRole,
  ProbeBrokerTask,
} from "./protocol.mjs";
import type { ProbeBrokerExecutionAuthorityLease } from "./execution-authority.mjs";
import type { ProbePreparedBrokerEnrollment } from "./mailbox-protocol.mjs";

export const PROBE_BROKER_JOURNAL_SCHEMA_VERSION: 1;
export const PROBE_BROKER_JOURNAL_STATES: readonly [
  "accepted",
  "effect-started",
  "effect-committed",
  "result-retained",
];
export const PROBE_BROKER_JOURNAL_RECOVERY_DIRECTIVES: readonly [
  "execute",
  "reconcile",
  "manual-intervention",
  "replay-retained-result",
];

export type ProbeBrokerJournalState = (typeof PROBE_BROKER_JOURNAL_STATES)[number];
export type ProbeBrokerJournalRecoveryDirective =
  (typeof PROBE_BROKER_JOURNAL_RECOVERY_DIRECTIVES)[number];

export interface ProbeBrokerJournalTaskAcceptanceOptions {
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  readonly validateDriverRequest: (
    request: ProbeBrokerDriverValidationRequest,
  ) => ProbeBrokerDriverValidationReceipt | Promise<ProbeBrokerDriverValidationReceipt>;
  readonly verificationInstant: Date;
}

export class ProbeBrokerJournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeBrokerJournalAuthority {
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly preparedBrokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly mailboxRootObjectIdentitySha256: string;
  readonly mailboxVolumeIdSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly mailboxAclSha256: string;
  readonly mailboxOwnerSidSha256: string;
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
  readonly processSidSha256: string;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly nativeObservationSha256: string;
}

export interface ProbeBrokerJournalTransitionDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-journal-transition";
  readonly authoritySha256: string;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly sequence: number;
  readonly state: ProbeBrokerJournalState;
  readonly capability: ProbeBrokerAcceptanceCapability;
  readonly capabilitySha256: string;
  readonly acceptedContextSha256: string;
  readonly protocolRecoveryDirective: ProbeBrokerRecoveryDirective;
  readonly artifactSha256: string | null;
  readonly previousRecordSha256: string | null;
}

export interface ProbeBrokerJournalTransition extends ProbeBrokerJournalTransitionDraft {
  readonly recordSha256: string;
}

export interface ProbeBrokerJournalTaskRecord {
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly taskId: string;
  readonly nonceSha256: string;
  readonly replayJournalEntrySha256: string;
  readonly task: ProbeBrokerTask;
  readonly transitions: readonly ProbeBrokerJournalTransition[];
  readonly currentState: ProbeBrokerJournalState;
  readonly effectSha256: string | null;
  readonly resultSha256: string | null;
}

export interface ProbeBrokerJournalRecoveryDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-journal-recovery";
  readonly authoritySha256: string;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly currentState: ProbeBrokerJournalState;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
  readonly protocolRecoveryDirective: ProbeBrokerRecoveryDirective;
  readonly orchestrationDirective: ProbeBrokerJournalRecoveryDirective;
  readonly transitionRecordSha256: string;
  readonly effectSha256: string | null;
  readonly resultSha256: string | null;
}

export interface ProbeBrokerJournalRecovery extends ProbeBrokerJournalRecoveryDraft {
  readonly recoverySha256: string;
}

export interface ProbeBrokerJournalScan {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-journal-scan";
  readonly authoritySha256: string;
  readonly journalMode: "wal";
  readonly lockingMode: "exclusive";
  readonly synchronous: "FULL";
  readonly tasks: readonly ProbeBrokerJournalTaskRecord[];
  readonly incompleteSemanticKeySha256s: readonly string[];
}

export type ProbeBrokerEffectAuthorization =
  | {
      readonly authorized: true;
      readonly record: ProbeBrokerJournalTaskRecord;
    }
  | {
      readonly authorized: false;
      readonly record: ProbeBrokerJournalTaskRecord;
      readonly recovery: ProbeBrokerJournalRecovery;
    };

export interface ProbeBrokerJournal {
  readonly root: string;
  readonly databasePath: string;
  readonly authoritySha256: string;
  acceptTask(
    task: ProbeBrokerTask,
    options: ProbeBrokerJournalTaskAcceptanceOptions,
  ): Promise<ProbeAcceptedBrokerTaskContext>;
  authorizeEffect(
    acceptedContext: ProbeAcceptedBrokerTaskContext,
  ): Promise<ProbeBrokerEffectAuthorization>;
  recordEffectCommitted(input: {
    readonly acceptedContext: ProbeAcceptedBrokerTaskContext;
    readonly effectSha256: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: ProbeBrokerJournalTaskRecord;
  }>;
  recordResultRetained(input: {
    readonly acceptedContext: ProbeAcceptedBrokerTaskContext;
    readonly result: ProbeBrokerResult;
  }): Promise<{
    readonly created: boolean;
    readonly record: ProbeBrokerJournalTaskRecord;
  }>;
  recover(acceptedContext: ProbeAcceptedBrokerTaskContext): Promise<ProbeBrokerJournalRecovery>;
  readTaskByDigest(taskSha256: string): Promise<ProbeBrokerJournalTaskRecord | null>;
  readRetainedResult(
    acceptedContext: ProbeAcceptedBrokerTaskContext,
  ): Promise<ProbeBrokerResult | null>;
  readRetainedCompletion(acceptedContext: ProbeAcceptedBrokerTaskContext): Promise<{
    readonly result: ProbeBrokerResult;
    readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
  } | null>;
  scan(): Promise<ProbeBrokerJournalScan>;
  assertStorageStable(): Promise<void>;
  close(): Promise<void>;
}

export function deriveProbeBrokerJournalAuthoritySha256(value: ProbeBrokerJournalAuthority): string;
export function deriveProbeBrokerJournalTransitionSha256(
  value: ProbeBrokerJournalTransitionDraft | ProbeBrokerJournalTransition,
): string;
export function validateProbeBrokerJournalTransition(value: unknown): ProbeBrokerJournalTransition;
export function deriveProbeBrokerJournalRecoverySha256(
  value: ProbeBrokerJournalRecoveryDraft | ProbeBrokerJournalRecovery,
): string;
export function validateProbeBrokerJournalRecovery(value: unknown): ProbeBrokerJournalRecovery;
export function openProbeBrokerJournal(options: {
  readonly root: string;
  readonly preparedBrokerEnrollment: ProbePreparedBrokerEnrollment;
  readonly executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  readonly limits?: {
    readonly maxTasks: number;
  };
}): Promise<ProbeBrokerJournal>;
export function openProbeBrokerJournalStorageForTest(options: {
  readonly root: string;
  readonly executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  readonly limits?: {
    readonly maxTasks: number;
  };
}): Promise<ProbeBrokerJournal>;
