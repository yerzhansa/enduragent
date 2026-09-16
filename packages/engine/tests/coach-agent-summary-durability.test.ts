import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { withTestModelProfiles } from "./helpers/model-profiles.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import { COMPACTION_SUMMARY_MARKER } from "../src/agent/compaction-note.js";
import { Memory } from "../../core/src/memory/store.js";
import type { EngineHostPorts, MemoryStorePort } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-summary-durability-"));
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
  const base = baseAgentConfig(dataDir);
  const ports: EngineHostPorts = {
    ...base,
    config: withTestModelProfiles({
      ...base.config,
      contextWindowTokens: 120_000,
      compactContextWindowTokens: 120_000,
    }),
  };
  return {
    agent: new CoachAgent(cyclingSport as unknown as Sport, ports),
    memory: ports.memory as MemoryStorePort,
  };
}

function mkAssistant(text: string, stopReason: "stop" | "length" = "stop") {
  return {
    text,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
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

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";
const COMPACT_MARKER = "conversation-compaction summarizer";

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

const FRESH_TS = new Date().toISOString();
const bigHistory = Array.from({ length: 30 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `MARK-${i} ` + "x".repeat(2_400),
  ts: FRESH_TS,
}));

const smallHistory = Array.from({ length: 4 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `hi-${i}`,
  ts: FRESH_TS,
}));

function markerCount(note: string): number {
  return note.split(COMPACTION_SUMMARY_MARKER).length - 1;
}

function dateKeyForToday(): string {
  const files = readdirSync(join(dataDir, "memory")).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.md$/.test(f),
  );
  expect(files).toHaveLength(1);
  return files[0].replace(/\.md$/, "");
}

describe("compaction summary durability into daily notes", () => {
  it("site 1 (trim path): the dropped-message summary lands in the day's note, heading-demoted", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACT_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, memory } = await setupAgent(complete);
    seedSession("trim", bigHistory);

    const text = await agent.chat("trim", "hello");

    expect(text).toBe("final-reply");
    const note = memory.readDailyNotes();
    expect(note).toContain(COMPACTION_SUMMARY_MARKER);
    expect(note).toContain("#### Coach Stance");
    expect(note).not.toMatch(/^## Coach Stance/m);
  });

  it("site 3 (overflow rescue): the rescue summary persists and the turn still replies", async () => {
    let chatCalls = 0;
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACT_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      chatCalls++;
      if (chatCalls === 1) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, memory } = await setupAgent(complete);
    seedSession("overflow", smallHistory);

    const text = await agent.chat("overflow", "hello");

    expect(text).toBe("final-reply");
    const note = memory.readDailyNotes();
    expect(note).toContain(COMPACTION_SUMMARY_MARKER);
    expect(note).toContain("#### Coach Stance");
  });

  it("duplicate-skip: two compactions with identical summary text produce exactly one block", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACT_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, memory } = await setupAgent(complete);

    seedSession("dup", bigHistory);
    await agent.chat("dup", "first");
    seedSession("dup", bigHistory);
    await agent.chat("dup", "second");

    const note = memory.readDailyNotes();
    expect(markerCount(note)).toBe(1);
  });

  it("a persisted summary survives a session reset and is found via the dated read path", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACT_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, memory } = await setupAgent(complete);
    seedSession("reset", bigHistory);

    await agent.chat("reset", "hello");
    const dateKey = dateKeyForToday();

    await agent.resetSession("reset");

    const recovered = memory.readDailyNotesInRange(dateKey, dateKey);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].text).toContain(COMPACTION_SUMMARY_MARKER);
    expect(recovered[0].text).toContain("#### Coach Stance");
  });

  it("a daily-note write failure is swallowed and never fails the turn", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.includes(COMPACT_MARKER)) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Memory.prototype, "appendDailyNote").mockImplementation(() => {
      throw new Error("disk full");
    });
    const { agent, memory } = await setupAgent(complete);
    seedSession("ac5", bigHistory);

    const text = await agent.chat("ac5", "hello");

    expect(text).toBe("final-reply");
    expect(memory.readDailyNotes()).not.toContain(COMPACTION_SUMMARY_MARKER);
    const logged = readFileSync(join(dataDir, "logs", "log.jsonl"), "utf-8");
    expect(logged).toContain("Failed to persist compaction summary to daily note");
  });
});
