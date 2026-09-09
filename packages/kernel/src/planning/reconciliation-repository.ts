import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { addCivilDays } from "./date-keys.js";

export type PlanReconciliationKind = "mirror" | "cleanup";
export type PlanReconciliationStatus = "pending" | "running" | "retrying" | "failed" | "verified";
export type PlanReconciliationItemStatus =
  | "pending"
  | "running"
  | "created"
  | "failed"
  | "verified";
export type PlanReconciliationOperation = "create" | "delete";
export type PlanReconciliationErrorCode =
  | "calendar-list-failed"
  | "calendar-create-failed"
  | "calendar-delete-failed"
  | "calendar-verification-failed";

export interface PlanReconciliationJobRecord {
  readonly id: string;
  readonly planId: string;
  readonly kind: PlanReconciliationKind;
  readonly status: PlanReconciliationStatus;
  readonly windowStartDateKey: number;
  readonly windowEndDateKey: number;
  readonly attemptCount: number;
  readonly failureCount: number;
  readonly resumedCount: number;
  readonly lastResumedAttempt: number | null;
  readonly lastErrorCode: PlanReconciliationErrorCode | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface PlanReconciliationItemRecord {
  readonly id: string;
  readonly jobId: string;
  readonly planWorkoutId: string | null;
  readonly operation: PlanReconciliationOperation;
  readonly status: PlanReconciliationItemStatus;
  readonly dateKey: number;
  readonly externalId: string;
  readonly providerEventId: number | null;
  readonly expectedJson: string;
  readonly attemptCount: number;
  readonly lastErrorCode: Exclude<PlanReconciliationErrorCode, "calendar-list-failed"> | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface NewPlanReconciliationJob {
  readonly id: string;
  readonly planId: string;
  readonly kind: PlanReconciliationKind;
  readonly windowStartDateKey: number;
  readonly windowEndDateKey: number;
  readonly createdAtMs: number;
}

export interface NewPlanReconciliationItem {
  readonly id: string;
  readonly jobId: string;
  readonly planWorkoutId: string | null;
  readonly operation: PlanReconciliationOperation;
  readonly dateKey: number;
  readonly externalId: string;
  readonly expectedJson: string;
  readonly createdAtMs: number;
}

export interface PlanReconciliationRepository {
  createOrGetJob(record: NewPlanReconciliationJob): Promise<PlanReconciliationJobRecord>;
  readJob(id: string): Promise<PlanReconciliationJobRecord | undefined>;
  readLatestJob(
    planId: string,
    kind: PlanReconciliationKind,
  ): Promise<PlanReconciliationJobRecord | undefined>;
  listRunnable(input: {
    nowMs: number;
    leaseMs: number;
    maxFailures: number;
  }): Promise<readonly PlanReconciliationJobRecord[]>;
  claim(
    id: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<PlanReconciliationJobRecord | undefined>;
  readLatestJobByWindow(
    planId: string,
    kind: PlanReconciliationKind,
  ): Promise<PlanReconciliationJobRecord | undefined>;
  readLatestJobsForLibrary(): Promise<readonly PlanReconciliationJobRecord[]>;
  beginAttempt(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord>;
  reopenJob(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord>;
  failJob(
    id: string,
    errorCode: PlanReconciliationErrorCode,
    updatedAtMs: number,
  ): Promise<PlanReconciliationJobRecord>;
  verifyJob(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord>;
  prepareItem(record: NewPlanReconciliationItem): Promise<PlanReconciliationItemRecord>;
  readItems(jobId: string): Promise<readonly PlanReconciliationItemRecord[]>;
  startItem(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord>;
  markItemCreated(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord>;
  failItem(
    id: string,
    errorCode: Exclude<PlanReconciliationErrorCode, "calendar-list-failed">,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord>;
  verifyItem(
    id: string,
    providerEventId: number | null,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord>;
  deleteItem(id: string): Promise<void>;
}

export class PlanReconciliationValidationError extends Error {
  readonly code:
    | "invalid-job"
    | "invalid-item"
    | "missing-job"
    | "missing-item"
    | "unverified-items";

  constructor(code: PlanReconciliationValidationError["code"]) {
    super(`plan reconciliation rejected: ${code}`);
    this.name = "PlanReconciliationValidationError";
    this.code = code;
  }
}

type ReconciliationStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_KIND = new Set<unknown>(["mirror", "cleanup"]);
const STATUS = new Set<unknown>(["pending", "running", "retrying", "failed", "verified"]);
const ITEM_STATUS = new Set<unknown>(["pending", "running", "created", "failed", "verified"]);
const OPERATION = new Set<unknown>(["create", "delete"]);
const ERROR_CODE = new Set<unknown>([
  "calendar-list-failed",
  "calendar-create-failed",
  "calendar-delete-failed",
  "calendar-verification-failed",
]);
const ITEM_ERROR_CODE = new Set<unknown>([
  "calendar-create-failed",
  "calendar-delete-failed",
  "calendar-verification-failed",
]);

function validDateKey(value: unknown): value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 10_101 ||
    (value as number) > 99_991_231
  ) {
    return false;
  }
  try {
    addCivilDays(value as number, 0);
    return true;
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validateNewJob(record: NewPlanReconciliationJob): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !JOB_KIND.has(record.kind) ||
    !validDateKey(record.windowStartDateKey) ||
    !validDateKey(record.windowEndDateKey) ||
    record.windowEndDateKey < record.windowStartDateKey ||
    !validTimestamp(record.createdAtMs)
  ) {
    throw new PlanReconciliationValidationError("invalid-job");
  }
}

function validateNewItem(record: NewPlanReconciliationItem): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.jobId) ||
    (record.planWorkoutId !== null && !ULID.test(record.planWorkoutId)) ||
    !OPERATION.has(record.operation) ||
    (record.operation === "create" && record.planWorkoutId === null) ||
    !validDateKey(record.dateKey) ||
    typeof record.externalId !== "string" ||
    record.externalId.length < 1 ||
    record.externalId.length > 256 ||
    !validJson(record.expectedJson) ||
    !validTimestamp(record.createdAtMs)
  ) {
    throw new PlanReconciliationValidationError("invalid-item");
  }
}

function jobFromRow(row: Row): PlanReconciliationJobRecord {
  const value: PlanReconciliationJobRecord = {
    id: row.id as string,
    planId: row.plan_id as string,
    kind: row.kind as PlanReconciliationKind,
    status: row.status as PlanReconciliationStatus,
    windowStartDateKey: row.window_start_date_key as number,
    windowEndDateKey: row.window_end_date_key as number,
    attemptCount: row.attempt_count as number,
    failureCount: row.failure_count as number,
    resumedCount: row.resumed_count as number,
    lastResumedAttempt: row.last_resumed_attempt as number | null,
    lastErrorCode: row.last_error_code as PlanReconciliationErrorCode | null,
    createdAtMs: row.created_at_ms as number,
    updatedAtMs: row.updated_at_ms as number,
    completedAtMs: row.completed_at_ms as number | null,
  };
  if (
    !ULID.test(value.id) ||
    !ULID.test(value.planId) ||
    !JOB_KIND.has(value.kind) ||
    !STATUS.has(value.status) ||
    !validDateKey(value.windowStartDateKey) ||
    !validDateKey(value.windowEndDateKey) ||
    value.windowEndDateKey < value.windowStartDateKey ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    !Number.isSafeInteger(value.resumedCount) ||
    value.resumedCount < 0 ||
    !Number.isSafeInteger(value.failureCount) ||
    value.failureCount < 0 ||
    value.resumedCount > value.attemptCount ||
    (value.lastResumedAttempt !== null &&
      (!Number.isSafeInteger(value.lastResumedAttempt) ||
        value.lastResumedAttempt <= 0 ||
        value.lastResumedAttempt > value.attemptCount)) ||
    (value.lastErrorCode !== null && !ERROR_CODE.has(value.lastErrorCode)) ||
    !validTimestamp(value.createdAtMs) ||
    !validTimestamp(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    (value.completedAtMs !== null &&
      (!validTimestamp(value.completedAtMs) || value.completedAtMs < value.createdAtMs))
  ) {
    throw new PlanReconciliationValidationError("invalid-job");
  }
  return Object.freeze(value);
}

function itemFromRow(row: Row): PlanReconciliationItemRecord {
  const value: PlanReconciliationItemRecord = {
    id: row.id as string,
    jobId: row.job_id as string,
    planWorkoutId: row.plan_workout_id as string | null,
    operation: row.operation as PlanReconciliationOperation,
    status: row.status as PlanReconciliationItemStatus,
    dateKey: row.date_key as number,
    externalId: row.external_id as string,
    providerEventId: row.provider_event_id as number | null,
    expectedJson: row.expected_json as string,
    attemptCount: row.attempt_count as number,
    lastErrorCode: row.last_error_code as PlanReconciliationItemRecord["lastErrorCode"],
    createdAtMs: row.created_at_ms as number,
    updatedAtMs: row.updated_at_ms as number,
    completedAtMs: row.completed_at_ms as number | null,
  };
  if (
    !ULID.test(value.id) ||
    !ULID.test(value.jobId) ||
    (value.planWorkoutId !== null && !ULID.test(value.planWorkoutId)) ||
    !OPERATION.has(value.operation) ||
    !ITEM_STATUS.has(value.status) ||
    (value.operation === "create" && value.planWorkoutId === null) ||
    (value.operation === "delete" && value.planWorkoutId !== null) ||
    (value.status === "created" && value.operation !== "create") ||
    !validDateKey(value.dateKey) ||
    typeof value.externalId !== "string" ||
    value.externalId.length < 1 ||
    value.externalId.length > 256 ||
    (value.providerEventId !== null &&
      (!Number.isSafeInteger(value.providerEventId) || value.providerEventId <= 0)) ||
    (value.operation === "create" &&
      value.status === "verified" &&
      value.providerEventId === null) ||
    (value.operation === "delete" && value.providerEventId !== null) ||
    (value.status !== "verified" && value.providerEventId !== null) ||
    !validJson(value.expectedJson) ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    (value.lastErrorCode !== null && !ITEM_ERROR_CODE.has(value.lastErrorCode)) ||
    !validTimestamp(value.createdAtMs) ||
    !validTimestamp(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    (value.completedAtMs !== null &&
      (!validTimestamp(value.completedAtMs) || value.completedAtMs < value.createdAtMs))
  ) {
    throw new PlanReconciliationValidationError("invalid-item");
  }
  return Object.freeze(value);
}

const JOB_COLUMNS = `id,plan_id,kind,status,window_start_date_key,window_end_date_key,
attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
created_at_ms,updated_at_ms,completed_at_ms`;
const ITEM_COLUMNS = `id,job_id,plan_workout_id,operation,status,date_key,external_id,
provider_event_id,expected_json,attempt_count,last_error_code,created_at_ms,updated_at_ms,completed_at_ms`;

export function createPlanReconciliationRepository(
  store: ReconciliationStore,
): PlanReconciliationRepository {
  async function requireJob(id: string): Promise<PlanReconciliationJobRecord> {
    const row = await store.get(`SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job WHERE id=?`, [
      id,
    ]);
    if (row === undefined) throw new PlanReconciliationValidationError("missing-job");
    return jobFromRow(row);
  }

  async function requireItem(id: string): Promise<PlanReconciliationItemRecord> {
    const row = await store.get(`SELECT ${ITEM_COLUMNS} FROM plan_reconciliation_item WHERE id=?`, [
      id,
    ]);
    if (row === undefined) throw new PlanReconciliationValidationError("missing-item");
    return itemFromRow(row);
  }

  async function persistAttempt(
    current: PlanReconciliationJobRecord,
    updatedAtMs: number,
  ): Promise<void> {
    if (updatedAtMs < current.updatedAtMs) {
      throw new PlanReconciliationValidationError("invalid-job");
    }
    const nextAttempt = current.attemptCount + 1;
    const resumed = current.status === "running" || current.status === "retrying";
    const nextStatus =
      current.status === "failed" || current.status === "retrying" ? "retrying" : "running";
    await store.run(
      `UPDATE plan_reconciliation_job SET
         status=?,attempt_count=?,resumed_count=resumed_count+?,
         last_resumed_attempt=?,last_error_code=NULL,
         updated_at_ms=?,completed_at_ms=NULL
       WHERE id=?`,
      [
        nextStatus,
        nextAttempt,
        resumed ? 1 : 0,
        resumed ? nextAttempt : null,
        updatedAtMs,
        current.id,
      ],
    );
  }

  const repository: PlanReconciliationRepository = {
    async createOrGetJob(record) {
      validateNewJob(record);
      await store.run(
        `INSERT INTO plan_reconciliation_job (
          id,plan_id,kind,status,window_start_date_key,window_end_date_key,
          attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
          created_at_ms,updated_at_ms,completed_at_ms
        ) VALUES (?,?,?,'pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
        ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
        [
          record.id,
          record.planId,
          record.kind,
          record.windowStartDateKey,
          record.windowEndDateKey,
          record.createdAtMs,
          record.createdAtMs,
        ],
      );
      const row = await store.get(
        `SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job
         WHERE plan_id=? AND kind=? AND window_start_date_key=? AND window_end_date_key=?`,
        [record.planId, record.kind, record.windowStartDateKey, record.windowEndDateKey],
      );
      if (row === undefined) throw new PlanReconciliationValidationError("missing-job");
      return jobFromRow(row);
    },
    async readJob(id) {
      if (!ULID.test(id)) throw new PlanReconciliationValidationError("invalid-job");
      const row = await store.get(`SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job WHERE id=?`, [
        id,
      ]);
      return row === undefined ? undefined : jobFromRow(row);
    },
    async readLatestJob(planId, kind) {
      if (!ULID.test(planId) || !JOB_KIND.has(kind)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const row = await store.get(
        `SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job
         WHERE plan_id=? AND kind=? ORDER BY updated_at_ms DESC,id DESC LIMIT 1`,
        [planId, kind],
      );
      return row === undefined ? undefined : jobFromRow(row);
    },
    async listRunnable({ nowMs, leaseMs, maxFailures }) {
      if (!validTimestamp(nowMs) || !validTimestamp(leaseMs) || !validTimestamp(maxFailures)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const rows = await store.all(
        `SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job
         WHERE (kind='cleanup' OR (kind='mirror' AND plan_id IN (
           SELECT plan_id FROM planning_plan WHERE status='active'
         ))) AND (status IN ('pending','retrying')
           OR (status='failed' AND failure_count<?)
           OR (status='running' AND updated_at_ms+?<=?))
         ORDER BY window_start_date_key ASC,created_at_ms ASC,id ASC`,
        [maxFailures, leaseMs, nowMs],
      );
      return Object.freeze(rows.map(jobFromRow));
    },
    async claim(id, nowMs, leaseMs) {
      if (!ULID.test(id) || !validTimestamp(nowMs) || !validTimestamp(leaseMs)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      return store.transaction(async () => {
        const current = await requireJob(id);
        if (
          current.status === "verified" ||
          ((current.status === "running" || current.status === "retrying") &&
            current.updatedAtMs + leaseMs > nowMs)
        ) {
          return undefined;
        }
        await persistAttempt(current, nowMs);
        return requireJob(id);
      });
    },
    async readLatestJobByWindow(planId, kind) {
      if (!ULID.test(planId) || !JOB_KIND.has(kind)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const row = await store.get(
        `SELECT ${JOB_COLUMNS} FROM plan_reconciliation_job
         WHERE plan_id=? AND kind=?
         ORDER BY window_start_date_key DESC,window_end_date_key DESC,id DESC LIMIT 1`,
        [planId, kind],
      );
      return row === undefined ? undefined : jobFromRow(row);
    },
    async readLatestJobsForLibrary() {
      const rows = await store.all(
        `SELECT ${JOB_COLUMNS} FROM (
           SELECT ${JOB_COLUMNS},ROW_NUMBER() OVER (
             PARTITION BY plan_id,kind
             ORDER BY window_start_date_key DESC,window_end_date_key DESC,id DESC
           ) AS job_rank FROM plan_reconciliation_job
         ) WHERE job_rank=1 ORDER BY plan_id,kind`,
      );
      return Object.freeze(rows.map(jobFromRow));
    },
    async beginAttempt(id, updatedAtMs) {
      if (!ULID.test(id) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      await store.transaction(async () => {
        const current = await requireJob(id);
        await persistAttempt(current, updatedAtMs);
      });
      return requireJob(id);
    },
    async reopenJob(id, updatedAtMs) {
      if (!ULID.test(id) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      await store.run(
        `UPDATE plan_reconciliation_job SET status='pending',last_error_code=NULL,
         completed_at_ms=NULL,updated_at_ms=? WHERE id=?`,
        [updatedAtMs, id],
      );
      return requireJob(id);
    },
    async failJob(id, errorCode, updatedAtMs) {
      if (!ULID.test(id) || !ERROR_CODE.has(errorCode) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const current = await requireJob(id);
      if (
        (current.status !== "running" && current.status !== "retrying") ||
        updatedAtMs < current.updatedAtMs
      ) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      await store.run(
        `UPDATE plan_reconciliation_job SET
           status='failed',failure_count=failure_count+1,last_error_code=?,
           updated_at_ms=?,completed_at_ms=NULL WHERE id=?`,
        [errorCode, updatedAtMs, id],
      );
      return requireJob(id);
    },
    async verifyJob(id, updatedAtMs) {
      if (!ULID.test(id) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const current = await requireJob(id);
      if (
        (current.status !== "running" && current.status !== "retrying") ||
        updatedAtMs < current.updatedAtMs
      ) {
        throw new PlanReconciliationValidationError("invalid-job");
      }
      const incomplete = await store.get(
        "SELECT count(*) AS count FROM plan_reconciliation_item WHERE job_id=? AND status<>'verified'",
        [id],
      );
      if (incomplete?.count !== 0) throw new PlanReconciliationValidationError("unverified-items");
      await store.run(
        `UPDATE plan_reconciliation_job SET
           status='verified',last_resumed_attempt=NULL,last_error_code=NULL,
           updated_at_ms=?,completed_at_ms=? WHERE id=?`,
        [updatedAtMs, updatedAtMs, id],
      );
      return requireJob(id);
    },
    async prepareItem(record) {
      validateNewItem(record);
      const existing = await store.get(
        `SELECT ${ITEM_COLUMNS} FROM plan_reconciliation_item
         WHERE job_id=? AND operation=? AND external_id=?`,
        [record.jobId, record.operation, record.externalId],
      );
      if (existing === undefined) {
        await store.run(
          `INSERT INTO plan_reconciliation_item (
            id,job_id,plan_workout_id,operation,status,date_key,external_id,
            provider_event_id,expected_json,attempt_count,last_error_code,
            created_at_ms,updated_at_ms,completed_at_ms
          ) VALUES (?,?,?,?,'pending',?,?,NULL,?,0,NULL,?,?,NULL)`,
          [
            record.id,
            record.jobId,
            record.planWorkoutId,
            record.operation,
            record.dateKey,
            record.externalId,
            record.expectedJson,
            record.createdAtMs,
            record.createdAtMs,
          ],
        );
      } else {
        const current = itemFromRow(existing);
        if (record.createdAtMs < current.updatedAtMs) {
          throw new PlanReconciliationValidationError("invalid-item");
        }
        if (
          current.planWorkoutId !== record.planWorkoutId ||
          current.dateKey !== record.dateKey ||
          current.expectedJson !== record.expectedJson
        ) {
          await store.run(
            `UPDATE plan_reconciliation_item SET
               plan_workout_id=?,date_key=?,expected_json=?,status='pending',
               provider_event_id=NULL,last_error_code=NULL,updated_at_ms=?,completed_at_ms=NULL
             WHERE id=?`,
            [
              record.planWorkoutId,
              record.dateKey,
              record.expectedJson,
              record.createdAtMs,
              current.id,
            ],
          );
        }
      }
      const row = await store.get(
        `SELECT ${ITEM_COLUMNS} FROM plan_reconciliation_item
         WHERE job_id=? AND operation=? AND external_id=?`,
        [record.jobId, record.operation, record.externalId],
      );
      if (row === undefined) throw new PlanReconciliationValidationError("missing-item");
      return itemFromRow(row);
    },
    async readItems(jobId) {
      if (!ULID.test(jobId)) throw new PlanReconciliationValidationError("invalid-item");
      const rows = await store.all(
        `SELECT ${ITEM_COLUMNS} FROM plan_reconciliation_item
         WHERE job_id=? ORDER BY date_key ASC,external_id COLLATE BINARY ASC,id ASC`,
        [jobId],
      );
      return Object.freeze(rows.map(itemFromRow));
    },
    async startItem(id, updatedAtMs) {
      if (!ULID.test(id) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      const current = await requireItem(id);
      if (updatedAtMs < current.updatedAtMs)
        throw new PlanReconciliationValidationError("invalid-item");
      await store.run(
        `UPDATE plan_reconciliation_item SET
           status='running',attempt_count=attempt_count+1,last_error_code=NULL,
           provider_event_id=NULL,updated_at_ms=?,completed_at_ms=NULL WHERE id=?`,
        [updatedAtMs, id],
      );
      return requireItem(id);
    },
    async markItemCreated(id, updatedAtMs) {
      if (!ULID.test(id) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      const current = await requireItem(id);
      if (
        current.operation !== "create" ||
        current.status !== "running" ||
        updatedAtMs < current.updatedAtMs
      ) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      await store.run(
        `UPDATE plan_reconciliation_item SET
           status='created',provider_event_id=NULL,last_error_code=NULL,
           updated_at_ms=?,completed_at_ms=NULL WHERE id=?`,
        [updatedAtMs, id],
      );
      return requireItem(id);
    },
    async failItem(id, errorCode, updatedAtMs) {
      if (!ULID.test(id) || !ITEM_ERROR_CODE.has(errorCode) || !validTimestamp(updatedAtMs)) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      const current = await requireItem(id);
      if (updatedAtMs < current.updatedAtMs)
        throw new PlanReconciliationValidationError("invalid-item");
      await store.run(
        `UPDATE plan_reconciliation_item SET
           status='failed',provider_event_id=NULL,last_error_code=?,
           updated_at_ms=?,completed_at_ms=NULL WHERE id=?`,
        [errorCode, updatedAtMs, id],
      );
      return requireItem(id);
    },
    async deleteItem(id) {
      if (!ULID.test(id)) throw new PlanReconciliationValidationError("invalid-item");
      await store.run("DELETE FROM plan_reconciliation_item WHERE id=?", [id]);
    },
    async verifyItem(id, providerEventId, updatedAtMs) {
      if (
        !ULID.test(id) ||
        (providerEventId !== null &&
          (!Number.isSafeInteger(providerEventId) || providerEventId <= 0)) ||
        !validTimestamp(updatedAtMs)
      ) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      const current = await requireItem(id);
      if (
        (current.operation === "create" && providerEventId === null) ||
        (current.operation === "delete" && providerEventId !== null) ||
        updatedAtMs < current.updatedAtMs
      ) {
        throw new PlanReconciliationValidationError("invalid-item");
      }
      await store.run(
        `UPDATE plan_reconciliation_item SET
           status='verified',provider_event_id=?,last_error_code=NULL,
           updated_at_ms=?,completed_at_ms=? WHERE id=?`,
        [providerEventId, updatedAtMs, updatedAtMs, id],
      );
      return requireItem(id);
    },
  };
  return Object.freeze(repository);
}
