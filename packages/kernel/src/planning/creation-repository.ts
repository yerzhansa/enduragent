import {
  validatePlanRecord,
  validatePlanWorkoutRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "./repository.js";
import {
  createPlanningCommandLedger,
  fail,
  PlanCreationStoreError,
  type PlanCreationCommandStamp,
} from "./command-ledger.js";
export {
  PlanCreationStoreError,
  type PlanCreationErrorCode,
  type PlanCreationCommandStamp,
} from "./command-ledger.js";
import { canonicalJson } from "../archive/canonical.js";
import { addCivilDays } from "./date-keys.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { z } from "zod";

export type PlanCreationStore = SqlStore & Pick<MigratorStore, "transaction">;
export const PlanCreationSeedV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventCandidates: z
      .array(
        z
          .object({
            candidateId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
            name: z.string().min(1).max(512),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            sourceLabel: z.string().min(1).max(128),
          })
          .strict()
          .readonly(),
      )
      .max(10)
      .readonly(),
  })
  .strict()
  .readonly();
export type PlanCreationSeedV1 = z.infer<typeof PlanCreationSeedV1Schema>;

const PlanCreationAnswerRecordSchema = z
  .object({
    id: z.string(),
    sequence: z.number().int().positive(),
    creationVersion: z.number().int().positive(),
    answerKey: z.string(),
    valueJson: z.string(),
    confirmedAtMs: z.number().int().nonnegative(),
  })
  .readonly();
export type PlanCreationAnswerRecord = z.infer<typeof PlanCreationAnswerRecordSchema>;

const PlanCreationDraftRevisionSchema = z
  .object({
    revisionNumber: z.number().int().positive(),
    parentRevisionNumber: z.number().int().positive().nullable(),
    inputVersion: z.number().int().positive(),
    inputSnapshotJson: z.string(),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    outputSnapshotJson: z.string(),
    builderId: z.string().min(1),
    builderVersion: z.string().min(1),
    activationFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .readonly();
export type PlanCreationDraftRevision = z.infer<typeof PlanCreationDraftRevisionSchema>;

const PlanCreationSnapshotSchema = z
  .object({
    id: z.string(),
    status: z.enum(["in-progress", "review", "activated", "discarded"]),
    version: z.number().int().positive(),
    seed: PlanCreationSeedV1Schema.nullable(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    answers: z.array(PlanCreationAnswerRecordSchema).readonly(),
    currentDraft: PlanCreationDraftRevisionSchema.nullable(),
  })
  .readonly();
export type PlanCreationSnapshot = z.infer<typeof PlanCreationSnapshotSchema>;

export interface StartPlanCreationInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly seed: PlanCreationSeedV1;
}

export interface RecordPlanCreationAnswerInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly answerId: string;
  readonly answerKey: string;
  readonly valueJson: string;
}

export interface RecordPlanCreationDraftInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly draftId: string;
  readonly inputSnapshotJson: string;
  readonly inputFingerprint: string;
  readonly outputSnapshotJson: string;
  readonly builderId: string;
  readonly builderVersion: string;
  readonly activationFingerprint: string;
}

export interface DiscardPlanCreationInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
}

export const PlanCreationActivationResultSchema = z
  .object({
    creationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    planId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    closedPlanId: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
      .nullable(),
    activatedAt: z.iso.date(),
  })
  .strict();
export type PlanCreationActivationResult = z.infer<typeof PlanCreationActivationResultSchema>;

export interface ActivatePlanCreationInput extends DiscardPlanCreationInput {
  readonly incumbent: { readonly planId: string; readonly version: number } | null;
  readonly activatedAt: string;
  readonly todayDateKey: number;
  readonly mirrorJobId: string;
  readonly cleanupJobId: string;
  readonly revisionId: string;
  readonly materialize: (snapshot: PlanCreationSnapshot) => {
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
  };
}

