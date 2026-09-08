import { z } from "zod";
import { LanguageTagSchema, LanguageSourceSchema } from "./language.js";
import type { TurnEvent } from "./turn-event.js";
import type { AthleteState } from "./athlete-state.js";
import {
  CoachDecisionReadModelSchema,
  type AnswerCoachDecisionRpcParams,
  type AnswerCoachDecisionRpcResult,
  type GetCoachDecisionRpcParams,
  type GetCoachDecisionRpcResult,
  type ResumeCoachDecisionRpcParams,
  type ResumeCoachDecisionRpcResult,
  type SkipCoachDecisionRpcParams,
  type SkipCoachDecisionRpcResult,
} from "./coach-decision.js";
import type {
  ChatQueueRunResult,
  ChatQueueSnapshot,
  EnqueueChatMessageRequest,
  GetChatQueueRequest,
  RemoveQueuedChatMessageRequest,
  ResumeChatQueueRequest,
  RetryQueuedTurnRequest,
  RunQueuedCommandRequest,
} from "./chat-queue.js";
import { TrainingExportCivilDateSchema } from "./training-export.js";

export const PlanIntakeWeekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const PlanIntakePatchSchema = z
  .object({
    eventName: z.string().trim().min(1).max(200).nullable().optional(),
    eventPriority: z.enum(["A", "B", "C"]).nullable().optional(),
    targetDate: TrainingExportCivilDateSchema.nullable().optional(),
    goal: z.string().trim().min(1).max(1_000).nullable().optional(),
    availability: z
      .object({
        sessionsPerWeek: z.number().int().min(1).max(6),
        weekdays: z.array(PlanIntakeWeekdaySchema).max(7),
      })
      .strict()
      .nullable()
      .optional(),
    experience: z.enum(["beginner", "intermediate", "advanced", "elite"]).nullable().optional(),
    currentTrainingSummary: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.values(value).every((field) => field === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Plan intake patch must contain at least one field",
      });
    }
    if (
      value.availability !== undefined &&
      value.availability !== null &&
      new Set(value.availability.weekdays).size !== value.availability.weekdays.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability", "weekdays"],
        message: "Plan intake weekdays must be unique",
      });
    }
  });
export type PlanIntakePatch = z.infer<typeof PlanIntakePatchSchema>;

export const ChatRequestSchema = z
  .object({
    chatId: z.string(),
    message: z.string(),
    turn: z
      .object({
        /** An opaque per-turn pace-anchor payload passed through to the engine. */
        resolvedCs: z.unknown().optional(),
        /** Source labels of the reference snapshot the anchor was resolved from. */
        referenceProvenance: z.unknown().optional(),
        language: LanguageTagSchema.optional(),
        languageSource: LanguageSourceSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z
  .object({
    text: z.string(),
    decision: CoachDecisionReadModelSchema.optional(),
    planIntakePatch: PlanIntakePatchSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision !== undefined && value.decision.status !== "unanswered") {
      context.addIssue({
        code: "custom",
        path: ["decision", "status"],
        message: "chat response decision must be unanswered",
      });
    }
    if (value.decision !== undefined && value.text !== "") {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "decision response must not include final text",
      });
    }
  });
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const StopChatRequestSchema = z
  .object({ chatId: z.string(), turnId: z.string().min(1) })
  .strict();
export type StopChatRequest = z.infer<typeof StopChatRequestSchema>;

export const StopChatResponseSchema = z.object({ stopped: z.boolean() }).strict();
export type StopChatResponse = z.infer<typeof StopChatResponseSchema>;

export const ResetSessionRequestSchema = z.object({ chatId: z.string() }).strict();
export type ResetSessionRequest = z.infer<typeof ResetSessionRequestSchema>;

export const ResetSessionResponseSchema = z.object({ memoryFlushed: z.boolean() }).strict();
export type ResetSessionResponse = z.infer<typeof ResetSessionResponseSchema>;

export const SettleRequestSchema = z.object({ chatId: z.string().optional() }).strict();
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export const HasSessionRequestSchema = z.object({ chatId: z.string() }).strict();
export type HasSessionRequest = z.infer<typeof HasSessionRequestSchema>;

export const HasSessionResponseSchema = z.object({ hasSession: z.boolean() }).strict();
export type HasSessionResponse = z.infer<typeof HasSessionResponseSchema>;

export interface ReplacePlanChatHistoryRequest {
  readonly chatId: string;
  readonly turns: readonly {
    readonly athleteText: string;
    readonly coachText: string;
  }[];
}

export interface CommitPlanChatTurnRequest {
  readonly chatId: string;
  readonly turnId: string;
}

export interface GetPlanDecisionIntakePatchRequest {
  readonly chatId: string;
  readonly decisionId: string;
}

/**
 * The single seam between the coaching engine and every surface. In-process
 * consumers call the interface directly; the remote projection is JSON-RPC 2.0
 * over a loopback (127.0.0.1) WebSocket with RPC method names equal to these
 * property names (`chat`, `resetSession`, `hasSession`, `getAthleteState`) —
 * the RPC layer adds no naming layer of its own.
 *
 * Every method is Promise-returning even where today's engine method is
 * synchronous, because the same interface must project over RPC.
 * `getAthleteState` takes no request: the state is a per-athlete-home
 * singleton read.
 */
export interface CoachEngine {
  chat(request: ChatRequest, onEvent?: (event: TurnEvent) => void): Promise<ChatResponse>;
  stopChat?(request: StopChatRequest): Promise<StopChatResponse>;
  enqueueChatMessage?(request: EnqueueChatMessageRequest): Promise<ChatQueueSnapshot>;
  getChatQueue?(request: GetChatQueueRequest): Promise<ChatQueueSnapshot>;
  removeQueuedChatMessage?(request: RemoveQueuedChatMessageRequest): Promise<ChatQueueSnapshot>;
  resumeChatQueue?(
    request: ResumeChatQueueRequest,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult>;
  runQueuedCommand?(
    request: RunQueuedCommandRequest,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult>;
  retryQueuedTurn?(
    request: RetryQueuedTurnRequest,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult>;
  getCoachDecision(request: GetCoachDecisionRpcParams): Promise<GetCoachDecisionRpcResult>;
  answerCoachDecision(
    request: AnswerCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<AnswerCoachDecisionRpcResult>;
  skipCoachDecision(request: SkipCoachDecisionRpcParams): Promise<SkipCoachDecisionRpcResult>;
  resumeCoachDecision(
    request: ResumeCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ResumeCoachDecisionRpcResult>;
  resetSession(request: ResetSessionRequest): Promise<ResetSessionResponse>;
  settle?(request?: SettleRequest): Promise<void>;
  hasSession(request: HasSessionRequest): Promise<HasSessionResponse>;
  getAthleteState(): Promise<AthleteState>;
  replacePlanChatHistory?(request: ReplacePlanChatHistoryRequest): Promise<void>;
  commitPlanChatTurn?(request: CommitPlanChatTurnRequest): Promise<void>;
  getPlanDecisionIntakePatch?(
    request: GetPlanDecisionIntakePatchRequest,
  ): Promise<PlanIntakePatch | undefined>;
}
