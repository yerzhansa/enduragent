import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerReadModel,
  ChatQueueRunResult,
  CoachDecisionReadModel,
  CoachTurnEventNotificationEnvelope,
  ListPlansResult,
  PlanChangeModel,
  PlanCreationCardModel,
  PlanningRequestDelivery,
  QueuedChatMessage,
  TurnEvent,
} from "@enduragent/coach-contract";
import { createChatController } from "../src/chat/controller";
import {
  CHAT_DRAFT_SAVE_FAILURE_COPY,
  type ChatViewControls,
} from "../src/chat/controller-helpers";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { EMPTY_PLAN_CHANGE_SURFACE, type PlanChangeSurfaceState } from "../src/state/chat-slice";
import type { ChatState } from "../src/turn-state";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function deliver(
  method:
    | "chat"
    | "resumeChatQueue"
    | "runQueuedCommand"
    | "retryQueuedTurn"
    | "answerCoachDecision",
  options: CoachClientCallOptions<"chat"> | undefined,
  event: TurnEvent,
  requestId = 1,
): void {
  const envelope: CoachTurnEventNotificationEnvelope = {
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: { requestId, requestMethod: method, turnId: event.turnId, event },
  };
  options?.onNotificationEnvelope?.(envelope);
  options?.onEvent?.(event);
}

function queueItem(
  id: string,
  text: string,
  position: number,
  options?: { readonly kind?: "ordinary" | "slash-command"; readonly restored?: boolean },
): QueuedChatMessage {
  return {
    queuedMessageId: id,
    messageId: `message-${id}`,
    submissionId: `submission-${id}`,
    text,
    kind: options?.kind ?? "ordinary",
    attachmentIds: [],
    position,
    restored: options?.restored ?? false,
  };
}

function emptyComposer(): ChatAttachmentComposerReadModel {
  return {
    schemaVersion: 1,
    capabilities: {
      schemaVersion: 1,
      active: { provider: "test", model: "text-only", transport: "test" },
      documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
      completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
      plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
      images: {
        enabled: false,
        mediaTypes: [],
        reason: "model_incompatible",
        source: "maintained_catalogue",
        checkedAt: "1998-08-24T08:00:00.000Z",
      },
    },
    draft: null,
  };
}

