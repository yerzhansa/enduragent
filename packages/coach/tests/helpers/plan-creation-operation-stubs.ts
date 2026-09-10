import type { PlanCreationOperations, PlanChangeOperations } from "@enduragent/coach-contract";

export const planCreationOperationStubs = {
  "plan.close": async () => ({
    status: "rejected",
    reason: "no-active-plan",
  }),
  "plan_creation.start": async () => ({
    status: "rejected",
    reason: "command-conflict",
  }),
  "plan_creation.answer": async () => ({
    status: "rejected",
    reason: "no-unfinished-creation",
    planCreation: null,
  }),
  "plan_creation.preview": async () => ({
    status: "rejected",
    reason: "no-unfinished-creation",
    planCreation: null,
  }),
  "plan_creation.discard": async () => ({
    status: "rejected",
    reason: "no-unfinished-creation",
    planCreation: null,
  }),
  "plan_creation.activate": async () => {
    throw new Error("No unfinished creation");
  },
  "plan_change.preview": async () => ({ status: "rejected", reason: "no-active-plan" }),
  "plan_change.apply": async () => ({ status: "rejected", reason: "no-active-plan" }),
} satisfies PlanCreationOperations & PlanChangeOperations;
