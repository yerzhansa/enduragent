import { describe, expect, it, vi } from "vitest";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
  type CoachClientCallOptions,
} from "@enduragent/coach-client";
import type {
  ChatAttachmentComposerReadModel,
  ChatQueueSnapshot,
  CoachDecisionReadModel,
  CoachTurnEventNotificationEnvelope,
  CreatePlanningRequestRpcParams,
  CreateWorkoutPlanningRequestRpcParams,
  PlanCreationAnswerRpcParams,
  PlanCreationAnswerRpcResult,
  PlanningRequestDelivery,
  PlanCreationCardModel,
  PlanCreationStartRpcParams,
  PlanCreationStartRpcResult,
  QueuedChatMessage,
  TurnEvent,
} from "@enduragent/coach-contract";
import {
  CHAT_CONNECTION_INTERRUPTED_COPY,
  CHAT_EMPTY_RESPONSE_COPY,
  CHAT_PROTOCOL_FAILURE_COPY,
  CHAT_RESPONSE_STOPPED_COPY,
  NEW_CONVERSATION_MEMORY_WARNING_COPY,
  NEW_CONVERSATION_SUCCESS_COPY,
  NEW_CONVERSATION_UNCERTAIN_COPY,
  type ChatViewControls,
  createChatController,
} from "../src/chat/controller";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "../src/chat/limits";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { CHAT_WORKING_COPY, EMPTY_CHAT_STATE, type ChatState } from "../src/turn-state";

function envelope(
  event: TurnEvent,
  requestId = 1,
  requestMethod: CoachTurnEventNotificationEnvelope["params"]["requestMethod"] = "chat",
): CoachTurnEventNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: {
      requestId,
      requestMethod,
      turnId: event.turnId,
      event,
    },
  };
}

function errorEvent(message = "Safe athlete message"): Extract<TurnEvent, { type: "error" }> {
  return {
    type: "error",
    turnId: "turn-1",
    chatId: "desktop",
    error_class: "unknown",
    kind: "provider-down",
    athleteMessage: message,
    overflowAttempts: 0,
    timeoutAttempts: 0,
    rateLimitAttempts: 0,
    duration_ms: 1,
    compactions: 0,
  };
}

function imageComposer(imagesEnabled: boolean): ChatAttachmentComposerReadModel {
  const common = {
    schemaVersion: 1 as const,
    attachmentId: "attachment-image",
    displayName: "recovery-note.jpg",
    kind: "image" as const,
    extension: "jpg" as const,
    byteSize: 128,
  };
  const sharedCapabilities: Pick<
    ChatAttachmentComposerReadModel["capabilities"],
    "schemaVersion" | "documents" | "completedActivities" | "plannedWorkouts"
  > = {
    schemaVersion: 1,
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: {
      enabled: true,
      extensions: ["fit", "tcx", "gpx"],
    },
    plannedWorkouts: {
      enabled: true,
      extensions: ["zwo", "erg", "mrc"],
    },
  };
  const sharedDraft = {
    schemaVersion: 1 as const,
    chatId: "desktop",
    text: "Keep this draft.",
    state: "restored" as const,
    updatedAt: "1998-08-24T08:00:00.000Z",
  };
  if (imagesEnabled) {
    return {
      schemaVersion: 1,
      capabilities: {
        ...sharedCapabilities,
        active: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          transport: "ai-sdk",
        },
        images: {
          enabled: true,
          mediaTypes: ["image/png", "image/jpeg", "image/webp"],
          reason: "supported",
          source: "maintained_catalogue",
          checkedAt: "1998-08-24T08:00:00.000Z",
        },
      },
      draft: {
        ...sharedDraft,
        attachments: [
          {
            ...common,
            status: "ready",
            preview: { kind: "image", mediaType: "image/jpeg", width: 1, height: 1 },
          },
        ],
      },
    };
  }
  return {
    schemaVersion: 1,
    capabilities: {
      ...sharedCapabilities,
      active: {
        provider: "deepseek",
        model: "deepseek-chat",
        transport: "ai-sdk",
      },
      images: {
        enabled: false,
        mediaTypes: [],
        reason: "model_incompatible",
        source: "maintained_catalogue",
        checkedAt: "1998-08-24T08:05:00.000Z",
      },
    },
    draft: {
      ...sharedDraft,
      attachments: [{ ...common, status: "blocked", reason: "model_incompatible" }],
    },
  };
}

function planningDelivery(
  state: PlanningRequestDelivery["state"] = "delivered",
): PlanningRequestDelivery {
  return {
    requestId: "request-plan-1",
    source: {
      kind: "workout_review",
      intent: "Review Tempo 3 × 12 in Plan.",
      chatId: "desktop",
      messageId: "message-plan-1",
      attachmentId: "attachment-workout",
    },
    state,
    attemptCount: 1,
    failureCode: state === "failed" ? "planning_unavailable" : null,
    retryable: state === "failed" || state === "pending",
    createdAtMs: 1,
    updatedAtMs: 2,
    deliveredAtMs: state === "delivered" ? 2 : null,
    planningRequest:
      state === "delivered"
        ? {
            requestId: "request-plan-1",
            kind: "workout_review",
            target: "active_plan",
            intent: "Review Tempo 3 × 12 in Plan.",
            planConversationId: "plan-conversation-1",
            proposalId: "proposal-1",
            requestedDateKey: null,
            resolvedDateKey: null,
            source: { chatId: "desktop", messageId: "message-plan-1", available: true },
            lifecycle: "open",
            attention: "needs_review",
            revision: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            terminalResult: null,
          }
        : null,
  };
}

function deliver(options: CoachClientCallOptions<"chat"> | undefined, event: TurnEvent): void {
  const requestMethod = (
    options as
      | (CoachClientCallOptions<"chat"> & {
          requestMethod?: CoachTurnEventNotificationEnvelope["params"]["requestMethod"];
        })
      | undefined
  )?.requestMethod;
  options?.onNotificationEnvelope?.(envelope(event, 1, requestMethod));
  options?.onEvent?.(event);
}

