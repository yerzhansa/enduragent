import { describe, expect, it } from "vitest";

import {
  assertNoTpKeysRemain,
  decodeWellnessRow,
  parseRenamedActivity,
  renameTpFieldsOnActivity,
  RowRejection,
} from "../src/reference/sync/rename-tp-fields.js";

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

describe("parseRenamedActivity — branded type gate", () => {
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

  it("type system rejects un-renamed input — checked via @ts-expect-error", () => {
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

describe("decodeWellnessRow", () => {
  const BODY = { weight: 70.5, restingHR: 50, hrv: 80, sleepSecs: 28800, sleepQuality: 3 };

  it("gives every load average its coach word and drops the platform key", () => {
    const day = decodeWellnessRow({ id: "1998-07-17", ...BODY, ctl: 52.1, atl: 38.4, ctlLoad: 51.9, atlLoad: 38.1,
      rampRate: 4.7, fatigue: null });
    expect(day).toEqual({ id: "1998-07-17", ...BODY, fitness: 52.1, fatigue: 38.4, fitnessContribution: 51.9,
      fatigueContribution: 38.1, weeklyFitnessChange: 4.7, subjectiveFatigue: null });
  });

  it("leaves out a load average the platform did not send and keeps one it sent as null", () => {
    const day = decodeWellnessRow({ id: "1998-07-17", ...BODY, ctl: null });
    expect(day).toEqual({ id: "1998-07-17", ...BODY, fitness: null, subjectiveFatigue: null });
  });

  it("carries every other field of the day through unchanged", () => {
    const rest = { soreness: 2, vo2max: 56.4, bodyFat: 14.6, mood: "good", vendor_extra: { nested: "yes" } };
    expect(decodeWellnessRow({ id: "1998-07-17", ...BODY, ...rest, ctl: 52.1 })).toMatchObject(rest);
  });

  it("keeps a logged fatigue score apart from the short-term load average", () => {
    const day = decodeWellnessRow({ id: "1998-07-17", ...BODY, atl: 27.787529, ctl: 31.2, fatigue: 3 });
    expect(day).toEqual({ id: "1998-07-17", ...BODY, fitness: 31.2, fatigue: 27.787529, subjectiveFatigue: 3 });
  });

  it("gives a day with a logged score and no load average no load fatigue", () => {
    const day = decodeWellnessRow({ id: "1998-07-17", ...BODY, fatigue: 3 });
    expect(day).toEqual({ id: "1998-07-17", ...BODY, subjectiveFatigue: 3 });
    expect(day).not.toHaveProperty("fatigue");
  });

  it("writes a null score on a day the athlete logged none", () => {
    expect(decodeWellnessRow({ id: "1998-07-17", ...BODY, atl: 27.787529 })).toHaveProperty("subjectiveFatigue", null);
  });

  it("refuses a day it already decoded", () => {
    const day = decodeWellnessRow({ id: "1998-07-17", ...BODY, atl: 27.787529 });
    expect(day).not.toHaveProperty("fitness");
    expect(() => decodeWellnessRow(day)).toThrow(new RowRejection("decode", "subjectiveFatigue"));
  });

  it("refuses a logged score that is not a whole number", () => {
    expect(() => decodeWellnessRow({ id: "1998-07-17", ...BODY, fatigue: 27.787529 })).toThrow(
      new RowRejection("decode", "subjectiveFatigue"),
    );
  });

  it("refuses a load average that is not a number and names it in the coach's word", () => {
    const decode = () => decodeWellnessRow({ id: "1998-07-17", ...BODY, ctl: "marker-4471" });
    expect(decode).toThrow(new RowRejection("decode", "fitness"));
    expect(decode).not.toThrow(/marker-4471/);
  });

  it("refuses a row that already carries a coach word for a load average, even when null", () => {
    expect(() => decodeWellnessRow({ id: "1998-07-17", ...BODY, fitness: null })).toThrow(
      new RowRejection("decode", "fitness"),
    );
  });

  it("rejects a row that is not an object", () => {
    for (const wire of [null, "1998-07-17", [{ id: "1998-07-17" }]]) {
      expect(() => decodeWellnessRow(wire)).toThrow(new RowRejection("shape"));
    }
  });

  it("names the key of a value it cannot read and never repeats the value", () => {
    const decode = () => decodeWellnessRow({ id: "1998-07-17", ...BODY, restingHR: "marker-4471" });
    expect(decode).toThrow(new RowRejection("decode", "restingHR"));
    expect(decode).not.toThrow(/marker-4471/);
  });

  it("rejects a row that would keep a platform load key", () => {
    expect(() => decodeWellnessRow({ id: "1998-07-17", ...BODY, icu_atl: 27.787529 })).toThrow(
      new RowRejection("decode", "icu_atl"),
    );
    expect(() => decodeWellnessRow({ id: "1998-07-17", ...BODY, sportInfo: [{ type: "Ride", ctl: 31.2 }] })).toThrow(
      new RowRejection("decode", "ctl"),
    );
  });
});
