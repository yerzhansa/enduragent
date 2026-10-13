//
// Why z.looseObject and not .strict(): cache schemas gate against on-disk
// drift via .strict(). Input schemas project upstream-API responses we
// don't control — strict here would mean every new field intervals.icu
// adds anywhere blows up Reference.
//
// Trademark hygiene: TP-named fields (`ctl`, `atl`, `tsb`, `tss`, `if`,
// `icu_atl`, `icu_ctl`, `ctlLoad`, `atlLoad`, `rampRate`) are deliberately
// excluded from the named field set. Real payloads still round-trip via
// the index-signature; the denylist test
// (`tests/reference-input-schemas-no-tp.test.ts`) blocks reintroduction.
// See `docs/knowledge/research/trademark-tp-terms.md`.

import { z } from "zod";

/** Per-rep workout segment from intervals.icu's `icu_intervals` array. */
export const IcuIntervalRepSchema = z.looseObject({
  type: z.string(), // "WORK", "RECOVERY", "WARMUP", etc.
  duration: z.number().nonnegative(), // seconds
  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),
});
export type IcuIntervalRep = z.infer<typeof IcuIntervalRepSchema>;

/** Per-bin zone-time entry. The pace/HR zone-time fields can appear either as
 *  the object form `{id: "Z1", secs: N}` or a bare-number form (pre-flattened
 *  seconds); this union stays permissive for those because their shape isn't
 *  pinned to the oracle. `icu_zone_times` is the exception — it is object-form
 *  ONLY (see `IcuZoneTimeEntrySchema`). */
export const ZoneTimeEntrySchema = z.union([
  z.number().nonnegative(),
  z.looseObject({
    id: z.string().optional(),
    secs: z.number().nonnegative(),
  }),
]);
export type ZoneTimeEntry = z.infer<typeof ZoneTimeEntrySchema>;

/** `icu_zone_times` entry — object form `{id, secs}` only, never a bare number.
 *  The upstream protocol reads this field with `zone.get("id")` /
 *  `zone.get("secs")` and raises `AttributeError` on a bare number (an `int`
 *  has no `.get`). So a bare-number entry is a shape the oracle cannot process
 *  and the parity gate can never capture; accepting it here would only let it
 *  reach the read side, which doesn't recognize it and silently undercounts the
 *  activity's zone time. Reject it at the boundary — object-form is the API's
 *  native bin shape (confirmed against the upstream's `_get_activity_zones`)
 *  and the only portable one. `secs` is optional: the oracle reads it as
 *  `zone.get("secs", 0)` and the reader coerces a missing value to 0, so a
 *  `{ id }`-only bin is processable (contributes 0), not a parse failure. */
export const IcuZoneTimeEntrySchema = z.looseObject({
  id: z.string().optional(),
  secs: z.number().nonnegative().optional(),
});
export type IcuZoneTimeEntry = z.infer<typeof IcuZoneTimeEntrySchema>;

/** Time-in-zone breakdown — Seiler 3-zone bins are derived from these. */
export const ZoneTimesSchema = z.looseObject({
  z1: z.number().nonnegative().optional(),
  z2: z.number().nonnegative().optional(),
  z3: z.number().nonnegative().optional(),
  z4: z.number().nonnegative().optional(),
  z5: z.number().nonnegative().optional(),
  z6: z.number().nonnegative().optional(),
  z7: z.number().nonnegative().optional(),
});
export type ZoneTimes = z.infer<typeof ZoneTimesSchema>;

