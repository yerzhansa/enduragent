import type {
  PlanCalendarActivity,
  PlanCalendarCopy,
  PlanCalendarOutcome,
  PlanCalendarRpcResult,
  PlanCalendarWeek,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import {
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
  type PlanRecord,
  type PlanWorkoutMatchRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";

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

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readActivities(
  store: SqlStore,
  range: { readonly startDateKey: number; readonly endDateKey: number },
): Promise<readonly Omit<PlanCalendarActivity, "workoutId">[]> {
  const rows = await store.all(
    `SELECT s.session_key, s.local_date_key, s.sport,
COALESCE(s.moving_s,s.timer_s,s.elapsed_s) AS duration_s, s.distance_m,
COALESCE(json_extract(COALESCE(rev.payload_json,sr.payload_json),'$.name'),w.name) AS name,
json_extract(COALESCE(rev.payload_json,sr.payload_json),'$.icu_training_load') AS load
FROM session s
LEFT JOIN workout w ON w.workout_key=s.workout_key
LEFT JOIN source_record sr ON sr.session_key=s.session_key AND sr.source='intervals-icu'
LEFT JOIN source_record_current current ON current.source_record_id=sr.id
LEFT JOIN source_record_revision rev ON rev.source_record_id=current.source_record_id
  AND rev.revision_id=current.revision_id
WHERE s.local_date_key BETWEEN ? AND ? AND s.is_transition=0
ORDER BY s.local_date_key,s.start_utc,s.session_key`,
    [range.startDateKey, range.endDateKey],
  );
  const seen = new Set<string>();
  const activities: Omit<PlanCalendarActivity, "workoutId">[] = [];
  for (const row of rows) {
    const activityId = text(row.session_key);
    const dateKey = finite(row.local_date_key);
    const sport = text(row.sport);
    if (activityId === null || dateKey === null || sport === null || seen.has(activityId)) continue;
    seen.add(activityId);
    const duration = finite(row.duration_s);
    const load = finite(row.load);
    activities.push({
      activityId,
      dateKey,
      name: text(row.name),
      sport,
      durationS: duration === null ? null : Math.max(0, Math.round(duration)),
      distanceM: finite(row.distance_m),
      load: load === null ? null : Math.max(0, Math.round(load)),
    });
  }
  return activities;
}

function phaseForWeek(plan: PlanRecord, weekIndex: number | null): string | null {
  if (weekIndex === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plan.structureJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const phases = Object.fromEntries(Object.entries(parsed)).phases;
  if (!Array.isArray(phases)) return null;
  let throughWeek = 0;
  for (const candidate of phases) {
    if (candidate === null || typeof candidate !== "object") continue;
    const entry = Object.fromEntries(Object.entries(candidate));
    const duration = finite(entry.durationWeeks);
    if (duration === null || duration < 1) continue;
    throughWeek += duration;
    if (weekIndex <= throughWeek) return text(entry.name) ?? text(entry.focus);
  }
  return null;
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
    };
  });
  const doneSeconds = new Map(
    records
      .filter((record) => record.decision === "confirmed")
      .map((record) => [record.planWorkoutId, record.activityDurationS ?? 0]),
  );
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
        .filter((workout) => workout.outcome.kind !== "removed-by-you")
        .reduce((total, workout) => total + (workout.durationS ?? 0), 0),
      doneS: inWeek.reduce((total, workout) => total + (doneSeconds.get(workout.id) ?? 0), 0),
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
