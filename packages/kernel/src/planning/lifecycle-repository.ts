import { z } from "zod";
import { createPlanningCommandLedger, fail, PlanCreationStoreError } from "./command-ledger.js";
import type { PlanCreationCommandStamp, PlanCreationStore } from "./creation-repository.js";
import { addCivilDays } from "./date-keys.js";
import type { PlanSummaryRecord } from "./repository.js";

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const PlanCloseResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("closed"),
      planId: UlidSchema,
      closedAt: z.number().int().nonnegative(),
      cleanupJobId: UlidSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["stale-version", "no-active-plan", "command-conflict"]),
    })
    .strict(),
]);
export type PlanCloseResult = z.infer<typeof PlanCloseResultSchema>;

export interface ClosePlanInput {
  readonly command: PlanCreationCommandStamp;
  readonly planId: string;
  readonly expectedVersion: number;
  readonly closedAtMs: number;
  readonly todayDateKey: number;
  readonly cleanupJobId: string;
}

export interface ClosedPlanDetail {
  readonly plan: PlanSummaryRecord;
  readonly closeActor: string | null;
  readonly revision: {
    readonly revisionNumber: number;
    readonly fingerprint: string;
    readonly snapshot: unknown;
  };
  readonly cleanup: "none" | "pending" | "complete" | "failed";
}

export interface PlanLifecycleRepository {
  close(input: ClosePlanInput): Promise<PlanCloseResult>;
  completeExpired(input: { readonly todayDateKey: number; readonly nowMs: number }): Promise<{
    readonly completedPlanId: string | null;
  }>;
  readClosedDetail(planId: string): Promise<ClosedPlanDetail | null>;
}

