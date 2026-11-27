import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import {
  encodeCloseChoice,
  encodeWeekDelivery,
  firstChangeSetWeeks,
  icuFingerprintParts,
  planEndingSummary,
  readIcuCopies,
  storedIcuCopy,
  type PlanCopyOnIcu,
  type TickedChange,
} from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { z } from "zod";

export interface PlanCalendarDetailsDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly todayDateKey: () => number;
  readonly now: () => number;
}

type Details = Extract<PlanCalendarRpcResult, { status: "plan-details" }>;
type HistoryEntry = Details["history"][number];
type EndingWorkout = Details["ending"]["removes"][number];

const DraftWorkoutSchema = z.object({
  date: z.string().nullable().optional(),
  name: z.string().optional(),
  minutes: z.number().optional(),
});

const ChangeRowSchema = z.object({
  diff_json: z.string(),
  updated_at_ms: z.number(),
});

const EnvelopeSchema = z.object({
  title: z.string(),
  intent: z.unknown(),
  diff: z.array(
    z.object({ workoutId: z.string(), before: z.unknown(), after: z.unknown() }),
  ),
});

const KeepIntentSchema = z.object({
  kind: z.literal("keep-intervals-change"),
  planWorkoutId: z.string(),
});

const MoveIntentSchema = z.object({
  kind: z.literal("move-by-you"),
  moves: z
    .array(
      z.object({
        planWorkoutId: z.string(),
        fromDateKey: z.number().int(),
        toDateKey: z.number().int(),
      }),
    )
    .min(1),
});

function dateKeyOf(date: string | null | undefined): number | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  return Number(date.replaceAll("-", ""));
}

function historyEntry(
  row: z.infer<typeof ChangeRowSchema>,
  workouts: ReadonlyMap<string, PlanWorkoutRecord>,
): HistoryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.diff_json);
  } catch {
    return null;
  }
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return null;
  const atMs = row.updated_at_ms;
  const move = MoveIntentSchema.safeParse(envelope.data.intent);
  if (move.success) {
    const first = move.data.moves[0];
    if (first === undefined) return null;
    return {
      kind: "moved",
      atMs,
      name: workouts.get(first.planWorkoutId)?.name ?? envelope.data.title,
      fromDateKey: first.fromDateKey,
      toDateKey: first.toDateKey,
    };
  }
  const keep = KeepIntentSchema.safeParse(envelope.data.intent);
  if (keep.success) {
    const after = DraftWorkoutSchema.safeParse(envelope.data.diff[0]?.after);
    const dateKey = after.success ? dateKeyOf(after.data.date) : null;
    const minutes = after.success ? after.data.minutes : undefined;
    return {
      kind: "kept",
      atMs,
      dateKey: dateKey ?? workouts.get(keep.data.planWorkoutId)?.dateKey ?? null,
      durationS: minutes === undefined ? null : Math.round(minutes * 60),
    };
  }
  return { kind: "change", atMs, title: envelope.data.title };
}

function endingWorkout(
  entry: PlanCopyOnIcu,
  workouts: ReadonlyMap<string, PlanWorkoutRecord>,
): EndingWorkout {
  const workout = workouts.get(entry.planWorkoutId);
  return {
    planWorkoutId: entry.planWorkoutId,
    name: workout?.name ?? "",
    dateKey: entry.dateKey,
    durationS: workout?.durationS ?? null,
  };
}

export async function planDetails(
  deps: PlanCalendarDetailsDeps,
  request: { readonly planId: string },
): Promise<PlanCalendarRpcResult> {
  return deps.store.transaction(async () => {
    const plans = createLegacyPlanRepository(deps.store);
    const plan = await plans.read(request.planId);
    const active = await deps.store.get(
      "SELECT version, activated_at_ms FROM planning_plan WHERE plan_id=? AND status='active'",
      [request.planId],
    );
    if (
      plan === undefined ||
      typeof active?.version !== "number" ||
      typeof active.activated_at_ms !== "number"
    ) {
      return { status: "refused", reason: "no-active-plan" } as const;
    }
    const workouts = new Map(
      (await plans.readWorkouts(request.planId)).map((workout) => [workout.id, workout]),
    );
    const rows = await deps.store.all(
      "SELECT diff_json, updated_at_ms FROM plan_change WHERE plan_id=? AND status='applied' ORDER BY updated_at_ms DESC, result_revision_number DESC",
      [request.planId],
    );
    const history: HistoryEntry[] = [];
    for (const raw of rows) {
      const row = ChangeRowSchema.safeParse(raw);
      const entry = row.success ? historyEntry(row.data, workouts) : null;
      if (entry !== null) history.push(entry);
    }
    history.push({ kind: "saved", atMs: active.activated_at_ms });
    const copies = await readIcuCopies(createPlanCalendarMirrorRepository(deps.store), plan.id);
    const summary = planEndingSummary(
      [...copies.values()].map((record) => {
        const workout = workouts.get(record.planWorkoutId);
        return {
          planWorkoutId: record.planWorkoutId,
          dateKey: workout?.dateKey ?? record.dateKey,
          copy: storedIcuCopy(record),
        };
      }),
      deps.todayDateKey(),
    );
    return {
      status: "plan-details",
      planId: plan.id,
      version: active.version,
      history,
      ending: {
        removes: summary.removes.map((entry) => endingWorkout(entry, workouts)),
        staysToday: summary.staysToday.map((entry) => endingWorkout(entry, workouts)),
        athleteChanges: summary.athleteChanges.map((entry) => {
          const shown = icuFingerprintParts(entry.tick.fingerprint);
          const planned = endingWorkout(entry, workouts);
          return {
            ...planned,
            name: shown?.name ?? planned.name,
            durationS: shown?.durationS ?? planned.durationS,
            dateKey: entry.tick.dateKey,
            tick: entry.tick,
          };
        }),
      },
    } as const;
  });
}

export async function saveEndChoice(
  deps: PlanCalendarDetailsDeps,
  request: { readonly planId: string; readonly ticked: readonly TickedChange[] },
): Promise<PlanCalendarRpcResult> {
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const plan = await createLegacyPlanRepository(deps.store).read(request.planId);
  if (plan === undefined || plan.status !== "active") {
    return { status: "refused", reason: "no-active-plan" };
  }
  const current = await mirror.readDelivery(plan.id);
  const choice =
    request.ticked.length === 0
      ? { kind: "keep-them" as const }
      : { kind: "remove-them" as const, ticked: [...request.ticked] };
  if (current === undefined && choice.kind === "keep-them") return { status: "end-choice-saved" };
  const delivery = {
    kind: "approved" as const,
    firstSetWeeks: firstChangeSetWeeks(plan, deps.todayDateKey()),
    approvedWeeks: [],
  };
  await mirror.writeDelivery({
    planId: plan.id,
    stateKind: current?.stateKind ?? delivery.kind,
    stateJson: current?.stateJson ?? encodeWeekDelivery(delivery),
    closeChoiceJson: encodeCloseChoice(choice),
    updatedAtMs: deps.now(),
  });
  return { status: "end-choice-saved" };
}
