import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import {
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  UnitsPreferenceSchema,
  type CyclingTrainingContext,
  type Freshness,
  type UnitsPreference,
} from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";

export type TrainingContextStatus = "loading" | "ready" | "unavailable" | "refresh-unavailable";

export type UnitsPreferenceStatus = "loading" | "ready" | "saving" | "unavailable";

export interface UnitsPreferenceViewState {
  readonly status: UnitsPreferenceStatus;
  readonly value: UnitsPreference;
  readonly source: "cycling" | "athlete" | "default";
}

export interface TrainingContextMetadata {
  readonly lastUpdated: string;
  readonly lastSynced: string | null;
  readonly freshness: Freshness;
  readonly degraded: boolean;
}

export interface TrainingContextViewState {
  readonly status: TrainingContextStatus;
  readonly metadata: TrainingContextMetadata | null;
  readonly trainingContext: CyclingTrainingContext;
  readonly unitsPreference: UnitsPreferenceViewState;
}

export interface TrainingContextView {
  render(state: TrainingContextViewState): void;
}

export interface TrainingContextController {
  start(): Promise<void>;
  refresh(): Promise<void>;
  setUnitsPreference(value: UnitsPreference): Promise<void>;
  dispose(): void;
}

export function createTrainingContextController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: TrainingContextView;
}): TrainingContextController {
  let disposed = false;
  let generation = 0;
  let stateRequest: Promise<void> | undefined;
  let queuedStateRequest: Promise<void> | undefined;
  let unitsRequest: Promise<void> | undefined;
  let unitsTail = Promise.resolve();
  let hasState = false;
  let stateNeedsReconnect = false;
  let stateFailedClient: DesktopCoachClient | undefined;
  let unitsNeedRead = false;
  let unitsFailedClient: DesktopCoachClient | undefined;
  let state: TrainingContextViewState = {
    status: "loading",
    metadata: null,
    trainingContext: UNKNOWN_CYCLING_TRAINING_CONTEXT,
    unitsPreference: { status: "loading", value: "metric", source: "default" },
  };

  const render = (): void => {
    if (!disposed) input.view.render(state);
  };
  const update = (next: Partial<TrainingContextViewState>): void => {
    state = { ...state, ...next };
    render();
  };
  const updateUnits = (next: UnitsPreferenceViewState): void => {
    state = { ...state, unitsPreference: next };
    render();
  };

  const clientAfterFailure = async (failedClient: DesktopCoachClient | undefined) => {
    if (failedClient === undefined) return input.clients.reconnect({ kind: "replace-current" });
    const current = await input.clients.getClient();
    return current === failedClient
      ? input.clients.reconnect({ kind: "failed-client", client: failedClient })
      : current;
  };

  const fetchState = (): Promise<void> => {
    if (stateRequest !== undefined) return stateRequest;
    const selectedGeneration = ++generation;
    if (!hasState) update({ status: "loading" });
    let selectedClient: DesktopCoachClient | undefined;
    const pending = (
      stateNeedsReconnect ? clientAfterFailure(stateFailedClient) : input.clients.getClient()
    )
      .then((client) => {
        selectedClient = client;
        stateNeedsReconnect = false;
        stateFailedClient = undefined;
        return client.call("getAthleteState", {});
      })
      .then((athleteState) => {
        if (disposed || selectedGeneration !== generation) return;
        hasState = true;
        update({
          status: "ready",
          metadata: {
            lastUpdated: athleteState.lastUpdated,
            lastSynced: athleteState.lastSynced,
            freshness: athleteState.freshness,
            degraded: athleteState.degraded,
          },
          trainingContext: athleteState.trainingContext ?? UNKNOWN_CYCLING_TRAINING_CONTEXT,
        });
      })
      .catch((error: unknown) => {
        if (disposed || selectedGeneration !== generation) return;
        if (
          error instanceof CoachClientDisconnectedError ||
          error instanceof CoachClientProtocolError
        ) {
          stateNeedsReconnect = true;
          stateFailedClient = selectedClient;
        }
        update({ status: hasState ? "refresh-unavailable" : "unavailable" });
      })
      .finally(() => {
        if (stateRequest === pending) stateRequest = undefined;
      });
    stateRequest = pending;
    return pending;
  };

  const refreshState = (): Promise<void> => {
    if (stateRequest === undefined) return fetchState();
    if (queuedStateRequest !== undefined) return queuedStateRequest;
    const active = stateRequest;
    const queued = active
      .then(() => {
        if (disposed) return;
        queuedStateRequest = undefined;
        return fetchState();
      })
      .finally(() => {
        if (queuedStateRequest === queued) queuedStateRequest = undefined;
      });
    queuedStateRequest = queued;
    return queued;
  };

  const fetchUnits = (reconnect: boolean): Promise<void> => {
    if (unitsRequest !== undefined) return unitsRequest;
    updateUnits({ ...state.unitsPreference, status: "loading" });
    let selectedClient: DesktopCoachClient | undefined;
    const pending = (reconnect ? clientAfterFailure(unitsFailedClient) : input.clients.getClient())
      .then((client) => {
        selectedClient = client;
        return client;
      })
      .then((client) => client.call("getUnitsPreference", {}))
      .then((result) => {
        if (disposed) return;
        unitsNeedRead = false;
        unitsFailedClient = undefined;
        updateUnits({ status: "ready", value: result.value, source: result.source });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (
          error instanceof CoachClientDisconnectedError ||
          error instanceof CoachClientProtocolError
        ) {
          unitsNeedRead = true;
          unitsFailedClient = selectedClient;
        }
        updateUnits({ ...state.unitsPreference, status: "unavailable" });
      })
      .finally(() => {
        if (unitsRequest === pending) unitsRequest = undefined;
      });
    unitsRequest = pending;
    return pending;
  };

  render();
  return {
    async start() {
      await Promise.all([fetchState(), fetchUnits(false)]);
    },
    refresh: refreshState,
    setUnitsPreference(value) {
      const parsed = UnitsPreferenceSchema.parse(value);
      const task = unitsTail.then(async () => {
        if (disposed) return;
        if (unitsNeedRead) {
          await fetchUnits(true);
          if (disposed || unitsNeedRead || state.unitsPreference.value === parsed) return;
        }
        const previous = state.unitsPreference;
        updateUnits({ ...previous, status: "saving" });
        let client: DesktopCoachClient | undefined;
        try {
          client = await input.clients.getClient();
          const result = await client.call("setUnitsPreference", { value: parsed });
          if (disposed) return;
          updateUnits({ status: "ready", value: result.value, source: result.source });
        } catch (error) {
          if (disposed) return;
          if (
            error instanceof CoachClientDisconnectedError ||
            error instanceof CoachClientProtocolError
          ) {
            unitsNeedRead = true;
            unitsFailedClient = client;
          }
          updateUnits({ ...previous, status: "unavailable" });
        }
      });
      unitsTail = task.catch(() => {});
      return task;
    },
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
