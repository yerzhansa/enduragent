import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";

describe("Memory daily-note dedup", () => {
  let dataDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-dailydedup-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function skipEvents(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter(
        (e: unknown): e is Record<string, unknown> =>
          e !== null && (e as Record<string, unknown>).event === "daily_note_duplicate_skipped",
      );
  }

  function noteFile(date: string): string {
    return readFileSync(join(dataDir, "memory", `${date}.md`), "utf-8");
  }

  it("skips an exact-duplicate note on the same date and warns once without content", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("rode 2h", "2026-06-11");
    const afterFirst = noteFile("2026-06-11");
    m.appendDailyNote("rode 2h", "2026-06-11");
    const afterSecond = noteFile("2026-06-11");

    expect(afterSecond).toBe(afterFirst);
    const skips = skipEvents();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ date: "2026-06-11", noteChars: "rode 2h".length });
    expect(JSON.stringify(skips[0])).not.toContain("rode 2h");
  });

  it("appends distinct notes in order", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("first note", "2026-06-11");
    m.appendDailyNote("second note", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe("first note\nsecond note");
    expect(skipEvents()).toHaveLength(0);
  });

  it("appends a substring note (not exact-boundary match)", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("ate well today", "2026-06-11");
    m.appendDailyNote("ate well", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe("ate well today\nate well");
    expect(skipEvents()).toHaveLength(0);
  });

  it("skips a duplicate multi-line note but appends a different multi-line note", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("a\nb", "2026-06-11");
    m.appendDailyNote("a\nb", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe("a\nb");
    expect(skipEvents()).toHaveLength(1);

    m.appendDailyNote("a\nc", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe("a\nb\na\nc");
  });

  it("skips a single-line note equal to one full line of a prior multi-line block (accepted edge)", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("line1\nline2", "2026-06-11");
    const before = noteFile("2026-06-11");
    m.appendDailyNote("line1", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe(before);
    expect(skipEvents()).toHaveLength(1);
  });

  it("dedups per date: same text on another date still appends", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("session done", "2026-07-01");
    m.appendDailyNote("session done", "2026-07-01");
    expect(noteFile("2026-07-01")).toBe("session done");
    m.appendDailyNote("session done", "2026-07-02");
    expect(noteFile("2026-07-02")).toBe("session done");
  });

  it("dedups against today's file when no date is passed", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("default-date note");
    m.appendDailyNote("default-date note");
    expect(noteFile("2026-06-11")).toBe("default-date note");
    expect(skipEvents()).toHaveLength(1);
  });

  it("documents that an empty-string note against a blank line is skipped", () => {
    const m = new Memory(dataDir);
    m.appendDailyNote("a\n", "2026-06-11");
    const before = noteFile("2026-06-11");
    m.appendDailyNote("", "2026-06-11");
    expect(noteFile("2026-06-11")).toBe(before);
    expect(skipEvents()).toHaveLength(1);
  });
});
