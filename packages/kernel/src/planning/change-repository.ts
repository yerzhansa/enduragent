import { z } from "zod";
import { canonicalJson } from "../archive/canonical.js";
import { createPlanningCommandLedger, fail, PlanCreationStoreError } from "./command-ledger.js";
import type { PlanCreationCommandStamp, PlanningCommandName } from "./command-ledger.js";
import type { PlanCreationStore } from "./creation-repository.js";
import { addCivilDays, dateKeyFromText } from "./date-keys.js";
import { createPlanRepository, validatePlanWorkoutRecord } from "./repository.js";
import type { PlanWorkoutRecord } from "./repository.js";

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const RevisionNumberSchema = z.number().int().positive();
const TotalsSchema = z.object({
  plan: z.number().nonnegative(),
  weeks: z.array(z.object({ number: RevisionNumberSchema, minutes: z.number().nonnegative() })),
});
export const PlanChangeEnvelopeSchema = z
  .object({
    title: z.string().min(1).max(20000),
    intent: z.json(),
    diff: z.array(z.object({ workoutId: z.string(), before: z.json(), after: z.json() })),
    totals: z.object({ before: TotalsSchema, after: TotalsSchema }),
    supersedes: UlidSchema.nullable(),
    premises: z.array(
      z.object({ id: z.string(), label: z.string(), source: z.string(), value: z.json() }),
    ),
    confidence: z.string(),
  })
  .strict();
export type PlanChangeEnvelope = z.infer<typeof PlanChangeEnvelopeSchema>;
export const PlanChangeRecordSchema = PlanChangeEnvelopeSchema.strip().extend({
  status: z.enum(["pending", "applied", "cancelled", "superseded", "stale"]),
  supersededBy: UlidSchema.nullable(),
  changeId: UlidSchema,
  planId: UlidSchema,
  baseRevisionNumber: RevisionNumberSchema,
  resultRevisionNumber: RevisionNumberSchema.nullable(),
});
export type PlanChangeRecord = z.infer<typeof PlanChangeRecordSchema>;
export const PlanChangePreviewStoreResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("previewed"),
      change: PlanChangeRecordSchema,
      version: RevisionNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["stale-version", "no-active-plan", "command-conflict", "invalid-intent"]),
    })
    .strict(),
]);
export const PlanChangeApplyStoreResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      changeId: UlidSchema,
      revisionNumber: RevisionNumberSchema,
      version: RevisionNumberSchema,
    })
    .strict(),
  z
    .object({ status: z.literal("cancelled"), changeId: UlidSchema, version: RevisionNumberSchema })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["stale-version", "not-pending", "no-active-plan", "command-conflict"]),
    })
    .strict(),
]);
export type PlanChangePreviewStoreResult = z.infer<typeof PlanChangePreviewStoreResultSchema>;
export type PlanChangeApplyStoreResult = z.infer<typeof PlanChangeApplyStoreResultSchema>;
export interface PreviewPlanChangeInput {
  readonly command: PlanCreationCommandStamp;
  readonly planId: string;
  readonly expectedVersion: number;
  readonly nowMs: number;
  readonly changeId: string;
  readonly build: (
    snapshotJson: string,
  ) =>
    | { readonly afterSnapshotJson: string; readonly envelope: PlanChangeEnvelope }
    | { readonly status: "rejected"; readonly reason: "invalid-intent" };
}
export interface PlanChangeWorkoutMutations {
  readonly insert: readonly PlanWorkoutRecord[];
  readonly update: readonly PlanWorkoutRecord[];
  readonly delete: readonly string[];
}
export interface ApplyPlanChangeInput {
  readonly command: PlanCreationCommandStamp;
  readonly planId: string;
  readonly changeId: string;
  readonly expectedVersion: number;
  readonly decision: "apply" | "cancel";
  readonly nowMs: number;
  readonly todayDateKey: number;
  readonly mirrorJobId: string;
  readonly materialize: (
    afterSnapshotJson: string,
    currentWorkouts: readonly PlanWorkoutRecord[],
    diffIds: ReadonlySet<string>,
  ) => PlanChangeWorkoutMutations;
}
export interface PlanChangeRepository {
  preview(input: PreviewPlanChangeInput): Promise<PlanChangePreviewStoreResult>;
  apply(input: ApplyPlanChangeInput): Promise<PlanChangeApplyStoreResult>;
  listChanges(planId: string): Promise<PlanChangeRecord[]>;
}
const ActiveRowSchema = z.object({
  plan_id: UlidSchema,
  version: RevisionNumberSchema,
  current_revision_number: RevisionNumberSchema,
});
const ChangeRowSchema = z.object({
  id: UlidSchema,
  plan_id: UlidSchema,
  status: z.enum(["preview", "applied", "stale", "discarded"]),
  base_revision_number: RevisionNumberSchema,
  result_revision_number: RevisionNumberSchema.nullable(),
  diff_json: z.string(),
  reconciliation_effect_json: z.string(),
  preview_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});
