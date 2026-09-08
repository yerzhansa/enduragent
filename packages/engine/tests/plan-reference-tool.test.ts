import type { PlanningReadModel } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { createPlanReferenceTool } from "../src/agent/plan-reference-tool.js";
import { createTurnContext } from "../src/agent/turn-context.js";

const planning: PlanningReadModel = {
  schemaVersion: 1,
  status: "ready",
  asOfDateKey: 20260826,
  plan: {
    id: "plan-1",
    name: "Twelve-week base",
    goal: "Build consistency",
    lifecycle: "active",
    startDateKey: 20260824,
    targetDateKey: null,
    currentWeek: 1,
    totalWeeks: 12,
    phase: "Base",
    weekStartDateKey: 20260824,
    weekEndDateKey: 20260830,
    workouts: [
      {
        id: "workout-1",
        dateKey: 20260826,
        sport: "cycling",
        name: "Tempo builder",
        durationSeconds: 3_600,
        targets: "3 × 8 min",
        purpose: "Sustainable power",
        safetyGuardrail: "Stop if the warm-up feels wrong",
        origin: "coach",
        navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
      },
    ],
    todayWorkout: null,
    navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
  },
};

async function execute(
  request: unknown,
  context = createTurnContext({
    language: { language: "en", source: "default", locale: "en-GB" },
    resolvedCs: null,
    chatId: "desktop",
    athleteText: "Show my Plan",
    turnId: "turn-1",
  }),
) {
  const read = vi.fn(async () => planning);
  const planTool = createPlanReferenceTool({ planning: { getPlanningReadModel: read } });
  const result = await (planTool.execute as (input: unknown, options: unknown) => Promise<unknown>)(
    request,
    { experimental_context: context },
  );
  return { context, read, result };
}

describe("read_plan_reference tool", () => {
  it.each([
    ["active_plan_summary", { kind: "active_plan_summary", planId: "plan-1" }],
    ["current_week", { kind: "current_week", planId: "plan-1", weekNumber: 1 }],
  ] as const)("records one typed %s selection for Desktop", async (kind, selection) => {
    const value = await execute({ kind });
    expect(value.read).toHaveBeenCalledOnce();
    expect(value.context.planReference.selection).toEqual(selection);
    expect(value.result).toMatchObject({ status: "ready", selection });
  });

  it("requires the exact Planning-owned workout ID", async () => {
    const ready = await execute({ kind: "workout_detail", workoutId: "workout-1" });
    expect(ready.context.planReference.selection).toEqual({
      kind: "workout_detail",
      planId: "plan-1",
      workoutId: "workout-1",
    });
    const missing = await execute({ kind: "workout_detail", workoutId: "made-up" });
    expect(missing.result).toEqual({ status: "unavailable", reason: "workout-not-found" });
    expect(missing.context.planReference.selection).toBeNull();
  });

  it("returns Plan data outside Desktop without recording a host card", async () => {
    const context = createTurnContext({
      language: { language: "en", source: "default", locale: "en-GB" },
      resolvedCs: null,
      chatId: "telegram:42",
      athleteText: "Show my Plan",
      turnId: "turn-1",
    });
    const value = await execute({ kind: "active_plan_summary" }, context);
    expect(value.result).toMatchObject({ status: "ready" });
    expect(context.planReference.selection).toBeNull();
  });
});
