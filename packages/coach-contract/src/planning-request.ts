import { z } from "zod";
import { PlanCreationCardModelSchema } from "./plan-creation.js";

const PlanningRequestIdSchema = z.string().min(1).max(512);
const PlanningRequestInstantSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PlanningRequestTimestampSchema = z.iso.datetime({ offset: true }).max(128);
const PlanningRequestCivilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const PlanningRequestKindSchema = z.enum([
  "workout_review",
  "plan_question",
  "plan_change",
  "plan_creation",
]);
export type PlanningRequestKind = z.infer<typeof PlanningRequestKindSchema>;

export const PlanningRequestTargetSchema = z.enum(["active_plan", "draft", "plan_creation"]);
export type PlanningRequestTarget = z.infer<typeof PlanningRequestTargetSchema>;

export const CreatePlanningRequestPayloadSchema = z
  .object({
    requestId: PlanningRequestIdSchema,
    kind: PlanningRequestKindSchema,
    intent: z.string().min(1).max(20_000),
    source: z
      .object({
        chatId: PlanningRequestIdSchema,
        messageId: PlanningRequestIdSchema,
        attachmentId: PlanningRequestIdSchema.optional(),
      })
      .strict(),
    sourceSnapshot: z
      .object({
        capturedAt: PlanningRequestTimestampSchema,
        attachment: z
          .object({
            attachmentId: PlanningRequestIdSchema,
            displayName: z.string().min(1).max(512),
            extension: z.enum(["zwo", "mrc", "erg"]),
          })
          .strict()
          .nullable(),
        selectedWorkout: z
          .object({
            setId: PlanningRequestIdSchema,
            workoutId: PlanningRequestIdSchema,
            workout: z.record(z.string(), z.json()),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    requestedDate: PlanningRequestCivilDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "workout_review" &&
      (value.source.attachmentId === undefined || value.sourceSnapshot.selectedWorkout === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "workout review requires an attachment and selected Workout",
      });
    }
    if (value.sourceSnapshot.selectedWorkout !== null && value.sourceSnapshot.attachment === null) {
      context.addIssue({
        code: "custom",
        path: ["sourceSnapshot", "attachment"],
        message: "selected Workout requires attachment provenance",
      });
    }
    if (value.source.attachmentId !== value.sourceSnapshot.attachment?.attachmentId) {
      context.addIssue({
        code: "custom",
        path: ["source", "attachmentId"],
        message: "source attachment must match its snapshot",
      });
    }
  });
export type CreatePlanningRequestPayload = z.infer<typeof CreatePlanningRequestPayloadSchema>;

const PlanningRequestTerminalResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("applied"),
      resultId: PlanningRequestIdSchema,
      completedAtMs: PlanningRequestInstantSchema,
      title: z.string().min(1).max(512),
      detail: z.string().min(1).max(2_000),
      workoutRef: z
        .object({ setId: PlanningRequestIdSchema, workoutId: PlanningRequestIdSchema })
        .strict()
        .nullable(),
      planRevisionId: PlanningRequestIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["rejected", "ended"]),
      resultId: PlanningRequestIdSchema,
      completedAtMs: PlanningRequestInstantSchema,
      title: z.string().min(1).max(512),
      detail: z.string().min(1).max(2_000),
      workoutRef: z
        .object({ setId: PlanningRequestIdSchema, workoutId: PlanningRequestIdSchema })
        .strict()
        .nullable(),
      planRevisionId: PlanningRequestIdSchema.nullable(),
    })
    .strict(),
]);

