import {
  AthletePlanChangeIntentSchema,
  type PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import {
  icuCopyAllowsMove,
  icuCopyDrag,
  icuCopyIsAthleteChange,
  planWorkoutFingerprint,
  readIcuCopies,
  saveIcuCopy,
  storedIcuCopy,
  type IcuCopy,
} from "@enduragent/engine/calendar";
import {
  addCivilDays,
  createPlanCalendarMirrorRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { z } from "zod";
import { applyWorkoutEdits, type PlanCalendarEditDeps } from "./plan-calendar-edit.js";

export interface PlanCalendarMoveDeps extends PlanCalendarEditDeps {
  readonly todayDateKey: () => number;
  readonly now: () => number;
  readonly changed: () => Promise<void>;
}

export interface MovedByYou {
  readonly fromDateKey: number;
  readonly toDateKey: number;
}

const EnvelopeIntentSchema = z.object({ intent: z.unknown() });
const PinnedSchema = z.object({ pinned: z.boolean().optional() });

function pinned(workout: PlanWorkoutRecord): boolean {
  try {
    const parsed = PinnedSchema.safeParse(JSON.parse(workout.structureJson));
    return parsed.success && parsed.data.pinned === true;
  } catch {
    return false;
  }
}

function showsOnItsDay(copy: IcuCopy): boolean {
  return copy.kind !== "removed-by-you" && copy.kind !== "kept-as-yours";
}

export function workoutMovable(input: {
  readonly workout: PlanWorkoutRecord;
  readonly copy: IcuCopy;
  readonly planned: boolean;
  readonly todayDateKey: number;
}): boolean {
  return (
    input.planned &&
    input.workout.dateKey >= input.todayDateKey &&
    input.workout.origin === "coach" &&
    !pinned(input.workout) &&
    icuCopyAllowsMove(input.copy) &&
    !icuCopyIsAthleteChange(input.copy)
  );
}

export async function movesByYou(
  store: Pick<SqlStore, "all">,
  planId: string,
): Promise<ReadonlyMap<string, MovedByYou>> {
  const rows = await store.all(
    "SELECT diff_json FROM plan_change WHERE plan_id=? AND status='applied' AND diff_json LIKE '%move-by-you%' ORDER BY result_revision_number",
    [planId],
  );
  const moves = new Map<string, MovedByYou>();
  for (const row of rows) {
    if (typeof row.diff_json !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.diff_json);
    } catch {
      continue;
    }
    const envelope = EnvelopeIntentSchema.safeParse(parsed);
    const intent = envelope.success
      ? AthletePlanChangeIntentSchema.safeParse(envelope.data.intent)
      : null;
    if (intent?.success !== true || intent.data.kind !== "move-by-you") continue;
    for (const move of intent.data.moves) {
      moves.set(move.planWorkoutId, { fromDateKey: move.fromDateKey, toDateKey: move.toDateKey });
    }
  }
  return moves;
}

type MoveRequest = {
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly toDateKey: number;
  readonly swap: boolean;
};

function refused(
  reason: Extract<PlanCalendarRpcResult, { status: "refused" }>["reason"],
): PlanCalendarRpcResult {
  return { status: "refused", reason };
}

export async function moveWorkout(
  deps: PlanCalendarMoveDeps,
  request: MoveRequest,
): Promise<PlanCalendarRpcResult> {
  const plans = createLegacyPlanRepository(deps.store);
  const plan = await plans.read(request.planId);
  if (plan === undefined || plan.status !== "active") return refused("no-active-plan");
  const today = deps.todayDateKey();
  const lastDay = addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1);
  if (
    request.toDateKey < today ||
    request.toDateKey < plan.startDateKey ||
    request.toDateKey > lastDay
  ) {
    return refused("outside-plan");
  }
  const workouts = await plans.readWorkouts(request.planId);
  const moved = workouts.find((workout) => workout.id === request.planWorkoutId);
  if (moved === undefined) return refused("workout-not-movable");
  if (moved.dateKey === request.toDateKey) return { status: "moved" };
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const copies = await readIcuCopies(mirror, request.planId);
  const copyOf = (workout: PlanWorkoutRecord) => storedIcuCopy(copies.get(workout.id));
  const others = request.swap
    ? workouts.filter(
        (workout) =>
          workout.id !== moved.id &&
          workout.dateKey === request.toDateKey &&
          showsOnItsDay(copyOf(workout)),
      )
    : [];
  const matches = createPlanWorkoutMatchRepository(deps.store);
  for (const workout of [moved, ...others]) {
    const copy = copyOf(workout);
    if (copy.kind === "changed-in-icu") return refused("change-card-open");
    const decided = (await matches.readForWorkout(workout.id)).some(
      (match) => match.decision === "confirmed" || match.decision === "suggested",
    );
    if (!workoutMovable({ workout, copy, planned: !decided, todayDateKey: today })) {
      return refused("workout-not-movable");
    }
  }
  const moves = [
    { planWorkoutId: moved.id, fromDateKey: moved.dateKey, toDateKey: request.toDateKey },
    ...others.map((workout) => ({
      planWorkoutId: workout.id,
      fromDateKey: workout.dateKey,
      toDateKey: moved.dateKey,
    })),
  ];
  const applied = await applyWorkoutEdits(deps, {
    planId: request.planId,
    title: `Moved ${moved.name}`,
    intent: { kind: "move-by-you", moves },
    edits: moves.map((move) => ({ planWorkoutId: move.planWorkoutId, dateKey: move.toDateKey })),
  });
  if (applied === "refused") return refused("plan-change-refused");
  const updated = await plans.readWorkouts(request.planId);
  const fresh = await readIcuCopies(mirror, request.planId);
  for (const move of moves) {
    const stored = fresh.get(move.planWorkoutId);
    const workout = updated.find((entry) => entry.id === move.planWorkoutId);
    if (stored === undefined || workout === undefined) continue;
    const dragged = icuCopyDrag(storedIcuCopy(stored), planWorkoutFingerprint(workout));
    if (dragged === null) continue;
    await saveIcuCopy(
      { mirror, now: deps.now },
      {
        planId: request.planId,
        planWorkoutId: workout.id,
        fallbackDateKey: workout.dateKey,
        stored,
        copy: dragged,
        lastWrite: stored.lastWrite,
      },
    );
  }
  void deps.changed();
  return { status: "moved" };
}
