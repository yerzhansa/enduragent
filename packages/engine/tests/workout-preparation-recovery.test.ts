import type { GenerateResult, LanguageModelPort } from "../src/sport.js";
import { describe, expect, it, vi } from "vitest";
import {
  assessWorkoutPreparation,
  workoutPreparationCorrectionMessages,
} from "../src/agent/workout-preparation-recovery.js";

const usage: GenerateResult["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

function result(text: string, finishReason: GenerateResult["finishReason"] = "stop") {
  return { text, finishReason, usage, toolCalls: [], steps: 1 } satisfies GenerateResult;
}

function budget() {
  return {
    chargeGenerateCall: vi.fn(),
    remainingMs: vi.fn(() => 12_345),
  };
}

describe("workout preparation assessment", () => {
  it("checks the full conversation and candidate without tools or streaming", async () => {
    const generate = vi.fn<LanguageModelPort["generate"]>(async () =>
      result("requires_preparation"),
    );
    const turnBudget = budget();
    const signal = new AbortController().signal;
    const messages = [
      { role: "user" as const, content: "Could you add an endurance ride tomorrow?" },
      { role: "assistant" as const, content: "That would fit after today's recovery." },
      { role: "user" as const, content: "Yes, do that." },
    ];

    await expect(
      assessWorkoutPreparation({
        llm: { generate },
        messages,
        candidate: "I'll prepare that for you.",
        budget: turnBudget,
        signal,
        cacheKey: "chat-key",
      }),
    ).resolves.toEqual({ kind: "requires_preparation" });

    expect(turnBudget.chargeGenerateCall).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        caller: "chat",
        cacheKey: "chat-key",
        deadlineMs: 12_345,
        maxOutputTokens: 256,
        messages: [
          ...messages,
          { role: "assistant", content: "I'll prepare that for you." },
          {
            role: "user",
            content:
              "Classify the candidate assistant reply immediately above. Return only the required enum value.",
          },
        ],
        signal,
      }),
    );
    const options = generate.mock.calls[0]?.[0];
    expect(options?.tools).toBeUndefined();
    expect(options?.onTextDelta).toBeUndefined();
    expect(options?.system).toContain("preparation_receipt=none");
    expect(options?.system).toContain("leaves the actionable request unfulfilled");
  });

  it.each([
    { name: "extra text", value: result("requires_preparation because it was requested") },
    { name: "truncated output", value: result("requires_preparation", "length") },
  ])("rejects $name instead of accepting an uncertain reply", async ({ value }) => {
    const generate = vi.fn<LanguageModelPort["generate"]>(async () => value);
    await expect(
      assessWorkoutPreparation({
        llm: { generate },
        messages: [],
        candidate: "The review is ready.",
        budget: budget(),
        signal: new AbortController().signal,
        cacheKey: "chat-key",
      }),
    ).resolves.toEqual({ kind: "assessment_failed", reason: "invalid_response" });
  });

  it("turns a provider failure into an assessment failure", async () => {
    const generate = vi.fn<LanguageModelPort["generate"]>(async () => {
      throw new Error("provider unavailable");
    });
    await expect(
      assessWorkoutPreparation({
        llm: { generate },
        messages: [],
        candidate: "The review is ready.",
        budget: budget(),
        signal: new AbortController().signal,
        cacheKey: "chat-key",
      }),
    ).resolves.toEqual({ kind: "assessment_failed", reason: "provider_failure" });
  });

  it("rethrows cancellation without accepting the candidate", async () => {
    const controller = new AbortController();
    const failure = new Error("canceled");
    const generate = vi.fn<LanguageModelPort["generate"]>(async () => {
      controller.abort();
      throw failure;
    });
    await expect(
      assessWorkoutPreparation({
        llm: { generate },
        messages: [],
        candidate: "The review is ready.",
        budget: budget(),
        signal: controller.signal,
        cacheKey: "chat-key",
      }),
    ).rejects.toBe(failure);
  });
});

it("appends the rejected reply and host correction to the original conversation", () => {
  const messages = [{ role: "user" as const, content: "Revise my pending workout." }];
  const corrected = workoutPreparationCorrectionMessages(messages, "The review is ready.");
  expect(corrected.slice(0, 2)).toEqual([
    ...messages,
    { role: "assistant", content: "The review is ready." },
  ]);
  expect(corrected[2]).toMatchObject({
    role: "system",
    content: expect.stringContaining("no workout proposal was submitted"),
  });
  expect(JSON.stringify(corrected[2])).toContain("read the canonical pending proposal first");
});
