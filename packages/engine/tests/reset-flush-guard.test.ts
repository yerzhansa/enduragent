import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

async function drain(chatId: string): Promise<void> {
  const { withSessionLock } = await import("../src/agent/session-lock.js");
  await withSessionLock(chatId, async () => {});
}

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-resetflush-"));
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

async function setupAgent(
  complete: ReturnType<typeof vi.fn>,
  timezone?: string,
  now?: () => number,
) {
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
  const base = baseAgentConfig(dataDir);
  const withTz =
    timezone === undefined
      ? base
      : { ...base, config: { ...base.config, session: { ...base.config.session, timezone } } };
  const ports = now === undefined ? withTz : { ...withTz, now };
  return new CoachAgent(cyclingSport as unknown as Sport, ports);
}

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

function isFlushCall(params: unknown): boolean {
  const system = (params as { system?: unknown } | undefined)?.system;
  return typeof system === "string" && system.includes(FLUSH_MARKER);
}

function flushMessagesText(params: unknown): string {
  return JSON.stringify((params as { messages: unknown }).messages);
}

function listFlushMarkers(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.flush-pending.`),
  );
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

const STALE_TS = "2020-01-01T00:00:00.000Z";

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

describe("reset-path flush guards", () => {
  it("resetSession archives the session even when the memory flush throws", async () => {
    const complete = vi.fn(async () => {
      throw new Error("boom");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("reset-guard", [
      { role: "user", content: "we agreed: hold volume this week", ts: STALE_TS },
      { role: "assistant", content: "yes - hold volume, recheck Friday", ts: STALE_TS },
    ]);

    await expect(agent.resetSession("reset-guard")).resolves.toEqual({ memoryFlushed: false });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(agent.hasSession("reset-guard")).toBe(false);
    const archives = listArchives("reset-guard");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("hold volume this week");
    expect(archived).toContain("recheck Friday");
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(true);
  });

  it("freshness-expiry reset archives and the chat continues when the flush throws", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("fresh-start");
      throw new Error("boom");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("stale-guard", [
      { role: "user", content: "old turn from a previous day", ts: STALE_TS },
      { role: "assistant", content: "old reply", ts: STALE_TS },
    ]);

    const text = await agent.chat("stale-guard", "hello");

    // A reset turn now prefixes the one-time post-reset notice before the reply.
    expect(text.startsWith("Started a fresh session")).toBe(true);
    expect(text).toContain("fresh-start");
    await drain("stale-guard");
    expect(complete).toHaveBeenCalledTimes(3);
    const archives = listArchives("stale-guard");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("old turn from a previous day");
    const freshSession = readFileSync(join(dataDir, "sessions", "stale-guard.jsonl"), "utf-8");
    expect(freshSession).toContain("hello");
    expect(freshSession).toContain("fresh-start");
    expect(freshSession).not.toContain("old turn from a previous day");
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("Queued stale-reset memory flush failed"),
      ),
    ).toBe(true);
  });

  it("the reply resolves before the stale-reset flush starts, and the next turn waits for it", async () => {
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 2) {
        await flushGate;
        return mkAssistant("facts noted");
      }
      return mkAssistant(`reply-${n}`);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("order", [
      { role: "user", content: "yesterday's talk", ts: STALE_TS },
      { role: "assistant", content: "yesterday's reply", ts: STALE_TS },
    ]);

    const first = await agent.chat("order", "morning");

    expect(first).toContain("reply-1");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(listArchives("order")).toHaveLength(1);

    const second = agent.chat("order", "and another thing");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(complete).toHaveBeenCalledTimes(2);

    releaseFlush();
    expect(await second).toBe("reply-3");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("defers a daily reset for one turn when the last exchange is still recent", async () => {
    const complete = vi.fn(async () => mkAssistant("carry on"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1998-06-15T04:10:00.000Z"));
    try {
      const agent = await setupAgent(complete, "UTC");
      seedSession("defer-daily", [
        { role: "user", content: "mid-conversation", ts: "1998-06-15T03:55:00.000Z" },
        { role: "assistant", content: "still talking", ts: "1998-06-15T03:55:00.000Z" },
      ]);

      const text = await agent.chat("defer-daily", "one more thing");

      expect(text).toBe("carry on");
      expect(listArchives("defer-daily")).toHaveLength(0);
      const session = readFileSync(join(dataDir, "sessions", "defer-daily.jsonl"), "utf-8");
      expect(session).toContain("mid-conversation");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetSession flushes and archives without a failure warn when the LLM is healthy", async () => {
    const complete = vi.fn(async () => mkAssistant("noted"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("healthy-reset", [
      { role: "user", content: "remember my FTP is 247", ts: STALE_TS },
    ]);

    await expect(agent.resetSession("healthy-reset")).resolves.toEqual({ memoryFlushed: true });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(agent.hasSession("healthy-reset")).toBe(false);
    expect(listArchives("healthy-reset")).toHaveLength(1);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(false);
  });
});

describe("reset archive re-flush", () => {
  it("a stale reset marks the archive pending until its queued flush completes", async () => {
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const complete = vi.fn(async (params: unknown) => {
      if (!isFlushCall(params)) return mkAssistant("reply");
      await flushGate;
      return mkAssistant("noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("mark", [
      { role: "user", content: "yesterday's talk", ts: STALE_TS },
      { role: "assistant", content: "yesterday's reply", ts: STALE_TS },
    ]);

    await agent.chat("mark", "morning");

    const archives = listArchives("mark");
    expect(archives).toHaveLength(1);
    const archiveRef = archives[0].slice("mark.jsonl.reset.".length);
    expect(listFlushMarkers("mark")).toEqual([`mark.jsonl.flush-pending.${archiveRef}`]);

    releaseFlush();
    await drain("mark");

    expect(listFlushMarkers("mark")).toHaveLength(0);
    expect(listArchives("mark")).toEqual(archives);
  });

  it("a flush lost to a process exit is re-queued once on the next turn, then never again", async () => {
    const flushCalls: string[] = [];
    let replies = 0;
    const complete = vi.fn(async (params: unknown) => {
      if (!isFlushCall(params)) return mkAssistant(`reply-${++replies}`);
      flushCalls.push(flushMessagesText(params));
      if (flushCalls.length === 1) await new Promise<void>(() => {});
      return mkAssistant("noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await setupAgent(complete);
    seedSession("lost", [
      { role: "user", content: "yesterday's talk", ts: STALE_TS },
      { role: "assistant", content: "yesterday's reply", ts: STALE_TS },
    ]);

    const first = await before.chat("lost", "morning");
    expect(first).toContain("reply-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushCalls).toHaveLength(1);
    expect(listFlushMarkers("lost")).toHaveLength(1);

    vi.resetModules();
    const restarted = await setupAgent(complete);

    expect(await restarted.chat("lost", "and another thing")).toBe("reply-2");
    await drain("lost");

    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[1]).toContain("yesterday's talk");
    expect(flushCalls[1]).not.toContain("and another thing");
    expect(listFlushMarkers("lost")).toHaveLength(0);
    expect(listArchives("lost")).toHaveLength(1);

    expect(await restarted.chat("lost", "third")).toBe("reply-3");
    await drain("lost");

    expect(flushCalls).toHaveLength(2);
    expect(listFlushMarkers("lost")).toHaveLength(0);
  });

  it("a failed queued flush keeps the marker and the next turn retries it", async () => {
    const flushCalls: string[] = [];
    let replies = 0;
    const complete = vi.fn(async (params: unknown) => {
      if (!isFlushCall(params)) return mkAssistant(`reply-${++replies}`);
      flushCalls.push(flushMessagesText(params));
      if (flushCalls.length <= 2) throw new Error("boom");
      return mkAssistant("noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("retry", [
      { role: "user", content: "yesterday's talk", ts: STALE_TS },
      { role: "assistant", content: "yesterday's reply", ts: STALE_TS },
    ]);

    await agent.chat("retry", "morning");
    await drain("retry");
    expect(flushCalls).toHaveLength(2);
    expect(listFlushMarkers("retry")).toHaveLength(1);

    await agent.chat("retry", "again");
    await drain("retry");
    expect(flushCalls).toHaveLength(3);
    expect(flushCalls[2]).toContain("yesterday's talk");
    expect(listFlushMarkers("retry")).toHaveLength(0);
  });

  it("recovers pending archives oldest first, one per turn", async () => {
    const flushCalls: string[] = [];
    let replies = 0;
    const complete = vi.fn(async (params: unknown) => {
      if (!isFlushCall(params)) return mkAssistant(`reply-${++replies}`);
      flushCalls.push(flushMessagesText(params));
      if (flushCalls.length === 1) await new Promise<void>(() => {});
      return mkAssistant("noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 0;
    const now = () => (clock += 60_000);
    const before = await setupAgent(complete, undefined, now);
    seedSession("oldest", [{ role: "user", content: "day one", ts: STALE_TS }]);
    await before.chat("oldest", "morning one");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushCalls).toHaveLength(1);

    vi.resetModules();
    const restarted = await setupAgent(complete, undefined, now);
    seedSession("oldest", [{ role: "user", content: "day two", ts: STALE_TS }]);

    await restarted.chat("oldest", "morning two");
    await drain("oldest");
    expect(listArchives("oldest")).toHaveLength(2);
    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[1]).toContain("day one");
    expect(listFlushMarkers("oldest")).toHaveLength(1);

    await restarted.chat("oldest", "later");
    await drain("oldest");
    expect(flushCalls).toHaveLength(3);
    expect(flushCalls[2]).toContain("day two");
    expect(listFlushMarkers("oldest")).toHaveLength(0);
  });
});
