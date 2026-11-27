import type { StateCreator } from "zustand";
import { MOVE_DIALOG_CLOSED, type MoveDialogState } from "../calendar/move-controller";
import type { EnduragentState } from "./store";

export interface CalendarMoveActions {
  request(planId: string, workoutId: string, toDateKey: number): void;
  setSwap(swap: boolean): void;
  confirm(): void;
  cancel(): void;
}

export interface CalendarMoveSlice {
  readonly calendarMove: MoveDialogState;
  readonly calendarMoveActions: CalendarMoveActions | null;
  setCalendarMove: (next: MoveDialogState) => void;
  bindCalendarMoveActions: (actions: CalendarMoveActions | null) => void;
}

export const createCalendarMoveSlice: StateCreator<
  EnduragentState,
  [],
  [],
  CalendarMoveSlice
> = (set) => ({
  calendarMove: MOVE_DIALOG_CLOSED,
  calendarMoveActions: null,
  setCalendarMove(next) {
    set({ calendarMove: next });
  },
  bindCalendarMoveActions(actions) {
    set({ calendarMoveActions: actions });
  },
});