function unansweredDecision(): Extract<CoachDecisionReadModel, { status: "unanswered" }> {
  return {
    decisionId: "decision-1",
    chatId: "desktop",
    messageId: "message-1",
    question: "Choose tomorrow's priority.",
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

function completedDecision(): Extract<CoachDecisionReadModel, { status: "answered" }> {
  return {
    ...unansweredDecision(),
    status: "answered",
    answer: { kind: "option", optionId: "recovery" },
    consequence: "Tomorrow becomes a recovery day.",
    continuation: {
      continuationId: "continuation-1",
      status: "completed",
      turnId: "turn-2",
      coachText: "We will keep tomorrow easy.",
    },
  };
}

function makeProvider(
  client: CoachClient,
  reconnectImpl?: () => Promise<CoachClient>,
): DesktopCoachClientProvider {
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(reconnectImpl ?? (async () => client)),
    onConnectionOpen: () => () => undefined,
    close: vi.fn(async () => undefined),
  };
}

function planCreationCard(overrides?: Partial<PlanCreationCardModel>): PlanCreationCardModel {
  return {
    creationId: "creation-1",
    version: 2,
    status: "in-progress",
    readiness: "ready",
    calendarWindow: null,
    answeredSummaries: [],
    openQuestion: {
      kind: "goal-question",
      step: { current: 1, total: 9 },
      prompt: "What is your main goal?",
      candidates: [],
      eventNotListedOption: {
        label: "Event not listed",
        detail: "Tell me the event name and its exact date.",
        placeholder: "Event name",
        nameLabel: "Event name",
        dateLabel: "Event date",
      },
      fitnessOption: {
        label: "Improve without an event",
        detail: "Build fitness.",
      },
    },
    pendingCommitment: null,
    pendingCheck: null,
    draft: planCreationDraft(),
    draftStale: false,
    ...overrides,
  };
}

function activePlanLibrary(changes: PlanChangeModel[] = []): ListPlansResult {
  return {
    calendarConnected: false,
    legacy: null,
    active: {
      supportingEventCandidates: [],
      planId: "plan-active",
      version: 7,
      name: "Build fitness",
      start: "1998-09-07",
      end: "1998-10-04",
      weeks: 4,
      status: "active",
      closeReason: null,
      closedAt: null,
      activatedAt: "1998-09-07",
      todayChoice: null,
      calendar: { status: "pending", window: null, currentThrough: null, error: null },
      creationId: null,
    },
    creation: null,
    closed: [],
    pendingChangeCheck: null,
    changesPaused: null,
    changes,
  };
}

describe("BUG-02 & BUG-03: unified drain scheduling", () => {
  it("drains waiting queued messages after a turn fails without retryRequired", async () => {
    const firstRun = deferred<ChatQueueRunResult>();
    let firstOptions: CoachClientCallOptions<"chat"> | undefined;
    let resumeCount = 0;
    const first = queueItem("queued-1", "First", 0);
    const second = queueItem("queued-2", "Second", 1);
    let enqueueCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          return Promise.resolve({ deliveries: [], planCreation: null }) as never;
        }
        if (method === "getChatQueue") {
          return Promise.resolve(
            resumeCount === 0
              ? { schemaVersion: 1, revision: 0, items: [] }
              : { schemaVersion: 1, revision: 3, items: [{ ...second, position: 0 }] },
          ) as never;
        }
        if (method === "enqueueChatMessage") {
          enqueueCount += 1;
          return Promise.resolve(
            enqueueCount === 1
              ? { schemaVersion: 1, revision: 1, items: [first] }
              : { schemaVersion: 1, revision: 2, items: [first, second] },
          ) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          const runOptions = options as CoachClientCallOptions<"chat">;
          if (resumeCount === 1) {
            firstOptions = runOptions;
            return firstRun.promise as never;
          }
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Second reply",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 4, items: [] },
            response: { text: "Second reply" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });
    await controller.start();

    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(firstOptions).toBeDefined());
    deliver("resumeChatQueue", firstOptions, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    await expect(controller.submit("Second")).resolves.toBe(true);

    firstRun.reject(new Error("provider failure"));

    await vi.waitFor(() => expect(resumeCount).toBe(2));
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages).toContainEqual(
      expect.objectContaining({ role: "coach", text: "Second reply", delivery: "complete" }),
    );
    controller.dispose();
  });

  it("does not loop infinitely when a failed queued head remains unclaimed at index 0", async () => {
    const first = queueItem("queued-1", "Stuck head", 0);
    let resumeCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          return Promise.resolve({ deliveries: [], planCreation: null }) as never;
        }
        if (method === "getChatQueue") {
          return Promise.resolve(
            resumeCount === 0
              ? { schemaVersion: 1, revision: 0, items: [] }
              : { schemaVersion: 1, revision: 2, items: [first] },
          ) as never;
        }
        if (method === "enqueueChatMessage") {
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [first] }) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          return Promise.reject(new Error("persistent server fault")) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });
    await controller.start();
    await expect(controller.submit("Stuck head")).resolves.toBe(true);
    await vi.waitFor(() => expect(resumeCount).toBe(1));
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resumeCount).toBe(1);
    controller.dispose();
  });

  it("drains an exposed ordinary message after removeQueued removes a restored slash command", async () => {
    const restoredCommand = queueItem("cmd-1", "/review", 0, {
      kind: "slash-command",
      restored: true,
    });
    const ordinary = queueItem("queued-2", "Follow up", 1);
    let resumeCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          return Promise.resolve({ deliveries: [], planCreation: null }) as never;
        }
        if (method === "getChatQueue") {
          return Promise.resolve({
            schemaVersion: 1,
            revision: 1,
            items: [restoredCommand, ordinary],
          }) as never;
        }
        if (method === "removeQueuedChatMessage") {
          return Promise.resolve({
            schemaVersion: 1,
            revision: 2,
            items: [{ ...ordinary, position: 0 }],
          }) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Drained after remove",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 3, items: [] },
            response: { text: "Drained after remove" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });
    await controller.start();
    expect(resumeCount).toBe(0);

    controller.removeQueued("cmd-1");

    await vi.waitFor(() => expect(resumeCount).toBe(1));
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.messages).toContainEqual(
      expect.objectContaining({
        role: "coach",
        text: "Drained after remove",
        delivery: "complete",
      }),
    );
    controller.dispose();
  });

  it("drains ordinary queued work after cancelNewConversation unblocks chat", async () => {
    const ordinary = queueItem("queued-1", "Waiting message", 0);
    let resumeCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-1",
            text: "Drained after cancel",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 2, items: [] },
            response: { text: "Drained after cancel" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 1, items: [ordinary] },
    });

    expect(controller.openNewConversation()).toBe(true);
    expect(resumeCount).toBe(0);

    controller.cancelNewConversation();

    await vi.waitFor(() => expect(resumeCount).toBe(1));
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.messages).toContainEqual(
      expect.objectContaining({
        role: "coach",
        text: "Drained after cancel",
        delivery: "complete",
      }),
    );
    controller.dispose();
  });

  it("drains ordinary queued work after reset-failed transitions resetPhase to uncertain", async () => {
    const ordinary = queueItem("queued-1", "Waiting after failed reset", 0);
    let resumeCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "resetSession") {
          return Promise.reject(new Error("reset timed out")) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-1",
            text: "Drained after reset failure",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 2, items: [] },
            response: { text: "Drained after reset failure" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 1, items: [ordinary] },
    });

    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();

    expect(states.at(-1)?.session.resetPhase).toBe("uncertain");
    await vi.waitFor(() => expect(resumeCount).toBe(1));
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.messages).toContainEqual(
      expect.objectContaining({
        role: "coach",
        text: "Drained after reset failure",
        delivery: "complete",
      }),
    );
    controller.dispose();
  });
});

