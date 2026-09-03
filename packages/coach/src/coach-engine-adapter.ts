import {
  AnswerCoachDecisionRpcParamsSchema,
  AnswerCoachDecisionRpcResultSchema,
  AthleteStateSchema,
  ChatRequestSchema,
  ChatQueueRunResultSchema,
  ChatQueueSnapshotSchema,
  EnqueueChatMessageRequestSchema,
  GetChatQueueRequestSchema,
  ChatResponseSchema,
  GetCoachDecisionRpcParamsSchema,
  GetCoachDecisionRpcResultSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  ResumeCoachDecisionRpcParamsSchema,
  ResumeCoachDecisionRpcResultSchema,
  RemoveQueuedChatMessageRequestSchema,
  ResumeChatQueueRequestSchema,
  RetryQueuedTurnRequestSchema,
  RunQueuedCommandRequestSchema,
  SkipCoachDecisionRpcParamsSchema,
  SkipCoachDecisionRpcResultSchema,
  StopChatRequestSchema,
  StopChatResponseSchema,
  TurnEventSchema,
  type AthleteState,
  type ChatQueueRunResult,
  type CoachEngine,
  type TurnEvent,
} from "@enduragent/coach-contract";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";

export interface CoachEngineAdapterInput {
  readonly backend: CoachEngine;
  readonly getAthleteState: () => Promise<AthleteState>;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
  readonly planCreationDrainGate: { hasOpenQuestion(): Promise<boolean> };
  readonly now: () => number;
}

export function createCoachEngineAdapter(input: CoachEngineAdapterInput): CoachEngine {
  const blocked = async (chatId: string): Promise<boolean> => {
    if (chatId !== "desktop") return false;
    try {
      return await input.planCreationDrainGate.hasOpenQuestion();
    } catch {
      return false;
    }
  };
  const currentQueue = async (chatId: string): Promise<ChatQueueRunResult> => {
    if (input.backend.getChatQueue === undefined)
      throw new Error("Durable chat queue is unavailable.");
    return ChatQueueRunResultSchema.parse({
      snapshot: await input.backend.getChatQueue({ chatId }),
    });
  };
  const queueStream = async (
    operation: (onEvent: (event: TurnEvent) => void) => Promise<ChatQueueRunResult>,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult> => {
    let firstEventValidationError: unknown | undefined;
    const response = await operation((event) => {
      if (firstEventValidationError !== undefined) return;
      const result = TurnEventSchema.safeParse(event);
      if (!result.success) {
        firstEventValidationError = result.error;
        return;
      }
      try {
        onEvent?.(result.data);
      } catch {}
    });
    if (firstEventValidationError !== undefined) throw firstEventValidationError;
    return ChatQueueRunResultSchema.parse(response);
  };
  return {
    async chat(request, onEvent) {
      const parsed = ChatRequestSchema.parse(request);
      if (await blocked(parsed.chatId)) return ChatResponseSchema.parse({ text: "" });
      const callEpochS = Math.floor(input.now() / 1_000);
      const resolvedCs = await input.cyclingFtpAnchorResolver.resolve({
        effectiveAtEpochS: callEpochS,
        evaluatedAtEpochS: callEpochS,
      });
      const resolvedRequest = {
        ...parsed,
        turn: {
          ...parsed.turn,
          resolvedCs,
        },
      };
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.chat(resolvedRequest, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return ChatResponseSchema.parse(response);
    },
    async stopChat(request) {
      const parsed = StopChatRequestSchema.parse(request);
      return StopChatResponseSchema.parse(
        await input.backend.stopChat?.(parsed).then((value) => value ?? { stopped: false }),
      );
    },
    async enqueueChatMessage(request) {
      const parsed = EnqueueChatMessageRequestSchema.parse(request);
      if (input.backend.enqueueChatMessage === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await input.backend.enqueueChatMessage(parsed));
    },
    async getChatQueue(request) {
      const parsed = GetChatQueueRequestSchema.parse(request);
      if (input.backend.getChatQueue === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await input.backend.getChatQueue(parsed));
    },
    async removeQueuedChatMessage(request) {
      const parsed = RemoveQueuedChatMessageRequestSchema.parse(request);
      if (input.backend.removeQueuedChatMessage === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await input.backend.removeQueuedChatMessage(parsed));
    },
    async resumeChatQueue(request, onEvent) {
      const parsed = ResumeChatQueueRequestSchema.parse(request);
      if (await blocked(parsed.chatId)) return currentQueue(parsed.chatId);
      if (input.backend.resumeChatQueue === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return queueStream((emit) => input.backend.resumeChatQueue!(parsed, emit), onEvent);
    },
    async runQueuedCommand(request, onEvent) {
      const parsed = RunQueuedCommandRequestSchema.parse(request);
      if (await blocked(parsed.chatId)) return currentQueue(parsed.chatId);
      if (input.backend.runQueuedCommand === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return queueStream((emit) => input.backend.runQueuedCommand!(parsed, emit), onEvent);
    },
    async retryQueuedTurn(request, onEvent) {
      const parsed = RetryQueuedTurnRequestSchema.parse(request);
      if (await blocked(parsed.chatId)) return currentQueue(parsed.chatId);
      if (input.backend.retryQueuedTurn === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return queueStream((emit) => input.backend.retryQueuedTurn!(parsed, emit), onEvent);
    },
    async resetSession(request) {
      const parsed = ResetSessionRequestSchema.parse(request);
      return ResetSessionResponseSchema.parse(await input.backend.resetSession(parsed));
    },
    async hasSession(request) {
      const parsed = HasSessionRequestSchema.parse(request);
      return HasSessionResponseSchema.parse(await input.backend.hasSession(parsed));
    },
    async getAthleteState() {
      return AthleteStateSchema.parse(await input.getAthleteState());
    },
    async getCoachDecision(request) {
      const parsed = GetCoachDecisionRpcParamsSchema.parse(request);
      return GetCoachDecisionRpcResultSchema.parse(await input.backend.getCoachDecision(parsed));
    },
    async answerCoachDecision(request, onEvent) {
      const parsed = AnswerCoachDecisionRpcParamsSchema.parse(request);
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.answerCoachDecision(parsed, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return AnswerCoachDecisionRpcResultSchema.parse(response);
    },
    async skipCoachDecision(request) {
      const parsed = SkipCoachDecisionRpcParamsSchema.parse(request);
      return SkipCoachDecisionRpcResultSchema.parse(await input.backend.skipCoachDecision(parsed));
    },
    async resumeCoachDecision(request, onEvent) {
      const parsed = ResumeCoachDecisionRpcParamsSchema.parse(request);
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.resumeCoachDecision(parsed, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return ResumeCoachDecisionRpcResultSchema.parse(response);
    },
  };
}
