import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import {
  icuCopyAllowsMove,
  icuCopyDrag,
  planWorkoutFingerprint,
  readIcuCopies,
  saveIcuCopy,
  storedIcuCopy,
} from "@enduragent/engine/calendar";
import { addCivilDays, createPlanCalendarMirrorRepository } from "@enduragent/kernel/planning";
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

const MOVE_INTENT = "move-by-you";

const MoveIntentSchema = z.object({
  kind: z.literal(MOVE_INTENT),
  moves: z.array(
    z.object({
      planWorkoutId: z.string(),
      fromDateKey: z.number().int(),
      toDateKey: z.number().int(),
    }),
  ),
});

const EnvelopeIntentSchema = z.object({ intent: z.unknown() });

export async function movesByYou(
  store: Pick<SqlStore, "all">,
  planId: string,
): Promise<ReadonlyMap<string, MovedByYou>> {
  const rows = await store.all(
    "SELECT diff_json FROM plan_change WHERE plan_id=? AND status='applied' ORDER BY result_revision_number",
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
    const intent = envelope.success ? MoveIntentSchema.safeParse(envelope.data.intent) : null;
    if (intent?.success !== true) continue;
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
  if (request.toDateKey < today || request.toDateKey > lastDay) return refused("outside-plan");
  const workouts = await plans.readWorkouts(request.planId);
  const moved = workouts.find((workout) => workout.id === request.planWorkoutId);
  if (moved === undefined || moved.dateKey < today || moved.dateKey === request.toDateKey) {
    return refused("workout-not-movable");
  }
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const copies = await readIcuCopies(mirror, request.planId);
  const others = request.swap
    ? workouts.filter((workout) => workout.dateKey === request.toDateKey)
    : [];
  for (const workout of [moved, ...others]) {
    const copy = storedIcuCopy(copies.get(workout.id));
    if (copy.kind === "changed-in-icu") return refused("change-card-open");
    if (!icuCopyAllowsMove(copy)) return refused("workout-not-movable");
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
    intent: { kind: MOVE_INTENT, moves },
    edits: moves.map((move) => ({ planWorkoutId: move.planWorkoutId, dateKey: move.toDateKey })),
  });
  if (applied === "refused") return refused("plan-change-refused");
  const updated = await plans.readWorkouts(request.planId);
  for (const move of moves) {
    const stored = copies.get(move.planWorkoutId);
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
