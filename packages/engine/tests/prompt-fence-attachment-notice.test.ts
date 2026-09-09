import { describe, expect, it, vi } from "vitest";
import {
  ATHLETE_CONTEXT_FENCE_CLOSE,
  ATHLETE_CONTEXT_TRUNCATION_NOTICE,
  ATTACHMENT_TEXT_MAX_CHARS,
  ATTACHMENT_TEXT_TRUNCATION_NOTICE,
  wrapAthleteContextFence,
} from "../src/agent/prompt-fence.js";

describe("attachment text truncation notice", () => {
  it("names the attachment limit and never points at memory", () => {
    expect(ATTACHMENT_TEXT_MAX_CHARS).toBe(200_000);
    expect(ATTACHMENT_TEXT_TRUNCATION_NOTICE).toContain("200,000");
    expect(ATTACHMENT_TEXT_TRUNCATION_NOTICE).not.toContain("memory");
  });

  it("appends the attachment notice instead of the memory notice when attachment text is cut", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = wrapAthleteContextFence({
      text: "x".repeat(ATTACHMENT_TEXT_MAX_CHARS + 1),
      maxChars: ATTACHMENT_TEXT_MAX_CHARS,
      truncationNotice: ATTACHMENT_TEXT_TRUNCATION_NOTICE,
    });
    warnSpy.mockRestore();
    expect(out).toContain(ATTACHMENT_TEXT_TRUNCATION_NOTICE);
    expect(out).not.toContain(ATHLETE_CONTEXT_TRUNCATION_NOTICE);
    expect(
      out.endsWith(ATTACHMENT_TEXT_TRUNCATION_NOTICE + "\n" + ATHLETE_CONTEXT_FENCE_CLOSE),
    ).toBe(true);
  });

  it("adds no notice when attachment text fits exactly at the limit", () => {
    const out = wrapAthleteContextFence({
      text: "x".repeat(ATTACHMENT_TEXT_MAX_CHARS),
      maxChars: ATTACHMENT_TEXT_MAX_CHARS,
      truncationNotice: ATTACHMENT_TEXT_TRUNCATION_NOTICE,
    });
    expect(out).not.toContain(ATTACHMENT_TEXT_TRUNCATION_NOTICE);
    expect(out).not.toContain(ATHLETE_CONTEXT_TRUNCATION_NOTICE);
  });

  it("keeps the memory notice for callers that pass no attachment notice", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = wrapAthleteContextFence({ text: "y".repeat(20), maxChars: 10 });
    warnSpy.mockRestore();
    expect(out).toContain(ATHLETE_CONTEXT_TRUNCATION_NOTICE);
    expect(out).not.toContain(ATTACHMENT_TEXT_TRUNCATION_NOTICE);
  });
});
