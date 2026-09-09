import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Memory } from "../src/memory/store.js";
import { formatCompactionNote } from "../src/memory/compaction-note.js";
import { EMPTY_PROVENANCE, UNKNOWN_PROVENANCE } from "../src/provenance.js";
import { createMemoryQueryTool } from "../../engine/src/sport/memory-tools.js";

const DATE = "1998-09-08";
const SUMMARY = "## Training Status\nSummary text retained for later queries.";
const GARMIN = { garmin: true, nonGarmin: false, unknown: false };

describe("daily compaction summaries in Athlete Context", () => {
  let dataDir: string;
  let memory: Memory;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${DATE}T12:00:00Z`));
    dataDir = mkdtempSync(join(tmpdir(), "memory-compaction-context-"));
    memory = new Memory(dataDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the summary from context while retaining it on disk and in memory_query", async () => {
    memory.appendDailyNote("Felt rested before the ride.");
    memory.appendDailyNote(formatCompactionNote(SUMMARY));
    const path = join(dataDir, "memory", `${DATE}.md`);
    const original = readFileSync(path, "utf8");

    const context = memory.getContext();

    expect(context).toContain("## Today's Notes\nFelt rested before the ride.");
    expect(context).not.toContain("Compaction summary");
    expect(context).not.toContain("Training Status");
    expect(context).not.toContain("Summary text retained");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(memory.readDailyNotes()).toContain(formatCompactionNote(SUMMARY));

    const query = createMemoryQueryTool(memory);
    if (!query.execute) throw new Error("memory_query has no executor");
    const result = await query.execute(
      { from: DATE, to: DATE, query: "Summary text retained" },
      { toolCallId: "compaction-context-query", messages: [] },
    );
    expect(result).toContain("Summary text retained for later queries.");
  });

  it.each(["#", "##", "###"])("preserves ordinary %s sections between summaries", (heading) => {
    memory.appendDailyNote(formatCompactionNote(SUMMARY));
    memory.appendDailyNote(`${heading} Ride notes\nFelt rested before the ride.`);
    memory.appendDailyNote(formatCompactionNote("Another summary."));

    expect(memory.getContext()).toBe(
      `## Today's Notes\n${heading} Ride notes\nFelt rested before the ride.`,
    );
  });

  it("omits Today's Notes when only summary blocks remain", () => {
    memory.appendDailyNote(`\n${formatCompactionNote(SUMMARY)}`);
    memory.appendDailyNote(formatCompactionNote("Another summary."));

    expect(memory.getContextWithProvenance()).toEqual({
      text: "",
      provenance: EMPTY_PROVENANCE,
    });
  });

  it("handles CRLF and keeps ordinary notes containing the marker in prose", () => {
    memory.appendDailyNote("Discussed the ### Compaction summary marker.");
    memory.appendDailyNote(formatCompactionNote(SUMMARY).replace(/\n/g, "\r\n"));

    expect(memory.getContext()).toBe(
      "## Today's Notes\nDiscussed the ### Compaction summary marker.",
    );
  });

  it("tracks visible note provenance by original line and rendered offset", () => {
    memory.appendDailyNote(formatCompactionNote(SUMMARY), undefined, UNKNOWN_PROVENANCE);
    memory.appendDailyNote("### Ride notes\nRecovered well.", undefined, GARMIN);

    expect(memory.getContextWithProvenance({ maxChars: 25 }).provenance).toEqual(GARMIN);
  });

  it("does not include hidden summary provenance or notes beyond the context cap", () => {
    memory.appendDailyNote(formatCompactionNote(SUMMARY), undefined, GARMIN);
    memory.appendDailyNote(`### Ride notes\n${"x".repeat(200)}`, undefined, UNKNOWN_PROVENANCE);
    memory.appendDailyNote("Another ride note.", undefined, GARMIN);

    expect(memory.getContextWithProvenance({ maxChars: 80 }).provenance).toEqual(
      UNKNOWN_PROVENANCE,
    );
    expect(memory.getContextWithProvenance().provenance).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: true,
    });
  });
  it("keeps a plain note appended after the summary block", () => {
    memory.appendDailyNote(formatCompactionNote(SUMMARY));
    memory.appendDailyNote("Knee felt fine on the evening spin.");

    const context = memory.getContext();

    expect(context).toContain("Knee felt fine on the evening spin.");
    expect(context).not.toContain("Training Status");
  });
});
