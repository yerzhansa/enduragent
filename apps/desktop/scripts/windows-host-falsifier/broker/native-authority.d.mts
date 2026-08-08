import type { NativeBrokerContextReceipt, NativeBuild } from "../native-client.mjs";
import type { ProbeBrokerExecutionAuthorityLease } from "./execution-authority.mjs";
import type { ProbeBrokerMailboxAuthorityGuard } from "./mailbox.mjs";
import type {
  ProbeBrokerEnrollment,
  ProbeBrokerMailboxObservation,
  ProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";
import type {
  ProbeBrokerRole,
  ProbeBrokerScenarioCoordinate,
  ProbeBrokerTask,
} from "./protocol.mjs";

export const PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_SCHEMA_VERSION: 1;
export const PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_KIND: "windows-host-probe-broker-prepared-operation-authority";

export class ProbeBrokerNativeAuthorityError extends Error {
  readonly code: string;
  readonly requiresProcessExit?: true;
  constructor(code: string, message: string);
}

export interface ProbeBrokerPreparedOperationAuthorityFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-prepared-operation-authority";
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
}

export interface ProbeBrokerPreparedOperationAuthority extends ProbeBrokerPreparedOperationAuthorityFields {
  readonly preparedOperationAuthoritySha256: string;
}

export type ProbeBrokerPreparedOperationAuthorityCreateInput = Omit<
  ProbeBrokerPreparedOperationAuthorityFields,
  "schemaVersion" | "kind"
>;

export interface ProbeBrokerNativeContextChannel {
  readonly acquired: NativeBrokerContextReceipt;
  revalidate(): Promise<NativeBrokerContextReceipt>;
  release(): Promise<unknown>;
}

export interface ProbeBrokerNativeAuthoritySession {
  readonly preparedOperationAuthority: ProbeBrokerPreparedOperationAuthority;
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  readonly assertMailboxAuthority: ProbeBrokerMailboxAuthorityGuard;
  release(): Promise<void>;
}

export function deriveProbeBrokerPreparedOperationAuthorityDigest(
  value: ProbeBrokerPreparedOperationAuthorityFields | ProbeBrokerPreparedOperationAuthority,
): string;
export function createProbeBrokerPreparedOperationAuthority(
  input: ProbeBrokerPreparedOperationAuthorityCreateInput,
): ProbeBrokerPreparedOperationAuthority;
export function validateProbeBrokerPreparedOperationAuthority(
  value: unknown,
): ProbeBrokerPreparedOperationAuthority;
export function assertProbeBrokerTaskMatchesPreparedOperationAuthority(
  task: ProbeBrokerTask,
  authority: ProbeBrokerPreparedOperationAuthority,
): ProbeBrokerTask;
export function createProbeBrokerMailboxObservationFromNativeStorage(options: {
  readonly brokerEnrollment: ProbeBrokerEnrollment;
  readonly nativeHelperSha256: string;
  readonly observation: NativeBrokerContextReceipt & {
    readonly kind: "windows-host-native-broker-storage-observed";
  };
}): ProbeBrokerMailboxObservation;
export function openProbeBrokerNativeAuthoritySession(options: {
  readonly build: NativeBuild;
  readonly preparedMailboxBinding: ProbePreparedBrokerEnrollment;
  readonly preparedOperationAuthority: ProbeBrokerPreparedOperationAuthority;
  readonly expectedPreparedOperationAuthoritySha256: string;
  readonly openContextChannel?: () => Promise<ProbeBrokerNativeContextChannel>;
}): Promise<ProbeBrokerNativeAuthoritySession>;
