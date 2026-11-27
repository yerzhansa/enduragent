import type { StateCreator } from "zustand";
import { CHANGE_SHEET_CLOSED, type ChangeSheetState } from "../calendar/change-controller";
import type { EnduragentState } from "./store";

export interface CalendarChangeActions {
  open(planId: string, planWorkoutId: string): void;
  keep(): void;
  putBack(): void;
  close(): void;
}

export interface CalendarChangeSlice {
  readonly calendarChange: ChangeSheetState;
  readonly calendarChangeActions: CalendarChangeActions | null;
  setCalendarChange: (next: ChangeSheetState) => void;
  bindCalendarChangeActions: (actions: CalendarChangeActions | null) => void;
}

export const createCalendarChangeSlice: StateCreator<
  EnduragentState,
  [],
  [],
  CalendarChangeSlice
> = (set) => ({
  calendarChange: CHANGE_SHEET_CLOSED,
  calendarChangeActions: null,
  setCalendarChange(next) {
    set({ calendarChange: next });
  },
  bindCalendarChangeActions(actions) {
    set({ calendarChangeActions: actions });
  },
});
