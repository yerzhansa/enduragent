import { msg, type Message } from "@enduragent/i18n";
import type {
  ActivityExportFormat,
  DesktopTrainingExportRequest,
  DesktopTrainingExportResult,
  TrainingExportRefusalReason,
  WorkoutArchiveFormat,
} from "@enduragent/coach-contract";

export type TrainingExportTarget = "activity" | "workout-archive";

export type TrainingExportState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly target: TrainingExportTarget }
  | {
      readonly status: "saved";
      readonly target: TrainingExportTarget;
      readonly byteLength: number;
    }
  | { readonly status: "cancelled"; readonly target: TrainingExportTarget }
  | {
      readonly status: "refused";
      readonly target: TrainingExportTarget;
      readonly reason: TrainingExportRefusalReason;
    };

export const IDLE_TRAINING_EXPORT: TrainingExportState = Object.freeze({ status: "idle" });

export interface TrainingExportTransport {
  exportTrainingFile(request: DesktopTrainingExportRequest): Promise<DesktopTrainingExportResult>;
}

export interface TrainingExportView {
  render(state: TrainingExportState): void;
}

export interface TrainingExportController {
  exportActivity(input: {
    readonly canonicalActivityId: string;
    readonly localDate: string;
    readonly format: ActivityExportFormat;
  }): Promise<void>;
  exportWorkoutArchive(input: {
    readonly oldest: string;
    readonly newest: string;
    readonly format: WorkoutArchiveFormat;
  }): Promise<void>;
}

export function createTrainingExportController(input: {
  readonly transport: TrainingExportTransport;
  readonly view: TrainingExportView;
}): TrainingExportController {
  let running = false;

  const run = async (
    target: TrainingExportTarget,
    request: DesktopTrainingExportRequest,
  ): Promise<void> => {
    if (running) return;
    running = true;
    input.view.render({ status: "running", target });
    try {
      const result = await input.transport.exportTrainingFile(request);
      input.view.render({ ...result, target });
    } catch {
      input.view.render({ status: "refused", target, reason: "write-failed" });
    } finally {
      running = false;
    }
  };

  return Object.freeze({
    exportActivity(request: Parameters<TrainingExportController["exportActivity"]>[0]) {
      return run("activity", { kind: "activity", ...request });
    },
    exportWorkoutArchive(request: Parameters<TrainingExportController["exportWorkoutArchive"]>[0]) {
      return run("workout-archive", { kind: "workout-archive", ...request });
    },
  });
}

export function trainingExportStatusCopy(state: TrainingExportState): Message | null {
  if (state.status === "idle") return null;
  if (state.status === "running") return msg("training.export.status.chooseLocation");
  if (state.status === "saved") return msg("training.export.status.saved");
  if (state.status === "cancelled") return msg("training.export.status.cancelled");
  const copy: Record<TrainingExportRefusalReason, Message> = {
    "not-configured": msg("training.export.status.notConfigured"),
    "source-not-found": msg("training.export.status.sourceNotFound"),
    "ambiguous-source": msg("training.export.status.ambiguousSource"),
    "provider-unavailable": msg("training.export.status.providerUnavailable"),
    "not-supported": msg("training.export.status.notSupported"),
    "rate-limited": msg("training.export.status.rateLimited"),
    network: msg("training.export.status.network"),
    timeout: msg("training.export.status.timeout"),
    "response-too-large": msg("training.export.status.responseTooLarge"),
    "invalid-response": msg("training.export.status.invalidResponse"),
    "write-failed": msg("training.export.status.writeFailed"),
    "commit-uncertain": msg("training.export.status.commitUncertain"),
  };
  return copy[state.reason];
}