export const PlanningRequestReadModelSchema = z
  .object({
    requestId: PlanningRequestIdSchema,
    kind: PlanningRequestKindSchema,
    target: PlanningRequestTargetSchema,
    intent: z.string().min(1).max(20_000),
    planConversationId: PlanningRequestIdSchema.nullable(),
    proposalId: PlanningRequestIdSchema.nullable(),
    requestedDateKey: z.number().int().positive().nullable(),
    resolvedDateKey: z.number().int().positive().nullable(),
    source: z
      .object({
        chatId: PlanningRequestIdSchema,
        messageId: PlanningRequestIdSchema,
        available: z.boolean(),
      })
      .strict(),
    lifecycle: z.enum(["open", "applied", "rejected", "ended"]),
    attention: z.enum([
      "none",
      "needs_review",
      "date_conflict",
      "revalidating",
      "stale_base",
      "apply_failed",
    ]),
    revision: z.number().int().positive(),
    createdAtMs: PlanningRequestInstantSchema,
    updatedAtMs: PlanningRequestInstantSchema,
    terminalResult: PlanningRequestTerminalResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.lifecycle === "open") !== (value.terminalResult === null)) {
      context.addIssue({
        code: "custom",
        path: ["terminalResult"],
        message: "terminal result must match request lifecycle",
      });
    }
    if (value.lifecycle !== "open" && value.terminalResult?.kind !== value.lifecycle) {
      context.addIssue({
        code: "custom",
        path: ["terminalResult", "kind"],
        message: "terminal result kind must match request lifecycle",
      });
    }
    if (value.attention !== "none" && (value.lifecycle !== "open" || value.proposalId === null)) {
      context.addIssue({
        code: "custom",
        path: ["attention"],
        message: "request attention requires an open Proposal",
      });
    }
  });
export type PlanningRequestReadModel = z.infer<typeof PlanningRequestReadModelSchema>;

export const PlanningRequestDeliverySchema = z
  .object({
    requestId: PlanningRequestIdSchema,
    source: z
      .object({
        kind: PlanningRequestKindSchema,
        intent: z.string().min(1).max(20_000),
        chatId: PlanningRequestIdSchema,
        messageId: PlanningRequestIdSchema,
        attachmentId: PlanningRequestIdSchema.nullable(),
      })
      .strict()
      .nullable(),
    state: z.enum(["pending", "failed", "delivered", "cancelled"]),
    attemptCount: z.number().int().nonnegative(),
    failureCode: z.string().min(1).max(128).nullable(),
    retryable: z.boolean(),
    createdAtMs: PlanningRequestInstantSchema,
    updatedAtMs: PlanningRequestInstantSchema,
    deliveredAtMs: PlanningRequestInstantSchema.nullable(),
    planningRequest: PlanningRequestReadModelSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "failed") !== (value.failureCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failure code must match failed delivery state",
      });
    }
    if (
      (value.state === "pending" && !value.retryable) ||
      ((value.state === "delivered" || value.state === "cancelled") && value.retryable)
    ) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "retryability must match delivery state",
      });
    }
    if ((value.state === "delivered") !== (value.deliveredAtMs !== null)) {
      context.addIssue({
        code: "custom",
        path: ["deliveredAtMs"],
        message: "delivery timestamp must match delivered state",
      });
    }
    if (value.state === "delivered" && value.planningRequest === null) {
      context.addIssue({
        code: "custom",
        path: ["planningRequest"],
        message: "delivered state requires its Planning request",
      });
    }
  });
export type PlanningRequestDelivery = z.infer<typeof PlanningRequestDeliverySchema>;

export const CreatePlanningRequestRpcParamsSchema = z
  .object({ payload: CreatePlanningRequestPayloadSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.payload.kind === "workout_review" ||
      value.payload.source.attachmentId !== undefined ||
      value.payload.sourceSnapshot.attachment !== null ||
      value.payload.sourceSnapshot.selectedWorkout !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Workout handoffs require trusted daemon source resolution",
      });
    }
  });
export type CreatePlanningRequestRpcParams = z.infer<typeof CreatePlanningRequestRpcParamsSchema>;

export const CreatePlanningRequestRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), delivery: PlanningRequestDeliverySchema }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["invalid_request", "request_conflict"]),
    })
    .strict(),
]);
export type CreatePlanningRequestRpcResult = z.infer<typeof CreatePlanningRequestRpcResultSchema>;

