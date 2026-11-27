import type {
  PlanCalendarRide,
  PlanCalendarRideDecision,
  PlanCalendarRideMatch,
  PlanCalendarRideWorkout,
  PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import { trainingWeeks, workoutOutcome } from "@enduragent/engine/calendar";
import {
  addCivilDays,
  createPlanWorkoutMatchRepository,
  type PlanRecord,
  type PlanWorkoutMatchDecision,
  type PlanWorkoutMatchRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  createTrainingHistoryReader,
  type MigratorStore,
  type RecordedFact,
  type SqlStore,
  type TrainingHistoryFactRow,
} from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import type { PlanCalendarEditDeps } from "./plan-calendar-edit.js";
import { boundedRange, isoOf } from "./plan-calendar-read.js";

export type PlanCalendarRidesRead = Extract<PlanCalendarRpcResult, { status: "rides" }>;

type RideStore = SqlStore & Pick<MigratorStore, "transaction">;

export interface PlanCalendarRidesDeps {
  readonly store: RideStore;
  readonly identity: PlanCalendarEditDeps["identity"];
  readonly todayDateKey: () => number;
  readonly changed: () => Promise<void>;
}

interface DateRange {
  readonly startDateKey: number;
  readonly endDateKey: number;
}

interface ActivePlan {
  readonly plan: PlanRecord;
  readonly workouts: ReadonlyMap<string, PlanWorkoutRecord>;
  readonly records: readonly PlanWorkoutMatchRecord[];
}

const NEARBY_DAYS = 3;

function rideKind(subSport: string | null): PlanCalendarRide["kind"] {
  switch (subSport) {
    case "road":
      return "road";
    case "indoor_cycling":
    case "virtual_activity":
    case "spin":
      return "indoor";
    case "mountain":
    case "downhill":
    case "e_bike_mountain":
      return "mountain";
    case "gravel_cycling":
    case "cyclocross":
      return "gravel";
    default:
      return "other";
  }
}

function recorded(fact: RecordedFact<number>, max: number): number | null {
  return fact.kind === "recorded" ? Math.min(max, Math.max(0, fact.value)) : null;
}

function rounded(fact: RecordedFact<number>, max: number): number | null {
  const value = recorded(fact, max);
  return value === null ? null : Math.round(value);
}

async function activePlan(store: RideStore): Promise<ActivePlan | null> {
  const active = await store.get("SELECT plan_id FROM planning_plan WHERE status='active'");
  if (typeof active?.plan_id !== "string") return null;
  const plans = createLegacyPlanRepository(store);
  const plan = await plans.read(active.plan_id);
  if (plan === undefined) return null;
  const workouts = await plans.readWorkouts(plan.id);
  return {
    plan,
    workouts: new Map(workouts.map((workout) => [workout.id, workout])),
    records: await createPlanWorkoutMatchRepository(store).readForPlan(plan.id),
  };
}

function workoutView(workout: PlanWorkoutRecord): PlanCalendarRideWorkout {
  return {
    planWorkoutId: workout.id,
    name: workout.name,
    dateKey: workout.dateKey,
    durationS: workout.durationS,
  };
}

function rideMatch(
  records: readonly PlanWorkoutMatchRecord[],
  workouts: ReadonlyMap<string, PlanWorkoutRecord>,
  todayDateKey: number,
): PlanCalendarRideMatch {
  const confirmed = records.find(
    (record) => record.decision === "confirmed" && workouts.has(record.planWorkoutId),
  );
  const confirmedWorkout =
    confirmed === undefined ? undefined : workouts.get(confirmed.planWorkoutId);
  if (confirmed !== undefined && confirmedWorkout !== undefined) {
    const outcome = workoutOutcome({
      workout: {
        dateKey: confirmed.activityDateKey,
        durationS: confirmedWorkout.durationS,
        place: "in-plan",
      },
      match: {
        kind: "confirmed",
        matchId: confirmed.id,
        activityId: confirmed.activityId,
        activityDateKey: confirmed.activityDateKey,
        activityDurationS: confirmed.activityDurationS,
      },
      todayDateKey,
      lastFinishedSync: { kind: "never" },
    });
    return {
      kind: "confirmed",
      ...workoutView(confirmedWorkout),
      outcome: outcome.kind === "done-differently" ? "done-differently" : "done-as-planned",
      by: confirmed.source === "platform" ? "intervals" : "you",
    };
  }
  const suggested = records.find(
    (record) => record.decision === "suggested" && workouts.has(record.planWorkoutId),
  );
  const suggestedWorkout =
    suggested === undefined ? undefined : workouts.get(suggested.planWorkoutId);
  return suggestedWorkout === undefined
    ? { kind: "none" }
    : { kind: "suggested", ...workoutView(suggestedWorkout) };
}

function otherWorkouts(
  dateKey: number,
  match: PlanCalendarRideMatch,
  context: ActivePlan,
): PlanCalendarRideWorkout[] {
  const first = addCivilDays(dateKey, -NEARBY_DAYS);
  const last = addCivilDays(dateKey, NEARBY_DAYS);
  const taken = new Set(
    context.records
      .filter((record) => record.decision === "confirmed")
      .map((record) => record.planWorkoutId),
  );
  return [...context.workouts.values()]
    .filter(
      (workout) =>
        workout.dateKey >= first &&
        workout.dateKey <= last &&
        !taken.has(workout.id) &&
        (match.kind === "none" || workout.id !== match.planWorkoutId),
    )
    .sort((left, right) => left.dateKey - right.dateKey || left.id.localeCompare(right.id))
    .slice(0, 32)
    .map(workoutView);
}

async function intervalsRides(store: SqlStore, range: DateRange): Promise<ReadonlySet<string>> {
  const rows = await store.all(
    `SELECT DISTINCT sr.session_key FROM source_record sr
JOIN session s ON s.session_key=sr.session_key
WHERE sr.source='intervals-icu' AND s.local_date_key BETWEEN ? AND ?`,
    [range.startDateKey, range.endDateKey],
  );
  return new Set(
    rows.flatMap((row) => (typeof row.session_key === "string" ? [row.session_key] : [])),
  );
}

function rideView(
  row: TrainingHistoryFactRow,
  fromIntervals: boolean,
  context: ActivePlan | null,
  todayDateKey: number,
): PlanCalendarRide {
  const dateKey = Number(row.localDate.replaceAll("-", ""));
  const seconds = row.movingSeconds ?? row.elapsedSeconds;
  const match =
    context === null
      ? ({ kind: "none" } as const)
      : rideMatch(
          context.records.filter((record) => record.activityId === row.id),
          context.workouts,
          todayDateKey,
        );
  return {
    activityId: row.id,
    dateKey,
    startEpochSeconds: row.startEpochSeconds,
    timezoneOffsetSeconds: row.timezoneOffsetSeconds,
    name: row.title === null || row.title.trim().length === 0 ? null : row.title.trim(),
    kind: rideKind(row.subSport),
    fromIntervals,
    sport: "cycling",
    durationS: seconds === null ? null : Math.max(0, Math.round(seconds)),
    distanceM: row.distanceMeters,
    load: rounded(row.load, 10_000),
    averagePowerW: rounded(row.averagePowerWatts, 20_000),
    averageHeartRateBpm: rounded(row.averageHeartRateBpm, 500),
    perceivedExertion: recorded(row.perceivedExertion, 10),
    match,
    otherWorkouts: context === null ? [] : otherWorkouts(dateKey, match, context),
  };
}

async function ridesInside(
  store: SqlStore,
  todayDateKey: number,
  range: DateRange,
  context: ActivePlan | null,
): Promise<PlanCalendarRide[]> {
  if (range.endDateKey < range.startDateKey) return [];
  const window = await createTrainingHistoryReader(store).readWindow({
    start: isoOf(range.startDateKey),
    end: isoOf(range.endDateKey),
  });
  const fromIntervals = await intervalsRides(store, range);
  return [...window.rows]
    .sort(
      (left, right) =>
        right.localDate.localeCompare(left.localDate) ||
        right.startEpochSeconds - left.startEpochSeconds ||
        left.id.localeCompare(right.id),
    )
    .map((row) => rideView(row, fromIntervals.has(row.id), context, todayDateKey));
}

export async function readRides(
  deps: { readonly store: RideStore; readonly todayDateKey: number },
  range: DateRange,
): Promise<PlanCalendarRidesRead> {
  return deps.store.transaction(async () => {
    const context = await activePlan(deps.store);
    const rides = await ridesInside(deps.store, deps.todayDateKey, boundedRange(range), context);
    return {
      status: "rides",
      todayDateKey: deps.todayDateKey,
      plan:
        context === null
          ? null
          : {
              planId: context.plan.id,
              weeks: trainingWeeks(context.plan).map((week) => ({
                index: week.index,
                startDateKey: week.startDateKey,
                endDateKey: week.endDateKey,
              })),
            },
      rides,
    };
  });
}

type Refusal = Extract<PlanCalendarRpcResult, { status: "refused" }>;

function refused(reason: Refusal["reason"]): Refusal {
  return { status: "refused", reason };
}

function targetOf(decision: PlanCalendarRideDecision): string | null {
  return decision.kind === "extra" ? null : decision.planWorkoutId;
}

function releaseDecision(
  record: PlanWorkoutMatchRecord,
): Exclude<PlanWorkoutMatchDecision, "suggested"> | null {
  if (record.decision === "suggested") return "rejected";
  if (record.decision !== "confirmed") return null;
  return record.source === "platform" ? "unpaired" : "rejected";
}

export async function decideRide(
  deps: PlanCalendarRidesDeps,
  request: {
    readonly planId: string;
    readonly activityId: string;
    readonly decision: PlanCalendarRideDecision;
  },
): Promise<PlanCalendarRpcResult> {
  const refusal = await deps.store.transaction(async (): Promise<Refusal | null> => {
    const context = await activePlan(deps.store);
    if (context === null || context.plan.id !== request.planId) return refused("no-active-plan");
    const session = await deps.store.get(
      "SELECT local_date_key FROM session WHERE session_key=? AND sport='cycling'",
      [request.activityId],
    );
    const dateKey = session?.local_date_key;
    if (typeof dateKey !== "number") return refused("match-changed");
    const matches = createPlanWorkoutMatchRepository(deps.store);
    const observation = (await matches.listActivities(dateKey, dateKey)).find(
      (activity) => activity.activityId === request.activityId,
    );
    if (observation === undefined) return refused("match-changed");
    const targetId = targetOf(request.decision);
    const target = targetId === null ? null : context.workouts.get(targetId);
    if (target === undefined) return refused("match-changed");
    const mine = context.records.filter((record) => record.activityId === request.activityId);
    const current = target === null ? undefined : mine.find((r) => r.planWorkoutId === target.id);
    if (
      request.decision.kind === "confirm" &&
      current?.decision !== "suggested" &&
      current?.decision !== "confirmed"
    ) {
      return refused("match-changed");
    }
    const takenByOther =
      target !== null &&
      context.records.some(
        (record) =>
          record.planWorkoutId === target.id &&
          record.decision === "confirmed" &&
          record.activityId !== request.activityId,
      );
    if (takenByOther) return refused("match-changed");
    const deviceId = await deps.identity.deviceId();
    const decide = async (
      record: PlanWorkoutMatchRecord,
      decision: Exclude<PlanWorkoutMatchDecision, "suggested">,
    ): Promise<void> => {
      const stamp = deps.identity.hlcStamp();
      await matches.decide({
        id: record.id,
        decision,
        decidedAtMs: Math.max(stamp.physicalMs, record.observedAtMs),
        deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      });
    };
    for (const record of mine) {
      if (record.planWorkoutId === target?.id) continue;
      const release = releaseDecision(record);
      if (release !== null) await decide(record, release);
    }
    if (target === null) return null;
    if (current === undefined) {
      const stamp = deps.identity.hlcStamp();
      await matches.observe({
        id: deps.identity.newUlid(),
        planId: context.plan.id,
        planWorkoutId: target.id,
        activityId: request.activityId,
        providerActivityId: observation.providerActivityId,
        providerEventId: null,
        source: "heuristic",
        decision: "confirmed",
        activityDateKey: observation.dateKey,
        activitySport: observation.sport,
        activityDurationS:
          observation.durationS !== null && observation.durationS > 0
            ? observation.durationS
            : null,
        observedAtMs: stamp.physicalMs,
        decidedAtMs: stamp.physicalMs,
        deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      });
    } else if (current.decision !== "confirmed") {
      await decide(current, "confirmed");
    }
    for (const record of context.records) {
      if (
        record.planWorkoutId === target.id &&
        record.activityId !== request.activityId &&
        record.decision === "suggested"
      ) {
        await decide(record, "rejected");
      }
    }
    return null;
  });
  if (refusal !== null) return refusal;
  void deps.changed();
  const ride = await deps.store.transaction(async () => {
    const session = await deps.store.get("SELECT local_date_key FROM session WHERE session_key=?", [
      request.activityId,
    ]);
    if (typeof session?.local_date_key !== "number") return undefined;
    const day = { startDateKey: session.local_date_key, endDateKey: session.local_date_key };
    const rides = await ridesInside(
      deps.store,
      deps.todayDateKey(),
      day,
      await activePlan(deps.store),
    );
    return rides.find((entry) => entry.activityId === request.activityId);
  });
  return ride === undefined ? refused("match-changed") : { status: "ride", ride };
}
