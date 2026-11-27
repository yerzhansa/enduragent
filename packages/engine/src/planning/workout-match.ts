import type {
  PlanActivityObservation,
  PlanWorkoutMatchRecord,
  PlanWorkoutMatchRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";

export const WORKOUT_MATCH_DURATION_RATIO = 0.5;
export const WORKOUT_MATCH_DURATION_MIN_SECONDS = 15 * 60;
export const WORKOUT_MATCH_DURATION_MAX_SECONDS = 45 * 60;
export const WORKOUT_MATCH_AS_PLANNED_RATIO = 0.1;
export const WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS = 5 * 60;
export const WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS = 15 * 60;

export type WorkoutMatchDisplayStatus =
  | "as-planned"
  | "adjusted"
  | "moved"
  | "missed"
  | "extra"
  | "decision-needed"
  | "awaiting-sync"
  | "upcoming";

export interface ProjectedWorkoutMatch {
  readonly workoutId: string | null;
  readonly activityId: string | null;
  readonly matchId: string | null;
  readonly status: WorkoutMatchDisplayStatus;
  readonly plannedDateKey: number | null;
  readonly actualDateKey: number | null;
  readonly plannedDurationS: number | null;
  readonly actualDurationS: number | null;
  readonly actualSport: string | null;
  readonly requiresConfirmation: boolean;
  readonly createdAtMs: number;
}

export interface WorkoutMatchIdentity {
  newId(): string;
  deviceId(): Promise<string>;
  stamp(): { readonly physicalMs: number; readonly counter: number };
}

function normalizeSport(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "ride" || normalized === "bike" ? "cycling" : normalized;
}

function differenceLimit(plannedS: number): number {
  return Math.min(
    WORKOUT_MATCH_DURATION_MAX_SECONDS,
    Math.max(WORKOUT_MATCH_DURATION_MIN_SECONDS, plannedS * WORKOUT_MATCH_DURATION_RATIO),
  );
}

function asPlannedLimit(plannedS: number): number {
  return Math.min(
    WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS,
    Math.max(WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS, plannedS * WORKOUT_MATCH_AS_PLANNED_RATIO),
  );
}

function durationDifference(
  workout: Pick<PlanWorkoutRecord, "durationS">,
  activity: Pick<PlanActivityObservation, "durationS">,
): number | null {
  if (workout.durationS === null || activity.durationS === null) return null;
  return Math.abs(workout.durationS - activity.durationS);
}

export function isRacePlanWorkout(workout: Pick<PlanWorkoutRecord, "structureJson">): boolean {
  try {
    const structure = JSON.parse(workout.structureJson) as {
      readonly race?: unknown;
      readonly category?: unknown;
      readonly type?: unknown;
      readonly subType?: unknown;
    };
    return (
      structure.race === true ||
      [structure.category, structure.type, structure.subType].some(
        (value) => typeof value === "string" && value.toLowerCase() === "race",
      )
    );
  } catch {
    return false;
  }
}

function qualified(workout: PlanWorkoutRecord, activity: PlanActivityObservation): boolean {
  if (
    workout.dateKey !== activity.dateKey ||
    normalizeSport(workout.sport) !== normalizeSport(activity.sport)
  ) {
    return false;
  }
  if (workout.durationS === null || activity.durationS === null) return true;
  return Math.abs(workout.durationS - activity.durationS) <= differenceLimit(workout.durationS);
}

export async function refreshPlanWorkoutMatches(input: {
  readonly planId: string;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly startDateKey: number;
  readonly endDateKey: number;
  readonly repository: PlanWorkoutMatchRepository;
  readonly identity: WorkoutMatchIdentity;
}): Promise<{
  readonly activities: readonly PlanActivityObservation[];
  readonly matches: readonly PlanWorkoutMatchRecord[];
}> {
  const [activities, providerIdentities, existing] = await Promise.all([
    input.repository.listActivities(input.startDateKey, input.endDateKey),
    input.repository.readProviderIdentities(input.planId),
    input.repository.readForPlan(input.planId),
  ]);
  const eligibleWorkouts = input.workouts.filter(
    (workout) =>
      workout.dateKey >= input.startDateKey &&
      workout.dateKey <= input.endDateKey &&
      !isRacePlanWorkout(workout),
  );
  const workoutByEventId = new Map(
    providerIdentities.map((identity) => [identity.providerEventId, identity.planWorkoutId]),
  );
  const workoutById = new Map(eligibleWorkouts.map((workout) => [workout.id, workout]));
  const usedWorkoutIds = new Set(
    existing.filter((match) => match.decision === "confirmed").map((match) => match.planWorkoutId),
  );
  const usedActivityIds = new Set(
    existing.filter((match) => match.decision === "confirmed").map((match) => match.activityId),
  );
  const deviceId = await input.identity.deviceId();

  for (const activity of activities) {
    const workoutId =
      activity.pairedEventId === null ? undefined : workoutByEventId.get(activity.pairedEventId);
    const workout = workoutId === undefined ? undefined : workoutById.get(workoutId);
    if (workout === undefined) continue;
    const stamp = input.identity.stamp();
    const match = await input.repository.observe({
      id: input.identity.newId(),
      planId: input.planId,
      planWorkoutId: workout.id,
      activityId: activity.activityId,
      providerActivityId: activity.providerActivityId,
      providerEventId: activity.pairedEventId,
      source: "platform",
      decision: "confirmed",
      activityDateKey: activity.dateKey,
      activitySport: activity.sport,
      activityDurationS: activity.durationS,
      observedAtMs: stamp.physicalMs,
      decidedAtMs: stamp.physicalMs,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
    if (match?.decision === "confirmed") {
      usedWorkoutIds.add(match.planWorkoutId);
      usedActivityIds.add(match.activityId);
    }
  }

  const candidates = eligibleWorkouts
    .filter((workout) => !usedWorkoutIds.has(workout.id))
    .flatMap((workout) =>
      activities
        .filter(
          (activity) => !usedActivityIds.has(activity.activityId) && qualified(workout, activity),
        )
        .map((activity) => ({
          workout,
          activity,
          difference: durationDifference(workout, activity) ?? 0,
        })),
    )
    .sort(
      (left, right) =>
        left.difference - right.difference ||
        left.workout.id.localeCompare(right.workout.id) ||
        left.activity.activityId.localeCompare(right.activity.activityId),
    );
  for (const candidate of candidates) {
    if (
      usedWorkoutIds.has(candidate.workout.id) ||
      usedActivityIds.has(candidate.activity.activityId)
    ) {
      continue;
    }
    const stamp = input.identity.stamp();
    const match = await input.repository.observe({
      id: input.identity.newId(),
      planId: input.planId,
      planWorkoutId: candidate.workout.id,
      activityId: candidate.activity.activityId,
      providerActivityId: candidate.activity.providerActivityId,
      providerEventId: null,
      source: "heuristic",
      decision: "suggested",
      activityDateKey: candidate.activity.dateKey,
      activitySport: candidate.activity.sport,
      activityDurationS: candidate.activity.durationS,
      observedAtMs: stamp.physicalMs,
      decidedAtMs: null,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
    if (match !== null && match.decision !== "rejected" && match.decision !== "unpaired") {
      usedWorkoutIds.add(candidate.workout.id);
      usedActivityIds.add(candidate.activity.activityId);
    }
  }
  return {
    activities,
    matches: await input.repository.readForPlan(input.planId),
  };
}

export function projectWorkoutMatches(input: {
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly activities: readonly PlanActivityObservation[];
  readonly matches: readonly PlanWorkoutMatchRecord[];
  readonly todayDateKey: number;
  readonly awaitingSync: boolean;
}): readonly ProjectedWorkoutMatch[] {
  const activityById = new Map(input.activities.map((activity) => [activity.activityId, activity]));
  const effective = input.matches.filter(
    (match) => match.decision === "confirmed" || match.decision === "suggested",
  );
  const matchByWorkout = new Map(effective.map((match) => [match.planWorkoutId, match]));
  const usedActivities = new Set(effective.map((match) => match.activityId));
  const rows: ProjectedWorkoutMatch[] = [];
  for (const workout of input.workouts) {
    if (isRacePlanWorkout(workout)) continue;
    const match = matchByWorkout.get(workout.id);
    const activity = match === undefined ? undefined : activityById.get(match.activityId);
    if (match?.decision === "suggested") {
      rows.push({
        workoutId: workout.id,
        activityId: match.activityId,
        matchId: match.id,
        status: "decision-needed",
        plannedDateKey: workout.dateKey,
        actualDateKey: match.activityDateKey,
        plannedDurationS: workout.durationS,
        actualDurationS: match.activityDurationS,
        actualSport: match.activitySport,
        requiresConfirmation: true,
        createdAtMs: match.observedAtMs,
      });
      continue;
    }
    if (match?.decision === "confirmed") {
      const actualDateKey = activity?.dateKey ?? match.activityDateKey;
      const actualDurationS = activity?.durationS ?? match.activityDurationS;
      const difference =
        workout.durationS === null || actualDurationS === null
          ? 0
          : Math.abs(workout.durationS - actualDurationS);
      const status =
        actualDateKey !== workout.dateKey
          ? "moved"
          : workout.durationS !== null && difference > asPlannedLimit(workout.durationS)
            ? "adjusted"
            : "as-planned";
      rows.push({
        workoutId: workout.id,
        activityId: match.activityId,
        matchId: match.id,
        status,
        plannedDateKey: workout.dateKey,
        actualDateKey,
        plannedDurationS: workout.durationS,
        actualDurationS,
        actualSport: activity?.sport ?? match.activitySport,
        requiresConfirmation: false,
        createdAtMs: match.observedAtMs,
      });
      continue;
    }
    rows.push({
      workoutId: workout.id,
      activityId: null,
      matchId: null,
      status:
        input.awaitingSync && workout.dateKey <= input.todayDateKey
          ? "awaiting-sync"
          : workout.dateKey < input.todayDateKey
            ? "missed"
            : "upcoming",
      plannedDateKey: workout.dateKey,
      actualDateKey: null,
      plannedDurationS: workout.durationS,
      actualDurationS: null,
      actualSport: null,
      requiresConfirmation: false,
      createdAtMs: 0,
    });
  }
  for (const activity of input.activities) {
    if (usedActivities.has(activity.activityId)) continue;
    rows.push({
      workoutId: null,
      activityId: activity.activityId,
      matchId: null,
      status: "extra",
      plannedDateKey: null,
      actualDateKey: activity.dateKey,
      plannedDurationS: null,
      actualDurationS: activity.durationS,
      actualSport: activity.sport,
      requiresConfirmation: false,
      createdAtMs: 0,
    });
  }
  return rows.sort(
    (left, right) =>
      (left.plannedDateKey ?? left.actualDateKey ?? 0) -
        (right.plannedDateKey ?? right.actualDateKey ?? 0) ||
      (left.workoutId ?? left.activityId ?? "").localeCompare(
        right.workoutId ?? right.activityId ?? "",
      ),
  );
}
