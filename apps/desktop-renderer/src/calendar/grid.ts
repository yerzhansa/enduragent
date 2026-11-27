import type {
  PlanCalendarActivity,
  PlanCalendarPlan,
  PlanCalendarRpcResult,
  PlanCalendarWeek,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { addDays, rowStart, type FirstDayOfWeek } from "./dates";

export type PlanCalendarRead = Extract<PlanCalendarRpcResult, { status: "calendar" }>;

export type CalendarDayPlace = "no-plan" | "before-plan" | "in-plan" | "after-plan";

export interface CalendarDay {
  readonly dateKey: number;
  readonly today: "today" | "past" | "future";
  readonly place: CalendarDayPlace;
  readonly weekStarts: PlanCalendarWeek | null;
  readonly workouts: readonly PlanCalendarWorkout[];
  readonly activities: readonly PlanCalendarActivity[];
}

export interface CalendarRow {
  readonly startDateKey: number;
  readonly endDateKey: number;
  readonly weeks: readonly PlanCalendarWeek[];
  readonly days: readonly CalendarDay[];
}

export interface CalendarRange {
  readonly firstRowStart: number;
  readonly rowCount: number;
}

export const CALENDAR_ROWS = 4;

export function defaultRange(todayDateKey: number, firstDay: FirstDayOfWeek): CalendarRange {
  return { firstRowStart: addDays(rowStart(todayDateKey, firstDay), -7), rowCount: CALENDAR_ROWS };
}

export function shiftRange(range: CalendarRange, rows: number): CalendarRange {
  return { ...range, firstRowStart: addDays(range.firstRowStart, rows * 7) };
}

export function rangeDates(range: CalendarRange): {
  readonly startDateKey: number;
  readonly endDateKey: number;
} {
  return {
    startDateKey: range.firstRowStart,
    endDateKey: addDays(range.firstRowStart, range.rowCount * 7 - 1),
  };
}

function place(plan: PlanCalendarPlan | null, dateKey: number): CalendarDayPlace {
  if (plan === null) return "no-plan";
  if (dateKey < plan.startDateKey) return "before-plan";
  return dateKey > addDays(plan.startDateKey, plan.totalWeeks * 7 - 1) ? "after-plan" : "in-plan";
}

function shownWorkout(workout: PlanCalendarWorkout): boolean {
  return workout.copy.kind !== "kept-as-yours";
}

export function calendarRows(read: PlanCalendarRead, range: CalendarRange): readonly CalendarRow[] {
  const plan = read.plan;
  const matched = new Set(
    (plan?.workouts ?? [])
      .filter(shownWorkout)
      .flatMap((workout) => ("activityId" in workout.outcome ? [workout.outcome.activityId] : [])),
  );
  return Array.from({ length: range.rowCount }, (_, row) => {
    const startDateKey = addDays(range.firstRowStart, row * 7);
    const endDateKey = addDays(startDateKey, 6);
    const days: CalendarDay[] = Array.from({ length: 7 }, (_, offset) => {
      const dateKey = addDays(startDateKey, offset);
      return {
        dateKey,
        today:
          dateKey === read.todayDateKey ? "today" : dateKey < read.todayDateKey ? "past" : "future",
        place: place(plan, dateKey),
        weekStarts:
          plan?.weeks.find((week) => week.startDateKey === dateKey && dateKey !== startDateKey) ??
          null,
        workouts: (plan?.workouts ?? []).filter(
          (workout) => workout.dateKey === dateKey && shownWorkout(workout),
        ),
        activities: read.activities.filter(
          (activity) => activity.dateKey === dateKey && !matched.has(activity.activityId),
        ),
      };
    });
    return {
      startDateKey,
      endDateKey,
      weeks: (plan?.weeks ?? []).filter(
        (week) => week.endDateKey >= startDateKey && week.startDateKey <= endDateKey,
      ),
      days,
    };
  });
}

export function currentWeek(read: PlanCalendarRead): PlanCalendarWeek | null {
  const plan = read.plan;
  if (plan === null || plan.currentWeek === null) return null;
  return plan.weeks.find((week) => week.index === plan.currentWeek) ?? null;
}

export type CalendarTiming = "past" | "current" | "future";

export type CalendarRowLabel =
  | {
      readonly kind: "training-week";
      readonly week: PlanCalendarWeek;
      readonly timing: CalendarTiming;
    }
  | { readonly kind: "week-start"; readonly week: PlanCalendarWeek }
  | { readonly kind: "week-end"; readonly week: PlanCalendarWeek }
  | { readonly kind: "crossing"; readonly from: number; readonly to: PlanCalendarWeek }
  | {
      readonly kind: "dates";
      readonly timing: CalendarTiming;
      readonly durationS: number;
      readonly count: number;
      readonly load: number | null;
    };

export function weekTiming(
  startDateKey: number,
  endDateKey: number,
  today: number,
): CalendarTiming {
  if (endDateKey < today) return "past";
  return startDateKey > today ? "future" : "current";
}

export function rowLabel(row: CalendarRow, today: number): CalendarRowLabel {
  const [first, second] = row.weeks;
  if (first !== undefined && second !== undefined) {
    return { kind: "crossing", from: first.index, to: second };
  }
  if (first !== undefined && first.startDateKey === row.startDateKey) {
    return {
      kind: "training-week",
      week: first,
      timing: weekTiming(first.startDateKey, first.endDateKey, today),
    };
  }
  if (first !== undefined && first.startDateKey > row.startDateKey) {
    return { kind: "week-start", week: first };
  }
  if (first !== undefined) return { kind: "week-end", week: first };
  const activities = row.days.flatMap((day) => day.activities);
  const loads = activities.flatMap((activity) => (activity.load === null ? [] : [activity.load]));
  return {
    kind: "dates",
    timing: weekTiming(row.startDateKey, row.endDateKey, today),
    durationS: activities.reduce((total, activity) => total + (activity.durationS ?? 0), 0),
    count: activities.length,
    load: loads.length === 0 ? null : loads.reduce((total, load) => total + load, 0),
  };
}

export interface SeasonBar {
  readonly workoutId: string;
  readonly plannedS: number;
  readonly doneS: number;
  readonly done: boolean;
}

export interface SeasonWeek {
  readonly week: PlanCalendarWeek;
  readonly bars: readonly SeasonBar[];
  readonly sent: "on-intervals" | "plan-only";
  readonly current: boolean;
}

function weekSent(plan: PlanCalendarPlan, week: PlanCalendarWeek): SeasonWeek["sent"] {
  if (week.status.kind === "on-intervals") return "on-intervals";
  if (week.status.kind !== "passed") return "plan-only";
  return plan.workouts.some(
    (workout) =>
      workout.dateKey >= week.startDateKey &&
      workout.dateKey <= week.endDateKey &&
      workout.copy.kind !== "plan-only",
  )
    ? "on-intervals"
    : "plan-only";
}

export function seasonWeeks(plan: PlanCalendarPlan): readonly SeasonWeek[] {
  return plan.weeks.map((week) => ({
    week,
    bars: plan.workouts
      .filter(
        (workout) =>
          workout.dateKey >= week.startDateKey &&
          workout.dateKey <= week.endDateKey &&
          workout.outcome.kind !== "removed-by-you" &&
          shownWorkout(workout),
      )
      .sort((left, right) => left.dateKey - right.dateKey)
      .map((workout) => ({
        workoutId: workout.id,
        plannedS: workout.durationS ?? 0,
        doneS: workout.doneS,
        done:
          workout.outcome.kind === "done-as-planned" ||
          workout.outcome.kind === "done-differently" ||
          workout.outcome.kind === "moved",
      })),
    sent: weekSent(plan, week),
    current: plan.currentWeek === week.index,
  }));
}

export interface SeasonLabel {
  readonly text: string;
  readonly firstWeek: number;
  readonly lastWeek: number;
}

export function seasonPhases(plan: PlanCalendarPlan): readonly SeasonLabel[] {
  const labels: SeasonLabel[] = [];
  for (const week of plan.weeks) {
    const last = labels.at(-1);
    if (week.phase === null) continue;
    if (last !== undefined && last.text === week.phase && last.lastWeek === week.index - 1) {
      labels[labels.length - 1] = { ...last, lastWeek: week.index };
    } else {
      labels.push({ text: week.phase, firstWeek: week.index, lastWeek: week.index });
    }
  }
  return labels;
}

export function raceWeek(plan: PlanCalendarPlan): number | null {
  const target = plan.targetDateKey;
  if (target === null) return null;
  return (
    plan.weeks.find((week) => target >= week.startDateKey && target <= week.endDateKey)?.index ??
    null
  );
}
