import { z } from "zod";

const DateKeySchema = z.number().int().min(10101).max(99991231);
const WattsSchema = z.number().int().min(1).max(9_999);

const FtpSourceSchema = z.enum(["first-sync", "intervals", "coach-test", "coach-estimate"]);

export const PlanCalendarFtpLineSchema = z
  .object({ watts: WattsSchema, dateKey: DateKeySchema, source: FtpSourceSchema })
  .strict();
export type PlanCalendarFtpLine = z.infer<typeof PlanCalendarFtpLineSchema>;

export const PlanCalendarRideFtpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("known"),
      watts: WattsSchema,
      use: z.enum(["outdoor", "indoor"]),
      setBy: z.enum(["unknown", "you", "coach"]),
      setOnDateKey: DateKeySchema.nullable(),
      outdoorWatts: WattsSchema.nullable(),
    })
    .strict(),
]);
export type PlanCalendarRideFtp = z.infer<typeof PlanCalendarRideFtpSchema>;

export const PlanCalendarFtpEstimateSchema = z
  .object({ dateKey: DateKeySchema, watts: WattsSchema })
  .strict();
export type PlanCalendarFtpEstimate = z.infer<typeof PlanCalendarFtpEstimateSchema>;

export const PlanCalendarFtpBasisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planned-test"),
      testDateKey: DateKeySchema,
      bestWatts: WattsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drift"),
      direction: z.enum(["above", "below"]),
      sinceDateKey: DateKeySchema.nullable(),
      lowWatts: WattsSchema.nullable(),
      highWatts: WattsSchema.nullable(),
      lowestWatts: WattsSchema.nullable(),
    })
    .strict(),
]);
export type PlanCalendarFtpBasis = z.infer<typeof PlanCalendarFtpBasisSchema>;

const PercentSchema = z.number().int().min(-100).max(1_000);

const ProposalFields = {
  watts: WattsSchema,
  basis: PlanCalendarFtpBasisSchema,
  shownOnDateKey: DateKeySchema,
  percent: PercentSchema.nullable(),
};

export const PlanCalendarFtpProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("shown"), ...ProposalFields }).strict(),
  z
    .object({
      kind: z.literal("confirming"),
      ...ProposalFields,
      icuWatts: WattsSchema.nullable(),
      changedSinceUse: z.boolean(),
      icuChangedAtMs: z.number().int().nonnegative().nullable(),
      workoutsOnIntervals: z.number().int().min(0).max(500),
    })
    .strict(),
]);
export type PlanCalendarFtpProposal = z.infer<typeof PlanCalendarFtpProposalSchema>;

export const PlanCalendarFtpOutcomeSchema = z.enum([
  "none",
  "written",
  "changed",
  "unavailable",
  "refused",
]);
export type PlanCalendarFtpOutcome = z.infer<typeof PlanCalendarFtpOutcomeSchema>;

export const PlanCalendarFtpReadSchema = z
  .object({
    status: z.literal("ftp"),
    todayDateKey: DateKeySchema,
    current: PlanCalendarFtpLineSchema.nullable(),
    history: z.array(PlanCalendarFtpLineSchema).max(500),
    estimates: z.array(PlanCalendarFtpEstimateSchema).max(400),
    chart: z
      .object({
        startDateKey: DateKeySchema,
        endDateKey: DateKeySchema,
        steps: z
          .array(
            z
              .object({
                dateKey: DateKeySchema,
                watts: WattsSchema.nullable(),
                source: FtpSourceSchema,
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    proposal: PlanCalendarFtpProposalSchema,
    outcome: PlanCalendarFtpOutcomeSchema,
  })
  .strict();
export type PlanCalendarFtpRead = z.infer<typeof PlanCalendarFtpReadSchema>;

export const PlanCalendarFtpAnswerSchema = z.enum(["keep", "use", "confirm", "cancel"]);
export type PlanCalendarFtpAnswer = z.infer<typeof PlanCalendarFtpAnswerSchema>;

export const PlanCalendarFtpExpectedSchema = z
  .object({ kind: z.enum(["shown", "confirming"]), watts: WattsSchema })
  .strict();
export type PlanCalendarFtpExpected = z.infer<typeof PlanCalendarFtpExpectedSchema>;

export const PlanCalendarFtpParamsSchemas = [
  z.object({ action: z.literal("ftp") }).strict(),
  z
    .object({
      action: z.literal("ftp-answer"),
      answer: PlanCalendarFtpAnswerSchema,
      expected: PlanCalendarFtpExpectedSchema,
    })
    .strict(),
] as const;
