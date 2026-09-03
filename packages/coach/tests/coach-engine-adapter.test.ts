import { describe, expect, it, vi } from "vitest";
import {
  type AthleteState,
  type ChatRequest,
  type CoachDecisionReadModel,
  type CoachEngine,
  type TurnEvent,
} from "@enduragent/coach-contract";
import type { CyclingFtpAnchorResolver, CyclingFtpAnchorResult } from "@enduragent/kernel/anchors";
import { createCoachEngineAdapter as createProductionCoachEngineAdapter } from "../src/coach-engine-adapter.js";

type AdapterInput = Parameters<typeof createProductionCoachEngineAdapter>[0];

function createCoachEngineAdapter(
  input: Omit<AdapterInput, "planCreationDrainGate"> & {
    readonly planCreationDrainGate?: AdapterInput["planCreationDrainGate"];
  },
) {
  const { planCreationDrainGate = { hasOpenQuestion: async () => false }, ...rest } = input;
  return createProductionCoachEngineAdapter({ ...rest, planCreationDrainGate });
}

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: { name: "Synthetic Athlete" },
  currentStatus: { summary: "ready" },
  derivedMetrics: { eftp: 250 },
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const ftp: CyclingFtpAnchorResult = {
  kind: "ftp",
  watts: 250,
  validFrom: "2026-07-01",
  source: "synthetic",
  confidence: "manual",
  ageDays: 17,
  stalenessBand: "fresh",
  stale: false,
};

const unansweredDecision = {
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

function resolver(result: CyclingFtpAnchorResult = ftp): {
  value: CyclingFtpAnchorResolver;
  resolve: ReturnType<typeof vi.fn<CyclingFtpAnchorResolver["resolve"]>>;
} {
  const resolve = vi.fn<CyclingFtpAnchorResolver["resolve"]>(async () => result);
  return { value: { resolve }, resolve };
}

function backend(overrides: Partial<CoachEngine> = {}): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => {
      throw new Error("not implemented");
    },
    skipCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resumeCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
    ...overrides,
  };
}

