import type { StateCreator } from "zustand";
import { DETAILS_SHEET_CLOSED, type DetailsSheetState } from "../calendar/details-controller";
import type { EnduragentState } from "./store";

export interface CalendarDetailsActions {
  open(planId: string): void;
  close(): void;
  startEnd(): void;
  setRemoveChanges(remove: boolean): void;
  cancelEnd(): void;
  confirmEnd(): void;
  replace(): void;
}

export interface CalendarDetailsSlice {
  readonly calendarDetails: DetailsSheetState;
  readonly calendarDetailsActions: CalendarDetailsActions | null;
  setCalendarDetails: (next: DetailsSheetState) => void;
  bindCalendarDetailsActions: (actions: CalendarDetailsActions | null) => void;
}

export const createCalendarDetailsSlice: StateCreator<
  EnduragentState,
  [],
  [],
  CalendarDetailsSlice
> = (set) => ({
  calendarDetails: DETAILS_SHEET_CLOSED,
  calendarDetailsActions: null,
  setCalendarDetails(next) {
    set({ calendarDetails: next });
  },
  bindCalendarDetailsActions(actions) {
    set({ calendarDetailsActions: actions });
  },
});
