import { describe, expect, it, vi } from "vitest";
import type { CoachClient, CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import type {
  CoachDecisionReadModel,
  CoachTurnEventNotificationEnvelope,
  TurnEvent,
} from "@enduragent/coach-contract";
import { createChatController } from "../src/chat/controller";
import { type ChatViewControls } from "../src/chat/controller-helpers";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import type { ChatState } from "../src/turn-state";

function unanswered(): Extract<CoachDecisionReadModel, { status: "unanswered" }> {
  return {
    decisionId: "decision-1",
    chatId: "desktop",
    messageId: "message-1",
    question: "Choose tomorrow’s priority.",
    status: "unanswered",
    options: [
      {
        id: "recovery",
        label: "Prioritize recovery",
        description: "Choose an easy day.",
        recommended: true,
        consequence: "Tomorrow becomes a recovery day.",
      },
      {
        id: "tempo",
        label: "Keep tempo",
        description: "Keep the planned workout.",
        recommended: false,
        consequence: "Tomorrow keeps tempo.",
      },
    ],
  };
}

function completed(): Extract<CoachDecisionReadModel, { status: "answered" }> {
  return {
    ...unanswered(),
    status: "answered",
    answer: { kind: "option", optionId: "recovery" },
    consequence: "Tomorrow becomes a recovery day.",
    continuation: {
      continuationId: "continuation-1",
      status: "completed",
      turnId: "turn-2",
      coachText: "We’ll keep tomorrow easy.",
    },
  };
}

function emit(
  options: TestCallOptions | undefined,
  requestMethod: "chat" | "resumeChatQueue" | "answerCoachDecision" | "resumeCoachDecision",
  event: TurnEvent,
  requestId: number,
): void {
  options?.onNotificationEnvelope?.({
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: { requestId, requestMethod, turnId: event.turnId, event },
  });
  options?.onEvent?.(event);
}

interface TestCallOptions {
  onNotificationEnvelope?: (envelope: CoachTurnEventNotificationEnvelope) => void;
  onEvent?: (event: TurnEvent) => void;
  onTerminalEnvelope?: (envelope: CoachClientTerminalEnvelope) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function subject(
  storedDecision: CoachDecisionReadModel | null = null,
  continuationOverride?: (
    method: "answerCoachDecision" | "resumeCoachDecision",
    options: TestCallOptions | undefined,
  ) => Promise<unknown>,
  decisionRead?:
    | Promise<CoachDecisionReadModel | null>
    | (() => Promise<CoachDecisionReadModel | null>),
) {
  const states: ChatState[] = [];
  const controls: ChatViewControls[] = [];
  let queueRevision = 0;
  let queued:
    | {
        queuedMessageId: string;
        submissionId: string;
        text: string;
        kind: "ordinary";
        position: number;
        restored: boolean;
      }
    | undefined;
  const call = vi.fn(async (method: string, request: unknown, options?: TestCallOptions) => {
    if (method === "enqueueChatMessage") {
      const input = request as { submissionId: string; text: string };
      queueRevision += 1;
      queued = {
        queuedMessageId: `queued-${queueRevision}`,
        submissionId: input.submissionId,
        text: input.text,
        kind: "ordinary",
        position: 0,
        restored: false,
      };
      return { schemaVersion: 1, revision: queueRevision, items: [queued] };
    }
    if (method === "getChatQueue") {
      return {
        schemaVersion: 1,
        revision: queueRevision,
        items: queued === undefined ? [] : [queued],
      };
    }
    if (method === "chat" || method === "resumeChatQueue") {
      const requestMethod = method;
      emit(options, requestMethod, { type: "turn-start", turnId: "turn-1", chatId: "desktop" }, 1);
      emit(
        options,
        requestMethod,
        { type: "decision-requested", turnId: "turn-1", chatId: "desktop", decision: unanswered() },
        1,
      );
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "decision-required", decision: unanswered() },
      });
      const response = { status: "decision-required" as const, decision: unanswered() };
      if (method === "chat") return response;
      queueRevision += 1;
      queued = undefined;
      return {
        snapshot: { schemaVersion: 1, revision: queueRevision, items: [] },
        response,
      };
    }
    if (method === "answerCoachDecision" || method === "resumeCoachDecision") {
      if (continuationOverride !== undefined) return continuationOverride(method, options);
      emit(options, method, { type: "turn-start", turnId: "turn-2", chatId: "desktop" }, 2);
      emit(
        options,
        method,
        { type: "final-text", turnId: "turn-2", text: "We’ll keep tomorrow easy." },
        2,
      );
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { decision: completed() } });
      return { decision: completed() };
    }
    if (method === "skipCoachDecision") {
      const decision = { ...unanswered(), status: "skipped" as const };
      return { decision };
    }
    if (method === "getCoachDecision") {
      return {
        decision:
          decisionRead === undefined
            ? storedDecision
            : await (typeof decisionRead === "function" ? decisionRead() : decisionRead),
      };
    }
    if (method === "stopChat") return { stopped: true };
    if (method === "hasSession") return { hasSession: false };
    throw new TypeError(method);
  });
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call: call as unknown as CoachClient["call"],
    close: vi.fn(async () => {}),
  };
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    onConnectionOpen: () => () => {},
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: {
      render(state, next) {
        states.push(structuredClone(state));
        if (next !== undefined) controls.push(structuredClone(next));
      },
    },
    refreshTrainingContext: async () => {},
    refreshSpend: async () => {},
    initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
  });
  const submittedController = {
    ...controller,
    async submit(message: string): Promise<boolean> {
      const acknowledged = await controller.submit(message);
      if (acknowledged) {
        await vi.waitFor(() => expect(states.at(-1)?.status).not.toBe("streaming"));
      }
      return acknowledged;
    },
  };
  return { controller: submittedController, call, states, controls };
}

