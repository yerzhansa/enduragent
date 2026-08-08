import type { ProbeEnvironmentId } from "../probe-contract.mjs";
import type {
  ProbeBrokerControllerAcceptanceInput,
  ProbeBrokerResult,
  ProbeBrokerRole,
  ProbeBrokerTask,
} from "./protocol.mjs";

export const PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION: 1;
export const PROBE_BROKER_ENROLLMENT_KIND: "windows-host-probe-broker-enrollment";
export const PROBE_BROKER_MAILBOX_OBSERVATION_KIND: "windows-host-probe-broker-mailbox-observation";
export const PROBE_PREPARED_BROKER_ENROLLMENT_KIND: "windows-host-probe-prepared-broker-enrollment";
export const PROBE_BROKER_MAILBOX_TASK_KIND: "windows-host-probe-broker-mailbox-task";
export const PROBE_BROKER_MAILBOX_RESULT_KIND: "windows-host-probe-broker-mailbox-result";
export const PROBE_BROKER_MAILBOX_REFUSAL_KIND: "windows-host-probe-broker-mailbox-refusal";
export const PROBE_BROKER_MAILBOX_SECURITY_PROFILE: "role-separated-immutable-file-mailbox-v1";
export const PROBE_BROKER_JOURNAL_SECURITY_PROFILE: "role-separated-append-only-journal-v1";
export const PROBE_BROKER_MAILBOX_REFUSAL_CODES: readonly [
  "AUTHORITY_MISMATCH",
  "BLOB_INVALID",
  "DEADLINE_EXPIRED",
  "EQUIVOCATION",
  "MALFORMED_TASK",
  "RECOVERY_REQUIRED",
  "UNSUPPORTED_DRIVER",
];

export class ProbeBrokerMailboxProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeBrokerMailboxRefusalCode = (typeof PROBE_BROKER_MAILBOX_REFUSAL_CODES)[number];

export interface ProbeBrokerEnrollmentFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-enrollment";
  readonly environmentId: ProbeEnvironmentId;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly mailboxRoot: string;
  readonly mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1";
  readonly mailboxAclSha256: string;
  readonly journalRoot: string;
  readonly journalSecurityProfile: "role-separated-append-only-journal-v1";
  readonly journalRootAclSha256: string;
  readonly journalDatabaseAclSha256: string;
  readonly processSidSha256: string;
  readonly peerAuthoritySha256: string | null;
}

export interface ProbeBrokerEnrollment extends ProbeBrokerEnrollmentFields {
  readonly brokerEnrollmentSha256: string;
}

export type ProbeBrokerEnrollmentCreateInput = Omit<
  ProbeBrokerEnrollmentFields,
  "schemaVersion" | "kind" | "mailboxSecurityProfile" | "journalSecurityProfile"
>;

export interface ProbeBrokerMailboxObservation {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-mailbox-observation";
  readonly brokerEnrollmentSha256: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly mailboxRoot: string;
  readonly mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1";
  readonly mailboxAclSha256: string;
  readonly mailboxOwnerSidSha256: string;
  readonly processSidSha256: string;
  readonly peerAuthoritySha256: string | null;
  readonly mailboxRootObjectIdentitySha256: string;
  readonly mailboxVolumeIdSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly mailboxFileSystem: "NTFS";
  readonly mailboxDriveType: "fixed";
  readonly mailboxLocalAbsolute: true;
  readonly mailboxNetworkPath: false;
  readonly mailboxReparsePoint: false;
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
  readonly journalFileSystem: "NTFS";
  readonly journalDriveType: "fixed";
  readonly journalLocalAbsolute: true;
  readonly journalNetworkPath: false;
  readonly journalReparsePoint: false;
  readonly bootIdSha256: string;
  readonly runnerSessionIdSha256: string;
  readonly nativeHelperSha256: string;
  readonly nativeObservationSha256: string;
}

export interface ProbePreparedBrokerEnrollmentFields extends Omit<
  ProbeBrokerMailboxObservation,
  "kind"
> {
  readonly kind: "windows-host-probe-prepared-broker-enrollment";
}

export interface ProbePreparedBrokerEnrollment extends ProbePreparedBrokerEnrollmentFields {
  readonly preparedBrokerEnrollmentSha256: string;
}

