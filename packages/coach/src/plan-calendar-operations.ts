import {
  PlanCalendarRpcParamsSchema,
  type PlanCalendarRpcParams,
  type PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import { readWeekDelivery, saveWeekDelivery, weekDeliveryStep } from "@enduragent/engine/calendar";
import { createPlanCalendarMirrorRepository } from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";

export interface PlanCalendarOperations {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}

export function createPlanCalendarOperations(deps: {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly todayDateKey: () => number;
  readonly now: () => number;
}): PlanCalendarOperations {
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const plans = createLegacyPlanRepository(deps.store);
  return {
    async "plan.calendar"(raw) {
      const request = PlanCalendarRpcParamsSchema.parse(raw);
      switch (request.action) {
        case "read-settings":
          return { status: "settings", weekDelivery: await mirror.readWeekDeliverySetting() };
        case "save-settings":
          await mirror.writeWeekDeliverySetting(request.weekDelivery, deps.now());
          return { status: "settings", weekDelivery: request.weekDelivery };
        case "approve-weeks":
          return deps.store.transaction(async () => {
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
            return {
              status: "approved",
              weeks:
                request.scope.kind === "first-weeks"
                  ? [...result.state.firstSetWeeks]
                  : [request.scope.week],
            } as const;
          });
      }
    },
  };
}
