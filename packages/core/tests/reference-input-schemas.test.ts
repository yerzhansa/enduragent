import { describe, it, expect } from "vitest";

import {
  ActivitySchema,
  WellnessDaySchema,
  WeeklyRollupSchema,
  FtpHistoryPointSchema,
  PlannedEventSchema,
  IcuIntervalRepSchema,
  ZoneTimesSchema,
  PowerCurveDataSchema,
  HrCurveDataSchema,
  SustainabilityFamilyCurvesSchema,
  ActivityStreamsSchema,
  AthleteSchema,
  FixtureSchema,
} from "../src/reference/schemas/inputs.js";

describe("PlannedEventSchema", () => {
  it.each([{}, { type: null, name: null }, { type: "Ride", name: "Endurance" }])(
    "accepts absent and nullish event provenance %#",
    (extension) => {
      const event = {
        id: 1,
        category: "WORKOUT",
        start_date_local: "2026-07-20T08:00:00",
        ...extension,
      };
      expect(PlannedEventSchema.parse(event)).toEqual(event);
    },
  );

  it("types the full Planning event payload", () => {
    const event = {
      id: 2,
      category: "RACE_A",
      start_date_local: "2026-10-04T08:00:00",
      name: "Gran Fondo Almaty",
      type: null,
      moving_time: 18_000,
      icu_training_load: 360,
      description: "A-priority goal event",
      workout_doc: { steps: [] },
    };
    expect(PlannedEventSchema.parse(event)).toEqual(event);
  });
});

describe("ActivitySchema (z.looseObject)", () => {
  it("round-trips a realistic intervals.icu activity preserving every field, including TP-trademark fields", () => {
    const realisticActivity = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,

      icu_training_load: 142,
      icu_intensity: 0.82,

      average_watts: 218,
      average_heartrate: 148,

      icu_zone_times: [
        { id: "Z1", secs: 600 },
        { id: "Z2", secs: 1800 },
        { id: "Z3", secs: 2400 },
        { id: "Z4", secs: 540 },
        { id: "Z5", secs: 60 },
      ],
      pace_zone_times: undefined,
      hr_zone_times: [500, 1700, 2600, 540, 60, 0, 0],

      decoupling: 4.2,
      pa_hr: 3.1,
      icu_efficiency_factor: 1.46,
      icu_intervals: [
        { type: "WORK", duration: 1200, average_watts: 280, average_heartrate: 165 },
        { type: "RECOVERY", duration: 300, average_watts: 120, average_heartrate: 110 },
      ],

      paired_event_id: 8899,
      rpe: 6,

      kj: 1180,

      icu_atl: 38.4,
      icu_ctl: 52.1,
      tsb: 13.7,

      vendor_id: "intervals.icu",
      stream_url: "https://intervals.icu/api/v1/activity/17654321/streams",
    };

    expect(ActivitySchema.parse(realisticActivity)).toEqual(realisticActivity);
  });

  it("accepts an Activity with no power meter (average_watts absent, icu_training_load absent)", () => {
    const noPowerActivity = {
      id: 17654322,
      start_date_local: "2026-04-15T18:00:00",
      type: "WeightTraining",
      moving_time: 2700,
      elapsed_time: 2900,
      average_heartrate: 122,
    };
    expect(ActivitySchema.parse(noPowerActivity)).toEqual(noPowerActivity);
  });

  it("accepts an Activity whose id is the string form 'i<digits>' (the API uses this shape on some endpoints)", () => {
    const stringIdActivity = {
      id: "i12345678",
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_training_load: 142,
    };
    expect(ActivitySchema.parse(stringIdActivity)).toEqual(stringIdActivity);
  });

  it("accepts an Activity whose pace_zone_times is null (API writes null, not absent, when the series is unavailable)", () => {
    const nullZoneActivity = {
      id: "i12345679",
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      pace_zone_times: null,
      hr_zone_times: null,
    };
    expect(ActivitySchema.parse(nullZoneActivity)).toEqual(nullZoneActivity);
  });

  it("accepts an Activity whose icu_zone_times uses the object form {id, secs} (the API's native bin shape)", () => {
    const objectFormActivity = {
      id: 17654323,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_training_load: 142,
      icu_intensity: 0.82,
      average_heartrate: 148,
      icu_zone_times: [
        { id: "Z1", secs: 600 },
        { id: "Z2", secs: 1800 },
        { id: "Z3", secs: 2400 },
      ],
      hr_zone_times: [
        { id: "Z1", secs: 500 },
        { id: "Z2", secs: 1700 },
      ],
    };
    expect(ActivitySchema.parse(objectFormActivity)).toEqual(objectFormActivity);
  });

  it("rejects an Activity whose icu_zone_times carries a bare-number entry (the upstream reads zone.get('id') and raises on an int, so bare-number bins are unportable and must not reach the read side)", () => {
    const bareNumberZoneActivity = {
      id: 17654324,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_zone_times: [600, 1800, 2400, 540, 60, 0, 0],
    };
    expect(ActivitySchema.safeParse(bareNumberZoneActivity).success).toBe(false);
  });

  it("accepts an icu_zone_times object bin without `secs` (the oracle defaults a missing secs to 0 via zone.get('secs', 0), so the bin is processable, not a parse failure)", () => {
    const missingSecsActivity = {
      id: 17654325,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_zone_times: [{ id: "Z1", secs: 600 }, { id: "Z2" }],
    };
    expect(ActivitySchema.safeParse(missingSecsActivity).success).toBe(true);
  });
});

