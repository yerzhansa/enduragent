import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

const PlanCreationUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const PlanCreationCommandIdSchema = z.string().min(1).max(512);
const PlanCreationCivilDateSchema = TrainingExportCivilDateSchema;

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

const PlanCreationPlanLengthWeeksSchema = z.union([
  z.literal(4),
  z.literal(8),
  z.literal(12),
  z.literal(16),
]);
const PlanCreationWeekdaySchema = z.number().int().min(1).max(7);
const PlanCreationWeeklyHoursLimitSchema = z.number().positive().max(168);
const PlanCreationLongestWorkoutHoursSchema = z.number().positive().max(24);
const completeOptionSet = <T extends string | number>(
  values: readonly T[],
  expected: readonly T[],
): boolean =>
  values.length === expected.length &&
  new Set(values).size === expected.length &&
  expected.every((value) => values.includes(value));
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

export const PlanCreationAnswerInputSchema = z.discriminatedUnion("kind", [
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
      kind: z.literal("commitments"),
      commitments: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z.object({ kind: z.literal("authored"), text: z.string().min(1).max(2_000) }).strict(),
      ]),
    })
    .strict(),
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
]);
export type PlanCreationAnswerInput = z.infer<typeof PlanCreationAnswerInputSchema>;

export const GoalEventCandidateSchema = z
  .object({
    candidateId: PlanCreationUlidSchema,
    name: z.string().min(1).max(512),
    date: PlanCreationCivilDateSchema,
    sourceLabel: z.string().min(1).max(128),
  })
  .strict();
export type GoalEventCandidate = z.infer<typeof GoalEventCandidateSchema>;

const PlanCreationQuestionStepSchema = z
  .object({
    current: z.number().int().min(1).max(9),
    total: z.number().int().min(1).max(9),
  })
  .strict()
  .refine((step) => step.current <= step.total, { path: ["current"] });

const PlanCreationAuthoredOptionSchema = z
  .object({
    label: z.literal("Something else"),
    detail: z.string().min(1).max(240),
    editorLabel: z.string().min(1).max(240),
    placeholder: z.string().min(1).max(240),
  })
  .strict();

export const PlanCreationOpenQuestionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("goal-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      candidates: z.array(GoalEventCandidateSchema).max(10),
      eventNotListedOption: z
        .object({
          label: z.literal("Event not listed"),
          detail: z.string().min(1).max(240),
          editorLabel: z.string().min(1).max(240),
          placeholder: z.string().min(1).max(240),
          nameLabel: z.string().min(1).max(128),
          dateLabel: z.string().min(1).max(128),
        })
        .strict(),
      fitnessOption: z
        .object({
          label: z.string().min(1).max(128),
          detail: z.string().min(1).max(240),
        })
        .strict(),
      authoredOption: PlanCreationAuthoredOptionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("success-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      input: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("event-finish"),
            options: z
              .array(
                z
                  .object({
                    choice: z.enum(["finish-comfortably", "finish-fast", "race-for-result"]),
                    label: z.string().min(1).max(128),
                    detail: z.string().min(1).max(240),
                  })
                  .strict(),
              )
              .length(3),
            authored: PlanCreationAuthoredOptionSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("fitness-choice"),
            options: z
              .array(
                z
                  .object({
                    choice: z.enum(["train-consistently", "climb-stronger", "ride-farther"]),
                    label: z.string().min(1).max(128),
                    detail: z.string().min(1).max(240),
                  })
                  .strict(),
              )
              .length(3)
              .refine((options) =>
                completeOptionSet(
                  options.map((option) => option.choice),
                  ["train-consistently", "climb-stronger", "ride-farther"],
                ),
              ),
            authored: PlanCreationAuthoredOptionSchema.omit({ placeholder: true }).strict(),
            placeholder: z.string().min(1).max(240),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan-length-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              weeks: PlanCreationPlanLengthWeeksSchema,
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(4)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.weeks),
            [4, 8, 12, 16],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-timing-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      earliestAllowed: PlanCreationCivilDateSchema,
      options: z
        .array(
          z
            .object({
              timing: z.enum(["as-soon-as-possible", "earliest"]),
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(2)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.timing),
            ["as-soon-as-possible", "earliest"],
          ),
        ),
      dateLabel: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule-mode-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              mode: z.enum(["fixed", "flexible"]),
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(2)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.mode),
            ["fixed", "flexible"],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("availability-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      mode: z.enum(["fixed", "flexible"]),
      weeklyHoursOptions: z
        .array(
          z
            .object({
              id: z.enum(["hours-6", "hours-8", "hours-10"]),
              weeklyHoursLimit: z.union([z.literal(6), z.literal(8), z.literal(10)]),
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(3)
        .refine(
          (options) =>
            completeOptionSet(
              options.map((option) => option.id),
              ["hours-6", "hours-8", "hours-10"],
            ) &&
            completeOptionSet(
              options.map((option) => option.weeklyHoursLimit),
              [6, 8, 10],
            ),
        ),
      longestWorkoutLabel: z.string().min(1).max(128),
      weekdayOptions: z
        .array(
          z
            .object({
              weekday: PlanCreationWeekdaySchema,
              label: z.string().min(1).max(32),
            })
            .strict(),
        )
        .length(7)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.weekday),
            [1, 2, 3, 4, 5, 6, 7],
          ),
        ),
      derivedPoolNote: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commitments-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      noneOption: z
        .object({
          label: z.string().min(1).max(128),
          detail: z.string().min(1).max(240),
        })
        .strict(),
      authoredOption: PlanCreationAuthoredOptionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseline-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              baseline: z.enum(["regular", "occasional", "starting-again"]),
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(3)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.baseline),
            ["regular", "occasional", "starting-again"],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restriction-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              kind: z.enum(["none", "no-training", "no-hard-training", "max-duration"]),
              label: z.string().min(1).max(128),
              detail: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(4)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.kind),
            ["none", "no-training", "no-hard-training", "max-duration"],
          ),
        ),
    })
    .strict(),
]);
export type PlanCreationOpenQuestion = z.infer<typeof PlanCreationOpenQuestionSchema>;

