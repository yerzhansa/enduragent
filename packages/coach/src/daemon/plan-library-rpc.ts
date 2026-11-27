import { COACH_RPC_METHOD_REGISTRY, type CoachRpcService } from "@enduragent/coach-contract";

export type PlanLibraryMethod = "plan.list" | "plan.close" | "plan.history" | "plan.calendar";

export type PlanLibraryOperations = Partial<Pick<CoachRpcService, PlanLibraryMethod>>;

function required<T>(operation: T | undefined, unavailable: string): T {
  if (operation === undefined) throw new TypeError(unavailable);
  return operation;
}

export async function callPlanLibraryMethod(
  method: PlanLibraryMethod,
  params: unknown,
  operations: PlanLibraryOperations,
): Promise<unknown> {
  switch (method) {
    case "plan.list": {
      const request = COACH_RPC_METHOD_REGISTRY["plan.list"].requestSchema.parse(params);
      return required(operations["plan.list"], "Plan library operation is unavailable.")(request);
    }
    case "plan.close": {
      const request = COACH_RPC_METHOD_REGISTRY["plan.close"].requestSchema.parse(params);
      return required(operations["plan.close"], "Plan closure operation is unavailable.")(request);
    }
    case "plan.history": {
      const request = COACH_RPC_METHOD_REGISTRY["plan.history"].requestSchema.parse(params);
      return required(
        operations["plan.history"],
        "Plan history operation is unavailable.",
      )(request);
    }
    case "plan.calendar": {
      const request = COACH_RPC_METHOD_REGISTRY["plan.calendar"].requestSchema.parse(params);
      return required(
        operations["plan.calendar"],
        "Plan calendar operation is unavailable.",
      )(request);
    }
  }
}
