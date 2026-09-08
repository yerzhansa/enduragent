import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-flushretry-"));
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
  return {
    agent: new CoachAgent(cyclingSport as unknown as Sport, ports),
    chatStore: ports.chatStore,
  };
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

function seedSession(chatId: string, lines: Array<{ role: string; content: string; ts: string }>) {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    { encoding: "utf-8", mode: 0o600 },
  );
}

function listArchives(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.reset.`),
  );
}

const STALE_TS = "2020-01-01T00:00:00.000Z";

const STALE_FOUR = [
  { role: "user", content: "old-fact-1: knee niggle on long rides", ts: STALE_TS },
  { role: "assistant", content: "old-fact-2: keep rides under two hours", ts: STALE_TS },
  { role: "user", content: "old-fact-3: agreed to recheck next week", ts: STALE_TS },
  { role: "assistant", content: "old-fact-4: noted, plan adjusted", ts: STALE_TS },
];

function warnEvents(warnSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((args: unknown[]) => {
      try {
        return JSON.parse(String(args[0]));
      } catch {
        return null;
      }
    })
    .filter((e: unknown): e is Record<string, unknown> => e !== null);
}

async function drain(chatId: string): Promise<void> {
  const { withSessionLock } = await import("../src/agent/session-lock.js");
  await withSessionLock(chatId, async () => {});
}

function eventsNamed(warnSpy: ReturnType<typeof vi.spyOn>, name: string) {
  return warnEvents(warnSpy).filter((e) => e.event === name);
}

describe("flush retry and degradation", () => {
  it("a transient flush failure recovers via retry on resetSession", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return mkAssistant("noted");
    });
    const { agent } = await setupAgent(complete);
    seedSession("retry-ok", STALE_FOUR.slice(0, 2));

    await expect(agent.resetSession("retry-ok")).resolves.toEqual({ memoryFlushed: true });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(agent.hasSession("retry-ok")).toBe(false);
    expect(listArchives("retry-ok")).toHaveLength(1);

    const failed = eventsNamed(warnSpy, "memory_flush_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].trigger).toBe("explicit-reset");
    expect(failed[0].attempt).toBe(1);
    expect(failed[0].maxAttempts).toBe(2);
    expect(failed[0].error).toBe("boom");
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(false);
  });

  it("a persistent flush failure on resetSession degrades but still archives", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = vi.fn(async () => {
      throw new Error("boom");
    });
    const { agent } = await setupAgent(complete);
    seedSession("retry-dead", STALE_FOUR.slice(0, 2));

    await expect(agent.resetSession("retry-dead")).resolves.toEqual({ memoryFlushed: false });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(listArchives("retry-dead")).toHaveLength(1);
    expect(agent.hasSession("retry-dead")).toBe(false);

    const failed = eventsNamed(warnSpy, "memory_flush_failed");
    expect(failed).toHaveLength(2);
    expect(failed.every((e) => e.trigger === "explicit-reset")).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(true);
  });

  it("a zero-write stale flush retries once after the reply and the archive is immediate", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      return mkAssistant(`turn-${n}`);
    });
    const { agent, chatStore } = await setupAgent(complete);
    const resetSpy = vi.spyOn(chatStore, "resetConversation");
    seedSession("retry-zero", STALE_FOUR);

    const t1 = await agent.chat("retry-zero", "hello");
    expect(t1.startsWith("Started a fresh session")).toBe(true);
    expect(t1).toContain("turn-1");
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(listArchives("retry-zero")).toHaveLength(1);
    await drain("retry-zero");

    expect(complete).toHaveBeenCalledTimes(3);
    const retries = eventsNamed(warnSpy, "memory_flush_zero_write_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0].messageCount).toBe(4);
    const afterT1 = readFileSync(join(dataDir, "sessions", "retry-zero.jsonl"), "utf-8");
    expect(afterT1).toContain("hello");
    expect(afterT1).not.toContain("old-fact-1");
  });

  it("a zero-write flush on a short stale session does not retry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      return mkAssistant(`turn-${n}`);
    });
    const { agent } = await setupAgent(complete);
    seedSession("short", STALE_FOUR.slice(0, 2));

    const text = await agent.chat("short", "hello");
    expect(text.startsWith("Started a fresh session")).toBe(true);
    expect(text).toContain("turn-1");
    expect(listArchives("short")).toHaveLength(1);
    await drain("short");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(eventsNamed(warnSpy, "memory_flush_zero_write_retry")).toHaveLength(0);
  });

  it("an overflow-recovery flush failure no longer kills the turn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("Request exceeds the maximum context length of 272000 tokens");
      if (n <= 3) throw new Error("boom");
      return mkAssistant("recovered");
    });
    const { agent } = await setupAgent(complete);

    const text = await agent.chat("overflow-degrade", "hello");
    expect(text).toBe("recovered");
    expect(complete).toHaveBeenCalledTimes(4);

    const failed = eventsNamed(warnSpy, "memory_flush_failed");
    expect(failed).toHaveLength(2);
    expect(failed.every((e) => e.trigger === "overflow-recovery")).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("In-turn memory flush failed")),
    ).toBe(true);
  });
});
