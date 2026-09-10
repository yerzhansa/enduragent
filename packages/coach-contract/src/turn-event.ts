import { z } from "zod";
import { CoachDecisionReadModelSchema } from "./coach-decision.js";
import { PlanHandoffSuggestionSchema, PlanReferenceSelectionSchema } from "./plan-chat-card.js";

export const MessageSchema = z
  .object({
    key: z.string().min(1),
    vars: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict();

/** Engine-internal turn failure classification (frozen field vocabulary). */
export const TurnErrorClassSchema = z.enum([
  "budget",
  "overflow",
  "timeout",
  "rate_limit",
  "unknown",
]);
export type TurnErrorClass = z.infer<typeof TurnErrorClassSchema>;

/** Athlete-facing error classification, paired with displayable copy. */
export const AgentErrorKindSchema = z.enum([
  "rate_limit",
  "provider-auth",
  "provider-down",
  "intervals",
  "unknown",
  "detached",
]);
export type AgentErrorKind = z.infer<typeof AgentErrorKindSchema>;

export const TurnStartEventSchema = z
  .object({
    type: z.literal("turn-start"),
    turnId: z.string(),
    chatId: z.string(),
  })
  .strict();

export const ToolStartEventSchema = z
  .object({
    type: z.literal("tool-start"),
    turnId: z.string(),
    toolName: z.string(),
  })
  .strict();

export const ToolEndEventSchema = z
  .object({
    type: z.literal("tool-end"),
    turnId: z.string(),
    toolName: z.string(),
    summary: z.string().optional(),
  })
  .strict();

/**
 * Producers may emit zero or more step-text events per turn; consumers must
 * not assume any particular count.
 */
export const StepTextEventSchema = z
  .object({
    type: z.literal("step-text"),
    turnId: z.string(),
    text: z.string(),
  })
  .strict();

export const FinalTextEventSchema = z
  .object({
    type: z.literal("final-text"),
    turnId: z.string(),
    text: z.string(),
    message: MessageSchema.optional(),
  })
  .strict();

export const InterruptedEventSchema = z
  .object({
    type: z.literal("interrupted"),
    turnId: z.string(),
    chatId: z.string(),
    text: z.string(),
  })
  .strict();

export const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    turnId: z.string(),
    chatId: z.string(),
    error_class: TurnErrorClassSchema,
    kind: AgentErrorKindSchema,
    athleteMessage: z.string(),
    message: MessageSchema.optional(),
    overflowAttempts: z.number(),
    timeoutAttempts: z.number(),
    rateLimitAttempts: z.number(),
    duration_ms: z.number(),
    compactions: z.number(),
  })
  .strict();

/**
 * Reserved for a future streaming producer. Nothing emits this variant today;
 * consumers must tolerate never receiving it.
 */
export const TextDeltaEventSchema = z
  .object({
    type: z.literal("text_delta"),
    turnId: z.string(),
    delta: z.string(),
  })
  .strict();

export const DecisionRequestedEventSchema = z
  .object({
    type: z.literal("decision-requested"),
    turnId: z.string().min(1),
    chatId: z.string().min(1),
    decision: CoachDecisionReadModelSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision.status !== "unanswered") {
      context.addIssue({
        code: "custom",
        path: ["decision", "status"],
        message: "decision request event requires an unanswered decision",
      });
    }
    if (value.decision.chatId !== value.chatId) {
      context.addIssue({
        code: "custom",
        path: ["decision", "chatId"],
        message: "decision chatId must match the event",
      });
    }
  });

export const PlanReferenceSelectedEventSchema = z
  .object({
    type: z.literal("plan-reference"),
    turnId: z.string().min(1),
    selection: PlanReferenceSelectionSchema,
  })
  .strict();

export const PlanHandoffRequestedEventSchema = z
  .object({
    type: z.literal("plan-handoff"),
    turnId: z.string().min(1),
    suggestion: PlanHandoffSuggestionSchema,
  })
  .strict();

/**
 * Terminal shapes: a successful turn ends with `final-text` as its last event.
 * A failed turn with no committed writes ends with `error` and delivers no
 * final text. A turn that fails AFTER a committed write emits `error` and THEN
 * `final-text` carrying the delivered fallback copy — the two co-occur, in
 * that order.
 */
export const TurnEventSchema = z.discriminatedUnion("type", [
  TurnStartEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  StepTextEventSchema,
  FinalTextEventSchema,
  InterruptedEventSchema,
  ErrorEventSchema,
  TextDeltaEventSchema,
  DecisionRequestedEventSchema,
  PlanReferenceSelectedEventSchema,
  PlanHandoffRequestedEventSchema,
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

/**
 * Events are advisory; a consumer callback throwing must never affect the
 * turn.
 */
export type TurnEventHandler = (event: TurnEvent) => void;
