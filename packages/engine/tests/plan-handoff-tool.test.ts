import { describe, expect, it } from "vitest";
import { createPlanHandoffTool } from "../src/agent/plan-handoff-tool.js";
import { createTurnContext } from "../src/agent/turn-context.js";

const suggestion = {
  kind: "plan_change" as const,
  title: "Review a lighter Friday",
  intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
  requestedDate: "2026-08-29",
};

async function execute(chatId: string, request: unknown = suggestion) {
  const context = createTurnContext({
    language: { language: "en", source: "default", locale: "en-GB" },
    resolvedCs: null,
    chatId,
    athleteText: "Can we move Friday?",
    turnId: "turn-1",
  });
  const handoffTool = createPlanHandoffTool();
  const result = await (
    handoffTool.execute as (input: unknown, options: unknown) => Promise<unknown>
  )(request, { toolCallId: "tool-1", experimental_context: context });
  return { context, result };
}

describe("request_plan_handoff tool", () => {
  it("records one strict host-owned suggestion for Desktop", async () => {
    const value = await execute("desktop");
    expect(value.context.planHandoff.suggestion).toEqual(suggestion);
    expect(value.result).toEqual({ status: "ready", suggestion });
  });

  it("returns the suggestion without recording a host card outside Desktop", async () => {
    const value = await execute("telegram:42");
    expect(value.context.planHandoff.suggestion).toBeNull();
    expect(value.result).toEqual({ status: "ready", suggestion });
  });

  it("rejects arbitrary markup fields", async () => {
    await expect(
      execute("desktop", { ...suggestion, markup: "<button>Apply</button>" }),
    ).rejects.toThrow();
  });

  it("keeps the first Desktop suggestion when the model calls twice", async () => {
    const context = createTurnContext({
      language: { language: "en", source: "default", locale: "en-GB" },
      resolvedCs: null,
      chatId: "desktop",
      athleteText: "Can we move Friday?",
      turnId: "turn-1",
    });
    const handoffTool = createPlanHandoffTool();
    const executeTool = handoffTool.execute as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    const options = { toolCallId: "tool-1", experimental_context: context };
    await executeTool(suggestion, options);
    const second = await executeTool(
      { ...suggestion, title: "A different card", intent: "A different request." },
      options,
    );
    expect(context.planHandoff.suggestion).toEqual(suggestion);
    expect(second).toEqual({ status: "ready", suggestion });
  });
});
