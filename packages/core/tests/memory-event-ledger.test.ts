import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { Memory } from "../src/memory/store.js";
import { ChatStore } from "../src/agent/chat-store.js";
import { runMemoryFlush } from "../../engine/src/agent/memory-flush.js";
import { ledgerEventSchema } from "../src/memory/event-ledger.js";
import type { GenerateOpts, GenerateResult } from "../../engine/src/llm-types.js";
import type { LLM } from "../../engine/src/llm.js";
import type { MemorySectionSpec } from "../src/sport.js";

const SECTIONS: readonly MemorySectionSpec[] = [
  { name: "notes", description: "anything else" },
  { name: "medical-history", description: "chronic conditions" },
];

const eventsPathOf = (dataDir: string) => join(dataDir, "memory", "events.jsonl");

const readLines = (dataDir: string) =>
  readFileSync(eventsPathOf(dataDir), "utf-8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));

type ScriptedToolCall = { tool: string; input: unknown };

function executeToolsLLM(calls: ScriptedToolCall[], captured: GenerateOpts[]): LLM {
  return {
    async generate(opts: GenerateOpts): Promise<GenerateResult> {
      captured.push(opts);
      for (const call of calls) {
        const t = (opts.tools ?? {})[call.tool] as
          | {
              execute?: (
                input: unknown,
                ctx: { toolCallId: string; messages: ModelMessage[] },
              ) => Promise<unknown>;
            }
          | undefined;
        if (!t?.execute) throw new Error(`tool ${call.tool} not in flush toolset`);
        await t.execute(call.input, { toolCallId: "test-call", messages: [] });
      }
      return {
        text: "",
        toolCalls: [],
        finishReason: "stop" as const,
        usage: {
          inputTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 0,
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          totalTokens: 0,
        },
      };
    },
  } as unknown as LLM;
}

describe("Memory.appendEvent", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-ledger-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("appends one schema-valid line with a host-stamped ts", () => {
    const memory = new Memory(dataDir);
    memory.appendEvent({
      date: "2026-06-10",
      kind: "override",
      text: "Rode hard despite a rest-day recommendation",
      source: "flush",
    });

    const lines = readLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(() => ledgerEventSchema.parse(lines[0])).not.toThrow();
    expect(lines[0]).toEqual({
      ts: "2026-06-11T08:00:00.000Z",
      date: "2026-06-10",
      kind: "override",
      text: "Rode hard despite a rest-day recommendation",
      source: "flush",
    });
  });

  it("appends without rewriting earlier lines", () => {
    const memory = new Memory(dataDir);
    memory.appendEvent({ date: "2026-06-09", kind: "decision", text: "Switch to base block", source: "flush" });
    const before = readFileSync(eventsPathOf(dataDir), "utf-8");

    memory.appendEvent({ date: "2026-06-10", kind: "outcome", text: "FTP test 252W", source: "flush" });
    const after = readFileSync(eventsPathOf(dataDir), "utf-8");

    expect(readLines(dataDir)).toHaveLength(2);
    expect(after.startsWith(before)).toBe(true);
  });

  it("creates the file owner-only", () => {
    const memory = new Memory(dataDir);
    memory.appendEvent({ date: "2026-06-10", kind: "illness", text: "Head cold", source: "flush" });

    expect(statSync(eventsPathOf(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("rejects a malformed date", () => {
    const memory = new Memory(dataDir);
    expect(() =>
      memory.appendEvent({ date: "June 10", kind: "override", text: "x", source: "flush" }),
    ).toThrow();
    expect(existsSync(eventsPathOf(dataDir))).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const memory = new Memory(dataDir);
    expect(() =>
      memory.appendEvent({
        date: "2026-06-10",
        // @ts-expect-error — invalid kind, schema must reject at runtime
        kind: "weather",
        text: "x",
        source: "flush",
      }),
    ).toThrow();
    expect(existsSync(eventsPathOf(dataDir))).toBe(false);
  });

  it("survives section rewrites, plan overwrites, and a session reset", () => {
    const memory = new Memory(dataDir);
    memory.appendEvent({ date: "2026-06-10", kind: "experiment", text: "Tried 3x20 SST", source: "flush" });
    const snapshot = readFileSync(eventsPathOf(dataDir), "utf-8");

    memory.writeSection("notes", "first");
    memory.writeSection("notes", "second");
    memory.savePlan({ name: "x" });
    expect(readFileSync(eventsPathOf(dataDir), "utf-8")).toBe(snapshot);

    const chat = new ChatStore(dataDir);
    chat.appendMessage("c1", "user", "hi");
    chat.archiveAndReset("c1");
    expect(readFileSync(eventsPathOf(dataDir), "utf-8")).toBe(snapshot);
  });
});
describe("runMemoryFlush ledger integration", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-ledger-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const OVERRIDE_CONVO: ModelMessage[] = [
    { role: "assistant", content: "Tomorrow is a rest day — keep it easy." },
    { role: "user", content: "I rode hard anyway, felt great." },
  ];

  it("an override exchange produces a ledger line", async () => {
    const memory = new Memory(dataDir);
    const captured: GenerateOpts[] = [];
    const llm = executeToolsLLM(
      [
        {
          tool: "ledger_append",
          input: {
            date: "2026-06-10",
            kind: "override",
            text: "Rode hard despite a rest-day recommendation",
          },
        },
      ],
      captured,
    );

    await runMemoryFlush({ llm, messages: OVERRIDE_CONVO, memory, memorySections: SECTIONS, tz: "UTC" });

    const lines = readLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ts: "2026-06-11T08:00:00.000Z",
      date: "2026-06-10",
      kind: "override",
      source: "flush",
    });
  });

  it("the flush toolset exposes exactly the two write tools", async () => {
    const memory = new Memory(dataDir);
    const captured: GenerateOpts[] = [];
    const llm = executeToolsLLM([], captured);

    await runMemoryFlush({ llm, messages: OVERRIDE_CONVO, memory, memorySections: SECTIONS, tz: "UTC" });

    expect(Object.keys(captured[0].tools ?? {}).sort()).toEqual(["ledger_append", "memory_write"]);
  });

  it("the flush prompt carries the extraction clause and the date anchor", async () => {
    const memory = new Memory(dataDir);
    const captured: GenerateOpts[] = [];
    const llm = executeToolsLLM([], captured);

    await runMemoryFlush({ llm, messages: OVERRIDE_CONVO, memory, memorySections: SECTIONS, tz: "UTC" });

    const messages = captured[0].messages ?? [];
    const last = messages[messages.length - 1];
    const content = last.content as string;
    expect(content).toContain("Today is 2026-06-11");
    expect(content).toContain("ledger_append");
    expect(content).toContain("overrode");
  });

  it("a flush that records no event creates no file", async () => {
    const memory = new Memory(dataDir);
    const captured: GenerateOpts[] = [];
    const llm = executeToolsLLM(
      [{ tool: "memory_write", input: { section: "notes", content: "x" } }],
      captured,
    );

    await runMemoryFlush({ llm, messages: OVERRIDE_CONVO, memory, memorySections: SECTIONS, tz: "UTC" });

    expect(existsSync(eventsPathOf(dataDir))).toBe(false);
  });
});