const ActiveRowSchema = z.object({
  plan_id: UlidSchema,
  version: z.number().int().positive(),
  start_date_key: z.number().int(),
  total_weeks: z.number().int().positive(),
  hlc_physical_ms: z.number().int().nonnegative(),
  hlc_counter: z.number().int().nonnegative(),
});
const ClosedRowSchema = z.object({
  plan_id: UlidSchema,
  name: z.string(),
  start_date_key: z.number().int(),
  total_weeks: z.number().int().positive(),
  status: z.literal("closed"),
  close_reason: z.enum(["stopped", "completed", "legacy-unclassified"]),
  closed_at_ms: z.number().int().nonnegative(),
  activated_at_ms: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  creation_id: z.string().nullable(),
  close_actor: z.string().nullable(),
  cleanup_status: z.enum(["pending", "running", "retrying", "failed", "verified"]).nullable(),
});
const RevisionRowSchema = z.object({
  revision_number: z.number().int().positive(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  snapshot_json: z.string(),
});

export function createPlanLifecycleRepository(
  store: PlanCreationStore,
  identity: { readonly newId: () => string },
): PlanLifecycleRepository {
  const { hasReplay, recordCommand } = createPlanningCommandLedger(store);
  const readActive = async () => {
    const row = await store.get(`SELECT planning_plan.plan_id,planning_plan.version,
      plan.start_date_key,plan.total_weeks,planning_plan.hlc_physical_ms,planning_plan.hlc_counter
      FROM planning_plan JOIN plan ON plan.id=planning_plan.plan_id
      WHERE planning_plan.status='active'`);
    return row === undefined ? null : ActiveRowSchema.parse(row);
  };
  const persistClose = async (input: {
    planId: string;
    version: number;
    reason: "stopped" | "completed";
    actor: "athlete" | "system:plan-completion";
    closedAtMs: number;
    updatedAtMs: number;
    deviceId: string;
    hlcPhysicalMs: number;
    hlcCounter: number;
    cleanupJobId: string;
    windowStart: number;
    windowEnd: number;
  }) => {
    await store.run(
      `UPDATE planning_plan SET status='closed',close_reason=?,close_actor=?,
      closed_at_ms=?,version=version+1,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
      WHERE plan_id=? AND status='active' AND version=?`,
      [
        input.reason,
        input.actor,
        input.closedAtMs,
        input.updatedAtMs,
        input.deviceId,
        input.hlcPhysicalMs,
        input.hlcCounter,
        input.planId,
        input.version,
      ],
    );
    await store.run(
      `UPDATE plan SET status='ended',updated_at_ms=?,device_id=?,
      hlc_physical_ms=?,hlc_counter=? WHERE id=?`,
      [input.updatedAtMs, input.deviceId, input.hlcPhysicalMs, input.hlcCounter, input.planId],
    );
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
        input.windowStart,
        input.windowEnd,
        input.updatedAtMs,
        input.updatedAtMs,
      ],
    );
    const job = await store.get(
      `SELECT id FROM plan_reconciliation_job
      WHERE plan_id=? AND kind='cleanup' AND window_start_date_key=? AND window_end_date_key=?`,
      [input.planId, input.windowStart, input.windowEnd],
    );
    return z.object({ id: UlidSchema }).parse(job).id;
  };
  return {
    async close(input) {
      return store.transaction(async () => {
        let prior;
        try {
          prior = await hasReplay("plan.close", input.command);
        } catch (error) {
          if (error instanceof PlanCreationStoreError && error.code === "command-conflict")
            return { status: "rejected", reason: "command-conflict" };
          throw error;
        }
        if (prior !== undefined) {
          if (typeof prior.result_json !== "string") return fail();
          return PlanCloseResultSchema.parse(JSON.parse(prior.result_json));
        }
        const active = await readActive();
        if (active === null || active.plan_id !== input.planId)
          return { status: "rejected", reason: "no-active-plan" };
        if (active.version !== input.expectedVersion)
          return { status: "rejected", reason: "stale-version" };
        const windowStart = addCivilDays(input.todayDateKey, 1);
        const finalDateKey = addCivilDays(active.start_date_key, active.total_weeks * 7 - 1);
        const cleanupJobId = await persistClose({
          planId: input.planId,
          version: input.expectedVersion,
          reason: "stopped",
          actor: "athlete",
          closedAtMs: input.closedAtMs,
          updatedAtMs: Math.max(input.command.nowMs, input.closedAtMs),
          deviceId: input.command.deviceId,
          hlcPhysicalMs: input.command.hlcPhysicalMs,
          hlcCounter: input.command.hlcCounter,
          cleanupJobId: input.cleanupJobId,
          windowStart,
          windowEnd: Math.max(windowStart, finalDateKey),
        });
        const result = PlanCloseResultSchema.parse({
          status: "closed",
          planId: input.planId,
          closedAt: input.closedAtMs,
          cleanupJobId,
        });
        await recordCommand("plan.close", input.command, { planId: input.planId }, result);
        return result;
      });
    },
    async completeExpired({ todayDateKey, nowMs }) {
      return store.transaction(async () => {
        const active = await readActive();
        if (active === null) return { completedPlanId: null };
        const finalDateKey = addCivilDays(active.start_date_key, active.total_weeks * 7 - 1);
        if (finalDateKey >= todayDateKey) return { completedPlanId: null };
        const preview = await store.get(
          `SELECT hlc_physical_ms,hlc_counter FROM plan_change
          WHERE plan_id=? AND status='preview' ORDER BY hlc_physical_ms DESC,hlc_counter DESC LIMIT 1`,
          [active.plan_id],
        );
        const clock = z
          .object({
            hlc_physical_ms: z.number().int().nonnegative(),
            hlc_counter: z.number().int().nonnegative(),
          })
          .parse(preview ?? active);
        const hlcPhysicalMs = Math.max(nowMs, active.hlc_physical_ms, clock.hlc_physical_ms);
        const hlcCounter =
          Math.max(
            hlcPhysicalMs === active.hlc_physical_ms ? active.hlc_counter : 0,
            hlcPhysicalMs === clock.hlc_physical_ms ? clock.hlc_counter : 0,
          ) + 1;
        const windowStart = addCivilDays(finalDateKey, 1);
        await persistClose({
          planId: active.plan_id,
          version: active.version,
          reason: "completed",
          actor: "system:plan-completion",
          closedAtMs: nowMs,
          updatedAtMs: nowMs,
          deviceId: "system:plan-completion",
          hlcPhysicalMs,
          hlcCounter,
          cleanupJobId: identity.newId(),
          windowStart,
          windowEnd: windowStart,
        });
        return { completedPlanId: active.plan_id };
      });
    },
    async readClosedDetail(planId) {
      const row = await store.get(
        `SELECT planning_plan.plan_id,plan.name,plan.start_date_key,plan.total_weeks,
        planning_plan.status,planning_plan.close_reason,planning_plan.closed_at_ms,
        planning_plan.activated_at_ms,planning_plan.version,planning_plan.close_actor,activation.source_id AS creation_id,
        (SELECT status FROM plan_reconciliation_job WHERE plan_id=planning_plan.plan_id AND kind='cleanup'
          ORDER BY updated_at_ms DESC,id DESC LIMIT 1) AS cleanup_status
        FROM planning_plan JOIN plan ON plan.id=planning_plan.plan_id
        LEFT JOIN plan_revision AS activation ON activation.plan_id=planning_plan.plan_id
          AND activation.source_kind='activation'
        WHERE planning_plan.plan_id=? AND planning_plan.status='closed'`,
        [planId],
      );
      if (row === undefined) return null;
      const closed = ClosedRowSchema.parse(row);
      const revisionRow = await store.get(
        `SELECT revision_number,fingerprint,snapshot_json
        FROM plan_revision WHERE plan_id=? ORDER BY revision_number DESC LIMIT 1`,
        [planId],
      );
      if (revisionRow === undefined) return null;
      const revision = RevisionRowSchema.parse(revisionRow);
      return {
        plan: {
          planId: closed.plan_id,
          name: closed.name,
          startDateKey: closed.start_date_key,
          totalWeeks: closed.total_weeks,
          status: closed.status,
          closeReason: closed.close_reason,
          closedAtMs: closed.closed_at_ms,
          activatedAtMs: closed.activated_at_ms,
          version: closed.version,
          creationId: closed.creation_id,
        },
        closeActor: closed.close_actor,
        revision: {
          revisionNumber: revision.revision_number,
          fingerprint: revision.fingerprint,
          snapshot: JSON.parse(revision.snapshot_json),
        },
        cleanup:
          closed.cleanup_status === null
            ? "none"
            : closed.cleanup_status === "verified"
              ? "complete"
              : closed.cleanup_status === "failed"
                ? "failed"
                : "pending",
      };
    },
  };
}