export const PlanCreationAnswerSummarySchema = z
  .object({
    answerKey: z.enum(PLAN_CREATION_ANSWER_KEYS),
    title: z.string().min(1).max(128),
    detail: z.string().min(1).max(2_000),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("athlete") }).strict(),
      z.object({ kind: z.literal("derived"), label: z.string().min(1).max(128) }).strict(),
    ]),
    question: PlanCreationOpenQuestionSchema,
    answer: PlanCreationAnswerInputSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.answer.kind !== summary.answerKey) {
      context.addIssue({ code: "custom", path: ["answer"], message: "answer key mismatch" });
    }
    if (summary.question.kind.replace(/-question$/u, "") !== summary.answerKey) {
      context.addIssue({ code: "custom", path: ["question"], message: "question key mismatch" });
    }
  });
export type PlanCreationAnswerSummary = z.infer<typeof PlanCreationAnswerSummarySchema>;

const PlanCreationDraftWorkoutSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    kind: z.enum(["hard", "endurance", "long", "easy", "event"]),
    date: PlanCreationCivilDateSchema.nullable(),
    minutes: z.number().positive().max(1440),
    pinned: z.boolean(),
    guidance: z.string().min(1).max(512),
    power: z.null(),
  })
  .strict();

export const PlanCreationDraftSchema = z
  .object({
    kind: z.literal("draft"),
    answeredSummaries: z.array(PlanCreationAnswerSummarySchema).max(16),
    goal: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("fitness"),
          outcome: z.string().min(1).max(2_000).optional(),
          weeks: PlanCreationPlanLengthWeeksSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("event"),
          name: z.string().min(1).max(512),
          date: PlanCreationCivilDateSchema,
        })
        .strict(),
    ]),
    mode: z.enum(["fixed", "flexible"]),
    start: PlanCreationCivilDateSchema,
    end: PlanCreationCivilDateSchema,
    spanKind: z.enum(["Short block", "Event preparation", "Base Plan", "Fitness Plan"]),
    computedWeeks: z.number().int().positive(),
    weeks: z
      .array(
        z
          .object({
            number: z.number().int().min(1).max(24),
            start: PlanCreationCivilDateSchema,
            end: PlanCreationCivilDateSchema,
            workouts: z.array(PlanCreationDraftWorkoutSchema).max(6),
            notes: z.array(z.string().min(1).max(2_000)).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    notes: z.array(z.string().min(1).max(2_000)).max(1_000),
    guidance: z.string().min(1).max(512),
    ftp: z.null(),
    builderId: z.string().min(1).max(128),
    builderVersion: z.string().min(1).max(128),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    outputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type PlanCreationDraft = z.infer<typeof PlanCreationDraftSchema>;

export const PlanCreationCardModelSchema = z
  .object({
    creationId: PlanCreationUlidSchema,
    version: z.number().int().positive(),
    status: z.enum(["in-progress", "review"]),
    draft: PlanCreationDraftSchema.nullable(),
    draftStale: z.boolean(),
    readiness: z.enum(["incomplete", "ready"]),
    answeredSummaries: z.array(PlanCreationAnswerSummarySchema).max(16),
    openQuestion: PlanCreationOpenQuestionSchema.nullable(),
  })
  .strict()
  .superRefine((card, context) => {
    if ((card.status === "review") !== (card.draft !== null)) {
      context.addIssue({ code: "custom", path: ["draft"], message: "review requires a Draft" });
    }
    if (card.draft === null && card.draftStale) {
      context.addIssue({
        code: "custom",
        path: ["draftStale"],
        message: "missing Draft cannot be stale",
      });
    }
    if ((card.readiness === "ready") !== (card.openQuestion === null)) {
      context.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "readiness and open question contradict each other",
      });
    }
  });
export type PlanCreationCardModel = z.infer<typeof PlanCreationCardModelSchema>;

export const PlanCreationStartRpcParamsSchema = z
  .object({ commandId: PlanCreationCommandIdSchema })
  .strict();
export type PlanCreationStartRpcParams = z.infer<typeof PlanCreationStartRpcParamsSchema>;

export const PlanCreationStartRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("started"),
      outcome: z.enum(["created", "resumed"]),
      planCreation: PlanCreationCardModelSchema,
    })
    .strict(),
  z.object({ status: z.literal("rejected"), reason: z.literal("command-conflict") }).strict(),
]);
export type PlanCreationStartRpcResult = z.infer<typeof PlanCreationStartRpcResultSchema>;

