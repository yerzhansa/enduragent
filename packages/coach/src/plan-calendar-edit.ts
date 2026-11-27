import {
  PlanCreationDraftSchema,
  type PlanChangeApplyResult,
  type PlanChangeApplyRpcParams,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createPlanChangeRepository, type PlanChangeEnvelope } from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";

export interface WorkoutEdit {
  readonly planWorkoutId: string;
  readonly dateKey: number;
  readonly name?: string;
  readonly minutes?: number;
}

export interface PlanCalendarEditDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly identity: {
    newUlid(): string;
    hlcStamp(): { readonly physicalMs: number; readonly counter: number };
    deviceId(): Promise<string>;
  };
  readonly applyChange: (request: PlanChangeApplyRpcParams) => Promise<PlanChangeApplyResult>;
}

type Draft = ReturnType<typeof PlanCreationDraftSchema.parse>;
type DraftWorkout = Draft["weeks"][number]["workouts"][number];
type DiffEntry = { workoutId: string; before: DraftWorkout; after: DraftWorkout };

function civilDate(dateKey: number): string {
  const text = String(dateKey).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function draftIdOf(structureJson: string): string | null {
  try {
    const value: unknown = JSON.parse(structureJson);
    if (value === null || typeof value !== "object" || !("id" in value)) return null;
    return typeof value.id === "string" ? value.id : null;
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function totals(draft: Draft) {
  const weeks = draft.weeks.map((week) => ({
    number: week.number,
    minutes: week.workouts.reduce((sum, workout) => sum + workout.minutes, 0),
  }));
  return { plan: weeks.reduce((sum, week) => sum + week.minutes, 0), weeks };
}

function edited(
  draft: Draft,
  edits: ReadonlyMap<string, WorkoutEdit>,
): {
  readonly after: Draft;
  readonly diff: DiffEntry[];
} | null {
  const after: Draft = structuredClone(draft);
  const diff: DiffEntry[] = [];
  for (const [draftId, edit] of edits) {
    const from = after.weeks.find((week) =>
      week.workouts.some((workout) => workout.id === draftId),
    );
    const before = from?.workouts.find((workout) => workout.id === draftId);
    const date = civilDate(edit.dateKey);
    const into = after.weeks.find((week) => date >= week.start && date <= week.end);
    if (from === undefined || before === undefined || into === undefined) return null;
    const changed = {
      ...before,
      date,
      name: edit.name ?? before.name,
      minutes:
        edit.minutes === undefined ? before.minutes : Math.max(1, Math.min(1440, edit.minutes)),
    };
    from.workouts = from.workouts.filter((workout) => workout.id !== draftId);
    into.workouts = [...into.workouts, changed].sort((left, right) =>
      (left.date ?? "").localeCompare(right.date ?? ""),
    );
    if (into.workouts.length > 6) return null;
    diff.push({ workoutId: draftId, before, after: changed });
  }
  return { after, diff };
}

export async function applyWorkoutEdits(
  deps: PlanCalendarEditDeps,
  input: {
    readonly planId: string;
    readonly title: string;
    readonly intent: PlanChangeEnvelope["intent"];
    readonly edits: readonly WorkoutEdit[];
  },
): Promise<"applied" | "refused"> {
  const active = await deps.store.get(
    "SELECT version FROM planning_plan WHERE plan_id=? AND status='active'",
    [input.planId],
  );
  if (typeof active?.version !== "number") return "refused";
  const workouts = await createLegacyPlanRepository(deps.store).readWorkouts(input.planId);
  const byDraftId = new Map<string, WorkoutEdit>();
  for (const edit of input.edits) {
    const workout = workouts.find((row) => row.id === edit.planWorkoutId);
    const draftId = workout === undefined ? null : draftIdOf(workout.structureJson);
    if (draftId === null) return "refused";
    byDraftId.set(draftId, edit);
  }
  const clock = deps.identity.hlcStamp();
  const commandId = deps.identity.newUlid();
  const repository = createPlanChangeRepository(deps.store, {
    newId: () => deps.identity.newUlid(),
    sha256,
  });
  const preview = await repository.preview({
    command: {
      commandId,
      requestDigest: await sha256(canonicalJson({ commandId, edits: input.edits })),
      nowMs: clock.physicalMs,
      deviceId: await deps.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    },
    planId: input.planId,
    expectedVersion: active.version,
    nowMs: clock.physicalMs,
    changeId: deps.identity.newUlid(),
    build({ snapshotJson }) {
      const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
      const result = edited(draft, byDraftId);
      if (result === null) return { status: "rejected", reason: "invalid-intent" };
      return {
        afterSnapshotJson: JSON.stringify(result.after),
        envelope: {
          title: input.title,
          intent: input.intent,
          diff: result.diff,
          totals: { before: totals(draft), after: totals(result.after) },
          supersedes: null,
          premises: [],
          confidence: "Confirmed update",
        },
      };
    },
  });
  if (preview.status !== "previewed") return "refused";
  const applied = await deps.applyChange({
    commandId: deps.identity.newUlid(),
    planId: input.planId,
    changeId: preview.change.changeId,
    expectedVersion: active.version,
    decision: "apply",
  });
  return applied.status === "applied" ? "applied" : "refused";
}
