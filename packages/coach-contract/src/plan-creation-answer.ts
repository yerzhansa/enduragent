import { z } from "zod";
import {
  AnswerCheckActionSchema,
  AnswerCheckTextSchema,
  answerCheckResultSchema,
  pendingAnswerCheckSchema,
} from "./answer-check.js";
import {
  PlanCreationCivilDateSchema,
  PlanCreationPlanLengthWeeksSchema,
  PlanCreationUlidSchema,
  PlanCreationWeekdaySchema,
} from "./plan-creation-values.js";

export const PLAN_CREATION_ANSWER_KEYS = [
  "goal",
  "plan-length",
  "schedule-mode",
  "availability",
  "start-timing",
  "commitments",
  "baseline",
  "success",
  "restriction",
] as const;

const PlanCreationWeeklyHoursLimitSchema = z.number().positive().max(168);
const PlanCreationLongestWorkoutHoursSchema = z.number().positive().max(24);
const PlanCreationUsableWeekdaysSchema = z
  .array(PlanCreationWeekdaySchema)
  .min(1)
  .max(7)
  .refine((weekdays) => new Set(weekdays).size === weekdays.length);
const PlanCreationAvailabilityAnswerSchema = z.discriminatedUnion("mode", [
  z
    .object({
      kind: z.literal("availability"),
      mode: z.literal("fixed"),
      weeklyHoursLimit: PlanCreationWeeklyHoursLimitSchema,
      longestWorkoutHours: PlanCreationLongestWorkoutHoursSchema,
      usableWeekdays: PlanCreationUsableWeekdaysSchema,
    })
    .strict()
    .refine((answer) => answer.longestWorkoutHours <= answer.weeklyHoursLimit, {
      path: ["longestWorkoutHours"],
    }),
  z
    .object({
      kind: z.literal("availability"),
      mode: z.literal("flexible"),
      weeklyHoursLimit: PlanCreationWeeklyHoursLimitSchema,
      longestWorkoutHours: PlanCreationLongestWorkoutHoursSchema,
    })
    .strict()
    .refine((answer) => answer.longestWorkoutHours <= answer.weeklyHoursLimit, {
      path: ["longestWorkoutHours"],
    }),
]);

export const PlanCreationGoalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event-candidate"), candidateId: PlanCreationUlidSchema }).strict(),
  z
    .object({
      kind: z.literal("event-manual"),
      name: z.string().min(1).max(512),
      date: PlanCreationCivilDateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("fitness"),
      outcome: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
]);
export type PlanCreationGoal = z.infer<typeof PlanCreationGoalSchema>;

export const PlanCreationSuccessSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fitness-choice"),
      choice: z.enum(["train-consistently", "climb-stronger", "ride-farther"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event-finish"),
      choice: z.enum(["finish-comfortably", "finish-fast", "race-for-result"]),
    })
    .strict(),
  z.object({ kind: z.literal("authored"), text: z.string().min(1).max(2_000) }).strict(),
]);
export type PlanCreationSuccess = z.infer<typeof PlanCreationSuccessSchema>;