/** Single intervals.icu activity, projected to fields metric layers consume. */
export const ActivitySchema = z.looseObject({
  // Identity + timing — the API returns activity ids in either string form
  // ("i12345678") or number form (17654321) depending on the endpoint and
  // sport; we mirror that union so real intervals.icu shape rides through.
  id: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
  start_date_local: z.string(), // ISO 8601
  type: z.string(), // "Ride", "VirtualRide", "Run", etc.
  moving_time: z.number().nonnegative(),
  elapsed_time: z.number().nonnegative(),
  source: z.string().nullable().optional().catch(undefined),

  // Load + intensity. Nullish because intervals.icu may omit them or send
  // explicit null on sessions it can't load-score (e.g., WeightTraining,
  // power-less history rides); the lib's own ActivitySchema marks them
  // nullish for the same reason.
  icu_training_load: z.number().nonnegative().nullable().optional(),
  icu_intensity: z.number().nonnegative().nullable().optional(),
  icu_rpe: z.number().nullable().optional(),

  // Power + HR. Optional because real activities can lack a
  // power meter (no Ride power data) or a HR strap (forgotten / dead).
  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),

  // Zone-time breakdowns. `icu_zone_times` is object-form only
  // (IcuZoneTimeEntrySchema) — the shape the upstream reads and the only one
  // the parity gate can capture; the pace/HR fields stay on the permissive
  // union since their shape isn't pinned. Nullable because intervals.icu
  // writes `null` (not just absent) for activities that lack the zone-time
  // series — e.g., a strength session has no pace_zone_times and the API
  // ships the field with a null value.
  icu_zone_times: z.array(IcuZoneTimeEntrySchema).nullable().optional(),
  pace_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),
  hr_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),

  // Capability proxies
  decoupling: z.number().nullable().optional(),
  icu_hr_decoupling: z.number().nullable().optional(),
  icu_variability_index: z.number().nullable().optional(),
  pa_hr: z.number().nullable().optional(),
  icu_efficiency_factor: z.number().nullable().optional(),
  icu_hrr: z
    .union([
      z.number(),
      z
        .object({
          value: z.number().nullable().optional(),
          hrr: z.number().nullable().optional(),
        })
        .loose(),
    ])
    .nullable()
    .optional(),
  icu_intervals: z.array(IcuIntervalRepSchema).optional(),

  // Compliance
  paired_event_id: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),

  // Energy / output
  kj: z.number().nonnegative().optional(),

  // Normalized fitness/fatigue snapshots at activity end — emitted by the
  // anti-corruption layer at `reference/sync/rename-tp-fields.ts` per
  // ADR-0012 from the TP-trademarked source fields the API exposes.
  fitnessAtEnd: z.number().nullable().optional(),
  fatigueAtEnd: z.number().nullable().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const SubjectiveScoreSchema = z.number().int().brand<"SubjectiveScore">();
export type SubjectiveScore = z.infer<typeof SubjectiveScoreSchema>;

/** Single intervals.icu wellness row.
 *  Excludes ctl/atl/ctlLoad/atlLoad/rampRate/icu_atl/icu_ctl from typed surface
 *  per project trademark policy (docs/knowledge/research/trademark-tp-terms.md).
 *  Runtime shape includes them via z.looseObject(); sanitize cosmetic-drops in JSON. */
export const WellnessDaySchema = z.looseObject({
  id: z.string(), // ISO date YYYY-MM-DD
  weight: z.number().nullable().default(null), // kg
  restingHR: z.number().nullable().default(null),
  hrv: z.number().nullable().default(null),
  sleepSecs: z.number().nullable().default(null),
  sleepQuality: z.number().nullable().default(null),

  // Body composition
  bodyFat: z.number().nullable().optional(),
  leanMass: z.number().nullable().optional(),

  // Subjective
  soreness: z.number().nullable().optional(),

  // VO2max
  vo2max: z.number().nullable().optional(),

  fitness: z.number().nullable().optional(),
  fatigue: z.number().nullable().optional(),
  fitnessContribution: z.number().nullable().optional(),
  fatigueContribution: z.number().nullable().optional(),
  weeklyFitnessChange: z.number().nullable().optional(),
  subjectiveFatigue: SubjectiveScoreSchema.nullable().optional(),
});
export type WellnessDay = z.infer<typeof WellnessDaySchema>;

/** Weekly load aggregate — input shape for weekly metrics. */
export const WeeklyRollupSchema = z.looseObject({
  weekStartDate: z.string(), // ISO date YYYY-MM-DD (Monday)
  weeklyLoad: z.number().nonnegative(),
  dailyLoads: z.array(z.number().nonnegative()).length(7),
  weeklyRecoveryHours: z.number().nonnegative(),
});
export type WeeklyRollup = z.infer<typeof WeeklyRollupSchema>;

/** Single FTP history point. */
export const FtpHistoryPointSchema = z.looseObject({
  date: z.string(),
  ftp: z.number().int().positive(),
  source: z.enum(["test", "estimate"]),
});
export type FtpHistoryPoint = z.infer<typeof FtpHistoryPointSchema>;

/** Calendar event — planned workout for compliance/consistency metrics. */
export const PLANNING_EVENT_CATEGORIES = ["WORKOUT", "RACE_A", "RACE_B", "RACE_C"] as const;
export type PlanningEventCategory = (typeof PLANNING_EVENT_CATEGORIES)[number];

const planningEventCategorySet = new Set<string>(PLANNING_EVENT_CATEGORIES);

export function isPlanningEventCategory(value: string): value is PlanningEventCategory {
  return planningEventCategorySet.has(value);
}

