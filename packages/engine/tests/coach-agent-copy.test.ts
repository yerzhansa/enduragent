import { describe, expect, it } from "vitest";
import { createPhrasebook } from "@enduragent/i18n/messages";
import {
  TAINTED_BY_WRITES_MESSAGE,
  STEP_LIMIT_TRUNCATION_MESSAGE,
  coachReplyMessage,
} from "../src/agent/coach-agent-copy.js";

describe("fixed coach copy", () => {
  it("returns messages while preserving the English reply", async () => {
    const book = await createPhrasebook({ tag: "en", locale: "en-GB" });
    expect(TAINTED_BY_WRITES_MESSAGE).toEqual({ key: "coach.fallback.writesSaved" });
    expect(STEP_LIMIT_TRUNCATION_MESSAGE).toEqual({ key: "coach.fallback.stepLimit" });
    expect(book.say(STEP_LIMIT_TRUNCATION_MESSAGE)).toBe(
      "I ran out of steps gathering data — ask me to continue and I'll pick up where I left off.",
    );
    expect(book.say(TAINTED_BY_WRITES_MESSAGE)).toBe(
      "I made a change to your calendar, but then ran into a problem finishing my reply. Your change is saved — please open your calendar to confirm it looks right, and tell me if you'd like me to adjust it.",
    );
  });
});

it("keeps fixed notices in the descriptor when they accompany model text or a fixed fallback", async () => {
  const book = await createPhrasebook({ tag: "en", locale: "en-GB" });
  for (const reset of [false, true]) {
    for (const unsaved of [false, true]) {
      for (const fixed of [false, true]) {
        const reply = fixed ? book.say(STEP_LIMIT_TRUNCATION_MESSAGE) : "Your next ride is ready.";
        const message = coachReplyMessage({
          reply,
          message: fixed ? STEP_LIMIT_TRUNCATION_MESSAGE : undefined,
          reset,
          unsaved,
        });
        const expected =
          (reset
            ? "Started a fresh session - earlier conversation is archived, and I still have your key details in memory.\n\n"
            : "") +
          reply +
          (unsaved
            ? "\n\n(Heads up: my disk is full, so I couldn't save this to our history — but your message went through. Please free up some space when you can.)"
            : "");
        expect(message === undefined ? reply : book.say(message)).toBe(expected);
        if (fixed && message !== undefined) expect(message.vars).toBeUndefined();
        if (!fixed && message !== undefined) expect(message.vars).toEqual({ reply });
      }
    }
  }
});
