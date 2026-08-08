import type { EvidenceStore } from "../evidence-store.mjs";
import type { NativeBuild } from "../native-client.mjs";
import type { ProbeEnvironmentId } from "../probe-contract.mjs";
import type {
  ProbeBrokerEnrollment,
  ProbeBrokerMailboxObservation,
  ProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";
import type { ProbeBrokerPreparedOperationAuthority } from "./native-authority.mjs";
import type { ProbeBrokerRole } from "./protocol.mjs";
import type { ProbeBrokerWorkerDriver, ProbeBrokerWorkerOutcome } from "./worker.mjs";

export const PROBE_BROKER_ROLE_PROCESS_HOST_SCHEMA_VERSION: 1;
export const PROBE_BROKER_ROLE_PROCESS_HOST_KIND: "windows-host-probe-broker-role-process-host";

export class ProbeBrokerRoleProcessHostError extends Error {
  readonly code: string;
  readonly requiresProcessExit?: true;
  constructor(code: string, message: string);
}

export interface ProbeBrokerRoleProcessIdentity {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-role-process-host";
  readonly environmentId: ProbeEnvironmentId;
  readonly brokerRole: ProbeBrokerRole;
  readonly brokerInstanceId: string;
  readonly brokerEnrollmentSha256: string;
  readonly mailboxRoot: string;
  readonly journalRoot: string;
  readonly nativeHelperSha256: string;
  readonly controllerPublicKeySha256: string;
}

export type ProbeBrokerRoleProcessState =
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "exit-required";

export interface ProbeBrokerRoleProcessHost {
  readonly identity: ProbeBrokerRoleProcessIdentity;
  state(): ProbeBrokerRoleProcessState;
  observeMailbox(): Promise<ProbeBrokerMailboxObservation>;
  runOnce(options: {
    readonly preparedBrokerEnrollment: ProbePreparedBrokerEnrollment;
    readonly preparedOperationAuthority: ProbeBrokerPreparedOperationAuthority;
    readonly expectedPreparedOperationAuthoritySha256: string;
  }): Promise<ProbeBrokerWorkerOutcome>;
}

export function createProbeBrokerRoleProcessHost(options: {
  readonly nativeBuild: NativeBuild;
  readonly brokerEnrollment: ProbeBrokerEnrollment;
  readonly mailboxStore: EvidenceStore;
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly driverRegistry: readonly ProbeBrokerWorkerDriver[];
  readonly now: () => Date;
}): ProbeBrokerRoleProcessHost;
