import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import {
  ActivityAnalysisResultSchema,
  CanonicalActivityIdSchema,
  type ActivityAnalysisResult,
  type ActivityAnalysisSection,
} from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";

export type RideAnalysisStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "refresh-unavailable";

export interface RideAnalysisViewState {
  readonly activityId: string | null;
  readonly status: RideAnalysisStatus;
  readonly revision: string | null;
  readonly sections: ActivityAnalysisResult["sections"];
  readonly loadingSections: readonly ActivityAnalysisSection[];
  readonly failedSections: readonly ActivityAnalysisSection[];
}

export const DEFAULT_RIDE_ANALYSIS_SECTIONS = [
  "aerobic-drift",
  "intervals",
  "best-efforts",
  "power-distribution",
  "heart-rate-distribution",
  "power-heart-rate",
] as const satisfies readonly ActivityAnalysisSection[];

export const EMPTY_RIDE_ANALYSIS: RideAnalysisViewState = Object.freeze({
  activityId: null,
  status: "idle" as const,
  revision: null,
  sections: Object.freeze({}),
  loadingSections: Object.freeze([]),
  failedSections: Object.freeze([]),
});

export interface RideAnalysisView {
  render(state: RideAnalysisViewState): void;
}

export interface RideAnalysisController {
  select(activityId: string | null): Promise<void>;
  start(): Promise<void>;
  load(sections: readonly ActivityAnalysisSection[], refresh?: boolean): Promise<void>;
  invalidate(): void;
  dispose(): void;
}

export function createRideAnalysisController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: RideAnalysisView;
}): RideAnalysisController {
  let disposed = false;
  let generation = 0;
  let operation: AbortController | undefined;
  let failedClient: DesktopCoachClient | undefined;
  let reconnectRequired = false;
  let state: RideAnalysisViewState = EMPTY_RIDE_ANALYSIS;
  const cache = new Map<string, RideAnalysisViewState>();

  const render = (next: RideAnalysisViewState): void => {
    state = next;
    if (!disposed) input.view.render(state);
  };
  const clientAfterFailure = async (): Promise<DesktopCoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const client = await input.clients.reconnect(failedClient);
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const load = async (
    sections: readonly ActivityAnalysisSection[],
    refresh = false,
  ): Promise<void> => {
    if (disposed || state.activityId === null) return;
    const selectedActivityId = state.activityId;
    const requested = [...new Set(sections)];
    if (requested.length === 0) return;
    const selectedGeneration = ++generation;
    operation?.abort();
    const controller = new AbortController();
    operation = controller;
    render({
      ...state,
      status: "loading",
      loadingSections: requested,
      failedSections: state.failedSections.filter((section) => !requested.includes(section)),
    });
    let client: DesktopCoachClient | undefined;
    try {
      client = await clientAfterFailure();
      controller.signal.throwIfAborted();
      const result = ActivityAnalysisResultSchema.parse(
        await client.call(
          "getActivityAnalysis",
          {
            canonicalActivityId: selectedActivityId,
            sections: requested,
            ...(refresh ? { refresh: true } : {}),
          },
          { signal: controller.signal },
        ),
      ) as ActivityAnalysisResult;
      if (
        disposed ||
        selectedGeneration !== generation ||
        state.activityId !== selectedActivityId
      ) {
        return;
      }
      const retain = state.revision === null || state.revision === result.revision;
      const next: RideAnalysisViewState = {
        activityId: selectedActivityId,
        status: "ready",
        revision: result.revision,
        sections: retain ? { ...state.sections, ...result.sections } : result.sections,
        loadingSections: [],
        failedSections: state.failedSections.filter((section) => !requested.includes(section)),
      };
      cache.set(selectedActivityId, next);
      render(next);
    } catch (error) {
      if (
        disposed ||
        selectedGeneration !== generation ||
        state.activityId !== selectedActivityId
      ) {
        return;
      }
      if (
        error instanceof CoachClientDisconnectedError ||
        error instanceof CoachClientProtocolError
      ) {
        reconnectRequired = true;
        failedClient = client;
      }
      render({
        ...state,
        status: Object.keys(state.sections).length === 0 ? "unavailable" : "refresh-unavailable",
        loadingSections: [],
        failedSections: [...new Set([...state.failedSections, ...requested])],
      });
    } finally {
      if (operation === controller) operation = undefined;
    }
  };

  input.view.render(state);
  return {
    async select(activityId) {
      const selected = activityId === null ? null : CanonicalActivityIdSchema.parse(activityId);
      if (disposed || selected === state.activityId) return;
      generation += 1;
      operation?.abort();
      operation = undefined;
      if (selected === null) {
        render(EMPTY_RIDE_ANALYSIS);
        return;
      }
      const cached = cache.get(selected);
      if (cached !== undefined) {
        render(cached);
        return;
      }
      render({
        activityId: selected,
        status: "idle",
        revision: null,
        sections: {},
        loadingSections: [],
        failedSections: [],
      });
    },
    async start() {
      if (
        disposed ||
        state.activityId === null ||
        state.status === "loading" ||
        cache.has(state.activityId)
      ) {
        return;
      }
      await load(DEFAULT_RIDE_ANALYSIS_SECTIONS);
    },
    load,
    invalidate() {
      const reloadSelectedActivity = state.activityId !== null && state.status !== "idle";
      generation += 1;
      operation?.abort();
      operation = undefined;
      cache.clear();
      if (reloadSelectedActivity) void load(DEFAULT_RIDE_ANALYSIS_SECTIONS);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      operation?.abort();
      operation = undefined;
    },
  };
}
