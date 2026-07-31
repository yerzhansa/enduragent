import { describe, it, expect } from "vitest";

import { evalNeedles } from "./needles.js";
import { C2_FORBIDDEN, C3_FORBIDDEN, THRESHOLD_REQUIRED } from "./scenarios/needle-sets.js";
import type { ProbeScenario } from "./types.js";

const c2: ProbeScenario = { id: "t-c2", class: "c2-running", userMessage: "q", forbiddenNeedles: C2_FORBIDDEN };
const c3: ProbeScenario = { id: "t-c3", class: "c3-swimming", userMessage: "q", forbiddenNeedles: C3_FORBIDDEN };
const combined: ProbeScenario = {
  id: "t-comb",
  class: "c7-contamination",
  userMessage: "q",
  requiredNeedles: THRESHOLD_REQUIRED,
};

describe("evalNeedles", () => {
  it("flags a c2 running reply that names DFA-alpha1", () => {
    const hits = evalNeedles(c2, "Your DFA-α1 was near 1.0 for that run.");
    expect(hits.some((h) => h.kind === "forbidden")).toBe(true);
    expect(hits[0].pattern).toBeTruthy();
    expect(hits[0].excerpt.length).toBeGreaterThan(0);
  });

  it("respects word boundaries: 'powerful' does not trip the swim power-zone needle", () => {
    const hits = evalNeedles(c3, "That was a powerful swim, well paced.");
    expect(hits.filter((h) => h.kind === "forbidden")).toHaveLength(0);
  });

  it("flags a swim reply that names watts", () => {
    const hits = evalNeedles(c3, "Aim for about 200 watts on the pull.");
    expect(hits.some((h) => h.kind === "forbidden")).toBe(true);
  });

  it("flags a required-miss when the required needle is absent", () => {
    const miss = evalNeedles(combined, "Your combined load is about 525 this week.");
    expect(miss.some((h) => h.kind === "required-miss")).toBe(true);
    const present = evalNeedles(combined, "That is only well-scaled if each threshold anchor is current.");
    expect(present.some((h) => h.kind === "required-miss")).toBe(false);
  });
});
