import type { Row, SqlStore } from "../store/ports.js";

export type PlanIcuCopyKind =
  | "not-sent"
  | "on-icu"
  | "moving-by-you"
  | "changed-in-icu"
  | "removed-by-you"
  | "kept-as-yours";

export type PlanIcuWriteErrorCode =
  | "calendar-read-failed"
  | "calendar-create-failed"
  | "calendar-update-failed"
  | "calendar-delete-failed";

export type PlanIcuLastWrite =
  | { readonly kind: "none" }
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly errorCode: PlanIcuWriteErrorCode };

export interface PlanIcuCopyRecord {
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly dateKey: number;
  readonly stateKind: PlanIcuCopyKind;
  readonly stateJson: string;
  readonly lastWrite: PlanIcuLastWrite;
  readonly updatedAtMs: number;
}

export type PlanWeekDeliveryKind = "waiting-for-first-approve" | "approved";

export interface PlanWeekDeliveryRecord {
  readonly planId: string;
  readonly stateKind: PlanWeekDeliveryKind;
  readonly stateJson: string;
  readonly closeChoiceJson: string;
  readonly updatedAtMs: number;
}

export type PlanCalendarWeekDelivery = "send-each-week" | "approve-each-week";

export interface PlanCalendarMirrorRepository {
  readCopies(planId: string): Promise<readonly PlanIcuCopyRecord[]>;
  writeCopy(record: PlanIcuCopyRecord): Promise<void>;
  readDelivery(planId: string): Promise<PlanWeekDeliveryRecord | undefined>;
  writeDelivery(record: PlanWeekDeliveryRecord): Promise<void>;
  readWeekDeliverySetting(): Promise<PlanCalendarWeekDelivery>;
  writeWeekDeliverySetting(value: PlanCalendarWeekDelivery, updatedAtMs: number): Promise<void>;
}

export class PlanCalendarMirrorValidationError extends Error {
  readonly code: "invalid-copy" | "invalid-delivery" | "invalid-setting";

  constructor(code: PlanCalendarMirrorValidationError["code"]) {
    super(`plan calendar mirror rejected: ${code}`);
    this.name = "PlanCalendarMirrorValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const COPY_KINDS: ReadonlySet<string> = new Set([
  "not-sent",
  "on-icu",
  "moving-by-you",
  "changed-in-icu",
  "removed-by-you",
  "kept-as-yours",
]);
const ERROR_CODES: ReadonlySet<string> = new Set([
  "calendar-read-failed",
  "calendar-create-failed",
  "calendar-update-failed",
  "calendar-delete-failed",
]);

function objectJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function copyKind(value: unknown): PlanIcuCopyKind {
  if (value === "not-sent" || value === "on-icu") return value;
  if (value === "changed-in-icu" || value === "removed-by-you") return value;
  if (value === "kept-as-yours" || value === "moving-by-you") return value;
  throw new PlanCalendarMirrorValidationError("invalid-copy");
}

function errorCode(value: unknown): PlanIcuWriteErrorCode {
  if (value === "calendar-read-failed" || value === "calendar-create-failed") return value;
  if (value === "calendar-update-failed" || value === "calendar-delete-failed") return value;
  throw new PlanCalendarMirrorValidationError("invalid-copy");
}

function lastWrite(row: Row): PlanIcuLastWrite {
  const kind = row.last_write;
  if (kind === "none" && row.last_error_code === null) return { kind: "none" };
  if (kind === "ok" && row.last_error_code === null) return { kind: "ok" };
  if (kind === "failed") return { kind: "failed", errorCode: errorCode(row.last_error_code) };
  throw new PlanCalendarMirrorValidationError("invalid-copy");
}

function integer(value: unknown, code: PlanCalendarMirrorValidationError["code"]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlanCalendarMirrorValidationError(code);
  }
  return value;
}

function text(value: unknown, code: PlanCalendarMirrorValidationError["code"]): string {
  if (typeof value !== "string") throw new PlanCalendarMirrorValidationError(code);
  return value;
}

function copyFromRow(row: Row): PlanIcuCopyRecord {
  const record: PlanIcuCopyRecord = {
    planId: text(row.plan_id, "invalid-copy"),
    planWorkoutId: text(row.plan_workout_id, "invalid-copy"),
    dateKey: integer(row.date_key, "invalid-copy"),
    stateKind: copyKind(row.state_kind),
    stateJson: text(row.state_json, "invalid-copy"),
    lastWrite: lastWrite(row),
    updatedAtMs: integer(row.updated_at_ms, "invalid-copy"),
  };
  validateCopy(record);
  return record;
}

