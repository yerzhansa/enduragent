import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATHLETE_FEEDBACK_ENDPOINT,
  ATHLETE_FEEDBACK_MAX_ATTEMPTS,
  ATHLETE_FEEDBACK_MAX_TEXT_CHARS,
  parseFeedbackCommand,
  prepareFeedbackText,
  submitFeedback,
  type FeedbackRequestInit,
} from "../src/athlete-feedback.js";

const ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

function feedbackRequest() {
  return vi.fn<(url: string, init: FeedbackRequestInit) => Promise<{ status: number }>>(
    async () => ({ status: 204 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseFeedbackCommand", () => {
  it("classifies slash drafts without posting", () => {
    expect(parseFeedbackCommand("/plan")).toEqual({ kind: "other" });
    expect(parseFeedbackCommand("/feedback")).toEqual({ kind: "usage" });
    expect(parseFeedbackCommand("  /feedback   ")).toEqual({ kind: "usage" });
    expect(parseFeedbackCommand("/feedback@EnduragentBot the watts look high")).toEqual({
      kind: "ready",
      text: "the watts look high",
    });
    expect(parseFeedbackCommand("/FEEDBACK\nplease keep rest days")).toEqual({
      kind: "ready",
      text: "please keep rest days",
    });
    expect(parseFeedbackCommand(`/feedback ${"x".repeat(ATHLETE_FEEDBACK_MAX_TEXT_CHARS + 1)}`)).toEqual({
      kind: "too-long",
    });
    expect(parseFeedbackCommand("/feedbackplease")).toEqual({ kind: "other" });
  });

  it("rejects a NUL in the note", () => {
    expect(prepareFeedbackText("ok\u0000no")).toEqual({ kind: "invalid" });
  });
});

describe("submitFeedback", () => {
  it("POSTs the frozen body and treats 204 as success", async () => {
    const request = feedbackRequest();
    await expect(
      submitFeedback({
        channel: "desktop",
        id: ID,
        text: "  the watts look high  ",
        request,
      }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(ATHLETE_FEEDBACK_ENDPOINT);
    const init = request.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(JSON.parse(init?.body ?? "")).toEqual({
      channel: "desktop",
      id: ID,
      text: "the watts look high",
    });
  });

  it("does not POST invalid notes", async () => {
    const request = feedbackRequest();
    await expect(
      submitFeedback({ channel: "desktop", id: "not-a-uuid", text: "hello", request }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(
      submitFeedback({ channel: "cli" as "desktop", id: ID, text: "hello", request }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(submitFeedback({ channel: "telegram", id: ID, text: "  ", request })).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not retry a 400", async () => {
    const request = vi.fn(async () => ({ status: 400 }));
    await expect(
      submitFeedback({ channel: "telegram", id: ID, text: "hello", request }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries an unavailable POST with the same id", async () => {
    const request = vi
      .fn<(url: string, init: FeedbackRequestInit) => Promise<{ status: number }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: 204 });
    await expect(
      submitFeedback({ channel: "ios", id: ID, text: "hello", request }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(ATHLETE_FEEDBACK_MAX_ATTEMPTS);
    expect(request.mock.calls[0]?.[1]?.body).toBe(request.mock.calls[1]?.[1]?.body);
  });

  it("does not truncate an overlong note", async () => {
    const request = feedbackRequest();
    const text = "x".repeat(ATHLETE_FEEDBACK_MAX_TEXT_CHARS + 1);
    await expect(submitFeedback({ channel: "desktop", id: ID, text, request })).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(request).not.toHaveBeenCalled();
    expect(text).toHaveLength(ATHLETE_FEEDBACK_MAX_TEXT_CHARS + 1);
  });
});