describe("Coach decision controller", () => {
  it("presents the host decision without leaving an empty Coach row", async () => {
    const { controller, states, controls } = subject();
    await controller.submit("What should I do tomorrow?");

    expect(controls.at(-1)?.decision?.value).toMatchObject({
      decisionId: "decision-1",
      status: "unanswered",
    });
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "What should I do tomorrow?" },
    ]);
  });

  it("opens New chat while preserving an unanswered decision", async () => {
    const { controller, states, controls } = subject();
    await controller.submit("What should I do tomorrow?");
    const decision = controls.at(-1)?.decision?.value;

    expect(controller.openNewConversation()).toBe(true);
    expect(states.at(-1)?.session.resetPhase).toBe("confirming");
    expect(controls.at(-1)?.decision?.value).toEqual(decision);
  });

  it("continues a selected answer without creating a second athlete message", async () => {
    const { controller, states, controls } = subject();
    await controller.submit("What should I do tomorrow?");
    await controller.answerDecision("decision-1", { kind: "option", optionId: "recovery" });

    expect(states.at(-1)?.messages.map((message) => message.role)).toEqual(["athlete", "coach"]);
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "We’ll keep tomorrow easy.",
      delivery: "complete",
    });
    expect(controls.at(-1)?.decision?.value).toMatchObject({
      status: "answered",
      continuation: { status: "completed", turnId: "turn-2" },
    });
  });

  it("keeps the question open with the cap message when an enforced cap refuses the answer", async () => {
    const refusal = { kind: "spend-cap-reached", dailyCapUsd: 0.5, knownSpendUsd: 0.62 } as const;
    const { controller, states, controls } = subject(null, async (_method, options) => {
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 2,
        result: { decision: unanswered(), refusal },
      });
      return { decision: unanswered(), refusal };
    });
    await controller.submit("What should I do tomorrow?");
    await controller.answerDecision("decision-1", { kind: "option", optionId: "recovery" });

    expect(controls.at(-1)?.decision).toMatchObject({
      value: { status: "unanswered", decisionId: "decision-1" },
      phase: "idle",
      error:
        "Today’s model spend has reached your $0.50 daily cap, so the coach didn’t answer. To keep going today, raise the cap or switch it to Warn in Settings › Spending.",
    });
    expect(states.at(-1)?.messages.map((message) => message.role)).toEqual(["athlete"]);
  });

  it("skips without starting a continuation", async () => {
    const { controller, call, states, controls } = subject();
    await controller.submit("What should I do tomorrow?");
    await controller.skipDecision("decision-1");

    expect(
      call.mock.calls.filter(
        ([method]) => method === "answerCoachDecision" || method === "resumeCoachDecision",
      ),
    ).toHaveLength(0);
    expect(states.at(-1)?.messages.map((message) => message.role)).toEqual(["athlete"]);
    expect(controls.at(-1)?.decision?.value).toMatchObject({ status: "skipped" });
  });

  it("resumes one pending saved continuation on relaunch", async () => {
    const pending: CoachDecisionReadModel = {
      ...unanswered(),
      status: "answered",
      answer: { kind: "option", optionId: "recovery" },
      consequence: "Tomorrow becomes a recovery day.",
      continuation: { continuationId: "continuation-1", status: "pending" },
    };
    const { controller, call, states } = subject(pending);
    await controller.start();
    await vi.waitFor(() => {
      expect(call.mock.calls.filter(([method]) => method === "resumeCoachDecision")).toHaveLength(
        1,
      );
      expect(states.at(-1)?.messages.at(-1)).toMatchObject({
        role: "coach",
        text: "We’ll keep tomorrow easy.",
        delivery: "complete",
      });
    });
  });

  it("keeps New chat blocked while a saved continuation is resuming", async () => {
    const pending: Extract<CoachDecisionReadModel, { status: "answered" }> = {
      ...unanswered(),
      status: "answered",
      answer: { kind: "option", optionId: "recovery" },
      consequence: "Tomorrow becomes a recovery day.",
      continuation: { continuationId: "continuation-1", status: "pending" },
    };
    const release = deferred<void>();
    const { controller, call } = subject(pending, async (method, options) => {
      emit(options, method, { type: "turn-start", turnId: "turn-2", chatId: "desktop" }, 2);
      await release.promise;
      const decision = completed();
      if (decision.continuation.status !== "completed") {
        throw new Error("completed fixture required");
      }
      emit(
        options,
        method,
        { type: "final-text", turnId: "turn-2", text: decision.continuation.coachText },
        2,
      );
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { decision } });
      return { decision };
    });

    const starting = controller.start();
    await vi.waitFor(() => {
      expect(call.mock.calls.filter(([method]) => method === "resumeCoachDecision")).toHaveLength(
        1,
      );
    });
    expect(controller.openNewConversation()).toBe(false);
    release.resolve();
    await starting;
  });

  it("stops a decision continuation and resumes it with the same client", async () => {
    const pending: Extract<CoachDecisionReadModel, { status: "answered" }> = {
      ...unanswered(),
      status: "answered",
      answer: { kind: "option", optionId: "recovery" },
      consequence: "Tomorrow becomes a recovery day.",
      continuation: { continuationId: "continuation-1", status: "pending" },
    };
    const stopped = deferred<void>();
    let attempt = 0;
    const { controller, call, states } = subject(pending, async (method, options) => {
      attempt += 1;
      emit(
        options,
        method,
        { type: "turn-start", turnId: `turn-${attempt + 1}`, chatId: "desktop" },
        10 + attempt,
      );
      if (attempt === 1) {
        emit(options, method, { type: "text_delta", turnId: "turn-2", delta: "Partial" }, 11);
        await stopped.promise;
        emit(
          options,
          method,
          { type: "interrupted", turnId: "turn-2", chatId: "desktop", text: "Partial" },
          11,
        );
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 11, result: { decision: pending } });
        return { decision: pending };
      }
      const source = completed();
      if (source.continuation.status !== "completed") throw new Error("completed fixture required");
      const resumed = {
        ...source,
        continuation: { ...source.continuation, turnId: "turn-3" },
      } satisfies CoachDecisionReadModel;
      emit(
        options,
        method,
        {
          type: "final-text",
          turnId: "turn-3",
          text: resumed.continuation.status === "completed" ? resumed.continuation.coachText : "",
        },
        12,
      );
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 12, result: { decision: resumed } });
      return { decision: resumed };
    });
    await controller.submit("What should I do tomorrow?");
    const answer = controller.answerDecision("decision-1", {
      kind: "option",
      optionId: "recovery",
    });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("streaming"));
    controller.stop();
    await vi.waitFor(() =>
      expect(call.mock.calls.some(([method]) => method === "stopChat")).toBe(true),
    );
    expect(call.mock.calls.find(([method]) => method === "stopChat")?.[1]).toEqual({
      chatId: "desktop",
      turnId: "turn-2",
    });
    stopped.resolve();
    await answer;

    expect(states.at(-1)?.status).toBe("interrupted");
    await controller.retryDecision();
    expect(call.mock.calls.filter(([method]) => method === "resumeCoachDecision")).toHaveLength(1);
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({ text: "We’ll keep tomorrow easy." });
  });

  it("keeps Chat blocked after decision hydration fails and recovers through reconnect", async () => {
    const decisionRead = vi
      .fn<() => Promise<CoachDecisionReadModel | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null);
    const { controller, call, controls } = subject(null, undefined, decisionRead);
    await controller.start();
    expect(controls.at(-1)?.decisionLoadError).toContain("saved Coach question");
    await controller.submit("Blocked while unknown");
    expect(call.mock.calls.filter(([method]) => method === "resumeChatQueue")).toHaveLength(0);

    await controller.retryDecision();
    expect(controls.at(-1)?.decisionLoading).toBe(false);
    expect(controls.at(-1)?.decisionLoadError).toBeNull();
    await controller.submit("Now available");
    expect(call.mock.calls.filter(([method]) => method === "resumeChatQueue")).toHaveLength(1);
  });

  it("restores a committed continuation after the transport fails before its terminal result", async () => {
    const { controller, states, controls } = subject(completed(), async (method, options) => {
      emit(options, method, { type: "turn-start", turnId: "turn-2", chatId: "desktop" }, 2);
      emit(
        options,
        method,
        { type: "final-text", turnId: "turn-2", text: "We’ll keep tomorrow easy." },
        2,
      );
      throw new Error("connection closed after commit");
    });
    await controller.submit("What should I do tomorrow?");

    await controller.answerDecision("decision-1", {
      kind: "option",
      optionId: "recovery",
    });

    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      turnId: "turn-2",
      text: "We’ll keep tomorrow easy.",
      delivery: "complete",
    });
    expect(controls.at(-1)?.decision).toMatchObject({
      value: { status: "answered", continuation: { status: "completed" } },
      phase: "idle",
      error: null,
    });
  });

  it("blocks normal Chat Send until the persisted decision read completes", async () => {
    const decisionRead = deferred<CoachDecisionReadModel | null>();
    const { controller, call, controls } = subject(null, undefined, decisionRead.promise);

    void controller.start();
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(true));
    await controller.submit("Send too early");
    expect(call.mock.calls.filter(([method]) => method === "resumeChatQueue")).toHaveLength(0);

    decisionRead.resolve(null);
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(false));
    await controller.submit("Send after recovery check");
    expect(call.mock.calls.filter(([method]) => method === "resumeChatQueue")).toHaveLength(1);
  });
});
