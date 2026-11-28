import { createCoachLanguage } from "@enduragent/i18n";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, expect, it, vi } from "vitest";
import type {
  AthleteState,
  ChatQueueRunResult,
  ChatQueueSnapshot,
  CoachDecisionReadModel,
  CoachEngine,
  SpendCapMode,
  SpendCapStatus,
  SpendSummary,
} from "@enduragent/coach-contract";
import {
  SpendCapReachedError,
  createCoachEngineAdapter,
  type SpendCapReader,
} from "../src/coach-engine-adapter.js";

const coachLanguage = createCoachLanguage({
  phrasebooks: createPhrasebook,
  store: {
    read: async () => ({ value: "en", origin: "stored" }),
    write: async (value) => ({ value, origin: "stored" }),
  },
  surface: { language: "en", locale: "en-US" },
});

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "1998-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "1998-07-18T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const emptyQueue: ChatQueueSnapshot = { schemaVersion: 1, revision: 3, items: [] };

const unanswered = {
  decisionId: "decision-1",
  chatId: "chat-1",
  messageId: "message-1",
  question: "Choose tomorrow's priority.",
  options: [
    {
      id: "option-1",
      label: "Recover",
      description: "Protect the weekend session.",
      recommended: true,
      consequence: "Tomorrow stays easy.",
    },
    {
      id: "option-2",
      label: "Train",
      description: "Keep the planned session.",
      recommended: false,
      consequence: "Tomorrow keeps its workout.",
    },
  ],
  status: "unanswered",
} satisfies CoachDecisionReadModel;

const pending = {
  ...unanswered,
  status: "answered" as const,
  answer: { kind: "option" as const, optionId: "option-1" },
  consequence: "Tomorrow stays easy.",
  continuation: { continuationId: "continuation-1", status: "pending" as const },
} satisfies CoachDecisionReadModel;

function summary(capMode: SpendCapMode, capStatus: SpendCapStatus): SpendSummary {
  return {
    localDate: "1998-07-18",
    timezone: "UTC",
    dailyCapUsd: 0.01,
    knownSpendUsd: capStatus === "below" ? 0 : 0.02,
    generationCount: 0,
    pricedGenerationCount: 0,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: capStatus !== "unknown",
    capStatus,
    capMode,
    cacheReadTokens: 0,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: true,
    routes: [],
  };
}

const ran: ChatQueueRunResult = { snapshot: emptyQueue, response: { text: "Ride easy." } };

function harness(spendCap: SpendCapReader) {
  const logger = { warn: vi.fn() };
  const turns = {
    chat: vi.fn<CoachEngine["chat"]>(async () => ({ text: "Ride easy." })),
    resumeChatQueue: vi.fn<NonNullable<CoachEngine["resumeChatQueue"]>>(async () => ran),
    runQueuedCommand: vi.fn<NonNullable<CoachEngine["runQueuedCommand"]>>(async () => ran),
    retryQueuedTurn: vi.fn<NonNullable<CoachEngine["retryQueuedTurn"]>>(async () => ran),
    answerCoachDecision: vi.fn<CoachEngine["answerCoachDecision"]>(async () => ({
      decision: pending,
    })),
    resumeCoachDecision: vi.fn<CoachEngine["resumeCoachDecision"]>(async () => ({
      decision: pending,
      resumed: true,
    })),
  };
  const backend: CoachEngine = {
    ...turns,
    getChatQueue: async () => emptyQueue,
    getCoachDecision: async ({ decisionId }) => ({
      decision: decisionId === "decision-pending" ? pending : unanswered,
    }),
    skipCoachDecision: async () => ({ decision: { ...unanswered, status: "skipped" } }),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
  };
  const engine = createCoachEngineAdapter({
    coachLanguage,
    backend,
    getAthleteState: async () => state,
    cyclingFtpAnchorResolver: {
      resolve: async () => ({ kind: "missing", refusal: "none" }) as never,
    },
    now: () => 0,
    spendCap: { reader: spendCap, logger },
  });
  return { engine, turns, logger };
}

