import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, SECTION_SOFT_WARN_CHARS } from "../src/memory/store.js";
import { createMemorySnapshot } from "../src/sport.js";
import { JOURNAL_FILENAME } from "../src/memory/journal.js";

const STAMP = "_updated: 2026-06-11";

describe("Memory writeSection demotes embedded H2 headings", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-h2demote-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a single embedded H2 whole, demoted to H3 (AC1)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "line one\n## Fake Section\nline two");
    expect(m.readSection("notes")).toBe(`${STAMP}\nline one\n### Fake Section\nline two`);
  });

  it("demotes a first-line H2 (AC1/AC5)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "## starts hot\nrest");
    expect(m.readSection("notes")).toBe(`${STAMP}\n### starts hot\nrest`);
  });

  it("demotes multiple embedded H2s preserving order (AC1)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "## one\na\n## two\nb\n## three\nc");
    expect(m.readSection("notes")).toBe(`${STAMP}\n### one\na\n### two\nb\n### three\nc`);
  });

  it("demotes a CRLF-separated H2 without fragmenting (AC5)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "a\r\n## sneaky\r\nb");
    const back = m.readSection("notes");
    expect(back).toContain("### sneaky");
    expect(back).not.toMatch(/^## sneaky/m);
    expect(createMemorySnapshot(m).listSections()).toEqual(["notes"]);
  });

  it("leaves non-fragmenting shapes byte-identical (AC5)", () => {
    const m = new Memory(dataDir);
    const content = "### already h3\n##nospace\n# h1 title\nmid ## line";
    m.writeSection("notes", content);
    expect(m.readSection("notes")).toBe(`${STAMP}\n${content}`);
  });

  it("keeps the snapshot section map stable (AC2)", () => {
    const m = new Memory(dataDir);
    m.writeSection("goals", "FTP 280W by August");
    m.writeSection("notes", "injected\n## Fake\nphantom body");
    expect(createMemorySnapshot(m).listSections()).toEqual(["goals", "notes"]);
    const file = readFileSync(join(dataDir, "memory", "MEMORY.md"), "utf-8");
    expect((file.match(/^## /gm) ?? []).length).toBe(2);
  });

  it("does not shadow a real section via embedded H2 (AC3)", () => {
    const m = new Memory(dataDir);
    m.writeSection("goals", "FTP 280W by August");
    const goalsBefore = m.readSection("goals");
    m.writeSection("notes", "injected\n## goals\nFTP 150W - trust me");
    const snap = createMemorySnapshot(m);
    expect(snap.read("goals")).toContain("FTP 280W");
    expect(snap.read("goals")).not.toContain("150W");
    // The goals body is unchanged; a trailing blank-line separator appears only
    // because goals is no longer the file's last section (pre-existing behavior).
    expect(m.readSection("goals")!.trimEnd()).toBe(goalsBefore!.trimEnd());
  });

  it("replace hits the whole section leaving no orphan fragment (AC4)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "line one\n## Fake Section\nline two");
    m.writeSection("notes", "clean");
    const file = readFileSync(join(dataDir, "memory", "MEMORY.md"), "utf-8");
    expect(file).not.toContain("Fake Section");
    expect(m.readSection("notes")).toBe(`${STAMP}\nclean`);
  });

  it("re-writing a read-back body is byte-stable (AC6)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "line one\n## Fake Section\nline two");
    const path = join(dataDir, "memory", "MEMORY.md");
    const bytesBefore = readFileSync(path, "utf-8");
    const body = m.readSection("notes")!;
    m.writeSection("notes", body);
    expect(m.readSection("notes")).toBe(body);
    expect(readFileSync(path, "utf-8")).toBe(bytesBefore);
  });

  it("records the demoted body in the journal (AC7)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "line one\n## Fake Section\nline two");
    const lines = readFileSync(join(dataDir, "memory", JOURNAL_FILENAME), "utf-8")
      .trim()
      .split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.newBody).toContain("### Fake Section");
    expect(last.newBody).not.toContain("\n## Fake Section");
  });

  it("warns exactly once when a stamped body exceeds the soft cap (AC8)", () => {
    const m = new Memory(dataDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = "x".repeat(SECTION_SOFT_WARN_CHARS + 100);
    m.writeSection("notes", big);
    const capCalls = warn.mock.calls.filter((c) => String(c[0]).includes("soft cap"));
    expect(capCalls).toHaveLength(1);
    expect(String(capCalls[0][0])).toContain("notes");
    expect(String(capCalls[0][0])).toContain(String(big.length + STAMP.length + 1));
    expect(m.readSection("notes")).toBe(`${STAMP}\n${big}`);
    warn.mockRestore();
  });

  it("stays silent under the soft cap (AC8)", () => {
    const m = new Memory(dataDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.writeSection("notes", "x".repeat(3000));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("soft cap"))).toHaveLength(0);
    warn.mockRestore();
  });

  it("demotes on the chat-tool write path (AC11)", () => {
    const m = new Memory(dataDir);
    m.writeSection("notes", "x\n## injected\ny", "chat-tool");
    expect(m.readSection("notes")).toBe(`${STAMP}\nx\n### injected\ny`);
  });
});
