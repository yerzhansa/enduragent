import {
  addCivilDays,
  planWeekIndex,
  planWeekRange,
  weekdayForDateKey,
} from "@enduragent/kernel/planning";

export type FirstDayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const TRAINING_WEEK_DAYS = 7 as const;
export const TRAINING_WEEK_LEAD_DAYS = 7 as const;

export interface TrainingWeekPlan {
  readonly startDateKey: number;
  readonly totalWeeks: number;
}

export interface TrainingWeek {
  readonly index: number;
  readonly startDateKey: number;
  readonly endDateKey: number;
  readonly sendDateKey: number;
}

export type TrainingWeekPosition =
  | { readonly kind: "before-plan"; readonly firstWeek: TrainingWeek }
  | { readonly kind: "inside"; readonly week: TrainingWeek }
  | { readonly kind: "after-plan" };

export class TrainingWeekError extends Error {
  readonly code: "invalid-first-day" | "invalid-plan" | "invalid-week-index";

  constructor(code: TrainingWeekError["code"]) {
    super(`training week rejected: ${code}`);
    this.name = "TrainingWeekError";
    this.code = code;
  }
}

export function firstDayOfWeek(value: number): FirstDayOfWeek {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  if (value === 5 || value === 6 || value === 7) return value;
  throw new TrainingWeekError("invalid-first-day");
}

export function firstDayOfWeekFromWeekday(weekday: number): FirstDayOfWeek {
  return firstDayOfWeek(weekday === 0 ? 7 : weekday);
}

function isoWeekday(dateKey: number): FirstDayOfWeek {
  return firstDayOfWeekFromWeekday(weekdayForDateKey(dateKey));
}

export function calendarRowStart(dateKey: number, firstDay: FirstDayOfWeek): number {
  const back = (isoWeekday(dateKey) - firstDay + 7) % 7;
  return addCivilDays(dateKey, -back);
}

export function nextFirstDayOfWeek(todayDateKey: number, firstDay: FirstDayOfWeek): number {
  const rowStart = calendarRowStart(todayDateKey, firstDay);
  return rowStart === todayDateKey ? todayDateKey : addCivilDays(rowStart, TRAINING_WEEK_DAYS);
}

function validPlan(plan: TrainingWeekPlan): TrainingWeekPlan {
  if (!Number.isSafeInteger(plan.totalWeeks) || plan.totalWeeks < 1) {
    throw new TrainingWeekError("invalid-plan");
  }
  weekdayForDateKey(plan.startDateKey);
  return plan;
}

export function trainingWeek(plan: TrainingWeekPlan, index: number): TrainingWeek {
  const checked = validPlan(plan);
  if (!Number.isSafeInteger(index) || index < 1 || index > checked.totalWeeks) {
    throw new TrainingWeekError("invalid-week-index");
  }
  const range = planWeekRange(checked, index);
  return {
    index,
    startDateKey: range.startDateKey,
    endDateKey: range.endDateKey,
    sendDateKey: addCivilDays(range.startDateKey, -TRAINING_WEEK_LEAD_DAYS),
  };
}

export function trainingWeeks(plan: TrainingWeekPlan): readonly TrainingWeek[] {
  const checked = validPlan(plan);
  return Array.from({ length: checked.totalWeeks }, (_, offset) =>
    trainingWeek(checked, offset + 1),
  );
}

export function trainingWeekPosition(
  plan: TrainingWeekPlan,
  dateKey: number,
): TrainingWeekPosition {
  const checked = validPlan(plan);
  const position = planWeekIndex(checked, dateKey);
  if (position.kind === "inside") {
    return { kind: "inside", week: trainingWeek(checked, position.weekIndex) };
  }
  return position.side === "before"
    ? { kind: "before-plan", firstWeek: trainingWeek(checked, 1) }
    : { kind: "after-plan" };
}

export function currentTrainingWeekIndex(
  plan: TrainingWeekPlan,
  todayDateKey: number,
): number | null {
  const position = trainingWeekPosition(plan, todayDateKey);
  if (position.kind === "after-plan") return null;
  return position.kind === "before-plan" ? 1 : position.week.index;
}

export function thisTrainingWeekAndNext(
  plan: TrainingWeekPlan,
  todayDateKey: number,
): readonly number[] {
  const current = currentTrainingWeekIndex(plan, todayDateKey);
  if (current === null) return [];
  return [current, current + 1].filter((index) => index <= plan.totalWeeks);
}

export function trainingWeekOfDate(plan: TrainingWeekPlan, dateKey: number): number | null {
  const position = trainingWeekPosition(plan, dateKey);
  return position.kind === "inside" ? position.week.index : null;
}
