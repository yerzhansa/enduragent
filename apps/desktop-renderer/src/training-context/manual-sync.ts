import type {
  TrainingSyncCoordinator,
  TrainingSyncDroppedActivities,
  TrainingSyncState,
} from "../training-sync";

export const SYNC_QUEUED_COPY = "Sync queued.";
export const SYNC_RUNNING_COPY = "Syncing training data…";
export const SYNC_PUBLISHED_COPY = "Training-data check completed.";
export const SYNC_NO_CHANGE_COPY = "Local training-data processing completed.";
export const SYNC_PARTIAL_COPY =
  "Training-data processing partially completed. Try again to finish.";
export const SYNC_OPERATION_FAILURE_COPY =
  "We couldn’t complete the training-data check. Your existing data is still available.";
export const SYNC_INDETERMINATE_COPY =
  "Connection interrupted. The sync may still be finishing. Enduragent won’t retry it automatically.";
export const SYNC_PROTOCOL_COPY =
  "Enduragent couldn’t verify the sync result. Quit and reopen Enduragent.";

export const STRAVA_RESTRICTION_DESKTOP_COPY = Object.freeze({
  syncMessage(count: number): string {
    return count === 1
      ? "Strava does not allow third-party AI tools to use data from its API, so one activity isn’t included."
      : `Strava does not allow third-party AI tools to use data from its API, so ${count} activities aren’t included.`;
  },
  tooltipLead(count: number): string {
    return count === 1 ? "1 activity hidden by Strava" : `${count} activities hidden by Strava`;
  },
  tooltipBody: "Strava does not allow third-party AI tools to use data from its API.",
  cardTitle(count: number, total: number): string {
    return count === 1 && total === 1
      ? "1 of 1 activity is hidden by Strava"
      : `${count} of ${total} activities are hidden by Strava`;
  },
  cause:
    "Strava does not allow third-party AI tools to use data from its API. Your API key is fine.",
  future:
    "Connect your recording source directly to intervals.icu and keep Strava connected. This is free and covers future rides.",
  past: "Use Import All Strava Data in intervals.icu settings. This covers past rides and requires an intervals.icu supporter subscription.",
});

export interface SourceRestrictionSummary {
  readonly count: number;
  readonly total: number;
}

export interface ManualSyncViewState {
  readonly label: "Sync now" | "Sync again" | "Try again" | "Sync unavailable";
  readonly message: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly tone: "idle" | "active" | "success" | "partial" | "failure";
  readonly droppedActivities?: TrainingSyncDroppedActivities;
}

export interface ManualSyncView {
  render(state: ManualSyncViewState): void;
  restoreKeyboardFocus(): void;
}

export interface ManualSyncController {
  activate(kind: "keyboard" | "pointer"): Promise<void>;
  dispose(): void;
}

export function sourceRestrictionSummary(
  droppedActivities: TrainingSyncDroppedActivities | undefined,
  source: string,
): SourceRestrictionSummary | null {
  if (droppedActivities === undefined) return null;
  const restriction = droppedActivities.overall.restrictions.find(
    (entry) => entry.reason === "source-restricted" && entry.source === source,
  );
  return restriction === undefined
    ? null
    : { count: restriction.count, total: droppedActivities.overall.total };
}

export function toManualSyncViewState(state: TrainingSyncState): ManualSyncViewState {
  switch (state.status) {
    case "idle":
      return { label: "Sync now", message: "", disabled: false, busy: false, tone: "idle" };
    case "queued":
      return {
        label: "Sync now",
        message: SYNC_QUEUED_COPY,
        disabled: true,
        busy: true,
        tone: "active",
      };
    case "running":
      return {
        label: "Sync now",
        message: SYNC_RUNNING_COPY,
        disabled: true,
        busy: true,
        tone: "active",
      };
    case "succeeded": {
      const message = state.kind === "published" ? SYNC_PUBLISHED_COPY : SYNC_NO_CHANGE_COPY;
      const restriction = sourceRestrictionSummary(state.droppedActivities, "STRAVA");
      return {
        label: "Sync again",
        message:
          restriction === null
            ? message
            : `${message} ${STRAVA_RESTRICTION_DESKTOP_COPY.syncMessage(restriction.count)}`,
        disabled: false,
        busy: false,
        tone: "success",
        droppedActivities: state.droppedActivities,
      };
    }
    case "failed":
      if (state.kind === "protocol") {
        return {
          label: "Sync unavailable",
          message: SYNC_PROTOCOL_COPY,
          disabled: true,
          busy: false,
          tone: "failure",
        };
      }
      return {
        label: "Try again",
        message:
          state.kind === "partial"
            ? SYNC_PARTIAL_COPY
            : state.kind === "indeterminate"
              ? SYNC_INDETERMINATE_COPY
              : SYNC_OPERATION_FAILURE_COPY,
        disabled: false,
        busy: false,
        tone: state.kind === "partial" ? "partial" : "failure",
      };
  }
}

export function createManualSyncController(input: {
  readonly coordinator: TrainingSyncCoordinator;
  readonly view: ManualSyncView;
}): ManualSyncController {
  let disposed = false;
  let activation = 0;
  let activationTask: Promise<void> | undefined;
  let droppedActivities: TrainingSyncDroppedActivities | undefined;
  const unsubscribe = input.coordinator.subscribe((state) => {
    if (disposed) return;
    const next = toManualSyncViewState(state);
    if (next.droppedActivities !== undefined) droppedActivities = next.droppedActivities;
    input.view.render(
      droppedActivities === undefined || next.droppedActivities !== undefined
        ? next
        : { ...next, droppedActivities },
    );
  });

  return {
    activate(kind) {
      if (disposed) return Promise.resolve();
      if (activationTask !== undefined) return activationTask;
      const state = input.coordinator.getState();
      if (
        state.status === "queued" ||
        state.status === "running" ||
        (state.status === "failed" && state.kind === "protocol")
      ) {
        return Promise.resolve();
      }
      const selectedActivation = ++activation;
      const task = input.coordinator.request();
      const selectedState = input.coordinator.getState();
      const selectedOperation =
        selectedState.status === "idle" ? undefined : selectedState.operation;
      activationTask = task;
      void task
        .then(() => {
          const currentState = input.coordinator.getState();
          const currentOperation =
            currentState.status === "idle" ? undefined : currentState.operation;
          if (
            !disposed &&
            selectedActivation === activation &&
            selectedOperation === currentOperation &&
            kind === "keyboard"
          ) {
            input.view.restoreKeyboardFocus();
          }
        })
        .finally(() => {
          if (activationTask === task) activationTask = undefined;
        });
      return task;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activation += 1;
      activationTask = undefined;
      unsubscribe();
    },
  };
}