export interface ProbeBrokerMailboxTaskEnvelopeDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-mailbox-task";
  readonly brokerEnrollmentSha256: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly task: ProbeBrokerTask;
}

export interface ProbeBrokerMailboxTaskEnvelope extends ProbeBrokerMailboxTaskEnvelopeDraft {
  readonly taskEnvelopeSha256: string;
}

export interface ProbeBrokerMailboxResultEnvelopeDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-mailbox-result";
  readonly brokerEnrollmentSha256: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly resultSha256: string;
  readonly result: ProbeBrokerResult;
  readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
}

export interface ProbeBrokerMailboxResultEnvelope extends ProbeBrokerMailboxResultEnvelopeDraft {
  readonly resultEnvelopeSha256: string;
}

export interface ProbeBrokerMailboxRefusalEnvelopeDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-mailbox-refusal";
  readonly brokerEnrollmentSha256: string;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly refusalCode: ProbeBrokerMailboxRefusalCode;
}

export interface ProbeBrokerMailboxRefusalEnvelope extends ProbeBrokerMailboxRefusalEnvelopeDraft {
  readonly refusalEnvelopeSha256: string;
}

export function deriveProbeBrokerEnrollmentDigest(
  value: ProbeBrokerEnrollmentFields | ProbeBrokerEnrollment,
): string;
export function createProbeBrokerEnrollment(
  input: ProbeBrokerEnrollmentCreateInput,
): ProbeBrokerEnrollment;
export function validateProbeBrokerEnrollment(value: unknown): ProbeBrokerEnrollment;
export function validateProbeBrokerEnrollmentInventory(
  value: unknown,
): readonly ProbeBrokerEnrollment[];
export function selectProbeBrokerEnrollments(
  value: unknown,
  environmentId: ProbeEnvironmentId,
): readonly ProbeBrokerEnrollment[];

export function validateProbeBrokerMailboxObservation(
  value: unknown,
): ProbeBrokerMailboxObservation;
export function deriveProbePreparedBrokerEnrollmentDigest(
  value: ProbePreparedBrokerEnrollmentFields | ProbePreparedBrokerEnrollment,
): string;
export function createProbePreparedBrokerEnrollment(
  enrollment: unknown,
  observation: unknown,
): ProbePreparedBrokerEnrollment;
export function validateProbePreparedBrokerEnrollment(
  value: unknown,
): ProbePreparedBrokerEnrollment;
export function validateProbePreparedBrokerEnrollmentSet(
  value: unknown,
  environmentId: ProbeEnvironmentId,
): readonly ProbePreparedBrokerEnrollment[];

export function deriveProbeBrokerMailboxTaskEnvelopeDigest(
  value: ProbeBrokerMailboxTaskEnvelopeDraft | ProbeBrokerMailboxTaskEnvelope,
): string;
export function createProbeBrokerMailboxTaskEnvelope(task: unknown): ProbeBrokerMailboxTaskEnvelope;
export function validateProbeBrokerMailboxTaskEnvelope(
  value: unknown,
): ProbeBrokerMailboxTaskEnvelope;

export function deriveProbeBrokerMailboxResultEnvelopeDigest(
  value: ProbeBrokerMailboxResultEnvelopeDraft | ProbeBrokerMailboxResultEnvelope,
): string;
export function createProbeBrokerMailboxResultEnvelope(
  task: unknown,
  result: unknown,
  controllerAcceptanceInput: unknown,
): ProbeBrokerMailboxResultEnvelope;
export function validateProbeBrokerMailboxResultEnvelope(
  value: unknown,
): ProbeBrokerMailboxResultEnvelope;

export function deriveProbeBrokerMailboxRefusalEnvelopeDigest(
  value: ProbeBrokerMailboxRefusalEnvelopeDraft | ProbeBrokerMailboxRefusalEnvelope,
): string;
export function createProbeBrokerMailboxRefusalEnvelope(
  task: unknown,
  refusalCode: ProbeBrokerMailboxRefusalCode,
): ProbeBrokerMailboxRefusalEnvelope;
export function validateProbeBrokerMailboxRefusalEnvelope(
  value: unknown,
): ProbeBrokerMailboxRefusalEnvelope;
