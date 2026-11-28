import type { StateCreator } from "zustand";
import { WORKOUT_CARD_CLOSED, type WorkoutCardState } from "../calendar/workout-card-controller";
import type { EnduragentState } from "./store";

export interface CalendarWorkoutActions {
  open(planId: string, workoutId: string): void;
  close(): void;
  askCoach(draft: string): void;
}

export interface CalendarWorkoutSlice {
  readonly calendarWorkout: WorkoutCardState;
  readonly calendarWorkoutActions: CalendarWorkoutActions | null;
  setCalendarWorkout: (next: WorkoutCardState) => void;
  bindCalendarWorkoutActions: (actions: CalendarWorkoutActions | null) => void;
}

export const createCalendarWorkoutSlice: StateCreator<
  EnduragentState,
  [],
  [],
  CalendarWorkoutSlice
> = (set) => ({
  calendarWorkout: WORKOUT_CARD_CLOSED,
  calendarWorkoutActions: null,
  setCalendarWorkout(next) {
    set({ calendarWorkout: next });
  },
  bindCalendarWorkoutActions(actions) {
    set({ calendarWorkoutActions: actions });
  },
});
