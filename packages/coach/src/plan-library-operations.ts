import { z } from "zod";
import {
  ListPlansParamsSchema,
  ListPlansResultSchema,
  PlanCloseRpcParamsSchema,
  PlanCloseResultSchema,
  PlanCreationDraftSchema,
  PlanHistoryParamsSchema,
  PlanHistoryResultSchema,
  type LegacyPlanSummary,
  type ListPlansParams,
  type ListPlansResult,
  type PlanCalendarStatus,
  type PlanChangeEventSource,
  type PlanCloseRpcParams,
  type PlanCloseResult,
  type PlanCreationCardModel,
  type PlanHistoryParams,
  type PlanHistoryResult,
} from "@enduragent/coach-contract";
import {
  addCivilDays,
  createPlanChangeRepository,
  createPlanLifecycleRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanCreationCommandStamp,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
  type PlanReconciliationJobRecord,
  type PlanSummaryRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  closedPlanCalendar,
  dateText,
  planCalendarStatus,
  plansWaitingForApprove,
} from "./plan-calendar-status.js";
import {
  projectPlanChanges,
  projectPendingChangeCheck,
  readPlanChangesPaused,
  projectTodayChoice,
  readClosedPlanOccupiesToday,
} from "./plan-change-operations.js";

export interface PlanLibraryOperations {
  "plan.list"(request: ListPlansParams): Promise<ListPlansResult>;
  "plan.close"(request: PlanCloseRpcParams): Promise<PlanCloseResult>;
  "plan.history"(request: PlanHistoryParams): Promise<PlanHistoryResult>;
}

