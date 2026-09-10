import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import { JOURNAL_FILENAME } from "../src/memory/journal.js";
import { createMemoryTools } from "../../engine/src/sport/memory-tools.js";
import { runMemoryFlush } from "../../engine/src/agent/memory-flush.js";
import { createFakeLLM } from "../../engine/tests/helpers/fake-llm.js";

const journalPathOf = (dataDir: string) => join(dataDir, "memory", JOURNAL_FILENAME);

const readJournal = (dataDir: string) =>
  readFileSync(journalPathOf(dataDir), "utf-8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));

const memoryFilePath = (dataDir: string) => join(dataDir, "memory", "MEMORY.md");

describe("memory journal", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-journal-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("first write journals oldBody null", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "Sub-3:30 century", "chat-tool");

    const lines = readJournal(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op: "write-section",
      section: "goals",
      oldBody: null,
      source: "chat-tool",
    });
    expect(lines[0].newBody).toMatch(/^_updated: \d{4}-\d{2}-\d{2}\nSub-3:30 century$/);
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("destructive replace journals the prior body and the lost fact is replay-recoverable", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("medical-history", "Hypertension; lisinopril 10mg", "flush");
    memory.writeSection("medical-history", "Asthma, mild", "flush");

    expect(readFileSync(memoryFilePath(dataDir), "utf-8")).not.toContain("lisinopril");

    const lines = readJournal(dataDir);
    expect(lines).toHaveLength(2);
    expect(lines[1].oldBody).toMatch(
      /^_updated: \d{4}-\d{2}-\d{2}\nHypertension; lisinopril 10mg$/,
    );

    const replayDir = mkdtempSync(join(tmpdir(), "cc-journal-replay-"));
    const replayMemory = new Memory(replayDir);
    for (const entry of lines.slice(0, lines.length - 1)) {
      replayMemory.writeSection(entry.section, entry.newBody);
    }
    expect(replayMemory.readSection("medical-history")).toContain("lisinopril 10mg");
    rmSync(replayDir, { recursive: true, force: true });
  });

  it("appends are byte-stable so earlier lines are never rewritten", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("medical-history", "Hypertension; lisinopril 10mg", "flush");
    const before = readFileSync(journalPathOf(dataDir), "utf-8");

    memory.writeSection("medical-history", "Asthma, mild", "flush");
    const after = readFileSync(journalPathOf(dataDir), "utf-8");

    expect(after.startsWith(before)).toBe(true);
  });

  it("savePlan overwrite journals the old plan JSON", () => {
    const memory = new Memory(dataDir);
    memory.savePlan({ name: "Base 1" }, "sport-tool");
    memory.savePlan({ name: "Build 1" }, "chat-tool");

    const lines = readJournal(dataDir);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      op: "save-plan",
      section: null,
      oldBody: JSON.stringify({ name: "Base 1" }, null, 2),
      newBody: JSON.stringify({ name: "Build 1" }, null, 2),
      source: "chat-tool",
    });
  });

  it("renameSections journals one full-file entry and noops journal nothing", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("profile", "FTP 247W, 72kg");
    memory.writeSection("schedule", "Mon, Wed, Fri");

    const before = readFileSync(memoryFilePath(dataDir), "utf-8");
    memory.renameSections(
      [
        ["profile", "cycling-profile"],
        ["missing", "x"],
      ],
      "migration",
    );

    let lines = readJournal(dataDir);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({
      op: "rename-sections",
      section: null,
      oldBody: before,
      newBody: readFileSync(memoryFilePath(dataDir), "utf-8"),
      source: "migration",
    });

    memory.renameSections([["missing", "x"]]);
    lines = readJournal(dataDir);
    expect(lines).toHaveLength(3);
  });

  it("omitted source defaults to unattributed", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "x");

    const lines = readJournal(dataDir);
    expect(lines[0].source).toBe("unattributed");
  });

  it("journal failure warns and the memory write still succeeds", () => {
    const memory = new Memory(dataDir);
    mkdirSync(join(dataDir, "memory", JOURNAL_FILENAME));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => memory.writeSection("goals", "Sub-3:30 century")).not.toThrow();
    expect(memory.readSection("goals")).toMatch(/^_updated: \d{4}-\d{2}-\d{2}\nSub-3:30 century$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("memory journal append failed"));
  });

  it("creates the journal file with 0600 mode", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "Sub-3:30 century");

    expect(statSync(journalPathOf(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("chat memory_write tool threads chat-tool", async () => {
    const memory = new Memory(dataDir);
    const tools = createMemoryTools(memory, [{ name: "goals", description: "Athlete goals" }]);

    await tools.memory_write.execute!(
      { type: "memory", section: "goals", content: "Sub-3:30 century" },
      {} as never,
    );

    const lines = readJournal(dataDir);
    expect(lines[lines.length - 1]).toMatchObject({ op: "write-section", source: "chat-tool" });
  });

  it("chat plan_save tool threads chat-tool", async () => {
    const memory = new Memory(dataDir);
    const tools = createMemoryTools(memory, [{ name: "goals", description: "Athlete goals" }]);

    await tools.plan_save.execute!({ plan: { name: "Base 1" } }, {} as never);

    const lines = readJournal(dataDir);
    expect(lines[lines.length - 1]).toMatchObject({ op: "save-plan", source: "chat-tool" });
  });

  it("flush path threads flush", async () => {
    const memory = new Memory(dataDir);
    const llm = createFakeLLM([""]);

    await runMemoryFlush({
      llm,
      messages: [{ role: "user", content: "I want FTP 280W by August" }],
      memory,
      memorySections: [{ name: "goals", description: "Athlete goals" }],
    });

    const flushTools = llm.capturedOpts[0]?.tools;
    expect(flushTools).toBeDefined();
    expect(flushTools).toHaveProperty("memory_write");
    await flushTools!.memory_write.execute!(
      { section: "goals", content: "Target FTP 280W by August" },
      {} as never,
    );

    const lines = readJournal(dataDir);
    expect(lines[lines.length - 1]).toMatchObject({
      op: "write-section",
      section: "goals",
      source: "flush",
    });
  });
});