function rejectWhenAborted(options: CoachClientCallOptions<"chat"> | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const signal = options?.signal;
    if (signal === undefined) {
      reject(new TypeError("missing call abort signal"));
      return;
    }
    const rejectAbort = (): void => reject(new CoachClientCallAbortedError("chat"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function client(
  implementation: (
    request: { chatId: string; message: string },
    options: CoachClientCallOptions<"chat"> | undefined,
  ) => Promise<{ text: string }>,
  sessions: {
    readonly hasSession?: (request: { chatId: string }) => Promise<{ hasSession: boolean }>;
    readonly resetSession?: (request: { chatId: string }) => Promise<{ memoryFlushed: boolean }>;
    readonly stopChat?: (request: {
      chatId: string;
      turnId: string;
    }) => Promise<{ stopped: boolean }>;
    readonly composer?: () => Promise<ChatAttachmentComposerReadModel>;
    readonly saveAttachmentDraftText?: (text: string) => Promise<ChatAttachmentComposerReadModel>;
    readonly mutateAttachment?: (
      method: "removeChatAttachment" | "retryChatAttachment" | "selectChatAttachmentWorkout",
    ) => Promise<ChatAttachmentComposerReadModel>;
    readonly clearAttachmentDraft?: () => Promise<ChatAttachmentComposerReadModel>;
    readonly getChatQueue?: () => Promise<ChatQueueSnapshot>;
    readonly enqueueChatMessage?: (request: {
      readonly chatId: string;
      readonly submissionId: string;
      readonly text: string;
      readonly attachmentIds?: readonly string[];
    }) => Promise<ChatQueueSnapshot>;
    readonly resumeChatQueue?: () => Promise<{
      readonly snapshot: ChatQueueSnapshot;
      readonly response?: { readonly text: string };
    }>;
    readonly getCoachDecision?: () => Promise<{
      readonly decision: CoachDecisionReadModel | null;
    }>;
    readonly listPlanningRequests?: () => Promise<{
      readonly deliveries: readonly PlanningRequestDelivery[];
      readonly planCreation?: PlanCreationCardModel | null;
    }>;
    readonly resumePlanningRequests?: () => Promise<{
      readonly deliveries: readonly PlanningRequestDelivery[];
    }>;
    readonly createWorkoutPlanningRequest?: (
      request: CreateWorkoutPlanningRequestRpcParams,
    ) => Promise<
      | { readonly status: "accepted"; readonly delivery: PlanningRequestDelivery }
      | { readonly status: "rejected"; readonly reason: "invalid_request" | "request_conflict" }
    >;
    readonly createPlanningRequest?: (
      request: CreatePlanningRequestRpcParams,
    ) => Promise<
      | { readonly status: "accepted"; readonly delivery: PlanningRequestDelivery }
      | { readonly status: "rejected"; readonly reason: "invalid_request" | "request_conflict" }
    >;
    readonly retryPlanningRequest?: () => Promise<
      | { readonly status: "found"; readonly delivery: PlanningRequestDelivery }
      | { readonly status: "missing" }
    >;
    readonly startPlanCreation?: (
      request: PlanCreationStartRpcParams,
    ) => Promise<PlanCreationStartRpcResult>;
    readonly answerPlanCreation?: (
      request: PlanCreationAnswerRpcParams,
    ) => Promise<PlanCreationAnswerRpcResult>;
  } = {},
): CoachClient {
  let queueRevision = 0;
  const queued: QueuedChatMessage[] = [];
  let retryRequired: ChatQueueSnapshot["retryRequired"];
  let claimSequence = 0;
  const snapshot = (): ChatQueueSnapshot => ({
    schemaVersion: 1,
    revision: queueRevision,
    items: queued.map((item, position) => ({ ...item, position })),
    ...(retryRequired === undefined ? {} : { retryRequired }),
  });
  const acknowledge = (items: readonly QueuedChatMessage[]): void => {
    const ids = new Set(items.map((item) => item.queuedMessageId));
    for (let index = queued.length - 1; index >= 0; index -= 1) {
      if (ids.has(queued[index]!.queuedMessageId)) queued.splice(index, 1);
    }
    queueRevision += 1;
  };
  const requireRetry = (items: readonly QueuedChatMessage[], turnId: string): void => {
    const ids = items.map((item) => item.queuedMessageId);
    retryRequired = {
      claimId: retryRequired?.claimId ?? `claim-${++claimSequence}`,
      queuedMessageIds: ids,
      turnId,
      status: "retry-required",
    };
    queueRevision += 1;
  };
  const call = vi.fn((method, request, options) => {
    const hideQueueCall = (): void => {
      call.mock.calls.pop();
    };
    const emptyComposer = (): ChatAttachmentComposerReadModel => ({
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
          checkedAt: "2001-01-01T00:00:00.000Z",
        },
      },
      draft: null,
    });
    if (method === "getChatAttachmentComposer") {
      hideQueueCall();
      return (sessions.composer?.() ?? Promise.resolve(emptyComposer())) as never;
    }
    if (method === "listPlanningRequests") {
      hideQueueCall();
      return (sessions
        .listPlanningRequests?.()
        .then((result) => ({ planCreation: null, ...result })) ??
        Promise.resolve({ deliveries: [], planCreation: null })) as never;
    }
    if (method === "resumePlanningRequests") {
      hideQueueCall();
      return (sessions.resumePlanningRequests?.() ?? Promise.resolve({ deliveries: [] })) as never;
    }
    if (method === "createWorkoutPlanningRequest") {
      return (sessions.createWorkoutPlanningRequest?.(
        request as CreateWorkoutPlanningRequestRpcParams,
      ) ?? Promise.resolve({ status: "rejected", reason: "invalid_request" })) as never;
    }
    if (method === "createPlanningRequest") {
      return (sessions.createPlanningRequest?.(request as CreatePlanningRequestRpcParams) ??
        Promise.resolve({ status: "rejected", reason: "invalid_request" })) as never;
    }
    if (method === "retryPlanningRequest") {
      return (sessions.retryPlanningRequest?.() ?? Promise.resolve({ status: "missing" })) as never;
    }
    if (method === "plan_creation.start") {
      return (sessions.startPlanCreation?.(request as PlanCreationStartRpcParams) ??
        Promise.resolve({ status: "rejected", reason: "command-conflict" })) as never;
    }
    if (method === "plan_creation.answer") {
      return (sessions.answerPlanCreation?.(request as PlanCreationAnswerRpcParams) ??
        Promise.resolve({
          status: "rejected",
          reason: "no-unfinished-creation",
          planCreation: null,
        })) as never;
    }
    if (method === "saveChatAttachmentDraftText") {
      hideQueueCall();
      const value = request as { text: string };
      return (sessions.saveAttachmentDraftText?.(value.text) ??
        Promise.resolve(emptyComposer())) as never;
    }
    if (
      method === "removeChatAttachment" ||
      method === "retryChatAttachment" ||
      method === "selectChatAttachmentWorkout" ||
      method === "clearChatAttachmentDraft"
    ) {
      hideQueueCall();
      return (
        method === "clearChatAttachmentDraft" && sessions.clearAttachmentDraft !== undefined
          ? sessions.clearAttachmentDraft()
          : method !== "clearChatAttachmentDraft" && sessions.mutateAttachment !== undefined
            ? sessions.mutateAttachment(method)
            : Promise.resolve(emptyComposer())
      ) as never;
    }
    if (method === "getChatQueue") {
      hideQueueCall();
      if (sessions.getChatQueue !== undefined) return sessions.getChatQueue() as never;
      return Promise.resolve(snapshot()) as never;
    }
    if (method === "enqueueChatMessage") {
      hideQueueCall();
      const value = request as {
        chatId: string;
        submissionId: string;
        text: string;
        attachmentIds?: readonly string[];
      };
      if (sessions.enqueueChatMessage !== undefined) {
        return sessions.enqueueChatMessage(value) as never;
      }
      if (!queued.some((item) => item.submissionId === value.submissionId)) {
        queued.push({
          queuedMessageId: `queued-${value.submissionId}`,
          messageId: `message-${value.submissionId}`,
          submissionId: value.submissionId,
          text: value.text,
          kind: value.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
          attachmentIds: [...(value.attachmentIds ?? [])],
          position: queued.length,
          restored: false,
        });
        queueRevision += 1;
      }
      return Promise.resolve(snapshot()) as never;
    }
    if (method === "removeQueuedChatMessage") {
      hideQueueCall();
      const value = request as { queuedMessageId: string };
      acknowledge(queued.filter((item) => item.queuedMessageId === value.queuedMessageId));
      return Promise.resolve(snapshot()) as never;
    }
    if (
      method === "resumeChatQueue" ||
      method === "runQueuedCommand" ||
      method === "retryQueuedTurn"
    ) {
      hideQueueCall();
      if (method === "resumeChatQueue" && sessions.resumeChatQueue !== undefined) {
        return sessions.resumeChatQueue() as never;
      }
      const group = (() => {
        if (method === "retryQueuedTurn") {
          const claimId = (request as { claimId: string }).claimId;
          if (retryRequired?.claimId !== claimId) return [];
          const ids = new Set(retryRequired.queuedMessageIds);
          return queued.filter((item) => ids.has(item.queuedMessageId));
        }
        const head = queued[0];
        if (head === undefined) return [];
        const commandIndex = queued.findIndex((item) => item.kind === "slash-command");
        return head.kind === "slash-command"
          ? [head]
          : queued.slice(0, commandIndex === -1 ? queued.length : commandIndex);
      })();
      if (group.length === 0) return Promise.resolve({ snapshot: snapshot() }) as never;
      let turnId = retryRequired?.turnId ?? "turn-1";
      let interrupted = false;
      const queueOptions = {
        ...(options as CoachClientCallOptions<"chat">),
        requestMethod: method,
        onEvent(event: TurnEvent) {
          turnId = event.turnId;
          if (event.type === "interrupted") interrupted = true;
          (options as CoachClientCallOptions<"chat"> | undefined)?.onEvent?.(event);
        },
      };
      const response = call(
        "chat",
        { chatId: "desktop", message: group.map((item) => item.text).join("\n\n") },
        queueOptions,
      ) as Promise<{ text: string }>;
      return response.then(
        (value) => {
          if (interrupted) {
            requireRetry(group, turnId);
          } else {
            retryRequired = undefined;
            acknowledge(group);
          }
          return { snapshot: snapshot(), response: value };
        },
        (error: unknown) => {
          requireRetry(group, turnId);
          throw error;
        },
      ) as never;
    }
    if (method === "hasSession") {
      return (sessions.hasSession ?? (async () => ({ hasSession: false })))(
        request as { chatId: string },
      ) as never;
    }
    if (method === "resetSession") {
      return (sessions.resetSession ?? (async () => ({ memoryFlushed: true })))(
        request as { chatId: string },
      ) as never;
    }
    if (method === "stopChat") {
      return (sessions.stopChat ?? (async () => ({ stopped: false })))(
        request as { chatId: string; turnId: string },
      ) as never;
    }
    if (method === "getCoachDecision") {
      return (sessions.getCoachDecision?.() ?? Promise.resolve({ decision: null })) as never;
    }
    if (method !== "chat") throw new TypeError();
    return implementation(
      request as { chatId: string; message: string },
      options as CoachClientCallOptions<"chat">,
    ) as never;
  });
  return {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  };
}

function replies(
  gate?: () => Promise<void>,
): (
  request: { chatId: string; message: string },
  options: CoachClientCallOptions<"chat"> | undefined,
) => Promise<{ text: string }> {
  let turn = 0;
  return async (_request, options) => {
    turn += 1;
    if (turn === 1 && gate !== undefined) await gate();
    const text = `Reply ${turn}`;
    deliver(options, { type: "final-text", turnId: `turn-${turn}`, text });
    options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: turn, result: { text } });
    return { text };
  };
}

function chatMessages(fake: CoachClient): readonly string[] {
  return vi
    .mocked(fake.call)
    .mock.calls.filter(([method]) => method === "chat")
    .map(([, request]) => (request as { message: string }).message);
}

