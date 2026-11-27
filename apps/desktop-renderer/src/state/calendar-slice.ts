import type { StateCreator } from "zustand";
import { CALENDAR_START, type CalendarViewState } from "../calendar/controller";
import type { EnduragentState } from "./store";

export interface CalendarActions {
  refresh(): void;
  previous(): void;
  next(): void;
  today(): void;
  showWeekOf(dateKey: number): void;
}

export interface CalendarSlice {
  readonly calendar: CalendarViewState;
  readonly calendarActions: CalendarActions | null;
  setCalendar: (next: CalendarViewState) => void;
  bindCalendarActions: (actions: CalendarActions | null) => void;
}

export const createCalendarSlice: StateCreator<EnduragentState, [], [], CalendarSlice> = (set) => ({
  calendar: CALENDAR_START,
  calendarActions: null,
  setCalendar(next) {
    set({ calendar: next });
  },
  bindCalendarActions(actions) {
    set({ calendarActions: actions });
  },
});
