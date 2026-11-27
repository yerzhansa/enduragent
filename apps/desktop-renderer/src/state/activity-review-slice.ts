import type { StateCreator } from "zustand";
import { ACTIVITY_REVIEW_START, type ActivityReviewState } from "../activity-review/controller";
import { RIDE_REVIEW_NONE, type RideReviewState } from "../activity-review/review-controller";
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
  writeAgain(): void;
  saveNote(text: string): void;
  askCoach(draft: string): void;
}

export interface ActivityReviewSlice {
  readonly activityReview: ActivityReviewState;
  readonly activityReviewActions: ActivityReviewActions | null;
  readonly rideReview: RideReviewState;
  setActivityReview: (next: ActivityReviewState) => void;
  setRideReview: (next: RideReviewState) => void;
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
  rideReview: RIDE_REVIEW_NONE,
  setActivityReview(next) {
    set({ activityReview: next });
  },
  setRideReview(next) {
    set({ rideReview: next });
  },
  bindActivityReviewActions(actions) {
    set({ activityReviewActions: actions });
  },
});