describe("BUG-11: draftError clears on submit success", () => {
  it("clears draftError when submit succeeds after an earlier draft save failure", async () => {
    const first = queueItem("queued-1", "Send me anyway", 0);
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "saveChatAttachmentDraftText") {
          return Promise.reject(new Error("offline while typing")) as never;
        }
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "enqueueChatMessage") {
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [first] }) as never;
        }
        if (method === "resumeChatQueue") {
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-1",
            text: "Received",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 2, items: [] },
            response: { text: "Received" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(_state, next) {
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });

    controller.saveAttachmentDraftText("Send me anyway");
    await vi.waitFor(() =>
      expect(controls.at(-1)?.attachments?.draftError).toBe(CHAT_DRAFT_SAVE_FAILURE_COPY),
    );

    await expect(controller.submit("Send me anyway")).resolves.toBe(true);
    expect(controls.at(-1)?.attachments?.draftError).toBeNull();
    controller.dispose();
  });
});

describe("BUG-12: decision streaming guard and action lock", () => {
  it("guards answerDecision while the decision-requesting turn is still streaming so decisionPhase never strands", async () => {
    const firstTurn = deferred<ChatQueueRunResult>();
    let firstOptions: CoachClientCallOptions<"chat"> | undefined;
    const item = queueItem("queued-1", "What should I do tomorrow?", 0);
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "enqueueChatMessage") {
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [item] }) as never;
        }
        if (method === "resumeChatQueue") {
          firstOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", firstOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", firstOptions, {
            type: "decision-requested",
            turnId: "turn-1",
            chatId: "desktop",
            decision: unansweredDecision(),
          });
          return firstTurn.promise as never;
        }
        if (method === "answerCoachDecision") {
          const answerOptions = options as CoachClientCallOptions<"chat">;
          deliver(
            "answerCoachDecision",
            answerOptions,
            {
              type: "turn-start",
              turnId: "turn-2",
              chatId: "desktop",
            },
            2,
          );
          deliver(
            "answerCoachDecision",
            answerOptions,
            {
              type: "final-text",
              turnId: "turn-2",
              text: "We will keep tomorrow easy.",
            },
            2,
          );
          answerOptions.onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 2,
            result: { decision: completedDecision() },
          });
          return Promise.resolve({ decision: completedDecision() }) as never;
        }
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state, next) {
          states.push(structuredClone(state));
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });

    await expect(controller.submit("What should I do tomorrow?")).resolves.toBe(true);
    await vi.waitFor(() => expect(controls.at(-1)?.decision?.value?.decisionId).toBe("decision-1"));
    expect(states.at(-1)?.status).toBe("streaming");

    await controller.answerDecision("decision-1", { kind: "option", optionId: "recovery" });

    expect(controls.at(-1)?.decision?.phase).toBe("idle");
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "answerCoachDecision"),
    ).toHaveLength(0);

    firstOptions?.onTerminalEnvelope?.({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "decision-required", decision: unansweredDecision() },
    });
    firstTurn.resolve({
      snapshot: { schemaVersion: 1, revision: 2, items: [] },
      response: { text: "" },
    });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));

    await controller.answerDecision("decision-1", { kind: "option", optionId: "recovery" });
    expect(controls.at(-1)?.decision?.phase).toBe("idle");
    expect(controls.at(-1)?.decision?.value?.status).toBe("answered");
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "We will keep tomorrow easy.",
      delivery: "complete",
    });
    controller.dispose();
  });

  it("serializes skipDecision and answerDecision behind one in-flight lock so they cannot race", async () => {
    const skipGate = deferred<{ readonly decision: CoachDecisionReadModel }>();
    const item = queueItem("queued-1", "What should I do tomorrow?", 0);
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "enqueueChatMessage") {
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [item] }) as never;
        }
        if (method === "resumeChatQueue") {
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "decision-requested",
            turnId: "turn-1",
            chatId: "desktop",
            decision: unansweredDecision(),
          });
          runOptions.onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "decision-required", decision: unansweredDecision() },
          });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 2, items: [] },
            response: { text: "" },
          }) as never;
        }
        if (method === "skipCoachDecision") return skipGate.promise as never;
        if (method === "answerCoachDecision") {
          throw new Error("answerCoachDecision must not run while skipDecision is in flight");
        }
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state, next) {
          states.push(structuredClone(state));
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });

    await expect(controller.submit("What should I do tomorrow?")).resolves.toBe(true);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));

    const firstSkip = controller.skipDecision("decision-1");
    const secondSkip = controller.skipDecision("decision-1");
    const racingAnswer = controller.answerDecision("decision-1", {
      kind: "option",
      optionId: "recovery",
    });

    skipGate.resolve({ decision: { ...unansweredDecision(), status: "skipped" } });
    await Promise.all([firstSkip, secondSkip, racingAnswer]);

    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "skipCoachDecision"),
    ).toHaveLength(1);
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "answerCoachDecision"),
    ).toHaveLength(0);
    expect(controls.at(-1)?.decision?.value?.status).toBe("skipped");
    controller.dispose();
  });
});

