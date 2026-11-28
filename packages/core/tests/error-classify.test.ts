import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, it, expect } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { ApiError } from "intervals-icu-api";
import { classifyAgentError as classifyAgentErrorMessage } from "../src/agent/error-classify.js";
import { classifyFailure, formatRateLimitWait } from "../src/agent/token-utils.js";

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

describe("payment required", () => {
  function openRouter402(message: string): APICallError {
    return new APICallError({
      message,
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: { code: 402, message } }),
      data: { error: { code: 402, message } },
    });
  }

  it("classifies an HTTP 402 as payment_required", () => {
    expect(classifyFailure(apiError(402))).toBe("payment_required");
  });

  it.each([
    "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 120.",
    "Request timed out: rate limit and context window exceeded",
  ])("keeps a 402 payment_required whatever its message says: %s", (message) => {
    expect(classifyFailure(openRouter402(message))).toBe("payment_required");
  });

  it("classifies OpenRouter's mid-stream { code: 402 } error part as payment_required", () => {
    expect(classifyFailure({ code: 402, message: "Insufficient credits" })).toBe(
      "payment_required",
    );
    expect(classifyFailure({ code: "402", message: "Insufficient credits" })).toBe(
      "payment_required",
    );
    expect(classifyFailure({ code: 400, message: "Insufficient credits" })).toBe("unknown");
    expect(classifyFailure(Object.assign(new Error("x"), { code: 402 }))).toBe("unknown");
  });

  it("does not treat other statuses as payment_required", () => {
    expect(classifyFailure(apiError(400))).toBe("invalid_request");
    expect(classifyFailure(apiError(401))).toBe("auth");
    expect(classifyFailure(apiError(429))).toBe("rate_limit");
    expect(classifyFailure(apiError(500))).toBe("server_error");
  });

  it("keeps the generic reply outside the desktop Coach", () => {
    const result = classifyAgentError(openRouter402("Insufficient credits"));
    expect(result).toEqual({
      kind: "unknown",
      athleteMessage: "Sorry, something went wrong. Please try again.",
    });
  });
});

function providerError(input: {
  readonly statusCode: number;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly message?: string;
}): APICallError {
  return new APICallError({
    message: input.message ?? "provider error",
    url: "https://provider.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode: input.statusCode,
    responseBody:
      input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body)),
    data: input.body,
  });
}

describe("model unavailable", () => {
  it("keeps a bare 404, such as a wrong base URL, generic", () => {
    expect(classifyFailure(apiError(404))).toBe("unknown");
    expect(classifyFailure(apiError(404), "anthropic")).toBe("unknown");
    expect(
      classifyFailure(
        providerError({ statusCode: 404, body: { error: { code: 404, message: "Not Found" } } }),
        "openrouter",
      ),
    ).toBe("unknown");
    expect(
      classifyFailure(providerError({ statusCode: 404, rawBody: "<html>Not Found</html>" })),
    ).toBe("unknown");
  });

  it.each([400, 404])(
    "classifies a %i with the model_not_found code or type, parsed or raw, as model_unavailable",
    (statusCode) => {
      const code = { error: { code: "model_not_found", message: "The model does not exist" } };
      const type = { error: { type: "model_not_found" } };
      expect(classifyFailure(providerError({ statusCode, body: code }))).toBe("model_unavailable");
      expect(classifyFailure(providerError({ statusCode, rawBody: JSON.stringify(code) }))).toBe(
        "model_unavailable",
      );
      expect(classifyFailure(providerError({ statusCode, body: type }))).toBe("model_unavailable");
    },
  );

  it("classifies Anthropic's not_found_error as model_unavailable on the anthropic route only", () => {
    const body = { type: "error", error: { type: "not_found_error", message: "model: retired" } };
    const error = providerError({ statusCode: 404, body });
    expect(classifyFailure(error, "anthropic")).toBe("model_unavailable");
    expect(classifyFailure(error, "openrouter")).toBe("unknown");
    expect(classifyFailure(error)).toBe("unknown");
  });

  it("keeps other 400s as an invalid request or an overflow", () => {
    expect(
      classifyFailure(
        providerError({ statusCode: 400, body: { error: { code: "invalid_value" } } }),
      ),
    ).toBe("invalid_request");
    expect(
      classifyFailure(providerError({ statusCode: 400, rawBody: "<html>Bad Request</html>" })),
    ).toBe("invalid_request");
    expect(
      classifyFailure(
        providerError({ statusCode: 400, body: { error: { code: "context_length_exceeded" } } }),
      ),
    ).toBe("overflow");
  });

  it("keeps the generic reply outside the desktop Coach", () => {
    expect(classifyAgentError(apiError(404))).toEqual({
      kind: "unknown",
      athleteMessage: "Sorry, something went wrong. Please try again.",
    });
  });
});

describe("OpenAI billing limits on a 429", () => {
  const quota = { error: { type: "insufficient_quota", code: "insufficient_quota" } };

  it("classifies OpenAI's no-quota 429 as payment_required", () => {
    expect(classifyFailure(providerError({ statusCode: 429, body: quota }), "openai")).toBe(
      "payment_required",
    );
    expect(
      classifyFailure(providerError({ statusCode: 429, rawBody: JSON.stringify(quota) }), "openai"),
    ).toBe("payment_required");
  });

  it.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ])("classifies OpenAI's %s 429 as payment_required", (code) => {
    const error = providerError({ statusCode: 429, body: { error: { type: "billing", code } } });
    expect(classifyFailure(error, "openai")).toBe("payment_required");
  });

  it("keeps a plain OpenAI 429 a rate limit", () => {
    const slowDown = { error: { type: "rate_limit_error", code: "slow_down" } };
    expect(classifyFailure(providerError({ statusCode: 429, body: slowDown }), "openai")).toBe(
      "rate_limit",
    );
    expect(classifyFailure(apiError(429), "openai")).toBe("rate_limit");
  });

  it("keeps the same 429 a rate limit on every other route", () => {
    const error = providerError({ statusCode: 429, body: quota });
    expect(classifyFailure(error)).toBe("rate_limit");
    expect(classifyFailure(error, "deepseek")).toBe("rate_limit");
    expect(classifyFailure(error, "openrouter")).toBe("rate_limit");
  });
});
