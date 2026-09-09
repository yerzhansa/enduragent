import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

const FLUSH_MARKER = "You are reviewing a conversation";
const COMPACTION_MARKER = "conversation-compaction summarizer";
const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg",
  "## Training Status",
  "- Build phase",
  "## Coach Stance",
  "- Hold volume this week",
  "## Discussion Context",
  "- Goal review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-flushdelta-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Call = { system?: string; messages: unknown };

async function setupAgent(
  complete: ReturnType<typeof vi.fn>,
  contextWindowTokens: number,
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
  const ports = baseAgentConfig(dataDir);
  return new CoachAgent(cyclingSport as unknown as Sport, {
    ...ports,
    config: { ...ports.config, contextWindowTokens },
  });
}

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
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

const FRESH_TS = new Date().toISOString();

function markedLines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${prefix}-${i} ` + "x".repeat(2_400),
    ts: FRESH_TS,
  }));
}

async function drain(chatId: string): Promise<void> {
  const { withSessionLock } = await import("../src/agent/session-lock.js");
  await withSessionLock(chatId, async () => {});
}

function isFlush(call: unknown[]): boolean {
  return String((call[0] as Call).system ?? "").includes(FLUSH_MARKER);
}

function isCompaction(call: unknown[]): boolean {
  return String((call[0] as Call).system ?? "").includes(COMPACTION_MARKER);
}

function flushCalls(complete: ReturnType<typeof vi.fn>): string[] {
  return complete.mock.calls
    .filter(isFlush)
    .map((call) => JSON.stringify((call[0] as Call).messages));
}

function routeByPrompt(reply: string) {
  return vi.fn(async (params: Call) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.includes(COMPACTION_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
    return mkAssistant(reply);
  });
}

describe("memory flush sends only what changed since the last successful flush", () => {
  it("the flush after a successful soft-threshold flush carries only the newer messages", async () => {
    const complete = routeByPrompt("main-reply");
    const agent = await setupAgent(complete, 80_000);
    seedSession("delta", markedLines("SOFT", 10));

    await agent.chat("delta", "hello");
    await drain("delta");
    expect(flushCalls(complete)).toHaveLength(1);
    expect(flushCalls(complete)[0]).toContain("SOFT-0 ");
    expect(flushCalls(complete)[0]).toContain("SOFT-9 ");

    await expect(agent.resetSession("delta")).resolves.toEqual({ memoryFlushed: true });
    const flushes = flushCalls(complete);
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).not.toContain("SOFT-0 ");
    expect(flushes[1]).not.toContain("SOFT-9 ");
    expect(flushes[1]).toContain("hello");
    expect(flushes[1]).toContain("main-reply");
  });

  it("makes no flush call when nothing changed since the last successful flush", async () => {
    const complete = vi.fn(async (params: Call) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      throw new Error("main turn unavailable");
    });
    const agent = await setupAgent(complete, 80_000);
    seedSession("idle", markedLines("SOFT", 10));

    await expect(agent.chat("idle", "hello")).rejects.toThrow();
    await drain("idle");
    expect(flushCalls(complete)).toHaveLength(1);

    const before = complete.mock.calls.length;
    await expect(agent.resetSession("idle")).resolves.toEqual({ memoryFlushed: true });
    expect(complete.mock.calls.length).toBe(before);
    expect(agent.hasSession("idle")).toBe(false);
  });

  it("a failed trim flush pays summarisation once and hands the pre-summary messages to the next flush", async () => {
    let flushAttempts = 0;
    const complete = vi.fn(async (params: Call) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) {
        flushAttempts++;
        if (flushAttempts <= 2) throw new Error("boom");
        return mkAssistant("facts noted");
      }
      if (sys.includes(COMPACTION_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("trim-reply");
    });
    const agent = await setupAgent(complete, 120_000);
    seedSession("trim", markedLines("TRIM", 30));

    expect(await agent.chat("trim", "hello")).toBe("trim-reply");
    expect(complete.mock.calls.filter(isCompaction)).toHaveLength(1);
    const session = readFileSync(join(dataDir, "sessions", "trim.jsonl"), "utf-8");
    expect(session).toContain("## Coach Stance");
    expect(session).not.toContain("TRIM-0 ");
    expect(
      readdirSync(join(dataDir, "sessions")).filter((f) => f.startsWith("trim.jsonl.precompact.")),
    ).toHaveLength(1);

    expect(await agent.chat("trim", "again")).toBe("trim-reply");
    expect(complete.mock.calls.filter(isCompaction)).toHaveLength(1);
    expect(flushCalls(complete)).toHaveLength(2);

    await expect(agent.resetSession("trim")).resolves.toEqual({ memoryFlushed: true });
    const flushes = flushCalls(complete);
    expect(flushes).toHaveLength(3);
    expect(flushes[2]).toContain("TRIM-0 ");
    expect(flushes[2]).toContain("TRIM-29 ");
    expect(flushes[2]).toContain("hello");
    expect(flushes[2]).toContain("again");
    expect(flushes[2]).not.toContain("## Coach Stance");
  });
});