export const CreateWorkoutPlanningRequestRpcParamsSchema = z
  .object({
    requestId: PlanningRequestIdSchema,
    intent: z.string().min(1).max(20_000),
    source: z
      .object({
        chatId: PlanningRequestIdSchema,
        messageId: PlanningRequestIdSchema,
        attachmentId: PlanningRequestIdSchema,
      })
      .strict(),
    requestedDate: PlanningRequestCivilDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.requestId === value.source.messageId ||
      value.requestId === value.source.attachmentId ||
      value.source.messageId === value.source.attachmentId
    ) {
      context.addIssue({ code: "custom", message: "Planning request identities must be distinct" });
    }
  });
export type CreateWorkoutPlanningRequestRpcParams = z.infer<
  typeof CreateWorkoutPlanningRequestRpcParamsSchema
>;
export const CreateWorkoutPlanningRequestRpcResultSchema = CreatePlanningRequestRpcResultSchema;
export type CreateWorkoutPlanningRequestRpcResult = CreatePlanningRequestRpcResult;

export const GetPlanningRequestRpcParamsSchema = z
  .object({ requestId: PlanningRequestIdSchema })
  .strict();
export type GetPlanningRequestRpcParams = z.infer<typeof GetPlanningRequestRpcParamsSchema>;

export const GetPlanningRequestRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), delivery: PlanningRequestDeliverySchema }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
]);
export type GetPlanningRequestRpcResult = z.infer<typeof GetPlanningRequestRpcResultSchema>;

export const RetryPlanningRequestRpcParamsSchema = GetPlanningRequestRpcParamsSchema;
export type RetryPlanningRequestRpcParams = GetPlanningRequestRpcParams;
export const RetryPlanningRequestRpcResultSchema = GetPlanningRequestRpcResultSchema;
export type RetryPlanningRequestRpcResult = GetPlanningRequestRpcResult;

export const ResumePlanningRequestsRpcParamsSchema = z.object({}).strict();
export type ResumePlanningRequestsRpcParams = z.infer<typeof ResumePlanningRequestsRpcParamsSchema>;
export const ResumePlanningRequestsRpcResultSchema = z
  .object({ deliveries: z.array(PlanningRequestDeliverySchema) })
  .strict();
export type ResumePlanningRequestsRpcResult = z.infer<typeof ResumePlanningRequestsRpcResultSchema>;

export const ListPlanningRequestsRpcParamsSchema = z
  .object({ chatId: PlanningRequestIdSchema })
  .strict();
export type ListPlanningRequestsRpcParams = z.infer<typeof ListPlanningRequestsRpcParamsSchema>;
export const ListPlanningRequestsRpcResultSchema = z
  .object({
    deliveries: z.array(PlanningRequestDeliverySchema),
    planCreation: PlanCreationCardModelSchema.nullable(),
  })
  .strict();
export type ListPlanningRequestsRpcResult = z.infer<typeof ListPlanningRequestsRpcResultSchema>;

export interface PlanningRequestOperations {
  createPlanningRequest?(
    request: CreatePlanningRequestRpcParams,
  ): Promise<CreatePlanningRequestRpcResult>;
  createWorkoutPlanningRequest?(
    request: CreateWorkoutPlanningRequestRpcParams,
  ): Promise<CreateWorkoutPlanningRequestRpcResult>;
  getPlanningRequest?(request: GetPlanningRequestRpcParams): Promise<GetPlanningRequestRpcResult>;
  retryPlanningRequest?(
    request: RetryPlanningRequestRpcParams,
  ): Promise<RetryPlanningRequestRpcResult>;
  resumePlanningRequests?(
    request: ResumePlanningRequestsRpcParams,
  ): Promise<ResumePlanningRequestsRpcResult>;
  listPlanningRequests?(
    request: ListPlanningRequestsRpcParams,
  ): Promise<ListPlanningRequestsRpcResult>;
}
