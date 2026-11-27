import type {
  PlanCalendarActivity,
  PlanCalendarCopy,
  PlanCalendarOutcome,
  PlanCalendarRpcResult,
  PlanCalendarWeek,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import {
  outcomeCount,
  readIcuCopies,
  readWeekDelivery,
  sentTrainingWeeks,
  storedIcuCopy,
  trainingWeeks,
  weekDeliveryStatus,
  workoutOutcome,
  type IcuCopy,
  type OutcomeMatch,
  type SyncCoverage,
  type WorkoutOutcome,
} from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutMatchRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  createTrainingHistoryReader,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { phaseForWeek } from "./plan-phase.js";

export type PlanCalendarRead = Extract<PlanCalendarRpcResult, { status: "calendar" }>;

export interface PlanCalendarReadDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly todayDateKey: number;
  readonly calendarConnected: boolean;
  readonly dateKeyOfMs: (ms: number) => number;
}

function copyView(copy: IcuCopy): PlanCalendarCopy {
  switch (copy.kind) {
    case "not-sent":
      return { kind: "plan-only" };
    case "on-icu":
      return { kind: "on-intervals", owner: copy.baseline.owner };
    case "moving-by-you":
      return { kind: "moving-by-you" };
    case "changed-in-icu":
      if (copy.shown.kind === "absent") {
        return { kind: "changed-in-intervals", change: "deleted", toDateKey: null };
      }
      return copy.shown.dateKey === copy.baseline.dateKey
        ? { kind: "changed-in-intervals", change: "edited", toDateKey: null }
        : { kind: "changed-in-intervals", change: "moved", toDateKey: copy.shown.dateKey };
    case "removed-by-you":
      return { kind: "removed-by-you" };
    case "kept-as-yours":
      return { kind: "kept-as-yours" };
  }
}

function outcomeMatch(records: readonly PlanWorkoutMatchRecord[]): OutcomeMatch {
  const confirmed = records.find((record) => record.decision === "confirmed");
  if (confirmed !== undefined) {
    return {
      kind: "confirmed",
      matchId: confirmed.id,
      activityId: confirmed.activityId,
      activityDateKey: confirmed.activityDateKey,
      activityDurationS: confirmed.activityDurationS,
    };
  }
  const suggested = records.find((record) => record.decision === "suggested");
  if (suggested !== undefined) {
    return { kind: "suggested", matchId: suggested.id, activityId: suggested.activityId };
  }
  return records.some((record) => record.decision === "rejected")
    ? { kind: "rejected" }
    : { kind: "none" };
}

function outcomeView(outcome: WorkoutOutcome, match: OutcomeMatch): PlanCalendarOutcome {
  switch (outcome.kind) {
    case "done-as-planned":
    case "done-differently":
      return {
        kind: outcome.kind,
        activityId: outcome.activityId,
        actualDurationS: match.kind === "confirmed" ? match.activityDurationS : null,
      };
    case "moved":
      return { kind: "moved", activityId: outcome.activityId, toDateKey: outcome.toDateKey };
    case "is-this-it":
      return { kind: "is-this-it", matchId: outcome.matchId, activityId: outcome.activityId };
    case "planned":
    case "not-synced-yet":
    case "missed":
    case "removed-by-you":
      return { kind: outcome.kind };
  }
}

const RANGE_LIMIT_DAYS = 120;

