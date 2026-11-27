import type { PlanCalendarWeek, PlanCalendarWorkout } from "@enduragent/coach-contract";
import type { PlanCalendarRead } from "./grid";

export type ApprovalScope =
  | { readonly kind: "first-weeks" }
  | { readonly kind: "week"; readonly week: number };

export interface ApprovalWeek {
  readonly week: PlanCalendarWeek;
  readonly workouts: readonly PlanCalendarWorkout[];
}

export interface PendingApproval {
  readonly planId: string;
  readonly scope: ApprovalScope;
  readonly weeks: readonly ApprovalWeek[];
  readonly count: number;
  readonly totalS: number;
}

type Included = "plan-only" | "all";

function included(workout: PlanCalendarWorkout, today: number, include: Included): boolean {
  return (
    workout.dateKey >= today &&
    (include === "all" || workout.copy.kind === "plan-only") &&
    workout.outcome.kind !== "removed-by-you"
  );
}

function approval(
  read: PlanCalendarRead,
  scope: ApprovalScope,
  weeks: readonly PlanCalendarWeek[],
  include: Included = "plan-only",
): PendingApproval | null {
  const plan = read.plan;
  if (plan === null || weeks.length === 0) return null;
  const grouped = weeks.map((week) => ({
    week,
    workouts: plan.workouts
      .filter(
        (workout) =>
          workout.dateKey >= week.startDateKey &&
          workout.dateKey <= week.endDateKey &&
          included(workout, read.todayDateKey, include),
      )
      .sort((left, right) => left.dateKey - right.dateKey),
  }));
  const workouts = grouped.flatMap((entry) => entry.workouts);
  return {
    planId: plan.planId,
    scope,
    weeks: grouped,
    count: workouts.length,
    totalS: workouts.reduce((total, workout) => total + (workout.durationS ?? 0), 0),
  };
}

export function firstApproval(read: PlanCalendarRead): PendingApproval | null {
  const weeks = (read.plan?.weeks ?? []).filter(
    (week) => week.status.kind === "waiting-for-first-approve",
  );
  return approval(read, { kind: "first-weeks" }, weeks);
}

export function weekApprovals(read: PlanCalendarRead): readonly PendingApproval[] {
  return (read.plan?.weeks ?? [])
    .filter((week) => week.status.kind === "waiting-for-week-approve")
    .flatMap((week) => approval(read, { kind: "week", week: week.index }, [week]) ?? []);
}

export function approvalFor(read: PlanCalendarRead, scope: ApprovalScope): PendingApproval | null {
  if (scope.kind === "first-weeks") return firstApproval(read);
  return (
    weekApprovals(read).find(
      (pending) => pending.scope.kind === "week" && pending.scope.week === scope.week,
    ) ?? null
  );
}

export function sendingFailures(
  read: PlanCalendarRead,
  weeks: readonly number[],
): {
  readonly sent: number;
  readonly failed: readonly PlanCalendarWorkout[];
  readonly waiting: number;
} {
  const plan = read.plan;
  if (plan === null) return { sent: 0, failed: [], waiting: 0 };
  const inWeeks = plan.workouts.filter(
    (workout) =>
      workout.dateKey >= read.todayDateKey &&
      workout.outcome.kind !== "removed-by-you" &&
      plan.weeks.some(
        (week) =>
          weeks.includes(week.index) &&
          workout.dateKey >= week.startDateKey &&
          workout.dateKey <= week.endDateKey,
      ),
  );
  return {
    sent: inWeeks.filter((workout) => workout.copy.kind !== "plan-only").length,
    failed: inWeeks.filter(
      (workout) => workout.copy.kind === "plan-only" && workout.lastWrite === "failed",
    ),
    waiting: inWeeks.filter(
      (workout) => workout.copy.kind === "plan-only" && workout.lastWrite !== "failed",
    ).length,
  };
}

export function approvedWeeks(
  read: PlanCalendarRead,
  scope: ApprovalScope,
  weeks: readonly number[],
): PendingApproval | null {
  const chosen = (read.plan?.weeks ?? []).filter((week) => weeks.includes(week.index));
  return approval(read, scope, chosen, "all");
}