export const PlanCreationAnswerRpcParamsSchema = z
  .object({
    commandId: PlanCreationCommandIdSchema,
    creationId: PlanCreationUlidSchema,
    expectedVersion: z.number().int().positive(),
    answer: PlanCreationAnswerInputSchema,
  })
  .strict();
export type PlanCreationAnswerRpcParams = z.infer<typeof PlanCreationAnswerRpcParamsSchema>;

export const PlanCreationAnswerRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), planCreation: PlanCreationCardModelSchema }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "stale-version",
        "command-conflict",
        "no-unfinished-creation",
        "answer-not-expected",
        "invalid-answer",
      ]),
      planCreation: PlanCreationCardModelSchema.nullable(),
    })
    .strict(),
]);
export type PlanCreationAnswerRpcResult = z.infer<typeof PlanCreationAnswerRpcResultSchema>;

export const PlanCreationDiscardRpcParamsSchema = z
  .object({
    commandId: PlanCreationCommandIdSchema,
    creationId: PlanCreationUlidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type PlanCreationDiscardRpcParams = z.infer<typeof PlanCreationDiscardRpcParamsSchema>;

export const PlanCreationDiscardRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("discarded") }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["stale-version", "command-conflict", "no-unfinished-creation"]),
      planCreation: PlanCreationCardModelSchema.nullable(),
    })
    .strict(),
]);
export type PlanCreationDiscardRpcResult = z.infer<typeof PlanCreationDiscardRpcResultSchema>;

export const PlanCreationPreviewRpcParamsSchema = z
  .object({
    commandId: PlanCreationCommandIdSchema,
    creationId: PlanCreationUlidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type PlanCreationPreviewRpcParams = z.infer<typeof PlanCreationPreviewRpcParamsSchema>;

export const PlanCreationPreviewRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("previewed"), planCreation: PlanCreationCardModelSchema }).strict(),
  z.discriminatedUnion("reason", [
    z
      .object({
        status: z.literal("rejected"),
        reason: z.enum([
          "stale-version",
          "command-conflict",
          "no-unfinished-creation",
          "not-ready",
        ]),
        planCreation: PlanCreationCardModelSchema.nullable(),
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        reason: z.literal("no-workouts"),
        explanation: z.string().min(1).max(2_000),
        planCreation: PlanCreationCardModelSchema.nullable(),
      })
      .strict(),
  ]),
]);
export type PlanCreationPreviewRpcResult = z.infer<typeof PlanCreationPreviewRpcResultSchema>;

export const PlanCreationActivateRpcParamsSchema = PlanCreationDiscardRpcParamsSchema.extend({
  incumbent: z
    .object({ planId: PlanCreationUlidSchema, version: z.number().int().positive() })
    .strict()
    .nullable(),
});
export type PlanCreationActivateRpcParams = z.infer<typeof PlanCreationActivateRpcParamsSchema>;

export const PlanCreationActivateRpcResultSchema = z
  .object({
    creationId: PlanCreationUlidSchema,
    planId: PlanCreationUlidSchema,
    closedPlanId: PlanCreationUlidSchema.nullable(),
    activatedAt: PlanCreationCivilDateSchema,
  })
  .strict();
export type PlanCreationActivateRpcResult = z.infer<typeof PlanCreationActivateRpcResultSchema>;

export const PlanCloseRpcParamsSchema = z
  .object({
    commandId: PlanCreationCommandIdSchema,
    planId: PlanCreationUlidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type PlanCloseRpcParams = z.infer<typeof PlanCloseRpcParamsSchema>;

export const PlanCloseResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("closed"),
      planId: PlanCreationUlidSchema,
      closedAt: z.number().int().nonnegative(),
      cleanupJobId: PlanCreationUlidSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["stale-version", "no-active-plan", "command-conflict"]),
    })
    .strict(),
]);
export type PlanCloseResult = z.infer<typeof PlanCloseResultSchema>;

export interface PlanCreationOperations {
  "plan.close"(request: PlanCloseRpcParams): Promise<PlanCloseResult>;
  "plan_creation.activate"(
    request: PlanCreationActivateRpcParams,
  ): Promise<PlanCreationActivateRpcResult>;
  "plan_creation.preview"(
    request: PlanCreationPreviewRpcParams,
  ): Promise<PlanCreationPreviewRpcResult>;
  "plan_creation.start"(request: PlanCreationStartRpcParams): Promise<PlanCreationStartRpcResult>;
  "plan_creation.answer"(
    request: PlanCreationAnswerRpcParams,
  ): Promise<PlanCreationAnswerRpcResult>;
  "plan_creation.discard"(
    request: PlanCreationDiscardRpcParams,
  ): Promise<PlanCreationDiscardRpcResult>;
}
