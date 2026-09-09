import type { PlanHistoryResult } from "@enduragent/coach-contract";
import { planReadModel } from "../state/plan-slice";
import { useEnduragentStore } from "../state/store";
import type { PlanController } from "./controller";

const retryListeners = new Set<(planId: string) => void>();

export function requestPlanCalendarRetry(planId: string): void {
  for (const listener of retryListeners) listener(planId);
}

export function subscribePlanLibraryRefresh(
  controller: PlanController,
  timers: {
    readonly setTimeout: typeof globalThis.setTimeout;
    readonly clearTimeout: typeof globalThis.clearTimeout;
  } = globalThis,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let refreshing = false;
  let disposed = false;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  const canPoll = (): boolean => {
    const state = useEnduragentStore.getState();
    const calendar = state.planLibrary.value?.active?.calendar;
    return (
      !disposed &&
      state.activeView === "plan" &&
      calendar !== undefined &&
      (calendar.status === "pending" ||
        calendar.status === "running" ||
        (calendar.status === "failed" && calendar.error.endsWith("Retry available.")))
    );
  };
  const schedule = (): void => {
    if (!canPoll()) {
      cancel();
      return;
    }
    if (timer !== undefined || refreshing || attempts >= 20) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      attempts += 1;
      refreshing = true;
      const currentGeneration = generation;
      void controller
        .refresh(true, () => currentGeneration === generation && canPoll())
        .finally(() => {
          refreshing = false;
          schedule();
        });
    }, 4_000);
  };
  const requestRetry = (planId: string): void => {
    if (disposed || useEnduragentStore.getState().planLibrary.value?.active?.planId !== planId)
      return;
    attempts = 0;
    schedule();
  };
  retryListeners.add(requestRetry);
  const unsubscribe = useEnduragentStore.subscribe((state, previousState) => {
    const creation = state.chat.planCreation;
    const previousCreation = previousState.chat.planCreation;
    const creationChanged =
      creation?.creationId !== previousCreation?.creationId ||
      creation?.version !== previousCreation?.version;
    const plan = planReadModel(state.plan);
    const previousPlan = planReadModel(previousState.plan);
    const activePlanId = plan?.lifecycle === "active" ? plan.planId : null;
    const previousActivePlanId = previousPlan?.lifecycle === "active" ? previousPlan.planId : null;
    const library = state.planLibrary.value;
    const creationNeedsRefresh =
      creationChanged &&
      (library === null ||
        creation?.creationId !== library.creation?.creationId ||
        creation?.version !== library.creation?.version);
    const activePlanNeedsRefresh =
      activePlanId !== previousActivePlanId && activePlanId !== (library?.active?.planId ?? null);
    const opened = state.activeView === "plan" && previousState.activeView !== "plan";
    if (
      opened ||
      state.planLibrary.value?.active?.planId !== previousState.planLibrary.value?.active?.planId ||
      (state.planLibrary.status === "loading" && previousState.planLibrary.status !== "loading")
    ) {
      cancel();
      attempts = 0;
    }
    if (opened || creationNeedsRefresh || activePlanNeedsRefresh)
      void controller.refresh(
        opened ||
          (creationNeedsRefresh && previousState.chat.planCreationLoaded) ||
          (activePlanNeedsRefresh && previousPlan !== null),
      );
    schedule();
  });
  schedule();
  return () => {
    disposed = true;
    retryListeners.delete(requestRetry);
    cancel();
    unsubscribe();
  };
}

export function subscribePlanFinalDetailsRefresh(
  options: {
    readonly history: NonNullable<PlanHistoryResult>;
    readonly readHistory: (planId: string) => Promise<PlanHistoryResult>;
    readonly onHistory: (history: PlanHistoryResult) => void;
  },
  timers: {
    readonly setTimeout: typeof globalThis.setTimeout;
    readonly clearTimeout: typeof globalThis.clearTimeout;
  } = globalThis,
): () => void {
  const planId = options.history.plan.planId;
  let history: PlanHistoryResult = options.history;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let refreshing = false;
  let disposed = false;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  const canPoll = (): boolean => {
    const calendar = history?.plan.calendar;
    return (
      !disposed &&
      useEnduragentStore.getState().activeView === "plan" &&
      calendar !== undefined &&
      (calendar.status === "pending" ||
        calendar.status === "running" ||
        (calendar.status === "failed" && calendar.error.endsWith("Retry available.")))
    );
  };
  const schedule = (): void => {
    if (!canPoll()) {
      cancel();
      return;
    }
    if (timer !== undefined || refreshing || attempts >= 20) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      attempts += 1;
      refreshing = true;
      const currentGeneration = generation;
      void options
        .readHistory(planId)
        .then(
          (value) => {
            if (currentGeneration !== generation || !canPoll()) return;
            history = value;
            options.onHistory(value);
          },
          () => {},
        )
        .finally(() => {
          refreshing = false;
          schedule();
        });
    }, 4_000);
  };
  const requestRetry = (requestedPlanId: string): void => {
    if (disposed || requestedPlanId !== planId) return;
    attempts = 0;
    schedule();
  };
  retryListeners.add(requestRetry);
  const unsubscribe = useEnduragentStore.subscribe((state, previousState) => {
    if (state.activeView === previousState.activeView) return;
    cancel();
    attempts = 0;
    schedule();
  });
  schedule();
  return () => {
    disposed = true;
    retryListeners.delete(requestRetry);
    cancel();
    unsubscribe();
  };
}
