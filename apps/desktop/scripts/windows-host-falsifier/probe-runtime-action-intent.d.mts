import type {
  ProbeActionActorIdentitySource,
  ProbeActionActorRole,
  ProbeActionMapping,
} from "./probe-action-map.mjs";
import type { ProbeControllerPreparedAuthority } from "./probe-controller-prepared-authority.mjs";
import type { PreparedProbeContext } from "./probe-preflight.mjs";
import type { ProbeScenarioAction, ProbeScenarioActionInvocation } from "./probe-scenarios.mjs";

export const PROBE_RUNTIME_ACTION_INTENT_SCHEMA_VERSION: 2;

export class ProbeRuntimeActionIntentError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeRuntimeActionCommand {
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly repetition?: number;
}

export interface ProbeRuntimeActionIntent {
  readonly schemaVersion: 2;
  readonly kind: "windows-host-probe-runtime-action-intent";
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly repetition: number | null;
  readonly planSha256: string;
  readonly actionId: string;
  readonly operationId: string;
  readonly action: ProbeScenarioAction;
  readonly execution: ProbeActionMapping;
  readonly expectedActor: ProbeRuntimeExpectedActor;
}

export interface ProbeRuntimeExpectedActor {
  readonly role: ProbeActionActorRole;
  readonly identitySource: ProbeActionActorIdentitySource;
  readonly identitySha256: string;
}

export interface ProbeRuntimeActionBinding {
  readonly operationId: string;
  readonly operationIntentSha256: string;
  readonly operationIntentPath: string;
  readonly operationResultPath: string;
  readonly execution: ProbeActionMapping;
  readonly expectedActor: ProbeRuntimeExpectedActor;
  readonly intent: ProbeRuntimeActionIntent;
}

export function deriveProbeRuntimeScenarioOperationId(
  command: Pick<ProbeRuntimeActionCommand, "campaignRunId" | "attemptId" | "workId"> & {
    readonly repetition?: number;
  },
  actionId: string,
): string;

export function deriveProbeRuntimeActionPaths(
  command: Pick<ProbeRuntimeActionCommand, "campaignRunId" | "attemptId" | "workId">,
  actionId: string,
): Readonly<Pick<ProbeRuntimeActionBinding, "operationIntentPath" | "operationResultPath">>;

export function createProbeRuntimeActionBinding(input: {
  readonly command: ProbeRuntimeActionCommand;
  readonly invocation: ProbeScenarioActionInvocation;
  readonly preparedContext: PreparedProbeContext;
}): ProbeRuntimeActionBinding;

export function createProbeRuntimeActionBindingFromPreparedAuthority(input: {
  readonly command: ProbeRuntimeActionCommand;
  readonly invocation: ProbeScenarioActionInvocation;
  readonly preparedAuthority: ProbeControllerPreparedAuthority;
}): ProbeRuntimeActionBinding;
