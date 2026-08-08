import type {
  NativeBuildIdentity,
  NativeChannel,
  NativeCommand,
  NativeCommandTranscript,
  NativeCommandTranscriptRecord,
  NativePreflightBinding,
  NativePreflightObservation,
  NativePreflightTranscript,
  NativeResultMap,
} from "./native-client.mjs";
import type { ProbeNativeActionPlan } from "./probe-native-action-plan.mjs";
import type {
  ProbeProductionLaneContext,
  ProbeProductionNativeLane,
} from "./probe-production-composition.mjs";
import type { ProbeRuntimeActionInput } from "./probe-authoritative-runtime.mjs";
import type { readVerifiedControllerNativeActionPlan } from "./probe-controller-spool-transport.mjs";
import type { ProbeTranscriptObservation } from "./probe-transcript.mjs";

export { PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX } from "./probe-native-paths.mjs";

export const PROBE_NATIVE_LANE_SCHEMA_VERSION: 1;
export const PROBE_NATIVE_LANE_DRIVER_KEYS: readonly ProbeNativeLaneDriverKey[];

export type ProbeNativeLaneDriverKey =
  | "F-01:capture-home-identity"
  | "F-02:capture-directory-ensure"
  | "F-02:capture-directory-inspection"
  | "F-03:capture-target-identity"
  | "F-03:capture-private-file-create"
  | "F-04:capture-secure-path-operation"
  | "F-04:capture-evidence-tree-seal"
  | "F-05:capture-inspected-identity"
  | "F-05:capture-handle-bound-mutation";

export class ProbeNativeLaneError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function probeNativeLaneDriverKey(rowId: string, actionId: string): ProbeNativeLaneDriverKey;

export type ProbeNativeLaneStepOutcome<Command extends NativeCommand = NativeCommand> =
  | { readonly ok: true; readonly result: NativeResultMap[Command] }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly win32Code: number | null;
      };
    };

export interface ProbeNativeLaneValidatedPlan {
  readonly plan: ProbeNativeActionPlan;
  readonly primaryStepId: string;
}

export interface ProbeNativeLaneProjectionStep {
  readonly step: ProbeNativeActionPlan["steps"][number];
  readonly operationId: string;
  readonly outcome: ProbeNativeLaneStepOutcome;
  readonly recordSha256: string;
}

export type ProbeVerifiedControllerNativeActionPlan = Awaited<
  ReturnType<typeof readVerifiedControllerNativeActionPlan>
>;

export interface ProbeNativeLanePlanValidationInput {
  readonly plan: ProbeNativeActionPlan;
  readonly verifiedControllerPlan: ProbeVerifiedControllerNativeActionPlan;
  readonly input: ProbeRuntimeActionInput;
  readonly verifiedPrerequisites: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface ProbeNativeLaneProjectionInput {
  readonly input: ProbeRuntimeActionInput;
  readonly validatedPlan: ProbeNativeLaneValidatedPlan;
  readonly verifiedControllerPlan: ProbeVerifiedControllerNativeActionPlan;
  readonly verifiedPrerequisites: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly transcript: NativeCommandTranscript;
  readonly primaryRecord: NativeCommandTranscriptRecord;
  readonly steps: readonly ProbeNativeLaneProjectionStep[];
}

export interface ProbeNativeLaneRowDriver {
  readonly rowId: string;
  readonly actionId: string;
  readonly operation: string;
  readonly driverId: string;
  readonly captureCommandId: string;
  readonly factKeys: readonly string[];
  readonly validateActionPlan: (
    input: ProbeNativeLanePlanValidationInput,
  ) => ProbeNativeLaneValidatedPlan | Promise<ProbeNativeLaneValidatedPlan>;
  readonly projectActionResult: (
    input: ProbeNativeLaneProjectionInput,
  ) =>
    | { readonly observations: readonly ProbeTranscriptObservation[] }
    | Promise<{ readonly observations: readonly ProbeTranscriptObservation[] }>;
}

export type ProbeNativeLaneRowDrivers = Readonly<
  Record<ProbeNativeLaneDriverKey, ProbeNativeLaneRowDriver>
>;

export interface ProbeNativeLanePreflightExecution {
  readonly build: NativeBuildIdentity;
  readonly observation: NativePreflightObservation;
  readonly transcript: NativePreflightTranscript;
  readonly transcriptBytes: Uint8Array;
}

export type ProbeNativeLaneObservePreflight = (options: {
  readonly runRoot: string;
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
}) => ProbeNativeLanePreflightExecution | Promise<ProbeNativeLanePreflightExecution>;

export type ProbeNativeLaneOpenNativeChannel = (options: {
  readonly runRoot: string;
  readonly preflightBinding: NativePreflightBinding;
  readonly candidateRoot: string;
  readonly candidateDirectory: string;
  readonly requestTimeoutMs: number;
  readonly totalTimeoutMs: number;
}) => NativeChannel | Promise<NativeChannel>;

export function createProbeNativeLane(
  context: ProbeProductionLaneContext,
  options: {
    readonly rowDrivers: ProbeNativeLaneRowDrivers;
    readonly observePreflight?: ProbeNativeLaneObservePreflight;
    readonly openNativeChannel?: ProbeNativeLaneOpenNativeChannel;
  },
): ProbeProductionNativeLane;