function isoOf(dateKey: number): string {
  const value = String(dateKey).padStart(8, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function boundedRange(range: { readonly startDateKey: number; readonly endDateKey: number }) {
  const limit = Number(
    new Date(
      Date.parse(`${isoOf(range.startDateKey)}T00:00:00Z`) + (RANGE_LIMIT_DAYS - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", ""),
  );
  return { startDateKey: range.startDateKey, endDateKey: Math.min(range.endDateKey, limit) };
}

async function readActivities(
  store: SqlStore,
  range: { readonly startDateKey: number; readonly endDateKey: number },
): Promise<readonly Omit<PlanCalendarActivity, "workoutId">[]> {
  if (range.endDateKey < range.startDateKey) return [];
  const window = await createTrainingHistoryReader(store).readWindow({
    start: isoOf(range.startDateKey),
    end: isoOf(range.endDateKey),
  });
  return [...window.rows]
    .sort(
      (left, right) =>
        left.localDate.localeCompare(right.localDate) ||
        left.startEpochSeconds - right.startEpochSeconds ||
        left.id.localeCompare(right.id),
    )
    .map((row) => {
      const seconds = row.movingSeconds ?? row.elapsedSeconds;
      return {
        activityId: row.id,
        dateKey: Number(row.localDate.replaceAll("-", "")),
        name: row.title,
        sport: "cycling",
        durationS: seconds === null ? null : Math.max(0, Math.round(seconds)),
        distanceM: row.distanceMeters,
        load: row.load.kind === "recorded" ? Math.max(0, Math.round(row.load.value)) : null,
      };
    });
}

function doneSeconds(outcome: WorkoutOutcome, match: OutcomeMatch): number {
  if (outcomeCount(outcome) !== "counts-done" || match.kind !== "confirmed") return 0;
  return Math.max(0, Math.round(match.activityDurationS ?? 0));
}

function counted(workout: PlanCalendarWorkout): boolean {
  return workout.outcome.kind !== "removed-by-you" && workout.copy.kind !== "kept-as-yours";
}

function weekOf(
  dateKey: number,
  weeks: readonly { index: number; startDateKey: number; endDateKey: number }[],
): number | null {
  return (
    weeks.find((week) => dateKey >= week.startDateKey && dateKey <= week.endDateKey)?.index ?? null
  );
}

export async function readPlanCalendar(
  deps: PlanCalendarReadDeps,
  range: { readonly startDateKey: number; readonly endDateKey: number },
): Promise<PlanCalendarRead> {
  return deps.store.transaction(() => readInside(deps, boundedRange(range)));
}

async function readInside(
  deps: PlanCalendarReadDeps,
  range: { readonly startDateKey: number; readonly endDateKey: number },
): Promise<PlanCalendarRead> {
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const weekDelivery = await mirror.readWeekDeliverySetting();
  const activities = await readActivities(deps.store, range);
  const active = await deps.store.get(
    "SELECT plan_id, version FROM planning_plan WHERE status='active'",
  );
  const base = {
    status: "calendar" as const,
    todayDateKey: deps.todayDateKey,
    calendarConnected: deps.calendarConnected,
    weekDelivery,
  };
  const plan =
    typeof active?.plan_id === "string"
      ? await createLegacyPlanRepository(deps.store).read(active.plan_id)
      : undefined;
  if (plan === undefined || typeof active?.version !== "number") {
    return {
      ...base,
      plan: null,
      activities: activities.map((activity) => ({ ...activity, workoutId: null })),
    };
  }
  const workouts: readonly PlanWorkoutRecord[] = await createLegacyPlanRepository(
    deps.store,
  ).readWorkouts(plan.id);
  const copies = await readIcuCopies(mirror, plan.id);
  const matches = createPlanWorkoutMatchRepository(deps.store);
  const records = await matches.readForPlan(plan.id);
  const sync = await matches.readSyncStatus();
  const lastFinishedSync: SyncCoverage =
    sync.lastSuccessfulSyncAtMs === null
      ? { kind: "never" }
      : { kind: "started-on", dateKey: deps.dateKeyOfMs(sync.lastSuccessfulSyncAtMs) };
  const calendarWorkouts: PlanCalendarWorkout[] = workouts.map((workout) => {
    const stored = copies.get(workout.id);
    const copy = storedIcuCopy(stored);
    const match = outcomeMatch(records.filter((record) => record.planWorkoutId === workout.id));
    const outcome = workoutOutcome({
      workout: {
        dateKey: workout.dateKey,
        durationS: workout.durationS,
        place: copy.kind === "removed-by-you" ? "removed-by-you" : "in-plan",
      },
      match,
      todayDateKey: deps.todayDateKey,
      lastFinishedSync,
    });
    return {
      id: workout.id,
      dateKey: workout.dateKey,
      name: workout.name,
      sport: workout.sport,
      durationS: workout.durationS,
      copy: copyView(copy),
      lastWrite: stored?.lastWrite.kind ?? "none",
      outcome: outcomeView(outcome, match),
      doneS: doneSeconds(outcome, match),
    };
  });
  const delivery = await readWeekDelivery(mirror, plan.id);
  const sent = await sentTrainingWeeks(
    { plan, workouts, todayDateKey: deps.todayDateKey, firstEligibleDateKey: deps.todayDateKey },
    mirror,
  );
  const ranges = trainingWeeks(plan);
  const weeks: PlanCalendarWeek[] = ranges.map((range) => {
    const inWeek = calendarWorkouts.filter(
      (workout) => workout.dateKey >= range.startDateKey && workout.dateKey <= range.endDateKey,
    );
    return {
      index: range.index,
      startDateKey: range.startDateKey,
      endDateKey: range.endDateKey,
      plannedS: inWeek
        .filter(counted)
        .reduce((total, workout) => total + (workout.durationS ?? 0), 0),
      doneS: inWeek.filter(counted).reduce((total, workout) => total + workout.doneS, 0),
      toConfirm: inWeek.filter((workout) => workout.outcome.kind === "is-this-it").length,
      phase: phaseForWeek(plan, range.index),
      status: weekDeliveryStatus({
        plan,
        state: delivery,
        setting: weekDelivery,
        todayDateKey: deps.todayDateKey,
        sentWeeks: sent,
        week: range.index,
      }),
    };
  });
  const confirmedBy = new Map(
    records
      .filter((record) => record.decision === "confirmed")
      .map((record) => [record.activityId, record.planWorkoutId]),
  );
  const currentWeek = weekOf(deps.todayDateKey, ranges);
  return {
    ...base,
    plan: {
      planId: plan.id,
      version: active.version,
      name: plan.name,
      startDateKey: plan.startDateKey,
      targetDateKey: plan.targetDateKey,
      totalWeeks: plan.totalWeeks,
      currentWeek,
      phase: phaseForWeek(plan, currentWeek),
      weeks,
      workouts: calendarWorkouts,
    },
    activities: activities.map((activity) => ({
      ...activity,
      workoutId: confirmedBy.get(activity.activityId) ?? null,
    })),
  };
}
