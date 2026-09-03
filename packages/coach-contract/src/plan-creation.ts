import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

const PlanCreationUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const PlanCreationCommandIdSchema = z.string().min(1).max(512);
const PlanCreationCivilDateSchema = TrainingExportCivilDateSchema;

export const PlanCreationGoalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event-candidate"), candidateId: PlanCreationUlidSchema }).strict(),
  z
    .object({
      kind: z.literal("event-manual"),
      name: z.string().min(1).max(512),
      date: PlanCreationCivilDateSchema,
    })
    .strict(),
  z.object({ kind: z.literal("fitness"), outcome: z.string().min(1).max(2_000) }).strict(),
]);
export type PlanCreationGoal = z.infer<typeof PlanCreationGoalSchema>;

export const PlanCreationSuccessSchema = z.discriminatedUnion("kind", [
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

export const PlanCreationOpenQuestionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("goal-question"),
      prompt: z.string().min(1).max(240),
      candidates: z.array(GoalEventCandidateSchema).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("success-question"),
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
                  })
                  .strict(),
              )
              .length(3),
          })
          .strict(),
        z.object({ kind: z.literal("authored"), placeholder: z.string().min(1).max(240) }).strict(),
      ]),
    })
    .strict(),
]);
export type PlanCreationOpenQuestion = z.infer<typeof PlanCreationOpenQuestionSchema>;

export const PlanCreationAnswerSummarySchema = z
  .object({
    answerKey: z.enum(["goal", "success"]),
    title: z.string().min(1).max(128),
    detail: z.string().min(1).max(2_000),
  })
  .strict();
export type PlanCreationAnswerSummary = z.infer<typeof PlanCreationAnswerSummarySchema>;

export const PlanCreationCardModelSchema = z
  .object({
    creationId: PlanCreationUlidSchema,
    version: z.number().int().positive(),
    status: z.literal("in-progress"),
    answeredSummaries: z.array(PlanCreationAnswerSummarySchema).max(16),
    openQuestion: PlanCreationOpenQuestionSchema.nullable(),
  })
  .strict();
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

export interface PlanCreationOperations {
  "plan_creation.start"(request: PlanCreationStartRpcParams): Promise<PlanCreationStartRpcResult>;
  "plan_creation.answer"(
    request: PlanCreationAnswerRpcParams,
  ): Promise<PlanCreationAnswerRpcResult>;
}