describe("WellnessDaySchema (z.looseObject)", () => {
  it("round-trips a realistic intervals.icu wellness day preserving every field, including TP-trademark fields", () => {
    const realisticWellness = {
      id: "2026-04-15",
      weight: 73.42,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,

      bodyFat: 14.6,
      leanMass: 62.7,

      soreness: 2,

      vo2max: 56.4,

      ctl: 52.1,
      atl: 38.4,
      ctlLoad: 51.9,
      atlLoad: 38.1,
      rampRate: 4.7,

      mood: "good",
    };

    expect(WellnessDaySchema.parse(realisticWellness)).toEqual(realisticWellness);
  });

  it("reads body metrics the day leaves out as null", () => {
    expect(WellnessDaySchema.parse({ id: "1998-07-17", fitness: 31.2 })).toEqual({
      id: "1998-07-17",
      fitness: 31.2,
      weight: null,
      restingHR: null,
      hrv: null,
      sleepSecs: null,
      sleepQuality: null,
    });
  });
});

describe("WeeklyRollupSchema (z.looseObject)", () => {
  it("round-trips a typical weekly rollup with extra forward-compat fields", () => {
    const realisticWeek = {
      weekStartDate: "2026-04-13",
      weeklyLoad: 612,
      dailyLoads: [78, 142, 0, 95, 134, 88, 75],
      weeklyRecoveryHours: 14.5,

      weeklyTimeSeconds: 28800,
      sourceSyncedAt: "2026-04-19T22:30:00Z",
    };

    expect(WeeklyRollupSchema.parse(realisticWeek)).toEqual(realisticWeek);
  });

  it("rejects a weekly rollup whose dailyLoads is not exactly length 7", () => {
    const malformed = {
      weekStartDate: "2026-04-13",
      weeklyLoad: 100,
      dailyLoads: [10, 20, 30, 40, 50, 60],
      weeklyRecoveryHours: 12,
    };

    expect(WeeklyRollupSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("FtpHistoryPointSchema (z.looseObject)", () => {
  it("round-trips a test-source FTP history point with extra metadata", () => {
    const point = {
      date: "2026-03-22",
      ftp: 285,
      source: "test" as const,

      protocol: "20min",
      testActivityId: 17654987,
    };

    expect(FtpHistoryPointSchema.parse(point)).toEqual(point);
  });

  it("rejects an FTP history point whose source is not 'test' or 'estimate'", () => {
    const malformed = {
      date: "2026-03-22",
      ftp: 285,
      source: "guess",
    };

    expect(FtpHistoryPointSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an FTP history point whose ftp is non-positive or non-integer", () => {
    expect(
      FtpHistoryPointSchema.safeParse({ date: "2026-03-22", ftp: 0, source: "test" }).success,
    ).toBe(false);
    expect(
      FtpHistoryPointSchema.safeParse({ date: "2026-03-22", ftp: 285.5, source: "test" }).success,
    ).toBe(false);
  });
});

describe("PlannedEventSchema (z.looseObject)", () => {
  it("round-trips a calendar workout event with the optional name field", () => {
    const event = {
      id: 8899,
      category: "WORKOUT",
      start_date_local: "2026-04-15T07:30:00",
      name: "Sweet-spot 3x12",

      icu_paired_activity_id: 17654321,
      external_url: "https://intervals.icu/events/8899",
    };

    expect(PlannedEventSchema.parse(event)).toEqual(event);
  });

  it("round-trips a planned event without the optional name field", () => {
    const event = {
      id: 9001,
      category: "RACE",
      start_date_local: "2026-06-08T08:00:00",
    };

    expect(PlannedEventSchema.parse(event)).toEqual(event);
  });
});

describe("IcuIntervalRepSchema (z.looseObject)", () => {
  it("round-trips a WORK rep with extended per-rep telemetry", () => {
    const rep = {
      type: "WORK",
      duration: 1200,
      average_watts: 280,
      average_heartrate: 165,

      max_watts: 312,
      max_heartrate: 172,
      distance: 8400,
      elevation_gain: 42,
      pace: 285,
      cadence: 92,
    };

    expect(IcuIntervalRepSchema.parse(rep)).toEqual(rep);
  });

  it("accepts nullable + omitted optional power/HR fields (the 'no power meter' case)", () => {
    const ridelessRep = { type: "RECOVERY", duration: 300 };
    expect(IcuIntervalRepSchema.parse(ridelessRep)).toEqual(ridelessRep);

    const explicitNullRep = {
      type: "RECOVERY",
      duration: 300,
      average_watts: null,
      average_heartrate: null,
    };
    expect(IcuIntervalRepSchema.parse(explicitNullRep)).toEqual(explicitNullRep);
  });
});

describe("ZoneTimesSchema (z.looseObject)", () => {
  it("round-trips a 7-zone time-in-zone object plus extra forward-compat fields", () => {
    const zoneTimes = {
      z1: 600,
      z2: 1800,
      z3: 2400,
      z4: 540,
      z5: 60,
      z6: 0,
      z7: 0,

      z8: 0,
      total: 5400,
    };

    expect(ZoneTimesSchema.parse(zoneTimes)).toEqual(zoneTimes);
  });

  it("accepts a partially-populated zone-times object (sparse rides)", () => {
    const partial = { z1: 1200, z2: 4200 };
    expect(ZoneTimesSchema.parse(partial)).toEqual(partial);
  });
});

describe("Curve / stream / athlete input schemas", () => {
  const win1 = "r.2026-05-08.2026-06-04";
  const win2 = "r.2026-04-10.2026-05-07";
  const sus = "r.2026-04-24.2026-06-04";

  it("PowerCurveDataSchema round-trips the {list:[{id,secs,watts}]} shape (power uses `watts`)", () => {
    const data = {
      list: [
        { id: win1, secs: [5, 60, 1200, 3600], watts: [637, 310, 191, 169] },
        { id: win2, secs: [5, 60, 1200, 3600], watts: [564, 259, 167, 157] },
      ],
    };
    expect(PowerCurveDataSchema.parse(data)).toEqual(data);
  });

  it("HrCurveDataSchema round-trips the {list:[{id,secs,values}]} shape (HR uses `values`, not `watts`)", () => {
    const data = {
      list: [{ id: win1, secs: [60, 300, 1200, 3600], values: [181, 176, 171, 162] }],
    };
    expect(HrCurveDataSchema.parse(data)).toEqual(data);
  });

  it("curve entries accept nulls in the value array (a duration whose anchor watts/values is null)", () => {
    expect(
      PowerCurveDataSchema.safeParse({ list: [{ id: win1, secs: [5, 60], watts: [637, null] }] })
        .success,
    ).toBe(true);
    expect(
      HrCurveDataSchema.safeParse({ list: [{ id: win1, secs: [60, 300], values: [181, null] }] })
        .success,
    ).toBe(true);
  });

  it("SustainabilityFamilyCurvesSchema round-trips the nested {power:{Ride,VirtualRide}, hr:{...}} shape", () => {
    const family = {
      power: {
        Ride: { list: [{ id: sus, secs: [300, 1200], watts: [218, 191] }] },
        VirtualRide: { list: [{ id: sus, secs: [300, 1200], watts: [218, 191] }] },
      },
      hr: {
        Ride: { list: [{ id: sus, secs: [300, 1200], values: [176, 171] }] },
      },
    };
    expect(SustainabilityFamilyCurvesSchema.parse(family)).toEqual(family);
  });

  it("ActivityStreamsSchema round-trips per-second channels and accepts all-absent (curve fixtures carry none)", () => {
    const full = {
      dfa_a1: [1.0, 0.95, null],
      artifacts: [1.0, 2.0, 0],
      heartrate: [140, 141, 142],
      watts: [200, 210, null],
    };
    expect(ActivityStreamsSchema.parse(full)).toEqual(full);
    expect(ActivityStreamsSchema.parse({})).toEqual({});
  });

  it("AthleteSchema round-trips the sportSettings array the upstream feeds _build_sport_thresholds", () => {
    const athlete = {
      sportSettings: [{ types: ["Ride", "VirtualRide"], ftp: 200, indoor_ftp: 195, lthr: 168 }],
    };
    expect(AthleteSchema.parse(athlete)).toEqual(athlete);
  });

  it("FixtureSchema accepts the 5 new top-level keys when present", () => {
    const fixture = {
      activities: [],
      wellness: [],
      ftp_history: [],
      power_curves: { list: [{ id: win1, secs: [5], watts: [637] }] },
      hr_curves: { list: [{ id: win1, secs: [60], values: [181] }] },
      sustainability_curves: {
        cycling: {
          power: { Ride: { list: [{ id: sus, secs: [300], watts: [218] }] } },
          hr: { Ride: { list: [{ id: sus, secs: [300], values: [176] }] } },
        },
      },
      streams: { "90101": { watts: [200, 210] } },
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 200, lthr: 168 }] },
    };
    expect(FixtureSchema.safeParse(fixture).success).toBe(true);
  });

  it("FixtureSchema still parses a fixture with NONE of the new keys (existing fixtures unaffected)", () => {
    const legacy = { activities: [], wellness: [], ftp_history: [] };
    expect(FixtureSchema.safeParse(legacy).success).toBe(true);
  });

  it("FixtureSchema rejects an unknown top-level key (the .strict() envelope still bites)", () => {
    const rogue = { activities: [], wellness: [], ftp_history: [], power_curvez: {} };
    expect(FixtureSchema.safeParse(rogue).success).toBe(false);
  });
});

describe("Normalized fitness/fatigue fields (anti-corruption layer per ADR-0012)", () => {
  it("WellnessDaySchema declares the 5 normalized fitness/fatigue fields", () => {
    const keys = Object.keys(WellnessDaySchema.shape);
    expect(keys).toContain("fitness");
    expect(keys).toContain("fatigue");
    expect(keys).toContain("fitnessContribution");
    expect(keys).toContain("fatigueContribution");
    expect(keys).toContain("weeklyFitnessChange");
  });

  it("ActivitySchema declares fitnessAtEnd and fatigueAtEnd", () => {
    const keys = Object.keys(ActivitySchema.shape);
    expect(keys).toContain("fitnessAtEnd");
    expect(keys).toContain("fatigueAtEnd");
  });

  it("the schemas declare a rename target for every TP API field", () => {
    const wellnessRenameTargets = [
      "fitness",
      "fatigue",
      "fitnessContribution",
      "fatigueContribution",
      "weeklyFitnessChange",
    ];
    const activityRenameTargets = ["fitnessAtEnd", "fatigueAtEnd"];
    const wellnessKeys = Object.keys(WellnessDaySchema.shape);
    const activityKeys = Object.keys(ActivitySchema.shape);
    for (const target of wellnessRenameTargets) {
      expect(wellnessKeys).toContain(target);
    }
    for (const target of activityRenameTargets) {
      expect(activityKeys).toContain(target);
    }
  });

  it("round-trips an Activity with fitnessAtEnd and fatigueAtEnd", () => {
    const activity = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      fitnessAtEnd: 52.1,
      fatigueAtEnd: 38.4,
    };
    expect(ActivitySchema.parse(activity)).toEqual(activity);
  });

  it("round-trips a WellnessDay with the 5 new normalized fields", () => {
    const day = {
      id: "2026-04-15",
      weight: 73.42,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,
      fitness: 52.1,
      fatigue: 38.4,
      fitnessContribution: 51.9,
      fatigueContribution: 38.1,
      weeklyFitnessChange: 4.7,
    };
    expect(WellnessDaySchema.parse(day)).toEqual(day);
  });

  it("accepts null for the new optional fields", () => {
    const dayWithNulls = {
      id: "2026-04-15",
      weight: null,
      restingHR: null,
      hrv: null,
      sleepSecs: null,
      sleepQuality: null,
      fitness: null,
      fatigue: null,
      fitnessContribution: null,
      fatigueContribution: null,
      weeklyFitnessChange: null,
    };
    expect(WellnessDaySchema.parse(dayWithNulls)).toEqual(dayWithNulls);

    const activityWithNulls = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      fitnessAtEnd: null,
      fatigueAtEnd: null,
    };
    expect(ActivitySchema.parse(activityWithNulls)).toEqual(activityWithNulls);
  });

  it("accepts absent new optional fields", () => {
    const minimalDay = {
      id: "2026-04-15",
      weight: 73,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,
    };
    expect(WellnessDaySchema.parse(minimalDay)).toEqual(minimalDay);

    const minimalActivity = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
    };
    expect(ActivitySchema.parse(minimalActivity)).toEqual(minimalActivity);
  });
});
