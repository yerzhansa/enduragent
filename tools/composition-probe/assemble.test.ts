import { describe, it, expect } from "vitest";

import { buildMockPrompt } from "./assemble.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../packages/core/src/agent/system-prompt.js";

describe("buildMockPrompt", () => {
  const { block1, block2, fullSystem } = buildMockPrompt();

  it("orders block1 as soul, cores, deep-protocol pointer, then the five rule blocks", () => {
    const iSoul = block1.indexOf("# Endurance Coach");
    const iCores = block1.indexOf("# Sport Cores");
    const iDeep = block1.indexOf("# Deep Protocol Library");
    const iRules = block1.indexOf("# Untrusted Data Handling");
    expect(iSoul).toBeGreaterThanOrEqual(0);
    expect(iSoul).toBeLessThan(iCores);
    expect(iCores).toBeLessThan(iDeep);
    expect(iDeep).toBeLessThan(iRules);
    for (const heading of [
      "# Untrusted Data Handling",
      "# Recall Before Answering",
      "# Voice & Register",
      "# Workout Review",
      "# Tool-Call Budget",
    ]) {
      expect(block1).toContain(heading);
    }
    for (const core of ["## Cycling", "## Running", "## Swimming"]) {
      expect(block1).toContain(core);
    }
  });

  it("applies the tool-name substitution in block1", () => {
    expect(block1).toContain("activities_list");
    expect(block1).not.toContain("intervals_fetch_activities");
  });

  it("heads block2 with the boundary marker text", () => {
    const marker = SYSTEM_PROMPT_CACHE_BOUNDARY.replace(/^\n\n---\n\n/, "");
    expect(block2.split("\n")[0]).toBe(marker);
  });

  it("fences the athlete context in block2, not block1", () => {
    expect(block2).toContain("=== BEGIN ATHLETE DATA");
    expect(block2).toContain("=== END ATHLETE DATA ===");
    expect(block1).not.toContain("=== BEGIN ATHLETE DATA");
    expect(block1).not.toContain("as of 1998-05-12");
  });

  it("is deterministic and byte-identical across calls", () => {
    expect(buildMockPrompt().fullSystem).toBe(fullSystem);
    expect(buildMockPrompt().block1).toBe(block1);
  });
});
