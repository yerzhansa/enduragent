// trademark-lint:skip-file — this fixture-arbitrary helper names the forbidden
// tokens in a comment describing realistic intervals.icu magnitude ranges; the
// tokens are documentation of the value ranges, never new vocabulary. A whole-
// file skip is the only mechanism (findHitsInTsFile honors skip-file only).
// fc.option discipline: every `.optional()` schema field uses
// `fc.option(arbitraryValue, { nil: undefined })`. This produces present-
// key-with-`undefined`-value, NOT absent-key. Metric authors MUST use
// optional-chaining or `=== undefined` checks — see metrics/README.md.
//
// All `fc.float` calls pass `{ noNaN: true }` — schemas reject NaN.

import fc from "fast-check";

import type {
  Activity,
  FtpHistoryPoint,
  IcuIntervalRep,
  PlannedEvent,
  WeeklyRollup,
  WellnessDay,
  ZoneTimes,
} from "../../src/reference/schemas/inputs.js";

// ─── Math-critical run-budget ───────────────────────────────────────────
//
// fast-check default is 100 runs. Math-critical metrics (ACWR, monotony,
// durability, decoupling, polarization-index) opt into 10_000 to surface
// stddev-zero edges that emerge ~1-in-5_000 random weekly histories.
//
// USAGE — both constants MUST be passed together:
//   fc.assert(prop, {
//     numRuns: MATH_CRITICAL_RUNS,
//     timeout: MATH_CRITICAL_TIMEOUT_MS,
//   });
//
// The 30s timeout (vs vitest's 5s default) is defense against fast-check
// shrink: a property that fails on a complex input can spend 100x the
// happy-path budget shrinking. The benchmark test at
// `tests/reference-arbitraries-benchmark.test.ts` locks the perf floor.
export const MATH_CRITICAL_RUNS = 10_000;
export const MATH_CRITICAL_TIMEOUT_MS = 30_000;

/** A nullable+optional field: produces value | null | undefined.
 *  Outer fc.option emits `undefined` ~10%; inner emits `null` ~10% of the rest. */
function nullableOptional<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null | undefined> {
  return fc.option(fc.option(arb, { nil: null }), { nil: undefined });
}