function subject(
  first: CoachClient,
  reconnected: CoachClient = first,
  refreshImplementation: () => Promise<void> = async () => {},
  spendRefreshImplementation: () => Promise<void> = async () => {},
  canChat: () => boolean = () => true,
  settleSubmissions = true,
  openPlanningRequest = vi.fn(),
  initialQueueSnapshot: ChatQueueSnapshot = { schemaVersion: 1, revision: 0, items: [] },
) {
  const states: ChatState[] = [];
  const controls: ChatViewControls[] = [];
  const settlements = new Set<{ remaining: number; resolve: () => void }>();
  const refresh = vi.fn(refreshImplementation);
  const refreshSpend = vi.fn(spendRefreshImplementation);
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => first),
    reconnect: vi.fn(async () => reconnected),
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: {
      render: (state, nextControls) => {
        states.push(structuredClone(state));
        if (nextControls !== undefined) controls.push(structuredClone(nextControls));
        if (state.status !== "streaming") {
          for (const settlement of settlements) {
            settlement.remaining -= 1;
            if (settlement.remaining === 0) {
              settlements.delete(settlement);
              settlement.resolve();
            }
          }
        }
      },
    },
    refreshTrainingContext: refresh,
    refreshSpend,
    canChat,
    initialQueueSnapshot,
    openPlanningRequest,
  });
  const submittedController = {
    ...controller,
    async submit(message: string, attachmentIds: readonly string[] = []): Promise<boolean> {
      const alreadyStreaming = states.at(-1)?.status === "streaming";
      const acknowledged = await controller.submit(message, attachmentIds);
      if (
        !settleSubmissions ||
        !acknowledged ||
        alreadyStreaming ||
        states.at(-1)?.status !== "streaming"
      ) {
        return acknowledged;
      }
      await new Promise<void>((resolve) => settlements.add({ remaining: 2, resolve }));
      return acknowledged;
    },
  };
  return {
    controller: submittedController,
    provider,
    states,
    controls,
    refresh,
    refreshSpend,
    openPlanningRequest,
  };
}

