import type { StateCreator } from "zustand";
import { ACTIVITY_REVIEW_START, type ActivityReviewState } from "../activity-review/controller";
import type { EnduragentState } from "./store";

export interface ActivityReviewActions {
  refresh(): void;
  select(activityId: string): void;
  change(): void;
  otherDay(): void;
  closeChoices(): void;
  confirm(planWorkoutId: string): void;
  extra(): void;
  rematch(planWorkoutId: string): void;
  showInCalendar(dateKey: number): void;
}

export interface ActivityReviewSlice {
  readonly activityReview: ActivityReviewState;
  readonly activityReviewActions: ActivityReviewActions | null;
  setActivityReview: (next: ActivityReviewState) => void;
  bindActivityReviewActions: (actions: ActivityReviewActions | null) => void;
}

export const createActivityReviewSlice: StateCreator<
  EnduragentState,
  [],
  [],
  ActivityReviewSlice
> = (set) => ({
  activityReview: ACTIVITY_REVIEW_START,
  activityReviewActions: null,
  setActivityReview(next) {
    set({ activityReview: next });
  },
  bindActivityReviewActions(actions) {
    set({ activityReviewActions: actions });
  },
});
