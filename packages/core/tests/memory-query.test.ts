import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import { createMemoryTools } from "../../engine/src/sport/memory-tools.js";
import type { MemorySectionSpec } from "../src/sport.js";

const SECTIONS: readonly MemorySectionSpec[] = [{ name: "notes", description: "misc" }];

const eventsPathOf = (dataDir: string) => join(dataDir, "memory", "events.jsonl");

describe("memory_query tool", () => {
  let dataDir: string;
  let memory: Memory;
  let queryTool: ReturnType<typeof createMemoryTools>["memory_query"];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-memquery-"));
    memory = new Memory(dataDir);
    queryTool = createMemoryTools(memory, SECTIONS).memory_query;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("registers memory_query in createMemoryTools", () => {
    const tools = createMemoryTools(memory, SECTIONS);
    expect(Object.keys(tools)).toContain("memory_query");
    expect(tools.memory_read.description).toContain(
      "only stored sections that Athlete Context does not show",
    );
  });

  it("returns a past-dated note inside the range", async () => {
    memory.appendDailyNote("Knee pain after the third interval", "2026-03-02");

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05" },
      {} as never,
    )) as string;

    expect(result).toContain("## 2026-03-02");
    expect(result).toContain("Knee pain");
  });

  it("query returns only matching lines and dates", async () => {
    memory.appendDailyNote("ftp bumped to 255", "2026-03-02");
    memory.appendDailyNote("slept badly", "2026-03-02");
    memory.appendDailyNote("easy spin", "2026-03-04");

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05", query: "ftp" },
      {} as never,
    )) as string;

    expect(result).toContain("ftp bumped to 255");
    expect(result).not.toContain("slept badly");
    expect(result).not.toContain("2026-03-04");
  });

  it("query is case-insensitive", async () => {
    memory.appendDailyNote("ftp bumped to 255", "2026-03-02");

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05", query: "FTP" },
      {} as never,
    )) as string;

    expect(result).toContain("ftp bumped to 255");
  });

  it("empty range reports cleanly", async () => {
    const result = (await queryTool.execute!(
      { from: "2026-01-01", to: "2026-01-31" },
      {} as never,
    )) as string;

    expect(result).toBe(
      "Memory query 2026-01-01..2026-01-31: no daily notes, events, or history found.",
    );
  });

  it("joins in-range ledger events, excludes out-of-range, skips malformed", async () => {
    writeFileSync(
      eventsPathOf(dataDir),
      [
        '{"ts":"2026-03-03T10:00:00.000Z","date":"2026-03-03","kind":"override","text":"swapped VO2 for endurance","source":"flush"}',
        '{"ts":"2026-05-20T10:00:00.000Z","date":"2026-05-20","kind":"override","text":"deload week","source":"flush"}',
        "not json{{{",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05" },
      {} as never,
    )) as string;

    expect(result).toContain("event:");
    expect(result).toContain("swapped VO2");
    expect(result).not.toContain("2026-05-20");
  });

  it("works with no events.jsonl present", async () => {
    memory.appendDailyNote("morning ride", "2026-03-02");

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05" },
      {} as never,
    )) as string;

    expect(result).toContain("morning ride");
  });

  it("from after to returns an Error string", async () => {
    const result = (await queryTool.execute!(
      { from: "2026-03-05", to: "2026-03-01" },
      {} as never,
    )) as string;

    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("after");
  });

  it("range over 366 days returns an Error string", async () => {
    const result = (await queryTool.execute!(
      { from: "2025-01-01", to: "2026-06-01" },
      {} as never,
    )) as string;

    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("366");
  });

  it("invalid calendar date returns an Error string", async () => {
    const result = (await queryTool.execute!(
      { from: "2026-02-31", to: "2026-03-05" },
      {} as never,
    )) as string;

    expect(result.startsWith("Error:")).toBe(true);
  });

  it("truncates oversized results with the marker", async () => {
    memory.appendDailyNote("x".repeat(30_000), "2026-03-02");

    const result = (await queryTool.execute!(
      { from: "2026-03-01", to: "2026-03-05" },
      {} as never,
    )) as string;

    expect(result.length).toBeLessThanOrEqual(20_100);
    expect(result.endsWith("[truncated — narrow the date range or add a query term]")).toBe(true);
  });

  it("365-file corpus scans under the budget", { timeout: 15_000 }, async () => {
    const start = Date.parse("2025-06-01T00:00:00Z");
    for (let i = 0; i < 365; i++) {
      const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      memory.appendDailyNote(`note for day ${i}`, date);
    }

    const t0 = performance.now();
    const result = (await queryTool.execute!(
      { from: "2025-06-01", to: "2026-05-31" },
      {} as never,
    )) as string;
    const ms = performance.now() - t0;
    console.info(`memory_query 365-file scan: ${ms.toFixed(1)} ms`);

    expect(ms).toBeLessThan(1000);
    expect(result).toContain("2025-06-01");
    expect(result).toContain("2026-05-31");
  });

  it("tool definition is static", () => {
    const t1 = createMemoryTools(new Memory(dataDir), SECTIONS).memory_query;
    const t2 = createMemoryTools(new Memory(dataDir), SECTIONS).memory_query;

    expect(t1.description).toBe(t2.description);
    expect(t1.description).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