export const PlannedEventSchema = z.looseObject({
  id: z.number(),
  category: z.string(), // "WORKOUT", "RACE", etc.
  start_date_local: z.string(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  moving_time: z.number().int().nonnegative().nullable().optional(),
  icu_training_load: z.number().finite().nonnegative().nullable().optional(),
  description: z.string().nullable().optional(),
  workout_doc: z.unknown().nullable().optional(),
});
export type PlannedEvent = z.infer<typeof PlannedEventSchema>;

/** One entry in a power mean-max curve list. The upstream matches by the
 *  `id` string (`r.<start>.<end>`) and indexes `secs`/`watts` positionally:
 *  `watts[secs.index(duration)]`. Arrays may be trimmed to the anchor
 *  durations a fixture exercises — positional lookup is by value, not slot. */
export const PowerCurveEntrySchema = z.looseObject({
  id: z.string(),
  secs: z.array(z.number()),
  watts: z.array(z.number().nullable()),
  activity_ids: z.array(z.string().nullable()).optional(),
  start_indexes: z.array(z.number().int().nonnegative().nullable()).optional(),
});
export type PowerCurveEntry = z.infer<typeof PowerCurveEntrySchema>;

export const PowerCurveActivitySchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  start_date_local: z.string(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  device_watts: z.boolean().nullable().optional(),
  icu_ignore_power: z.boolean().nullable().optional(),
  power_meter: z.string().nullable().optional(),
  device_name: z.string().nullable().optional(),
  missing_timestamps: z.boolean().nullable().optional(),
  missing_power_samples: z.boolean().nullable().optional(),
});
export type PowerCurveActivity = z.infer<typeof PowerCurveActivitySchema>;

/** One entry in an HR mean-max curve list. Same matching as power, but the
 *  value array is keyed `values` (HR bpm), not `watts`. */
export const HrCurveEntrySchema = z.looseObject({
  id: z.string(),
  secs: z.array(z.number()),
  values: z.array(z.number().nullable()),
});
export type HrCurveEntry = z.infer<typeof HrCurveEntrySchema>;

/** A curve API response envelope — the `{list: [...]}` shape the upstream
 *  reads via `data.get("list", [])`. */
export const PowerCurveDataSchema = z.looseObject({
  list: z.array(PowerCurveEntrySchema),
  activities: z.record(z.string(), PowerCurveActivitySchema).optional(),
});
export type PowerCurveData = z.infer<typeof PowerCurveDataSchema>;

export const HrCurveDataSchema = z.looseObject({
  list: z.array(HrCurveEntrySchema),
});
export type HrCurveData = z.infer<typeof HrCurveDataSchema>;

/** Per-sport sustainability curve bundle, mirroring the nested kwarg the
 *  upstream fetch loop builds: `{power: {Ride: {list}, VirtualRide: {list}},
 *  hr: {Ride: {list}, ...}}`. Keyed by activity type, then by `{list}`
 *  envelope, matched on the single 42d-window curve id. */
export const SustainabilityFamilyCurvesSchema = z.looseObject({
  power: z.record(z.string(), PowerCurveDataSchema),
  hr: z.record(z.string(), HrCurveDataSchema),
});
export type SustainabilityFamilyCurves = z.infer<typeof SustainabilityFamilyCurvesSchema>;

/** Per-second activity stream channels, keyed by `String(activity.id)`. The
 *  dfa-profile path joins this record back to the activities array (both
 *  sides coerce id to string). All channels optional — the curve fixture
 *  carries none; the dfa fixture carries all four. */
export const ActivityStreamsSchema = z.looseObject({
  dfa_a1: z.array(z.number().nullable()).optional(),
  artifacts: z.array(z.number().nullable()).optional(),
  heartrate: z.array(z.number().nullable()).optional(),
  watts: z.array(z.number().nullable()).optional(),
});
export type ActivityStreams = z.infer<typeof ActivityStreamsSchema>;

/** One per-sport-family threshold row from the athlete's sportSettings array.
 *  The upstream builds `sport_settings` from these via `_build_sport_thresholds`:
 *  `types` maps to a sport family, `ftp`/`indoor_ftp`/`lthr` feed the
 *  sustainability and zone-basis logic. */
export const SportSettingsRowSchema = z.looseObject({
  types: z.array(z.string()),
  ftp: z.number().nullable().optional(),
  indoor_ftp: z.number().nullable().optional(),
  lthr: z.number().nullable().optional(),
  // Pace-anchored thresholds. `threshold_pace` (the platform-supplied critical-
  // speed anchor for running zones) is stored in SI m/s; `pace_units` is the
  // athlete's display preference only. These already rode through the
  // `z.looseObject` surface (buildSportThresholds casts them inline); typing
  // them here makes that surface explicit. `critical_speed` is the manual
  // override the CS-source gate reads (also m/s). `cs_source`/`cs_confidence`
  // are forward-declared provenance/reliability labels for the anchor's read
  // path; the gate validates only the numeric anchor and does not read them yet.
  threshold_pace: z.number().nullable().optional(),
  pace_units: z.string().nullable().optional(),
  critical_speed: z.number().nullable().optional(),
  cs_source: z.enum(["platform", "athlete_manual", "computed"]).nullable().optional(),
  cs_confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
});
export type SportSettingsRow = z.infer<typeof SportSettingsRowSchema>;

