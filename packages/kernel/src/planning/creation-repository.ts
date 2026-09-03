import { canonicalJson } from "../archive/canonical.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { z } from "zod";

export type PlanCreationStore = SqlStore & Pick<MigratorStore, "transaction">;
export type PlanCreationErrorCode =
  | "command-conflict"
  | "stale-version"
  | "missing-creation"
  | "corrupt-record";

export class PlanCreationStoreError extends Error {
  constructor(readonly code: PlanCreationErrorCode) {
    super(code);
    this.name = "PlanCreationStoreError";
  }
}

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

export interface PlanCreationAnswerRecord {
  readonly id: string;
  readonly sequence: number;
  readonly creationVersion: number;
  readonly answerKey: string;
  readonly valueJson: string;
  readonly confirmedAtMs: number;
}

export interface PlanCreationSnapshot {
  readonly id: string;
  readonly status: "in-progress" | "review" | "activated" | "discarded";
  readonly version: number;
  readonly seed: PlanCreationSeedV1 | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly answers: readonly PlanCreationAnswerRecord[];
}

export interface PlanCreationCommandStamp {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly nowMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

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

export interface PlanCreationRepository {
  readUnfinished(): Promise<PlanCreationSnapshot | undefined>;
  start(input: StartPlanCreationInput): Promise<{
    outcome: "created" | "resumed" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  recordAnswer(input: RecordPlanCreationAnswerInput): Promise<{
    outcome: "recorded" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
}

const fail = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};
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
  const readUnfinished = async (): Promise<PlanCreationSnapshot | undefined> => {
    const rows = await store.all(
      "SELECT * FROM plan_creation WHERE status IN ('in-progress','review') ORDER BY created_at_ms,id",
    );
    if (rows.length > 1) fail();
    const row = rows[0];
    if (row === undefined) return undefined;
    const id = text(row, "id");
    const status = text(row, "status");
    if (status !== "in-progress" && status !== "review") fail();
    const seedJson = row.seed_json;
    const seed =
      seedJson === null ? null : typeof seedJson === "string" ? parseSeed(json(seedJson)) : fail();
    const answers = await store.all(
      "SELECT * FROM plan_creation_answer WHERE creation_id=? ORDER BY sequence,id",
      [id],
    );
    return {
      id,
      status: status === "review" ? "review" : "in-progress",
      version: integer(row, "version"),
      seed,
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
  const requireUnfinished = async () => {
    const snapshot = await readUnfinished();
    if (snapshot === undefined) throw new PlanCreationStoreError("missing-creation");
    return snapshot;
  };
  const replay = async (
    name: "plan_creation.start" | "plan_creation.answer",
    command: PlanCreationCommandStamp,
  ) => {
    const row = await store.get(
      "SELECT request_digest,status FROM planning_command WHERE command_name=? AND command_id=?",
      [name, command.commandId],
    );
    if (row === undefined) return undefined;
    if (text(row, "request_digest") !== command.requestDigest)
      throw new PlanCreationStoreError("command-conflict");
    if (text(row, "status") !== "succeeded") fail();
    return requireUnfinished();
  };
  const recordCommand = (
    name: "plan_creation.start" | "plan_creation.answer",
    command: PlanCreationCommandStamp,
    creationId: string,
    result: unknown,
  ) =>
    store.run(
      `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, 'succeeded', ?, ?, NULL, NULL, 2, ?, ?, ?, ?, ?)`,
      [
        name,
        command.commandId,
        command.requestDigest,
        canonicalJson({ creationId }),
        canonicalJson(result),
        command.nowMs,
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
      ],
    );
  return {
    readUnfinished,
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
          snapshot = await requireUnfinished();
        }
        await recordCommand("plan_creation.start", command, snapshot.id, {
          creationId: snapshot.id,
          outcome,
        });
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
WHERE id=? AND status='in-progress' AND version=?`,
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
        await recordCommand("plan_creation.answer", command, creationId, {
          creationId,
          answerId,
          version,
        });
        return { outcome: "recorded", snapshot };
      });
    },
  };
}