describe("BUG-14: boot probe recovery without duplicating succeeded probes", () => {
  it("retries only failed boot probes on subsequent start/resume and skips already-succeeded probes", async () => {
    const counts = {
      decision: 0,
      queue: 0,
      hasSession: 0,
      attachments: 0,
      hydration: 0,
      resumePlanning: 0,
      listPlanning: 0,
    };
    const delivery: PlanningRequestDelivery = {
      requestId: "plan-req-1",
      source: {
        kind: "workout_review",
        intent: "Review Tempo in Plan.",
        chatId: "desktop",
        messageId: "msg-1",
        attachmentId: "att-1",
      },
      state: "delivered",
      attemptCount: 1,
      failureCode: null,
      retryable: false,
      createdAtMs: 903_945_600_000,
      updatedAtMs: 903_945_601_000,
      deliveredAtMs: 903_945_601_000,
      planningRequest: null,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        if (method === "getCoachDecision") {
          counts.decision += 1;
          return { decision: null } as never;
        }
        if (method === "getChatQueue") {
          counts.queue += 1;
          return { schemaVersion: 1, revision: 0, items: [] } as never;
        }
        if (method === "hasSession") {
          counts.hasSession += 1;
          if (counts.hasSession === 1) throw new Error("session probe offline");
          return { hasSession: true } as never;
        }
        if (method === "getChatAttachmentComposer") {
          counts.attachments += 1;
          if (counts.attachments === 1) throw new Error("attachments offline");
          return emptyComposer() as never;
        }
        if (method === "resumePlanningRequests") {
          counts.resumePlanning += 1;
          if (counts.resumePlanning === 1) throw new Error("planning offline");
          return { deliveries: [delivery] } as never;
        }
        if (method === "listPlanningRequests") {
          counts.listPlanning += 1;
          if (counts.listPlanning === 1) throw new Error("planning offline");
          return { deliveries: [delivery], planCreation: null } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const readTranscriptPage = vi.fn(async () => {
      counts.hydration += 1;
      if (counts.hydration === 1) throw new Error("hydration offline");
      return {
        schemaVersion: 1 as const,
        status: "page" as const,
        turns: [
          {
            turnId: "turn-hist-1",
            completedAt: "1998-08-24T08:00:00.000Z",
            athleteText: "Earlier message",
            coachText: "Earlier reply",
          },
        ],
        nextCursor: null,
      };
    });
    const states: ChatState[] = [];
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state, next) {
          states.push(structuredClone(state));
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      readTranscriptPage,
    });

    await controller.start();
    expect(states.at(-1)?.session.presence).toBe("unknown");
    expect(controls.at(-1)?.hydration?.status).toBe("failed");
    expect(controls.at(-1)?.attachments?.value).toBeNull();
    expect(controls.at(-1)?.planningRequests?.loaded).toBe(false);

    await controller.resume();

    expect(counts.decision).toBe(1);
    expect(counts.queue).toBe(1);
    expect(counts.hasSession).toBe(2);
    expect(counts.attachments).toBe(2);
    expect(counts.hydration).toBe(2);
    expect(counts.resumePlanning).toBe(2);
    expect(states.at(-1)?.session.presence).toBe("present");
    expect(controls.at(-1)?.hydration?.status).toBe("ready");
    expect(controls.at(-1)?.attachments?.value).toEqual(emptyComposer());
    expect(controls.at(-1)?.planningRequests?.loaded).toBe(true);
    expect(controls.at(-1)?.planningRequests?.value).toEqual([delivery]);

    await controller.start();
    expect(counts.hasSession).toBe(2);
    expect(counts.attachments).toBe(2);
    expect(counts.hydration).toBe(2);
    expect(counts.resumePlanning).toBe(2);
    controller.dispose();
  });

  it("recovers all failed boot probes on retryDecision without duplicating already-succeeded probes", async () => {
    let attempt = 0;
    const calls: string[] = [];
    let hydrationReads = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        calls.push(String(method));
        if (method === "getCoachDecision") {
          if (attempt === 0) throw new Error("offline");
          return { decision: null } as never;
        }
        if (method === "getChatQueue") {
          if (attempt === 0) throw new Error("offline");
          return { schemaVersion: 1, revision: 0, items: [] } as never;
        }
        if (method === "hasSession") {
          if (attempt === 0) throw new Error("offline");
          return { hasSession: true } as never;
        }
        if (method === "getChatAttachmentComposer") {
          if (attempt === 0) throw new Error("offline");
          return emptyComposer() as never;
        }
        if (method === "resumePlanningRequests") {
          return { deliveries: [] } as never;
        }
        if (method === "listPlanningRequests") {
          return { deliveries: [], planCreation: null } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const readTranscriptPage = vi.fn(async () => {
      hydrationReads += 1;
      if (attempt === 0) throw new Error("offline");
      return {
        schemaVersion: 1 as const,
        status: "page" as const,
        turns: [],
        nextCursor: null,
      };
    });
    const states: ChatState[] = [];
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client, async () => {
        attempt += 1;
        return client;
      }),
      view: {
        render(state, next) {
          states.push(structuredClone(state));
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      readTranscriptPage,
    });

    await controller.start();
    expect(states.at(-1)?.session.presence).toBe("unknown");
    expect(controls.at(-1)?.hydration?.status).toBe("failed");
    expect(controls.at(-1)?.attachments?.value).toBeNull();
    expect(controls.at(-1)?.planningRequests?.loaded).toBe(true);

    calls.length = 0;
    await controller.retryDecision();

    expect(states.at(-1)?.session.presence).toBe("present");
    expect(controls.at(-1)?.hydration?.status).toBe("ready");
    expect(controls.at(-1)?.attachments?.value).toEqual(emptyComposer());
    expect(controls.at(-1)?.decisionLoadError).toBeNull();
    expect(controls.at(-1)?.queueLoadError).toBeNull();
    expect(hydrationReads).toBe(2);
    expect(calls).toContain("hasSession");
    expect(calls).toContain("getChatAttachmentComposer");
    expect(calls).not.toContain("resumePlanningRequests");
    expect(calls).not.toContain("listPlanningRequests");
    controller.dispose();
  });
});

