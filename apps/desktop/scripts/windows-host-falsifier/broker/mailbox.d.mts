import type { EvidenceStore } from "../evidence-store.mjs";
import type {
  ProbeBrokerArtifactReference,
  ProbeBrokerControllerAcceptanceInput,
  ProbeBrokerResult,
  ProbeBrokerTask,
} from "./protocol.mjs";
import type {
  ProbeBrokerMailboxRefusalCode,
  ProbeBrokerMailboxRefusalEnvelope,
  ProbeBrokerMailboxResultEnvelope,
  ProbeBrokerMailboxTaskEnvelope,
  ProbeBrokerMailboxObservation,
  ProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";

export const PROBE_BROKER_MAILBOX_SCHEMA_VERSION: 1;
export const PROBE_BROKER_MAILBOX_MECHANISM: "role-separated-hardlink-publication-v1";
export const PROBE_BROKER_MAILBOX_PRINCIPALS: readonly ["broker", "controller"];

export class ProbeBrokerMailboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeBrokerMailboxPrincipal = (typeof PROBE_BROKER_MAILBOX_PRINCIPALS)[number];

export interface ProbeBrokerMailboxAuthorityRequest {
  readonly preparedBrokerEnrollmentSha256: string;
  readonly brokerEnrollmentSha256: string;
  readonly environmentId: ProbePreparedBrokerEnrollment["environmentId"];
  readonly brokerRole: ProbePreparedBrokerEnrollment["brokerRole"];
  readonly brokerInstanceId: string;
  readonly mailboxRoot: string;
}

export type ProbeBrokerMailboxAuthorityGuard = (
  request: ProbeBrokerMailboxAuthorityRequest,
) => ProbeBrokerMailboxObservation | Promise<ProbeBrokerMailboxObservation>;

export interface ProbeBrokerMailboxArtifact {
  readonly reference: ProbeBrokerArtifactReference;
  readonly bytes: Buffer;
}

declare const authenticatedProbeBrokerMailboxTask: unique symbol;
export interface ProbeAuthenticatedBrokerMailboxTask {
  readonly envelope: ProbeBrokerMailboxTaskEnvelope;
  readonly task: ProbeBrokerTask;
  readonly driverRequestBytes: Buffer;
  readonly preparedBrokerEnrollmentSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly [authenticatedProbeBrokerMailboxTask]: true;
}

declare const authenticatedProbeBrokerMailboxResult: unique symbol;
export interface ProbeAuthenticatedBrokerMailboxResult {
  readonly envelope: ProbeBrokerMailboxResultEnvelope;
  readonly result: ProbeBrokerResult;
  readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
  readonly artifacts: readonly ProbeBrokerMailboxArtifact[];
  readonly preparedBrokerEnrollmentSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly [authenticatedProbeBrokerMailboxResult]: true;
}

declare const authenticatedProbeBrokerMailboxRefusal: unique symbol;
export interface ProbeAuthenticatedBrokerMailboxRefusal {
  readonly envelope: ProbeBrokerMailboxRefusalEnvelope;
  readonly preparedBrokerEnrollmentSha256: string;
  readonly mailboxTransportIdentitySha256: string;
  readonly [authenticatedProbeBrokerMailboxRefusal]: true;
}

export function assertProbeBrokerMailboxBytesSafe(
  value: Uint8Array,
  options?: { readonly forbiddenValues?: readonly string[] },
): Buffer;

export function initializeProbeBrokerMailboxStore(options: {
  readonly store: EvidenceStore;
}): Promise<{
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-mailbox-initialized";
  readonly mechanism: "role-separated-hardlink-publication-v1";
}>;

export interface ProbeBrokerMailbox {
  readonly binding: ProbePreparedBrokerEnrollment;
  readonly principal: ProbeBrokerMailboxPrincipal;
  assertMailboxAuthority(): Promise<ProbeBrokerMailboxObservation>;
  listTaskPhysicalOperationKeys(): Promise<readonly string[]>;
  publishTask(input: {
    readonly task: ProbeBrokerTask;
    readonly driverRequestBytes: Uint8Array;
  }): Promise<ProbeBrokerMailboxTaskEnvelope>;
  readTask(physicalOperationKeySha256: string): Promise<ProbeAuthenticatedBrokerMailboxTask>;
  stageResultArtifacts(input: {
    readonly task: ProbeBrokerTask;
    readonly result: ProbeBrokerResult;
    readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
    readonly artifacts: readonly {
      readonly reference: ProbeBrokerArtifactReference;
      readonly bytes: Uint8Array;
    }[];
  }): Promise<ProbeBrokerMailboxResultEnvelope>;
  publishRetainedResult(input: {
    readonly task: ProbeBrokerTask;
    readonly result: ProbeBrokerResult;
    readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
  }): Promise<ProbeBrokerMailboxResultEnvelope>;
  publishResult(input: {
    readonly task: ProbeBrokerTask;
    readonly result: ProbeBrokerResult;
    readonly controllerAcceptanceInput: ProbeBrokerControllerAcceptanceInput;
    readonly artifacts: readonly {
      readonly reference: ProbeBrokerArtifactReference;
      readonly bytes: Uint8Array;
    }[];
  }): Promise<ProbeBrokerMailboxResultEnvelope>;
  readResult(task: ProbeBrokerTask): Promise<ProbeAuthenticatedBrokerMailboxResult>;
  publishRefusal(input: {
    readonly task: ProbeBrokerTask;
    readonly refusalCode: ProbeBrokerMailboxRefusalCode;
  }): Promise<ProbeBrokerMailboxRefusalEnvelope>;
  readRefusal(task: ProbeBrokerTask): Promise<ProbeAuthenticatedBrokerMailboxRefusal>;
}

export function openProbeBrokerMailbox(options: {
  readonly store: EvidenceStore;
  readonly binding: ProbePreparedBrokerEnrollment;
  readonly principal: ProbeBrokerMailboxPrincipal;
  readonly assertMailboxAuthority: ProbeBrokerMailboxAuthorityGuard;
  readonly forbiddenValues?: readonly string[];
}): ProbeBrokerMailbox;
