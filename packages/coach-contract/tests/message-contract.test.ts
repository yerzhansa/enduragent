import { describe, expect, it } from "vitest";
import { ChatResponseSchema } from "../src/engine.js";
import { ErrorEventSchema, FinalTextEventSchema } from "../src/turn-event.js";

describe("fixed-copy wire metadata", () => {
  it("preserves English text and accepts an optional message without a catalog dependency", () => {
    const message = { key: "coach.fallback.stepLimit", vars: { count: 2 } };
    const response = { text: "English fallback", message };
    expect(ChatResponseSchema.parse(response)).toEqual(response);
    expect(ChatResponseSchema.parse({ text: response.text })).toEqual({ text: response.text });
    const finalText = { type: "final-text", turnId: "turn", ...response };
    expect(FinalTextEventSchema.parse(finalText)).toEqual(finalText);
    const error = {
      type: "error",
      turnId: "turn",
      chatId: "chat",
      error_class: "unknown",
      kind: "provider-down",
      athleteMessage: "English fallback",
      message: { key: "coach.error.providerDown" },
      overflowAttempts: 0,
      timeoutAttempts: 0,
      rateLimitAttempts: 0,
      duration_ms: 1,
      compactions: 0,
    };
    expect(ErrorEventSchema.parse(error)).toEqual(error);
  });

  it("rejects malformed message metadata", () => {
    for (const message of [
      { key: "" },
      { key: "coach.error.unknown", vars: { value: {} } },
      { key: "coach.error.unknown", extra: true },
    ]) {
      expect(ChatResponseSchema.safeParse({ text: "English fallback", message }).success).toBe(
        false,
      );
    }
  });
});