describe("BUG-15: ghost bubble, preview epoch stomp, and Plan Creation disposed guards", () => {
  it("validates Plan Change text length before appending an athlete bubble or clearing draft", async () => {
    let surface: PlanChangeSurfaceState = EMPTY_PLAN_CHANGE_SURFACE;
    const library = activePlanLibrary();
    const call = vi.fn(async () => emptyComposer() as never);
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call,
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(state) {
          states.push(structuredClone(state));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
      readPlanLibrary: () => library,
      readPlanChange: () => surface,
      publishPlanChange: (next) => {
        surface = next;
      },
    });

    controller.openPlanChangeEditor();
    const tooLong = "x".repeat(2001);
    await expect(controller.submit(tooLong)).resolves.toBe(false);

    expect(states.at(-1)?.messages).toEqual([]);
    expect(surface.error).toBe("Keep your change request to 2000 characters or fewer.");
    expect(surface.busy).toBe(false);
    expect(call).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not stomp a newer preview's busy state when a stale preview from an earlier epoch settles", async () => {
    let surface: PlanChangeSurfaceState = EMPTY_PLAN_CHANGE_SURFACE;
    const library = activePlanLibrary();
    const firstStale = deferred<never>();
    const secondPreview = deferred<never>();
    let previewCalls = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "plan_change.preview") {
          previewCalls += 1;
          return previewCalls === 1 ? firstStale.promise : secondPreview.promise;
        }
        if (method === "resetSession") return Promise.resolve({ memoryFlushed: true }) as never;
        if (method === "clearChatAttachmentDraft") return Promise.resolve(emptyComposer()) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const controller = createChatController({
      clients: makeProvider(client),
      view: { render: vi.fn() },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: {
        schemaVersion: 1,
        revision: 1,
        items: [queueItem("cmd-1", "/review", 0, { kind: "slash-command", restored: true })],
      },
      readPlanLibrary: () => library,
      readPlanChange: () => surface,
      publishPlanChange: (next) => {
        surface = next;
      },
      refreshPlanLibrary: async () => undefined,
    });

    controller.openPlanChangeEditor();
    const stalePreview = controller.previewPlanChange({ kind: "ftp", watts: 250 });
    await vi.waitFor(() => expect(previewCalls).toBe(1));
    expect(surface.busy).toBe(true);

    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();
    expect(surface.busy).toBe(false);

    controller.openPlanChangeEditor();
    const freshPreview = controller.previewPlanChange({ kind: "ftp", watts: 260 });
    await vi.waitFor(() => expect(previewCalls).toBe(2));
    expect(surface.busy).toBe(true);

    firstStale.reject(new Error("stale failure"));
    await stalePreview;

    expect(surface.busy).toBe(true);

    secondPreview.reject(new Error("cleanup"));
    await freshPreview;
    controller.dispose();
  });

  it("ignores Plan Creation RPC completions after dispose without triggering side effects", async () => {
    const discardGate = deferred<{ readonly status: "discarded" }>();
    const activateGate = deferred<Record<string, never>>();
    const previewGate = deferred<{
      readonly status: "rejected";
      readonly reason: "commitments-pending";
      readonly explanation: string;
      readonly planCreation: PlanCreationCardModel;
    }>();
    const openChat = vi.fn();
    const refreshPlan = vi.fn(async () => undefined);
    const refreshPlanLibrary = vi.fn(async () => undefined);
    let listPlanningCalls = 0;
    const card = planCreationCard();
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        }
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          listPlanningCalls += 1;
          return Promise.resolve({ deliveries: [], planCreation: card }) as never;
        }
        if (method === "plan_creation.discard") return discardGate.promise as never;
        if (method === "plan_creation.preview") return previewGate.promise as never;
        if (method === "getPlanState") {
          return Promise.resolve({ status: "ready", state: { lifecycle: "none" } }) as never;
        }
        if (method === "plan_creation.activate") return activateGate.promise as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };

    const render1 = vi.fn();
    const c1 = createChatController({
      clients: makeProvider(client),
      view: { render: render1 },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      openChat,
      refreshPlan,
      refreshPlanLibrary,
      readPlanLibrary: () => activePlanLibrary(),
    });
    await c1.start();
    c1.openPlanCreationDiscard();
    const discarding = c1.confirmPlanCreationDiscard();
    await vi.waitFor(() =>
      expect(
        vi.mocked(client.call).mock.calls.some(([method]) => method === "plan_creation.discard"),
      ).toBe(true),
    );
    c1.dispose();
    const rendersAtDispose1 = render1.mock.calls.length;
    discardGate.resolve({ status: "discarded" });
    await discarding;
    expect(openChat).not.toHaveBeenCalled();
    expect(render1.mock.calls.length).toBe(rendersAtDispose1);

    const c2 = createChatController({
      clients: makeProvider(client),
      view: { render: vi.fn() },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      openChat,
      refreshPlan,
      refreshPlanLibrary,
      readPlanLibrary: () => activePlanLibrary(),
    });
    await c2.start();
    await c2.openPlanCreationActivate();
    const activating = c2.confirmPlanCreationActivate();
    await vi.waitFor(() =>
      expect(
        vi.mocked(client.call).mock.calls.some(([method]) => method === "plan_creation.activate"),
      ).toBe(true),
    );
    c2.dispose();
    activateGate.resolve({});
    await activating;
    expect(refreshPlan).not.toHaveBeenCalled();

    const c3 = createChatController({
      clients: makeProvider(client),
      view: { render: vi.fn() },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      openChat,
      refreshPlan,
      refreshPlanLibrary,
      readPlanLibrary: () => activePlanLibrary(),
    });
    await c3.start();
    const listBeforePreview = listPlanningCalls;
    const building = c3.buildPlanCreationDraft();
    await vi.waitFor(() =>
      expect(
        vi.mocked(client.call).mock.calls.some(([method]) => method === "plan_creation.preview"),
      ).toBe(true),
    );
    c3.dispose();
    previewGate.resolve({
      status: "rejected",
      reason: "commitments-pending",
      explanation: "Finish confirming your commitments first.",
      planCreation: card,
    });
    await building;
    expect(listPlanningCalls).toBe(listBeforePreview);
  });
});