const ActivationDraftSchema = z.object({
  weeks: z.array(z.object({ workouts: z.array(z.unknown()) })),
  outputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export interface PlanCreationRepository {
  activate(input: ActivatePlanCreationInput): Promise<PlanCreationActivationResult>;
  readUnfinished(): Promise<PlanCreationSnapshot | undefined>;
  start(input: StartPlanCreationInput): Promise<{
    outcome: "created" | "resumed" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  recordAnswer(input: RecordPlanCreationAnswerInput): Promise<{
    outcome: "recorded" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  replayDraft(command: PlanCreationCommandStamp): Promise<PlanCreationSnapshot | undefined>;
  recordDraft(input: RecordPlanCreationDraftInput): Promise<{
    outcome: "recorded" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  discard(input: DiscardPlanCreationInput): Promise<{
    outcome: "discarded";
  }>;
}

const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};
const integer = (row: Row, key: string): number => {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fail();
};
const json = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return fail();
  }
};
const parseSeed = (value: unknown): PlanCreationSeedV1 => {
  const parsed = PlanCreationSeedV1Schema.safeParse(value);
  return parsed.success ? parsed.data : fail();
};

export function createPlanCreationRepository(store: PlanCreationStore): PlanCreationRepository {
  const { hasReplay, recordCommand } = createPlanningCommandLedger(store);
  const readSnapshot = async (row: Row): Promise<PlanCreationSnapshot> => {
    const id = text(row, "id");
    const status = text(row, "status");
    if (
      status !== "in-progress" &&
      status !== "review" &&
      status !== "activated" &&
      status !== "discarded"
    )
      return fail();
    const seedJson = row.seed_json;
    const seed =
      seedJson === null ? null : typeof seedJson === "string" ? parseSeed(json(seedJson)) : fail();
    const answers = await store.all(
      "SELECT * FROM plan_creation_answer WHERE creation_id=? ORDER BY sequence,id",
      [id],
    );
    const revisionNumber = row.current_draft_revision_number;
    let currentDraft: PlanCreationDraftRevision | null = null;
    if (revisionNumber !== null) {
      const draft = await store.get(
        "SELECT * FROM plan_creation_draft_revision WHERE creation_id=? AND revision_number=?",
        [id, integer(row, "current_draft_revision_number")],
      );
      if (draft === undefined) return fail();
      const parsed = PlanCreationDraftRevisionSchema.safeParse({
        revisionNumber: draft.revision_number,
        parentRevisionNumber: draft.parent_revision_number,
        inputVersion: draft.input_version,
        inputSnapshotJson: draft.input_snapshot_json,
        inputFingerprint: draft.input_fingerprint,
        outputSnapshotJson: draft.output_snapshot_json,
        builderId: draft.builder_id,
        builderVersion: draft.builder_version,
        activationFingerprint: draft.activation_fingerprint,
      });
      if (!parsed.success) return fail();
      currentDraft = parsed.data;
      json(currentDraft.inputSnapshotJson);
      json(currentDraft.outputSnapshotJson);
    }
    return {
      id,
      status,
      version: integer(row, "version"),
      seed,
      currentDraft,
      createdAtMs: integer(row, "created_at_ms"),
      updatedAtMs: integer(row, "updated_at_ms"),
      answers: answers.map((answer) => {
        const valueJson = text(answer, "value_json");
        json(valueJson);
        return {
          id: text(answer, "id"),
          sequence: integer(answer, "sequence"),
          creationVersion: integer(answer, "creation_version"),
          answerKey: text(answer, "answer_key"),
          valueJson,
          confirmedAtMs: integer(answer, "confirmed_at_ms"),
        };
      }),
    };
  };
  const readUnfinished = async (): Promise<PlanCreationSnapshot | undefined> => {
    const rows = await store.all(
      "SELECT * FROM plan_creation WHERE status IN ('in-progress','review') ORDER BY created_at_ms,id",
    );
    if (rows.length > 1) fail();
    const row = rows[0];
    return row === undefined ? undefined : readSnapshot(row);
  };
  const requireUnfinished = async () => {
    const snapshot = await readUnfinished();
    if (snapshot === undefined) throw new PlanCreationStoreError("missing-creation");
    return snapshot;
  };
  const replay = async (
    name: "plan_creation.start" | "plan_creation.answer",
    command: PlanCreationCommandStamp,
  ) => {
    const commandRow = await hasReplay(name, command);
    if (commandRow === undefined) return undefined;
    const parsed = z
      .object({ creationId: z.string() })
      .safeParse(json(text(commandRow, "result_json")));
    if (!parsed.success) return fail();
    const row = await store.get("SELECT * FROM plan_creation WHERE id=?", [parsed.data.creationId]);
    return row === undefined ? fail() : readSnapshot(row);
  };
  const replayDraft = async (command: PlanCreationCommandStamp) => {
    const row = await hasReplay("plan_creation.preview", command);
    if (row === undefined) return undefined;
    const parsed = PlanCreationSnapshotSchema.safeParse(json(text(row, "result_json")));
    return parsed.success ? parsed.data : fail();
  };
  return {
    readUnfinished,
    replayDraft,
    async start({ command, creationId, seed }) {
      return store.transaction(async () => {
        const prior = await replay("plan_creation.start", command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        let snapshot = await readUnfinished();
        const outcome = snapshot ? "resumed" : "created";
        if (!snapshot) {
          await store.run(
            `INSERT INTO plan_creation (
id,status,version,seed_json,current_draft_revision_number,activated_plan_id,created_at_ms,updated_at_ms,
terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, 'in-progress', 1, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
            [
              creationId,
              canonicalJson(seed),
              command.nowMs,
              command.nowMs,
              command.deviceId,
              command.hlcPhysicalMs,
              command.hlcCounter,
            ],
          );
          await store.run(
            `UPDATE planning_authority
SET chat_authority_since_ms = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ?
WHERE singleton = 1 AND chat_authority_since_ms IS NULL`,
            [command.nowMs, command.deviceId, command.hlcPhysicalMs, command.hlcCounter],
          );
          snapshot = await requireUnfinished();
        }
        await recordCommand(
          "plan_creation.start",
          command,
          { creationId: snapshot.id },
          {
            creationId: snapshot.id,
            outcome,
            version: snapshot.version,
          },
        );
        return { outcome, snapshot };
      });
    },
    async recordAnswer({ command, creationId, expectedVersion, answerId, answerKey, valueJson }) {
      return store.transaction(async () => {
        const prior = await replay("plan_creation.answer", command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        const current = await requireUnfinished();
        if (current.id !== creationId) throw new PlanCreationStoreError("missing-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const version = expectedVersion + 1;
        await store.run(
          `INSERT INTO plan_creation_answer (
id,creation_id,sequence,creation_version,answer_key,value_json,scope,preference_id,confirmed_at_ms,
device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, 'plan-creation', NULL, ?, ?, ?, ?)`,
          [
            answerId,
            creationId,
            current.answers.length + 1,
            version,
            answerKey,
            valueJson,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_creation SET version=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            version,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        const snapshot = await requireUnfinished();
        if (snapshot.id !== creationId || snapshot.version !== version)
          throw new PlanCreationStoreError("stale-version");
        await recordCommand(
          "plan_creation.answer",
          command,
          { creationId },
          {
            creationId,
            answerId,
            version: snapshot.version,
          },
        );
        return { outcome: "recorded", snapshot };
      });
    },
    async recordDraft(input) {
      const { command, creationId, expectedVersion } = input;
      return store.transaction(async () => {
        const prior = await replayDraft(command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        const current = await readUnfinished();
        if (current === undefined || current.id !== creationId)
          throw new PlanCreationStoreError("no-unfinished-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const parentRevisionNumber = current.currentDraft?.revisionNumber ?? null;
        const revisionNumber = (parentRevisionNumber ?? 0) + 1;
        await store.run(
          `INSERT INTO plan_creation_draft_revision (
id,creation_id,revision_number,parent_revision_number,input_version,input_snapshot_json,
input_fingerprint,builder_id,builder_version,output_snapshot_json,activation_fingerprint,
created_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.draftId,
            creationId,
            revisionNumber,
            parentRevisionNumber,
            expectedVersion,
            input.inputSnapshotJson,
            input.inputFingerprint,
            input.builderId,
            input.builderVersion,
            input.outputSnapshotJson,
            input.activationFingerprint,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_creation SET status='review',current_draft_revision_number=?,version=version+1,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            revisionNumber,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        const snapshot = await requireUnfinished();
        if (
          snapshot.id !== creationId ||
          snapshot.version !== expectedVersion + 1 ||
          snapshot.currentDraft?.revisionNumber !== revisionNumber ||
          snapshot.status !== "review"
        )
          throw new PlanCreationStoreError("stale-version");
        await recordCommand("plan_creation.preview", command, { creationId }, snapshot);
        return { outcome: "recorded", snapshot };
      });
    },
    async activate({
      command,
      creationId,
      expectedVersion,
      incumbent,
      activatedAt,
      todayDateKey,
      mirrorJobId,
      cleanupJobId,
      revisionId,
      materialize,
    }) {
      return store.transaction(async () => {
        const prior = await hasReplay("plan_creation.activate", command);
        if (prior !== undefined) {
          const parsed = PlanCreationActivationResultSchema.safeParse(
            json(text(prior, "result_json")),
          );
          return parsed.success ? parsed.data : fail();
        }
        const current = await readUnfinished();
        if (current === undefined || current.id !== creationId)
          throw new PlanCreationStoreError("not-ready");
        if (current.version !== expectedVersion)
          throw new PlanCreationStoreError("version-conflict");
        const revision = current.currentDraft;
        if (
          current.status !== "review" ||
          revision === null ||
          revision.inputVersion + 1 !== current.version
        )
          throw new PlanCreationStoreError("not-ready");
        const draft = ActivationDraftSchema.safeParse(json(revision.outputSnapshotJson));
        if (!draft.success || !draft.data.weeks.some((week) => week.workouts.length > 0))
          throw new PlanCreationStoreError("not-ready");
        if (draft.data.outputFingerprint !== revision.activationFingerprint) return fail();
        const { plan, workouts } = materialize(current);
        validatePlanRecord(plan);
        for (const workout of workouts) validatePlanWorkoutRecord(plan, workout);
        if (plan.status !== "active") return fail();
        const activePlan = await store.get(
          "SELECT plan_id,version FROM planning_plan WHERE status='active'",
        );
        if (
          incumbent === null
            ? activePlan !== undefined
            : activePlan === undefined ||
              text(activePlan, "plan_id") !== incumbent.planId ||
              integer(activePlan, "version") !== incumbent.version
        )
          throw new PlanCreationStoreError("version-conflict");
        const closedPlanId = activePlan === undefined ? null : text(activePlan, "plan_id");
        const result = PlanCreationActivationResultSchema.parse({
          creationId,
          planId: plan.id,
          closedPlanId,
          activatedAt,
        });
        if (closedPlanId !== null) {
          await store.run(
            `UPDATE planning_plan SET status='closed',close_reason='stopped',close_actor=?,closed_at_ms=?,
version=version+1,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE plan_id=? AND status='active'`,
            [
              command.deviceId,
              command.nowMs,
              command.nowMs,
              command.deviceId,
              command.hlcPhysicalMs,
              command.hlcCounter,
              closedPlanId,
            ],
          );
          await store.run(
            `UPDATE plan SET status='ended',updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=?`,
            [
              command.nowMs,
              command.deviceId,
              command.hlcPhysicalMs,
              command.hlcCounter,
              closedPlanId,
            ],
          );
        }
        await store.run(
          `INSERT INTO plan (id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,
total_weeks,week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            plan.id,
            plan.originId,
            plan.name,
            plan.primaryGoal,
            plan.startDateKey,
            plan.targetDateKey,
            plan.status,
            plan.kind,
            plan.totalWeeks,
            plan.weekStartDay,
            plan.structureJson,
            plan.createdAtMs,
            plan.updatedAtMs,
            plan.deviceId,
            plan.hlcPhysicalMs,
            plan.hlcCounter,
          ],
        );
        for (const workout of workouts) {
          await store.run(
            `INSERT INTO plan_workout (id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        await store.run(
          `INSERT INTO plan_reconciliation_job (
id,plan_id,kind,status,window_start_date_key,window_end_date_key,
attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
created_at_ms,updated_at_ms,completed_at_ms
) VALUES (?,?,'mirror','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
          [
            mirrorJobId,
            plan.id,
            todayDateKey,
            addCivilDays(todayDateKey, 6),
            command.nowMs,
            command.nowMs,
          ],
        );
        if (closedPlanId !== null) {
          const closedPlan = await store.get(
            "SELECT start_date_key,total_weeks FROM plan WHERE id=?",
            [closedPlanId],
          );
          if (closedPlan === undefined) return fail();
          const windowStart = addCivilDays(todayDateKey, 1);
          const windowEnd = Math.max(
            windowStart,
            addCivilDays(
              integer(closedPlan, "start_date_key"),
              integer(closedPlan, "total_weeks") * 7 - 1,
            ),
          );
          await store.run(
            `INSERT INTO plan_reconciliation_job (
id,plan_id,kind,status,window_start_date_key,window_end_date_key,
attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
created_at_ms,updated_at_ms,completed_at_ms
) VALUES (?,?,'cleanup','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
            [cleanupJobId, closedPlanId, windowStart, windowEnd, command.nowMs, command.nowMs],
          );
        }
        await store.run(
          `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,'active',1,1,?,?,?,?,?)`,
          [
            plan.id,
            command.nowMs,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        await store.run(
          `INSERT INTO plan_revision (id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,1,NULL,'activation',?,?,?,?,?,?,?)`,
          [
            revisionId,
            plan.id,
            creationId,
            revision.outputSnapshotJson,
            draft.data.outputFingerprint,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        const updated = await store.get(
          `UPDATE plan_creation SET status='activated',activated_plan_id=?,terminal_at_ms=?,version=version+1,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='review' AND version=? RETURNING version`,
          [
            plan.id,
            command.nowMs,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        if (updated === undefined || integer(updated, "version") !== expectedVersion + 1)
          throw new PlanCreationStoreError("version-conflict");
        await recordCommand("plan_creation.activate", command, { creationId }, result);
        return result;
      });
    },
    async discard({ command, creationId, expectedVersion }) {
      return store.transaction(async () => {
        if (await hasReplay("plan_creation.discard", command)) return { outcome: "discarded" };
        const current = await readUnfinished();
        if (current === undefined || current.id !== creationId)
          throw new PlanCreationStoreError("no-unfinished-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const version = expectedVersion + 1;
        const updated = await store.get(
          `UPDATE plan_creation SET status='discarded',terminal_at_ms=?,updated_at_ms=?,version=version+1,
device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?
RETURNING status,version`,
          [
            command.nowMs,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        if (updated === undefined) throw new PlanCreationStoreError("stale-version");
        if (text(updated, "status") !== "discarded" || integer(updated, "version") !== version) {
          fail();
        }
        await recordCommand(
          "plan_creation.discard",
          command,
          { creationId },
          {
            creationId,
            outcome: "discarded",
            version,
          },
        );
        return { outcome: "discarded" };
      });
    },
  };
}