/** Athlete-level settings carrier. `sportSettings` is the array the upstream
 *  hands to `_build_sport_thresholds(athlete)`. */
export const AthleteSchema = z.looseObject({
  sportSettings: z.array(SportSettingsRowSchema),
});
export type AthleteSettings = z.infer<typeof AthleteSchema>;

/**
 * Top-level envelope for a golden fixture. The shape every parity-gate
 * metric receives. Strict at the envelope level (rogue top-level keys
 * fail the parse — typos can't masquerade as silently-present optional
 * fields); per-row schemas remain `z.looseObject()` so real upstream
 * shape rides through (see the file header on the trademark-hygiene
 * justification for that decision).
 *
 * Adding a new field is an explicit schema change: a new fixture key
 * that isn't here fails parse at the gate boundary, forcing the
 * accessor + schema to land in lockstep. That friction is the point —
 * it's what stops a sixth-or-seventh ad-hoc `as { ... }` cast from
 * accreting in metric files when an author judges the schema-update
 * tax to be higher than an inline cast (the pattern that proliferated
 * before this seam landed).
 *
 * Used by:
 *   - `tools/check-metric-parity.ts` — parses every fixture at the
 *     gate boundary; metric implementations see a typed shape, never
 *     `unknown`.
 *   - `packages/core/tests/helpers/load-fixture.ts` — the test loader
 *     re-uses this schema as its validation surface (no duplicate
 *     definition).
 */
export const FixtureSchema = z
  .object({
    activities: z.array(ActivitySchema),
    wellness: z.array(WellnessDaySchema),
    ftp_history: z.array(FtpHistoryPointSchema),

    // Optional fixture extensions for the compliance + benchmark batch.
    // None of the current committed fixtures populate these; the schema
    // declares them so future populated-branch fixtures can land
    // without a rogue-key parse failure.
    past_events: z.array(PlannedEventSchema).optional(),
    current_ftp_indoor: z.number().nullable().optional(),
    current_ftp_outdoor: z.number().nullable().optional(),
    ftp_history_indoor: z.record(z.string(), z.number()).optional(),
    ftp_history_outdoor: z.record(z.string(), z.number()).optional(),

    // Top-level eFTP fallback consumed by `_build_weight_signal`'s FTP
    // source resolution when tested outdoor FTP is null. Distinct from
    // `sportInfo[].eftp` (inner field, used by tools/fetch-real-athlete.ts
    // to derive ftp_history). Optional — current golden fixtures don't
    // populate this branch; the eFTP path is exercised by unit tests.
    eftp: z.number().nullable().optional(),

    // Per-activity intervals lookup, mirroring upstream's intervals.json
    // surface (a distinct API endpoint from activities). Keyed by activity
    // id as a string. Optional so existing fixtures without the key still
    // validate. Only the `intervals[].type` field is consumed by the
    // current Reference port (`has_intervals` WORK-segment classifier);
    // other fields ride through via the loose row schemas. See ADR-0017.
    intervals: z
      .record(
        z.string(),
        z.looseObject({
          intervals: z.array(z.looseObject({ type: z.string() })).optional(),
        }),
      )
      .optional(),

    // Curve + stream inputs for the capability/stream metrics (power_curve_delta,
    // hr_curve_delta, sustainability_profile, dfa_a1_profile). Each is the
    // EXACT object the harness passes to the upstream's _calculate_derived_metrics
    // kwarg of the same role — not a projection. Optional so the 11 existing
    // fixtures (which carry none) still parse; only the curve/stream fixtures
    // populate them. The harness derives the window dates/tuples ONLY when the
    // matching key is present, so absent keys reproduce the prior null-block
    // snapshots byte-for-byte.
    power_curves: PowerCurveDataSchema.optional(),
    hr_curves: HrCurveDataSchema.optional(),
    sustainability_curves: z.record(z.string(), SustainabilityFamilyCurvesSchema).optional(),
    streams: z.record(z.string(), ActivityStreamsSchema).optional(),
    athlete: AthleteSchema.optional(),
  })
  .strict();
export type FixtureShape = z.infer<typeof FixtureSchema>;
