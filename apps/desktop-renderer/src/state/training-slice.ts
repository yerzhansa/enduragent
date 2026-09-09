import {
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  type CompletedActivityWeek,
  type TrainingHistoryRide,
} from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { TrainingContextViewState } from "../training-context/controller";
import type { EnduragentState } from "./store";

export const EMPTY_TRAINING_SURFACE: TrainingContextViewState = Object.freeze({
  status: "loading" as const,
  metadata: null,
  trainingContext: UNKNOWN_CYCLING_TRAINING_CONTEXT,
  unitsPreference: Object.freeze({
    status: "loading" as const,
    value: "metric" as const,
    source: "default" as const,
  }),
});

export interface TrainingSlice {
  readonly training: TrainingContextViewState;
  readonly selectedRide: TrainingHistoryRide | null;
  setTraining: (next: TrainingContextViewState) => void;
  openRide: (ride: TrainingHistoryRide) => void;
  closeRide: () => void;
}

function provesRideAbsent(week: CompletedActivityWeek | null, localDate: string): boolean {
  return (
    week !== null &&
    localDate >= week.window.start &&
    localDate <= week.window.end &&
    week.coverage.kind === "complete" &&
    week.rides.count.kind === "exact" &&
    !week.rides.truncated
  );
}

function reconciledRide(
  current: TrainingHistoryRide | null,
  next: TrainingContextViewState,
): TrainingHistoryRide | null {
  if (current === null) return null;
  const panel = next.trainingContext.trainingHistory;
  if (panel.kind !== "computed") return current;
  const refreshed =
    panel.anchorWeek.rides.items.find((ride) => ride.id === current.id) ??
    panel.previousWeek?.rides.items.find((ride) => ride.id === current.id);
  if (refreshed !== undefined) return refreshed;
  return provesRideAbsent(panel.anchorWeek, current.localDate) ||
    provesRideAbsent(panel.previousWeek, current.localDate)
    ? null
    : current;
}

export const createTrainingSlice: StateCreator<EnduragentState, [], [], TrainingSlice> = (
  set,
  get,
) => ({
  training: EMPTY_TRAINING_SURFACE,
  selectedRide: null,
  setTraining(next) {
    set({
      training: next,
      selectedRide: reconciledRide(get().selectedRide, next),
    });
  },
  openRide(ride) {
    set({ selectedRide: ride });
  },
  closeRide() {
    set({ selectedRide: null });
  },
});
