import type {
  ProbeTranscriptCommandEvent,
  ProbeTranscriptFactValue,
  ProbeTranscriptProducerKind,
} from "./probe-transcript.mjs";

export const PROBE_SCENARIO_SCHEMA_VERSION: 1;

export class ProbeScenarioError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeScenarioActor = "native-helper" | "external-controller";
export type ProbeScenarioActionPhase = "setup" | "transition" | "recovery" | "capture";
export type ProbeScenarioParameterValue = ProbeTranscriptFactValue;

export interface ProbeScenarioCapturePlan {
  readonly sequence: number;
  readonly commandId: string;
  readonly factKeys: readonly string[];
}

export interface ProbeScenarioAction {
  readonly sequence: number;
  readonly actionId: string;
  readonly actor: ProbeScenarioActor;
  readonly phase: ProbeScenarioActionPhase;
  readonly operation: string;
  readonly parameters: Readonly<Record<string, ProbeScenarioParameterValue>>;
  readonly prerequisiteActionIds: readonly string[];
  readonly capture: ProbeScenarioCapturePlan | null;
}

export interface ProbeScenarioPrerequisites {
  readonly completedRowIds: readonly string[];
  readonly attestationCapabilityIds: readonly string[];
  readonly conditionId: string | null;
}

export type ProbeScenarioContinuationRequirement =
  | {
      readonly kind: "none";
      readonly checkpoint: null;
      readonly repetitions: 0;
    }
  | {
      readonly kind: "external-hard-cut";
      readonly checkpoint: string;
      readonly repetitions: number;
    };

export interface ProbeScenarioDefinition {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-scenario-definition";
  readonly rowId: string;
  readonly variantId: string;
  readonly transcriptProducerKind: ProbeTranscriptProducerKind;
  readonly prerequisites: ProbeScenarioPrerequisites;
  readonly continuation: ProbeScenarioContinuationRequirement;
  readonly actions: readonly ProbeScenarioAction[];
  readonly planSha256: string;
}

export interface ProbeScenarioEvidenceArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface ProbeScenarioActionInvocation {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-scenario-action-invocation";
  readonly rowId: string;
  readonly variantId: string;
  readonly planSha256: string;
  readonly action: ProbeScenarioAction;
}

export interface ProbeScenarioActionResult {
  readonly actionId: string;
  readonly commandEvent: ProbeTranscriptCommandEvent | null;
  readonly evidenceArtifacts: readonly ProbeScenarioEvidenceArtifact[];
}

export type ProbeScenarioActionSeam = (
  invocation: ProbeScenarioActionInvocation,
) => ProbeScenarioActionResult | Promise<ProbeScenarioActionResult>;

export interface ProbeScenarioCapture {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-scenario-capture";
  readonly rowId: string;
  readonly variantId: string;
  readonly planSha256: string;
  readonly transcriptProducerKind: ProbeTranscriptProducerKind;
  readonly commandEvents: readonly ProbeTranscriptCommandEvent[];
  readonly evidenceArtifacts: readonly ProbeScenarioEvidenceArtifact[];
}

export interface ProbeScenarioPartialCapture {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-scenario-partial-capture";
  readonly rowId: string;
  readonly variantId: string;
  readonly planSha256: string;
  readonly actionIds: readonly string[];
  readonly commandEvents: readonly ProbeTranscriptCommandEvent[];
  readonly evidenceArtifacts: readonly ProbeScenarioEvidenceArtifact[];
}

export const PROBE_SCENARIO_DEFINITIONS: readonly ProbeScenarioDefinition[];

export function getProbeScenarioDefinition(
  rowId: string,
  variantId: string,
): ProbeScenarioDefinition;

export function executeProbeScenarioActionSlice(input: {
  readonly rowId: string;
  readonly variantId: string;
  readonly actionIds: readonly string[];
  readonly invokeNative?: ProbeScenarioActionSeam;
  readonly invokeController?: ProbeScenarioActionSeam;
}): Promise<ProbeScenarioPartialCapture>;

export function executeProbeScenario(input: {
  readonly rowId: string;
  readonly variantId: string;
  readonly invokeNative?: ProbeScenarioActionSeam;
  readonly invokeController?: ProbeScenarioActionSeam;
}): Promise<ProbeScenarioCapture>;
