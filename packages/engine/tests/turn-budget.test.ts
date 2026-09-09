import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import {
  createTurnBudget,
  TurnBudgetExceededError,
  MAX_TURN_GENERATE_CALLS,
  MAX_TURN_GENERATE_ATTEMPTS,
  TURN_WALL_CLOCK_MS,
} from "../src/agent/turn-budget.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-budget-"));
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

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

function mkAssistant(text: string, stopReason: "stop" | "length" = "stop") {
  return {
    text,
    toolCalls: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    stopReason,
  };
}

async function setupAgent(complete: ReturnType<typeof vi.fn>) {
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

function isMainTurn(call: unknown[]): boolean {
  const sys = (call[0] as { system?: string } | undefined)?.system ?? "";
  return sys.length > 0 && !sys.includes(FLUSH_MARKER);
}

function countMainTurns(complete: ReturnType<typeof vi.fn>): number {
  return complete.mock.calls.filter(isMainTurn).length;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe("createTurnBudget (unit)", () => {
  it("charges generate calls up to the cap then throws a classified generate_calls error", () => {
    const budget = createTurnBudget(() => 0);
    for (let i = 0; i < MAX_TURN_GENERATE_CALLS; i++) budget.chargeGenerateCall();
    let thrown: unknown;
    try {
      budget.chargeGenerateCall();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnBudgetExceededError);
    expect((thrown as TurnBudgetExceededError).kind).toBe("generate_calls");
  });

  it("charges attempts up to the cap then throws a classified generate_attempts error", () => {
    const budget = createTurnBudget(() => 0);
    for (let i = 0; i < MAX_TURN_GENERATE_ATTEMPTS; i++) budget.chargeAttempt();
    let thrown: unknown;
    try {
      budget.chargeAttempt();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnBudgetExceededError);
    expect((thrown as TurnBudgetExceededError).kind).toBe("generate_attempts");
  });

  it("remainingMs returns the budget left and clamps to zero past the deadline", () => {
    let clock = 5_000;
    const budget = createTurnBudget(() => clock);
    expect(budget.remainingMs()).toBe(TURN_WALL_CLOCK_MS);
    clock += 100_000;
    expect(budget.remainingMs()).toBe(TURN_WALL_CLOCK_MS - 100_000);
    clock += TURN_WALL_CLOCK_MS;
    expect(budget.remainingMs()).toBe(0);
  });

  it("checkDeadline throws wall_clock only once the injected clock crosses the deadline", () => {
    let clock = 1_000;
    const budget = createTurnBudget(() => clock);
    expect(() => budget.checkDeadline()).not.toThrow();
    clock += TURN_WALL_CLOCK_MS - 1;
    expect(() => budget.checkDeadline()).not.toThrow();
    clock += 1;
    let thrown: unknown;
    try {
      budget.checkDeadline();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnBudgetExceededError);
    expect((thrown as TurnBudgetExceededError).kind).toBe("wall_clock");
  });
});

describe("per-turn budget through chat() (behavioral)", () => {
  it("stops a brownout turn at the attempt cap with a classified generate_attempts error and <= 40 generate calls", async () => {
    // Mix error classes so the per-class caps (3 overflow / 2 timeout / 3
    // rate-limit) never exhaust before the total attempt cap of 4 fires: three
    // overflows then rate-limits. Attempt 5's charge throws before any spend.
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary"); // compaction prompt-only call
      const mainTurns = countMainTurns(complete);
      if (mainTurns <= 3) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      throw new Error("You have hit your rate limit. Try again later.");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const outcomeP = settle(agent.chat("brownout", "hello"));
    await vi.advanceTimersByTimeAsync(600_000);
    const outcome = await outcomeP;
    vi.useRealTimers();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Module identity differs across vi.resetModules() + dynamic import, so
      // assert on the structural fields (name + kind) rather than instanceof.
      expect((outcome.error as Error).name).toBe("TurnBudgetExceededError");
      expect((outcome.error as TurnBudgetExceededError).kind).toBe("generate_attempts");
    }
    expect(countMainTurns(complete)).toBeLessThanOrEqual(MAX_TURN_GENERATE_ATTEMPTS);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(MAX_TURN_GENERATE_CALLS);
  });

  it("a normal turn under budget returns its text and charges exactly one generate call", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      return mkAssistant("all good");
    });
    const agent = await setupAgent(complete);

    const text = await agent.chat("happy", "hello");

    expect(text).toBe("all good");
    expect(countMainTurns(complete)).toBe(1);
  });

  it("a retry after an early timeout gets only the budget left, capping total chat time", async () => {
    // Each chat generate mints its per-call deadline from the turn's remaining
    // wall-clock budget. A timeout 100s into the 600s turn must leave the retry
    // only ~500s — not a fresh full window (which would let a turn run ~1200s,
    // the double-window bug).
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const deadlines: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      deadlines.push(ms);
      return new AbortController().signal;
    });

    let mainCalls = 0;
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      mainCalls++;
      if (mainCalls === 1) {
        clock += 100_000;
        const err = new Error("deadline exceeded");
        err.name = "TimeoutError";
        throw err;
      }
      return mkAssistant("done");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const text = await agent.chat("budget-deadline", "hello");
    nowSpy.mockRestore();

    expect(text).toBe("done");
    expect(mainCalls).toBe(2);
    expect(deadlines.length).toBe(2);
    // First call: full budget. Retry: only the ~200s the turn has left.
    expect(deadlines[0]).toBe(TURN_WALL_CLOCK_MS);
    expect(deadlines[1]).toBe(TURN_WALL_CLOCK_MS - 100_000);
    // Total chat time stays bounded by the wall-clock budget.
    expect(100_000 + deadlines[1]).toBeLessThanOrEqual(TURN_WALL_CLOCK_MS);
  });

  it("a between-attempts wall-clock overrun stops with a wall_clock error and lets the in-flight call complete", async () => {
    // Inject a clock that stays at turnStart through the first attempt and jumps
    // past the 10-minute deadline once the first attempt's generate has thrown
    // (a rate-limit error the loop would normally retry). The first attempt's
    // generate runs to completion (its throw is observed), proving the deadline
    // never aborted the in-flight call; the between-attempts check then stops it.
    const base = 1_000_000;
    let crossed = false;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      return crossed ? base + TURN_WALL_CLOCK_MS + 1 : base;
    });

    let mainCalls = 0;
    let firstAttemptCompleted = false;
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      mainCalls++;
      if (mainCalls === 1) {
        firstAttemptCompleted = true;
        crossed = true;
        throw new Error("You have hit your rate limit. Try again later.");
      }
      return mkAssistant("should-not-reach");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fake only the timer functions, not Date, so the explicit Date.now spy
    // above controls the budget clock while the rate-limit backoff sleep is
    // still driven synchronously by advanceTimersByTimeAsync.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const agent = await setupAgent(complete);

    const outcomeP = settle(agent.chat("walls", "hello"));
    await vi.advanceTimersByTimeAsync(600_000);
    const outcome = await outcomeP;
    vi.useRealTimers();
    nowSpy.mockRestore();

    expect(firstAttemptCompleted).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as Error).name).toBe("TurnBudgetExceededError");
      expect((outcome.error as TurnBudgetExceededError).kind).toBe("wall_clock");
    }
    // The second main generate never ran — the deadline stopped the next attempt.
    expect(mainCalls).toBe(1);
  });
});
