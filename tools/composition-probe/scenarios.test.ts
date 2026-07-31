import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { ALL_SCENARIOS } from "./scenarios/index.js";
import { SUITE_COMPOSITION } from "./constants.js";
import { MOCK_TOOL_NAMES } from "./tools.js";
import { C2_FORBIDDEN, C3_FORBIDDEN, THRESHOLD_REQUIRED } from "./scenarios/needle-sets.js";
import { SKILL_PINNED_FACTS } from "./scenarios/skill-facts.js";

function mockRead(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./mock/${rel}`, import.meta.url)), "utf-8");
}

const CORES = ["core-cycling.md", "core-running.md", "core-swimming.md"].map(mockRead).join("\n");

describe("scenario suite shape", () => {
  it("has 70 unique scenario ids", () => {
    expect(ALL_SCENARIOS).toHaveLength(70);
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(70);
  });

  it("matches the pinned per-class composition", () => {
    for (const [cls, count] of Object.entries(SUITE_COMPOSITION)) {
      expect(ALL_SCENARIOS.filter((s) => s.class === cls)).toHaveLength(count);
    }
  });

  it("every c7 scenario carries its class's binding needles", () => {
    const c7 = ALL_SCENARIOS.filter((s) => s.class === "c7-contamination");
    const combined = c7.filter((s) => (s.judgeItems ?? []).includes("caveat-thresholds"));
    expect(combined).toHaveLength(2);
    for (const s of combined) {
      expect(s.judgeItems).toContain("caveat-thresholds");
      expect(s.judgeItems).toContain("caveat-cost");
      expect(s.requiredNeedles).toBe(THRESHOLD_REQUIRED);
    }
    for (const s of c7.filter((x) => !combined.includes(x))) {
      expect(s.forbiddenNeedles === C2_FORBIDDEN || s.forbiddenNeedles === C3_FORBIDDEN).toBe(true);
    }
  });

  it("every c8 expectedTools name exists in the mock union", () => {
    for (const s of ALL_SCENARIOS.filter((x) => x.class === "c8-tool-choice")) {
      for (const name of s.expectedTools ?? []) {
        expect(name === "<none>" || MOCK_TOOL_NAMES.includes(name)).toBe(true);
      }
    }
  });

  it("every c9 skillTarget resolves and carries a core-absent fact", () => {
    for (const s of ALL_SCENARIOS.filter((x) => x.class === "c9-deep-protocol")) {
      const target = s.skillTarget;
      expect(target).toBeDefined();
      const key = `${target!.sport}-${target!.topic}`;
      const file = mockRead(`skills/${key}.md`);
      const facts = SKILL_PINNED_FACTS[key];
      expect(facts).toBeDefined();
      expect(facts.some((f) => file.includes(f) && !CORES.includes(f))).toBe(true);
    }
  });
});
