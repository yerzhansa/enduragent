import { z } from "zod";

export const IcuIntervalRepSchema = z.looseObject({
  type: z.string(),
  duration: z.number().nonnegative(),
  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),
});
export type IcuIntervalRep = z.infer<typeof IcuIntervalRepSchema>;

export const ZoneTimeEntrySchema = z.union([
  z.number().nonnegative(),
  z.looseObject({
    id: z.string().optional(),
    secs: z.number().nonnegative(),
  }),
]);
export type ZoneTimeEntry = z.infer<typeof ZoneTimeEntrySchema>;

export const IcuZoneTimeEntrySchema = z.looseObject({
  id: z.string().optional(),
  secs: z.number().nonnegative().optional(),
});
export type IcuZoneTimeEntry = z.infer<typeof IcuZoneTimeEntrySchema>;

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

export const ActivitySchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
  start_date_local: z.string(),
  type: z.string(),
  moving_time: z.number().nonnegative(),
  elapsed_time: z.number().nonnegative(),
  source: z.string().nullable().optional().catch(undefined),

  icu_training_load: z.number().nonnegative().nullable().optional(),
  icu_intensity: z.number().nonnegative().nullable().optional(),
  icu_rpe: z.number().nullable().optional(),

  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),

  icu_zone_times: z.array(IcuZoneTimeEntrySchema).nullable().optional(),
  pace_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),
  hr_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),

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

  paired_event_id: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),

  kj: z.number().nonnegative().optional(),

  fitnessAtEnd: z.number().nullable().optional(),
  fatigueAtEnd: z.number().nullable().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const SubjectiveScoreSchema = z.number().int().brand<"SubjectiveScore">();
export type SubjectiveScore = z.infer<typeof SubjectiveScoreSchema>;

export const WellnessDaySchema = z.looseObject({
  id: z.string(),
  weight: z.number().nullable().default(null),
  restingHR: z.number().nullable().default(null),
  hrv: z.number().nullable().default(null),
  sleepSecs: z.number().nullable().default(null),
  sleepQuality: z.number().nullable().default(null),

  bodyFat: z.number().nullable().optional(),
  leanMass: z.number().nullable().optional(),

  soreness: z.number().nullable().optional(),

  vo2max: z.number().nullable().optional(),

  fitness: z.number().nullable().optional(),
  fatigue: z.number().nullable().optional(),
  fitnessContribution: z.number().nullable().optional(),
  fatigueContribution: z.number().nullable().optional(),
  weeklyFitnessChange: z.number().nullable().optional(),
  subjectiveFatigue: SubjectiveScoreSchema.nullable().optional(),
});
export type WellnessDay = z.infer<typeof WellnessDaySchema>;

const isStorable = (value: number): boolean => value >= 0 && !Object.is(value, -0);
const StoredNumberSchema = z.number().refine(isStorable);
const StoredIntegerSchema = z.number().int().refine(isStorable);

export const WellnessColumnsSchema = z.object({
  restingHR: StoredIntegerSchema.nullish(),
  hrv: StoredNumberSchema.nullish(),
  hrvSDNN: StoredNumberSchema.nullish(),
  sleepSecs: StoredIntegerSchema.nullish(),
  sleepQuality: StoredIntegerSchema.nullish(),
  weight: StoredNumberSchema.nullish(),
  soreness: StoredIntegerSchema.nullish(),
  subjectiveFatigue: SubjectiveScoreSchema.refine(isStorable).nullish(),
});

export const WeeklyRollupSchema = z.looseObject({
  weekStartDate: z.string(),
  weeklyLoad: z.number().nonnegative(),
  dailyLoads: z.array(z.number().nonnegative()).length(7),
  weeklyRecoveryHours: z.number().nonnegative(),
});
export type WeeklyRollup = z.infer<typeof WeeklyRollupSchema>;

export const FtpHistoryPointSchema = z.looseObject({
  date: z.string(),
  ftp: z.number().int().positive(),
  source: z.enum(["test", "estimate"]),
});
export type FtpHistoryPoint = z.infer<typeof FtpHistoryPointSchema>;