describe("BUG-17: orphan dropped attachment admission timeout and dismiss while busy", () => {
  it("releases an orphaned beginDroppedAttachmentAdmission token after a bounded timeout", async () => {
    vi.useFakeTimers();
    const composer = emptyComposer();
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        if (method === "getChatAttachmentComposer") return composer as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(_state, next) {
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: {
        schemaVersion: 1,
        revision: 1,
        items: [queueItem("cmd-1", "/review", 0, { kind: "slash-command", restored: true })],
      },
    });

    expect(controller.beginDroppedAttachmentAdmission("orphan-1")).toBe(true);
    expect(controls.at(-1)?.attachments?.busy).toBe(true);
    expect(controller.openNewConversation()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(controls.at(-1)?.attachments?.busy).toBe(false);
    expect(controller.openNewConversation()).toBe(true);
    controller.cancelNewConversation();

    controller.settleDroppedAttachmentAdmission("orphan-1", []);
    expect(controls.at(-1)?.attachments?.busy).toBe(false);
    controller.dispose();
  });

  it("clears dropped attachment admission timeout cleanly on dispose", async () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const controller = createChatController({
      clients: makeProvider(client),
      view: { render },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });

    expect(controller.beginDroppedAttachmentAdmission("orphan-dispose")).toBe(true);
    controller.dispose();
    const rendersAfterDispose = render.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(render.mock.calls.length).toBe(rendersAfterDispose);
  });

  it("dismisses attachment admission errors cleanly while busy without triggering refreshAttachments", async () => {
    const composerCalls = vi.fn(async () => emptyComposer());
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getChatAttachmentComposer") return composerCalls() as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: {
        render(_state, next) {
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });

    const rejected: AttachmentAdmissionReadModel = {
      selectionId: "sel-1",
      displayName: "notes.bin",
      status: "rejected",
      reason: "format_unsupported",
    };
    controller.receiveAttachmentAdmissions([rejected]);
    await vi.waitFor(() => expect(composerCalls).toHaveBeenCalledTimes(1));
    expect(controls.at(-1)?.attachments?.admissions).toEqual([rejected]);

    expect(controller.beginDroppedAttachmentAdmission("busy-drop")).toBe(true);
    expect(controls.at(-1)?.attachments?.busy).toBe(true);

    controller.receiveAttachmentAdmissions([]);

    expect(controls.at(-1)?.attachments?.admissions).toEqual([]);
    expect(controls.at(-1)?.attachments?.error).toBeNull();
    expect(composerCalls).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe("Recovery and drain race guards", () => {
  it("does not drain queued messages during retryDecision before failed planningRequests recover", async () => {
    let decisionCalls = 0;
    let queueCalls = 0;
    let listPlanningCalls = 0;
    let resumeQueueCalls = 0;
    const blockingPlanCreation = {
      schemaVersion: 1,
      creationId: "pc-block-1",
      status: "interviewing",
      version: 1,
      openQuestion: {
        kind: "goal-question",
        prompt: "What are you training for?",
        candidates: [],
        eventNotListedOption: {
          detail: "Enter another event",
          nameLabel: "Event",
          dateLabel: "Date",
          placeholder: "Spring sportive",
        },
        fitnessOption: {
          label: "Build general fitness",
          detail: "No specific race date",
        },
      },
      answers: [],
      draft: null,
      pendingCheck: null,
      pendingCommitment: null,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") {
          decisionCalls += 1;
          if (decisionCalls === 1) return Promise.reject(new Error("boot decision down"));
          return Promise.resolve({ decision: null }) as never;
        }
        if (method === "getChatQueue") {
          queueCalls += 1;
          if (queueCalls === 1) return Promise.reject(new Error("boot queue down"));
          return Promise.resolve({
            schemaVersion: 1,
            revision: 1,
            items: [
              {
                queuedMessageId: "q-ord-1",
                messageId: "m-ord-1",
                submissionId: "s-ord-1",
                attachmentIds: [],
                text: "Waiting behind plan creation",
                kind: "ordinary",
                position: 0,
                restored: false,
              },
            ],
          }) as never;
        }
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "getTranscriptPage") {
          return Promise.resolve({
            schemaVersion: 1,
            status: "page",
            turns: [],
            nextCursor: null,
          }) as never;
        }
        if (method === "resumePlanningRequests") {
          return listPlanningCalls === 0
            ? Promise.reject(new Error("boot planning down"))
            : (Promise.resolve({ deliveries: [] }) as never);
        }
        if (method === "listPlanningRequests") {
          listPlanningCalls += 1;
          if (listPlanningCalls === 1) return Promise.reject(new Error("boot planning down"));
          return Promise.resolve({ deliveries: [], planCreation: blockingPlanCreation }) as never;
        }
        if (method === "resumeChatQueue") {
          resumeQueueCalls += 1;
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 2, items: [] },
            response: { text: "Should not run" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const controller = createChatController({
      clients: makeProvider(client),
      view: { render: vi.fn() },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });

    await controller.start();
    await controller.retryDecision();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resumeQueueCalls).toBe(0);
    controller.dispose();
  });

  it("does not re-fire a stalled head when a later queued item is removed", async () => {
    let resumeCalls = 0;
    const item1 = {
      queuedMessageId: "q-stalled-1",
      messageId: "m-stalled-1",
      submissionId: "s-stalled-1",
      attachmentIds: [],
      text: "Fails at head",
      kind: "ordinary" as const,
      position: 0,
      restored: false,
    };
    const item2 = {
      queuedMessageId: "q-later-2",
      messageId: "m-later-2",
      submissionId: "s-later-2",
      attachmentIds: [],
      text: "Removed behind head",
      kind: "ordinary" as const,
      position: 1,
      restored: false,
    };
    let currentItems = [item1, item2];
    let rev = 2;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, params) => {
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: rev, items: currentItems }) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCalls += 1;
          return Promise.reject(new Error("head failure"));
        }
        if (method === "removeQueuedChatMessage") {
          const id = (params as { readonly queuedMessageId: string }).queuedMessageId;
          currentItems = currentItems
            .filter((item) => item.queuedMessageId !== id)
            .map((item, position) => ({ ...item, position }));
          rev += 1;
          return Promise.resolve({ schemaVersion: 1, revision: rev, items: currentItems }) as never;
        }
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "getTranscriptPage") {
          return Promise.resolve({
            schemaVersion: 1,
            status: "page",
            turns: [],
            nextCursor: null,
          }) as never;
        }
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          return Promise.resolve({ deliveries: [], planCreation: null }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: makeProvider(client),
      view: { render: (next) => states.push(structuredClone(next)) },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });

    await controller.start();
    await vi.waitFor(() => expect(resumeCalls).toBe(1));

    controller.removeQueued("q-later-2");
    await vi.waitFor(() =>
      expect(states.at(-1)?.queued.map((item) => item.id)).toEqual(["q-stalled-1"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resumeCalls).toBe(1);
    controller.dispose();
  });

  it("retries hasSession on resume when an earlier session probe resolved in a stale epoch", async () => {
    let releaseFirstSession!: (value: { readonly hasSession: boolean }) => void;
    const firstSession = new Promise<{ readonly hasSession: boolean }>((resolve) => {
      releaseFirstSession = resolve;
    });
    let sessionCalls = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "hasSession") {
          sessionCalls += 1;
          if (sessionCalls === 1) return firstSession as never;
          return Promise.resolve({ hasSession: true }) as never;
        }
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        }
        if (method === "getChatAttachmentComposer")
          return Promise.resolve(emptyComposer()) as never;
        if (method === "resumePlanningRequests")
          return Promise.resolve({ deliveries: [] }) as never;
        if (method === "listPlanningRequests") {
          return Promise.resolve({ deliveries: [], planCreation: null }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => undefined),
    };
    const states: ChatState[] = [];
    let newConversationDisabled = true;
    const controller = createChatController({
      clients: makeProvider(client),
      readTranscriptPage: async () => ({
        schemaVersion: 1,
        status: "page",
        turns: [
          {
            turnId: "t-old-1",
            completedAt: "1998-08-24T08:00:00.000Z",
            athleteText: "Earlier ride",
            coachText: "Good spin.",
          },
        ],
        nextCursor: null,
      }),
      view: {
        render: (next, meta) => {
          states.push(structuredClone(next));
          newConversationDisabled = meta?.newConversationDisabled ?? true;
        },
      },
      refreshTrainingContext: async () => undefined,
      refreshSpend: async () => undefined,
    });

    const started = controller.start();
    await vi.waitFor(() => {
      expect(sessionCalls).toBe(1);
      expect(newConversationDisabled).toBe(false);
    });
    expect(controller.openNewConversation()).toBe(true);
    controller.cancelNewConversation();
    releaseFirstSession({ hasSession: true });
    await started;

    expect(states.at(-1)?.session.presence).toBe("unknown");
    await controller.resume();
    expect(sessionCalls).toBe(2);
    expect(states.at(-1)?.session.presence).toBe("present");
    controller.dispose();
  });
});
