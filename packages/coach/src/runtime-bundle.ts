import type { ConfirmationGate, ConversationStorePort, Memory } from "@enduragent/core";
import type { IntentTranslationPort } from "@enduragent/engine";
import type {
  CoachEngine,
  GetArchivedTranscriptPageRpcParams,
  GetArchivedTranscriptPageRpcResult,
  GetTranscriptPageRpcParams,
  GetTranscriptPageRpcResult,
  ListArchivedConversationsRpcParams,
  ListArchivedConversationsRpcResult,
} from "@enduragent/coach-contract";
import type { SpendMeterService } from "./spend-meter.js";

export interface RuntimeBundle {
  readonly intentTranslator?: IntentTranslationPort;
  readonly engine: CoachEngine;
  readonly memory: Memory;
  readonly chatStore: ConversationStorePort;
  readonly spendMeter: SpendMeterService;
  readonly timezone: string;
  readonly confirmations: ConfirmationGate;
}

export function createReconfigurableRuntimeBundle(initial: RuntimeBundle): {
  readonly intentTranslator: IntentTranslationPort;
  readonly engine: CoachEngine;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  readonly getTranscriptPage: (
    request: GetTranscriptPageRpcParams,
  ) => Promise<GetTranscriptPageRpcResult>;
  readonly listArchivedConversations: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly getArchivedTranscriptPage: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
  readonly withChatStore: <T>(
    operation: (store: ConversationStorePort) => Promise<T>,
  ) => Promise<T>;
  replace<T>(
    prepare: () => T | Promise<T>,
    commit: (prepared: T) => RuntimeBundle | Promise<RuntimeBundle>,
  ): Promise<void>;
} {
  let active = initial;
  let admission = Promise.resolve();
  let activeCalls = 0;
  let pendingReplacements = 0;
  const drainWaiters = new Set<() => void>();

  const run = async <T>(operation: (bundle: RuntimeBundle) => Promise<T>): Promise<T> => {
    await admission;
    activeCalls += 1;
    const selected = active;
    try {
      return await operation(selected);
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  };
  const queueUnavailable = (): never => {
    throw new TypeError("Durable chat queue is unavailable.");
  };

  return {
    intentTranslator: {
      translateIntent: (text, schema, context) =>
        run(
          async (bundle) => bundle.intentTranslator?.translateIntent(text, schema, context) ?? null,
        ),
    },
    engine: {
      chat: (request, onEvent) => run((bundle) => bundle.engine.chat(request, onEvent)),
      stopChat: (request) =>
        run(async (bundle) => bundle.engine.stopChat?.(request) ?? { stopped: false }),
      enqueueChatMessage: (request) =>
        run((bundle) => bundle.engine.enqueueChatMessage?.(request) ?? queueUnavailable()),
      getChatQueue: (request) =>
        run((bundle) => bundle.engine.getChatQueue?.(request) ?? queueUnavailable()),
      removeQueuedChatMessage: (request) =>
        run((bundle) => bundle.engine.removeQueuedChatMessage?.(request) ?? queueUnavailable()),
      resumeChatQueue: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeChatQueue?.(request, onEvent) ?? queueUnavailable()),
      runQueuedCommand: (request, onEvent) =>
        run((bundle) => bundle.engine.runQueuedCommand?.(request, onEvent) ?? queueUnavailable()),
      retryQueuedTurn: (request, onEvent) =>
        run((bundle) => bundle.engine.retryQueuedTurn?.(request, onEvent) ?? queueUnavailable()),
      getCoachDecision: (request) => run((bundle) => bundle.engine.getCoachDecision(request)),
      answerCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.answerCoachDecision(request, onEvent)),
      skipCoachDecision: (request) => run((bundle) => bundle.engine.skipCoachDecision(request)),
      resumeCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeCoachDecision(request, onEvent)),
      resetSession: (request) => run((bundle) => bundle.engine.resetSession(request)),
      settle: (request) => run(async (bundle) => bundle.engine.settle?.(request)),
      hasSession: (request) => run((bundle) => bundle.engine.hasSession(request)),
      getAthleteState: () => run((bundle) => bundle.engine.getAthleteState()),
    },
    spendMeter: {
      getSpendSummary: () => run((bundle) => bundle.spendMeter.getSpendSummary()),
      setDailySpendCap: (dailyCapUsd) =>
        run((bundle) => bundle.spendMeter.setDailySpendCap(dailyCapUsd)),
    },
    confirmations: {
      peek: (chatId, phrasebook) =>
        pendingReplacements === 0 ? active.confirmations.peek(chatId, phrasebook) : undefined,
      confirm: (chatId, nonce, phrasebook) =>
        run((bundle) => bundle.confirmations.confirm(chatId, nonce, phrasebook)),
      cancel: (chatId, nonce) =>
        pendingReplacements === 0 ? active.confirmations.cancel(chatId, nonce) : "none",
    },
    getTranscriptPage: (request) =>
      run(async (bundle) => bundle.chatStore.readCurrentConversationPage("desktop", request)),
    listArchivedConversations: () =>
      run(async (bundle) => bundle.chatStore.listArchivedConversations("desktop")),
    getArchivedTranscriptPage: ({ boundaryRef, ...request }) =>
      run(async (bundle) =>
        bundle.chatStore.readArchivedConversationPage("desktop", boundaryRef, request),
      ),
    withChatStore: (operation) => run((bundle) => operation(bundle.chatStore)),
    async replace(prepare, commit) {
      pendingReplacements += 1;
      const previousAdmission = admission;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      admission = previousAdmission.then(() => barrier);
      await previousAdmission;
      try {
        const prepared = await prepare();
        if (activeCalls > 0) {
          await new Promise<void>((resolve) => drainWaiters.add(resolve));
        }
        active = await commit(prepared);
      } finally {
        pendingReplacements -= 1;
        release();
      }
    },
  };
}
