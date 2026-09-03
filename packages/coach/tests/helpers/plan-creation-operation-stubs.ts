import type { PlanCreationOperations } from "@enduragent/coach-contract";

export const planCreationOperationStubs = {
  "plan_creation.start": async () => ({
    status: "rejected",
    reason: "command-conflict",
  }),
  "plan_creation.answer": async () => ({
    status: "rejected",
    reason: "no-unfinished-creation",
    planCreation: null,
  }),
} satisfies PlanCreationOperations;
