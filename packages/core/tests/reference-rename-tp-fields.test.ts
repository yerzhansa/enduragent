// trademark-lint:skip-file — anti-corruption layer tests legitimately name
// the TP-trademarked source fields the rename layer reads.
//
// Behavioral tests for the anti-corruption layer per ADR-0012. The rename
// layer reads intervals.icu's TP-trademarked API field names (ctl, atl,
// ctlLoad, atlLoad, rampRate, icu_ctl, icu_atl) at runtime via Record-key
// access and emits plain-English equivalents that metric computers consume
// by name. The TP keys are stripped from the output; the rest of the row
// rides through verbatim.

import { describe, expect, it } from "vitest";

import {
  assertNoTpKeysRemain,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type RenameSummary,
} from "../src/reference/sync/rename-tp-fields.js";

describe("renameTpFieldsOnWellnessRow", () => {
  it("renames a wellness row with all 5 TP fields populated", () => {
    const raw = {
      id: "2026-04-15",
      ctl: 52.1,
      atl: 38.4,
      ctlLoad: 51.9,
      atlLoad: 38.1,
      rampRate: 4.7,
    };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out).toEqual({
      id: "2026-04-15",
      fitness: 52.1,
      fatigue: 38.4,
      fitnessContribution: 51.9,
      fatigueContribution: 38.1,
      weeklyFitnessChange: 4.7,
    });
  });

  it("renames a wellness row with only ctl set — other normalized keys absent", () => {
    const raw = { id: "2026-04-15", ctl: 52.1 };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out).toEqual({ id: "2026-04-15", fitness: 52.1 });
    expect(Object.keys(out)).not.toContain("fatigue");
    expect(Object.keys(out)).not.toContain("fitnessContribution");
    expect(Object.keys(out)).not.toContain("fatigueContribution");
    expect(Object.keys(out)).not.toContain("weeklyFitnessChange");
  });

  it("renames a wellness row with ctl: null — emits fitness: null", () => {
    const raw = { id: "2026-04-15", ctl: null };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out).toEqual({ id: "2026-04-15", fitness: null });
  });

  it("renames a wellness row with no TP fields — no normalized keys added", () => {
    const raw = { id: "2026-04-15", weight: 73.42, restingHR: 51 };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out).toEqual({ id: "2026-04-15", weight: 73.42, restingHR: 51 });
    for (const k of [
      "fitness",
      "fatigue",
      "fitnessContribution",
      "fatigueContribution",
      "weeklyFitnessChange",
    ]) {
      expect(Object.keys(out)).not.toContain(k);
    }
  });

  it("preserves non-TP wellness fields verbatim (id, weight, hrv, soreness, vendor extras)", () => {
    const raw = {
      id: "2026-04-15",
      weight: 73.42,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      soreness: 2,
      vo2max: 56.4,
      bodyFat: 14.6,
      mood: "good",
      vendor_extra: { nested: "yes" },
      ctl: 52.1,
    };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out.id).toBe("2026-04-15");
    expect(out.weight).toBe(73.42);
    expect(out.restingHR).toBe(51);
    expect(out.hrv).toBe(84);
    expect(out.sleepSecs).toBe(27000);
    expect(out.soreness).toBe(2);
    expect(out.vo2max).toBe(56.4);
    expect(out.bodyFat).toBe(14.6);
    expect(out.mood).toBe("good");
    expect(out.vendor_extra).toEqual({ nested: "yes" });
  });

  it("never emits a TP-named key on wellness output", () => {
    const raw = {
      id: "2026-04-15",
      ctl: 52.1,
      atl: 38.4,
      ctlLoad: 51.9,
      atlLoad: 38.1,
      rampRate: 4.7,
    };
    const out = renameTpFieldsOnWellnessRow(raw);
    const banned = ["ctl", "atl", "ctlLoad", "atlLoad", "rampRate"];
    for (const k of banned) {
      expect(Object.keys(out)).not.toContain(k);
    }
  });

  it("increments RenameSummary.skippedNonNumeric for string-typed ctl", () => {
    const summary: RenameSummary = { skippedNonNumeric: {} };
    const raw = { id: "2026-04-15", ctl: "52.1" };
    const out = renameTpFieldsOnWellnessRow(raw, summary);
    expect(summary.skippedNonNumeric).toEqual({ ctl: 1 });
    expect(Object.keys(out)).not.toContain("fitness");
    expect(Object.keys(out)).not.toContain("ctl");
  });

  it("throws on collision — input has both ctl AND a non-null fitness (rename would silently overwrite real data)", () => {
    const raw = { id: "2026-04-15", ctl: 52.1, fitness: 99 };
    expect(() => renameTpFieldsOnWellnessRow(raw)).toThrow(/collision.*'ctl'.*'fitness'/);
  });

  it("tolerates target=null collision — API ships fatigue:null alongside atl:<number>; rename fills in safely", () => {
    // Real-world shape: intervals.icu wellness rows carry both `atl` (Banister
    // ATL) and `fatigue` (subjective 1-5, currently always null). The rename
    // overwriting null is not data loss — only non-null targets trigger the
    // throw. See WellnessDaySchema comment for context.
    const raw = { id: "2026-04-15", atl: 38.4, fatigue: null };
    const out = renameTpFieldsOnWellnessRow(raw);
    expect(out).toEqual({ id: "2026-04-15", fatigue: 38.4 });
  });
});

