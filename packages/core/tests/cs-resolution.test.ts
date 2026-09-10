import { describe, it, expect } from "vitest";
import type { LatestJson } from "../src/reference/schemas/latest.js";
import { resolveRunningCs, collectRunCsRows } from "../src/reference/cs-resolution.js";

// Same sportSettings row shape the step-5 CS-source gate validates — both read it
// through the shared collectRunCsRows walk, so a schema change breaks both.
function latestWith(sportSettings: unknown): LatestJson {
  return { athlete_profile: { sportSettings } } as unknown as LatestJson;
}

describe("resolveRunningCs", () => {
  it("resolves a platform threshold_pace for a Run row", () => {
    const r = resolveRunningCs(latestWith([{ types: ["Run"], threshold_pace: 4.0 }]));
    expect(r).toEqual({ criticalSpeedMps: 4.0, source: "platform", confidence: null });
  });

  it("matches TrailRun rows too", () => {
    const r = resolveRunningCs(latestWith([{ types: ["TrailRun"], threshold_pace: 3.5 }]));
    expect(r?.criticalSpeedMps).toBe(3.5);
  });

  it("manual critical_speed outranks platform threshold_pace (the locked precedence)", () => {
    const r = resolveRunningCs(
      latestWith([{ types: ["Run"], critical_speed: 3.8, threshold_pace: 4.0 }]),
    );
    expect(r).toEqual({ criticalSpeedMps: 3.8, source: "athlete_manual", confidence: null });
  });

  it("threads cs_confidence through as disclosure-only", () => {
    const r = resolveRunningCs(
      latestWith([{ types: ["Run"], threshold_pace: 4.0, cs_confidence: "high" }]),
    );
    expect(r?.confidence).toBe("high");
  });

  it("returns null for a non-running profile (resolve-or-skip)", () => {
    expect(resolveRunningCs(latestWith([{ types: ["Ride"], ftp: 247 }]))).toBeNull();
  });

  it("skips an out-of-band value rather than emitting a corrupt anchor", () => {
    expect(resolveRunningCs(latestWith([{ types: ["Run"], threshold_pace: 7.5 }]))).toBeNull();
    expect(resolveRunningCs(latestWith([{ types: ["Run"], critical_speed: -1 }]))).toBeNull();
  });

  it("falls back to a valid platform value when a manual override is out of band", () => {
    const r = resolveRunningCs(
      latestWith([{ types: ["Run"], critical_speed: 9.9, threshold_pace: 4.0 }]),
    );
    expect(r).toEqual({ criticalSpeedMps: 4.0, source: "platform", confidence: null });
  });

  it("returns null on null / empty / malformed input", () => {
    expect(resolveRunningCs(null)).toBeNull();
    expect(resolveRunningCs(latestWith([]))).toBeNull();
    expect(resolveRunningCs({} as unknown as LatestJson)).toBeNull();
  });
});

describe("collectRunCsRows (shared with the step-5 gate)", () => {
  it("yields only run-family rows' CS fields", () => {
    const rows = collectRunCsRows({
      sportSettings: [
        { types: ["Run"], critical_speed: 3.8, threshold_pace: 4.0, cs_confidence: "medium" },
        { types: ["Ride"], ftp: 247 },
      ],
    });
    expect(rows).toEqual([{ criticalSpeed: 3.8, thresholdPace: 4.0, confidence: "medium" }]);
  });

  it("returns [] for a malformed profile", () => {
    expect(collectRunCsRows(null)).toEqual([]);
    expect(collectRunCsRows({ sportSettings: "nope" })).toEqual([]);
    expect(collectRunCsRows(42)).toEqual([]);
  });
});