const PlanCreationOrdinaryAnswerSchemas = [
  z.object({ kind: z.literal("goal"), goal: PlanCreationGoalSchema }).strict(),
  z.object({ kind: z.literal("success"), success: PlanCreationSuccessSchema }).strict(),
  z.object({ kind: z.literal("plan-length"), weeks: PlanCreationPlanLengthWeeksSchema }).strict(),
  z
    .object({
      kind: z.literal("start-timing"),
      timing: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("as-soon-as-possible") }).strict(),
        z.object({ kind: z.literal("earliest"), date: PlanCreationCivilDateSchema }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("schedule-mode"), mode: z.enum(["fixed", "flexible"]) }).strict(),
  PlanCreationAvailabilityAnswerSchema,
  z
    .object({
      kind: z.literal("baseline"),
      baseline: z.enum(["regular", "occasional", "starting-again"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restriction"),
      restriction: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z
          .object({
            kind: z.literal("no-training"),
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("no-hard-training"),
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("max-duration"),
            hours: PlanCreationLongestWorkoutHoursSchema,
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
] as const;

export const PlanCreationCommitmentRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("weekday-duration"),
      day: PlanCreationWeekdaySchema,
      minutes: z.number().positive().max(1440),
    })
    .strict(),
  z.object({ kind: z.literal("weekday-unavailable"), day: PlanCreationWeekdaySchema }).strict(),
  z.object({ kind: z.literal("hard-weekday"), day: PlanCreationWeekdaySchema }).strict(),
  z
    .object({
      kind: z.literal("time-off"),
      start: PlanCreationCivilDateSchema,
      end: PlanCreationCivilDateSchema,
    })
    .strict()
    .refine((rule) => rule.end >= rule.start, { path: ["end"] }),
]);
export type PlanCreationCommitmentRule = z.infer<typeof PlanCreationCommitmentRuleSchema>;

export const PlanCreationCheckSubmissionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("commitments"), text: AnswerCheckTextSchema }).strict(),
  z.object({ field: z.literal("success"), text: AnswerCheckTextSchema }).strict(),
  z
    .object({
      field: z.literal("event"),
      text: AnswerCheckTextSchema,
      date: PlanCreationCivilDateSchema,
    })
    .strict(),
]);
export type PlanCreationCheckSubmission = z.infer<typeof PlanCreationCheckSubmissionSchema>;
export const CommitmentCheckResultSchema = answerCheckResultSchema(
  z.array(PlanCreationCommitmentRuleSchema).min(1).max(20),
);
export const SuccessCheckResultSchema = answerCheckResultSchema(AnswerCheckTextSchema);
const EventCheckOutcomesSchema = answerCheckResultSchema(
  z.object({ name: z.string().trim().min(1).max(512), date: PlanCreationCivilDateSchema }).strict(),
);
export const EventCheckResultSchema = z.discriminatedUnion("outcome", [
  EventCheckOutcomesSchema.options[0],
  EventCheckOutcomesSchema.options[1],
]);
export const PlanCreationPendingCheckSchema = z.union([
  pendingAnswerCheckSchema(
    PlanCreationCheckSubmissionSchema.options[0],
    CommitmentCheckResultSchema,
  ),
  pendingAnswerCheckSchema(PlanCreationCheckSubmissionSchema.options[1], SuccessCheckResultSchema),
  pendingAnswerCheckSchema(PlanCreationCheckSubmissionSchema.options[2], EventCheckResultSchema),
]);
export type PlanCreationPendingCheck = z.infer<typeof PlanCreationPendingCheckSchema>;

const PlanCreationCommitmentTextSchema = z.string().min(1).max(2_000);
const PlanCreationCommitmentInputTextSchema = PlanCreationCommitmentTextSchema.trim().min(1);
const PlanCreationNoCommitmentsSchema = z.object({ kind: z.literal("none") }).strict();
export const PlanCreationAnswerInputSchema = z.discriminatedUnion("kind", [
  ...PlanCreationOrdinaryAnswerSchemas,
  z
    .object({ kind: z.literal("check-submit"), submission: PlanCreationCheckSubmissionSchema })
    .strict(),
  AnswerCheckActionSchema,
  z
    .object({
      kind: z.literal("commitments"),
      commitments: z.discriminatedUnion("kind", [
        PlanCreationNoCommitmentsSchema,
        z
          .object({ kind: z.literal("interpreted"), text: PlanCreationCommitmentInputTextSchema })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commitments-interpret"),
      text: PlanCreationCommitmentInputTextSchema,
    })
    .strict(),
  z.object({ kind: z.literal("commitments-confirm") }).strict(),
  z.object({ kind: z.literal("commitments-cancel") }).strict(),
]);
export type PlanCreationAnswerInput = z.infer<typeof PlanCreationAnswerInputSchema>;

export const PlanCreationAnswerSchema = z.discriminatedUnion("kind", [
  ...PlanCreationOrdinaryAnswerSchemas,
  z
    .object({
      kind: z.literal("commitments"),
      commitments: z.union([
        PlanCreationNoCommitmentsSchema,
        z
          .object({
            kind: z.literal("interpreted"),
            text: PlanCreationCommitmentTextSchema,
            rules: z.array(PlanCreationCommitmentRuleSchema),
            status: z.enum(["confirmed", "clarify"]),
          })
          .strict()
          .refine((answer) => answer.status !== "confirmed" || answer.rules.length > 0, {
            path: ["rules"],
          }),
        z
          .object({
            kind: z.literal("authored"),
            text: z.string().min(1).max(2_000),
            acknowledged: z.boolean().optional(),
          })
          .strict()
          .transform((answer) => ({
            kind: "interpreted" as const,
            text: answer.text,
            rules: new Array<PlanCreationCommitmentRule>(),
            status: "clarify" as const,
          })),
      ]),
    })
    .strict(),
]);
export type PlanCreationAnswer = z.infer<typeof PlanCreationAnswerSchema>;

export const PlanCreationPendingCommitmentSchema = z
  .object({
    text: PlanCreationCommitmentTextSchema,
    rules: z.array(PlanCreationCommitmentRuleSchema),
    status: z.enum(["confirm", "clarify"]),
    unparsed: z.array(z.string().min(1).max(2_000)),
  })
  .strict()
  .refine(
    (pending) =>
      pending.status !== "confirm" || (pending.rules.length > 0 && pending.unparsed.length === 0),
    { path: ["status"] },
  );
export type PlanCreationPendingCommitment = z.infer<typeof PlanCreationPendingCommitmentSchema>;
