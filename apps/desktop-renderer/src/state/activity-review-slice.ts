import type { StateCreator } from "zustand";
import { ACTIVITY_REVIEW_START, type ActivityReviewState } from "../activity-review/controller";
import type { PlanCalendarFtpAnswer } from "@enduragent/coach-contract";
import { FTP_PANEL_START, type FtpPanelState } from "../activity-review/ftp-controller";
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

export interface FtpActions {
  open(): void;
  close(): void;
  answer(answer: PlanCalendarFtpAnswer): void;
  planTest(request: string): void;
}

export interface ActivityReviewSlice {
  readonly activityReview: ActivityReviewState;
  readonly activityReviewActions: ActivityReviewActions | null;
  readonly rideReview: RideReviewState;
  readonly ftpPanel: FtpPanelState;
  readonly ftpActions: FtpActions | null;
  setActivityReview: (next: ActivityReviewState) => void;
  setRideReview: (next: RideReviewState) => void;
  bindActivityReviewActions: (actions: ActivityReviewActions | null) => void;
  setFtpPanel: (next: FtpPanelState) => void;
  bindFtpActions: (actions: FtpActions | null) => void;
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
  ftpPanel: FTP_PANEL_START,
  ftpActions: null,
  setActivityReview(next) {
    set({ activityReview: next });
  },
  setRideReview(next) {
    set({ rideReview: next });
  },
  bindActivityReviewActions(actions) {
    set({ activityReviewActions: actions });
  },
  setFtpPanel(next) {
    set({ ftpPanel: next });
  },
  bindFtpActions(actions) {
    set({ ftpActions: actions });
  },
});