const reader = (value: SpendSummary): SpendCapReader => ({ getSpendSummary: async () => value });

const refusal = { kind: "spend-cap-reached", dailyCapUsd: 0.01, knownSpendUsd: 0.02 } as const;

type TurnName =
  | "chat"
  | "resumeChatQueue"
  | "runQueuedCommand"
  | "retryQueuedTurn"
  | "answerCoachDecision"
  | "resumeCoachDecision";

const calls: ReadonlyArray<{
  readonly name: TurnName;
  readonly run: (engine: CoachEngine, chatId: string) => Promise<unknown>;
  readonly refused: unknown;
}> = [
  {
    name: "chat",
    run: (engine, chatId) => engine.chat({ chatId, message: "How should I ride today?" }),
    refused: {
      text: "Today’s model spend has reached your $0.01 daily cap, so the coach didn’t answer. To keep going today, raise the cap or switch it to Warn in Settings › Spending.",
      message: { key: "coach.refusal.spendCapReached", vars: { cap: "$0.01" } },
      refusal,
    },
  },
  {
    name: "resumeChatQueue",
    run: (engine, chatId) => engine.resumeChatQueue!({ chatId }),
    refused: { snapshot: emptyQueue, refusal },
  },
  {
    name: "runQueuedCommand",
    run: (engine, chatId) => engine.runQueuedCommand!({ chatId, queuedMessageId: "queued-1" }),
    refused: { snapshot: emptyQueue, refusal },
  },
  {
    name: "retryQueuedTurn",
    run: (engine, chatId) => engine.retryQueuedTurn!({ chatId, claimId: "claim-1" }),
    refused: { snapshot: emptyQueue, refusal },
  },
  {
    name: "answerCoachDecision",
    run: (engine, chatId) =>
      engine.answerCoachDecision({
        chatId,
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "option-1" },
      }),
    refused: { decision: unanswered, refusal },
  },
  {
    name: "resumeCoachDecision",
    run: (engine, chatId) => engine.resumeCoachDecision({ chatId, decisionId: "decision-pending" }),
    refused: { decision: pending, resumed: false, refusal },
  },
];

describe("the spend cap at the coach engine adapter", () => {
  it.each(calls)(
    "$name refuses with no model call when an enforced cap is reached",
    async (call) => {
      const { engine, turns } = harness(reader(summary("enforce", "reached")));
      await expect(call.run(engine, "chat-1")).resolves.toEqual(call.refused);
      for (const turn of Object.values(turns)) expect(turn).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    "$name runs the turn below the cap, at an unknown spend, and in warn mode",
    async (call) => {
      for (const [mode, status] of [
        ["enforce", "below"],
        ["enforce", "unknown"],
        ["warn", "reached"],
      ] as const) {
        const { engine, turns } = harness(reader(summary(mode, status)));
        const result = await call.run(engine, "chat-1");
        expect(result).not.toHaveProperty("refusal");
        expect(turns[call.name]).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(calls)("$name runs the turn when the spend meter cannot be read", async (call) => {
    const unreadable = new Error("ledger unreadable");
    const { engine, turns, logger } = harness({
      getSpendSummary: async () => {
        throw unreadable;
      },
    });
    await call.run(engine, "chat-1");
    expect(turns[call.name]).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("spend_cap_read_failed", unreadable);
  });

  it.each(calls)(
    "$name throws a spend cap error for a Plan chat instead of answering",
    async (call) => {
      const { engine, turns } = harness(reader(summary("enforce", "reached")));
      await expect(call.run(engine, "plan:conversation-1")).rejects.toBeInstanceOf(
        SpendCapReachedError,
      );
      for (const turn of Object.values(turns)) expect(turn).not.toHaveBeenCalled();
    },
  );
});
