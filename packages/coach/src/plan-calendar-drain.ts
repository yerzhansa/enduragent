import {
  cleanupPlanMirror,
  reconcileActivePlanWindow,
  verifyPlanMirror,
  type PlanMirrorCalendarPort,
} from "@enduragent/engine";
import { addCivilDays, createPlanReconciliationRepository } from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";

export interface PlanCalendarDrain {
  kick(options?: { reclaimRunning?: boolean }): Promise<void>;
  idle(): Promise<void>;
}

function hasTransactions(store: SqlStore): store is SqlStore & Pick<MigratorStore, "transaction"> {
  return "transaction" in store && typeof store.transaction === "function";
}

export function createPlanCalendarDrain(deps: {
  store: SqlStore;
  calendar: PlanMirrorCalendarPort;
  calendarConnected: () => boolean;
  identity: { newUlid(): string };
  todayDateKey: () => number;
  now: () => number;
  logger: { warn(event: string, fields?: Record<string, unknown>): void };
}): PlanCalendarDrain {
  let active: Promise<void> | undefined;
  let rerun = false;
  let reclaimRunning = false;

  const run = async (reclaim: boolean): Promise<void> => {
    const { store } = deps;
    if (!hasTransactions(store))
      throw new TypeError("Calendar reconciliation requires transactions.");
    const repository = createPlanReconciliationRepository(store);
    const plans = createLegacyPlanRepository(store);
    const engine = {
      repository,
      calendar: deps.calendar,
      identity: { newId: () => deps.identity.newUlid() },
      now: deps.now,
    };
    const today = deps.todayDateKey();
    const activePlan = await store.get("SELECT plan_id FROM planning_plan WHERE status='active'");
    if (typeof activePlan?.plan_id === "string") {
      const existing = await store.get(
        "SELECT id FROM plan_reconciliation_job WHERE plan_id=? AND kind='mirror' AND window_start_date_key=?",
        [activePlan.plan_id, today],
      );
      if (existing === undefined) {
        await repository.createOrGetJob({
          id: deps.identity.newUlid(),
          planId: activePlan.plan_id,
          kind: "mirror",
          windowStartDateKey: today,
          windowEndDateKey: addCivilDays(today, 6),
          createdAtMs: deps.now(),
        });
      }
    }
    const jobs = await repository.listRunnable({
      nowMs: deps.now(),
      leaseMs: reclaim ? 0 : 300_000,
      maxFailures: 5,
    });
    for (const job of jobs) {
      try {
        if (job.kind === "cleanup") {
          await cleanupPlanMirror(
            {
              planId: job.planId,
              todayDateKey: today,
              startDateKey: job.windowStartDateKey,
              endDateKey: job.windowEndDateKey,
            },
            engine,
          );
          continue;
        }
        const target = await store.get(
          "SELECT status, version FROM planning_plan WHERE plan_id=?",
          [job.planId],
        );
        if (target?.status !== "active" || job.windowStartDateKey > today) continue;
        if (job.windowStartDateKey < today) {
          if ((await repository.readItems(job.id)).length > 0) {
            await verifyPlanMirror(job, engine);
          } else {
            await repository.beginAttempt(job.id, deps.now());
            await repository.verifyJob(job.id, deps.now());
          }
          continue;
        }
        const plan = await plans.read(job.planId);
        if (plan === undefined || plan.status !== "active") continue;
        const tomorrow = addCivilDays(today, 1);
        const cleanup = await store.get(
          "SELECT id FROM plan_reconciliation_job WHERE kind='cleanup' AND plan_id<>? AND window_start_date_key=? LIMIT 1",
          [job.planId, tomorrow],
        );
        await reconcileActivePlanWindow(
          {
            plan,
            workouts: await plans.readWorkouts(job.planId),
            todayDateKey: today,
            firstEligibleDateKey: cleanup === undefined ? today : tomorrow,
          },
          engine,
        );
        const current = await store.get("SELECT version FROM planning_plan WHERE plan_id=?", [
          job.planId,
        ]);
        if (current?.version !== target.version) {
          await repository.reopenJob(job.id, deps.now());
          rerun = true;
        }
      } catch (error) {
        deps.logger.warn("plan_calendar_drain_failed", { jobId: job.id, kind: job.kind, error });
        const current = await repository.readJob(job.id);
        if (current?.status === "running" || current?.status === "retrying") {
          await repository.failJob(job.id, "calendar-verification-failed", deps.now());
        }
      }
    }
  };

  return {
    kick(options) {
      reclaimRunning ||= options?.reclaimRunning === true;
      if (!deps.calendarConnected()) return Promise.resolve();
      if (active !== undefined) {
        rerun = true;
        return Promise.resolve();
      }
      rerun = false;
      active = Promise.resolve().then(async () => {
        try {
          for (;;) {
            const reclaim = reclaimRunning;
            reclaimRunning = false;
            try {
              await run(reclaim);
            } catch (error) {
              deps.logger.warn("plan_calendar_drain_failed", { error });
            }
            if (!rerun || !deps.calendarConnected()) break;
            rerun = false;
          }
        } finally {
          active = undefined;
        }
      });
      return active;
    },
    async idle() {
      while (active !== undefined) await active;
    },
  };
}
