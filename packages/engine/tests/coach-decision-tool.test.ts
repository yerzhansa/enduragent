import { describe, expect, it } from "vitest";
import type { CoachDecisionStorePort } from "../src/host-ports.js";
import {
  createCoachDecisionTool,
  numberedDecisionFallback,
} from "../src/agent/coach-decision-tool.js";
import { createTurnContext } from "../src/agent/turn-context.js";

const request = {
  question: "Choose tomorrow's priority.",
  options: [
    {
      label: "Recovery",
      description: "Ride easy.",
      recommended: true,
      consequence: "Tomorrow becomes a recovery day.",
    },
    {
      label: "Tempo",
      description: "Keep the planned work.",
      recommended: false,
      consequence: "Tomorrow keeps the tempo session.",
    },
  ],
};

describe("request_user_decision tool", () => {
  it("renders the Recommended option first in numbered fallback text", () => {
    const reversed = { ...request, options: [...request.options].reverse() };
    expect(numberedDecisionFallback(reversed).split("\n").slice(1, 3)).toEqual([
      "1. Recovery (Recommended) — Ride easy.",
      "2. Tempo — Keep the planned work.",
    ]);
  });

  it("captures deterministic numbered fallback text when durable creation fails", async () => {
    const store = {
      appendDecisionRequested: () => {
        throw new Error("disk full");
      },
    } as unknown as CoachDecisionStorePort;
    const context = createTurnContext({
      language: { language: "en", source: "default", locale: "en-GB" },
      resolvedCs: null,
      chatId: "desktop",
      athleteText: "What should I do?",
    });
    const decisionTool = createCoachDecisionTool({
      store,
      randomId: () => "id",
      now: () => 0,
    });

    await expect(
      (decisionTool.execute as (input: unknown, options: unknown) => Promise<unknown>)(request, {
        toolCallId: "tool-1",
        experimental_context: context,
      }),
    ).rejects.toThrow("disk full");
    expect(context.decision.requested).toBeNull();
    expect(context.decision.fallbackText).toBe(numberedDecisionFallback(request));
  });
});