function validateCopy(record: PlanIcuCopyRecord): void {
  if (
    !ULID.test(record.planId) ||
    !ULID.test(record.planWorkoutId) ||
    !COPY_KINDS.has(record.stateKind) ||
    !objectJson(record.stateJson) ||
    (record.lastWrite.kind === "failed" && !ERROR_CODES.has(record.lastWrite.errorCode))
  ) {
    throw new PlanCalendarMirrorValidationError("invalid-copy");
  }
}

function deliveryKind(value: unknown): PlanWeekDeliveryKind {
  if (value === "waiting-for-first-approve" || value === "approved") return value;
  throw new PlanCalendarMirrorValidationError("invalid-delivery");
}

function deliveryFromRow(row: Row): PlanWeekDeliveryRecord {
  const record: PlanWeekDeliveryRecord = {
    planId: text(row.plan_id, "invalid-delivery"),
    stateKind: deliveryKind(row.state_kind),
    stateJson: text(row.state_json, "invalid-delivery"),
    closeChoiceJson: text(row.close_choice_json, "invalid-delivery"),
    updatedAtMs: integer(row.updated_at_ms, "invalid-delivery"),
  };
  validateDelivery(record);
  return record;
}

function validateDelivery(record: PlanWeekDeliveryRecord): void {
  if (
    !ULID.test(record.planId) ||
    !objectJson(record.stateJson) ||
    !objectJson(record.closeChoiceJson)
  ) {
    throw new PlanCalendarMirrorValidationError("invalid-delivery");
  }
}

function weekDelivery(value: unknown): PlanCalendarWeekDelivery {
  if (value === "send-each-week" || value === "approve-each-week") return value;
  throw new PlanCalendarMirrorValidationError("invalid-setting");
}

export function createPlanCalendarMirrorRepository(store: SqlStore): PlanCalendarMirrorRepository {
  return {
    async readCopies(planId) {
      const rows = await store.all(
        `SELECT plan_id,plan_workout_id,date_key,state_kind,state_json,last_write,last_error_code,updated_at_ms
FROM plan_icu_copy WHERE plan_id=? ORDER BY date_key,plan_workout_id`,
        [planId],
      );
      return rows.map(copyFromRow);
    },
    async writeCopy(record) {
      validateCopy(record);
      await store.run(
        `INSERT INTO plan_icu_copy (plan_id,plan_workout_id,date_key,state_kind,state_json,last_write,last_error_code,updated_at_ms)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(plan_id,plan_workout_id) DO UPDATE SET
  date_key=excluded.date_key,
  state_kind=excluded.state_kind,
  state_json=excluded.state_json,
  last_write=excluded.last_write,
  last_error_code=excluded.last_error_code,
  updated_at_ms=excluded.updated_at_ms`,
        [
          record.planId,
          record.planWorkoutId,
          record.dateKey,
          record.stateKind,
          record.stateJson,
          record.lastWrite.kind,
          record.lastWrite.kind === "failed" ? record.lastWrite.errorCode : null,
          record.updatedAtMs,
        ],
      );
    },
    async readDelivery(planId) {
      const row = await store.get(
        `SELECT plan_id,state_kind,state_json,close_choice_json,updated_at_ms
FROM plan_week_delivery WHERE plan_id=?`,
        [planId],
      );
      return row === undefined ? undefined : deliveryFromRow(row);
    },
    async writeDelivery(record) {
      validateDelivery(record);
      await store.run(
        `INSERT INTO plan_week_delivery (plan_id,state_kind,state_json,close_choice_json,updated_at_ms)
VALUES (?,?,?,?,?)
ON CONFLICT(plan_id) DO UPDATE SET
  state_kind=excluded.state_kind,
  state_json=excluded.state_json,
  close_choice_json=excluded.close_choice_json,
  updated_at_ms=excluded.updated_at_ms`,
        [
          record.planId,
          record.stateKind,
          record.stateJson,
          record.closeChoiceJson,
          record.updatedAtMs,
        ],
      );
    },
    async readWeekDeliverySetting() {
      const row = await store.get("SELECT week_delivery FROM planning_calendar_setting WHERE id=1");
      return row === undefined ? "send-each-week" : weekDelivery(row.week_delivery);
    },
    async writeWeekDeliverySetting(value, updatedAtMs) {
      await store.run(
        `INSERT INTO planning_calendar_setting (id,week_delivery,updated_at_ms) VALUES (1,?,?)
ON CONFLICT(id) DO UPDATE SET week_delivery=excluded.week_delivery,updated_at_ms=excluded.updated_at_ms`,
        [weekDelivery(value), integer(updatedAtMs, "invalid-setting")],
      );
    },
  };
}
