import { describe, expect, it, vi } from "vitest";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import type { TurnEvent } from "@enduragent/coach-contract";
import { createChatController } from "../src/chat/controller";
import type { TranscriptPage } from "../src/chat/hydration";
import { CHAT_WORKING_COPY, type ChatState } from "../src/turn-state";

function transcriptPage(turnId: string, nextCursor: string | null = null): TranscriptPage {
  return {
    schemaVersion: 1,
    status: "page",
    turns: [
      {
        turnId,
        completedAt: "2001-01-01T00:00:00.000Z",
        athleteText: `Athlete ${turnId}`,
        coachText: `Coach ${turnId}`,
      },
    ],
    nextCursor,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function emptyAttachmentComposer() {
  return {
    schemaVersion: 1 as const,
    capabilities: {
      schemaVersion: 1 as const,
      active: { provider: "test", model: "text-only", transport: "test" },
      documents: { enabled: true as const, extensions: ["pdf", "txt", "csv", "docx"] as const },
      completedActivities: { enabled: true as const, extensions: ["fit", "tcx", "gpx"] as const },
      plannedWorkouts: { enabled: true as const, extensions: ["zwo", "erg", "mrc"] as const },
      images: {
        enabled: false as const,
        mediaTypes: [] as const,
        reason: "model_incompatible" as const,
        source: "maintained_catalogue" as const,
        checkedAt: "2001-01-01T00:00:00.000Z",
      },
    },
    draft: null,
  };
}

function coachClient(input: {
  readonly hasSession?: boolean;
  readonly resetSession?: () => Promise<{ memoryFlushed: boolean }>;
  readonly chat?: (
    options: CoachClientCallOptions<"chat"> | undefined,
  ) => Promise<{ text: string }>;
}): CoachClient {
  let revision = 0;
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
  return {
    handshake: {} as CoachClient["handshake"],
    call: vi.fn((method, request, options) => {
      if (method === "hasSession") {
        return Promise.resolve({ hasSession: input.hasSession ?? false }) as never;
      }
      if (method === "resetSession") {
        return (input.resetSession?.() ?? Promise.resolve({ memoryFlushed: true })) as never;
      }
      if (method === "getCoachDecision") {
        return Promise.resolve({ decision: null }) as never;
      }
      if (method === "getChatAttachmentComposer") {
        return Promise.resolve(emptyAttachmentComposer()) as never;
      }
      if (method === "clearChatAttachmentDraft") {
        return Promise.resolve(emptyAttachmentComposer()) as never;
      }
      if (method === "getChatQueue") {
        return Promise.resolve({
          schemaVersion: 1,
          revision,
          items: queued === undefined ? [] : [queued],
        }) as never;
      }
      if (method === "listPlanningRequests") {
        return Promise.resolve({ deliveries: [], planCreation: null }) as never;
      }
      if (method === "resumePlanningRequests") {
        return Promise.resolve({ deliveries: [] }) as never;
      }
      if (method === "enqueueChatMessage") {
        const value = request as { submissionId: string; text: string };
        revision += 1;
        queued = {
          queuedMessageId: `queued-${revision}`,
          submissionId: value.submissionId,
          text: value.text,
          kind: "ordinary",
          position: 0,
          restored: false,
        };
        return Promise.resolve({ schemaVersion: 1, revision, items: [queued] }) as never;
      }
      if (method === "resumeChatQueue" && input.chat !== undefined) {
        const queueOptions = {
          ...(options as CoachClientCallOptions<"chat">),
          requestMethod: "resumeChatQueue" as const,
        };
        return input.chat(queueOptions).then((response) => {
          revision += 1;
          queued = undefined;
          return { snapshot: { schemaVersion: 1, revision, items: [] }, response };
        }) as never;
      }
      if (method === "chat" && input.chat !== undefined) {
        return input.chat(options as CoachClientCallOptions<"chat">) as never;
      }
      throw new TypeError();
    }),
    close: vi.fn(async () => {}),
  };
}

function deliver(options: CoachClientCallOptions<"chat"> | undefined, event: TurnEvent): void {
  const requestMethod = (
    options as (CoachClientCallOptions<"chat"> & { requestMethod?: "resumeChatQueue" }) | undefined
  )?.requestMethod;
  options?.onNotificationEnvelope?.({
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: {
      requestId: 1,
      requestMethod: requestMethod ?? "chat",
      turnId: event.turnId,
      event,
    },
  });
  options?.onEvent?.(event);
}

function subject(input: {
  readonly client: CoachClient;
  readonly readTranscriptPage: (request: {
    cursor: string | null;
    limit: number;
  }) => Promise<TranscriptPage>;
  readonly canChat?: () => boolean;
}) {
  const states: ChatState[] = [];
  const controls: Array<
    Parameters<Parameters<typeof createChatController>[0]["view"]["render"]>[1]
  > = [];
  const controller = createChatController({
    clients: {
      getClient: vi.fn(async () => input.client),
      reconnect: vi.fn(async () => input.client),
      close: vi.fn(async () => {}),
    },
    view: {
      render(state, nextControls) {
        states.push(structuredClone(state));
        controls.push(structuredClone(nextControls));
      },
    },
    refreshTrainingContext: vi.fn(async () => {}),
    refreshSpend: vi.fn(async () => {}),
    readTranscriptPage: input.readTranscriptPage,
    canChat: input.canChat ?? (() => true),
  });
  return { controller, states, controls };
}

describe("chat controller transcript hydration", () => {
  it("defers transcript and session hydration until chat becomes available", async () => {
    let ready = false;
    const client = coachClient({ hasSession: true });
    const readTranscriptPage = vi.fn(async () => transcriptPage("turn-1"));
    const { controller, states } = subject({
      client,
      readTranscriptPage,
      canChat: () => ready,
    });

    await controller.start();

    expect(readTranscriptPage).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
    expect(states.at(-1)?.messages).toHaveLength(0);

    ready = true;
    await controller.resume();

    await vi.waitFor(() => {
      expect(readTranscriptPage).toHaveBeenCalledTimes(1);
      expect(states.at(-1)?.messages).toHaveLength(2);
    });
    expect(client.call).toHaveBeenCalledTimes(6);
    expect(client.call).toHaveBeenCalledWith("hasSession", { chatId: "desktop" });
    expect(client.call).toHaveBeenCalledWith("getCoachDecision", { chatId: "desktop" });
    expect(client.call).toHaveBeenCalledWith("resumePlanningRequests", {});
    expect(client.call).toHaveBeenCalledWith("listPlanningRequests", { chatId: "desktop" });
  });

  it("renders the first persisted page alongside a still-pending live readiness probe", async () => {
    const session = deferred<{ hasSession: boolean }>();
    const client = coachClient({});
    vi.mocked(client.call).mockImplementation((method) => {
      if (method === "hasSession") return session.promise as never;
      if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
      if (method === "getChatAttachmentComposer") {
        return Promise.resolve(emptyAttachmentComposer()) as never;
      }
      if (method === "getChatQueue")
        return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
      if (method === "listPlanningRequests") {
        return Promise.resolve({ deliveries: [], planCreation: null }) as never;
      }
      throw new TypeError();
    });
    const { controller, states } = subject({
      client,
      readTranscriptPage: async () => transcriptPage("turn-1"),
    });

    const readiness = controller.start();
    await vi.waitFor(() => expect(states.at(-1)?.messages).toHaveLength(2));

    expect(states.at(-1)?.messages).toMatchObject([
      { id: "history:athlete:turn-1", historical: true },
      { id: "history:coach:turn-1", historical: true },
    ]);
    session.resolve({ hasSession: true });
    await readiness;
  });

  it("sends after decision recovery without waiting for transcript hydration", async () => {
    const hydration = deferred<TranscriptPage>();
    const client = coachClient({
      chat: async (options) => {
        deliver(options, { type: "final-text", turnId: "turn-live", text: "Live coach" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          result: { text: "Live coach" },
        });
        return { text: "Live coach" };
      },
    });
    const { controller, states, controls } = subject({
      client,
      readTranscriptPage: () => hydration.promise,
    });
    const starting = controller.start();
    await vi.waitFor(() => expect(controls.at(-1)?.decisionLoading).toBe(false));

    await expect(controller.submit("Live athlete")).resolves.toBe(true);
    await vi.waitFor(() => expect(states.at(-1)?.messages).toHaveLength(2));

    hydration.resolve(transcriptPage("turn-live"));
    await starting;
    await vi.waitFor(() => {
      expect(states.at(-1)?.messages).toHaveLength(2);
      expect(states.at(-1)?.messages.every((message) => message.historical !== true)).toBe(true);
    });
  });

  it("keeps a live in-flight turn visible while a reset signal refreshes persisted history", async () => {
    const recovery = deferred<TranscriptPage>();
    const finishChat = deferred<void>();
    const restart: TranscriptPage = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    const readTranscriptPage = vi
      .fn()
      .mockResolvedValueOnce(transcriptPage("turn-old", "older"))
      .mockResolvedValueOnce(restart)
      .mockImplementationOnce(() => recovery.promise);
    const client = coachClient({
      chat: async (options) => {
        await finishChat.promise;
        deliver(options, { type: "final-text", turnId: "turn-live", text: "Live coach" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          result: { text: "Live coach" },
        });
        return { text: "Live coach" };
      },
    });
    const { controller, states } = subject({ client, readTranscriptPage });
    await controller.start();
    const submission = controller.submit("Live athlete");

    const pagination = controller.loadEarlier();
    await vi.waitFor(() => expect(readTranscriptPage).toHaveBeenCalledTimes(3));

    expect(states.at(-1)).toMatchObject({
      status: "streaming",
      progress: CHAT_WORKING_COPY,
      messages: [
        { role: "athlete", text: "Live athlete" },
        { role: "coach", text: "" },
      ],
    });

    recovery.resolve({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });
    await pagination;
    finishChat.resolve();
    await submission;
  });

  it("clears history-only state on success and rejects a stale in-flight page afterward", async () => {
    const stale = deferred<TranscriptPage>();
    const reset = deferred<{ memoryFlushed: boolean }>();
    const client = coachClient({
      hasSession: true,
      resetSession: () => reset.promise,
    });
    const { controller, states } = subject({
      client,
      readTranscriptPage: () => stale.promise,
    });
    const starting = controller.start();
    await vi.waitFor(() => expect(states.at(-1)?.session.presence).toBe("present"));

    expect(controller.openNewConversation()).toBe(true);
    const resetting = controller.confirmNewConversation();
    reset.resolve({ memoryFlushed: true });
    await resetting;
    expect(states.at(-1)?.messages).toEqual([]);

    stale.resolve(transcriptPage("turn-stale"));
    await starting;
    await vi.waitFor(() => expect(states.at(-1)?.messages).toEqual([]));
  });

  it("opens and clears a new conversation when persisted history is the only visible state", async () => {
    const client = coachClient({ hasSession: false });
    const { controller, states } = subject({
      client,
      readTranscriptPage: async () => transcriptPage("turn-persisted"),
    });
    await controller.start();
    await vi.waitFor(() => expect(states.at(-1)?.messages).toHaveLength(2));

    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();

    expect(states.at(-1)?.messages).toEqual([]);
    expect(states.at(-1)?.session.resetCount).toBe(1);
  });
});
