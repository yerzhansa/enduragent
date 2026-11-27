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
  applied_at_ms: z.number(),
});

const NAME_LIMIT = 512;
const HISTORY_LIMIT = 499;

const EnvelopeSchema = z.object({
  title: z.string(),
  intent: z.unknown(),
  diff: z.array(z.object({ workoutId: z.string(), before: z.unknown(), after: z.unknown() })),
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

function shortName(name: string): string {
  return name.slice(0, NAME_LIMIT);
}

function historyEntries(
  row: z.infer<typeof ChangeRowSchema>,
  workouts: ReadonlyMap<string, PlanWorkoutRecord>,
): HistoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.diff_json);
  } catch {
    return [];
  }
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return [];
  const atMs = row.applied_at_ms;
  const move = MoveIntentSchema.safeParse(envelope.data.intent);
  if (move.success) {
    return move.data.moves.map((entry) => ({
      kind: "moved" as const,
      atMs,
      name: shortName(workouts.get(entry.planWorkoutId)?.name ?? envelope.data.title),
      fromDateKey: entry.fromDateKey,
      toDateKey: entry.toDateKey,
    }));
  }
  const keep = KeepIntentSchema.safeParse(envelope.data.intent);
  if (keep.success) {
    const after = DraftWorkoutSchema.safeParse(envelope.data.diff[0]?.after);
    const dateKey = after.success ? dateKeyOf(after.data.date) : null;
    const minutes = after.success ? after.data.minutes : undefined;
    return [
      {
        kind: "kept",
        atMs,
        dateKey: dateKey ?? workouts.get(keep.data.planWorkoutId)?.dateKey ?? null,
        durationS: minutes === undefined ? null : Math.round(minutes * 60),
      },
    ];
  }
  return [{ kind: "change", atMs, title: envelope.data.title }];
}

function endingWorkout(
  entry: PlanCopyOnIcu,
  workouts: ReadonlyMap<string, PlanWorkoutRecord>,
): EndingWorkout {
  const workout = workouts.get(entry.planWorkoutId);
  return {
    planWorkoutId: entry.planWorkoutId,
    name: shortName(workout?.name ?? ""),
    dateKey: entry.dateKey,
    durationS: workout?.durationS ?? null,
  };
}

export async function planEndingView(
  store: SqlStore & Pick<MigratorStore, "transaction">,
  planId: string,
  closedOnDateKey: number,
): Promise<Details["ending"]> {
  const workouts = new Map(
    (await createLegacyPlanRepository(store).readWorkouts(planId)).map((workout) => [
      workout.id,
      workout,
    ]),
  );
  const copies = await readIcuCopies(createPlanCalendarMirrorRepository(store), planId);
  const summary = planEndingSummary(
    [...copies.values()].map((record) => {
      const workout = workouts.get(record.planWorkoutId);
      return {
        planWorkoutId: record.planWorkoutId,
        dateKey: workout?.dateKey ?? record.dateKey,
        copy: storedIcuCopy(record),
      };
    }),
    closedOnDateKey,
  );
  return {
    removes: summary.removes.map((entry) => endingWorkout(entry, workouts)),
    staysToday: summary.staysToday.map((entry) => endingWorkout(entry, workouts)),
    athleteChanges: summary.athleteChanges.map((entry) => {
      const shown = icuFingerprintParts(entry.tick.fingerprint);
      const planned = endingWorkout(entry, workouts);
      return {
        ...planned,
        name: shortName(shown?.name ?? planned.name),
        durationS: shown?.durationS ?? planned.durationS,
        dateKey: entry.tick.dateKey,
        tick: entry.tick,
      };
    }),
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
      `SELECT diff_json, terminal_at_ms AS applied_at_ms FROM plan_change
      WHERE plan_id=? AND status='applied' ORDER BY result_revision_number DESC LIMIT ?`,
      [request.planId, HISTORY_LIMIT],
    );
    const history: HistoryEntry[] = [];
    for (const raw of rows) {
      const row = ChangeRowSchema.safeParse(raw);
      if (row.success) history.push(...historyEntries(row.data, workouts));
    }
    history.splice(HISTORY_LIMIT);
    history.push({ kind: "saved", atMs: active.activated_at_ms });
    return {
      status: "plan-details",
      planId: plan.id,
      version: active.version,
      history,
      ending: await planEndingView(deps.store, plan.id, deps.todayDateKey()),
    } as const;
  });
}

export async function saveEndChoice(
  deps: PlanCalendarDetailsDeps,
  request: {
    readonly planId: string;
    readonly commandId: string;
    readonly ticked: readonly TickedChange[];
  },
): Promise<PlanCalendarRpcResult> {
  return deps.store.transaction(async () => {
    const mirror = createPlanCalendarMirrorRepository(deps.store);
    const plan = await createLegacyPlanRepository(deps.store).read(request.planId);
    const active = await deps.store.get(
      "SELECT plan_id FROM planning_plan WHERE plan_id=? AND status='active'",
      [request.planId],
    );
    if (plan === undefined || active === undefined) {
      return { status: "refused", reason: "no-active-plan" } as const;
    }
    const current = await mirror.readDelivery(plan.id);
    const choice =
      request.ticked.length === 0
        ? { kind: "keep-them" as const }
        : { kind: "remove-them" as const, ticked: [...request.ticked] };
    if (current === undefined && choice.kind === "keep-them") {
      return { status: "end-choice-saved" } as const;
    }
    const delivery = {
      kind: "approved" as const,
      firstSetWeeks: firstChangeSetWeeks(plan, deps.todayDateKey()),
      approvedWeeks: [],
    };
    await mirror.writeDelivery({
      planId: plan.id,
      stateKind: current?.stateKind ?? delivery.kind,
      stateJson: current?.stateJson ?? encodeWeekDelivery(delivery),
      closeChoiceJson:
        choice.kind === "keep-them"
          ? encodeCloseChoice(choice)
          : JSON.stringify({ ...choice, commandId: request.commandId }),
      updatedAtMs: deps.now(),
    });
    return { status: "end-choice-saved" } as const;
  });
}
