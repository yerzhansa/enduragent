import { msg, type CoachLanguage, type Message } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
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
  type ChatQueueSnapshot,
  type CoachEngine,
  type SpendSummary,
  type TurnEvent,
  type TurnRefusal,
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

export interface SpendCapReader {
  getSpendSummary(): Promise<SpendSummary>;
}

export interface SpendCapGuard {
  readonly reader: SpendCapReader;
  readonly logger: { warn(event: string, err?: unknown): void };
}

export interface CoachEngineAdapterInput {
  readonly coachLanguage: CoachLanguage;
  readonly backend: CoachEngine;
  readonly getAthleteState: () => Promise<AthleteState>;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
  readonly now: () => number;
  readonly spendCap?: SpendCapGuard;
}

type SpendCapReading =
  | { readonly kind: "read"; readonly summary: SpendSummary }
  | { readonly kind: "unreadable"; readonly error: unknown };

async function readSpendCap(reader: SpendCapReader): Promise<SpendCapReading> {
  try {
    return { kind: "read", summary: await reader.getSpendSummary() };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

export function spendCapRefusal(reading: SpendCapReading): TurnRefusal | undefined {
  if (reading.kind !== "read") return undefined;
  const { capMode, capStatus, dailyCapUsd, knownSpendUsd } = reading.summary;
  if (capMode !== "enforce" || capStatus !== "reached") return undefined;
  return { kind: "spend-cap-reached", dailyCapUsd, knownSpendUsd };
}

export class SpendCapReachedError extends Error {
  readonly refusal: TurnRefusal;

  constructor(refusal: TurnRefusal) {
    super("The daily spend cap is reached, so the coach refused this turn.");
    this.name = "SpendCapReachedError";
    this.refusal = refusal;
  }
}

export function spendCapRefusalMessage(refusal: TurnRefusal): Message {
  return msg("coach.refusal.spendCapReached", { cap: `$${refusal.dailyCapUsd.toFixed(2)}` });
}

function notify(onEvent: ((event: TurnEvent) => void) | undefined, event: TurnEvent): void {
  try {
    onEvent?.(event);
  } catch {
    return;
  }
}

function validatedEvents(onEvent: ((event: TurnEvent) => void) | undefined): {
  readonly listener: (event: TurnEvent) => void;
  readonly assertValid: () => void;
} {
  let firstValidationError: { readonly error: unknown } | undefined;
  return {
    listener: (event) => {
      if (firstValidationError !== undefined) return;
      const result = TurnEventSchema.safeParse(event);
      if (!result.success) {
        firstValidationError = { error: result.error };
        return;
      }
      notify(onEvent, result.data);
    },
    assertValid: () => {
      if (firstValidationError !== undefined) throw firstValidationError.error;
    },
  };
}

export function createCoachEngineAdapter(input: CoachEngineAdapterInput): CoachEngine {
  let english: Promise<Phrasebook> | undefined;
  const refusal = async (chatId: string): Promise<TurnRefusal | undefined> => {
    if (input.spendCap === undefined) return undefined;
    const reading = await readSpendCap(input.spendCap.reader);
    if (reading.kind === "unreadable")
      input.spendCap.logger.warn("spend_cap_read_failed", reading.error);
    const refused = spendCapRefusal(reading);
    if (refused !== undefined && chatId.startsWith("plan:"))
      throw new SpendCapReachedError(refused);
    return refused;
  };
  const currentDecision = async (chatId: string, decisionId: string) =>
    GetCoachDecisionRpcResultSchema.parse(
      await input.backend.getCoachDecision({ chatId, decisionId }),
    ).decision;
  const queueBackend = <K extends "resumeChatQueue" | "runQueuedCommand" | "retryQueuedTurn">(
    name: K,
  ): NonNullable<CoachEngine[K]> => {
    const operation = input.backend[name];
    if (operation === undefined) throw new Error("Durable chat queue is unavailable.");
    return operation.bind(input.backend) as NonNullable<CoachEngine[K]>;
  };
  const unchangedQueue = async (chatId: string): Promise<ChatQueueSnapshot> => {
    const getChatQueue = input.backend.getChatQueue;
    if (getChatQueue === undefined) throw new Error("Durable chat queue is unavailable.");
    return ChatQueueSnapshotSchema.parse(await getChatQueue.call(input.backend, { chatId }));
  };
  const queueStream = async (
    operation: (onEvent: (event: TurnEvent) => void) => Promise<ChatQueueRunResult>,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ChatQueueRunResult> => {
    const events = validatedEvents(onEvent);
    const response = await operation(events.listener);
    events.assertValid();
    return ChatQueueRunResultSchema.parse(response);
  };
  const refuseQueue = async (chatId: string, refused: TurnRefusal): Promise<ChatQueueRunResult> =>
    ChatQueueRunResultSchema.parse({ snapshot: await unchangedQueue(chatId), refusal: refused });
  return {
    async chat(request, onEvent) {
      const parsed = ChatRequestSchema.parse(request);
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) {
        english ??= createPhrasebook({ tag: "en", locale: "en-GB" });
        const message = spendCapRefusalMessage(refused);
        return ChatResponseSchema.parse({
          text: (await english).say(message),
          message,
          refusal: refused,
        });
      }
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
      const events = validatedEvents(onEvent);
      const response = await input.backend.chat(resolvedRequest, events.listener);
      events.assertValid();
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
      return unchangedQueue(parsed.chatId);
    },
    async removeQueuedChatMessage(request) {
      const parsed = RemoveQueuedChatMessageRequestSchema.parse(request);
      if (input.backend.removeQueuedChatMessage === undefined)
        throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await input.backend.removeQueuedChatMessage(parsed));
    },
    async resumeChatQueue(request, onEvent) {
      const parsed = ResumeChatQueueRequestSchema.parse(request);
      const resume = queueBackend("resumeChatQueue");
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) return refuseQueue(parsed.chatId, refused);
      return queueStream((emit) => resume(parsed, emit), onEvent);
    },
    async runQueuedCommand(request, onEvent) {
      const parsed = RunQueuedCommandRequestSchema.parse(request);
      const run = queueBackend("runQueuedCommand");
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) return refuseQueue(parsed.chatId, refused);
      return queueStream((emit) => run(parsed, emit), onEvent);
    },
    async retryQueuedTurn(request, onEvent) {
      const parsed = RetryQueuedTurnRequestSchema.parse(request);
      const retry = queueBackend("retryQueuedTurn");
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) return refuseQueue(parsed.chatId, refused);
      return queueStream((emit) => retry(parsed, emit), onEvent);
    },
    async discardQueuedTurn(request) {
      const parsed = DiscardQueuedTurnRequestSchema.parse(request);
      const discard = input.backend.discardQueuedTurn;
      if (discard === undefined) throw new Error("Durable chat queue is unavailable.");
      return ChatQueueSnapshotSchema.parse(await discard.call(input.backend, parsed));
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
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) {
        return AnswerCoachDecisionRpcResultSchema.parse({
          decision: await currentDecision(parsed.chatId, parsed.decisionId),
          refusal: refused,
        });
      }
      const events = validatedEvents(onEvent);
      const response = await input.backend.answerCoachDecision(parsed, events.listener);
      events.assertValid();
      return AnswerCoachDecisionRpcResultSchema.parse(response);
    },
    async skipCoachDecision(request) {
      const parsed = SkipCoachDecisionRpcParamsSchema.parse(request);
      return SkipCoachDecisionRpcResultSchema.parse(await input.backend.skipCoachDecision(parsed));
    },
    async resumeCoachDecision(request, onEvent) {
      const parsed = ResumeCoachDecisionRpcParamsSchema.parse(request);
      const refused = await refusal(parsed.chatId);
      if (refused !== undefined) {
        return ResumeCoachDecisionRpcResultSchema.parse({
          decision: await currentDecision(parsed.chatId, parsed.decisionId),
          resumed: false,
          refusal: refused,
        });
      }
      const events = validatedEvents(onEvent);
      const response = await input.backend.resumeCoachDecision(parsed, events.listener);
      events.assertValid();
      return ResumeCoachDecisionRpcResultSchema.parse(response);
    },
  };
}
