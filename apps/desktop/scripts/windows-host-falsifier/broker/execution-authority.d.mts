import type { ProbeBrokerRole, ProbeBrokerScenarioCoordinate } from "./protocol.mjs";

export const PROBE_BROKER_EXECUTION_AUTHORITY_SCHEMA_VERSION: 1;
export const PROBE_BROKER_EXECUTION_AUTHORITY_PHASES: readonly [
  "journal-open",
  "mailbox-access",
  "acceptance",
  "journal-consumption",
  "effect-started",
  "physical-execution",
  "effect-committed",
  "result-validation",
  "result-retained",
  "retained-result-read",
  "release",
];

export type ProbeBrokerExecutionAuthorityPhase =
  (typeof PROBE_BROKER_EXECUTION_AUTHORITY_PHASES)[number];

export class ProbeBrokerExecutionAuthorityError extends Error {
  readonly code: string;
  readonly requiresProcessExit?: true;
  constructor(code: string, message: string);
}

export interface ProbeBrokerExecutionAuthoritySnapshot {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-execution-authority";
  readonly preparedRunGenerationSha256: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly candidateSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly coordinate: ProbeBrokerScenarioCoordinate;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly runtimeActionIntentSha256: string;
  readonly operationId: string;
  readonly producerActionId: string;
  readonly driverId: string;
  readonly brokerEnrollmentSha256: string;
  readonly preparedBrokerEnrollmentSha256: string;
  readonly brokerInstanceId: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly mailboxRootObjectIdentitySha256: string;
  readonly mailboxVolumeIdSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly mailboxAclSha256: string;
  readonly mailboxOwnerSidSha256: string;
  readonly journalRoot: string;
  readonly journalSecurityProfile: "role-separated-append-only-journal-v1";
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
  readonly peerAuthoritySha256: string | null;
}

declare const executionAuthorityLease: unique symbol;
export interface ProbeBrokerExecutionAuthorityLease {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-execution-authority-lease";
  readonly authoritySha256: string;
  readonly [executionAuthorityLease]: true;
}

declare const executionAuthorityConfirmation: unique symbol;
export interface ProbeBrokerExecutionAuthorityConfirmation {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-execution-authority-confirmation";
  readonly authoritySha256: string;
  readonly phase: ProbeBrokerExecutionAuthorityPhase;
  readonly sequence: number;
  readonly confirmationSha256: string;
  readonly [executionAuthorityConfirmation]: true;
}

export function acquireProbeBrokerExecutionAuthorityLease(options: {
  readonly acquire: () =>
    | ProbeBrokerExecutionAuthoritySnapshot
    | Promise<ProbeBrokerExecutionAuthoritySnapshot>;
  readonly revalidate: () =>
    | ProbeBrokerExecutionAuthoritySnapshot
    | Promise<ProbeBrokerExecutionAuthoritySnapshot>;
  readonly release: () => void | Promise<void>;
}): Promise<ProbeBrokerExecutionAuthorityLease>;

export function assertProbeBrokerExecutionAuthorityLease(value: unknown): Readonly<{
  authoritySha256: string;
  snapshot: ProbeBrokerExecutionAuthoritySnapshot;
}>;
export function bindProbeBrokerExecutionAuthorityLeaseToOperation(
  lease: ProbeBrokerExecutionAuthorityLease,
  physicalOperationKeySha256: string,
): void;

export function confirmProbeBrokerExecutionAuthority(
  lease: ProbeBrokerExecutionAuthorityLease,
  phase: ProbeBrokerExecutionAuthorityPhase,
): Promise<ProbeBrokerExecutionAuthorityConfirmation>;

export function consumeProbeBrokerExecutionAuthorityConfirmation(
  lease: ProbeBrokerExecutionAuthorityLease,
  confirmation: ProbeBrokerExecutionAuthorityConfirmation,
  expectedPhase: ProbeBrokerExecutionAuthorityPhase,
): Promise<ProbeBrokerExecutionAuthoritySnapshot>;
export function discardProbeBrokerExecutionAuthorityConfirmation(
  lease: ProbeBrokerExecutionAuthorityLease,
  confirmation: ProbeBrokerExecutionAuthorityConfirmation,
  expectedPhase: ProbeBrokerExecutionAuthorityPhase,
): void;
export function withProbeBrokerExecutionAuthorityConfirmation<Result>(
  lease: ProbeBrokerExecutionAuthorityLease,
  confirmation: ProbeBrokerExecutionAuthorityConfirmation,
  expectedPhase: ProbeBrokerExecutionAuthorityPhase,
  operation: (snapshot: ProbeBrokerExecutionAuthoritySnapshot) => Result | Promise<Result>,
): Promise<Result>;
export function withProbeBrokerExecutionAuthorityLease<Result>(
  lease: ProbeBrokerExecutionAuthorityLease,
  phase: ProbeBrokerExecutionAuthorityPhase,
  operation: (snapshot: ProbeBrokerExecutionAuthoritySnapshot) => Result | Promise<Result>,
): Promise<Result>;
export function markProbeBrokerExecutionAuthorityEffectStarted(
  lease: ProbeBrokerExecutionAuthorityLease,
): void;
export function markProbeBrokerExecutionAuthorityResultRetained(
  lease: ProbeBrokerExecutionAuthorityLease,
): void;

export function releaseProbeBrokerExecutionAuthorityLease(
  lease: ProbeBrokerExecutionAuthorityLease,
): Promise<void>;