type ChangeRow = z.infer<typeof ChangeRowSchema>;
type Retirement =
  | { status: "cancelled"; supersededBy: null }
  | { status: "superseded"; supersededBy: string };
const ChangeCommandRowSchema = z.object({
  command_name: z.enum(["plan_change.apply", "plan_change.preview"]),
  result_json: z.string(),
});
const SnapshotSchema = z.object({
  weeks: z.array(
    z.object({
      workouts: z.array(
        z
          .object({
            id: z.string(),
            date: z.string().nullable(),
            name: z.string(),
            minutes: z.number(),
            pinned: z.boolean().optional(),
          })
          .passthrough(),
      ),
    }),
  ),
});
const DraftIdSchema = z.object({ id: z.string() }).passthrough();
const draftId = (workout: PlanWorkoutRecord) =>
  DraftIdSchema.parse(JSON.parse(workout.structureJson)).id;

export function createPlanChangeRepository(
  store: PlanCreationStore,
  dependencies: {
    readonly newId: () => string;
    readonly sha256: (text: string) => string | Promise<string>;
  },
): PlanChangeRepository {
  const { hasReplay, recordCommand } = createPlanningCommandLedger(store);
  const plans = createPlanRepository(store);
  const replay = async (name: PlanningCommandName, command: PlanCreationCommandStamp) => {
    try {
      const prior = await hasReplay(name, command);
      if (prior === undefined) return undefined;
      if (typeof prior.result_json !== "string") return fail();
      const result: unknown = JSON.parse(prior.result_json);
      return result;
    } catch (error) {
      if (error instanceof PlanCreationStoreError && error.code === "command-conflict")
        return { status: "rejected", reason: "command-conflict" };
      throw error;
    }
  };
  const readActive = async () => {
    const row = await store.get(
      "SELECT plan_id,version,current_revision_number FROM planning_plan WHERE status='active'",
    );
    return row === undefined ? null : ActiveRowSchema.parse(row);
  };
  const project = (
    row: ChangeRow,
    retirements: ReadonlyMap<string, Retirement>,
  ): PlanChangeRecord => {
    const envelope = PlanChangeEnvelopeSchema.parse(JSON.parse(row.diff_json));
    const state =
      row.status === "discarded"
        ? (retirements.get(row.id) ?? fail())
        : { status: row.status === "preview" ? "pending" : row.status, supersededBy: null };
    return PlanChangeRecordSchema.parse({
      ...envelope,
      ...state,
      changeId: row.id,
      planId: row.plan_id,
      baseRevisionNumber: row.base_revision_number,
      resultRevisionNumber: row.result_revision_number,
    });
  };
  const retire = async (
    row: ChangeRow,
    input: { command: PlanCreationCommandStamp; nowMs: number },
  ) => {
    await store.run(
      `UPDATE plan_change SET status='discarded',version=version+1,terminal_at_ms=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='preview'`,
      [
        input.nowMs,
        input.nowMs,
        input.command.deviceId,
        input.command.hlcPhysicalMs,
        input.command.hlcCounter,
        row.id,
      ],
    );
  };
  const writeWorkouts = async (
    input: ApplyPlanChangeInput,
    change: ChangeRow,
    afterSnapshotJson: string,
  ) => {
    const plan = await plans.read(input.planId);
    if (plan === undefined) return fail();
    const current = await plans.readWorkouts(input.planId);
    const revision = z
      .object({ snapshot_json: z.string() })
      .parse(
        await store.get(
          "SELECT snapshot_json FROM plan_revision WHERE plan_id=? AND revision_number=?",
          [input.planId, change.base_revision_number],
        ),
      );
    const baseWorkouts = SnapshotSchema.parse(JSON.parse(revision.snapshot_json)).weeks.flatMap(
      (week) => week.workouts,
    );
    const afterWorkouts = SnapshotSchema.parse(JSON.parse(afterSnapshotJson)).weeks.flatMap(
      (week) => week.workouts,
    );
    const afterById = new Map(afterWorkouts.map((workout) => [workout.id, workout]));
    const baseIds = new Set(baseWorkouts.map((workout) => workout.id));
    const changedWorkouts = baseWorkouts.filter(
      (workout) => canonicalJson(workout) !== canonicalJson(afterById.get(workout.id) ?? null),
    );
    const diffIds = new Set([
      ...changedWorkouts.map((workout) => workout.id),
      ...afterWorkouts.filter((workout) => !baseIds.has(workout.id)).map((workout) => workout.id),
    ]);
    const completedRows = await store.all(
      "SELECT plan_workout_id FROM plan_workout_match WHERE plan_id=? AND decision='confirmed'",
      [input.planId],
    );
    const completedWorkoutIds = new Set(
      completedRows.map((row) => z.string().parse(row.plan_workout_id)),
    );
    const currentByDraftId = new Map(current.map((workout) => [draftId(workout), workout]));
    for (const workout of changedWorkouts) {
      const row = currentByDraftId.get(workout.id);
      if (
        workout.pinned ||
        workout.date === null ||
        dateKeyFromText(workout.date) < input.todayDateKey ||
        (row !== undefined && completedWorkoutIds.has(row.id))
      )
        return false;
    }
    for (const workout of baseWorkouts) {
      if (!diffIds.has(workout.id)) continue;
      const row = currentByDraftId.get(workout.id);
      if (
        row === undefined
          ? workout.date !== null
          : workout.date === null ||
            row.name !== workout.name ||
            row.durationS !== workout.minutes * 60 ||
            row.dateKey !== dateKeyFromText(workout.date) ||
            canonicalJson(JSON.parse(row.structureJson)) !== canonicalJson(workout)
      )
        return false;
    }
    const mutations = input.materialize(afterSnapshotJson, current, diffIds);
    const byId = new Map(current.map((workout) => [workout.id, workout]));
    const byDraftId = new Map(current.map((workout) => [draftId(workout), workout.id]));
    const touched = new Set<string>();
    const next = new Map(byId);
    for (const id of mutations.delete) {
      if (!byId.has(id) || touched.has(id) || !diffIds.has(draftId(byId.get(id) ?? fail())))
        return fail();
      touched.add(id);
      next.delete(id);
    }
    for (const [operation, rows] of [
      ["insert", mutations.insert],
      ["update", mutations.update],
    ] as const) {
      for (const workout of rows) {
        validatePlanWorkoutRecord(plan, workout);
        if (!diffIds.has(draftId(workout))) return fail();
        if (touched.has(workout.id) || (operation === "insert") === byId.has(workout.id))
          return fail();
        const existingId = byDraftId.get(draftId(workout));
        if (existingId !== undefined && existingId !== workout.id) return fail();
        if (operation === "update" && draftId(byId.get(workout.id) ?? fail()) !== draftId(workout))
          return fail();
        touched.add(workout.id);
        next.set(workout.id, workout);
      }
    }
    const datedIds = SnapshotSchema.parse(JSON.parse(afterSnapshotJson)).weeks.flatMap((week) =>
      week.workouts.filter((workout) => workout.date !== null).map((workout) => workout.id),
    );
    const nextIds = [...next.values()].map(draftId);
    if (
      new Set(datedIds).size !== datedIds.length ||
      new Set(nextIds).size !== nextIds.length ||
      datedIds.length !== nextIds.length ||
      datedIds.some((id) => !nextIds.includes(id))
    )
      return fail();
    for (const id of mutations.delete)
      await store.run("DELETE FROM plan_workout WHERE id=? AND plan_id=?", [id, input.planId]);
    for (const workout of mutations.update) {
      await store.run(
        `UPDATE plan_workout SET date_key=?,sport=?,name=?,duration_s=?,structure_json=?,origin=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=? AND plan_id=?`,
        [
          workout.dateKey,
          workout.sport,
          workout.name,
          workout.durationS,
          workout.structureJson,
          workout.origin,
          workout.deviceId,
          workout.hlcPhysicalMs,
          workout.hlcCounter,
          workout.id,
          input.planId,
        ],
      );
    }
    for (const workout of mutations.insert) {
      await store.run(
        `INSERT INTO plan_workout (id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          workout.id,
          workout.planId,
          workout.dateKey,
          workout.sport,
          workout.name,
          workout.durationS,
          workout.structureJson,
          workout.origin,
          workout.deviceId,
          workout.hlcPhysicalMs,
          workout.hlcCounter,
        ],
      );
    }
    return true;
  };
  return {
    async preview(input) {
      return store.transaction(async () => {
        const prior = await replay("plan_change.preview", input.command);
        if (prior !== undefined) return PlanChangePreviewStoreResultSchema.parse(prior);
        const active = await readActive();
        if (active === null) return { status: "rejected", reason: "no-active-plan" };
        if (active.plan_id !== input.planId || active.version !== input.expectedVersion)
          return { status: "rejected", reason: "stale-version" };
        const revision = z
          .object({ snapshot_json: z.string() })
          .parse(
            await store.get(
              "SELECT snapshot_json FROM plan_revision WHERE plan_id=? AND revision_number=?",
              [input.planId, active.current_revision_number],
            ),
          );
        const built = input.build(revision.snapshot_json);
        if ("status" in built) return built;
        const afterSnapshotJson = canonicalJson(JSON.parse(built.afterSnapshotJson));
        const fingerprint = await dependencies.sha256(afterSnapshotJson);
        const previous = await store.get(
          "SELECT * FROM plan_change WHERE plan_id=? AND status='preview'",
          [input.planId],
        );
        const previousRow = previous === undefined ? null : ChangeRowSchema.parse(previous);
        const envelope = PlanChangeEnvelopeSchema.parse({
          ...PlanChangeEnvelopeSchema.parse(JSON.parse(canonicalJson(built.envelope))),
          supersedes: previousRow?.id ?? null,
        });
        if (previousRow !== null) await retire(previousRow, input);
        await store.run(
          `INSERT INTO plan_change (id,plan_id,status,version,base_revision_number,result_revision_number,diff_json,rationale,premises_json,preview_fingerprint,reconciliation_effect_json,created_at_ms,updated_at_ms,terminal_at_ms,device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,'preview',1,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?)`,
          [
            input.changeId,
            input.planId,
            active.current_revision_number,
            canonicalJson(envelope),
            envelope.title,
            canonicalJson(envelope.premises),
            fingerprint,
            canonicalJson({ afterSnapshotJson }),
            input.nowMs,
            input.nowMs,
            input.command.deviceId,
            input.command.hlcPhysicalMs,
            input.command.hlcCounter,
          ],
        );
        const result = PlanChangePreviewStoreResultSchema.parse({
          status: "previewed",
          change: {
            ...envelope,
            status: "pending",
            supersededBy: null,
            changeId: input.changeId,
            planId: input.planId,
            baseRevisionNumber: active.current_revision_number,
            resultRevisionNumber: null,
          },
          version: active.version,
        });
        await recordCommand(
          "plan_change.preview",
          input.command,
          { planId: input.planId, planChangeId: input.changeId },
          result,
        );
        return result;
      });
    },
    async apply(input) {
      return store.transaction(async () => {
        const prior = await replay("plan_change.apply", input.command);
        if (prior !== undefined) return PlanChangeApplyStoreResultSchema.parse(prior);
        const active = await readActive();
        if (active === null) return { status: "rejected", reason: "no-active-plan" };
        if (active.plan_id !== input.planId || active.version !== input.expectedVersion)
          return { status: "rejected", reason: "stale-version" };
        const raw = await store.get("SELECT * FROM plan_change WHERE id=? AND plan_id=?", [
          input.changeId,
          input.planId,
        ]);
        if (raw === undefined) return { status: "rejected", reason: "not-pending" };
        const change = ChangeRowSchema.parse(raw);
        if (
          change.status !== "preview" ||
          change.base_revision_number !== active.current_revision_number
        )
          return { status: "rejected", reason: "not-pending" };
        let result: PlanChangeApplyStoreResult;
        if (input.decision === "cancel") {
          await retire(change, input);
          result = { status: "cancelled", changeId: input.changeId, version: active.version };
        } else {
          const { afterSnapshotJson } = z
            .object({ afterSnapshotJson: z.string() })
            .parse(JSON.parse(change.reconciliation_effect_json));
          if (!(await writeWorkouts(input, change, afterSnapshotJson)))
            return { status: "rejected", reason: "stale-version" };
          const revisionNumber = active.current_revision_number + 1;
          await store.run(
            `INSERT INTO plan_revision (id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,?,?,'plan-change',?,?,?,?,?,?,?)`,
            [
              dependencies.newId(),
              input.planId,
              revisionNumber,
              active.current_revision_number,
              input.changeId,
              afterSnapshotJson,
              change.preview_fingerprint,
              input.nowMs,
              input.command.deviceId,
              input.command.hlcPhysicalMs,
              input.command.hlcCounter,
            ],
          );
          await store.run(
            `UPDATE planning_plan SET version=version+1,current_revision_number=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE plan_id=? AND status='active' AND version=?`,
            [
              revisionNumber,
              input.nowMs,
              input.command.deviceId,
              input.command.hlcPhysicalMs,
              input.command.hlcCounter,
              input.planId,
              input.expectedVersion,
            ],
          );
          await store.run(
            "UPDATE plan SET updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=?",
            [
              input.nowMs,
              input.command.deviceId,
              input.command.hlcPhysicalMs,
              input.command.hlcCounter,
              input.planId,
            ],
          );
          const windowEnd = addCivilDays(input.todayDateKey, 6);
          await store.run(
            `INSERT INTO plan_reconciliation_job (
            id,plan_id,kind,status,window_start_date_key,window_end_date_key,
            attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
            created_at_ms,updated_at_ms,completed_at_ms
            ) VALUES (?,?,'mirror','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
            ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
            [
              input.mirrorJobId,
              input.planId,
              input.todayDateKey,
              windowEnd,
              input.nowMs,
              input.nowMs,
            ],
          );
          const job = z.object({ id: UlidSchema }).parse(
            await store.get(
              `SELECT id FROM plan_reconciliation_job
              WHERE plan_id=? AND kind='mirror' AND window_start_date_key=? AND window_end_date_key=?`,
              [input.planId, input.todayDateKey, windowEnd],
            ),
          );
          await store.run(
            `DELETE FROM plan_reconciliation_item
            WHERE job_id=? AND (operation='delete' OR (operation='create' AND (
              plan_workout_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM plan_workout WHERE id=plan_workout_id
                  AND origin='coach' AND date_key BETWEEN ? AND ?
              )
            )))`,
            [job.id, input.todayDateKey, windowEnd],
          );
          await store.run(
            `UPDATE plan_reconciliation_job SET status='pending',last_error_code=NULL,
            completed_at_ms=NULL,updated_at_ms=? WHERE id=?`,
            [input.nowMs, job.id],
          );
          result = {
            status: "applied",
            changeId: input.changeId,
            revisionNumber,
            version: active.version + 1,
          };
        }
        await recordCommand(
          "plan_change.apply",
          input.command,
          { planId: input.planId, planChangeId: input.changeId },
          result,
        );
        return result;
      });
    },
    async listChanges(planId) {
      return store.transaction(async () => {
        const rows = await store.all(
          "SELECT * FROM plan_change WHERE plan_id=? ORDER BY status='preview',created_at_ms,id",
          [planId],
        );
        const commands = await store.all(
          "SELECT command_name,result_json FROM planning_command WHERE json_extract(aggregate_refs_json,'$.planId')=? AND command_name IN ('plan_change.apply','plan_change.preview') AND status='succeeded'",
          [planId],
        );
        const retirements = new Map<string, Retirement>();
        for (const raw of commands) {
          const command = ChangeCommandRowSchema.parse(raw);
          if (command.command_name === "plan_change.apply") {
            const result = PlanChangeApplyStoreResultSchema.parse(JSON.parse(command.result_json));
            if (result.status === "cancelled")
              retirements.set(result.changeId, { status: "cancelled", supersededBy: null });
          } else {
            const result = PlanChangePreviewStoreResultSchema.parse(
              JSON.parse(command.result_json),
            );
            if (result.status === "previewed" && result.change.supersedes !== null)
              retirements.set(result.change.supersedes, {
                status: "superseded",
                supersededBy: result.change.changeId,
              });
          }
        }
        return rows.map((row) => project(ChangeRowSchema.parse(row), retirements));
      });
    },
  };
}
