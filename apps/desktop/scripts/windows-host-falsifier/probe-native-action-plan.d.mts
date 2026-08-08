import type { NativeCommand, NativeRequestMap } from "./native-client.mjs";
import type { PreparedProbeContext } from "./probe-preflight.mjs";
import type {
  ProbeRunWorkItem,
  ProbeRunnerContinuationCommand,
  ProbeRunnerFinalizeSegmentCommand,
  ProbeRunnerSegmentCommand,
} from "./probe-runner.mjs";
import type { ProbeScenarioActionInvocation } from "./probe-scenarios.mjs";

export const PROBE_NATIVE_ACTION_PLAN_SCHEMA_VERSION: 1;
export const PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES: readonly [
  "read-only-replay",
  "inspect-and-reconcile",
  "never-auto-replay",
];

export type ProbeNativeActionPlanRecoveryClass =
  (typeof PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES)[number];

export class ProbeNativeActionPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeNativeActionPlanStep = {
  readonly [Command in NativeCommand]: {
    readonly sequence: number;
    readonly stepId: string;
    readonly command: Command;
    readonly request: NativeRequestMap[Command];
    readonly timeoutMs: number;
    readonly recoveryClass: ProbeNativeActionPlanRecoveryClass;
  };
}[NativeCommand];

export interface ProbeNativeActionPlanPrerequisiteEvidence {
  readonly path: string;
  readonly sha256: string;
}

export interface ProbeNativeActionPlanFields {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-native-action-plan";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly environmentId: "win11-floor" | "win11-current";
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly rowId: string;
  readonly variantId: string;
  readonly scenarioPlanSha256: string;
  readonly producerActionId: string;
  readonly consumerActionId: string;
  readonly operationId: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly steps: readonly ProbeNativeActionPlanStep[];
  readonly prerequisiteEvidence: readonly ProbeNativeActionPlanPrerequisiteEvidence[];
}

export interface ProbeNativeActionPlan extends ProbeNativeActionPlanFields {
  readonly actionPlanSha256: string;
}

export type ProbeNativeActionPlanCreateInput = Omit<
  ProbeNativeActionPlanFields,
  "schemaVersion" | "kind" | "campaignId" | "manifestSha256" | "runPlanSha256"
>;

export function deriveProbeNativeActionPlanDigest(
  value: ProbeNativeActionPlanFields | ProbeNativeActionPlan,
): string;
export function validateProbeNativeActionPlan(value: unknown): ProbeNativeActionPlan;
export function createProbeNativeActionPlan(
  input: ProbeNativeActionPlanCreateInput,
): ProbeNativeActionPlan;
export function probeNativeActionPlanPath(input: {
  readonly campaignRunId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly consumerActionId: string;
}): string;
export function deriveProbeNativeActionPlanStepOperationId(value: unknown, stepId: string): string;
export function verifyProbeNativeActionPlanBinding(
  value: unknown,
  input: {
    readonly command:
      | ProbeRunnerSegmentCommand
      | ProbeRunnerContinuationCommand
      | ProbeRunnerFinalizeSegmentCommand;
    readonly workItem: ProbeRunWorkItem;
    readonly preparedContext: PreparedProbeContext;
    readonly invocation: ProbeScenarioActionInvocation;
    readonly operationId: string;
    readonly evidenceRootObjectIdentitySha256: string;
  },
): ProbeNativeActionPlan;
