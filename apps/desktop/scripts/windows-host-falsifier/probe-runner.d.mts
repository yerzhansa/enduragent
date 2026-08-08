import type {
  ProbeCampaignManifest,
  ProbeEnvironmentId,
  ProbePathProfileId,
  ProbeVerifierId,
} from "./probe-contract.mjs";
import type { VerifiedProbeCampaignResult } from "./probe-finalizer.mjs";

export const PROBE_RUNNER_SCHEMA_VERSION: 1;
export const PROBE_RUNNER_COMMANDS: readonly [
  "prepare",
  "segment",
  "checkpoint",
  "resume",
  "finalize",
];
export const PROBE_RUNNER_EXPECTED_WORK_COUNT: 1044;

export type ProbeRunnerCommandName = (typeof PROBE_RUNNER_COMMANDS)[number];

export interface ProbeRunWorkItem {
  readonly ordinal: number;
  readonly workId: string;
  readonly stageIndex: number;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly availability: "required" | "conditional";
  readonly conditionId: string | null;
  readonly dependsOnRowIds: readonly string[];
  readonly verifierId: ProbeVerifierId;
  readonly verifierDefinitionSha256: string;
  readonly transcriptKind:
    | "windows-host-probe-controller-transcript"
    | "windows-host-probe-native-transcript";
  readonly transcriptMappingSha256: string;
  readonly transcriptCommandIds: readonly string[];
  readonly mechanismId: string;
  readonly continuationRepetitions: number;
  readonly requiresExternalCheckpoint: boolean;
}

export interface ProbeRunStage {
  readonly stageIndex: number;
  readonly rowIds: readonly string[];
  readonly dependencyStageIndexes: readonly number[];
  readonly firstWorkOrdinal: number;
  readonly lastWorkOrdinal: number;
  readonly workCount: number;
}

export interface ProbeRunPlan {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-run-plan";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly workCount: 1044;
  readonly conditionalWorkCount: number;
  readonly hardCutWorkCount: number;
  readonly stages: readonly ProbeRunStage[];
  readonly work: readonly ProbeRunWorkItem[];
  readonly planSha256: string;
}

export interface ProbeDependencySelection {
  readonly rowId: string;
  readonly selectionDigest: string;
}

interface ProbeRunnerCommandBase {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-runner-command";
  readonly mode: "authoritative";
  readonly command: ProbeRunnerCommandName;
  readonly campaignRunId: string;
  readonly planSha256: string;
}

interface ProbeRunnerSegmentCoordinate {
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly rowId: string;
  readonly variantId: string;
  readonly workId: string;
  readonly stageIndex: number;
}

export interface ProbeRunnerPrepareCommand extends ProbeRunnerCommandBase {
  readonly command: "prepare";
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly preparationId: string;
}

export interface ProbeRunnerSegmentCommand
  extends ProbeRunnerCommandBase, ProbeRunnerSegmentCoordinate {
  readonly command: "segment";
}

export interface ProbeRunnerContinuationCommand
  extends ProbeRunnerCommandBase, ProbeRunnerSegmentCoordinate {
  readonly command: "checkpoint" | "resume";
  readonly repetition: number;
  readonly checkpointId: string;
  readonly chainId: string;
}

export interface ProbeRunnerFinalizeSegmentCommand
  extends ProbeRunnerCommandBase, ProbeRunnerSegmentCoordinate {
  readonly command: "finalize";
  readonly scope: "segment";
}

export interface ProbeRunnerFinalizeCampaignCommand extends ProbeRunnerCommandBase {
  readonly command: "finalize";
  readonly scope: "campaign";
}

export type AuthoritativeProbeRunnerCommand =
  | ProbeRunnerPrepareCommand
  | ProbeRunnerSegmentCommand
  | ProbeRunnerContinuationCommand
  | ProbeRunnerFinalizeSegmentCommand
  | ProbeRunnerFinalizeCampaignCommand;

export interface ProbeRunnerPrepareDispatchInput {
  readonly command: ProbeRunnerPrepareCommand;
  readonly plan: ProbeRunPlan;
}

export interface ProbeRunnerWorkDispatchInput<
  Command extends
    | ProbeRunnerSegmentCommand
    | ProbeRunnerContinuationCommand
    | ProbeRunnerFinalizeSegmentCommand,
> {
  readonly command: Command;
  readonly plan: ProbeRunPlan;
  readonly workItem: ProbeRunWorkItem;
}

export interface ProbeRunnerCampaignFinalizeDispatchInput {
  readonly command: ProbeRunnerFinalizeCampaignCommand;
  readonly plan: ProbeRunPlan;
}

export interface AuthoritativeProbeRunnerDispatchers {
  readonly prepare?: (input: ProbeRunnerPrepareDispatchInput) => Promise<unknown> | unknown;
  readonly segment?: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerSegmentCommand>,
  ) => Promise<unknown> | unknown;
  readonly checkpoint?: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerContinuationCommand>,
  ) => Promise<unknown> | unknown;
  readonly resume?: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerContinuationCommand>,
  ) => Promise<unknown> | unknown;
  readonly finalizeSegment?: (
    input: ProbeRunnerWorkDispatchInput<ProbeRunnerFinalizeSegmentCommand>,
  ) => Promise<unknown> | unknown;
  readonly finalizeCampaign?: (
    input: ProbeRunnerCampaignFinalizeDispatchInput,
  ) => Promise<unknown> | unknown;
}

export class ProbeRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export const PROBE_RUN_PLAN: ProbeRunPlan;
export const PROBE_RUN_PLAN_SHA256: string;

export function deriveProbeRunPlan(manifest?: ProbeCampaignManifest): ProbeRunPlan;
export function validateProbeRunPlan(value: unknown): ProbeRunPlan;
export function getProbeRunWorkItem(input: {
  readonly environmentId: string;
  readonly pathProfileId: string;
  readonly rowId: string;
  readonly variantId: string;
}): ProbeRunWorkItem;
export function extractProbeDependencySelection(
  campaignResult: VerifiedProbeCampaignResult,
  rowId: string,
): ProbeDependencySelection;
export function deriveProbeWorkUpstreamSelectionDigests(
  campaignResult: VerifiedProbeCampaignResult,
  workItem: Pick<ProbeRunWorkItem, "environmentId" | "pathProfileId" | "rowId" | "variantId">,
): readonly string[];
export function parseAuthoritativeProbeCommand(
  argv: readonly string[],
): AuthoritativeProbeRunnerCommand;
export function validateAuthoritativeProbeCommand(value: unknown): AuthoritativeProbeRunnerCommand;
export function dispatchAuthoritativeProbeCommand(
  command: AuthoritativeProbeRunnerCommand,
  dispatchers?: AuthoritativeProbeRunnerDispatchers,
): Promise<unknown>;
