import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, it, expect } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { ApiError } from "intervals-icu-api";
import { classifyAgentError as classifyAgentErrorMessage } from "../src/agent/error-classify.js";
import { formatRateLimitWait } from "../src/agent/token-utils.js";

const book = await createPhrasebook({ tag: "en", locale: "en-GB" });

function classifyAgentError(error: unknown) {
  const result = classifyAgentErrorMessage(error, book.format);
  return { ...result, athleteMessage: book.say(result.athleteMessage) };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "api error",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
  });
}

describe("classifyAgentError", () => {
  it("gives structurally tagged reauthentication an actionable sign-in path", () => {
    const result = classifyAgentError(
      Object.assign(new Error("rate limit"), {
        refreshFailureReason: "reauth",
        kind: "RateLimit",
        retryAfterMs: 3_000,
      }),
    );

    expect(result).toEqual({
      kind: "provider-auth",
      athleteMessage: "Your ChatGPT sign-in is no longer valid. Sign in again to continue.",
    });
  });

  it("keeps a structurally tagged refresh rate limit in the rate-limit lane", () => {
    const result = classifyAgentError({
      refreshFailureReason: "rate_limit",
      retryAfterMs: 3_000,
    });

    expect(result).toEqual({
      kind: "rate_limit",
      athleteMessage: "Rate limited — please try again in ~3 seconds.",
    });
  });

  it("classifies 401/403 as provider-auth with provider-neutral copy", () => {
    for (const status of [401, 403]) {
      const result = classifyAgentError(apiError(status));
      expect(result.kind).toBe("provider-auth");
      expect(result.athleteMessage).toBe(
        "The model provider rejected the API key — check your provider credentials.",
      );
      expect(result.athleteMessage).not.toContain("Anthropic");
    }
  });

  it("classifies 5xx as provider-down", () => {
    for (const status of [500, 501, 502, 503, 504, 529, 599]) {
      const result = classifyAgentError(apiError(status));
      expect(result.kind).toBe("provider-down");
      expect(result.athleteMessage).toBe(
        "The model provider is having trouble — try again in a few minutes.",
      );
    }
  });

  it("classifies a network error (ECONNRESET via cause chain) as provider-down", () => {
    const e = new TypeError("fetch failed");
    (e as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect(classifyAgentError(e).kind).toBe("provider-down");
  });

  it("classifies a TimeoutError as provider-down", () => {
    const e = new Error("boom");
    e.name = "TimeoutError";
    expect(classifyAgentError(e).kind).toBe("provider-down");
  });

  it("classifies 429 as rate_limit with the formatRateLimitWait copy", () => {
    const err = apiError(429);
    const result = classifyAgentError(err);
    expect(result.kind).toBe("rate_limit");
    expect(result.athleteMessage).toContain(formatRateLimitWait(err));
    expect(result.athleteMessage).toBe("Rate limited — please try again in about a minute.");
  });

  it("classifies intervals Unauthorized/Forbidden as intervals with the credentials copy, NotFound as intervals transient", () => {
    const unauthorized: ApiError = { kind: "Unauthorized", status: 401, body: {} };
    const forbidden: ApiError = { kind: "Forbidden", status: 403, body: {} };
    for (const err of [unauthorized, forbidden]) {
      const result = classifyAgentError(err);
      expect(result.kind).toBe("intervals");
      expect(result.athleteMessage).toBe(
        "intervals.icu rejected the request — check your intervals.icu connection or API key.",
      );
    }

    const notFound: ApiError = { kind: "NotFound", status: 404, body: {} };
    const notFoundResult = classifyAgentError(notFound);
    expect(notFoundResult.kind).toBe("intervals");
    expect(notFoundResult.athleteMessage).toBe(
      "Couldn't reach intervals.icu right now — try again shortly.",
    );
  });

  it("routes intervals RateLimit to rate_limit and Timeout/Network to the intervals transient classification", () => {
    const rateLimit: ApiError = { kind: "RateLimit", status: 429, retryAfterMs: 1000, body: {} };
    expect(classifyAgentError(rateLimit).kind).toBe("rate_limit");

    const timeout: ApiError = { kind: "Timeout", message: "slow" };
    const timeoutResult = classifyAgentError(timeout);
    expect(timeoutResult.kind).toBe("intervals");
    expect(timeoutResult.athleteMessage).toBe(
      "Couldn't reach intervals.icu right now — try again shortly.",
    );

    const network: ApiError = { kind: "Network", message: "down" };
    const networkResult = classifyAgentError(network);
    expect(networkResult.kind).toBe("intervals");
    expect(networkResult.athleteMessage).toBe(
      "Couldn't reach intervals.icu right now — try again shortly.",
    );
  });

  it("does NOT classify an unrelated object carrying a string kind as intervals", () => {
    const result = classifyAgentError({ kind: "whatever" });
    expect(result.kind).toBe("unknown");
  });

  it("classifies unknown / overflow / invalid_request as unknown with a single-line apology", () => {
    const cases: unknown[] = [
      new Error("???"),
      new Error("maximum context length exceeded"),
      apiError(400),
    ];
    for (const err of cases) {
      const result = classifyAgentError(err);
      expect(result.kind).toBe("unknown");
      expect(result.athleteMessage).toBe("Sorry, something went wrong. Please try again.");
      expect(result.athleteMessage).not.toContain("\n");
    }
  });

  it("never leaks the raw error message or a stack trace into athleteMessage", () => {
    const err = new Error("SENSITIVE provider payload at /secret/path");
    const result = classifyAgentError(err);
    expect(result.athleteMessage).not.toContain("SENSITIVE");
    expect(result.athleteMessage).not.toContain("/secret/path");
    expect(result.athleteMessage).not.toContain("Error:");
  });
});

it("returns a message descriptor for provider failures", () => {
  expect(classifyAgentErrorMessage(apiError(500)).athleteMessage).toEqual({
    key: "coach.error.providerDown",
  });
});
