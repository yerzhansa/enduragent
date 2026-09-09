import type { StateCreator } from "zustand";
import type { ActivityAnalysisSection } from "@enduragent/coach-contract";
import { EMPTY_RIDE_ANALYSIS, type RideAnalysisViewState } from "../activity-analysis/controller";
import type { EnduragentState } from "./store";

export interface RideAnalysisActions {
  start(): void;
  refresh(sections: readonly ActivityAnalysisSection[]): void;
}

export interface ActivityAnalysisSlice {
  readonly rideAnalysis: RideAnalysisViewState;
  readonly rideAnalysisActions: RideAnalysisActions | null;
  setRideAnalysis: (next: RideAnalysisViewState) => void;
  bindRideAnalysisActions: (actions: RideAnalysisActions | null) => void;
}

export const createActivityAnalysisSlice: StateCreator<
  EnduragentState,
  [],
  [],
  ActivityAnalysisSlice
> = (set) => ({
  rideAnalysis: EMPTY_RIDE_ANALYSIS,
  rideAnalysisActions: null,
  setRideAnalysis(next) {
    set({ rideAnalysis: next });
  },
  bindRideAnalysisActions(actions) {
    set({ rideAnalysisActions: actions });
  },
});
