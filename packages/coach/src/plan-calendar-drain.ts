import { cleanupPlanMirror, type PlanMirrorCalendarPort } from "@enduragent/engine";
import {
  cleanupPlanCalendar,
  dueWindow,
  firstChangeSetWeeks,
  mirrorPlanCalendar,
  observeIcuCopies,
  readWeekDelivery,
  saveWeekDelivery,
  type CalendarMirrorPort,
} from "@enduragent/engine/calendar";
import {
  addCivilDays,
  createPlanCalendarMirrorRepository,
  createPlanCleanupHoldRepository,
  createPlanReconciliationRepository,
  type PlanIcuWriteErrorCode,
  type PlanReconciliationErrorCode,
  type PlanReconciliationJobRecord,
  type PlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";

export interface PlanCalendarDrain {
  kick(options?: { reclaimRunning?: boolean }): Promise<void>;
  idle(): Promise<void>;
}

const MIRROR_FAILURE_BUDGET = 5;
const CLEANUP_RETRY_MS = 900_000;
const HELD_OBSERVE_MS = 300_000;

function jobErrorCode(failure: PlanIcuWriteErrorCode | undefined): PlanReconciliationErrorCode {
  if (failure === "calendar-create-failed" || failure === "calendar-delete-failed") return failure;
  return "calendar-verification-failed";
}

async function retireJob(
  repository: PlanReconciliationRepository,
  jobId: string,
  nowMs: number,
): Promise<void> {
  for (const item of await repository.readItems(jobId)) await repository.deleteItem(item.id);
  await repository.beginAttempt(jobId, nowMs);
  await repository.verifyJob(jobId, nowMs);
}

async function ledgerWindow(
  store: SqlStore & Pick<MigratorStore, "transaction">,
  planId: string,
  today: number,
): Promise<{ readonly endDateKey: number } | null> {
  const plan = await createLegacyPlanRepository(store).read(planId);
  if (plan === undefined || plan.status !== "active") return null;
  return dueWindow({ plan, workouts: [], todayDateKey: today, firstEligibleDateKey: today });
}

async function todaysMirrorJob(
  repository: PlanReconciliationRepository,
  input: {
    readonly planId: string;
    readonly todayDateKey: number;
    readonly windowEndDateKey: number;
    readonly newId: () => string;
    readonly nowMs: number;
  },
): Promise<PlanReconciliationJobRecord> {
  return repository.createOrGetJob({
    id: input.newId(),
    planId: input.planId,
    kind: "mirror",
    windowStartDateKey: input.todayDateKey,
    windowEndDateKey: input.windowEndDateKey,
    createdAtMs: input.nowMs,
  });
}

function hasTransactions(store: SqlStore): store is SqlStore & Pick<MigratorStore, "transaction"> {
  return "transaction" in store && typeof store.transaction === "function";
}

export function createPlanCalendarDrain(deps: {
  store: SqlStore;
  calendar: PlanMirrorCalendarPort & { readonly mirror: CalendarMirrorPort };
  calendarConnected: () => boolean;
  identity: { newUlid(): string };
  todayDateKey: () => number;
  now: () => number;
  logger: { warn(event: string, fields?: Record<string, unknown>): void };
}): PlanCalendarDrain {
  let active: Promise<void> | undefined;
  const observedAt = new Map<string, number>();
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
    await store.transaction(() =>
      createPlanCleanupHoldRepository(store).releaseOrphans({
        closedOnDateKey: today,
        nowMs: deps.now(),
        newId: () => deps.identity.newUlid(),
      }),
    );
    const jobs = await repository.listRunnable({
      nowMs: deps.now(),
      leaseMs: reclaim ? 0 : 300_000,
      maxFailures: MIRROR_FAILURE_BUDGET,
      cleanupRetryMs: CLEANUP_RETRY_MS,
    });
    const mirrorDeps = {
      calendar: deps.calendar.mirror,
      workouts: (planId: string) => plans.readWorkouts(planId),
      mirror: createPlanCalendarMirrorRepository(store),
      reconciliation: repository,
      now: deps.now,
    };
    for (const planId of await createPlanCleanupHoldRepository(store).readHeldPlanIds()) {
      const seenAt = observedAt.get(planId);
      if (seenAt !== undefined && deps.now() - seenAt < HELD_OBSERVE_MS) continue;
      observedAt.set(planId, deps.now());
      const held = await plans.read(planId);
      if (held === undefined) continue;
      const window = {
        planId,
        workouts: await plans.readWorkouts(planId),
        startDateKey: addCivilDays(today, 1),
        endDateKey: addCivilDays(held.startDateKey, held.totalWeeks * 7 - 1),
      };
      if (window.startDateKey > window.endDateKey) continue;
      try {
        await observeIcuCopies(window, mirrorDeps);
      } catch (error) {
        deps.logger.warn("plan_calendar_drain_failed", { planId, kind: "held", error });
      }
    }
    for (const job of jobs) {
      try {
        const chatPlan = await store.get("SELECT plan_id FROM planning_plan WHERE plan_id=?", [
          job.planId,
        ]);
        if (job.kind === "cleanup" && chatPlan !== undefined) {
          await cleanupPlanCalendar(job, mirrorDeps);
          continue;
        }
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
        if (chatPlan === undefined) continue;
        const delivery = await mirrorDeps.mirror.readDelivery(job.planId);
        if (delivery?.stateKind === "waiting-for-first-approve") continue;
        const ledger = await ledgerWindow(store, job.planId, today);
        if (
          ledger !== null &&
          job.windowStartDateKey === today &&
          job.windowEndDateKey === ledger.endDateKey
        ) {
          continue;
        }
        await retireJob(repository, job.id, deps.now());
      } catch (error) {
        deps.logger.warn("plan_calendar_drain_failed", { jobId: job.id, kind: job.kind, error });
        const current = await repository.readJob(job.id);
        if (current?.status === "running" || current?.status === "retrying") {
          await repository.failJob(job.id, "calendar-verification-failed", deps.now());
        }
      }
    }
    const due = await store.transaction(async () => {
      const activePlan = await store.get(
        "SELECT plan_id, version FROM planning_plan WHERE status='active'",
      );
      if (typeof activePlan?.plan_id !== "string") return null;
      const plan = await plans.read(activePlan.plan_id);
      if (plan === undefined || plan.status !== "active") return null;
      if ((await mirrorDeps.mirror.readDelivery(plan.id)) === undefined) {
        await saveWeekDelivery(
          mirrorDeps.mirror,
          plan.id,
          { kind: "approved", firstSetWeeks: firstChangeSetWeeks(plan, today), approvedWeeks: [] },
          deps.now(),
        );
      }
      const delivery = await readWeekDelivery(mirrorDeps.mirror, plan.id);
      if (delivery.kind === "waiting-for-first-approve") return null;
      const barrier = await repository.readCleanupBarrier();
      if (barrier !== undefined && barrier.status !== "verified") return null;
      const input = {
        plan,
        workouts: await plans.readWorkouts(plan.id),
        todayDateKey: today,
        firstEligibleDateKey: Math.max(today, barrier?.windowStartDateKey ?? today),
      };
      const window = dueWindow(input);
      return window === null ? null : { version: activePlan.version, plan, input, window };
    });
    if (due === null) return;
    const { plan, input, window } = due;
    const job = await todaysMirrorJob(repository, {
      planId: plan.id,
      todayDateKey: today,
      windowEndDateKey: window.endDateKey,
      newId: () => deps.identity.newUlid(),
      nowMs: deps.now(),
    });
    if (job.status === "failed" && job.failureCount >= MIRROR_FAILURE_BUDGET) return;
    if (job.status === "verified") await repository.reopenJob(job.id, deps.now());
    await repository.beginAttempt(job.id, deps.now());
    try {
      const result = await mirrorPlanCalendar(input, mirrorDeps);
      if (result.kind === "list-failed") {
        await repository.failJob(job.id, "calendar-list-failed", deps.now());
      } else if (result.kind === "ran" && result.failures.length > 0) {
        await repository.failJob(job.id, jobErrorCode(result.failures[0]), deps.now());
      } else {
        await repository.verifyJob(job.id, deps.now());
      }
    } catch (error) {
      deps.logger.warn("plan_calendar_drain_failed", { planId: plan.id, kind: "mirror", error });
      await repository.failJob(job.id, "calendar-verification-failed", deps.now());
    }
    const current = await store.get("SELECT version FROM planning_plan WHERE plan_id=?", [plan.id]);
    if (current?.version !== due.version) rerun = true;
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
