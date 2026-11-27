import {
  PlanCalendarRpcParamsSchema,
  type PlanCalendarRpcParams,
  type PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import {
  readWeekDelivery,
  saveWeekDelivery,
  weekDeliveryStep,
  type CalendarMirrorPort,
} from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { todayInTZ } from "@enduragent/engine/sport";
import { changeDetail, keepChange, putBackChange } from "./plan-calendar-changes.js";
import type { PlanCalendarEditDeps } from "./plan-calendar-edit.js";
import { readPlanCalendar } from "./plan-calendar-read.js";

const SEND_AGAIN_WAIT_MS = 20_000;

export function dateKeyOfMsIn(timezone: () => string): (ms: number) => number {
  return (ms) => Number(todayInTZ(timezone(), new Date(ms)).replaceAll("-", ""));
}

async function settledWithin(settled: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export interface PlanCalendarOperations {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}

export function createPlanCalendarOperations(
  deps: PlanCalendarEditDeps & {
    readonly store: SqlStore & Pick<MigratorStore, "transaction">;
    readonly calendar: { readonly mirror: CalendarMirrorPort };
    readonly todayDateKey: () => number;
    readonly now: () => number;
    readonly calendarConnected: () => boolean;
    readonly dateKeyOfMs: (ms: number) => number;
    readonly changed: () => Promise<void>;
  },
): PlanCalendarOperations {
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const plans = createLegacyPlanRepository(deps.store);
  return {
    async "plan.calendar"(raw) {
      const request = PlanCalendarRpcParamsSchema.parse(raw);
      switch (request.action) {
        case "read":
          return readPlanCalendar(
            {
              store: deps.store,
              todayDateKey: deps.todayDateKey(),
              calendarConnected: deps.calendarConnected(),
              dateKeyOfMs: deps.dateKeyOfMs,
            },
            request,
          );
        case "send-again":
          await createPlanReconciliationRepository(deps.store).reopenFailedCleanups(deps.now());
          await settledWithin(deps.changed, SEND_AGAIN_WAIT_MS);
          return { status: "sending" };
        case "read-settings":
          return { status: "settings", weekDelivery: await mirror.readWeekDeliverySetting() };
        case "change-detail":
        case "keep-change":
        case "put-back": {
          const changeDeps = { ...deps, mirror: deps.calendar.mirror };
          if (request.action === "change-detail") return changeDetail(changeDeps, request);
          if (request.action === "keep-change") return keepChange(changeDeps, request);
          return putBackChange(changeDeps, request);
        }
        case "save-settings":
          await mirror.writeWeekDeliverySetting(request.weekDelivery, deps.now());
          void deps.changed();
          return { status: "settings", weekDelivery: request.weekDelivery };
        case "approve-weeks": {
          const approved = await deps.store.transaction(async () => {
            const active = await deps.store.get(
              "SELECT plan_id FROM planning_plan WHERE plan_id=? AND status='active'",
              [request.planId],
            );
            const plan = active === undefined ? undefined : await plans.read(request.planId);
            if (plan === undefined || plan.status !== "active") {
              return { status: "refused", reason: "no-active-plan" } as const;
            }
            const todayDateKey = deps.todayDateKey();
            const delivery = await readWeekDelivery(mirror, plan.id);
            const result = weekDeliveryStep(
              plan,
              delivery,
              request.scope.kind === "first-weeks"
                ? { type: "first-approve", todayDateKey }
                : { type: "approve-week", week: request.scope.week, todayDateKey },
            );
            if (result.kind === "refused")
              return { status: "refused", reason: result.reason } as const;
            await saveWeekDelivery(mirror, plan.id, result.state, deps.now());
            if (result.state.kind !== "approved") {
              return { status: "refused", reason: "not-approved-yet" } as const;
            }
            await createPlanReconciliationRepository(deps.store).reopenFailedCleanups(deps.now());
            return {
              status: "approved",
              weeks:
                request.scope.kind === "first-weeks"
                  ? [...result.state.firstSetWeeks]
                  : [request.scope.week],
            } as const;
          });
          if (approved.status === "approved") void deps.changed();
          return approved;
        }
      }
    },
  };
}
