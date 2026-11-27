import type { PlanCalendarWeek, PlanCalendarWorkout } from "@enduragent/coach-contract";
import { addDays } from "./dates";
import type { PlanCalendarRead } from "./grid";

export type MoveWhere =
  | { readonly kind: "goes" }
  | { readonly kind: "leaves"; readonly week: number }
  | { readonly kind: "plan-only" };

export interface MovePreview {
  readonly workout: PlanCalendarWorkout;
  readonly toDateKey: number;
  readonly clash: readonly PlanCalendarWorkout[];
  readonly canSwap: boolean;
  readonly where: MoveWhere;
  readonly crossing: {
    readonly moved: "on" | "off";
    readonly swapped: { readonly kind: "on" } | { readonly kind: "off"; readonly week: number };
  } | null;
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

function sentCopy(workout: PlanCalendarWorkout): boolean {
  return workout.copy.kind === "on-intervals" || workout.copy.kind === "moving-by-you";
}

function whereTo(read: PlanCalendarRead, sent: boolean, dateKey: number): MoveWhere {
  const to = weekOf(read, dateKey);
  const out = to !== undefined && (to.status.kind === "on-intervals" || to.status.kind === "due");
  const inWindow = out || to?.status.kind === "waiting-for-week-approve";
  if ((sent && inWindow) || (read.calendarConnected && out)) return { kind: "goes" };
  return sent && to !== undefined ? { kind: "leaves", week: to.index } : { kind: "plan-only" };
}

function crossingOf(
  read: PlanCalendarRead,
  workout: PlanCalendarWorkout,
  where: MoveWhere,
  clash: readonly PlanCalendarWorkout[],
): MovePreview["crossing"] {
  const clashSent = clash.some(sentCopy);
  const swapped = whereTo(read, clashSent, workout.dateKey);
  if (where.kind === "leaves" && swapped.kind === "goes" && !clashSent) {
    return { moved: "off", swapped: { kind: "on" } };
  }
  if (where.kind === "goes" && !sentCopy(workout) && swapped.kind === "leaves") {
    return { moved: "on", swapped: { kind: "off", week: swapped.week } };
  }
  return null;
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

export function dropDayFrom(
  read: PlanCalendarRead,
  workout: PlanCalendarWorkout,
  fromDateKey: number,
  step: 1 | -1,
): number | null {
  const plan = read.plan;
  const last = lastPlanDay(read);
  if (plan === null || last === null) return null;
  const first = Math.max(read.todayDateKey, plan.startDateKey);
  for (
    let day = addDays(fromDateKey, step);
    day >= first && day <= last;
    day = addDays(day, step)
  ) {
    if (canDropOn(read, workout, day)) return day;
  }
  return null;
}

export function firstDropDay(read: PlanCalendarRead, workout: PlanCalendarWorkout): number | null {
  return (
    dropDayFrom(read, workout, workout.dateKey, 1) ??
    dropDayFrom(read, workout, workout.dateKey, -1)
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
  const where = whereTo(read, sentCopy(workout), toDateKey);
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
    crossing: swap && canSwap ? crossingOf(read, workout, where, clash) : null,
    weeks,
  };
}