const isoDate = fc
  .date({ min: new Date("2024-01-01"), max: new Date("2027-01-01"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 19)); // "YYYY-MM-DDTHH:MM:SS"

const positiveSeconds = fc.float({ min: 1, max: 14_400, noNaN: true }); // up to 4h

export const arbitraryIcuIntervalRep: fc.Arbitrary<IcuIntervalRep> = fc.record({
  type: fc.constantFrom("WORK", "RECOVERY", "WARMUP", "COOLDOWN", "FREE"),
  duration: fc.float({ min: 30, max: 3600, noNaN: true }),
  average_watts: nullableOptional(fc.float({ min: 50, max: 600, noNaN: true })),
  average_heartrate: nullableOptional(fc.float({ min: 60, max: 200, noNaN: true })),
});

/** Zone-time entry for the pace/HR fields — those can appear as the object
 *  form `{id, secs}` or a bare-number form (pre-flattened payloads), and
 *  ZoneTimeEntrySchema accepts both; this arbitrary exercises both branches
 *  under property tests. NOTE: `icu_zone_times` is object-form ONLY — use
 *  `icuZoneTimeEntry` for it, not this one. */
const zoneTimeEntry: fc.Arbitrary<number | { id: string; secs: number }> = fc.oneof(
  fc.float({ min: 0, max: 3600, noNaN: true }),
  fc.record({
    id: fc.constantFrom("Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7", "SS"),
    secs: fc.float({ min: 0, max: 3600, noNaN: true }),
  }),
);

const sevenZoneTimes = fc.array(zoneTimeEntry, { minLength: 7, maxLength: 7 });

/** `icu_zone_times` entry — object form only, matching IcuZoneTimeEntrySchema.
 *  The upstream reads `zone.get("id")` and raises on a bare number, so the
 *  schema rejects bare numbers for this field; the arbitrary must not produce
 *  shapes the schema rejects. */
const icuZoneTimeEntry: fc.Arbitrary<{ id: string; secs: number }> = fc.record({
  id: fc.constantFrom("Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7", "SS"),
  secs: fc.float({ min: 0, max: 3600, noNaN: true }),
});

const sevenIcuZoneTimes = fc.array(icuZoneTimeEntry, { minLength: 7, maxLength: 7 });

const arbitraryActivityRaw: fc.Arbitrary<Activity> = fc.record({
  // Identity + timing — the API uses both the string form ("i12345678",
  // some endpoints) and the bare-number form (other endpoints); the schema
  // accepts the union. Generate both so metric tests reading `act.id`
  // exercise both branches under property tests.
  id: fc.oneof(
    fc.integer({ min: 1, max: 99_999_999 }),
    fc.integer({ min: 1, max: 99_999_999 }).map((n) => `i${n}`),
  ),
  start_date_local: isoDate,
  type: fc.constantFrom("Ride", "VirtualRide", "Run", "Swim"),
  moving_time: positiveSeconds,
  elapsed_time: positiveSeconds,

  // Load + intensity — schema marks both .optional() (WeightTraining and
  // other unscored sessions ship without them, per
  // `reference-input-schemas.test.ts:75-88`). Wrap in fc.option so property
  // tests exercise the `undefined` branch — a metric reading
  // `act.icu_training_load` without optional-chaining would NPE on a real
  // WeightTraining row, and an always-populated arbitrary would hide it.
  icu_training_load: fc.option(fc.float({ min: 0, max: 500, noNaN: true }), { nil: undefined }),
  icu_intensity: fc.option(fc.float({ min: 0, max: 1.5, noNaN: true }), { nil: undefined }),

  // Power + HR (nullable, NOT optional)
  average_watts: fc.option(fc.float({ min: 50, max: 600, noNaN: true }), { nil: null }),
  average_heartrate: fc.option(fc.float({ min: 60, max: 200, noNaN: true }), { nil: null }),

  // Zone-time breakdowns (optional)
  icu_zone_times: fc.option(sevenIcuZoneTimes, { nil: undefined }),
  pace_zone_times: fc.option(sevenZoneTimes, { nil: undefined }),
  hr_zone_times: fc.option(sevenZoneTimes, { nil: undefined }),

  // Capability proxies (nullable + optional)
  decoupling: nullableOptional(fc.float({ min: -10, max: 30, noNaN: true })),
  pa_hr: nullableOptional(fc.float({ min: -10, max: 30, noNaN: true })),
  icu_efficiency_factor: nullableOptional(fc.float({ min: 0.5, max: 3, noNaN: true })),
  icu_intervals: fc.option(fc.array(arbitraryIcuIntervalRep, { maxLength: 8 }), {
    nil: undefined,
  }),

  // Compliance
  paired_event_id: nullableOptional(fc.integer({ min: 1, max: 99_999 })),
  rpe: nullableOptional(fc.integer({ min: 1, max: 10 })),

  // Energy
  kj: fc.option(fc.float({ min: 0, max: 5000, noNaN: true }), { nil: undefined }),

  // Normalized fitness/fatigue snapshots at activity end — emitted by the
  // anti-corruption layer at `reference/sync/rename-tp-fields.ts` per
  // ADR-0012. Generated here so metric tests reading `activity.fitnessAtEnd`
  // by name exercise the populated branch under property tests, not just
  // the undefined branch the rename layer was added to surface.
  fitnessAtEnd: nullableOptional(fc.float({ min: 20, max: 100, noNaN: true })),
  fatigueAtEnd: nullableOptional(fc.float({ min: 20, max: 100, noNaN: true })),
});

/** Cross-field constraint: decoupling, pa_hr, and icu_efficiency_factor all
 *  require HR data. Efficiency factor is the watts/HR ratio — undefined
 *  without HR. When average_heartrate is null, force all three to null too
 *  — otherwise property tests for capability metrics fail on inputs that
 *  can't physically exist. */
export const arbitraryActivity: fc.Arbitrary<Activity> = arbitraryActivityRaw.map((a) => {
  if (a.average_heartrate === null) {
    return { ...a, decoupling: null, pa_hr: null, icu_efficiency_factor: null };
  }
  return a;
});

const isoDateOnly = fc
  .date({ min: new Date("2024-01-01"), max: new Date("2027-01-01"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10)); // "YYYY-MM-DD"

export const arbitraryWellnessDay: fc.Arbitrary<WellnessDay> = fc.record({
  id: isoDateOnly,
  weight: fc.option(fc.float({ min: 40, max: 130, noNaN: true }), { nil: null }),
  restingHR: fc.option(fc.integer({ min: 35, max: 100 }), { nil: null }),
  hrv: fc.option(fc.integer({ min: 20, max: 200 }), { nil: null }),
  sleepSecs: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
  sleepQuality: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),

  // Body composition (nullable + optional)
  bodyFat: nullableOptional(fc.float({ min: 5, max: 40, noNaN: true })),
  leanMass: nullableOptional(fc.float({ min: 30, max: 100, noNaN: true })),

  // Subjective
  soreness: nullableOptional(fc.integer({ min: 1, max: 10 })),

  // VO2max
  vo2max: nullableOptional(fc.float({ min: 30, max: 80, noNaN: true })),

  // Normalized fitness/fatigue fields — emitted by the anti-corruption layer
  // at `reference/sync/rename-tp-fields.ts` per ADR-0012. Generated here so
  // metric tests reading `wellness.fitness` / `wellness.fatigue` by name
  // exercise the populated branch under property tests. Ranges anchored to
  // realistic intervals.icu CTL/ATL-equivalent magnitudes; weeklyFitnessChange
  // is direction-neutral (positive when building, negative when detraining).
  fitness: nullableOptional(fc.float({ min: 20, max: 100, noNaN: true })),
  fatigue: nullableOptional(fc.float({ min: 20, max: 100, noNaN: true })),
  fitnessContribution: nullableOptional(fc.float({ min: 0, max: 200, noNaN: true })),
  fatigueContribution: nullableOptional(fc.float({ min: 0, max: 200, noNaN: true })),
  weeklyFitnessChange: nullableOptional(fc.float({ min: -10, max: 10, noNaN: true })),
});

const dailyLoadsSeven = fc.array(fc.float({ min: 0, max: 300, noNaN: true }), {
  minLength: 7,
  maxLength: 7,
});

export const arbitraryWeeklyRollup: fc.Arbitrary<WeeklyRollup> = fc.record({
  weekStartDate: isoDateOnly,
  weeklyLoad: fc.float({ min: 0, max: 1500, noNaN: true }),
  dailyLoads: dailyLoadsSeven,
  weeklyRecoveryHours: fc.float({ min: 0, max: 168, noNaN: true }),
});

export const arbitraryFtpHistoryPoint: fc.Arbitrary<FtpHistoryPoint> = fc.record({
  date: isoDateOnly,
  ftp: fc.integer({ min: 50, max: 500 }),
  source: fc.constantFrom("test", "estimate"),
});

export const arbitraryPlannedEvent: fc.Arbitrary<PlannedEvent> = fc.record({
  id: fc.integer({ min: 1, max: 99_999 }),
  category: fc.constantFrom("WORKOUT", "RACE", "NOTE"),
  start_date_local: isoDate,
  name: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
});

export const arbitraryZoneTimes: fc.Arbitrary<ZoneTimes> = fc.record({
  z1: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z2: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z3: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z4: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z5: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z6: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
  z7: fc.option(fc.float({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
});

// ─── Combinators ───────────────────────────────────────────────────────

export interface ArbitraryActivityListOptions {
  minLength?: number;
  maxLength?: number;
}

export function arbitraryActivityList(
  opts?: ArbitraryActivityListOptions,
): fc.Arbitrary<Activity[]> {
  return fc.array(arbitraryActivity, {
    minLength: opts?.minLength ?? 0,
    maxLength: opts?.maxLength ?? 30,
  });
}

/** N consecutive weeks with monotonically-increasing `weekStartDate` (Mondays).
 *  weeks=0 → empty array. */
export function arbitraryWeeklyHistory(weeks: number): fc.Arbitrary<WeeklyRollup[]> {
  if (weeks <= 0) return fc.constant([]);
  return arbitraryWeeklyRollup.chain((seed) => {
    const start = new Date(seed.weekStartDate + "T00:00:00Z");
    return fc.tuple(...Array.from({ length: weeks }, () => arbitraryWeeklyRollup)).map((rollups) =>
      rollups.map((r, i) => {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + i * 7);
        return { ...r, weekStartDate: d.toISOString().slice(0, 10) };
      }),
    );
  });
}

/** Pairs activities with a known event roster so `paired_event_id` values
 *  are drawn from an actual planned-event id set, not random integers in
 *  the same range. Compliance metrics counting "planned events with a paired
 *  activity" need this correlation; without it, the property tests see only
 *  noise from chance ID collisions. Activities can still be unpaired
 *  (`paired_event_id: null`) to model extra/missed sessions — `null` is
 *  sampled ~10% of the time per fc.option defaults.
 *
 *  With an empty `events` roster, behaves as `arbitraryActivityList`. */
export function arbitraryPairedActivityList(
  events: readonly PlannedEvent[],
  opts?: ArbitraryActivityListOptions,
): fc.Arbitrary<Activity[]> {
  if (events.length === 0) return arbitraryActivityList(opts);
  const eventIds = events.map((e) => e.id);
  return arbitraryActivityList(opts).chain((acts) => {
    if (acts.length === 0) return fc.constant(acts);
    return fc
      .tuple(...acts.map(() => fc.option(fc.constantFrom(...eventIds), { nil: null })))
      .map((pairedIds) => acts.map((a, i) => ({ ...a, paired_event_id: pairedIds[i] })));
  });
}

export interface ArbitraryWellnessHistoryOptions {
  days?: number;
  startDate?: string;
}

export function arbitraryWellnessHistory(
  opts?: ArbitraryWellnessHistoryOptions,
): fc.Arbitrary<WellnessDay[]> {
  const days = opts?.days ?? 28;
  if (days <= 0) return fc.constant([]);
  const startBase = opts?.startDate !== undefined ? fc.constant(opts.startDate) : isoDateOnly;

  return startBase.chain((startStr) => {
    const start = new Date(startStr + "T00:00:00Z");
    return fc.tuple(...Array.from({ length: days }, () => arbitraryWellnessDay)).map((rows) =>
      rows.map((row, i) => {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + i);
        return { ...row, id: d.toISOString().slice(0, 10) };
      }),
    );
  });
}
