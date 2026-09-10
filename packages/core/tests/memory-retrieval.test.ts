import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import { boundToolResultProvenance } from "../../engine/src/sport/bound-tool-result.js";
import {
  createLedgerAppendTool,
  createMemoryReadTool,
  createMemoryTools,
} from "../../engine/src/sport/memory-tools.js";

const sections = [
  { name: "profile", description: "Athlete profile" },
  { name: "notes", description: "Notes", inject: false },
];
const options = { toolCallId: "memory-test", messages: [] };

describe("memory retrieval", () => {
  let root: string;
  let memory: Memory;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-retrieval-"));
    memory = new Memory(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1998-03-12T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it("records chat events once across normalization, store restarts, and flushes", async () => {
    const tools = createMemoryTools(memory, sections);
    expect(Object.keys(tools)).toContain("ledger_append");
    const event = { date: "1998-03-12", kind: "decision", text: "Keep the easy week" } as const;
    expect(await tools.ledger_append.execute!(event, options)).toEqual({ recorded: true });
    const original = memory.readEventsRaw();
    expect(JSON.parse(original)).toMatchObject({ ...event, source: "chat" });
    expect(
      await tools.ledger_append.execute!({ ...event, text: "  KEEP\n the\t easy week  " }, options),
    ).toEqual({ recorded: false, duplicate: true });
    const onAppend = vi.fn();
    const flush = createLedgerAppendTool(new Memory(root), "flush", undefined, onAppend);
    expect(await flush.execute!(event, options)).toEqual({ recorded: false, duplicate: true });
    expect(onAppend).not.toHaveBeenCalled();
    expect(memory.readEventsRaw()).toBe(original);
    expect(await flush.execute!({ ...event, kind: "outcome" }, options)).toEqual({
      recorded: true,
    });
    expect(onAppend).toHaveBeenCalledOnce();
    expect(memory.readEventsRaw().trim().split("\n")).toHaveLength(2);
    expect(memory.appendEvent({ ...event, date: "1998-03-13", source: "chat" })).toBe(true);
  });

  it("skips malformed ledger lines while detecting duplicates", () => {
    appendFileSync(join(root, "memory", "events.jsonl"), "broken\nnull\n{}\n");
    const event = {
      date: "1998-03-12",
      kind: "illness",
      text: "Head cold",
      source: "chat",
    } as const;
    expect(memory.appendEvent(event)).toBe(true);
    expect(memory.appendEvent(event)).toBe(false);
  });

  it("reads only non-injected sections in chat and preserves the full flush read", async () => {
    memory.writeSection("profile", "Injected profile body");
    memory.writeSection("notes", "Hidden notes body");
    await memory.savePlan({ name: "Spring plan" });
    const chat = createMemoryTools(memory, sections).memory_read;
    const result = await chat.execute!({}, options);
    expect(result).not.toContain("Injected profile body");
    expect(result).toContain("Hidden notes body");
    expect(result).toContain("Spring plan");
    const full = await createMemoryReadTool(memory, "Read everything").execute!({}, options);
    expect(full).toContain("Injected profile body");
    expect(full).toContain("Hidden notes body");
    expect(full).toContain("Spring plan");
  });

  it("reports an empty complement", async () => {
    memory.writeSection("profile", "Already injected");
    expect(await createMemoryTools(memory, sections).memory_read.execute!({}, options)).toBe(
      "Every stored section is already in your Athlete Context.",
    );
  });

  it("queries journaled section rewrites by timestamp and any history field", async () => {
    expect(memory.readJournalRaw()).toBe("");
    vi.setSystemTime(new Date("1998-02-28T23:59:00.000Z"));
    memory.writeSection("profile", "FTP 220\nOld threshold");
    vi.setSystemTime(new Date("1998-03-12T08:00:00.000Z"));
    memory.writeSection("profile", "FTP 240\nNew threshold");
    memory.writeSection("notes", "Unrelated entry");
    appendFileSync(join(root, "memory", "MEMORY.history.jsonl"), "broken\nnull\n{}\n");
    const query = createMemoryTools(memory, sections).memory_query;
    for (const term of ["PROFILE", "220", "240"]) {
      const result = await query.execute!(
        { from: "1998-03-01", to: "1998-03-31", query: term },
        options,
      );
      expect(result).toContain("## 1998-03-12");
      expect(result).toContain(
        "history: profile — was: _updated: 1998-02-28 FTP 220 Old threshold / now: _updated: 1998-03-12 FTP 240 New threshold",
      );
      expect(result).not.toContain("## 1998-02-28");
      expect(result).not.toContain("Unrelated entry");
    }
    expect(
      await query.execute!({ from: "1998-03-01", to: "1998-03-31", query: "absent" }, options),
    ).toContain("no daily notes, events, or history found");
  });

  it("caps each history body and the combined query result", async () => {
    for (let index = 0; index < 60; index++) {
      memory.writeSection("profile", `${index} ${"a".repeat(300)}`);
    }
    const result = await createMemoryTools(memory, sections).memory_query.execute!(
      { from: "1998-03-12", to: "1998-03-12" },
      options,
    );
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected query text");
    expect(result).not.toContain("a".repeat(201));
    expect(result.length).toBeLessThanOrEqual(20_100);
    expect(result).toContain("[truncated — narrow the date range or add a query term]");
  });

  it("windows a history preview around the matched text", async () => {
    memory.writeSection("notes", `${"x".repeat(250)} ALLERGIC TO IBUPROFEN ${"y".repeat(50)}`);
    const query = createMemoryTools(memory, sections).memory_query;
    const result = await query.execute!(
      { from: "1998-03-12", to: "1998-03-12", query: "ibuprofen" },
      options,
    );
    expect(result).toContain("ALLERGIC TO IBUPROFEN");
    expect(result).toMatch(/now: …x+ ALLERGIC TO IBUPROFEN y+$/m);
    expect(result).not.toContain("x".repeat(201));
    expect(result).not.toContain("now: x");
  });

  it("keeps the prefix shape when the match sits near the start", async () => {
    memory.writeSection("notes", `Tolerates caffeine ${"z".repeat(300)}`);
    const query = createMemoryTools(memory, sections).memory_query;
    const result = await query.execute!(
      { from: "1998-03-12", to: "1998-03-12", query: "caffeine" },
      options,
    );
    expect(result).toMatch(/now: _updated: 1998-03-12 Tolerates caffeine z+…$/m);
    expect(result).not.toContain("now: …");
  });

  it("never splits a surrogate pair at the preview window edge", async () => {
    const emoji = "🚴".repeat(160);
    memory.writeSection("notes", `${emoji} hates gels! ${emoji}`);
    const query = createMemoryTools(memory, sections).memory_query;
    const result = await query.execute!(
      { from: "1998-03-12", to: "1998-03-12", query: "gels" },
      options,
    );
    expect(result).not.toMatch(/\p{Cs}/u);
    expect(result).toContain("hates gels!");
    expect(result).toMatch(/now: …(?:🚴)+ hates gels! (?:🚴)+…$/m);
  });

  it("drops the oldest dates first when the combined result overflows", async () => {
    memory.appendDailyNote(`older ${"o".repeat(21_000)}`, "1998-03-10");
    memory.appendDailyNote("newer note survives", "1998-03-11");
    const result = await createMemoryTools(memory, sections).memory_query.execute!(
      { from: "1998-03-10", to: "1998-03-11" },
      options,
    );
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected query text");
    expect(result.indexOf("## 1998-03-11")).toBeLessThan(result.indexOf("## 1998-03-10"));
    expect(result).toContain("newer note survives");
    expect(result).not.toContain("o".repeat(21_000));
    expect(result).toContain("[truncated — narrow the date range or add a query term]");
  });

  it("marks journal history as unknown provenance", async () => {
    memory.writeSection("profile", "Historical threshold");
    const result = await createMemoryTools(memory, sections, { bindProvenance: true }).memory_query
      .execute!({ from: "1998-03-12", to: "1998-03-12" }, options);
    expect(boundToolResultProvenance(result)).toMatchObject({ unknown: true });
  });
});
