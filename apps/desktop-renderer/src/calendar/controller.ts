import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import type { FirstDayOfWeek } from "./dates";
import {
  defaultRange,
  rangeDates,
  shiftRange,
  type CalendarRange,
  type PlanCalendarRead,
} from "./grid";

export type CalendarRefresh = "idle" | "refreshing" | "failed";

export type CalendarViewState =
  | { readonly kind: "loading"; readonly range: CalendarRange | null }
  | {
      readonly kind: "ready";
      readonly read: PlanCalendarRead;
      readonly range: CalendarRange;
      readonly refresh: CalendarRefresh;
    }
  | { readonly kind: "unavailable"; readonly range: CalendarRange | null };

export const CALENDAR_START: CalendarViewState = Object.freeze({ kind: "loading", range: null });

export interface CalendarController {
  open(): Promise<void>;
  refresh(): Promise<void>;
  previous(): Promise<void>;
  next(): Promise<void>;
  today(): Promise<void>;
  showWeekOf(dateKey: number): Promise<void>;
}

export interface CalendarControllerDeps {
  read(range: {
    readonly startDateKey: number;
    readonly endDateKey: number;
  }): Promise<PlanCalendarRpcResult>;
  firstDayOfWeek(): FirstDayOfWeek;
  localTodayDateKey(): number;
  publish(state: CalendarViewState): void;
}

export function createCalendarController(deps: CalendarControllerDeps): CalendarController {
  let state: CalendarViewState = CALENDAR_START;
  let target: CalendarRange | null = null;
  let generation = 0;

  const publish = (next: CalendarViewState): void => {
    state = next;
    deps.publish(next);
  };

  const todayRange = (): CalendarRange =>
    defaultRange(deps.localTodayDateKey(), deps.firstDayOfWeek());

  const failed = (range: CalendarRange): void => {
    if (state.kind === "ready") {
      target = state.range;
      publish({ ...state, refresh: "failed" });
      return;
    }
    publish({ kind: "unavailable", range });
  };

  const load = async (range: CalendarRange): Promise<void> => {
    target = range;
    generation += 1;
    const mine = generation;
    publish(
      state.kind === "ready" ? { ...state, refresh: "refreshing" } : { kind: "loading", range },
    );
    let result: PlanCalendarRpcResult;
    try {
      result = await deps.read(rangeDates(range));
    } catch {
      if (mine === generation) failed(range);
      return;
    }
    if (mine !== generation) return;
    if (result.status !== "calendar") {
      failed(range);
      return;
    }
    publish({ kind: "ready", read: result, range, refresh: "idle" });
  };

  return {
    open: () => load(todayRange()),
    refresh: () => load(target ?? todayRange()),
    previous: () => load(shiftRange(target ?? todayRange(), -1)),
    next: () => load(shiftRange(target ?? todayRange(), 1)),
    today: () => load(todayRange()),
    showWeekOf: (dateKey) => load(defaultRange(dateKey, deps.firstDayOfWeek())),
  };
}
