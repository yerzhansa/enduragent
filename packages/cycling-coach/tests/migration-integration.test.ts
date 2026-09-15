import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledAcceptedCatalog, CoachAgent } from "@enduragent/core";
import { cyclingSport } from "@enduragent/sport-cycling";
import { migrateCyclingLegacySections } from "@enduragent/sport-cycling/migrate";
import { baseAgentConfig } from "../../core/tests/helpers/base-agent-config.js";

describe("legacy-section migration — binary startup integration (steps 1-3)", () => {
  let dataDir: string;
  let memoryFile: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-migrate-int-"));
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    memoryFile = join(dataDir, "memory", "MEMORY.md");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it("migrates legacy section names through agent.getMemory() at startup", () => {
    // Step 1: pre-seed fixture with full legacy shape.
    writeFileSync(
      memoryFile,
      "## profile\nFTP 247W, 72kg\n" +
        "## schedule\nMon, Wed, Fri\n" +
        "## goals\nSub-3:30 century in October\n" +
        "## equipment\nTrek Émonda, Wahoo Kickr\n" +
        "## health\nHypertension; lisinopril 10mg; knee twinge resolved\n" +
        "## preferences\nIndoor when raining\n" +
        "## notes\nCurious about VO2max blocks\n",
      "utf-8",
    );

    // Step 2: construct the agent (mirrors src/index.ts startup path).
    const agent = new CoachAgent(cyclingSport, baseAgentConfig(dataDir), {
      catalog: bundledAcceptedCatalog(),
    });

    // Wiring: this is exactly what src/index.ts does immediately after
    // agent construction. The integration test asserts that calling the
    // migrator via the agent's getMemory() accessor produces the expected
    // file shape — proving the seam used by the binary is correct.
    migrateCyclingLegacySections(agent.getMemory());

    // Step 3: assert post-migration file shape.
    const after = readFileSync(memoryFile, "utf-8");

    // Legacy names absent
    expect(after).not.toMatch(/^## profile$/m);
    expect(after).not.toMatch(/^## equipment$/m);
    expect(after).not.toMatch(/^## health$/m);

    // Cycling-prefixed names present with original content
    expect(after).toContain("## cycling-profile\nFTP 247W, 72kg\n");
    expect(after).toContain("## cycling-equipment\nTrek Émonda, Wahoo Kickr\n");
    expect(after).toContain(
      "## cycling-history\nHypertension; lisinopril 10mg; knee twinge resolved\n",
    );

    // Core-shared sections untouched
    expect(after).toContain("## schedule\nMon, Wed, Fri\n");
    expect(after).toContain("## goals\nSub-3:30 century in October\n");
    expect(after).toContain("## preferences\nIndoor when raining\n");
    expect(after).toContain("## notes\nCurious about VO2max blocks\n");
  });

  it("is a no-op for fresh installs (no MEMORY.md present)", () => {
    // No file pre-seeded. Construct agent, run migrator, file should not be created.
    const agent = new CoachAgent(cyclingSport, baseAgentConfig(dataDir), {
      catalog: bundledAcceptedCatalog(),
    });
    expect(() => migrateCyclingLegacySections(agent.getMemory())).not.toThrow();

    const events = logSpy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])));
    expect(events.map((e: Record<string, unknown>) => e.outcome)).toEqual([
      "noop",
      "noop",
      "noop",
    ]);
  });

  it("is idempotent — second call after construction leaves file unchanged", () => {
    writeFileSync(memoryFile, "## profile\nFTP 247W\n## schedule\nMon, Wed, Fri\n", "utf-8");

    const agent = new CoachAgent(cyclingSport, baseAgentConfig(dataDir), {
      catalog: bundledAcceptedCatalog(),
    });
    migrateCyclingLegacySections(agent.getMemory());
    const afterFirst = readFileSync(memoryFile, "utf-8");

    migrateCyclingLegacySections(agent.getMemory());
    const afterSecond = readFileSync(memoryFile, "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterFirst).toContain("## cycling-profile\nFTP 247W\n");
  });
});
