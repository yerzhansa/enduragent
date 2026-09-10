// The load-bearing claim: each primitive arbitrary produces values that
// satisfy its corresponding `inputs.ts` schema. Without this, downstream
// metric property tests would run on inputs the schema would reject —
// useless coverage.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ActivitySchema,
  WellnessDaySchema,
  WeeklyRollupSchema,
  FtpHistoryPointSchema,
  PlannedEventSchema,
  IcuIntervalRepSchema,
  ZoneTimesSchema,
} from "../src/reference/schemas/inputs.js";
import {
  arbitraryActivity,
  arbitraryWellnessDay,
  arbitraryWeeklyRollup,
  arbitraryFtpHistoryPoint,
  arbitraryPlannedEvent,
  arbitraryIcuIntervalRep,
  arbitraryZoneTimes,
  arbitraryActivityList,
  arbitraryWeeklyHistory,
  arbitraryWellnessHistory,
  arbitraryPairedActivityList,
} from "./helpers/reference-arbitraries.js";

describe("primitive arbitraries — produce schema-valid values", () => {
  it("arbitraryActivity produces values that pass ActivitySchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        const r = ActivitySchema.safeParse(a);
        if (!r.success) {
          throw new Error(`Generated invalid activity: ${JSON.stringify(a)}\n${r.error.message}`);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryWellnessDay produces values that pass WellnessDaySchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryWellnessDay, (w) => {
        const r = WellnessDaySchema.safeParse(w);
        if (!r.success) {
          throw new Error(
            `Generated invalid wellness day: ${JSON.stringify(w)}\n${r.error.message}`,
          );
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryWeeklyRollup produces values that pass WeeklyRollupSchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryWeeklyRollup, (w) => {
        const r = WeeklyRollupSchema.safeParse(w);
        if (!r.success) {
          throw new Error(
            `Generated invalid weekly rollup: ${JSON.stringify(w)}\n${r.error.message}`,
          );
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryFtpHistoryPoint produces values that pass FtpHistoryPointSchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryFtpHistoryPoint, (p) => {
        const r = FtpHistoryPointSchema.safeParse(p);
        if (!r.success) {
          throw new Error(`Generated invalid FTP point: ${JSON.stringify(p)}\n${r.error.message}`);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryPlannedEvent produces values that pass PlannedEventSchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryPlannedEvent, (e) => {
        const r = PlannedEventSchema.safeParse(e);
        if (!r.success) {
          throw new Error(
            `Generated invalid planned event: ${JSON.stringify(e)}\n${r.error.message}`,
          );
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryIcuIntervalRep produces values that pass IcuIntervalRepSchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryIcuIntervalRep, (rep) => {
        const r = IcuIntervalRepSchema.safeParse(rep);
        if (!r.success) {
          throw new Error(`Generated invalid rep: ${JSON.stringify(rep)}\n${r.error.message}`);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryZoneTimes produces values that pass ZoneTimesSchema (1000 runs)", () => {
    fc.assert(
      fc.property(arbitraryZoneTimes, (z) => {
        const r = ZoneTimesSchema.safeParse(z);
        if (!r.success) {
          throw new Error(`Generated invalid zone times: ${JSON.stringify(z)}\n${r.error.message}`);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("combinators", () => {
  it("arbitraryActivityList honors maxLength: 0 — produces only empty arrays", () => {
    fc.assert(
      fc.property(arbitraryActivityList({ minLength: 0, maxLength: 0 }), (xs) => {
        return xs.length === 0;
      }),
      { numRuns: 100 },
    );
  });

  it("arbitraryActivityList honors maxLength: 5 — produces arrays in [0, 5]", () => {
    fc.assert(
      fc.property(arbitraryActivityList({ maxLength: 5 }), (xs) => {
        return xs.length <= 5;
      }),
      { numRuns: 100 },
    );
  });

  it("arbitraryWeeklyHistory(4) yields exactly 4 entries with monotonically increasing weekStartDate", () => {
    fc.assert(
      fc.property(arbitraryWeeklyHistory(4), (weeks) => {
        if (weeks.length !== 4) return false;
        for (let i = 1; i < weeks.length; i++) {
          if (weeks[i].weekStartDate <= weeks[i - 1].weekStartDate) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("arbitraryWeeklyHistory(0) yields an empty array", () => {
    fc.assert(
      fc.property(arbitraryWeeklyHistory(0), (weeks) => weeks.length === 0),
      { numRuns: 50 },
    );
  });

  it("arbitraryWellnessHistory({ days: 7 }) yields exactly 7 wellness days", () => {
    fc.assert(
      fc.property(arbitraryWellnessHistory({ days: 7 }), (days) => days.length === 7),
      { numRuns: 100 },
    );
  });
});

describe("cross-field constraints", () => {
  it("arbitraryActivity: decoupling is null/undefined when average_heartrate is null (you can't compute decoupling without HR)", () => {
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.average_heartrate === null) {
          return a.decoupling === null || a.decoupling === undefined;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryActivity: pa_hr is null/undefined when average_heartrate is null", () => {
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.average_heartrate === null) {
          return a.pa_hr === null || a.pa_hr === undefined;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("arbitraryActivity: icu_efficiency_factor is null/undefined when average_heartrate is null (watts/HR ratio is undefined without HR)", () => {
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.average_heartrate === null) {
          return a.icu_efficiency_factor === null || a.icu_efficiency_factor === undefined;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

describe("fc.option discipline", () => {
  it("arbitraryActivity sometimes produces icu_intervals: undefined (would fail if always present)", () => {
    let omitted = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.icu_intervals === undefined) omitted++;
        return true;
      }),
      { numRuns: 1000 },
    );
    // fc.option default produces nil ~10% of the time → expect ~100 omitted in 1000 runs.
    // Generous lower bound: 20 catches "always present" without flaking on randomness.
    expect(omitted).toBeGreaterThan(20);
  });

  it("arbitraryActivity sometimes produces icu_training_load: undefined (schema marks it .optional(); WeightTraining ships without it)", () => {
    let omitted = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.icu_training_load === undefined) omitted++;
        return true;
      }),
      { numRuns: 1000 },
    );
    expect(omitted).toBeGreaterThan(20);
  });

  it("arbitraryActivity sometimes produces icu_intensity: undefined", () => {
    let omitted = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (a.icu_intensity === undefined) omitted++;
        return true;
      }),
      { numRuns: 1000 },
    );
    expect(omitted).toBeGreaterThan(20);
  });
});

describe("schema-union coverage (id form, zone-times form, rename-layer fields)", () => {
  it("arbitraryActivity sometimes produces the string-form id ('i<digits>') and sometimes the bare-number form", () => {
    let stringForm = 0;
    let numberForm = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (typeof a.id === "string") stringForm++;
        else numberForm++;
        return true;
      }),
      { numRuns: 400 },
    );
    // fc.oneof defaults to ~50/50; 400 runs → ~200 each. Generous floor of 40
    // catches the "only one branch generated" regression without flaking.
    expect(stringForm).toBeGreaterThan(40);
    expect(numberForm).toBeGreaterThan(40);
  });

  it("arbitraryActivity produces icu_zone_times only in the object form {id, secs} — never a bare number (IcuZoneTimeEntrySchema rejects those)", () => {
    let withZones = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        const zones = a.icu_zone_times;
        if (!Array.isArray(zones) || zones.length === 0) return true;
        withZones++;
        // The upstream reads `zone.get("id")` and raises on a bare number, so
        // the schema (and this arbitrary) must keep icu_zone_times object-form.
        return zones.every((z) => typeof z === "object" && z !== null);
      }),
      { numRuns: 500 },
    );
    // ~90% of generated activities have zone-times set, so 500 runs covers the
    // object-only invariant on a large sample rather than vacuously.
    expect(withZones).toBeGreaterThan(100);
  });

  it("arbitraryActivity sometimes produces a numeric fitnessAtEnd (rename-layer field — metric tests must exercise the populated branch)", () => {
    let numericForm = 0;
    fc.assert(
      fc.property(arbitraryActivity, (a) => {
        if (typeof a.fitnessAtEnd === "number" && Number.isFinite(a.fitnessAtEnd)) {
          numericForm++;
        }
        return true;
      }),
      { numRuns: 500 },
    );
    // nullableOptional emits a real value ~80% of the time (nested fc.option:
    // ~10% undefined outer, ~10% null inner, ~80% value).
    expect(numericForm).toBeGreaterThan(100);
  });

  it("arbitraryWellnessDay sometimes produces numeric fitness/fatigue (rename-layer fields)", () => {
    let withFitness = 0;
    let withFatigue = 0;
    let withRamp = 0;
    fc.assert(
      fc.property(arbitraryWellnessDay, (w) => {
        if (typeof w.fitness === "number") withFitness++;
        if (typeof w.fatigue === "number") withFatigue++;
        if (typeof w.weeklyFitnessChange === "number") withRamp++;
        return true;
      }),
      { numRuns: 500 },
    );
    expect(withFitness).toBeGreaterThan(100);
    expect(withFatigue).toBeGreaterThan(100);
    expect(withRamp).toBeGreaterThan(100);
  });
});

describe("arbitraryPairedActivityList", () => {
  it("draws paired_event_id values from the provided event roster (or null), never random integers", () => {
    const events = [
      { id: 100, category: "WORKOUT", start_date_local: "2026-04-15T07:00:00" },
      { id: 200, category: "WORKOUT", start_date_local: "2026-04-16T07:00:00" },
      { id: 300, category: "RACE", start_date_local: "2026-04-17T07:00:00" },
    ];
    const eventIdSet = new Set(events.map((e) => e.id));
    fc.assert(
      fc.property(arbitraryPairedActivityList(events, { minLength: 5, maxLength: 10 }), (acts) => {
        for (const a of acts) {
          if (a.paired_event_id === null) continue;
          if (!eventIdSet.has(a.paired_event_id as number)) {
            throw new Error(
              `paired_event_id ${a.paired_event_id} not in roster ${[...eventIdSet].join(",")}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("with empty events, behaves like arbitraryActivityList (paired_event_id values left untouched)", () => {
    fc.assert(
      fc.property(arbitraryPairedActivityList([], { minLength: 0, maxLength: 3 }), (acts) => {
        return acts.length <= 3;
      }),
      { numRuns: 50 },
    );
  });

  it("produces at least one paired activity in a typical roster (combinator actually correlates)", () => {
    const events = [
      { id: 100, category: "WORKOUT", start_date_local: "2026-04-15T07:00:00" },
      { id: 200, category: "WORKOUT", start_date_local: "2026-04-16T07:00:00" },
    ];
    let runsWithPaired = 0;
    fc.assert(
      fc.property(arbitraryPairedActivityList(events, { minLength: 5, maxLength: 5 }), (acts) => {
        if (acts.some((a) => typeof a.paired_event_id === "number")) {
          runsWithPaired++;
        }
        return true;
      }),
      { numRuns: 100 },
    );
    // 5 activities × ~90% pairing rate per fc.option default → runs without
    // any paired activity should be vanishingly rare (~0.001%). Floor of 80
    // out of 100 is enormously generous.
    expect(runsWithPaired).toBeGreaterThan(80);
  });
});

describe("shrinking", () => {
  it("induced failure shrinks toward a minimal counterexample (moving_time)", () => {
    // We falsify a trivially-true property to observe shrinking. fast-check
    // should shrink the counterexample's moving_time downward (not all the
    // way to 0 — the float arbitrary's lower bound is 1 — but markedly lower
    // than the typical mid-range generated value).
    //
    // moving_time chosen because it's required (always a number in [1, 14400]).
    // icu_training_load is .optional() now, so shrinking can produce
    // `undefined` and the assertion wouldn't be comparable.
    const out = fc.check(
      fc.property(arbitraryActivity, (a) => a.moving_time < -1),
      { numRuns: 50 },
    );

    expect(out.failed).toBe(true);
    const shrunk = out.counterexample![0];
    expect(shrunk.moving_time).toBeLessThan(50);
  });
});