describe("chat controller", () => {
  it("keeps submit, reset, and queued drain inert while setup is not ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = false;
    const fake = client(replies(() => gate));
    const { controller, states } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => ready,
      false,
    );

    await controller.submit("Blocked");
    expect(chatMessages(fake)).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);

    ready = true;
    const first = controller.submit("Allowed");
    await Promise.resolve();
    await controller.submit("Queued");
    ready = false;
    release();
    await first;

    expect(chatMessages(fake)).toEqual(["Allowed\n\nQueued"]);
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);
  });

  it("resumes a readiness-blocked queue exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = true;
    const fake = client(replies(() => gate));
    const { controller, states } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => ready,
      false,
    );

    const first = controller.submit("Allowed");
    await Promise.resolve();
    await controller.submit("Queued");
    ready = false;
    release();
    await first;

    expect(chatMessages(fake)).toEqual(["Allowed\n\nQueued"]);
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.queued).toEqual([]);

    ready = true;
    await Promise.all([controller.resume(), controller.resume(), controller.resume()]);

    expect(chatMessages(fake)).toEqual(["Allowed\n\nQueued"]);
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("renders the reauthentication copy instead of the generic failure copy", async () => {
    const reauthenticationCopy =
      "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
    const fake = client(async (_request, options) => {
      deliver(options, {
        ...errorEvent(reauthenticationCopy),
        kind: "provider-auth",
      });
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);

    await controller.submit("Help");

    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe(reauthenticationCopy);
    expect(states.at(-1)?.progress).toBeNull();
    expect(states.at(-1)?.status).toBe("idle");
  });

  it("keeps a transient provider failure retryable without reauthentication copy", async () => {
    const transientCopy = "The model provider is having trouble — try again in a few minutes.";
    const fake = client(async (_request, options) => {
      deliver(options, errorEvent(transientCopy));
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);

    await controller.submit("Help");

    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe(transientCopy);
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).not.toContain("sign in again");
  });

  it("does not wait for spend refresh before settling a completed chat", async () => {
    const gate = new Promise<void>(() => {});
    const fake = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, refreshSpend } = subject(
      fake,
      fake,
      async () => {},
      () => gate,
    );
    await expect(controller.submit("Continue")).resolves.toBe(true);
    expect(refreshSpend).toHaveBeenCalledTimes(1);
  });

  it("publishes working feedback immediately for an accepted submit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(async (_request, options) => {
      await gate;
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states } = subject(fake);

    const submission = controller.submit("Continue");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "streaming",
        progress: CHAT_WORKING_COPY,
        messages: [
          { role: "athlete", text: "Continue" },
          { role: "coach", text: "", delivery: "streaming" },
        ],
      }),
    );

    release();
    await submission;
  });

  it("stops only the active response and retries on the same connected client", async () => {
    let firstOptions: CoachClientCallOptions<"chat"> | undefined;
    let finishFirst!: (value: { text: string }) => void;
    let callCount = 0;
    const firstResult = new Promise<{ text: string }>((resolve) => {
      finishFirst = resolve;
    });
    const fake = client(
      async (_request, options) => {
        callCount += 1;
        if (callCount === 1) {
          firstOptions = options;
          deliver(options, { type: "turn-start", turnId: "turn-1", chatId: "desktop" });
          deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial response" });
          return firstResult;
        }
        deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 2,
          result: { text: "Recovered" },
        });
        return { text: "Recovered" };
      },
      {
        stopChat: async () => {
          deliver(firstOptions, {
            type: "interrupted",
            turnId: "turn-1",
            chatId: "desktop",
            text: "Partial response",
          });
          firstOptions?.onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: { text: "Partial response" },
          });
          finishFirst({ text: "Partial response" });
          return { stopped: true };
        },
      },
    );
    const { controller, provider, states } = subject(fake);

    const submission = controller.submit("Stop this");
    await vi.waitFor(() => expect(states.at(-1)?.messages.at(-1)?.text).toBe("Partial response"));
    controller.stop();
    await submission;

    expect(vi.mocked(fake.call).mock.calls.map(([method]) => method)).toEqual(["chat", "stopChat"]);
    expect(vi.mocked(fake.call).mock.calls[1]?.[1]).toEqual({
      chatId: "desktop",
      turnId: "turn-1",
    });
    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_RESPONSE_STOPPED_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: "Partial response",
      delivery: "interrupted",
    });
    expect(firstOptions?.signal?.aborted).toBe(false);

    expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
    await controller.retryQueuedTurn("claim-1");

    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: "Recovered",
      delivery: "complete",
    });
  });

  it("ignores Stop after a response has completed", async () => {
    const fake = client(replies());
    const { controller, states } = subject(fake);

    await controller.submit("Continue");
    controller.stop();

    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: "Reply 1",
      delivery: "complete",
    });
  });

  it("clears only generic working feedback on the first substantive delta", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: " \n" });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Ride easy." });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Ride easy." });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Ride easy." } });
      return { text: "Ride easy." };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    const whitespace = states.find((state) => state.activeTurn?.draft === " \n");
    expect(whitespace?.progress).toBe(CHAT_WORKING_COPY);
    expect(whitespace?.messages.at(-1)?.text).toBe("");
    const firstText = states.find((state) => state.activeTurn?.draft === " \nRide easy.");
    expect(firstText?.progress).toBeNull();
    expect(firstText?.messages.at(-1)?.text).toBe(" \nRide easy.");
  });

  it("renders ordered deltas immediately and canonical final text once without turn-start", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Hel" });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "lo" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Hello." });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Hello." } });
      return { text: "Hello." };
    });
    const { controller, states, refresh, refreshSpend } = subject(fake);
    await controller.submit("Original message ");
    expect(states.some((state) => state.messages.at(-1)?.text === "Hel")).toBe(true);
    expect(states.at(-1)?.messages.filter((message) => message.text === "Hello.")).toHaveLength(1);
    expect(states.at(-1)?.session.presence).toBe("present");
    expect(vi.mocked(fake.call).mock.calls[0]?.slice(0, 2)).toEqual([
      "chat",
      { chatId: "desktop", message: "Original message " },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshSpend).toHaveBeenCalledTimes(1);
  });

  it("admits cumulative text deltas at the exact response boundary", async () => {
    const first = "🚴".repeat(30_000);
    const second = "b".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT - first.length);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: first });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: second });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states, controls } = subject(fake);

    await controller.submit("Continue");

    expect(
      states.some((state) => state.activeTurn?.draft.length === COACH_RESPONSE_CODE_UNIT_LIMIT),
    ).toBe(true);
    expect(controls.filter((control) => control.appendDelta).at(-1)?.appendDelta).toEqual({
      messageId: "message-3",
      previousTextLength: first.length,
      nextTextLength: COACH_RESPONSE_CODE_UNIT_LIMIT,
      delta: second,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Done");
    expect(signal?.aborted).toBe(false);
  });

  it("rejects one cumulative delta code unit over the response boundary", async () => {
    const admitted = "a".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: admitted });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "b" });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe(admitted);
    expect(signal?.aborted).toBe(true);
  });

  it("admits final text at the exact response boundary", async () => {
    const finalText = "🚴".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT / 2);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      deliver(options, { type: "final-text", turnId: "turn-1", text: finalText });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: finalText } });
      return { text: finalText };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: finalText,
      delivery: "complete",
    });
    expect(signal?.aborted).toBe(false);
  });

  it("rejects final text one code unit over the response boundary", async () => {
    const oversized = `${"🚴".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT / 2)}x`;
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Preserved" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: oversized });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Preserved");
    expect(states.some((state) => state.messages.at(-1)?.text === oversized)).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("admits the final event at the exact turn-event boundary", async () => {
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      for (let index = 0; index < COACH_TURN_EVENT_LIMIT - 1; index += 1) {
        deliver(options, { type: "step-text", turnId: "turn-1", text: "Checking" });
      }
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: "Done",
      delivery: "complete",
    });
    expect(signal?.aborted).toBe(false);
  });

  it("rejects one turn event over the boundary and preserves admitted text", async () => {
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Preserved" });
      for (let index = 1; index < COACH_TURN_EVENT_LIMIT; index += 1) {
        deliver(options, { type: "step-text", turnId: "turn-1", text: "Checking" });
      }
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Rejected" });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Preserved");
    expect(states.some((state) => state.messages.at(-1)?.text === "Rejected")).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("preserves partial text and the contract athlete message without automatic retry", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      deliver(options, errorEvent());
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Partial");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe("Safe athlete message");
    await vi.waitFor(() => expect(fake.call).toHaveBeenCalledTimes(1));
  });

  it("reconciles a safe final after an error while retaining the subdued notice", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
      deliver(options, errorEvent());
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Safe fallback" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Safe fallback" } });
      return { text: "Safe fallback" };
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Safe fallback");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe("Safe athlete message");
  });

  it.each(["missing", "mismatch"])(
    "treats a %s final confirmation as a safe protocol interruption",
    async (variant) => {
      const fake = client(async (_request, options) => {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
        if (variant === "mismatch") {
          deliver(options, { type: "final-text", turnId: "turn-1", text: "Canonical" });
        }
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Other" } });
        return { text: "Other" };
      });
      const { controller, states } = subject(fake);
      await controller.submit("Help");
      expect(states.at(-1)).toMatchObject({
        status: "interrupted",
        progress: CHAT_PROTOCOL_FAILURE_COPY,
      });
      expect(states.at(-1)?.messages.at(-1)?.text).toBe(
        variant === "mismatch" ? "Canonical" : "Draft",
      );
    },
  );

  it.each([
    { finalText: "", partial: "" },
    { finalText: " \n\t", partial: "Preserved partial" },
  ])(
    "keeps a matching whitespace-only terminal retryable without completing %#",
    async ({ finalText, partial }) => {
      const fake = client(async (_request, options) => {
        if (partial.length > 0) {
          deliver(options, { type: "text_delta", turnId: "turn-1", delta: partial });
        }
        deliver(options, { type: "final-text", turnId: "turn-1", text: finalText });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: finalText } });
        return { text: finalText };
      });
      const { controller, states } = subject(fake);
      await controller.start();

      await controller.submit("Help");

      expect(states.at(-1)).toMatchObject({
        status: "interrupted",
        progress: CHAT_EMPTY_RESPONSE_COPY,
        session: { presence: "absent" },
      });
      expect(states.at(-1)?.messages).toMatchObject([
        { role: "athlete", text: "Help", delivery: "complete" },
        { role: "coach", text: partial, delivery: "interrupted" },
      ]);
      expect(
        states.some(
          (state) =>
            state.messages.at(-1)?.delivery === "complete" &&
            !/\S/u.test(state.messages.at(-1)?.text ?? ""),
        ),
      ).toBe(false);
    },
  );

  it("accepts one matching first turn-start and rejects a late start", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
      deliver(options, { type: "turn-start", turnId: "turn-1", chatId: "desktop" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Final" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Final" } });
      return { text: "Final" };
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.progress).toBe(CHAT_PROTOCOL_FAILURE_COPY);
  });

  it("preserves a disconnected draft and retries explicitly without duplicating the user row", async () => {
    let attempt = 0;
    const fake = client(async (_request, options) => {
      attempt += 1;
      if (attempt === 1) {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw new CoachClientDisconnectedError(1006, "synthetic");
      }
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller, provider, states, refresh } = subject(fake);
    await controller.submit("Same message");
    expect(states.at(-1)?.progress).toBe(CHAT_CONNECTION_INTERRUPTED_COPY);
    expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
    const retry = controller.retryQueuedTurn("claim-1");
    expect(states.at(-1)?.progress).toBe(CHAT_WORKING_COPY);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    await retry;
    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(chatMessages(fake)).toEqual(["Same message", "Same message"]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    new CoachClientCallTimeoutError("chat", 11 * 60_000),
    new CoachClientCallAbortedError("chat"),
  ])(
    "preserves a draft after $name and makes one new call only on explicit retry",
    async (failure) => {
      let attempt = 0;
      const fake = client(async (_request, options) => {
        attempt += 1;
        if (attempt === 1) {
          deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
          throw failure;
        }
        deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 2,
          result: { text: "Recovered" },
        });
        return { text: "Recovered" };
      });
      const { controller, provider, states } = subject(fake);

      await controller.submit("Same message");

      expect(states.at(-1)?.status).toBe("interrupted");
      expect(states.at(-1)?.progress).toBe(CHAT_CONNECTION_INTERRUPTED_COPY);
      expect(states.at(-1)?.messages.at(-1)?.text).toBe("Partial");
      expect(chatMessages(fake)).toHaveLength(1);
      expect(provider.reconnect).not.toHaveBeenCalled();

      expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
      await controller.retryQueuedTurn("claim-1");

      expect(chatMessages(fake)).toHaveLength(2);
      expect(provider.reconnect).not.toHaveBeenCalled();
      expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(
        1,
      );
      expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
    },
  );

  it("retries a durable interrupted turn through the current client", async () => {
    let attempt = 0;
    const fake = client(async (_request, options) => {
      attempt += 1;
      if (attempt === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller, provider, states } = subject(fake);
    await controller.submit("Same message");
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
    await controller.retryQueuedTurn("claim-1");
    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(chatMessages(fake)).toHaveLength(2);
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
  });

  it("queues one explicit retry while terminal state refresh is still running", async () => {
    let release!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    let attempt = 0;
    const fake = client(async (_request, options) => {
      attempt += 1;
      if (attempt === 1) {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw new CoachClientDisconnectedError(1006, "synthetic");
      }
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    let interrupted!: () => void;
    const interruptedState = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => fake),
      reconnect: vi.fn(async () => fake),
      close: vi.fn(async () => {}),
    };
    let latestState = EMPTY_CHAT_STATE;
    const controller = createChatController({
      clients: provider,
      view: {
        render(state) {
          latestState = structuredClone(state);
          if (state.status === "interrupted") interrupted();
        },
      },
      refreshTrainingContext: vi.fn(async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) await refreshGate;
      }),
      refreshSpend: vi.fn(async () => {}),
      initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
    });
    const submission = controller.submit("Same message");
    await interruptedState;
    expect(latestState.retryRequired?.claimId).toBe("claim-1");
    const retry = controller.retryQueuedTurn("claim-1");
    const duplicate = controller.retryQueuedTurn("claim-1");
    expect(latestState.progress).toBe(CHAT_WORKING_COPY);
    expect(latestState.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(controller.openNewConversation()).toBe(false);
    release();
    await Promise.all([submission, retry, duplicate]);
    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(chatMessages(fake)).toHaveLength(2);
  });

  it("allows one in-flight call and treats client protocol rejection as explicit-retry state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(async () => {
      await gate;
      throw new CoachClientProtocolError();
    });
    const { controller, states } = subject(fake);
    const first = controller.submit("One");
    const second = controller.submit("Two");
    await vi.waitFor(() => expect(fake.call).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(states.at(-1)?.progress).toBe(CHAT_PROTOCOL_FAILURE_COPY);
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
  });

  it("does not dispatch blank-only input", async () => {
    const fake = client(async () => ({ text: "unused" }));
    const { controller } = subject(fake);
    await controller.submit("  \n");
    expect(fake.call).not.toHaveBeenCalled();
  });

  it("restores the durable Composer and sends an attachment-only Message", async () => {
    const surface: ChatAttachmentComposerReadModel = {
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
          checkedAt: "2026-08-26T00:00:00.000Z",
        },
      },
      draft: {
        schemaVersion: 1,
        chatId: "desktop",
        text: "",
        state: "restored",
        updatedAt: "2026-08-26T00:00:00.000Z",
        attachments: [
          {
            schemaVersion: 1,
            attachmentId: "attachment-1",
            displayName: "notes.txt",
            kind: "document",
            extension: "txt",
            byteSize: 42,
            status: "ready",
            preview: { kind: "document", extractedTextChars: 42, visualPageCount: 0 },
          },
        ],
      },
    };
    const fake = client(replies(), { composer: async () => surface });
    const { controller, controls, states } = subject(fake);
    await controller.start();
    expect(controls.at(-1)?.attachments?.value).toEqual(surface);

    await expect(controller.submit("", ["attachment-1"])).resolves.toBe(true);
    expect(chatMessages(fake)).toEqual([""]);
    expect(states.at(-1)?.messages).toContainEqual(
      expect.objectContaining({
        role: "athlete",
        text: "",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "notes.txt",
            kind: "document",
            extension: "txt",
          },
        ],
      }),
    );
    await expect(controller.submit("/status", ["attachment-1"])).resolves.toBe(false);
  });

  it("refreshes the durable Composer after attachment capabilities change", async () => {
    let imagesEnabled = true;
    const fake = client(replies(), { composer: async () => imageComposer(imagesEnabled) });
    const { controller, controls } = subject(fake);
    await controller.start();
    expect(controls.at(-1)?.attachments?.value).toEqual(imageComposer(true));

    imagesEnabled = false;
    await controller.refreshAttachments();

    expect(controls.at(-1)?.attachments).toMatchObject({
      error: null,
      value: {
        capabilities: {
          active: { provider: "deepseek", model: "deepseek-chat" },
          images: { enabled: false, reason: "model_incompatible" },
        },
        draft: {
          text: "Keep this draft.",
          attachments: [
            {
              attachmentId: "attachment-image",
              status: "blocked",
              reason: "model_incompatible",
            },
          ],
        },
      },
    });
  });

  it("opens reset confirmation for an attachment-only draft", async () => {
    const fake = client(replies(), { composer: async () => imageComposer(true) });
    const { controller, states } = subject(fake);
    await controller.start();

    expect(states.at(-1)?.messages).toEqual([]);
    expect(controller.openNewConversation()).toBe(true);
    expect(states.at(-1)?.session.resetPhase).toBe("confirming");
  });

  it("keeps reset behind an in-flight attachment mutation", async () => {
    const surface = imageComposer(true);
    const cleared = { ...surface, draft: null };
    let resolveMutation!: (value: ChatAttachmentComposerReadModel) => void;
    const mutation = new Promise<ChatAttachmentComposerReadModel>((resolve) => {
      resolveMutation = resolve;
    });
    const fake = client(replies(), {
      composer: async () => surface,
      mutateAttachment: async () => mutation,
      resetSession: async () => ({ memoryFlushed: true }),
      clearAttachmentDraft: async () => cleared,
    });
    const { controller, controls } = subject(fake);
    await controller.start();

    controller.removeAttachment("attachment-image");
    await vi.waitFor(() => expect(controls.at(-1)?.attachments?.busy).toBe(true));
    expect(controller.openNewConversation()).toBe(false);

    resolveMutation(surface);
    await vi.waitFor(() => expect(controls.at(-1)?.attachments?.busy).toBe(false));
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();

    expect(controls.at(-1)?.attachments?.value).toEqual(cleared);
  });

  it("keeps a settled drop refresh from restoring the draft after reset", async () => {
    const surface = imageComposer(true);
    const cleared = { ...surface, draft: null };
    let composerReads = 0;
    let resolveStaleRefresh!: (value: ChatAttachmentComposerReadModel) => void;
    const staleRefresh = new Promise<ChatAttachmentComposerReadModel>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const fake = client(replies(), {
      composer: () => {
        composerReads += 1;
        return composerReads === 1 ? Promise.resolve(surface) : staleRefresh;
      },
      resetSession: async () => ({ memoryFlushed: true }),
      clearAttachmentDraft: async () => cleared,
    });
    const { controller, controls } = subject(fake);
    await controller.start();

    expect(controller.beginDroppedAttachmentAdmission("drop-1")).toBe(true);
    expect(controller.openNewConversation()).toBe(false);
    controller.settleDroppedAttachmentAdmission("drop-1", [
      {
        selectionId: "selection-drop-1",
        displayName: "recovery-note.jpg",
        status: "accepted",
        attachmentId: "attachment-image",
      },
    ]);
    await vi.waitFor(() => expect(composerReads).toBe(2));
    expect(controller.openNewConversation()).toBe(true);
    expect(controller.beginDroppedAttachmentAdmission("drop-2")).toBe(false);

    await controller.confirmNewConversation();
    resolveStaleRefresh(surface);
    await staleRefresh;
    await Promise.resolve();

    expect(controls.at(-1)?.attachments?.value).toEqual(cleared);
  });

  it("keeps an older composer read from replacing a newer one", async () => {
    const initial = imageComposer(true);
    const oldSurface = imageComposer(true);
    const newSurface = imageComposer(false);
    let composerReads = 0;
    let resolveOldRead!: (value: ChatAttachmentComposerReadModel) => void;
    let resolveNewRead!: (value: ChatAttachmentComposerReadModel) => void;
    const oldRead = new Promise<ChatAttachmentComposerReadModel>((resolve) => {
      resolveOldRead = resolve;
    });
    const newRead = new Promise<ChatAttachmentComposerReadModel>((resolve) => {
      resolveNewRead = resolve;
    });
    const fake = client(replies(), {
      composer: () => {
        composerReads += 1;
        if (composerReads === 1) return Promise.resolve(initial);
        return composerReads === 2 ? oldRead : newRead;
      },
    });
    const { controller, controls } = subject(fake);
    await controller.start();

    const firstRefresh = controller.refreshAttachments();
    const secondRefresh = controller.refreshAttachments();
    await vi.waitFor(() => expect(composerReads).toBe(3));
    resolveNewRead(newSurface);
    await secondRefresh;
    resolveOldRead(oldSurface);
    await firstRefresh;

    expect(controls.at(-1)?.attachments?.value).toEqual(newSurface);
  });

  it("keeps an older composer read from replacing a later attachment mutation", async () => {
    const oldSurface = imageComposer(true);
    const mutatedSurface = imageComposer(false);
    let composerReads = 0;
    let resolveOldRead!: (value: ChatAttachmentComposerReadModel) => void;
    const oldRead = new Promise<ChatAttachmentComposerReadModel>((resolve) => {
      resolveOldRead = resolve;
    });
    const fake = client(replies(), {
      composer: () => {
        composerReads += 1;
        return composerReads === 1 ? Promise.resolve(oldSurface) : oldRead;
      },
      mutateAttachment: async () => mutatedSurface,
    });
    const { controller, controls } = subject(fake);
    await controller.start();

    const staleRefresh = controller.refreshAttachments();
    await vi.waitFor(() => expect(composerReads).toBe(2));
    controller.removeAttachment("attachment-image");
    await vi.waitFor(() => expect(controls.at(-1)?.attachments?.value).toEqual(mutatedSurface));
    resolveOldRead(oldSurface);
    await staleRefresh;

    expect(controls.at(-1)?.attachments?.value).toEqual(mutatedSurface);
  });

  it("creates one trusted Workout handoff and opens the delivered request in Plan", async () => {
    const surface: ChatAttachmentComposerReadModel = {
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
          checkedAt: "1998-08-26T00:00:00.000Z",
        },
      },
      draft: {
        schemaVersion: 1,
        chatId: "desktop",
        text: "",
        state: "active",
        updatedAt: "1998-08-26T00:00:00.000Z",
        attachments: [
          {
            schemaVersion: 1,
            attachmentId: "attachment-workout",
            displayName: "tempo.mrc",
            kind: "workout",
            extension: "mrc",
            byteSize: 420,
            status: "ready",
            preview: {
              kind: "workout",
              sourceFormat: "mrc",
              selectedWorkoutId: "tempo",
              workouts: [
                {
                  workoutId: "tempo",
                  title: "Tempo 3 × 12",
                  durationSeconds: 3_840,
                  target: "88–92% FTP",
                  purpose: "Sustainable power",
                },
              ],
            },
          },
        ],
      },
    };
    let delivered = planningDelivery();
    const create = vi.fn(async (request: CreateWorkoutPlanningRequestRpcParams) => {
      delivered = {
        ...delivered,
        requestId: request.requestId,
        source: delivered.source === null ? null : { ...delivered.source, ...request.source },
        planningRequest:
          delivered.planningRequest === null
            ? null
            : {
                ...delivered.planningRequest,
                requestId: request.requestId,
                source: {
                  ...delivered.planningRequest.source,
                  chatId: request.source.chatId,
                  messageId: request.source.messageId,
                },
              },
      };
      return { status: "accepted" as const, delivery: delivered };
    });
    const fake = client(replies(), {
      composer: async () => surface,
      listPlanningRequests: async () => ({ deliveries: [] }),
      createWorkoutPlanningRequest: create,
    });
    const { controller, controls, openPlanningRequest } = subject(fake);
    await controller.start();

    controller.reviewAttachmentInPlan("attachment-workout");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const createdRequestId = create.mock.calls[0]![0].requestId;
    await vi.waitFor(() =>
      expect(openPlanningRequest).toHaveBeenCalledWith("desktop", createdRequestId),
    );
    expect(vi.mocked(fake.call)).toHaveBeenCalledWith(
      "createWorkoutPlanningRequest",
      expect.objectContaining({
        requestId: expect.any(String),
        intent: "Review Tempo 3 × 12 in Plan.",
        source: {
          chatId: "desktop",
          messageId: expect.any(String),
          attachmentId: "attachment-workout",
        },
      }),
    );
    expect(controls.at(-1)?.planningRequests?.value).toContainEqual(delivered);
  });

  it("resumes durable Plan handoffs before restoring their Chat cards", async () => {
    const order: string[] = [];
    const restored = planningDelivery();
    const resumePlanningRequests = vi.fn(async () => {
      order.push("resume");
      return { deliveries: [restored] };
    });
    const listPlanningRequests = vi.fn(async () => {
      order.push("list");
      return { deliveries: [restored] };
    });
    const fake = client(replies(), { resumePlanningRequests, listPlanningRequests });
    const { controller, controls } = subject(fake);

    await controller.start();

    expect(order).toEqual(["resume", "list"]);
    expect(resumePlanningRequests).toHaveBeenCalledOnce();
    expect(controls.at(-1)?.planningRequests).toMatchObject({
      loaded: true,
      error: null,
      value: [restored],
    });
  });

  it("restores an open Card and blocks coaching work", async () => {
    const planCreation = {
      creationId: "01J00000000000000000000000",
      version: 1,
      status: "in-progress" as const,
      answeredSummaries: [],
      openQuestion: { kind: "goal-question" as const, prompt: "Goal?", candidates: [] },
    };
    const fake = client(replies(), {
      listPlanningRequests: async () => ({ deliveries: [], planCreation }),
    });
    const { controller, controls } = subject(fake);
    await controller.start();
    expect(controls.at(-1)?.planCreation).toMatchObject({ loaded: true, value: planCreation });
    await expect(controller.submit("blocked")).resolves.toBe(false);
    expect(chatMessages(fake)).toEqual([]);
  });

  it("does not start Plan Creation while a Coach decision blocks work", async () => {
    const startPlanCreation = vi.fn<
      (request: PlanCreationStartRpcParams) => Promise<PlanCreationStartRpcResult>
    >();
    const fake = client(replies(), {
      getCoachDecision: async () => ({
        decision: {
          decisionId: "decision-1",
          chatId: "desktop",
          messageId: "message-1",
          question: "Choose tomorrow's priority.",
          status: "unanswered",
          options: [],
        },
      }),
      listPlanningRequests: async () => ({ deliveries: [], planCreation: null }),
      startPlanCreation,
    });
    const { controller } = subject(fake);

    await controller.start();
    await controller.startPlanCreation();

    expect(startPlanCreation).not.toHaveBeenCalled();
  });

  it("waits for Plan Creation restoration before queue drains and submissions", async () => {
    const restoredMessage: QueuedChatMessage = {
      queuedMessageId: "queued-restored",
      messageId: "message-restored",
      submissionId: "submission-restored",
      text: "Keep this queued",
      kind: "ordinary",
      attachmentIds: [],
      position: 0,
      restored: true,
    };
    const restoredQueue: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 4,
      items: [restoredMessage],
    };
    const planCreation: PlanCreationCardModel = {
      creationId: "01J00000000000000000000000",
      version: 1,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "Goal?", candidates: [] },
    };
    let finishPlanningLoad!: (result: {
      deliveries: readonly PlanningRequestDelivery[];
      planCreation: PlanCreationCardModel | null;
    }) => void;
    const planningLoad = new Promise<{
      deliveries: readonly PlanningRequestDelivery[];
      planCreation: PlanCreationCardModel | null;
    }>((resolve) => {
      finishPlanningLoad = resolve;
    });
    const getChatQueue = vi.fn(async () => restoredQueue);
    const getCoachDecision = vi.fn(async () => ({ decision: null }));
    const resumeChatQueue = vi.fn(async () => ({
      snapshot: { schemaVersion: 1 as const, revision: 5, items: [] },
    }));
    const enqueueChatMessage = vi.fn(async () => restoredQueue);
    const fake = client(replies(), {
      getChatQueue,
      getCoachDecision,
      resumeChatQueue,
      enqueueChatMessage,
      listPlanningRequests: async () => planningLoad,
    });
    const { controller, states, controls } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => true,
      true,
      vi.fn(),
      restoredQueue,
    );

    const starting = controller.start();
    const submission = controller.submit("Do not enqueue this yet");
    await vi.waitFor(() => {
      expect(getChatQueue).toHaveBeenCalledOnce();
      expect(getCoachDecision).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(resumeChatQueue).not.toHaveBeenCalled();
    expect(enqueueChatMessage).not.toHaveBeenCalled();

    finishPlanningLoad({ deliveries: [], planCreation });
    await expect(submission).resolves.toBe(false);
    await starting;

    expect(resumeChatQueue).not.toHaveBeenCalled();
    expect(enqueueChatMessage).not.toHaveBeenCalled();
    expect(states.at(-1)?.queued).toEqual([
      {
        id: "queued-restored",
        text: "Keep this queued",
        command: false,
        restored: true,
        attachmentIds: [],
      },
    ]);
    expect(controls.at(-1)?.planCreation).toMatchObject({ loaded: true, value: planCreation });
  });

  it("retries Card commands with stable ids, installs monotonically, and unblocks Chat", async () => {
    const goalCard: PlanCreationCardModel = {
      creationId: "01J00000000000000000000000",
      version: 1,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "Goal?", candidates: [] },
    };
    const completeCard: PlanCreationCardModel = {
      ...goalCard,
      version: 2,
      answeredSummaries: [{ answerKey: "goal", title: "Goal", detail: "Build power" }],
      openQuestion: null,
    };
    const listPlanningRequests = vi
      .fn()
      .mockResolvedValueOnce({ deliveries: [], planCreation: null })
      .mockResolvedValue({ deliveries: [], planCreation: goalCard });
    const startPlanCreation = vi
      .fn<(request: PlanCreationStartRpcParams) => Promise<PlanCreationStartRpcResult>>()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValue({ status: "started", outcome: "created", planCreation: goalCard });
    const answerPlanCreation = vi
      .fn<(request: PlanCreationAnswerRpcParams) => Promise<PlanCreationAnswerRpcResult>>()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValue({ status: "answered", planCreation: completeCard });
    const fake = client(replies(), {
      listPlanningRequests,
      startPlanCreation,
      answerPlanCreation,
    });
    const { controller, controls } = subject(fake);
    await controller.start();
    await controller.startPlanCreation();
    await controller.startPlanCreation();
    expect(startPlanCreation.mock.calls[0]?.[0].commandId).toBe(
      startPlanCreation.mock.calls[1]?.[0].commandId,
    );
    const answer = {
      kind: "goal" as const,
      goal: { kind: "fitness" as const, outcome: "Build power" },
    };
    await controller.answerPlanCreation(answer);
    await controller.answerPlanCreation(answer);
    expect(answerPlanCreation.mock.calls[0]?.[0].commandId).toBe(
      answerPlanCreation.mock.calls[1]?.[0].commandId,
    );
    expect(controls.at(-1)?.planCreation?.value).toEqual(completeCard);
    controller.refreshPlanningRequests();
    await vi.waitFor(() => expect(listPlanningRequests).toHaveBeenCalledTimes(2));
    expect(controls.at(-1)?.planCreation?.value).toEqual(completeCard);
    await expect(controller.submit("Chat continues")).resolves.toBe(true);
    expect(chatMessages(fake)).toEqual(["Chat continues"]);
  });

  it("clears and replaces server-authoritative Plan Creation cards", async () => {
    const first: PlanCreationCardModel = {
      creationId: "01J00000000000000000000000",
      version: 4,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "First goal?", candidates: [] },
    };
    const replacement: PlanCreationCardModel = {
      creationId: "01J00000000000000000000001",
      version: 1,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "Replacement goal?", candidates: [] },
    };
    const listPlanningRequests = vi
      .fn()
      .mockResolvedValueOnce({ deliveries: [], planCreation: first })
      .mockResolvedValueOnce({ deliveries: [], planCreation: replacement })
      .mockResolvedValueOnce({ deliveries: [], planCreation: null });
    const fake = client(replies(), { listPlanningRequests });
    const { controller, controls } = subject(fake);

    await controller.start();
    expect(controls.at(-1)?.planCreation?.value).toEqual(first);
    controller.refreshPlanningRequests();
    await vi.waitFor(() => expect(listPlanningRequests).toHaveBeenCalledTimes(2));
    expect(controls.at(-1)?.planCreation?.value).toEqual(replacement);
    controller.refreshPlanningRequests();
    await vi.waitFor(() => expect(listPlanningRequests).toHaveBeenCalledTimes(3));
    expect(controls.at(-1)?.planCreation?.value).toBeNull();
  });

  it("keeps interrupted recovery inert while a Plan Creation question is open", async () => {
    const planCreation: PlanCreationCardModel = {
      creationId: "01J00000000000000000000000",
      version: 1,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "Goal?", candidates: [] },
    };
    const listPlanningRequests = vi
      .fn()
      .mockResolvedValueOnce({ deliveries: [], planCreation: null })
      .mockResolvedValueOnce({ deliveries: [], planCreation });
    const resumeChatQueue = vi.fn(async () =>
      Promise.reject(new CoachClientDisconnectedError(1006, "synthetic")),
    );
    const fake = client(replies(), { listPlanningRequests, resumeChatQueue });
    const { controller, provider, states, controls } = subject(fake);

    await controller.start();
    await controller.submit("Interrupt this message");
    expect(states.at(-1)).toMatchObject({ status: "interrupted", retryRequired: null });
    controller.refreshPlanningRequests();
    await vi.waitFor(() => expect(controls.at(-1)?.planCreation?.value).toEqual(planCreation));

    await controller.retryInterrupted();

    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(resumeChatQueue).toHaveBeenCalledOnce();
  });

  it("keeps the last safe Plan cards when relaunch recovery cannot deliver", async () => {
    const restored = planningDelivery("failed");
    const resumePlanningRequests = vi.fn(async () => {
      throw new Error("planning unavailable");
    });
    const listPlanningRequests = vi.fn(async () => ({ deliveries: [restored] }));
    const fake = client(replies(), { resumePlanningRequests, listPlanningRequests });
    const { controller, controls } = subject(fake);

    await controller.start();

    expect(resumePlanningRequests).toHaveBeenCalledOnce();
    expect(listPlanningRequests).toHaveBeenCalledOnce();
    expect(controls.at(-1)?.planningRequests).toMatchObject({
      loaded: false,
      error: expect.any(String),
      value: [restored],
    });
  });

  it("retries one saved failed Plan request without changing its identity", async () => {
    const failed = planningDelivery("failed");
    const delivered = planningDelivery();
    const retry = vi.fn(async () => ({ status: "found" as const, delivery: delivered }));
    const fake = client(replies(), {
      listPlanningRequests: async () => ({ deliveries: [failed] }),
      retryPlanningRequest: retry,
    });
    const { controller, openPlanningRequest } = subject(fake);
    await controller.start();

    controller.retryPlanningRequest(failed.requestId);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(vi.mocked(fake.call)).toHaveBeenCalledWith("retryPlanningRequest", {
      requestId: failed.requestId,
    });
    await vi.waitFor(() =>
      expect(openPlanningRequest).toHaveBeenCalledWith("desktop", failed.requestId),
    );
  });

  it("retries an uncertain new Plan request with the same request and message identity", async () => {
    const surface: ChatAttachmentComposerReadModel = {
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
          checkedAt: "1998-08-26T00:00:00.000Z",
        },
      },
      draft: {
        schemaVersion: 1,
        chatId: "desktop",
        text: "",
        state: "active",
        updatedAt: "1998-08-26T00:00:00.000Z",
        attachments: [
          {
            schemaVersion: 1,
            attachmentId: "attachment-workout",
            displayName: "tempo.mrc",
            kind: "workout",
            extension: "mrc",
            byteSize: 420,
            status: "ready",
            preview: {
              kind: "workout",
              sourceFormat: "mrc",
              selectedWorkoutId: "tempo",
              workouts: [
                {
                  workoutId: "tempo",
                  title: "Tempo 3 × 12",
                  durationSeconds: 3_840,
                  target: "88–92% FTP",
                  purpose: "Sustainable power",
                },
              ],
            },
          },
        ],
      },
    };
    let attempt = 0;
    const create = vi.fn(async (request: CreateWorkoutPlanningRequestRpcParams) => {
      attempt += 1;
      if (attempt === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
      const delivery = planningDelivery();
      return {
        status: "accepted" as const,
        delivery: {
          ...delivery,
          requestId: request.requestId,
          source: delivery.source === null ? null : { ...delivery.source, ...request.source },
          planningRequest:
            delivery.planningRequest === null
              ? null
              : {
                  ...delivery.planningRequest,
                  requestId: request.requestId,
                  source: {
                    ...delivery.planningRequest.source,
                    chatId: request.source.chatId,
                    messageId: request.source.messageId,
                  },
                },
        },
      };
    });
    const fake = client(replies(), {
      composer: async () => surface,
      listPlanningRequests: async () => ({ deliveries: [] }),
      createWorkoutPlanningRequest: create,
    });
    const { controller, openPlanningRequest } = subject(fake);
    await controller.start();

    controller.reviewAttachmentInPlan("attachment-workout");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    controller.retryPlanningRequestLoad();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    await vi.waitFor(() =>
      expect(openPlanningRequest).toHaveBeenCalledWith(
        "desktop",
        create.mock.calls[0]![0].requestId,
      ),
    );
  });

  it("retries an uncertain text-only Plan handoff with the same durable payload", async () => {
    let attempt = 0;
    const create = vi.fn(async (request: CreatePlanningRequestRpcParams) => {
      attempt += 1;
      if (attempt === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
      const payload = request.payload;
      const delivery: PlanningRequestDelivery = {
        requestId: payload.requestId,
        source: {
          kind: payload.kind,
          intent: payload.intent,
          chatId: payload.source.chatId,
          messageId: payload.source.messageId,
          attachmentId: null,
        },
        state: "delivered",
        attemptCount: 2,
        failureCode: null,
        retryable: false,
        createdAtMs: 1,
        updatedAtMs: 2,
        deliveredAtMs: 2,
        planningRequest: {
          requestId: payload.requestId,
          kind: payload.kind,
          target: "active_plan",
          intent: payload.intent,
          planConversationId: null,
          proposalId: null,
          requestedDateKey: 20260829,
          resolvedDateKey: null,
          source: { chatId: "desktop", messageId: "turn-1", available: true },
          lifecycle: "open",
          attention: "none",
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 2,
          terminalResult: null,
        },
      };
      return { status: "accepted" as const, delivery };
    });
    const fake = client(replies(), {
      listPlanningRequests: async () => ({ deliveries: [] }),
      createPlanningRequest: create,
    });
    const { controller, openPlanningRequest } = subject(fake);
    await controller.start();

    controller.continueMessageInPlan("turn-1", {
      kind: "plan_change",
      title: "Review a lighter Friday",
      intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
      requestedDate: "2026-08-29",
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    controller.retryPlanningRequestLoad();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    expect(create.mock.calls[0]![0]).toMatchObject({
      payload: {
        kind: "plan_change",
        intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
        source: { chatId: "desktop", messageId: "turn-1" },
        sourceSnapshot: { attachment: null, selectedWorkout: null },
        requestedDate: "2026-08-29",
      },
    });
    await vi.waitFor(() =>
      expect(openPlanningRequest).toHaveBeenCalledWith(
        "desktop",
        create.mock.calls[0]![0].payload.requestId,
      ),
    );
  });

  it("serializes the latest durable draft save before enqueueing Send", async () => {
    let releaseSave!: () => void;
    const saved = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const order: string[] = [];
    const fake = client(
      async () => {
        order.push("chat");
        return { text: "Done" };
      },
      {
        saveAttachmentDraftText: async () => {
          order.push("save-start");
          await saved;
          order.push("save-end");
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
                checkedAt: "2026-08-26T00:00:00.000Z",
              },
            },
            draft: null,
          };
        },
      },
    );
    const { controller } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => true,
      false,
    );
    controller.saveAttachmentDraftText("Latest draft");
    const submission = controller.submit("Latest draft");
    await vi.waitFor(() => expect(order).toEqual(["save-start"]));
    releaseSave();
    await submission;
    expect(order).toEqual(["save-start", "save-end", "chat"]);
  });

  it("starts one exact session probe and deduplicates repeated starts", async () => {
    const fake = client(async () => ({ text: "unused" }), {
      hasSession: async () => ({ hasSession: true }),
    });
    const { controller, states } = subject(fake);

    const first = controller.start();
    const duplicate = controller.start();

    expect(duplicate).toBe(first);
    await first;
    expect(vi.mocked(fake.call).mock.calls).toEqual([
      ["getCoachDecision", { chatId: "desktop" }],
      ["hasSession", { chatId: "desktop" }],
    ]);
    expect(states.at(-1)?.session.presence).toBe("present");
  });

  it("keeps reset unavailable after an absent probe and exposes no probe failure", async () => {
    const absent = client(async () => ({ text: "unused" }));
    const first = subject(absent);
    await first.controller.start();
    expect(first.states.at(-1)?.session.presence).toBe("absent");
    expect(first.controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(first.controller.openNewConversation()).toBe(false);
    expect(first.provider.reconnect).not.toHaveBeenCalled();

    const failed = client(async () => ({ text: "unused" }), {
      hasSession: async () => Promise.reject(new Error("private probe detail")),
    });
    const second = subject(failed);
    await second.controller.start();
    expect(second.states.at(-1)?.session).toEqual(EMPTY_CHAT_STATE.session);
    expect(second.provider.reconnect).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(failed.call)
        .mock.calls.filter(([method]) => method !== "hasSession" && method !== "getCoachDecision"),
    ).toEqual([]);
  });

  it("does not project local content before durable admission succeeds", async () => {
    const fake = client(async () => ({ text: "unused" }));
    const { controller, provider, states, controls } = subject(fake);
    await controller.start();

    let rejectClient!: (reason?: unknown) => void;
    const clientGate = new Promise<CoachClient>((_resolve, reject) => {
      rejectClient = reject;
    });
    vi.mocked(provider.getClient).mockReturnValueOnce(clientGate);

    const submission = controller.submit("Keep this visible");
    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(controller.openNewConversation()).toBe(false);

    rejectClient(new Error("synthetic pre-client failure"));
    await expect(submission).rejects.toThrow("synthetic pre-client failure");

    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(controller.openNewConversation()).toBe(false);
    expect(states.at(-1)?.session).toMatchObject({ presence: "absent", resetPhase: "idle" });
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "chat")).toEqual([]);
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );
  });

  it("ignores a delayed false probe after a locally completed chat", async () => {
    let resolveProbe!: (value: { hasSession: boolean }) => void;
    const probe = new Promise<{ hasSession: boolean }>((resolve) => {
      resolveProbe = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      { hasSession: async () => probe },
    );
    const { controller, states, controls } = subject(fake);

    const starting = controller.start();
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(false));
    await controller.submit("Continue");
    resolveProbe({ hasSession: false });
    await starting;

    expect(states.at(-1)?.session.presence).toBe("present");
    expect(controller.openNewConversation()).toBe(true);
  });

  it("ignores a delayed true probe after a successful reset", async () => {
    let resolveProbe!: (value: { hasSession: boolean }) => void;
    const probe = new Promise<{ hasSession: boolean }>((resolve) => {
      resolveProbe = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      {
        hasSession: async () => probe,
        resetSession: async () => ({ memoryFlushed: true }),
      },
    );
    const { controller, states, controls } = subject(fake);

    const starting = controller.start();
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(false));
    await controller.submit("Continue");
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();
    resolveProbe({ hasSession: true });
    await starting;

    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);
  });

  it("rejects confirmation while chat streaming or terminal refresh is active", async () => {
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fake = client(async (_request, options) => {
      await chatGate;
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, refresh } = subject(fake, fake, () => refreshGate);

    const submission = controller.submit("Continue");
    await Promise.resolve();
    expect(controller.openNewConversation()).toBe(false);
    releaseChat();
    while (refresh.mock.calls.length === 0) await Promise.resolve();
    expect(controller.openNewConversation()).toBe(false);
    releaseRefresh();
    await submission;
    expect(controller.openNewConversation()).toBe(true);
  });

  it("keeps reset unavailable until every accepted chat cleanup settles", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fake = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, provider, states, controls, refresh } = subject(
      fake,
      fake,
      () => refreshGate,
    );

    const chatA = controller.submit("Chat A");
    while (refresh.mock.calls.length === 0) await Promise.resolve();
    expect(states.at(-1)?.status).toBe("idle");

    vi.mocked(provider.getClient).mockRejectedValueOnce(new Error("synthetic admission failure"));
    const chatB = controller.submit("Chat B");
    await expect(chatB).rejects.toThrow("synthetic admission failure");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(controller.openNewConversation()).toBe(false);
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );

    releaseRefresh();
    await chatA;

    await vi.waitFor(() => expect(controls.at(-1)?.newConversationDisabled).toBe(false));
    expect(controller.openNewConversation()).toBe(true);
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );
  });

  it("blocks new conversation until durable retry resolves, then confirmation blocks submit", async () => {
    let attempt = 0;
    const fake = client(async (_request, options) => {
      attempt += 1;
      if (attempt === 1) {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw new CoachClientDisconnectedError(1006, "synthetic");
      }
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller, states } = subject(fake);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(false);
    expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
    await controller.retryQueuedTurn("claim-1");
    expect(controller.openNewConversation()).toBe(true);
    vi.mocked(fake.call).mockClear();

    await Promise.all([controller.submit("Blocked"), controller.retryInterrupted()]);
    expect(fake.call).not.toHaveBeenCalled();

    controller.cancelNewConversation();
    expect(controller.openNewConversation()).toBe(true);
    controller.cancelNewConversation();
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );
  });

  it.each([
    [true, NEW_CONVERSATION_SUCCESS_COPY],
    [false, NEW_CONVERSATION_MEMORY_WARNING_COPY],
  ] as const)(
    "clears only after reset success when memoryFlushed is %s",
    async (memoryFlushed, announcement) => {
      let settleReset!: (value: { memoryFlushed: boolean }) => void;
      const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
        settleReset = resolve;
      });
      const fake = client(
        async (_request, options) => {
          deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
          options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
          return { text: "Done" };
        },
        { resetSession: async () => resetGate },
      );
      const { controller, states, refreshSpend } = subject(fake);
      await controller.submit("Original");
      const transcript = states.at(-1)?.messages;
      refreshSpend.mockClear();
      expect(controller.openNewConversation()).toBe(true);

      const first = controller.confirmNewConversation();
      const duplicate = controller.confirmNewConversation();
      expect(duplicate).toBe(first);
      await Promise.resolve();
      expect(
        vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
      ).toEqual([["resetSession", { chatId: "desktop" }]]);
      expect(states.at(-1)?.messages).toEqual(transcript);
      expect(states.at(-1)?.session.resetPhase).toBe("resetting");

      settleReset({ memoryFlushed });
      await first;
      expect(states.at(-1)).toMatchObject({
        status: "idle",
        messages: [],
        activeTurn: null,
        progress: null,
        session: {
          presence: "absent",
          resetPhase: "idle",
          announcement,
        },
      });
      expect(refreshSpend).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error("private reset detail"),
    new CoachClientCallTimeoutError("resetSession", 660_000),
    new CoachClientDisconnectedError(1006, "synthetic"),
    new CoachClientProtocolError(),
  ])("preserves conversation and blocks a second reset after $name", async (failure) => {
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      { resetSession: async () => Promise.reject(failure) },
    );
    const { controller, states } = subject(fake);
    await controller.submit("Original");
    const before = structuredClone(states.at(-1)!);
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();

    expect(states.at(-1)).toMatchObject({
      status: before.status,
      messages: before.messages,
      activeTurn: before.activeTurn,
      progress: before.progress,
      session: {
        presence: "present",
        resetPhase: "uncertain",
        announcement: NEW_CONVERSATION_UNCERTAIN_COPY,
      },
    });
    expect(controller.openNewConversation()).toBe(false);
    await controller.confirmNewConversation();
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toHaveLength(1);
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "hasSession"),
    ).toHaveLength(0);
  });

  it("keeps the visible conversation and attachment draft when durable draft clearing fails", async () => {
    const surface = imageComposer(true);
    const clearAttachmentDraft = vi.fn(async () => {
      throw new Error("private attachment clear failure");
    });
    const fake = client(replies(), {
      composer: async () => surface,
      resetSession: async () => ({ memoryFlushed: true }),
      clearAttachmentDraft,
    });
    const { controller, states, controls } = subject(fake);
    await controller.start();
    await controller.submit("Original");
    const beforeMessages = structuredClone(states.at(-1)?.messages);
    expect(controller.openNewConversation()).toBe(true);

    await controller.confirmNewConversation();

    expect(states.at(-1)).toMatchObject({
      messages: beforeMessages,
      session: {
        presence: "present",
        resetPhase: "uncertain",
        announcement: NEW_CONVERSATION_UNCERTAIN_COPY,
      },
    });
    expect(controls.at(-1)?.attachments?.value).toEqual(surface);
    expect(clearAttachmentDraft).toHaveBeenCalledOnce();
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toHaveLength(1);
  });

  it("blocks reset while a durable retry is unresolved and preserves retry ownership", async () => {
    let attempt = 0;
    const fake = client(
      async (_request, options) => {
        attempt += 1;
        if (attempt === 1) {
          deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
          throw new CoachClientDisconnectedError(1006, "synthetic");
        }
        deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 2,
          result: { text: "Recovered" },
        });
        return { text: "Recovered" };
      },
      { resetSession: async () => Promise.reject(new Error("uncertain")) },
    );
    const { controller, provider, states } = subject(fake);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(false);
    await controller.confirmNewConversation();
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );
    expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1");
    await controller.retryQueuedTurn("claim-1");

    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
  });

  it("holds one reset pending while repeated confirm, submit, and retry dispatch no chat", async () => {
    let settleReset!: (value: { memoryFlushed: boolean }) => void;
    const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
      settleReset = resolve;
    });
    const fake = client(replies(), { resetSession: async () => resetGate });
    const { controller } = subject(fake);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    vi.mocked(fake.call).mockClear();

    const reset = controller.confirmNewConversation();
    const duplicate = controller.confirmNewConversation();
    await Promise.all([controller.submit("Blocked"), controller.retryInterrupted()]);
    await Promise.resolve();

    expect(duplicate).toBe(reset);
    expect(vi.mocked(fake.call).mock.calls).toEqual([["resetSession", { chatId: "desktop" }]]);
    settleReset({ memoryFlushed: true });
    await reset;
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "chat")).toEqual([]);
  });

  it("fences late probe and reset settlements after dispose without refreshing spend", async () => {
    let settleProbe!: (value: { hasSession: boolean }) => void;
    let settleReset!: (value: { memoryFlushed: boolean }) => void;
    const probeGate = new Promise<{ hasSession: boolean }>((resolve) => {
      settleProbe = resolve;
    });
    const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
      settleReset = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      {
        hasSession: async () => probeGate,
        resetSession: async () => resetGate,
      },
    );
    const { controller, states, controls, refreshSpend } = subject(fake);
    const starting = controller.start();
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(false));
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    refreshSpend.mockClear();
    const resetting = controller.confirmNewConversation();
    await Promise.resolve();
    const renderCount = states.length;
    controller.dispose();

    settleProbe({ hasSession: true });
    settleReset({ memoryFlushed: true });
    await Promise.all([starting, resetting]);

    expect(states).toHaveLength(renderCount);
    expect(refreshSpend).not.toHaveBeenCalled();
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "hasSession"),
    ).toHaveLength(1);
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toHaveLength(1);
  });
});
