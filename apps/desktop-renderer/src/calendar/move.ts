import type { PlanCalendarWeek, PlanCalendarWorkout } from "@enduragent/coach-contract";
import { addDays } from "./dates";
import type { PlanCalendarRead } from "./grid";

export interface MovePreview {
  readonly workout: PlanCalendarWorkout;
  readonly toDateKey: number;
  readonly clash: readonly PlanCalendarWorkout[];
  readonly canSwap: boolean;
  readonly where:
    | { readonly kind: "goes" }
    | { readonly kind: "leaves"; readonly week: number }
    | { readonly kind: "plan-only" };
  readonly weeks:
    | { readonly kind: "same"; readonly week: PlanCalendarWeek }
    | {
        readonly kind: "across";
        readonly from: PlanCalendarWeek;
        readonly fromS: number;
        readonly to: PlanCalendarWeek;
        readonly toS: number;
      }
    | null;
}

function weekOf(read: PlanCalendarRead, dateKey: number): PlanCalendarWeek | undefined {
  return read.plan?.weeks.find(
    (week) => dateKey >= week.startDateKey && dateKey <= week.endDateKey,
  );
}

function shownOn(workout: PlanCalendarWorkout, dateKey: number): boolean {
  return (
    workout.dateKey === dateKey &&
    workout.outcome.kind !== "removed-by-you" &&
    workout.copy.kind !== "removed-by-you" &&
    workout.copy.kind !== "kept-as-yours"
  );
}

export function lastPlanDay(read: PlanCalendarRead): number | null {
  const plan = read.plan;
  return plan === null ? null : addDays(plan.startDateKey, plan.totalWeeks * 7 - 1);
}

export function canDropOn(
  read: PlanCalendarRead,
  workout: PlanCalendarWorkout,
  dateKey: number,
): boolean {
  const last = lastPlanDay(read);
  const plan = read.plan;
  return (
    plan !== null &&
    last !== null &&
    workout.movable &&
    dateKey !== workout.dateKey &&
    dateKey >= read.todayDateKey &&
    dateKey >= plan.startDateKey &&
    dateKey <= last
  );
}

export function movePreview(
  read: PlanCalendarRead,
  workoutId: string,
  toDateKey: number,
  swap: boolean,
): MovePreview | null {
  const workout = read.plan?.workouts.find((entry) => entry.id === workoutId);
  if (workout === undefined || read.plan === null) return null;
  const clash = read.plan.workouts.filter(
    (entry) => entry.id !== workout.id && shownOn(entry, toDateKey),
  );
  const from = weekOf(read, workout.dateKey);
  const to = weekOf(read, toDateKey);
  const length = workout.durationS ?? 0;
  const canSwap = clash.length > 0 && clash.every((entry) => entry.movable);
  const swapped =
    swap && canSwap ? clash.reduce((total, entry) => total + (entry.durationS ?? 0), 0) : 0;
  const sent = workout.copy.kind === "on-intervals" || workout.copy.kind === "moving-by-you";
  const targetSent =
    to !== undefined && (to.status.kind === "on-intervals" || to.status.kind === "due");
  const where =
    read.calendarConnected && targetSent
      ? ({ kind: "goes" } as const)
      : sent && to !== undefined
        ? ({ kind: "leaves", week: to.index } as const)
        : ({ kind: "plan-only" } as const);
  const weeks =
    from === undefined || to === undefined
      ? null
      : from.index === to.index
        ? ({ kind: "same", week: from } as const)
        : ({
            kind: "across",
            from,
            fromS: from.plannedS - length + swapped,
            to,
            toS: to.plannedS + length - swapped,
          } as const);
  return {
    workout,
    toDateKey,
    clash,
    canSwap,
    where,
    weeks,
  };
}