export const PLANNING_EVENT_CATEGORIES = ["WORKOUT", "RACE_A", "RACE_B", "RACE_C"] as const;
export type PlanningEventCategory = (typeof PLANNING_EVENT_CATEGORIES)[number];

const planningEventCategorySet = new Set<string>(PLANNING_EVENT_CATEGORIES);

export function isPlanningEventCategory(value: string): value is PlanningEventCategory {
  return planningEventCategorySet.has(value);
}

export const PlannedEventSchema = z.looseObject({
  id: z.number(),
  category: z.string(),
  start_date_local: z.string(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  moving_time: z.number().int().nonnegative().nullable().optional(),
  icu_training_load: z.number().finite().nonnegative().nullable().optional(),
  description: z.string().nullable().optional(),
  workout_doc: z.unknown().nullable().optional(),
});
export type PlannedEvent = z.infer<typeof PlannedEventSchema>;

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

export const HrCurveEntrySchema = z.looseObject({
  id: z.string(),
  secs: z.array(z.number()),
  values: z.array(z.number().nullable()),
});
export type HrCurveEntry = z.infer<typeof HrCurveEntrySchema>;

export const PowerCurveDataSchema = z.looseObject({
  list: z.array(PowerCurveEntrySchema),
  activities: z.record(z.string(), PowerCurveActivitySchema).optional(),
});
export type PowerCurveData = z.infer<typeof PowerCurveDataSchema>;

export const HrCurveDataSchema = z.looseObject({
  list: z.array(HrCurveEntrySchema),
});
export type HrCurveData = z.infer<typeof HrCurveDataSchema>;

export const SustainabilityFamilyCurvesSchema = z.looseObject({
  power: z.record(z.string(), PowerCurveDataSchema),
  hr: z.record(z.string(), HrCurveDataSchema),
});
export type SustainabilityFamilyCurves = z.infer<typeof SustainabilityFamilyCurvesSchema>;

export const ActivityStreamsSchema = z.looseObject({
  dfa_a1: z.array(z.number().nullable()).optional(),
  artifacts: z.array(z.number().nullable()).optional(),
  heartrate: z.array(z.number().nullable()).optional(),
  watts: z.array(z.number().nullable()).optional(),
});
export type ActivityStreams = z.infer<typeof ActivityStreamsSchema>;

export const SportSettingsRowSchema = z.looseObject({
  types: z.array(z.string()),
  ftp: z.number().nullable().optional(),
  indoor_ftp: z.number().nullable().optional(),
  lthr: z.number().nullable().optional(),
  threshold_pace: z.number().nullable().optional(),
  pace_units: z.string().nullable().optional(),
  critical_speed: z.number().nullable().optional(),
  cs_source: z.enum(["platform", "athlete_manual", "computed"]).nullable().optional(),
  cs_confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
});
export type SportSettingsRow = z.infer<typeof SportSettingsRowSchema>;

export const AthleteSchema = z.looseObject({
  sportSettings: z.array(SportSettingsRowSchema),
});
export type AthleteSettings = z.infer<typeof AthleteSchema>;

export const FixtureSchema = z
  .object({
    activities: z.array(ActivitySchema),
    wellness: z.array(WellnessDaySchema),
    ftp_history: z.array(FtpHistoryPointSchema),

    past_events: z.array(PlannedEventSchema).optional(),
    current_ftp_indoor: z.number().nullable().optional(),
    current_ftp_outdoor: z.number().nullable().optional(),
    ftp_history_indoor: z.record(z.string(), z.number()).optional(),
    ftp_history_outdoor: z.record(z.string(), z.number()).optional(),

    eftp: z.number().nullable().optional(),

    intervals: z
      .record(
        z.string(),
        z.looseObject({
          intervals: z.array(z.looseObject({ type: z.string() })).optional(),
        }),
      )
      .optional(),

    power_curves: PowerCurveDataSchema.optional(),
    hr_curves: HrCurveDataSchema.optional(),
    sustainability_curves: z.record(z.string(), SustainabilityFamilyCurvesSchema).optional(),
    streams: z.record(z.string(), ActivityStreamsSchema).optional(),
    athlete: AthleteSchema.optional(),
  })
  .strict();
export type FixtureShape = z.infer<typeof FixtureSchema>;
