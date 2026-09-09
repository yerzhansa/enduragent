import { addCivilDays } from "@enduragent/kernel/planning";
import type { AuthoredRow, ImportSink, RestoreTableResult } from "@enduragent/kernel/store/export";
import type { MigratorStore, Row, SqlStore, SqlValue } from "@enduragent/kernel/store";

type SqliteImportStore = SqlStore & Pick<MigratorStore, "transaction">;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function toSqlValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError("Export row contains a non-SQL value");
}

function text(row: AuthoredRow | Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Export row is invalid");
  return value;
}

function integer(row: AuthoredRow | Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Export row is invalid");
  }
  return value;
}

async function requireCompatibleCleanupJob(
  store: SqliteImportStore,
  replacement: AuthoredRow,
): Promise<void> {
  const cleanupJobId = text(replacement, "cleanup_job_id");
  const previousPlanId = text(replacement, "previous_plan_id");
  const existing = await store.get("SELECT plan_id,kind FROM plan_reconciliation_job WHERE id=?", [
    cleanupJobId,
  ]);
  if (existing !== undefined) {
    if (text(existing, "plan_id") !== previousPlanId || text(existing, "kind") !== "cleanup") {
      throw new TypeError("Export row is inconsistent");
    }
    return;
  }
  const plan = await store.get("SELECT start_date_key,total_weeks FROM plan WHERE id=?", [
    previousPlanId,
  ]);
  if (plan === undefined) throw new TypeError("Export row is inconsistent");
  const startDateKey = integer(plan, "start_date_key");
  const totalWeeks = integer(plan, "total_weeks");
  if (totalWeeks === 0) throw new TypeError("Export row is invalid");
  const createdAtMs = integer(replacement, "created_at_ms");
  const updatedAtMs = integer(replacement, "updated_at_ms");
  await store.run(
    `INSERT INTO plan_reconciliation_job (
      id,plan_id,kind,status,window_start_date_key,window_end_date_key,
      attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
      created_at_ms,updated_at_ms,completed_at_ms
    ) VALUES (?,?,'cleanup','verified',?,?,0,0,0,NULL,NULL,?,?,?)
    ON CONFLICT DO NOTHING`,
    [
      cleanupJobId,
      previousPlanId,
      startDateKey,
      addCivilDays(startDateKey, totalWeeks * 7 - 1),
      createdAtMs,
      updatedAtMs,
      updatedAtMs,
    ],
  );
  const restored = await store.get("SELECT plan_id,kind FROM plan_reconciliation_job WHERE id=?", [
    cleanupJobId,
  ]);
  if (
    restored === undefined ||
    text(restored, "plan_id") !== previousPlanId ||
    text(restored, "kind") !== "cleanup"
  ) {
    throw new TypeError("Export row is inconsistent");
  }
}

function normalizeRows(
  table: string,
  rows: readonly AuthoredRow[],
  sourceUserVersion: number,
): readonly AuthoredRow[] {
  if (table !== "plan_adaptation_ledger" || sourceUserVersion < 19 || sourceUserVersion >= 28) {
    return rows;
  }
  return rows.map((row) => ({ ...row, operation: "update" }));
}

async function restorePlanningAuthority(
  store: SqliteImportStore,
  rows: readonly AuthoredRow[],
): Promise<RestoreTableResult> {
  const table = "planning_authority";
  if (rows.length === 0) return { table, inserted: 0, skipped: 0 };
  if (rows.length !== 1 || integer(rows[0]!, "singleton") !== 1) {
    throw new TypeError("Export row is invalid");
  }
  const row = rows[0]!;
  if (row.chat_authority_since_ms === null) return { table, inserted: 0, skipped: 1 };
  const instant = integer(row, "chat_authority_since_ms");
  const current = await store.get(
    "SELECT chat_authority_since_ms FROM planning_authority WHERE singleton = 1",
  );
  if (current === undefined) throw new TypeError("Planning authority is missing");
  if (current.chat_authority_since_ms !== null) return { table, inserted: 0, skipped: 1 };
  await store.run(
    `UPDATE planning_authority
SET chat_authority_since_ms = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ?
WHERE singleton = 1 AND chat_authority_since_ms IS NULL`,
    [
      instant,
      toSqlValue(row.device_id),
      toSqlValue(row.hlc_physical_ms),
      toSqlValue(row.hlc_counter),
    ],
  );
  return { table, inserted: 1, skipped: 0 };
}

async function restoreRows(
  store: SqliteImportStore,
  table: string,
  rows: readonly AuthoredRow[],
): Promise<RestoreTableResult> {
  const tableName = quoteIdentifier(table);
  const before = Number((await store.get(`SELECT COUNT(*) AS count FROM ${tableName}`))?.count);
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) throw new TypeError("Export row is invalid");
    await store.run(
      `INSERT INTO ${tableName} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
      columns.map((column) => toSqlValue(row[column])),
    );
  }
  const after = Number((await store.get(`SELECT COUNT(*) AS count FROM ${tableName}`))?.count);
  const inserted = after - before;
  return { table, inserted, skipped: rows.length - inserted };
}

export function createSqliteImportSink(store: SqliteImportStore): ImportSink {
  return {
    restoreAuthoredTable(table, rows, { sourceUserVersion }) {
      return store.transaction(async () => {
        if (table === "planning_authority") return restorePlanningAuthority(store, rows);
        const normalized = normalizeRows(table, rows, sourceUserVersion);
        if (table === "plan_replacement" && sourceUserVersion >= 21 && sourceUserVersion < 29) {
          for (const row of normalized) await requireCompatibleCleanupJob(store, row);
        }
        const result = await restoreRows(store, table, normalized);
        if (table === "plan_creation") {
          await store.run(
            `UPDATE planning_authority
SET chat_authority_since_ms = (SELECT MIN(created_at_ms) FROM plan_creation)
WHERE singleton = 1 AND chat_authority_since_ms IS NULL AND EXISTS (SELECT 1 FROM plan_creation)`,
          );
        }
        return result;
      });
    },
  };
}
