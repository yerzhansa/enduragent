import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoachEngine } from "../src/index.js";
import type { CoachDecisionReadModel, TurnEvent } from "@enduragent/coach-contract";
import type { GenerateResult, Sport } from "../src/sport.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { LanguageResolution } from "@enduragent/i18n";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDecision(chatId: string): CoachDecisionReadModel {
  return {
    status: "unanswered",
    decisionId: "decision-1",
    chatId,
    messageId: "message-1",
    question: "Choose tomorrow's priority.",
    options: [
      {
        id: "recovery",
        label: "Recovery",
        description: "Ride easy.",
        recommended: true,
        consequence: "Tomorrow becomes a recovery day.",
      },
      {
        id: "tempo",
        label: "Tempo",
        description: "Keep the planned work.",
        recommended: false,
        consequence: "Tomorrow keeps the tempo session.",
      },
    ],
  };
}

function setup(language?: EngineHostPorts["language"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-decision-engine-"));
  dirs.push(dataDir);
  const ports = baseAgentConfig(dataDir);
  const interrupted: Array<{
    chatId: string;
    turnId: string;
    athleteText: string;
    coachText: string;
  }> = [];
  const generate = vi.fn(async (_request: unknown): Promise<GenerateResult> => ({
    text: "Keep tomorrow easy, then reassess.",
    toolCalls: [],
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  }));
  const ids = ["continuation-1", "turn-1"];
  const engine = createCoachEngine({
    sport: {
      id: "cycling",
      soul: "",
      skills: {},
      sessionClusterGapMinutes: 30,
      memorySections: [],
      mustPreserveTokens: [],
      intervalsActivityTypes: [],
      athleteProfileSchema: {} as never,
      tools: () => [],
    } as Sport,
    ports: {
      ...ports,
      ...(language === undefined ? {} : { language }),
      transcriptWriter: {
        appendCompletedTurn: () => undefined,
        appendInterruptedTurn: (turn) => interrupted.push(turn),
      },
      randomId: () => ids.shift() ?? "unused",
      modelTransportDecorator: () => ({ generate }),
    },
  });
  return {
    engine,
    generate,
    store: ports.coachDecisions!,
    chatStore: ports.chatStore,
    interrupted,
  };
}

describe("coach decision lifecycle", () => {
  it.each(["chat-language", "plan:language"])(
    "resolves the saved athlete message when continuing %s and re-resolves on retry",
    async (chatId) => {
      let language: LanguageResolution = { language: "it", source: "preference", locale: "it-IT" };
      const resolveFor = vi.fn(async () => language);
      const { engine, generate, store } = setup({ resolveFor });
      store.appendDecisionRequested({
        turnId: "turn-decision",
        decision: makeDecision(chatId),
        toolCallId: "tool-1",
        athleteText: "Come recupero domani?",
        requestedAt: "1998-08-24T00:00:00.000Z",
      });
      expect(resolveFor).not.toHaveBeenCalled();
      generate.mockRejectedValueOnce(new Error("failed continuation"));
      await expect(
        engine.answerCoachDecision({
          chatId,
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "recovery" },
        }),
      ).rejects.toThrow("failed continuation");
      expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
        chatId,
        athleteText: "Come recupero domani?",
      });
      expect(generate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            system: expect.stringContaining("The athlete chose Italian (Italiano)."),
          }),
        }),
      );
      language = { language: "ja", source: "preference", locale: "ja-JP" };
      await engine.resumeCoachDecision({ chatId, decisionId: "decision-1" });
      expect(resolveFor).toHaveBeenCalledTimes(2);
      expect(resolveFor).toHaveBeenLastCalledWith({ chatId, athleteText: "Come recupero domani?" });
      expect(generate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            system: expect.stringContaining("The athlete chose Japanese (日本語)."),
          }),
        }),
      );
    },
  );

  it("resolves a custom decision answer as the latest actual athlete message", async () => {
    const resolveFor = vi.fn(async (): Promise<LanguageResolution> => ({
      language: "it",
      source: "message",
      locale: "it-IT",
    }));
    const { engine, store } = setup({ resolveFor });
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-custom-language"),
      toolCallId: "tool-1",
      athleteText: "What should I do tomorrow?",
      requestedAt: "1998-08-24T00:00:00.000Z",
    });
    await engine.answerCoachDecision({
      chatId: "chat-custom-language",
      decisionId: "decision-1",
      answer: { kind: "custom", text: "Vorrei riposare domani." },
    });
    expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
      chatId: "chat-custom-language",
      athleteText: "Vorrei riposare domani.",
    });
  });

  it("persists one continuation and returns it on an identical duplicate answer", async () => {
    const { engine, generate, store } = setup();
    const events: TurnEvent[] = [];
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-1"),
      toolCallId: "tool-1",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });

    const first = await engine.answerCoachDecision(
      {
        chatId: "chat-1",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "recovery" },
      },
      (event) => events.push(event),
    );
    const duplicate = await engine.answerCoachDecision({
      chatId: "chat-1",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
    });

    expect(first.decision).toEqual(duplicate.decision);
    expect(first.decision).toMatchObject({
      status: "answered",
      continuation: {
        status: "completed",
        turnId: "turn-1",
        coachText: "Keep tomorrow easy, then reassess.",
      },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "turn-start", turnId: "turn-1", chatId: "chat-1" },
      {
        type: "final-text",
        turnId: "turn-1",
        text: "Keep tomorrow easy, then reassess.",
      },
    ]);
    const continuationRequest = generate.mock.calls[0]![0] as {
      options?: { system?: string; tools?: unknown };
    };
    expect(continuationRequest.options?.tools).toBeUndefined();
    expect(continuationRequest.options?.system).toContain(
      "Otherwise ask the same choice as numbered text",
    );
  });

  it("skips without calling the model", async () => {
    const { engine, generate, store } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-2"),
      toolCallId: "tool-2",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });

    const result = await engine.skipCoachDecision({
      chatId: "chat-2",
      decisionId: "decision-1",
    });

    expect(result.decision.status).toBe("skipped");
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns durable Skip when structured session repair fails", async () => {
    const { engine, generate, store, chatStore } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-skip-failure"),
      toolCallId: "tool-skip-failure",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    vi.spyOn(chatStore, "persistDecisionContext").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const result = await engine.skipCoachDecision({
      chatId: "chat-skip-failure",
      decisionId: "decision-1",
    });

    expect(result.decision.status).toBe("skipped");
    expect(generate).not.toHaveBeenCalled();
  });

  it("repairs structured session context on resume without another provider call", async () => {
    const { engine, generate, store, chatStore } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-3"),
      toolCallId: "tool-3",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    const persist = chatStore.persistDecisionContext.bind(chatStore);
    vi.spyOn(chatStore, "persistDecisionContext")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      })
      .mockImplementation(persist);

    await engine.answerCoachDecision({
      chatId: "chat-3",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
    });
    await engine.resumeCoachDecision({ chatId: "chat-3", decisionId: "decision-1" });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(chatStore.load("chat-3").messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("emits turn-start before stored final text when resuming a completed continuation", async () => {
    const { engine, generate, store } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-5"),
      toolCallId: "tool-5",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    await engine.answerCoachDecision({
      chatId: "chat-5",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
    });
    const events: TurnEvent[] = [];

    await engine.resumeCoachDecision({ chatId: "chat-5", decisionId: "decision-1" }, (event) =>
      events.push(event),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "turn-start", turnId: "turn-1", chatId: "chat-5" },
      {
        type: "final-text",
        turnId: "turn-1",
        text: "Keep tomorrow easy, then reassess.",
      },
    ]);
  });

  it("rejects ordinary chat while a decision is unanswered", async () => {
    const { engine, generate, store } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-4"),
      toolCallId: "tool-4",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });

    await expect(engine.chat({ chatId: "chat-4", message: "another message" })).rejects.toThrow(
      "Answer or skip",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops only the active decision continuation and accepts its resumed next request", async () => {
    const { engine, generate, store, interrupted } = setup();
    let firstStarted = false;
    generate
      .mockImplementationOnce(async (request: unknown) => {
        const options = (
          request as {
            options: {
              signal?: AbortSignal;
              onTextDelta?: (delta: string) => void;
            };
          }
        ).options;
        firstStarted = true;
        options.onTextDelta?.("Partial decision response");
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce({
        text: "Recovered continuation.",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        },
      })
      .mockResolvedValueOnce({
        text: "Next chat response.",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        },
      });
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-stop-decision"),
      toolCallId: "tool-stop-decision",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    const events: TurnEvent[] = [];
    const answer = engine.answerCoachDecision(
      {
        chatId: "chat-stop-decision",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "recovery" },
      },
      (event) => events.push(event),
    );

    await vi.waitFor(() => expect(firstStarted).toBe(true));
    expect(engine.stopChat).toBeDefined();
    const stopChat = engine.stopChat!;
    await expect(stopChat({ chatId: "another-chat", turnId: "turn-1" })).resolves.toEqual({
      stopped: false,
    });
    await expect(stopChat({ chatId: "chat-stop-decision", turnId: "turn-1" })).resolves.toEqual({
      stopped: true,
    });
    await expect(answer).resolves.toMatchObject({
      decision: { status: "answered", continuation: { status: "pending" } },
    });
    expect(events.at(-1)).toMatchObject({
      type: "interrupted",
      chatId: "chat-stop-decision",
      text: "Partial decision response",
    });
    expect(interrupted).toContainEqual(
      expect.objectContaining({
        chatId: "chat-stop-decision",
        athleteText: "",
        coachText: "Partial decision response",
      }),
    );
    await expect(stopChat({ chatId: "chat-stop-decision", turnId: "turn-1" })).resolves.toEqual({
      stopped: false,
    });

    await expect(
      engine.resumeCoachDecision({
        chatId: "chat-stop-decision",
        decisionId: "decision-1",
      }),
    ).resolves.toMatchObject({
      decision: { continuation: { status: "completed", coachText: "Recovered continuation." } },
    });
    await expect(
      engine.chat({ chatId: "chat-stop-decision", message: "What comes next?" }),
    ).resolves.toMatchObject({ text: "Next chat response." });
  });

  it("rejects a Conversation reset while an answer continuation is pending", async () => {
    const { engine, store } = setup();
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: makeDecision("chat-reset"),
      toolCallId: "tool-reset",
      athleteText: "What should I do tomorrow?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    store.answerDecision({
      chatId: "chat-reset",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
      consequence: "Tomorrow becomes a recovery day.",
      continuationId: "continuation-reset",
      answeredAt: "2026-08-24T00:01:00.000Z",
    });

    await expect(engine.resetSession({ chatId: "chat-reset" })).rejects.toThrow(
      "Resume the active Coach decision",
    );
    expect(store.getDecision("chat-reset")).toMatchObject({
      status: "answered",
      continuation: { status: "pending" },
    });
  });
});
