import { addCivilDays } from "@enduragent/kernel/planning";
import {
  WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS,
  WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS,
  WORKOUT_MATCH_AS_PLANNED_RATIO,
} from "./workout-match.js";

export type SyncCoverage =
  | { readonly kind: "never" }
  | { readonly kind: "started-on"; readonly dateKey: number };

export type OutcomeMatch =
  | { readonly kind: "none" }
  | { readonly kind: "rejected" }
  | {
      readonly kind: "suggested";
      readonly matchId: string;
      readonly activityId: string;
    }
  | {
      readonly kind: "confirmed";
      readonly matchId: string;
      readonly activityId: string;
      readonly activityDateKey: number;
      readonly activityDurationS: number | null;
    };

export interface OutcomeWorkout {
  readonly dateKey: number;
  readonly durationS: number | null;
  readonly place: "in-plan" | "removed-by-you";
}

export interface WorkoutOutcomeInput {
  readonly workout: OutcomeWorkout;
  readonly match: OutcomeMatch;
  readonly todayDateKey: number;
  readonly lastFinishedSync: SyncCoverage;
}

export type WorkoutOutcome =
  | { readonly kind: "planned" }
  | { readonly kind: "not-synced-yet" }
  | { readonly kind: "missed" }
  | { readonly kind: "is-this-it"; readonly matchId: string; readonly activityId: string }
  | { readonly kind: "done-as-planned"; readonly matchId: string; readonly activityId: string }
  | { readonly kind: "done-differently"; readonly matchId: string; readonly activityId: string }
  | {
      readonly kind: "moved";
      readonly matchId: string;
      readonly activityId: string;
      readonly toDateKey: number;
    }
  | { readonly kind: "removed-by-you" };

export type OutcomeCount = "counts-done" | "counts-missed" | "not-counted";

function asPlannedLimit(plannedS: number): number {
  return Math.min(
    WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS,
    Math.max(WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS, plannedS * WORKOUT_MATCH_AS_PLANNED_RATIO),
  );
}

export function syncCoversDay(lastFinishedSync: SyncCoverage, dateKey: number): boolean {
  return lastFinishedSync.kind === "started-on" && lastFinishedSync.dateKey > dateKey;
}

export function dayIsOver(dateKey: number, todayDateKey: number): boolean {
  return addCivilDays(dateKey, 1) <= todayDateKey;
}

export function workoutOutcome(input: WorkoutOutcomeInput): WorkoutOutcome {
  const { workout, match } = input;
  if (workout.place === "removed-by-you") return { kind: "removed-by-you" };
  if (match.kind === "confirmed") {
    const ids = { matchId: match.matchId, activityId: match.activityId };
    if (match.activityDateKey !== workout.dateKey) {
      return { kind: "moved", ...ids, toDateKey: match.activityDateKey };
    }
    if (
      workout.durationS !== null &&
      match.activityDurationS !== null &&
      Math.abs(workout.durationS - match.activityDurationS) > asPlannedLimit(workout.durationS)
    ) {
      return { kind: "done-differently", ...ids };
    }
    return { kind: "done-as-planned", ...ids };
  }
  if (match.kind === "suggested") {
    return { kind: "is-this-it", matchId: match.matchId, activityId: match.activityId };
  }
  if (!dayIsOver(workout.dateKey, input.todayDateKey)) return { kind: "planned" };
  if (!syncCoversDay(input.lastFinishedSync, workout.dateKey)) return { kind: "not-synced-yet" };
  return { kind: "missed" };
}

export function outcomeCount(outcome: WorkoutOutcome): OutcomeCount {
  switch (outcome.kind) {
    case "done-as-planned":
    case "done-differently":
    case "moved":
      return "counts-done";
    case "missed":
      return "counts-missed";
    case "planned":
    case "not-synced-yet":
    case "is-this-it":
    case "removed-by-you":
      return "not-counted";
  }
}

export function outcomeCountsTowardPlanned(outcome: WorkoutOutcome): boolean {
  return outcome.kind !== "removed-by-you";
}
