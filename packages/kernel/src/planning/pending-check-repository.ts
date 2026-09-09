import { z } from "zod";
import { canonicalJson } from "../archive/canonical.js";
import { fail, PlanCreationStoreError } from "./command-ledger.js";
import type { PlanCreationCommandStamp } from "./command-ledger.js";
import type { PlanCreationStore } from "./creation-repository.js";

export const PlanningCheckOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("creation"),
      creationId: z.string().min(1),
      sourceVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("change"),
      planId: z.string().min(1),
      sourceVersion: z.number().int().positive(),
      sourceChangeSequence: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type PlanningCheckOwner = z.infer<typeof PlanningCheckOwnerSchema>;
const ObjectJsonSchema = z.string().refine((value) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
});
export const PlanningPendingCheckSchema = z
  .object({
    owner: PlanningCheckOwnerSchema,
    checkId: z.string().min(1),
    commandId: z.string().min(1),
    attempt: z.number().int().positive(),
    state: z.enum(["busy", "ready", "error"]),
    submissionJson: ObjectJsonSchema,
    checkJson: ObjectJsonSchema,
  })
  .strict();
export type PlanningPendingCheck = z.infer<typeof PlanningPendingCheckSchema>;
export type PlanningCheckAdmission =
  | { readonly status: "admitted"; readonly check: PlanningPendingCheck }
  | { readonly status: "pending"; readonly check: PlanningPendingCheck | null }
  | { readonly status: "replayed"; readonly resultJson: string };