export function createPlanLibraryOperations(input: {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly repository: PlanCreationRepository;
  readonly identity: Pick<AuthoredIdentity, "newUlid">;
  readonly crypto: Crypto;
  readonly eventSources: { read(): Promise<PlanChangeEventSource[]> };
  readonly calendarConnected: () => boolean;
  readonly intervalsConfigured: () => boolean;
  readonly legacyPlan: () => Promise<LegacyPlanSummary | null>;
  readonly todayDateKey: () => number;
  readonly timezone: () => string;
  readonly now: () => number;
  readonly stamp: (commandId: string, digest: string) => Promise<PlanCreationCommandStamp>;
  readonly digest: (value: unknown) => Promise<string>;
  readonly project: (snapshot: PlanCreationSnapshot) => Promise<PlanCreationCardModel>;
  readonly ready: () => Promise<void>;
}): PlanLibraryOperations {
  const {
    calendarConnected,
    intervalsConfigured,
    legacyPlan,
    todayDateKey,
    timezone,
    now,
    stamp,
    digest,
    project,
    ready,
  } = input;
  const plans = createPlanRepository(input.store);
  const lifecycle = createPlanLifecycleRepository(input.store, {
    newId: () => input.identity.newUlid(),
  });
  const timestampDate = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString().slice(0, 10);
  const summarizeCalendar = (
    job: PlanReconciliationJobRecord | undefined,
    waitingForApprove = false,
  ): PlanCalendarStatus =>
    planCalendarStatus({ job, connected: calendarConnected(), waitingForApprove });
  const summarizePlan = (plan: PlanSummaryRecord) => ({
    planId: plan.planId,
    version: plan.version,
    name: plan.name,
    start: dateText(plan.startDateKey),
    end: dateText(addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1)),
    weeks: plan.totalWeeks,
    status: plan.status,
    closeReason: plan.closeReason,
    closedAt: timestampDate(plan.closedAtMs),
    activatedAt: timestampDate(plan.activatedAtMs),
    creationId: plan.creationId,
  });
  const supportingEventCandidates = async (planId: string, sources: PlanChangeEventSource[]) => {
    if (sources.length === 0) return [];
    const revision = await input.store.get(
      "SELECT snapshot_json FROM plan_revision WHERE plan_id=? ORDER BY revision_number DESC LIMIT 1",
      [planId],
    );
    const accepted = new Set(
      revision === undefined
        ? []
        : PlanCreationDraftSchema.parse(
            JSON.parse(z.string().parse(revision.snapshot_json)),
          ).supportingEvents.flatMap((event) =>
            event.source.kind === "synced" ? [event.source.providerId] : [],
          ),
    );
    return sources
      .filter((source) => !accepted.has(source.providerId))
      .map(({ providerId, name, date, category }) => ({
        providerId,
        name,
        date,
        category,
        sourceLabel: "Intervals.icu event",
      }));
  };
  return {
    async "plan.list"(request) {
      const { retryCalendar } = ListPlansParamsSchema.parse(request);
      await ready();
      const legacy = await legacyPlan();
      const sources = intervalsConfigured() ? await input.eventSources.read() : [];
      return input.store.transaction(async () => {
        const transactionStore = {
          exec: (sql: string) => input.store.exec(sql),
          get: input.store.get.bind(input.store),
          all: input.store.all.bind(input.store),
          run: input.store.run.bind(input.store),
          close: () => input.store.close(),
          transaction: async <T>(run: () => Promise<T>): Promise<T> => run(),
        };
        await createPlanLifecycleRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
        }).completeExpired({ todayDateKey: todayDateKey(), nowMs: now() });
        const planChanges = createPlanChangeRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
          sha256: async (text) => {
            const digest = await input.crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text),
            );
            return [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          },
        });
        const creation = await input.repository.readUnfinished();
        const records = await plans.listPlans();
        const reconciliation = createPlanReconciliationRepository(transactionStore);
        if (retryCalendar === true) await reconciliation.reopenFailedCleanups(now());
        const jobs = new Map(
          (await reconciliation.readLatestJobsForLibrary()).map((job) => [
            `${job.planId}:${job.kind}`,
            job,
          ]),
        );
        const barrier = await reconciliation.readCleanupBarrier();
        const holding = barrier?.status !== "verified" ? barrier : undefined;
        const waiting = await plansWaitingForApprove(transactionStore);
        const summaries = records.map((plan) => ({
          ...summarizePlan(plan),
          calendar: summarizeCalendar(
            (plan.status === "active" ? holding : undefined) ??
              jobs.get(`${plan.planId}:${plan.status === "active" ? "mirror" : "cleanup"}`),
            waiting.has(plan.planId),
          ),
        }));
        const active = summaries.find((plan) => plan.status === "active") ?? null;
        const choiceDateKey = todayDateKey();
        const activeRevision =
          active === null
            ? undefined
            : await transactionStore.get(
                `SELECT revision.snapshot_json FROM planning_plan plan
          JOIN plan_revision revision ON revision.plan_id=plan.plan_id AND revision.revision_number=plan.current_revision_number
          WHERE plan.plan_id=?`,
                [active.planId],
              );
        const activeDraft =
          activeRevision === undefined
            ? null
            : PlanCreationDraftSchema.safeParse(
                JSON.parse(z.string().parse(activeRevision.snapshot_json)),
              );
        const todayChoice = !activeDraft?.success
          ? null
          : projectTodayChoice(
              activeDraft.data,
              choiceDateKey,
              await readClosedPlanOccupiesToday(transactionStore, choiceDateKey),
              new Set(),
              timezone(),
            );
        return ListPlansResultSchema.parse({
          calendarConnected: calendarConnected(),
          legacy,
          creation: creation === undefined ? null : await project(creation),
          active:
            active === null
              ? null
              : {
                  ...active,
                  todayChoice,
                  supportingEventCandidates: await supportingEventCandidates(
                    active.planId,
                    sources,
                  ),
                },
          changesPaused:
            active === null
              ? null
              : await readPlanChangesPaused({
                  calendarConnected: async () => intervalsConfigured(),
                  syncStatus: () =>
                    createPlanWorkoutMatchRepository(transactionStore).readSyncStatus(),
                  now,
                }),
          pendingChangeCheck:
            active === null
              ? null
              : await projectPendingChangeCheck(transactionStore, active.planId),
          changes:
            active === null
              ? []
              : await projectPlanChanges({
                  repository: planChanges,
                  store: transactionStore,
                  planId: active.planId,
                  todayDateKey: todayDateKey(),
                }),
          closed: summaries.filter((plan) => plan.status === "closed"),
        });
      });
    },
    async "plan.close"(request) {
      const parsed = PlanCloseRpcParamsSchema.parse(request);
      const command = await stamp(parsed.commandId, await digest(parsed));
      return PlanCloseResultSchema.parse(
        await lifecycle.close({
          command,
          planId: parsed.planId,
          expectedVersion: parsed.expectedVersion,
          closedAtMs: now(),
          todayDateKey: todayDateKey(),
          cleanupJobId: input.identity.newUlid(),
        }),
      );
    },
    async "plan.history"(request) {
      const parsed = PlanHistoryParamsSchema.parse(request);
      return input.store.transaction(async () => {
        const transactionStore = {
          exec: (sql: string) => input.store.exec(sql),
          get: input.store.get.bind(input.store),
          all: input.store.all.bind(input.store),
          run: input.store.run.bind(input.store),
          close: () => input.store.close(),
          transaction: async <T>(run: () => Promise<T>): Promise<T> => run(),
        };
        const detail = await createPlanLifecycleRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
        }).readClosedDetail(parsed.planId);
        return PlanHistoryResultSchema.parse(
          detail === null
            ? null
            : {
                ...detail,
                plan: {
                  ...summarizePlan(detail.plan),
                  calendar: await closedPlanCalendar(transactionStore, {
                    planId: detail.plan.planId,
                    connected: calendarConnected(),
                  }),
                },
              },
        );
      });
    },
  };
}
