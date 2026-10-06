import type { OnboardingCompletion } from "./onboarding/machine";
import type { TrainingSyncCoordinator, TrainingSyncState } from "./training-sync";

export type FirstSyncState =
  | { readonly status: "idle" }
  | { readonly status: "syncing" }
  | { readonly status: "ready" }
  | {
      readonly status: "failed";
      readonly kind: "operation" | "disconnected" | "protocol";
      readonly retryable: boolean;
    };

export interface FirstSyncPorts {
  readonly coordinator: TrainingSyncCoordinator;
  focusComposer(): void;
  render(state: FirstSyncState): void;
}

export interface FirstSyncController {
  start(completion: OnboardingCompletion): Promise<void>;
  retry(): Promise<void>;
  dispose(): void;
}

function validCompletion(value: unknown): value is OnboardingCompletion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return (
    keys.join(",") ===
      "intakeSaved,providerConfigured,requiresProviderSync,trainingDataConfigured" &&
    candidate.providerConfigured === true &&
    candidate.trainingDataConfigured === true &&
    candidate.intakeSaved === true &&
    typeof candidate.requiresProviderSync === "boolean"
  );
}

function toFirstSyncState(state: TrainingSyncState): FirstSyncState {
  if (state.status === "idle") return { status: "idle" };
  if (state.status === "queued" || state.status === "running") return { status: "syncing" };
  if (state.status === "succeeded") {
    return state.kind === "published"
      ? { status: "ready" }
      : { status: "failed", kind: "operation", retryable: true };
  }
  return {
    status: "failed",
    kind:
      state.kind === "protocol"
        ? "protocol"
        : state.kind === "indeterminate"
          ? "disconnected"
          : "operation",
    retryable: state.retryable,
  };
}

function sameState(left: FirstSyncState, right: FirstSyncState): boolean {
  return (
    left.status === right.status &&
    (left.status !== "failed" ||
      (right.status === "failed" && left.kind === right.kind && left.retryable === right.retryable))
  );
}

export function createFirstSyncController(ports: FirstSyncPorts): FirstSyncController {
  let state: FirstSyncState = { status: "idle" };
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let activated = false;
  let completed = false;
  let composerFocused = false;
  let composerFocusOperation: number | undefined;

  const apply = (syncState: TrainingSyncState): void => {
    if (disposed || !activated || completed) return;
    const next = toFirstSyncState(syncState);
    if (!sameState(state, next)) {
      state = next;
      ports.render(state);
    }
    if (
      next.status === "ready" &&
      syncState.status === "succeeded" &&
      syncState.operation === composerFocusOperation &&
      !composerFocused
    ) {
      composerFocused = true;
      ports.focusComposer();
    }
    if (next.status === "ready") completed = true;
  };
  const unsubscribe = ports.coordinator.subscribe(apply);

  const begin = (): Promise<void> => {
    const previous = ports.coordinator.getState();
    const joining = previous.status === "queued" || previous.status === "running";
    const task = ports.coordinator.request();
    const selected = ports.coordinator.getState();
    if (!joining && selected.status !== "idle") composerFocusOperation = selected.operation;
    apply(selected);
    inFlight = task;
    void task
      .finally(() => {
        if (inFlight === task) inFlight = undefined;
      })
      .catch(() => {});
    return task;
  };

  return {
    start(completion) {
      if (!validCompletion(completion)) return Promise.reject(new TypeError("Invalid completion."));
      if (disposed) return Promise.resolve();
      if (!completion.requiresProviderSync) {
        activated = false;
        completed = true;
        inFlight = undefined;
        composerFocusOperation = undefined;
        if (state.status !== "idle") {
          state = { status: "idle" };
          ports.render(state);
        }
        if (!composerFocused) {
          composerFocused = true;
          ports.focusComposer();
        }
        return Promise.resolve();
      }
      if (inFlight !== undefined) return inFlight;
      activated = true;
      completed = false;
      if (state.status === "idle" || state.status === "ready") return begin();
      return Promise.resolve();
    },
    retry() {
      if (disposed || inFlight !== undefined || state.status !== "failed" || !state.retryable) {
        return inFlight ?? Promise.resolve();
      }
      return begin();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight = undefined;
      unsubscribe();
    },
  };
}
