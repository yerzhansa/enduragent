import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
// Import the Sport-consuming helpers from the package entry (dist) so their
// Sport type matches cyclingSport's — mixing the src copy trips the private-
// field brand check under the workspace typecheck.
import { createMemoryTools, getEffectiveSections } from "@enduragent/core";
import { cyclingSport } from "@enduragent/sport-cycling";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-inject-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(): Memory {
  const m = new Memory(dataDir);
  m.writeSection("person", "Name: Sam; weight 72kg");
  m.writeSection("notes", "prefers hill repeats, dislikes the trainer");
  m.writeSection("random-legacy", "stale orphan body not matching any spec");
  m.appendDailyNote("felt strong on the climb today");
  m.savePlan({ name: "Base Build", primaryGoal: "raise FTP", totalWeeks: 8, status: "active" });
  return m;
}

describe("getContext inject-tiering: excluded sections drop, orphans keep injecting", () => {
  it("includes only inject-flagged sections plus orphans; drops spec'd-but-excluded", () => {
    const m = seed();
    const context = m.getContext({ excludeSections: ["notes"] });
    // Injected section present.
    expect(context).toContain("## person");
    expect(context).toContain("Name: Sam");
    // Spec'd-but-excluded (inject === false → in the exclude set) is dropped.
    expect(context).not.toContain("## notes");
    expect(context).not.toContain("dislikes the trainer");
    // Orphan (in neither list) is kept — no silent visibility loss.
    expect(context).toContain("## random-legacy");
    expect(context).toContain("stale orphan body");
    // Today's notes and plan summary still render.
    expect(context).toContain("## Today's Notes");
    expect(context).toContain("felt strong on the climb");
    expect(context).toContain("## Current Plan");
    expect(context).toContain("raise FTP");
  });

  it("returns the full store when called with no opts (memory_read path)", () => {
    const m = seed();
    const full = m.getContext();
    expect(full).toContain("## person");
    expect(full).toContain("## notes");
    expect(full).toContain("dislikes the trainer");
    expect(full).toContain("## random-legacy");
  });
});

describe("effective-section inject flags: explicit on every core and sport section", () => {
  it("marks cycling-profile inject and equipment/history non-inject; core notes non-inject", () => {
    const sections = getEffectiveSections(cyclingSport);
    const byName = new Map(sections.map((s) => [s.name, s]));
    expect(byName.get("cycling-profile")?.inject).toBe(true);
    expect(byName.get("cycling-equipment")?.inject).toBe(false);
    expect(byName.get("cycling-history")?.inject).toBe(false);
    expect(byName.get("person")?.inject).toBe(true);
    expect(byName.get("schedule")?.inject).toBe(true);
    expect(byName.get("goals")?.inject).toBe(true);
    expect(byName.get("preferences")?.inject).toBe(true);
    expect(byName.get("medical-history")?.inject).toBe(true);
    expect(byName.get("notes")?.inject).toBe(false);
  });
});

describe("memory_read chat description", () => {
  it("describes the complement and plan state", () => {
    const m = new Memory(dataDir);
    const tools = createMemoryTools(m, getEffectiveSections(cyclingSport));
    const desc = (tools.memory_read as { description?: string }).description ?? "";
    expect(desc).toContain("only stored sections that Athlete Context does not show");
    expect(desc).toContain("plan state");
  });
});
