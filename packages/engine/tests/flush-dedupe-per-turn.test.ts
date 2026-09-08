import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import type { LLM, GenerateResult, GenerateOpts } from "../src/llm.js";
import type { MemorySnapshot } from "../src/host-ports.js";
import { summarizeInStages, summarizeDroppedMessages } from "../src/agent/compaction.js";

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";
const COMPACTION_MARKER = "conversation-compaction summarizer";
const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Coach Stance",
  "- Hold volume this week; athlete has not pushed back",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-dedupe-"));
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

// A call is a flush iff the codex Context carries the memory-flush system prompt.
function isFlushCall(call: unknown[]): boolean {
  const params = call[0] as { system?: string } | undefined;
  return typeof params?.system === "string" && params.system.includes(FLUSH_MARKER);
}

function countFlushCalls(complete: ReturnType<typeof vi.fn>): number {
  return complete.mock.calls.filter((c) => isFlushCall(c)).length;
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

function overBudgetLines(ts: string): Array<{ role: string; content: string; ts: string }> {
  return Array.from({ length: 13 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(2_400),
    ts,
  }));
}

const FRESH_TS = new Date().toISOString();
const STALE_TS = "2020-01-01T00:00:00.000Z";

describe("flush dedupe — at most one memory flush per chat() turn", () => {
  it("an overflow-retry storm flushes at most once", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACTION_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY); // compaction lane
      // Main turn: throw overflow twice to drive the retry loop, then recover.
      const mainTurns = complete.mock.calls.filter((c) => {
        const s = (c[0] as { system?: string } | undefined)?.system ?? "";
        return s.length > 0 && !s.includes(FLUSH_MARKER) && !s.includes(COMPACTION_MARKER);
      }).length;
      if (mainTurns <= 2) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return mkAssistant("recovered");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("storm", overBudgetLines(FRESH_TS));

    const text = await agent.chat("storm", "hello");

    expect(text).toBe("recovered");
    expect(countFlushCalls(complete)).toBeLessThanOrEqual(1);
  });

  it("a daily-reset turn does not also flush on trim or compaction", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACTION_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("fresh-day-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    // Stale (predates the daily reset hour) AND over budget.
    seedSession("daily", overBudgetLines(STALE_TS));

    const text = await agent.chat("daily", "hello");

    expect(text).toContain("fresh-day-reply");
    expect(isFlushCall(complete.mock.calls[0])).toBe(false);
    const { withSessionLock } = await import("../src/agent/session-lock.js");
    await withSessionLock("daily", async () => {});
    expect(countFlushCalls(complete)).toBeLessThanOrEqual(2);
  });

  it("a normal single-flush trim turn is unchanged (no false suppression)", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACTION_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("trim-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim", overBudgetLines(FRESH_TS));

    const text = await agent.chat("trim", "hello");

    expect(text).toBe("trim-reply");
    expect(countFlushCalls(complete)).toBe(1);
  });
});

describe("compaction caller tag — the compact tag reaches llm.generate end-to-end", () => {
  const emptyMemory: MemorySnapshot = {
    read: () => null,
    has: () => false,
    listSections: () => [],
    provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: false }),
  };

  function makeLlmSpy() {
    // The compaction path reads only `.text` off the result; the rest of
    // GenerateResult is supplied via cast so the mock stays minimal.
    const generate = vi.fn(
      async (_opts: GenerateOpts): Promise<GenerateResult> =>
        ({
          text: FIVE_SECTION_SUMMARY,
          toolCalls: [],
          finishReason: "stop" as const,
        }) as unknown as GenerateResult,
    );
    return { llm: { generate } as unknown as LLM, generate };
  }

  function mkText(text: string): ModelMessage {
    return { role: "user", content: text };
  }

  it("summarizeInStages threads caller:'compact' into every llm.generate call", async () => {
    const { llm, generate } = makeLlmSpy();
    // recentToKeep defaults to 4, so 6 messages leaves 2 to summarize.
    const messages = Array.from({ length: 6 }, (_, i) => mkText(`turn ${i}`));

    await summarizeInStages({
      messages,
      llm,
      mustPreserveTokens: [],
      memory: emptyMemory,
      caller: "compact",
    });

    expect(generate).toHaveBeenCalled();
    for (const call of generate.mock.calls) {
      expect(call[0]).toMatchObject({ caller: "compact" });
    }
  });

  it("summarizeDroppedMessages threads caller:'compact' into every llm.generate call", async () => {
    const { llm, generate } = makeLlmSpy();

    await summarizeDroppedMessages({
      dropped: [mkText("older turn a"), mkText("older turn b")],
      llm,
      mustPreserveTokens: [],
      memory: emptyMemory,
      caller: "compact",
    });

    expect(generate).toHaveBeenCalled();
    for (const call of generate.mock.calls) {
      expect(call[0]).toMatchObject({ caller: "compact" });
    }
  });
});
