import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import { createMemorySnapshot } from "../../engine/src/sport/memory-snapshot.js";
import { JOURNAL_FILENAME } from "../src/memory/journal.js";
import { runMemoryFlush } from "../../engine/src/agent/memory-flush.js";
import { createFakeLLM } from "../../engine/tests/helpers/fake-llm.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-factdating-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("writeSection _updated stamp", () => {
  it("stamps the first body line with today's date", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "FTP 252W (athlete, 2026-06-08)", "chat-tool");

    expect(memory.readSection("goals")).toBe(
      "_updated: 2026-06-11\nFTP 252W (athlete, 2026-06-08)",
    );
  });

  it("uses the store's timezone for the stamp date", () => {
    vi.setSystemTime(new Date("2026-06-11T23:30:00.000Z"));
    const memory = new Memory(dataDir, "Pacific/Auckland");
    memory.writeSection("goals", "race in October");

    expect(memory.readSection("goals")).toBe("_updated: 2026-06-12\nrace in October");
  });

  it("replaces an echoed stale stamp instead of stacking a second one", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "_updated: 2026-01-05\nFTP 255W", "flush");

    const body = memory.readSection("goals");
    expect(body).toBe("_updated: 2026-06-11\nFTP 255W");
    expect(body!.match(/_updated:/g)).toHaveLength(1);
  });

  it("re-stamps content that is only a stale stamp line", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("notes", "_updated: 2026-01-05");

    expect(memory.readSection("notes")).toBe("_updated: 2026-06-11");
  });

  it("stamps empty content as a bare stamp line", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("notes", "");

    expect(memory.readSection("notes")).toBe("_updated: 2026-06-11");
  });

  it("does not fragment section parsing or the snapshot view", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "sub-3:30 century");
    memory.writeSection("schedule", "Mon, Wed, Fri");

    const snapshot = createMemorySnapshot(memory);
    expect(snapshot.listSections()).toEqual(["goals", "schedule"]);
    expect(snapshot.read("schedule")).toContain("Mon, Wed, Fri");
    expect(memory.readSection("goals")).toBe("_updated: 2026-06-11\nsub-3:30 century\n");
  });

  it("journals the stamped body so the journal mirrors written bytes", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("goals", "FTP 252W", "flush");

    const lines = readFileSync(join(dataDir, "memory", JOURNAL_FILENAME), "utf-8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].newBody).toBe("_updated: 2026-06-11\nFTP 252W");
    expect(lines[0].newBody).toBe(memory.readSection("goals"));
  });

  it("renames preserve the original stamp untouched", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("profile", "FTP 247W");
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    memory.renameSection("profile", "cycling-profile", "migration");

    expect(memory.readSection("cycling-profile")).toBe("_updated: 2026-06-11\nFTP 247W");
  });
});

describe("flush prompt dating discipline", () => {
  it("carries the source-and-date rule, the 6-month re-confirm flag, and the stamp prohibition", async () => {
    const memory = new Memory(dataDir);
    const llm = createFakeLLM([""]);

    await runMemoryFlush({
      llm,
      messages: [{ role: "user", content: "My FTP is 252 as of last week" }],
      memory,
      memorySections: [{ name: "goals", description: "Athlete goals" }],
      tz: "UTC",
    });

    const messages = llm.capturedMessages[0] ?? [];
    const content = String(messages[messages.length - 1]?.content ?? "");
    expect(content).toContain('Example: "- FTP 252W (athlete, 2026-06-08)"');
    expect(content).toContain("6 months");
    expect(content).toContain("(re-confirm)");
    expect(content).toContain('Never write "_updated:" lines yourself');
    expect(content).toContain("Today is 2026-06-11");
    expect(content.indexOf("omitted facts will be lost")).toBeLessThan(
      content.indexOf("Dating discipline"),
    );
    expect(content.indexOf("Dating discipline")).toBeLessThan(content.indexOf("Today is"));
  });

  it("the flush memory_write tool produces a stamped section", async () => {
    const memory = new Memory(dataDir);
    const llm = createFakeLLM([""]);

    await runMemoryFlush({
      llm,
      messages: [{ role: "user", content: "I want FTP 280W by August" }],
      memory,
      memorySections: [{ name: "goals", description: "Athlete goals" }],
      tz: "UTC",
    });

    const flushTools = llm.capturedOpts[0]?.tools;
    expect(flushTools).toBeDefined();
    await flushTools!.memory_write.execute!(
      { section: "goals", content: "FTP 280W target (athlete, 2026-06-11)" },
      {} as never,
    );

    expect(memory.readSection("goals")).toBe(
      "_updated: 2026-06-11\nFTP 280W target (athlete, 2026-06-11)",
    );
  });
});