export interface AdmitPlanningCheckInput {
  readonly command: PlanCreationCommandStamp;
  readonly check: PlanningPendingCheck;
  readonly replacesCheckId?: string;
}
export interface SettlePlanningCheckInput {
  readonly command: PlanCreationCommandStamp;
  readonly check: PlanningPendingCheck;
  readonly resultJson: string;
  readonly staleResultJson: string;
}
export interface ResolvePlanningCheckInput {
  readonly owner: PlanningCheckOwner;
  readonly command: PlanCreationCommandStamp;
  readonly checkId: string;
  readonly effect: (store: PlanCreationStore, check: PlanningPendingCheck) => Promise<string>;
}
export interface PlanningPendingCheckRepository {
  read(owner: PlanningCheckOwner): Promise<PlanningPendingCheck | null>;
  listLive(): Promise<readonly PlanningPendingCheck[]>;
  listPendingCommands(): Promise<
    readonly { readonly check: PlanningPendingCheck; readonly command: PlanCreationCommandStamp }[]
  >;
  readCommand(owner: PlanningCheckOwner, commandId: string): Promise<PlanCreationCommandStamp>;
  admit(input: AdmitPlanningCheckInput): Promise<PlanningCheckAdmission>;
  settle(input: SettlePlanningCheckInput): Promise<{
    readonly status: "stored" | "stale" | "replayed";
    readonly resultJson: string;
  }>;
  resolve(input: ResolvePlanningCheckInput): Promise<string>;
}
const CommandRowSchema = z.object({
  command_id: z.string(),
  request_digest: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  result_json: z.string().nullable(),
  aggregate_refs_json: z.string(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  device_id: z.string(),
  hlc_physical_ms: z.number().int().nonnegative(),
  hlc_counter: z.number().int().nonnegative(),
});
const OwnerRowSchema = z.object({
  version: z.number().int().positive(),
  pending_check_json: z.string().nullable(),
});
const parseCheck = (value: string) => PlanningPendingCheckSchema.parse(JSON.parse(value));
const location = (owner: PlanningCheckOwner) =>
  owner.kind === "creation"
    ? {
        table: "plan_creation",
        key: "id",
        id: owner.creationId,
        live: "status IN ('in-progress','review')",
        name: "plan_creation.answer",
      }
    : {
        table: "planning_plan",
        key: "plan_id",
        id: owner.planId,
        live: "status='active'",
        name: "plan_change.preview",
      };

export function createPlanningPendingCheckRepository(
  store: PlanCreationStore,
): PlanningPendingCheckRepository {
  const readLiveOwner = async (owner: PlanningCheckOwner) => {
    const { table, key, id, live } = location(owner);
    const row = await store.get(
      `SELECT version,pending_check_json FROM ${table} WHERE ${key}=? AND ${live}`,
      [id],
    );
    return row === undefined ? null : OwnerRowSchema.parse(row);
  };
  const read = async (owner: PlanningCheckOwner) => {
    const row = await readLiveOwner(owner);
    return row?.pending_check_json == null ? null : parseCheck(row.pending_check_json);
  };
  const current = async (owner: PlanningCheckOwner) => {
    const row = await readLiveOwner(owner);
    if (row === null || row.version !== owner.sourceVersion) return false;
    if (owner.kind === "change") {
      const { sequence } = z
        .object({ sequence: z.number().int().nonnegative() })
        .parse(
          await store.get(
            "SELECT COALESCE(SUM(version),0) AS sequence FROM plan_change WHERE plan_id=?",
            [owner.planId],
          ),
        );
      if (sequence !== owner.sourceChangeSequence) return false;
    }
    return true;
  };
  const commandRow = async (owner: PlanningCheckOwner, commandId: string) => {
    const row = await store.get(
      "SELECT * FROM planning_command WHERE command_name=? AND command_id=?",
      [location(owner).name, commandId],
    );
    return row === undefined ? null : CommandRowSchema.parse(row);
  };
  const replay = async (owner: PlanningCheckOwner, command: PlanCreationCommandStamp) => {
    const row = await commandRow(owner, command.commandId);
    if (row === null) return null;
    const refs = z
      .object({ check: z.literal(true), owner: PlanningCheckOwnerSchema })
      .safeParse(JSON.parse(row.aggregate_refs_json));
    if (
      row.request_digest !== command.requestDigest ||
      !refs.success ||
      refs.data.owner.kind !== owner.kind ||
      location(refs.data.owner).id !== location(owner).id
    )
      throw new PlanCreationStoreError("command-conflict");
    if (row.status === "failed") return fail();
    return row;
  };
  const admitCommand = async (
    owner: PlanningCheckOwner,
    command: PlanCreationCommandStamp,
    check: PlanningPendingCheck,
  ) => {
    const refs =
      owner.kind === "creation" ? { creationId: owner.creationId } : { planId: owner.planId };
    await store.run(
      `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, 1, ?, ?, ?, ?, ?)`,
      [
        location(owner).name,
        command.commandId,
        command.requestDigest,
        canonicalJson({ ...refs, check: true, owner, pending: check }),
        command.nowMs,
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
      ],
    );
  };
  const finishCommand = async (
    owner: PlanningCheckOwner,
    command: PlanCreationCommandStamp,
    resultJson: string,
  ) => {
    ObjectJsonSchema.parse(resultJson);
    await store.run(
      `UPDATE planning_command SET status='succeeded',version=version+1,result_json=?,
updated_at_ms=MAX(updated_at_ms,?),device_id=?,hlc_counter=CASE WHEN hlc_physical_ms>? THEN hlc_counter ELSE MAX(hlc_counter,?) END,
hlc_physical_ms=MAX(hlc_physical_ms,?) WHERE command_name=? AND command_id=? AND request_digest=? AND status='pending'`,
      [
        resultJson,
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
        command.hlcPhysicalMs,
        location(owner).name,
        command.commandId,
        command.requestDigest,
      ],
    );
  };
  const writeCheck = async (
    owner: PlanningCheckOwner,
    check: PlanningPendingCheck | null,
    command: PlanCreationCommandStamp,
  ) => {
    const { table, key, id, live } = location(owner);
    await store.run(
      `UPDATE ${table} SET pending_check_json=?,updated_at_ms=MAX(updated_at_ms,?),device_id=?,
hlc_counter=CASE WHEN hlc_physical_ms>? THEN hlc_counter ELSE MAX(hlc_counter,?) END,
hlc_physical_ms=MAX(hlc_physical_ms,?) WHERE ${key}=? AND ${live}`,
      [
        check === null ? null : canonicalJson(check),
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
        command.hlcPhysicalMs,
        id,
      ],
    );
  };
  const scopedStore: PlanCreationStore = {
    exec: (sql) => store.exec(sql),
    run: (sql, params) => store.run(sql, params),
    get: (sql, params) => store.get(sql, params),
    all: (sql, params) => store.all(sql, params),
    close: () => {
      throw new Error("Cannot close a transaction store");
    },
    transaction: (operation) => operation(),
  };
  return {
    read,
    async listLive() {
      const rows =
        await store.all(`SELECT pending_check_json FROM plan_creation WHERE status IN ('in-progress','review') AND pending_check_json IS NOT NULL
UNION ALL SELECT pending_check_json FROM planning_plan WHERE status='active' AND pending_check_json IS NOT NULL`);
      return rows.map((row) => parseCheck(z.string().parse(row.pending_check_json)));
    },
    async listPendingCommands() {
      const rows = await store.all(
        "SELECT * FROM planning_command WHERE status='pending' AND json_extract(aggregate_refs_json,'$.check')=1",
      );
      return rows.map((raw) => {
        const row = CommandRowSchema.parse(raw);
        const { pending } = z
          .object({ pending: PlanningPendingCheckSchema })
          .parse(JSON.parse(row.aggregate_refs_json));
        return {
          check: pending,
          command: {
            commandId: row.command_id,
            requestDigest: row.request_digest,
            nowMs: row.updated_at_ms,
            deviceId: row.device_id,
            hlcPhysicalMs: row.hlc_physical_ms,
            hlcCounter: row.hlc_counter,
          },
        };
      });
    },
    async readCommand(owner, commandId) {
      const row = await commandRow(owner, commandId);
      if (row === null) return fail();
      return {
        commandId: row.command_id,
        requestDigest: row.request_digest,
        nowMs: row.updated_at_ms,
        deviceId: row.device_id,
        hlcPhysicalMs: row.hlc_physical_ms,
        hlcCounter: row.hlc_counter,
      };
    },
    async admit(input) {
      const check = PlanningPendingCheckSchema.parse(input.check);
      const { owner } = check;
      if (check.state !== "busy" || check.commandId !== input.command.commandId) return fail();
      return store.transaction(async () => {
        const prior = await replay(owner, input.command);
        if (prior !== null) {
          if (prior.status === "succeeded")
            return { status: "replayed", resultJson: prior.result_json ?? fail() };
          return { status: "pending", check: await read(owner) };
        }
        if (!(await current(owner))) throw new PlanCreationStoreError("stale-version");
        const existing = await read(owner);
        if (
          existing !== null &&
          (existing.state === "busy" || existing.checkId !== input.replacesCheckId)
        )
          throw new PlanCreationStoreError("not-ready");
        if (input.replacesCheckId !== undefined && existing?.checkId !== input.replacesCheckId)
          throw new PlanCreationStoreError("stale-version");
        await admitCommand(owner, input.command, check);
        await writeCheck(owner, check, input.command);
        return { status: "admitted", check };
      });
    },
    async settle(input) {
      const check = PlanningPendingCheckSchema.parse(input.check);
      const { owner } = check;
      if (check.state === "busy" || check.commandId !== input.command.commandId) return fail();
      return store.transaction(async () => {
        const prior = await replay(owner, input.command);
        if (prior === null) return fail();
        if (prior.status === "succeeded")
          return { status: "replayed", resultJson: prior.result_json ?? fail() };
        const existing = await read(owner);
        const valid =
          (await current(owner)) &&
          existing?.checkId === check.checkId &&
          existing.commandId === check.commandId &&
          canonicalJson(existing.owner) === canonicalJson(owner) &&
          existing.attempt === check.attempt &&
          existing.submissionJson === check.submissionJson &&
          existing.state === "busy";
        const resultJson = valid ? input.resultJson : input.staleResultJson;
        if (valid) await writeCheck(owner, check, input.command);
        else if (existing?.checkId === check.checkId && existing.commandId === check.commandId)
          await writeCheck(owner, null, input.command);
        await finishCommand(owner, input.command, resultJson);
        return { status: valid ? "stored" : "stale", resultJson };
      });
    },
    async resolve(input) {
      return store.transaction(async () => {
        const prior = await replay(input.owner, input.command);
        if (prior !== null) {
          if (prior.status === "succeeded") return prior.result_json ?? fail();
          throw new PlanCreationStoreError("not-ready");
        }
        if (!(await current(input.owner))) throw new PlanCreationStoreError("stale-version");
        const check = await read(input.owner);
        if (
          check === null ||
          check.checkId !== input.checkId ||
          canonicalJson(check.owner) !== canonicalJson(input.owner)
        )
          throw new PlanCreationStoreError("stale-version");
        if (check.state === "busy") throw new PlanCreationStoreError("not-ready");
        await admitCommand(input.owner, input.command, check);
        await writeCheck(input.owner, null, input.command);
        const resultJson = await input.effect(scopedStore, check);
        await finishCommand(input.owner, input.command, resultJson);
        return resultJson;
      });
    },
  };
}