describe("coach engine adapter", () => {
  it("refuses desktop Chat and every queue drain while a Plan Creation question is open", async () => {
    const selected = resolver();
    const chat = vi.fn<CoachEngine["chat"]>(async () => ({ text: "unexpected" }));
    const resumeChatQueue = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const runQueuedCommand = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const retryQueuedTurn = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const getChatQueue = vi.fn(async () => ({ schemaVersion: 1 as const, revision: 4, items: [] }));
    const engine = createCoachEngineAdapter({
      backend: backend({
        chat,
        resumeChatQueue,
        runQueuedCommand,
        retryQueuedTurn,
        getChatQueue,
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: selected.value,
      planCreationDrainGate: { hasOpenQuestion: async () => true },
      now: () => 1_752_796_801_999,
    });
    await expect(engine.chat({ chatId: "desktop", message: "queued" })).resolves.toEqual({
      text: "",
    });
    await expect(engine.resumeChatQueue?.({ chatId: "desktop" })).resolves.toEqual({
      snapshot: { schemaVersion: 1, revision: 4, items: [] },
    });
    await expect(
      engine.runQueuedCommand?.({ chatId: "desktop", queuedMessageId: "queued-1" }),
    ).resolves.toEqual({ snapshot: { schemaVersion: 1, revision: 4, items: [] } });
    await expect(
      engine.retryQueuedTurn?.({ chatId: "desktop", claimId: "claim-1" }),
    ).resolves.toEqual({ snapshot: { schemaVersion: 1, revision: 4, items: [] } });
    expect(chat).not.toHaveBeenCalled();
    expect(resumeChatQueue).not.toHaveBeenCalled();
    expect(runQueuedCommand).not.toHaveBeenCalled();
    expect(retryQueuedTurn).not.toHaveBeenCalled();
    expect(getChatQueue).toHaveBeenCalledTimes(3);
    expect(selected.resolve).not.toHaveBeenCalled();
  });

  it("fails open when the Plan Creation drain gate cannot be read", async () => {
    const selected = resolver();
    const chat = vi.fn<CoachEngine["chat"]>(async () => ({ text: "ok" }));
    const queueResult = {
      snapshot: { schemaVersion: 1 as const, revision: 4, items: [] },
    };
    const resumeChatQueue = vi.fn(async () => queueResult);
    const runQueuedCommand = vi.fn(async () => queueResult);
    const retryQueuedTurn = vi.fn(async () => queueResult);
    const engine = createCoachEngineAdapter({
      backend: backend({ chat, resumeChatQueue, runQueuedCommand, retryQueuedTurn }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: selected.value,
      planCreationDrainGate: {
        hasOpenQuestion: async () => Promise.reject(new Error("corrupt Plan Creation record")),
      },
      now: () => 1_752_796_801_999,
    });

    await expect(engine.chat({ chatId: "desktop", message: "continue" })).resolves.toEqual({
      text: "ok",
    });
    await expect(engine.resumeChatQueue?.({ chatId: "desktop" })).resolves.toEqual(queueResult);
    await expect(
      engine.runQueuedCommand?.({ chatId: "desktop", queuedMessageId: "queued-1" }),
    ).resolves.toEqual(queueResult);
    await expect(
      engine.retryQueuedTurn?.({ chatId: "desktop", claimId: "claim-1" }),
    ).resolves.toEqual(queueResult);
    expect(chat).toHaveBeenCalledOnce();
    expect(resumeChatQueue).toHaveBeenCalledOnce();
    expect(runQueuedCommand).toHaveBeenCalledOnce();
    expect(retryQueuedTurn).toHaveBeenCalledOnce();
    expect(selected.resolve).toHaveBeenCalledOnce();
  });

  it("resolves one FTP anchor at the call epoch and validates event order and response", async () => {
    const selected = resolver();
    const calls: string[] = [];
    const chat = vi.fn<CoachEngine["chat"]>(async (request, onEvent) => {
      calls.push("backend");
      expect(request.turn?.resolvedCs).toEqual(ftp);
      onEvent?.({ type: "turn-start", turnId: "turn-1", chatId: request.chatId });
      return { text: "ready" };
    });
    const engine = createCoachEngineAdapter({
      backend: backend({ chat }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: selected.value,
      now: () => 1_752_796_801_999,
    });
    await expect(
      engine.chat({ chatId: "chat-1", message: "status" }, () => {
        calls.push("event");
      }),
    ).resolves.toEqual({ text: "ready" });
    expect(selected.resolve).toHaveBeenCalledOnce();
    expect(selected.resolve).toHaveBeenCalledWith({
      effectiveAtEpochS: 1_752_796_801,
      evaluatedAtEpochS: 1_752_796_801,
    });
    expect(calls).toEqual(["backend", "event"]);
  });

  it("rejects invalid chat requests before clock, resolver, or backend", async () => {
    const selected = resolver();
    const chat = vi.fn<CoachEngine["chat"]>(async () => ({ text: "no" }));
    const now = vi.fn(() => 0);
    const engine = createCoachEngineAdapter({
      backend: backend({ chat }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: selected.value,
      now,
    });
    await expect(
      engine.chat({ chatId: "x", message: "x", extra: true } as ChatRequest),
    ).rejects.toThrow();
    expect(now).not.toHaveBeenCalled();
    expect(selected.resolve).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("latches invalid events, validates responses, keeps consumer errors advisory, and favors backend errors", async () => {
    const selected = resolver();
    const invalidEvent = { type: "turn-start", turnId: "x" } as unknown as TurnEvent;
    const invalid = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          try {
            onEvent?.(invalidEvent);
          } catch {}
          return { text: "ok" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: selected.value,
      now: () => 0,
    });
    await expect(invalid.chat({ chatId: "x", message: "x" })).rejects.toThrow();
    const backendError = { kind: "backend" };
    const precedence = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          onEvent?.(invalidEvent);
          throw backendError;
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(precedence.chat({ chatId: "x", message: "x" })).rejects.toBe(backendError);
    const advisory = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          onEvent?.({ type: "final-text", turnId: "x", text: "ok" });
          return { text: "ok" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(
      advisory.chat({ chatId: "x", message: "x" }, () => {
        throw new Error("consumer");
      }),
    ).resolves.toEqual({ text: "ok" });
    const malformed = createCoachEngineAdapter({
      backend: backend({ chat: async () => ({ text: 1 }) as unknown as { text: string } }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(malformed.chat({ chatId: "x", message: "x" })).rejects.toThrow();
  });

  it("validates every text_delta before advisory delivery and latches malformed deltas", async () => {
    const received: TurnEvent[] = [];
    const valid = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          onEvent?.({ type: "text_delta", turnId: "turn-1", delta: "one" });
          onEvent?.({ type: "text_delta", turnId: "turn-1", delta: " two" });
          return { text: "one two" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(
      valid.chat({ chatId: "x", message: "x" }, (event) => received.push(event)),
    ).resolves.toEqual({ text: "one two" });
    expect(received).toEqual([
      { type: "text_delta", turnId: "turn-1", delta: "one" },
      { type: "text_delta", turnId: "turn-1", delta: " two" },
    ]);

    const malformedDelta = {
      type: "text_delta",
      turnId: "turn-1",
      delta: 1,
      extra: true,
    } as unknown as TurnEvent;
    const malformed = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          expect(() => onEvent?.(malformedDelta)).not.toThrow();
          return { text: "ok" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(malformed.chat({ chatId: "x", message: "x" })).rejects.toThrow();

    const backendError = new Error("backend wins");
    const precedence = createCoachEngineAdapter({
      backend: backend({
        chat: async (_request, onEvent) => {
          onEvent?.(malformedDelta);
          throw backendError;
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(precedence.chat({ chatId: "x", message: "x" })).rejects.toBe(backendError);
  });

  it("strictly validates reset requests and responses", async () => {
    const resetSession = vi.fn<CoachEngine["resetSession"]>(async () => ({ memoryFlushed: true }));
    const engine = createCoachEngineAdapter({
      backend: backend({ resetSession }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(engine.resetSession({ chatId: "x", extra: 1 } as never)).rejects.toThrow();
    expect(resetSession).not.toHaveBeenCalled();
    await expect(engine.resetSession({ chatId: "x" })).resolves.toEqual({ memoryFlushed: true });
    resetSession.mockResolvedValueOnce({ memoryFlushed: true, extra: 1 } as never);
    await expect(engine.resetSession({ chatId: "x" })).rejects.toThrow();
  });

  it("strictly validates has-session requests and responses asynchronously", async () => {
    const hasSession = vi.fn<CoachEngine["hasSession"]>(async () => ({ hasSession: true }));
    const engine = createCoachEngineAdapter({
      backend: backend({ hasSession }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    const pending = engine.hasSession({ chatId: "x" });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual({ hasSession: true });
    await expect(engine.hasSession({ chatId: "x", extra: 1 } as never)).rejects.toThrow();
    hasSession.mockResolvedValueOnce({ hasSession: false, extra: 1 } as never);
    await expect(engine.hasSession({ chatId: "x" })).rejects.toThrow();
  });

  it("validates decision requests, events, and responses at the engine boundary", async () => {
    const answeredDecision = {
      ...unansweredDecision,
      status: "answered" as const,
      answer: { kind: "option" as const, optionId: "option-1" },
      consequence: "Tomorrow stays easy.",
      continuation: { continuationId: "continuation-1", status: "pending" as const },
    };
    const completedDecision = {
      ...answeredDecision,
      continuation: {
        continuationId: "continuation-1",
        status: "completed" as const,
        turnId: "turn-1",
        coachText: "Keep tomorrow easy.",
      },
    };
    const getCoachDecision = vi.fn<CoachEngine["getCoachDecision"]>(async () => ({
      decision: unansweredDecision,
    }));
    const answerCoachDecision = vi.fn<CoachEngine["answerCoachDecision"]>(
      async (_request, onEvent) => {
        onEvent?.({ type: "turn-start", turnId: "turn-1", chatId: "chat-1" });
        return { decision: answeredDecision };
      },
    );
    const skipCoachDecision = vi.fn<CoachEngine["skipCoachDecision"]>(async () => ({
      decision: { ...unansweredDecision, status: "skipped" },
    }));
    const resumeCoachDecision = vi.fn<CoachEngine["resumeCoachDecision"]>(
      async (_request, onEvent) => {
        onEvent?.({ type: "final-text", turnId: "turn-1", text: "Keep tomorrow easy." });
        return { decision: completedDecision, resumed: true };
      },
    );
    const engine = createCoachEngineAdapter({
      backend: backend({
        getCoachDecision,
        answerCoachDecision,
        skipCoachDecision,
        resumeCoachDecision,
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(engine.getCoachDecision({ chatId: "chat-1" })).resolves.toEqual({
      decision: unansweredDecision,
    });
    await expect(
      engine.answerCoachDecision(
        {
          chatId: "chat-1",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "option-1" },
        },
        () => {},
      ),
    ).resolves.toEqual({ decision: answeredDecision });
    await expect(
      engine.skipCoachDecision({ chatId: "chat-1", decisionId: "decision-1" }),
    ).resolves.toEqual({ decision: { ...unansweredDecision, status: "skipped" } });
    await expect(
      engine.resumeCoachDecision({ chatId: "chat-1", decisionId: "decision-1" }, () => {}),
    ).resolves.toEqual({ decision: completedDecision, resumed: true });
    await expect(
      engine.getCoachDecision({ chatId: "chat-1", extra: true } as never),
    ).rejects.toThrow();
    expect(getCoachDecision).toHaveBeenCalledOnce();
  });

  it("validates injected athlete state and exposes exactly eight methods", async () => {
    const getAthleteState = vi.fn(async (): Promise<AthleteState> => state);
    const engine = createCoachEngineAdapter({
      backend: backend(),
      getAthleteState,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await expect(engine.getAthleteState()).resolves.toEqual(state);
    expect(getAthleteState).toHaveBeenCalledOnce();
    expect(Object.keys(engine).sort()).toEqual([
      "answerCoachDecision",
      "chat",
      "enqueueChatMessage",
      "getAthleteState",
      "getChatQueue",
      "getCoachDecision",
      "hasSession",
      "removeQueuedChatMessage",
      "resetSession",
      "resumeChatQueue",
      "resumeCoachDecision",
      "retryQueuedTurn",
      "runQueuedCommand",
      "skipCoachDecision",
      "stopChat",
    ]);
    await expect(
      createCoachEngineAdapter({
        backend: backend(),
        getAthleteState: async () => ({ ...state, extra: true }) as AthleteState,
        cyclingFtpAnchorResolver: resolver().value,
        now: () => 0,
      }).getAthleteState(),
    ).rejects.toThrow();
  });

  it("always replaces a caller FTP value without mutating either caller object", async () => {
    const request = { chatId: "x", message: "x", turn: { resolvedCs: { old: true } } };
    const turn = request.turn;
    let received: ChatRequest | undefined;
    const engine = createCoachEngineAdapter({
      backend: backend({
        chat: async (value) => {
          received = value;
          return { text: "ok" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver().value,
      now: () => 0,
    });
    await engine.chat(request);
    expect(received?.turn?.resolvedCs).toEqual(ftp);
    expect(request.turn.resolvedCs).toEqual({ old: true });
    expect(received).not.toBe(request);
    expect(received?.turn).not.toBe(turn);
  });

  it("forwards the complete missing-anchor result", async () => {
    const missing = { kind: "missing" as const, refusal: "missing-cycling-ftp-anchor" as const };
    let received: ChatRequest | undefined;
    const engine = createCoachEngineAdapter({
      backend: backend({
        chat: async (value) => {
          received = value;
          return { text: "ok" };
        },
      }),
      getAthleteState: async () => state,
      cyclingFtpAnchorResolver: resolver(missing).value,
      now: () => 0,
    });
    await expect(engine.chat({ chatId: "x", message: "x" })).resolves.toEqual({ text: "ok" });
    expect(received?.turn?.resolvedCs).toEqual(missing);
  });
});
