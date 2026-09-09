import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { selectPeriodizationModel, computeTotalWeeks } from "../src/periodization.js";
import type { AthleteProfile } from "../src/schemas.js";

function makeProfile(overrides: Partial<AthleteProfile> = {}): AthleteProfile {
  return {
    experienceLevel: "intermediate",
    ftpWatts: 250,
    volumeTier: "medium",
    scheduleType: "flexible",
    sessionsPerWeek: 4,
    needsExtraRecovery: false,
    goalType: "general",
    ...overrides,
  };
}

describe("selectPeriodizationModel", () => {
  it("selects linear for beginners", () => {
    const p = makeProfile({ experienceLevel: "beginner" });
    expect(selectPeriodizationModel(p, 12)).toBe("linear");
  });

  it("selects reverse_linear for short plans (<= 8 weeks)", () => {
    const p = makeProfile({ experienceLevel: "intermediate" });
    expect(selectPeriodizationModel(p, 8)).toBe("reverse_linear");
  });

  it("selects polarized for advanced + high volume", () => {
    const p = makeProfile({
      experienceLevel: "advanced",
      volumeTier: "high",
    });
    expect(selectPeriodizationModel(p, 16)).toBe("polarized");
  });

  it("selects block for intermediate + race goal", () => {
    const p = makeProfile({
      experienceLevel: "intermediate",
      goalType: "race",
    });
    expect(selectPeriodizationModel(p, 12)).toBe("block");
  });

  it("falls back to pyramidal", () => {
    const p = makeProfile({
      experienceLevel: "intermediate",
      goalType: "general",
    });
    expect(selectPeriodizationModel(p, 12)).toBe("pyramidal");
  });
});

describe("computeTotalWeeks", () => {
  it("calculates weeks from race date", () => {
    const future = new Date();
    future.setDate(future.getDate() + 84); // 12 weeks
    const p = makeProfile({
      goalType: "race",
      raceDate: future.toISOString().split("T")[0],
      raceType: "gran_fondo",
    });
    const weeks = computeTotalWeeks(p);
    expect(weeks).toBeGreaterThanOrEqual(11);
    expect(weeks).toBeLessThanOrEqual(13);
  });

  it("clamps to minimum 8 weeks", () => {
    const near = new Date();
    near.setDate(near.getDate() + 14); // 2 weeks out
    const p = makeProfile({
      goalType: "race",
      raceDate: near.toISOString().split("T")[0],
    });
    expect(computeTotalWeeks(p)).toBe(8);
  });

  it("clamps to maximum 24 weeks", () => {
    const far = new Date();
    far.setDate(far.getDate() + 365);
    const p = makeProfile({
      goalType: "race",
      raceDate: far.toISOString().split("T")[0],
    });
    expect(computeTotalWeeks(p)).toBe(24);
  });

  it("uses race type defaults when no date", () => {
    const p = makeProfile({ goalType: "race", raceType: "century" });
    expect(computeTotalWeeks(p)).toBe(12);
  });

  it("uses experience defaults for general goals", () => {
    const p = makeProfile({
      goalType: "general",
      experienceLevel: "beginner",
    });
    expect(computeTotalWeeks(p)).toBe(8);
  });

  // AC4 — daysUntil is local-midnight-to-local-midnight in athlete TZ.
  // Without the fix, `new Date("2026-08-15")` is parsed as UTC midnight, so
  // a Pacific athlete at local 23:00 on Aug 14 would see daysUntil = 0
  // (instead of 1) — and the week count would drop by 1 vs an athlete in UTC.
  describe("AC4: race countdown is athlete-local", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("America/Los_Angeles at local 23:00 on Aug 14 → 1 day, 8 weeks (clamped)", () => {
      // 2026-08-14T23:00 PDT = 2026-08-15T06:00Z
      vi.setSystemTime(new Date("2026-08-15T06:00:00Z"));
      const p = makeProfile({
        goalType: "race",
        raceDate: "2026-08-15",
      });
      expect(computeTotalWeeks(p, "America/Los_Angeles")).toBe(8);
    });

    it("Asia/Tokyo at local 02:00 on Aug 15 → 0 days, 8 weeks (clamped)", () => {
      // 2026-08-15T02:00+09:00 = 2026-08-14T17:00Z
      vi.setSystemTime(new Date("2026-08-14T17:00:00Z"));
      const p = makeProfile({
        goalType: "race",
        raceDate: "2026-08-15",
      });
      expect(computeTotalWeeks(p, "Asia/Tokyo")).toBe(8);
    });

    it("12-week race date counts the same in any TZ", () => {
      vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
      const p = makeProfile({
        goalType: "race",
        raceDate: "2026-07-24", // 84 days = 12 weeks
      });
      expect(computeTotalWeeks(p, "UTC")).toBe(12);
      expect(computeTotalWeeks(p, "Asia/Tokyo")).toBe(12);
      expect(computeTotalWeeks(p, "America/Los_Angeles")).toBe(12);
    });
  });
});
