import type {
  ListPlansResult,
  PlanNavigationTarget,
  PlanningReadModel,
} from "@enduragent/coach-contract";
import type { PlanLibraryState, PlanReadSurfaceState } from "../state/plan-slice";

export interface PlanController {
  start(): Promise<void>;
  refresh(afterPending?: boolean, shouldRefresh?: () => boolean): Promise<void>;
  openFromChat(target: PlanNavigationTarget): void;
  backToChat(): void;
  dispose(): void;
}

export function createPlanController(input: {
  readonly listPlans: () => Promise<ListPlansResult>;
  readonly renderLibrary: (state: PlanLibraryState) => void;
  readonly read: () => Promise<PlanningReadModel>;
  readonly render: (state: PlanReadSurfaceState) => void;
  readonly navigate: (view: "chat" | "plan") => void;
  readonly focus: (target: PlanNavigationTarget | null, returnToChat: boolean) => void;
}): PlanController {
  let disposed = false;
  let value: PlanningReadModel | null = null;
  let library: ListPlansResult | null = null;
  let pending: Promise<void> | undefined;

  const refresh = (afterPending = false, shouldRefresh = () => true): Promise<void> => {
    if (disposed || !shouldRefresh()) return Promise.resolve();
    if (pending !== undefined)
      return afterPending ? pending.then(() => refresh(false, shouldRefresh)) : pending;
    input.render(value === null ? { status: "loading", value: null } : { status: "ready", value });
    const list = input
      .listPlans()
      .then((next) => {
        if (disposed) return;
        library = next;
        input.renderLibrary({ status: "ready", value: next });
      })
      .catch(() => {
        if (!disposed) input.renderLibrary({ status: "unavailable", value: library });
      });
    const read = input
      .read()
      .then((next) => {
        if (disposed) return;
        value = next;
        input.render({ status: "ready", value: next });
      })
      .catch(() => {
        if (!disposed) input.render({ status: "unavailable", value });
      });
    const task = Promise.all([read, list])
      .then(() => undefined)
      .finally(() => {
        if (pending === task) pending = undefined;
      });
    pending = task;
    return task;
  };

  return {
    start: refresh,
    refresh,
    openFromChat(target) {
      input.focus(target, true);
      input.navigate("plan");
      void refresh();
    },
    backToChat() {
      input.focus(null, false);
      input.navigate("chat");
    },
    dispose() {
      disposed = true;
    },
  };
}
