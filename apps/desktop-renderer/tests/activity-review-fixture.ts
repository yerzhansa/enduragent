import type { PlanCalendarRide, PlanCalendarRideWorkout } from "@enduragent/coach-contract";
import { addDays } from "../src/calendar/dates";
import type { ActivityReviewRead } from "../src/activity-review/rides";

export const PLAN_ID = "0".repeat(25) + "P";
export const MONDAY = 19980810;
export const TODAY = 19980820;

export function workoutId(index: number): string {
  return `${"0".repeat(24)}${String(10 + index).padStart(2, "0")}`;
}

export function rideId(letter: string): string {
  return letter.repeat(64);
}

export function planWorkout(
  index: number,
  dateKey: number,
  name: string,
  durationS: number | null = 3_000,
): PlanCalendarRideWorkout {
  return { planWorkoutId: workoutId(index), name, dateKey, durationS };
}

export function ride(
  letter: string,
  dateKey: number,
  extra: Partial<PlanCalendarRide> = {},
): PlanCalendarRide {
  const day = String(dateKey);
  return {
    activityId: rideId(letter),
    dateKey,
    startEpochSeconds:
      Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T05:55:00Z`) / 1000,
    timezoneOffsetSeconds: 3_600,
    name: "Road ride",
    kind: "road",
    fromIntervals: true,
    sport: "cycling",
    durationS: 3_120,
    distanceM: 24_100,
    load: 38,
    averagePowerW: 181,
    averageHeartRateBpm: 131,
    perceivedExertion: null,
    match: { kind: "none" },
    otherWorkouts: [],
    ftp: { kind: "unknown" },
    ...extra,
  };
}

export function rides(
  list: readonly PlanCalendarRide[],
  plan: { readonly weeks: number } | null = { weeks: 4 },
  todayDateKey = TODAY,
): ActivityReviewRead {
  return {
    status: "rides",
    todayDateKey,
    plan:
      plan === null
        ? null
        : {
            planId: PLAN_ID,
            weeks: Array.from({ length: plan.weeks }, (_, index) => ({
              index: index + 1,
              startDateKey: addDays(MONDAY, index * 7 - 7),
              endDateKey: addDays(MONDAY, index * 7 - 1),
            })),
          },
    rides: [...list],
  };
}
