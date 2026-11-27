import type { PlanCalendarWeekDelivery } from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { ApprovalScope } from "../calendar/approval";
import { APPROVE_SHEET_CLOSED, type ApproveSheetState } from "../calendar/approve-controller";
import {
  CALENDAR_SETTINGS_START,
  type CalendarSettingsState,
} from "../calendar/settings-controller";
import type { EnduragentState } from "./store";

export interface CalendarApproveActions {
  open(scope: ApprovalScope): void;
  approve(): void;
  notNow(): void;
  retry(): void;
  connect(): void;
}

export interface CalendarSettingsActions {
  load(): void;
  setWeekDelivery(value: PlanCalendarWeekDelivery): void;
  setStartAtLogin(enabled: boolean): void;
}

export interface CalendarApproveSlice {
  readonly calendarApproval: ApproveSheetState;
  readonly calendarApproveActions: CalendarApproveActions | null;
  readonly calendarSettings: CalendarSettingsState;
  readonly calendarSettingsActions: CalendarSettingsActions | null;
  setCalendarApproval: (next: ApproveSheetState) => void;
  bindCalendarApproveActions: (actions: CalendarApproveActions | null) => void;
  setCalendarSettings: (next: CalendarSettingsState) => void;
  bindCalendarSettingsActions: (actions: CalendarSettingsActions | null) => void;
}

export const createCalendarApproveSlice: StateCreator<
  EnduragentState,
  [],
  [],
  CalendarApproveSlice
> = (set) => ({
  calendarApproval: APPROVE_SHEET_CLOSED,
  calendarApproveActions: null,
  calendarSettings: CALENDAR_SETTINGS_START,
  calendarSettingsActions: null,
  setCalendarApproval(next) {
    set({ calendarApproval: next });
  },
  bindCalendarApproveActions(actions) {
    set({ calendarApproveActions: actions });
  },
  setCalendarSettings(next) {
    set({ calendarSettings: next });
  },
  bindCalendarSettingsActions(actions) {
    set({ calendarSettingsActions: actions });
  },
});
