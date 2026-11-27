import { z } from "zod";
import type { SqlStore } from "../store/ports.js";
import { addCivilDays } from "./date-keys.js";

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

const HoldRowSchema = z.object({
  plan_id: UlidSchema,
  replacement_plan_id: UlidSchema,
  held_at_ms: z.number().int().nonnegative(),
  released_at_ms: z.number().int().nonnegative().nullable(),
});

const PlanSpanSchema = z.object({
  start_date_key: z.number().int(),
  total_weeks: z.number().int().positive(),
});

export interface PlanCleanupHoldRecord {
  readonly planId: string;
  readonly replacementPlanId: string;
  readonly heldAtMs: number;
  readonly releasedAtMs: number | null;
}

export interface PlanCleanupRelease {
  readonly closedOnDateKey: number;
  readonly nowMs: number;
  readonly newId: () => string;
}

export interface PlanCleanupHoldRepository {
  hold(input: {
    readonly planId: string;
    readonly replacementPlanId: string;
    readonly nowMs: number;
  }): Promise<void>;
  release(replacementPlanId: string, release: PlanCleanupRelease): Promise<readonly string[]>;
  releaseOrphans(release: PlanCleanupRelease): Promise<readonly string[]>;
  readForReplacement(replacementPlanId: string): Promise<readonly PlanCleanupHoldRecord[]>;
  readHeldPlanIds(): Promise<ReadonlySet<string>>;
}

type HoldStore = Pick<SqlStore, "run" | "get" | "all">;

const HOLD_COLUMNS = "plan_id,replacement_plan_id,held_at_ms,released_at_ms";

function holdFromRow(row: unknown): PlanCleanupHoldRecord {
  const parsed = HoldRowSchema.parse(row);
  return {
    planId: parsed.plan_id,
    replacementPlanId: parsed.replacement_plan_id,
    heldAtMs: parsed.held_at_ms,
    releasedAtMs: parsed.released_at_ms,
  };
}

export function createPlanCleanupHoldRepository(store: HoldStore): PlanCleanupHoldRepository {
  const releaseAll = async (
    holds: readonly PlanCleanupHoldRecord[],
    release: PlanCleanupRelease,
  ): Promise<readonly string[]> => {
    const windowStart = addCivilDays(release.closedOnDateKey, 1);
    for (const hold of holds) {
      const span = PlanSpanSchema.parse(
        await store.get("SELECT start_date_key,total_weeks FROM plan WHERE id=?", [hold.planId]),
      );
      const windowEnd = Math.max(
        windowStart,
        addCivilDays(span.start_date_key, span.total_weeks * 7 - 1),
      );
      await store.run(
        `INSERT INTO plan_reconciliation_job (
id,plan_id,kind,status,window_start_date_key,window_end_date_key,
attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
created_at_ms,updated_at_ms,completed_at_ms
) VALUES (?,?,'cleanup','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)
ON CONFLICT(plan_id,kind,window_start_date_key,window_end_date_key) DO NOTHING`,
        [release.newId(), hold.planId, windowStart, windowEnd, release.nowMs, release.nowMs],
      );
      await store.run(
        `UPDATE plan_cleanup_hold SET released_at_ms=?,updated_at_ms=?
WHERE plan_id=? AND released_at_ms IS NULL`,
        [
          Math.max(release.nowMs, hold.heldAtMs),
          Math.max(release.nowMs, hold.heldAtMs),
          hold.planId,
        ],
      );
    }
    return holds.map((hold) => hold.planId);
  };
  return {
    async hold({ planId, replacementPlanId, nowMs }) {
      await store.run(
        `UPDATE plan_cleanup_hold SET replacement_plan_id=?,updated_at_ms=MAX(updated_at_ms,?)
WHERE replacement_plan_id=? AND released_at_ms IS NULL`,
        [replacementPlanId, nowMs, planId],
      );
      await store.run(
        `INSERT INTO plan_cleanup_hold (plan_id,replacement_plan_id,held_at_ms,released_at_ms,updated_at_ms)
VALUES (?,?,?,NULL,?) ON CONFLICT(plan_id) DO NOTHING`,
        [planId, replacementPlanId, nowMs, nowMs],
      );
    },
    async release(replacementPlanId, release) {
      const rows = await store.all(
        `SELECT ${HOLD_COLUMNS} FROM plan_cleanup_hold
WHERE replacement_plan_id=? AND released_at_ms IS NULL ORDER BY held_at_ms,plan_id`,
        [replacementPlanId],
      );
      return releaseAll(rows.map(holdFromRow), release);
    },
    async releaseOrphans(release) {
      const rows = await store.all(
        `SELECT ${HOLD_COLUMNS} FROM plan_cleanup_hold
WHERE released_at_ms IS NULL AND replacement_plan_id NOT IN (
  SELECT planning_plan.plan_id FROM planning_plan
  JOIN plan_week_delivery ON plan_week_delivery.plan_id=planning_plan.plan_id
  WHERE planning_plan.status='active' AND plan_week_delivery.state_kind='waiting-for-first-approve'
) ORDER BY held_at_ms,plan_id`,
      );
      return releaseAll(rows.map(holdFromRow), release);
    },
    async readForReplacement(replacementPlanId) {
      const rows = await store.all(
        `SELECT ${HOLD_COLUMNS} FROM plan_cleanup_hold
WHERE replacement_plan_id=? ORDER BY held_at_ms,plan_id`,
        [replacementPlanId],
      );
      return rows.map(holdFromRow);
    },
    async readHeldPlanIds() {
      const rows = await store.all(
        "SELECT plan_id FROM plan_cleanup_hold WHERE released_at_ms IS NULL ORDER BY plan_id",
      );
      return new Set(rows.map((row) => UlidSchema.parse(row.plan_id)));
    },
  };
}
