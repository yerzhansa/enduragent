import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import {
  MIN_FULL_PLAN_DAYS,
  MIN_FULL_PLAN_WEEKS,
  inclusiveCivilDays,
  planWeekIndex,
  validateNewPlanStartDate,
  weekdayForDateKey,
} from "./date-keys.js";

export type PlanStatus = "draft" | "active" | "ended";
export type PlanKind = "full_plan" | "short_race_preparation";
export type PlanWorkoutOrigin = "coach" | "athlete";

export interface PlanRecord {
  readonly id: string;
  readonly originId: string | null;
  readonly name: string;
  readonly primaryGoal: string;
  readonly startDateKey: number;
  readonly targetDateKey: number | null;
  readonly status: PlanStatus;
  readonly kind: PlanKind;
  readonly totalWeeks: number;
  readonly weekStartDay: number;
  readonly structureJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanWorkoutRecord {
  readonly id: string;
  readonly planId: string;
  readonly dateKey: number;
  readonly sport: string;
  readonly name: string;
  readonly durationS: number | null;
  readonly structureJson: string;
  readonly origin: PlanWorkoutOrigin;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanSummaryRecord {
  readonly planId: string;
  readonly version: number;
  readonly name: string;
  readonly startDateKey: number;
  readonly totalWeeks: number;
  readonly status: "active" | "closed";
  readonly closeReason: "stopped" | "completed" | "legacy-unclassified" | null;
  readonly closedAtMs: number | null;
  readonly activatedAtMs: number | null;
  readonly creationId: string | null;
}

export type PlanValidationErrorCode =
  | "invalid-id"
  | "invalid-origin-id"
  | "invalid-name"
  | "invalid-primary-goal"
  | "invalid-status"
  | "invalid-kind"
  | "inconsistent-kind"
  | "invalid-total-weeks"
  | "invalid-week-start-day"
  | "inconsistent-week-start-day"
  | "invalid-target-date"
  | "target-outside-plan"
  | "invalid-json"
  | "invalid-timestamp"
  | "invalid-device-id"
  | "invalid-hlc"
  | "invalid-workout"
  | "workout-outside-plan";

export class PlanValidationError extends Error {
  readonly code: PlanValidationErrorCode;

  constructor(code: PlanValidationErrorCode) {
    super(`plan rejected: ${code}`);
    this.name = "PlanValidationError";
    this.code = code;
  }
}

export interface PlanRepository {
  replace(plan: PlanRecord, workouts: readonly PlanWorkoutRecord[]): Promise<void>;
  replaceNew(
    plan: PlanRecord,
    workouts: readonly PlanWorkoutRecord[],
    todayDateKey: number,
  ): Promise<void>;
  read(id: string): Promise<PlanRecord | undefined>;
  readByOriginId(originId: string): Promise<PlanRecord | undefined>;
  readLatest(): Promise<PlanRecord | undefined>;
  listPlans(): Promise<readonly PlanSummaryRecord[]>;
  readWorkouts(planId: string): Promise<readonly PlanWorkoutRecord[]>;
  endActive(input: EndActivePlanInput): Promise<EndActivePlanResult>;
  count(): Promise<number>;
  delete(id: string): Promise<void>;
}

export interface EndActivePlanInput {
  readonly planId: string;
  readonly cleanupJobId: string;
  readonly windowStartDateKey: number;
  readonly windowEndDateKey: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface EndActivePlanResult {
  readonly plan: PlanRecord;
  readonly cleanupJobId: string;
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS = new Set<unknown>(["draft", "active", "ended"]);
const KIND = new Set<unknown>(["full_plan", "short_race_preparation"]);
const ORIGIN = new Set<unknown>(["coach", "athlete"]);
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function expectedKind(
  plan: Pick<PlanRecord, "startDateKey" | "targetDateKey" | "totalWeeks">,
): PlanKind {
  if (plan.targetDateKey !== null) {
    const days = inclusiveCivilDays(plan.startDateKey, plan.targetDateKey);
    if (days <= 0) throw new PlanValidationError("invalid-target-date");
    return days >= MIN_FULL_PLAN_DAYS ? "full_plan" : "short_race_preparation";
  }
  return plan.totalWeeks >= MIN_FULL_PLAN_WEEKS ? "full_plan" : "short_race_preparation";
}

export function validatePlanRecord(plan: PlanRecord): void {
  if (!ULID.test(plan.id)) throw new PlanValidationError("invalid-id");
  if (plan.originId !== null && (typeof plan.originId !== "string" || plan.originId.length === 0)) {
    throw new PlanValidationError("invalid-origin-id");
  }
  if (typeof plan.name !== "string") throw new PlanValidationError("invalid-name");
  if (typeof plan.primaryGoal !== "string") throw new PlanValidationError("invalid-primary-goal");
  if (!STATUS.has(plan.status)) throw new PlanValidationError("invalid-status");
  if (!KIND.has(plan.kind)) throw new PlanValidationError("invalid-kind");
  if (!Number.isSafeInteger(plan.totalWeeks) || plan.totalWeeks <= 0) {
    throw new PlanValidationError("invalid-total-weeks");
  }
  if (!Number.isSafeInteger(plan.weekStartDay) || plan.weekStartDay < 0 || plan.weekStartDay > 6) {
    throw new PlanValidationError("invalid-week-start-day");
  }
  const actualWeekStartDay = weekdayForDateKey(plan.startDateKey);
  if (plan.weekStartDay !== actualWeekStartDay) {
    throw new PlanValidationError("inconsistent-week-start-day");
  }
  if (plan.targetDateKey !== null) {
    const targetWeek = planWeekIndex(plan, plan.targetDateKey);
    if (targetWeek.kind !== "inside") throw new PlanValidationError("target-outside-plan");
  }
  if (plan.kind !== expectedKind(plan)) throw new PlanValidationError("inconsistent-kind");
  if (!validJson(plan.structureJson)) throw new PlanValidationError("invalid-json");
  if (
    !Number.isSafeInteger(plan.createdAtMs) ||
    plan.createdAtMs < 0 ||
    !Number.isSafeInteger(plan.updatedAtMs) ||
    plan.updatedAtMs < plan.createdAtMs
  ) {
    throw new PlanValidationError("invalid-timestamp");
  }
  if (!DEVICE_ID.test(plan.deviceId)) throw new PlanValidationError("invalid-device-id");
  if (
    !Number.isSafeInteger(plan.hlcPhysicalMs) ||
    plan.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(plan.hlcCounter) ||
    plan.hlcCounter < 0
  ) {
    throw new PlanValidationError("invalid-hlc");
  }
}

export function validatePlanWorkoutRecord(plan: PlanRecord, workout: PlanWorkoutRecord): void {
  if (
    !ULID.test(workout.id) ||
    workout.planId !== plan.id ||
    typeof workout.sport !== "string" ||
    workout.sport.length === 0 ||
    typeof workout.name !== "string" ||
    workout.name.length === 0 ||
    (workout.durationS !== null &&
      (!Number.isSafeInteger(workout.durationS) || workout.durationS <= 0)) ||
    !validJson(workout.structureJson) ||
    !ORIGIN.has(workout.origin) ||
    !DEVICE_ID.test(workout.deviceId) ||
    !Number.isSafeInteger(workout.hlcPhysicalMs) ||
    workout.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(workout.hlcCounter) ||
    workout.hlcCounter < 0
  ) {
    throw new PlanValidationError("invalid-workout");
  }
  if (planWeekIndex(plan, workout.dateKey).kind !== "inside") {
    throw new PlanValidationError("workout-outside-plan");
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanValidationError("invalid-json");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanValidationError("invalid-json");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new PlanValidationError("invalid-json");
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanValidationError("invalid-json");
  }
  return value;
}

function planFromRow(row: Row): PlanRecord {
  const plan: PlanRecord = Object.freeze({
    id: text(row, "id"),
    originId: nullableText(row, "origin_id"),
    name: text(row, "name"),
    primaryGoal: text(row, "primary_goal"),
    startDateKey: integer(row, "start_date_key"),
    targetDateKey: nullableInteger(row, "target_date_key"),
    status: text(row, "status") as PlanStatus,
    kind: text(row, "kind") as PlanKind,
    totalWeeks: integer(row, "total_weeks"),
    weekStartDay: integer(row, "week_start_day"),
    structureJson: text(row, "structure_json"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validatePlanRecord(plan);
  return plan;
}

function workoutFromRow(row: Row): PlanWorkoutRecord {
  return Object.freeze({
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    dateKey: integer(row, "date_key"),
    sport: text(row, "sport"),
    name: text(row, "name"),
    durationS: nullableInteger(row, "duration_s"),
    structureJson: text(row, "structure_json"),
    origin: text(row, "origin") as PlanWorkoutOrigin,
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
}

function planSummaryFromRow(row: Row): PlanSummaryRecord {
  const status = text(row, "status");
  const closeReason = nullableText(row, "close_reason");
  if (status !== "active" && status !== "closed") {
    throw new PlanValidationError("invalid-status");
  }
  if (
    closeReason !== null &&
    closeReason !== "stopped" &&
    closeReason !== "completed" &&
    closeReason !== "legacy-unclassified"
  ) {
    throw new PlanValidationError("invalid-json");
  }
  return Object.freeze({
    planId: text(row, "plan_id"),
    version: integer(row, "version"),
    name: text(row, "name"),
    startDateKey: integer(row, "start_date_key"),
    totalWeeks: integer(row, "total_weeks"),
    status,
    closeReason,
    closedAtMs: nullableInteger(row, "closed_at_ms"),
    activatedAtMs: nullableInteger(row, "activated_at_ms"),
    creationId: nullableText(row, "creation_id"),
  });
}

export function createPlanRepository(store: PlanningStore): PlanRepository {
  const replace = async (
    plan: PlanRecord,
    workouts: readonly PlanWorkoutRecord[],
  ): Promise<void> => {
    validatePlanRecord(plan);
    for (const workout of workouts) validatePlanWorkoutRecord(plan, workout);
    await store.transaction(async () => {
      await store.run(
        `INSERT INTO plan (
  id, origin_id, name, primary_goal, start_date_key, target_date_key, status, kind,
  total_weeks, week_start_day, structure_json, created_at_ms, updated_at_ms,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  origin_id = excluded.origin_id,
  name = excluded.name,
  primary_goal = excluded.primary_goal,
  start_date_key = excluded.start_date_key,
  target_date_key = excluded.target_date_key,
  status = excluded.status,
  kind = excluded.kind,
  total_weeks = excluded.total_weeks,
  week_start_day = excluded.week_start_day,
  structure_json = excluded.structure_json,
  updated_at_ms = excluded.updated_at_ms,
  device_id = excluded.device_id,
  hlc_physical_ms = excluded.hlc_physical_ms,
  hlc_counter = excluded.hlc_counter`,
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
      await store.run("DELETE FROM plan_workout WHERE plan_id = ?", [plan.id]);
      for (const workout of workouts) {
        await store.run(
          `INSERT INTO plan_workout (
  id, plan_id, date_key, sport, name, duration_s, structure_json, origin,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    });
  };

  return Object.freeze({
    replace,
    async replaceNew(
      plan: PlanRecord,
      workouts: readonly PlanWorkoutRecord[],
      todayDateKey: number,
    ) {
      validateNewPlanStartDate(plan, todayDateKey);
      await replace(plan, workouts);
    },
    async read(id: string) {
      if (!ULID.test(id)) throw new PlanValidationError("invalid-id");
      const row = await store.get("SELECT * FROM plan WHERE id = ?", [id]);
      return row === undefined ? undefined : planFromRow(row);
    },
    async readByOriginId(originId: string) {
      if (typeof originId !== "string" || originId.length === 0) {
        throw new PlanValidationError("invalid-origin-id");
      }
      const row = await store.get("SELECT * FROM plan WHERE origin_id = ?", [originId]);
      return row === undefined ? undefined : planFromRow(row);
    },
    async readLatest() {
      const row = await store.get(
        "SELECT * FROM plan ORDER BY updated_at_ms DESC, hlc_physical_ms DESC, hlc_counter DESC, id DESC LIMIT 1",
      );
      return row === undefined ? undefined : planFromRow(row);
    },
    async listPlans() {
      const rows = await store.all(
        `SELECT planning_plan.plan_id, planning_plan.version, plan.name, plan.start_date_key, plan.total_weeks,
                planning_plan.status, planning_plan.close_reason, planning_plan.closed_at_ms,
                planning_plan.activated_at_ms, plan_revision.source_id AS creation_id
         FROM planning_plan
         JOIN plan ON plan.id = planning_plan.plan_id
         LEFT JOIN plan_revision ON plan_revision.plan_id = planning_plan.plan_id
           AND plan_revision.source_kind = 'activation'
         ORDER BY planning_plan.status = 'active' DESC,
                  planning_plan.closed_at_ms DESC, planning_plan.plan_id ASC`,
      );
      return rows.map(planSummaryFromRow);
    },
    async readWorkouts(planId: string) {
      if (!ULID.test(planId)) throw new PlanValidationError("invalid-id");
      return (
        await store.all("SELECT * FROM plan_workout WHERE plan_id = ? ORDER BY date_key, id", [
          planId,
        ])
      ).map(workoutFromRow);
    },
    async endActive(input: EndActivePlanInput) {
      if (!ULID.test(input.planId) || !ULID.test(input.cleanupJobId)) {
        throw new PlanValidationError("invalid-id");
      }
      if (
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < 0 ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanValidationError("invalid-timestamp");
      }
      if (!DEVICE_ID.test(input.deviceId)) throw new PlanValidationError("invalid-device-id");
      if (inclusiveCivilDays(input.windowStartDateKey, input.windowEndDateKey) <= 0) {
        throw new PlanValidationError("invalid-target-date");
      }
      return store.transaction(async () => {
        const row = await store.get("SELECT * FROM plan WHERE id = ?", [input.planId]);
        if (row === undefined) throw new PlanValidationError("invalid-id");
        const current = planFromRow(row);
        if (current.status !== "active" && current.status !== "ended") {
          throw new PlanValidationError("invalid-status");
        }
        if (current.status === "active") {
          if (input.updatedAtMs < current.updatedAtMs) {
            throw new PlanValidationError("invalid-timestamp");
          }
          await store.run(
            `UPDATE plan SET
               status='ended',updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
             WHERE id=? AND status='active'`,
            [
              input.updatedAtMs,
              input.deviceId,
              input.hlcPhysicalMs,
              input.hlcCounter,
              input.planId,
            ],
          );
        }
        await store.run(
          `INSERT INTO plan_reconciliation_job (
             id,plan_id,kind,status,window_start_date_key,window_end_date_key,
             attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
             created_at_ms,updated_at_ms,completed_at_ms
           ) VALUES (?,?,'cleanup','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
           ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
          [
            input.cleanupJobId,
            input.planId,
            input.windowStartDateKey,
            input.windowEndDateKey,
            input.updatedAtMs,
            input.updatedAtMs,
          ],
        );
        const [endedRow, jobRow] = await Promise.all([
          store.get("SELECT * FROM plan WHERE id = ?", [input.planId]),
          store.get(
            `SELECT id FROM plan_reconciliation_job
             WHERE plan_id=? AND kind='cleanup' AND window_start_date_key=? AND window_end_date_key=?`,
            [input.planId, input.windowStartDateKey, input.windowEndDateKey],
          ),
        ]);
        if (endedRow === undefined || jobRow === undefined) {
          throw new PlanValidationError("invalid-id");
        }
        return Object.freeze({
          plan: planFromRow(endedRow),
          cleanupJobId: text(jobRow, "id"),
        });
      });
    },
    async count() {
      const row = await store.get("SELECT count(*) AS count FROM plan");
      return row === undefined ? 0 : integer(row, "count");
    },
    async delete(id: string) {
      if (!ULID.test(id)) throw new PlanValidationError("invalid-id");
      await store.run("DELETE FROM plan WHERE id = ?", [id]);
    },
  });
}
