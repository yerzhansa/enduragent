import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import { shouldRunMemoryFlush } from "../src/agent/memory-flush.js";

const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Coach Stance",
  "- Hold volume this week (prior knee issue); athlete has not pushed back",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

describe("shouldRunMemoryFlush", () => {
  it("cooldown suppresses even far over threshold", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 9_999,
        tokenBudget: 10_000,
        lastFlushMessageCount: 10,
        currentMessageCount: 14,
      }),
    ).toBe(false);
  });

  it("exactly 5 new messages over threshold fires", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 9_000,
        tokenBudget: 10_000,
        lastFlushMessageCount: 10,
        currentMessageCount: 15,
      }),
    ).toBe(true);
  });

  it("exactly 80% does not fire (strict >)", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 8_000,
        tokenBudget: 10_000,
        lastFlushMessageCount: 0,
        currentMessageCount: 20,
      }),
    ).toBe(false);
  });

  it("just above 80% fires", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 8_001,
        tokenBudget: 10_000,
        lastFlushMessageCount: 0,
        currentMessageCount: 20,
      }),
    ).toBe(true);
  });

  it("never-flushed short session is suppressed", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 9_000,
        tokenBudget: 10_000,
        lastFlushMessageCount: 0,
        currentMessageCount: 4,
      }),
    ).toBe(false);
  });

  it("never-flushed session at 5 messages fires", () => {
    expect(
      shouldRunMemoryFlush({
        estimatedTokens: 9_000,
        tokenBudget: 10_000,
        lastFlushMessageCount: 0,
        currentMessageCount: 5,
      }),
    ).toBe(true);
  });
});

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-softflush-"));
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
  const ports = baseAgentConfig(dataDir);
  return new CoachAgent(cyclingSport as unknown as Sport, {
    ...ports,
    config: { ...ports.config, contextWindowTokens: 80_000 },
  });
}

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

const FRESH_TS = new Date().toISOString();

function seedSession(chatId: string, lines: Array<{ role: string; content: string; ts: string }>) {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function overThresholdLines(): Array<{ role: string; content: string; ts: string }> {
  return Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `SOFT-MARK-${i} ` + "x".repeat(2_400 - 11 - String(i).length),
    ts: FRESH_TS,
  }));
}

function underThresholdLines(): Array<{ role: string; content: string; ts: string }> {
  return Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(800),
    ts: FRESH_TS,
  }));
}

function trimLines(): Array<{ role: string; content: string; ts: string }> {
  return Array.from({ length: 13 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(2_400),
    ts: FRESH_TS,
  }));
}

async function drain(chatId: string): Promise<void> {
  const { withSessionLock } = await import("../src/agent/session-lock.js");
  await withSessionLock(chatId, async () => {});
}

function readSession(chatId: string): string {
  return readFileSync(join(dataDir, "sessions", `${chatId}.jsonl`), "utf-8");
}

describe("soft-threshold flush in chat()", () => {
  it("fires past 80% after the reply and cools down for 5 messages", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("main-reply");
      return mkAssistant("facts noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("soft", overThresholdLines());

    const text = await agent.chat("soft", "hello");

    expect(text).toBe("main-reply");
    await drain("soft");
    expect(complete).toHaveBeenCalledTimes(2);
    const warnSpy = console.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("flush failed"))).toBe(false);
    const session = readSession("soft");
    expect(session).toContain("SOFT-MARK-0");
    expect(session).toContain("SOFT-MARK-9");
    expect(session).toContain("hello");
    expect(session).toContain("main-reply");

    await agent.chat("soft", "again");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("below threshold never flushes", async () => {
    const complete = vi.fn(async () => mkAssistant("reply"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("low", underThresholdLines());

    await agent.chat("low", "hi");

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("flush failure warns, the turn completes, and the next turn retries the same window", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 2 || n === 3) throw new Error("boom");
      return mkAssistant("ok-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("fail", overThresholdLines());

    const text = await agent.chat("fail", "hello");

    expect(text).toBe("ok-reply");
    await drain("fail");
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("Queued soft-threshold memory flush failed"),
      ),
    ).toBe(true);
    expect(complete).toHaveBeenCalledTimes(3);
    const session = readSession("fail");
    expect(session).toContain("hello");
    expect(session).toContain("ok-reply");

    await agent.chat("fail", "again");
    await drain("fail");
    expect(complete).toHaveBeenCalledTimes(5);
    const retry = (complete.mock.calls as unknown[][])[4]?.[0] as
      | { system?: string; messages: unknown }
      | undefined;
    expect(retry?.system).toContain("You are reviewing a conversation");
    const retried = JSON.stringify(retry?.messages);
    expect(retried).toContain("SOFT-MARK-0 ");
    expect(retried).toContain("SOFT-MARK-9 ");
    expect(retried).toContain("hello");
    expect(retried).toContain("ok-reply");

    await agent.chat("fail", "third");
    await drain("fail");
    expect(complete).toHaveBeenCalledTimes(6);
  });

  it("a trim turn does not double-flush", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("facts noted");
      if (n === 2) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("trim-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim", trimLines());

    const text = await agent.chat("trim", "hello");

    expect(text).toBe("trim-reply");
    expect(complete).toHaveBeenCalledTimes(3);
    const archives = readdirSync(join(dataDir, "sessions")).filter((f) =>
      f.startsWith("trim.jsonl.precompact."),
    );
    expect(archives).toHaveLength(1);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Soft-threshold")),
    ).toBe(false);
  });
});
