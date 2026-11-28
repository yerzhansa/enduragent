import type { CoachLanguage } from "@enduragent/i18n";
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
  DiscardQueuedTurnRequestSchema,
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

const trustedLanguageRequests = new WeakSet<object>();

export function withTrustedTurnLanguage(engine: CoachEngine): CoachEngine {
  return {
    ...engine,
    async chat(request, onEvent) {
      const trustedRequest = { ...request };
      trustedLanguageRequests.add(trustedRequest);
      try {
        return await engine.chat(trustedRequest, onEvent);
      } finally {
        trustedLanguageRequests.delete(trustedRequest);
      }
    },
  };
}

export interface CoachEngineAdapterInput {
  readonly coachLanguage: CoachLanguage;
  readonly backend: CoachEngine;
  readonly getAthleteState: () => Promise<AthleteState>;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
  readonly now: () => number;
}

export function createCoachEngineAdapter(input: CoachEngineAdapterInput): CoachEngine {
  const validatedEvents = async <Result>(
    operation: (onEvent: (event: TurnEvent) => void) => Promise<Result>,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<Result> => {
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
      } catch {
        return;
      }
    });
    if (firstEventValidationError !== undefined) throw firstEventValidationError;
    return response;
  };
  const queueUnavailable = (): never => {
    throw new Error("Durable chat queue is unavailable.");
  };
  const queueStream = async (
    operation: (onEvent: (event: TurnEvent) => void) => Promise<ChatQueueRunResult> | undefined,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult> =>
    ChatQueueRunResultSchema.parse(
      await validatedEvents((emit) => operation(emit) ?? queueUnavailable(), onEvent),
    );
  return {
    async chat(request, onEvent) {
      const parsed = ChatRequestSchema.parse(request);
      const callEpochS = Math.floor(input.now() / 1_000);
      const resolvedCs = await input.cyclingFtpAnchorResolver.resolve({
        effectiveAtEpochS: callEpochS,
        evaluatedAtEpochS: callEpochS,
      });
      const language =
        trustedLanguageRequests.has(request) && parsed.turn?.language !== undefined
          ? { language: parsed.turn.language, source: parsed.turn.languageSource }
          : await input.coachLanguage.resolveFor({ athleteText: parsed.message });
      const resolvedRequest = {
        ...parsed,
        turn: {
          ...parsed.turn,
          resolvedCs,
          language: language.language,
          languageSource: language.source,
        },
      };
      return ChatResponseSchema.parse(
        await validatedEvents((emit) => input.backend.chat(resolvedRequest, emit), onEvent),
      );
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
      return queueStream((emit) => input.backend.resumeChatQueue?.(parsed, emit), onEvent);
    },
    async runQueuedCommand(request, onEvent) {
      const parsed = RunQueuedCommandRequestSchema.parse(request);
      return queueStream((emit) => input.backend.runQueuedCommand?.(parsed, emit), onEvent);
    },
    async retryQueuedTurn(request, onEvent) {
      const parsed = RetryQueuedTurnRequestSchema.parse(request);
      return queueStream((emit) => input.backend.retryQueuedTurn?.(parsed, emit), onEvent);
    },
    async discardQueuedTurn(request) {
      const parsed = DiscardQueuedTurnRequestSchema.parse(request);
      if (input.backend.discardQueuedTurn === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await input.backend.discardQueuedTurn(parsed));
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
      return AnswerCoachDecisionRpcResultSchema.parse(
        await validatedEvents((emit) => input.backend.answerCoachDecision(parsed, emit), onEvent),
      );
    },
    async skipCoachDecision(request) {
      const parsed = SkipCoachDecisionRpcParamsSchema.parse(request);
      return SkipCoachDecisionRpcResultSchema.parse(await input.backend.skipCoachDecision(parsed));
    },
    async resumeCoachDecision(request, onEvent) {
      const parsed = ResumeCoachDecisionRpcParamsSchema.parse(request);
      return ResumeCoachDecisionRpcResultSchema.parse(
        await validatedEvents((emit) => input.backend.resumeCoachDecision(parsed, emit), onEvent),
      );
    },
  };
}