describe("renameTpFieldsOnActivity", () => {
  it("renames an activity with both icu_ctl and icu_atl", () => {
    const raw = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      icu_ctl: 52.1,
      icu_atl: 38.4,
    };
    const out = renameTpFieldsOnActivity(raw);
    expect(out).toEqual({
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      fitnessAtEnd: 52.1,
      fatigueAtEnd: 38.4,
    });
  });

  it("preserves non-TP activity fields verbatim", () => {
    const raw = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      average_watts: 218,
      icu_training_load: 142,
      icu_intensity: 0.82,
      icu_ctl: 52.1,
      icu_atl: 38.4,
    };
    const out = renameTpFieldsOnActivity(raw);
    expect(out.id).toBe(17654321);
    expect(out.start_date_local).toBe("2026-04-15T07:30:00");
    expect(out.type).toBe("Ride");
    expect(out.moving_time).toBe(5400);
    expect(out.average_watts).toBe(218);
    expect(out.icu_training_load).toBe(142);
    expect(out.icu_intensity).toBe(0.82);
  });

  it("never emits a TP-named key on activity output", () => {
    const raw = {
      id: 17654321,
      icu_ctl: 52.1,
      icu_atl: 38.4,
    };
    const out = renameTpFieldsOnActivity(raw);
    expect(Object.keys(out)).not.toContain("icu_ctl");
    expect(Object.keys(out)).not.toContain("icu_atl");
  });

  it("throws on collision — input has both icu_ctl AND a non-null fitnessAtEnd", () => {
    const raw = { id: 17654321, icu_ctl: 52.1, fitnessAtEnd: 99 };
    expect(() => renameTpFieldsOnActivity(raw)).toThrow(/collision.*'icu_ctl'.*'fitnessAtEnd'/);
  });
});

describe("assertNoTpKeysRemain", () => {
  it("throws on a nested ctl with [<index>]-style path and no row-id values", () => {
    const bundle = {
      wellness: [{ id: "i12345678", weeklyAggregates: { ctl: 50 } }],
    };
    let caught: unknown;
    try {
      assertNoTpKeysRemain(bundle);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("[0]");
    expect(msg).toContain("weeklyAggregates");
    expect(msg).toContain("ctl");
    expect(msg).not.toMatch(/i\d+/);
  });

  it("passes on a clean post-rename bundle", () => {
    const cleanBundle = {
      wellness: [
        {
          id: "2026-04-15",
          fitness: 52.1,
          fatigue: 38.4,
        },
      ],
      activities: [
        {
          id: 17654321,
          fitnessAtEnd: 52.1,
          fatigueAtEnd: 38.4,
        },
      ],
    };
    expect(() => assertNoTpKeysRemain(cleanBundle)).not.toThrow();
  });
});

describe("parseRenamedActivity / parseRenamedWellnessRow — branded type gate", () => {
  // Type-level test: the branded input type forces sync-path authors
  // through the rename layer. The runtime body just delegates to the
  // schema parse; the load-bearing piece is the type signature, exercised
  // here by composing rename → parse and asserting the resulting Activity
  // has the post-rename fields.

  it("parseRenamedActivity accepts the output of renameTpFieldsOnActivity and returns a typed Activity", () => {
    const renamed = renameTpFieldsOnActivity({
      id: 17654321,
      start_date_local: "2026-04-15T07:00:00",
      type: "Ride",
      moving_time: 3600,
      elapsed_time: 3700,
      icu_ctl: 52.1,
      icu_atl: 38.4,
    });
    const activity = parseRenamedActivity(renamed);
    expect(activity.fitnessAtEnd).toBe(52.1);
    expect(activity.fatigueAtEnd).toBe(38.4);
    // TP source keys never appear on the typed surface — the rename layer
    // strips them and the schema's named fields don't include them.
    expect((activity as Record<string, unknown>).icu_ctl).toBeUndefined();
    expect((activity as Record<string, unknown>).icu_atl).toBeUndefined();
  });

  it("parseRenamedActivity accepts explicit null load and intensity on unscoreable sessions", () => {
    const renamed = renameTpFieldsOnActivity({
      id: 17654322,
      start_date_local: "2019-04-15T07:00:00",
      type: "Ride",
      moving_time: 3600,
      elapsed_time: 3700,
      icu_training_load: null,
      icu_intensity: null,
    });
    const activity = parseRenamedActivity(renamed);
    expect(activity.icu_training_load).toBeNull();
    expect(activity.icu_intensity).toBeNull();
  });

  it("parseRenamedWellnessRow accepts the output of renameTpFieldsOnWellnessRow", () => {
    const renamed = renameTpFieldsOnWellnessRow({
      id: "2026-04-15",
      weight: 70,
      restingHR: 50,
      hrv: 80,
      sleepSecs: 28800,
      sleepQuality: 4,
      ctl: 52.1,
      atl: 38.4,
    });
    const day = parseRenamedWellnessRow(renamed);
    expect(day.fitness).toBe(52.1);
    expect(day.fatigue).toBe(38.4);
    expect((day as Record<string, unknown>).ctl).toBeUndefined();
    expect((day as Record<string, unknown>).atl).toBeUndefined();
  });

  it("type system rejects un-renamed input — checked via @ts-expect-error", () => {
    // The directive below fails the build if the line *does* type-check.
    // That's the load-bearing assertion: a sync-path author who skips the
    // rename call gets a type error, not a silent runtime bypass.
    const unrenamedRaw: Record<string, unknown> = {
      id: 17654321,
      start_date_local: "2026-04-15T07:00:00",
      type: "Ride",
      moving_time: 3600,
      elapsed_time: 3700,
    };
    // @ts-expect-error — RenamedActivityRow brand cannot be conjured from a plain Record
    parseRenamedActivity(unrenamedRaw);
  });
});
