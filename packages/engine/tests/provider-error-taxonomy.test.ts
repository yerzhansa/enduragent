import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { withTestModelProfiles } from "./helpers/model-profiles.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-taxonomy-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Drives the codex path: the in-house round-trip (codexResponses) is mocked.
async function setupCodexAgent(complete: ReturnType<typeof vi.fn>) {
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: complete,
  }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({
    refreshCodexToken: vi.fn(),
    loginCodex: vi.fn(),
  }));
  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
}

// Drives the AI-SDK path (anthropic provider): the `ai` streamText call is
// mocked. Network errors on this path are plain (not name="NetworkError"), so the
// outer loop retries them — unlike the codex path.
async function setupAiSdkAgent(streamText: ReturnType<typeof vi.fn>) {
  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return { ...actual, streamText };
  });
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const ports = baseAgentConfig(dataDir);
  const config = {
    ...ports,
    config: withTestModelProfiles({
      ...ports.config,
      llm: { provider: "anthropic" as const, model: "claude-sonnet-4-6", apiKey: "sk-test" },
    }),
  };
  return new CoachAgent(cyclingSport as unknown as Sport, config);
}

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
  };
}

function aiSdkResult(text: string) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    fullStream: (async function* () {
      if (text !== "") yield { type: "text-delta", id: "text-1", text };
      yield { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: usage };
    })(),
    text: Promise.resolve(text),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(usage),
    steps: Promise.resolve([{}]),
  };
}

function failingAiSdkResult(error: unknown) {
  return {
    ...aiSdkResult(""),
    fullStream: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw error;
          },
        };
      },
    },
  };
}

describe("provider error taxonomy", () => {
  it("recovers a single AI-SDK 502 in exactly two attempts", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error("server error"), { name: "ServerError" });
      return mkAssistant("recovered-502");
    });

    vi.useFakeTimers();
    const agent = await setupCodexAgent(complete);
    const chatPromise = agent.chat("taxonomy-502", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-502");
    expect(complete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("recovers an AI-SDK network error (ECONNREFUSED on .cause) in two attempts", async () => {
    let n = 0;
    const streamText = vi.fn((_request: { maxRetries?: number }) => {
      n++;
      if (n === 1) {
        const e = new TypeError("fetch failed");
        (e as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        return failingAiSdkResult(e);
      }
      return aiSdkResult("recovered-network");
    });

    vi.useFakeTimers();
    const agent = await setupAiSdkAgent(streamText);
    const chatPromise = agent.chat("taxonomy-network", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-network");
    expect(streamText).toHaveBeenCalledTimes(2);
    expect(streamText.mock.calls.every(([request]) => request.maxRetries === 0)).toBe(true);
    vi.useRealTimers();
  });

  it("recovers a codex 5xx via the short server-error backoff, not the rate-limit ramp", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        // The codex round-trip throws an httpStatus-carrying error on a 5xx;
        // normalizeError splits it into ServerError via the status, not rate-limit.
        const e = new Error("Server error (status=503)") as Error & { httpStatus?: number };
        e.httpStatus = 503;
        throw e;
      }
      return mkAssistant("recovered-codex-5xx");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupCodexAgent(complete);

    const chatPromise = agent.chat("taxonomy-codex-5xx", "hello");
    // A short advance (under the 5s rate-limit base) suffices for the server-error backoff.
    await vi.advanceTimersByTimeAsync(5_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-codex-5xx");
    expect(complete).toHaveBeenCalledTimes(2);
    const rateLimitWarn = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Rate limited"));
    expect(rateLimitWarn).toBeUndefined();
    vi.useRealTimers();
  });

  it("retries a codex network error at exactly one layer (no outer re-retry)", async () => {
    // The codex round-trip surfaces a raw thrown fetch (errno on the cause chain);
    // normalizeError tags it NetworkError, so the outer loop classifies it for
    // logging but does NOT re-enter its network retry — codex network is retried
    // at exactly one layer.
    const complete = vi.fn(async () => {
      const e = Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      });
      throw e;
    });

    vi.useFakeTimers();
    const agent = await setupCodexAgent(complete);
    const settled = agent.chat("taxonomy-codex-network", "hello").then(
      (v) => ({ ok: true as const, value: v }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await settled;

    // Exactly one library-level attempt; the outer loop does not retry the codex
    // network class, so complete is invoked once and the turn surfaces the error.
    expect(outcome.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    if (!outcome.ok) {
      const { isRateLimitError } = await import("../../core/src/agent/token-utils.js");
      // The surfaced error is a network error, never mis-routed to rate-limit.
      expect(isRateLimitError(outcome.err)).toBe(false);
    }
    vi.useRealTimers();
  });
});
