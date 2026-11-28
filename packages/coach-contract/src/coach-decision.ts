import { z } from "zod";
import { TurnRefusalSchema } from "./spend.js";

const DecisionIdSchema = z.string().min(1);

export const RequestUserDecisionOptionInputSchema = z
  .object({
    label: z.string().min(1).max(60),
    description: z.string().min(1).max(180),
    recommended: z.boolean(),
    consequence: z.string().min(1).max(180),
  })
  .strict();
export type RequestUserDecisionOptionInput = z.infer<typeof RequestUserDecisionOptionInputSchema>;

export const RequestUserDecisionInputSchema = z
  .object({
    question: z.string().min(1).max(240),
    options: z.array(RequestUserDecisionOptionInputSchema).min(2).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.options.filter((option) => option.recommended).length > 1) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "only one decision option may be recommended",
      });
    }
  });
export type RequestUserDecisionInput = z.infer<typeof RequestUserDecisionInputSchema>;

export const CoachDecisionOptionSchema = RequestUserDecisionOptionInputSchema.extend({
  id: DecisionIdSchema,
}).strict();
export type CoachDecisionOption = z.infer<typeof CoachDecisionOptionSchema>;

export const CoachDecisionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("option"), optionId: DecisionIdSchema }).strict(),
  z.object({ kind: z.literal("custom"), text: z.string().min(1).max(2_000) }).strict(),
]);
export type CoachDecisionAnswer = z.infer<typeof CoachDecisionAnswerSchema>;

export const RequestUserDecisionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("presented"), decisionId: DecisionIdSchema }).strict(),
  z
    .object({
      status: z.literal("answered"),
      decisionId: DecisionIdSchema,
      answer: CoachDecisionAnswerSchema,
      consequence: z.string().min(1).max(2_000),
    })
    .strict(),
  z.object({ status: z.literal("skipped"), decisionId: DecisionIdSchema }).strict(),
]);
export type RequestUserDecisionResult = z.infer<typeof RequestUserDecisionResultSchema>;

export const CoachDecisionContinuationLineageSchema = z
  .object({
    templateHash: z.string().min(1),
    assembledHash: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    lineageVersion: z.string().min(1),
    planIntakePatch: z.json().optional(),
  })
  .strict();
export type CoachDecisionContinuationLineage = z.infer<
  typeof CoachDecisionContinuationLineageSchema
>;

export const CoachDecisionContinuationSchema = z.discriminatedUnion("status", [
  z.object({ continuationId: DecisionIdSchema, status: z.literal("pending") }).strict(),
  z
    .object({
      continuationId: DecisionIdSchema,
      status: z.literal("completed"),
      turnId: DecisionIdSchema,
      coachText: z.string().min(1),
      lineage: CoachDecisionContinuationLineageSchema.optional(),
    })
    .strict(),
]);
export type CoachDecisionContinuation = z.infer<typeof CoachDecisionContinuationSchema>;

const CoachDecisionBaseSchema = z
  .object({
    decisionId: DecisionIdSchema,
    chatId: DecisionIdSchema,
    messageId: DecisionIdSchema,
    question: z.string().min(1).max(240),
    options: z.array(CoachDecisionOptionSchema).min(2).max(5),
  })
  .strict();

export const CoachDecisionReadModelSchema = z
  .discriminatedUnion("status", [
    CoachDecisionBaseSchema.extend({ status: z.literal("unanswered") }).strict(),
    CoachDecisionBaseSchema.extend({
      status: z.literal("answered"),
      answer: CoachDecisionAnswerSchema,
      consequence: z.string().min(1).max(2_000),
      continuation: CoachDecisionContinuationSchema,
    }).strict(),
    CoachDecisionBaseSchema.extend({ status: z.literal("skipped") }).strict(),
    CoachDecisionBaseSchema.extend({
      status: z.literal("abandoned"),
      reason: z.literal("new_conversation"),
    }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.options.filter((option) => option.recommended).length > 1) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "only one decision option may be recommended",
      });
    }
    if (value.status === "answered" && value.answer.kind === "option") {
      const optionId = value.answer.optionId;
      if (!value.options.some((option) => option.id === optionId)) {
        context.addIssue({
          code: "custom",
          path: ["answer", "optionId"],
          message: "optionId must reference an option",
        });
      }
    }
  });
export type CoachDecisionReadModel = z.infer<typeof CoachDecisionReadModelSchema>;

export const GetCoachDecisionRpcParamsSchema = z
  .object({ chatId: DecisionIdSchema, decisionId: DecisionIdSchema.optional() })
  .strict();
export type GetCoachDecisionRpcParams = z.infer<typeof GetCoachDecisionRpcParamsSchema>;

export const GetCoachDecisionRpcResultSchema = z
  .object({ decision: CoachDecisionReadModelSchema.nullable() })
  .strict();
export type GetCoachDecisionRpcResult = z.infer<typeof GetCoachDecisionRpcResultSchema>;

export const AnswerCoachDecisionRpcParamsSchema = z
  .object({
    chatId: DecisionIdSchema,
    decisionId: DecisionIdSchema,
    answer: CoachDecisionAnswerSchema,
  })
  .strict();
export type AnswerCoachDecisionRpcParams = z.infer<typeof AnswerCoachDecisionRpcParamsSchema>;

export const AnswerCoachDecisionRpcResultSchema = z
  .object({ decision: CoachDecisionReadModelSchema, refusal: TurnRefusalSchema.optional() })
  .strict()
  .superRefine((value, context) => {
    if (value.refusal === undefined && value.decision.status !== "answered") {
      context.addIssue({
        code: "custom",
        path: ["decision", "status"],
        message: "answered decision required",
      });
    }
  });
export type AnswerCoachDecisionRpcResult = z.infer<typeof AnswerCoachDecisionRpcResultSchema>;

export const SkipCoachDecisionRpcParamsSchema = z
  .object({ chatId: DecisionIdSchema, decisionId: DecisionIdSchema })
  .strict();
export type SkipCoachDecisionRpcParams = z.infer<typeof SkipCoachDecisionRpcParamsSchema>;

export const SkipCoachDecisionRpcResultSchema = z
  .object({ decision: CoachDecisionReadModelSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.decision.status !== "skipped") {
      context.addIssue({
        code: "custom",
        path: ["decision", "status"],
        message: "skipped decision required",
      });
    }
  });
export type SkipCoachDecisionRpcResult = z.infer<typeof SkipCoachDecisionRpcResultSchema>;

export const ResumeCoachDecisionRpcParamsSchema = z
  .object({ chatId: DecisionIdSchema, decisionId: DecisionIdSchema })
  .strict();
export type ResumeCoachDecisionRpcParams = z.infer<typeof ResumeCoachDecisionRpcParamsSchema>;

export const ResumeCoachDecisionRpcResultSchema = z
  .object({
    decision: CoachDecisionReadModelSchema,
    resumed: z.boolean(),
    refusal: TurnRefusalSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision.status !== "answered") {
      context.addIssue({
        code: "custom",
        path: ["decision", "status"],
        message: "answered decision required",
      });
    }
  });
export type ResumeCoachDecisionRpcResult = z.infer<typeof ResumeCoachDecisionRpcResultSchema>;
