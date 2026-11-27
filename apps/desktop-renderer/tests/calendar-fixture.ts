import type {
  PlanCalendarActivity,
  PlanCalendarPlan,
  PlanCalendarWeek,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { addDays } from "../src/calendar/dates";
import type { PlanCalendarRead } from "../src/calendar/grid";

export const PLAN_ID = "0".repeat(25) + "P";

export function workoutId(index: number): string {
  return `${"0".repeat(24)}${String(10 + index).padStart(2, "0")}`;
}

export function week(
  index: number,
  startDateKey: number,
  extra: Partial<PlanCalendarWeek> = {},
): PlanCalendarWeek {
  return {
    index,
    startDateKey,
    endDateKey: addDays(startDateKey, 6),
    plannedS: 12_300,
    doneS: 0,
    toConfirm: 0,
    phase: null,
    status: { kind: "on-intervals" },
    ...extra,
  };
}

export function workout(
  index: number,
  dateKey: number,
  extra: Partial<PlanCalendarWorkout> = {},
): PlanCalendarWorkout {
  return {
    id: workoutId(index),
    dateKey,
    name: `Endurance ${index}`,
    sport: "Ride",
    durationS: 3_600,
    copy: { kind: "on-intervals", owner: "plan" },
    lastWrite: "ok",
    outcome: { kind: "planned" },
    doneS: 0,
    movable: false,
    movedByYou: null,
    ...extra,
  };
}

export function activity(
  key: string,
  dateKey: number,
  extra: Partial<PlanCalendarActivity> = {},
): PlanCalendarActivity {
  return {
    activityId: key.repeat(64).slice(0, 64),
    dateKey,
    name: "Road ride",
    sport: "Ride",
    durationS: 3_900,
    distanceM: 32_000,
    load: 60,
    workoutId: null,
    ...extra,
  };
}

export function plan(
  startDateKey: number,
  weeks: readonly PlanCalendarWeek[],
  workouts: readonly PlanCalendarWorkout[],
  extra: Partial<PlanCalendarPlan> = {},
): PlanCalendarPlan {
  return {
    planId: PLAN_ID,
    version: 1,
    name: "Synthetic base",
    startDateKey,
    targetDateKey: null,
    totalWeeks: weeks.length,
    currentWeek: null,
    phase: null,
    weeks: [...weeks],
    workouts: [...workouts],
    ...extra,
  };
}

export function calendarRead(
  todayDateKey: number,
  planned: PlanCalendarPlan | null,
  activities: readonly PlanCalendarActivity[] = [],
): PlanCalendarRead {
  return {
    status: "calendar",
    todayDateKey,
    calendarConnected: true,
    weekDelivery: "send-each-week",
    plan: planned,
    activities: [...activities],
  };
}
