import type { EvidenceStore } from "../evidence-store.mjs";
import type { NativeBuild } from "../native-client.mjs";
import type { ProbeBrokerJournalRecovery } from "./journal.mjs";
import type { ProbePreparedBrokerEnrollment } from "./mailbox-protocol.mjs";
import type {
  ProbeBrokerNativeContextChannel,
  ProbeBrokerPreparedOperationAuthority,
} from "./native-authority.mjs";
import type {
  ProbeBrokerArtifactReference,
  ProbeBrokerObserverTranscriptReference,
  ProbeBrokerRecoveryClass,
  ProbeBrokerResultOutcome,
} from "./protocol.mjs";

export const PROBE_BROKER_WORKER_SCHEMA_VERSION: 1;
export const PROBE_BROKER_WORKER_DRIVER_TERMINAL_KIND: "windows-host-probe-broker-worker-driver-terminal";
export const PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND: "windows-host-probe-broker-worker-manual-intervention";

export class ProbeBrokerWorkerError extends Error {
  readonly code: string;
  readonly manualIntervention?: ProbeBrokerWorkerManualIntervention;
  readonly requiresProcessExit?: true;
  constructor(code: string, message: string);
}

export interface ProbeBrokerWorkerArtifact {
  readonly reference: ProbeBrokerArtifactReference;
  readonly bytes: Uint8Array;
}

export interface ProbeBrokerWorkerDriverTerminal {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-worker-driver-terminal";
  readonly effectSha256: string;
  readonly outcome: ProbeBrokerResultOutcome;
  readonly driverResultArtifact: ProbeBrokerArtifactReference;
  readonly proofArtifacts: readonly ProbeBrokerArtifactReference[];
  readonly observerTranscripts: readonly ProbeBrokerObserverTranscriptReference[];
  readonly pausedSessionReceipt: ProbeBrokerArtifactReference | null;
  readonly artifacts: readonly ProbeBrokerWorkerArtifact[];
}

export interface ProbeBrokerWorkerManualIntervention {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-broker-worker-manual-intervention";
  readonly reasonCode: string;
}

export interface ProbeBrokerWorkerDriver {
  readonly driverId: string;
  readonly requestSchemaSha256: string;
  readonly recoveryClass: ProbeBrokerRecoveryClass;
  validateRequest(
    driverRequestBytes: Buffer,
    preparedOperationAuthority: ProbeBrokerPreparedOperationAuthority,
  ): unknown | Promise<unknown>;
  execute(
    preparedRequest: unknown,
  ): ProbeBrokerWorkerDriverTerminal | Promise<ProbeBrokerWorkerDriverTerminal>;
  reconcile(
    preparedRequest: unknown,
    recovery: ProbeBrokerJournalRecovery,
  ):
    | ProbeBrokerWorkerDriverTerminal
    | ProbeBrokerWorkerManualIntervention
    | Promise<ProbeBrokerWorkerDriverTerminal | ProbeBrokerWorkerManualIntervention>;
}

export type ProbeBrokerWorkerOutcome = Readonly<
  {
    schemaVersion: 1;
    kind: "windows-host-probe-broker-worker-outcome";
    physicalOperationKeySha256: string;
    taskSha256: string;
  } & (
    | {
        disposition: "published-result" | "replayed-retained-result";
        resultSha256: string;
        resultEnvelopeSha256: string;
      }
    | {
        disposition: "published-refusal";
        refusalCode: string;
        refusalEnvelopeSha256: string;
      }
  )
>;

export interface ProbeBrokerWorker {
  run(): Promise<ProbeBrokerWorkerOutcome>;
}

export function createProbeBrokerWorker(options: {
  readonly nativeBuild: NativeBuild;
  readonly preparedBrokerEnrollment: ProbePreparedBrokerEnrollment;
  readonly preparedOperationAuthority: ProbeBrokerPreparedOperationAuthority;
  readonly expectedPreparedOperationAuthoritySha256: string;
  readonly mailboxStore: EvidenceStore;
  readonly journalRoot: string;
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly driverRegistry: readonly ProbeBrokerWorkerDriver[];
  readonly now: () => Date;
  readonly openNativeBrokerContextChannel?: () => Promise<ProbeBrokerNativeContextChannel>;
}): ProbeBrokerWorker;
