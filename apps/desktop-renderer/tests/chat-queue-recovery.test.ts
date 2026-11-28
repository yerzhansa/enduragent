import { describe, expect, it, vi } from "vitest";
import type {
  ChatQueueRunResult,
  ChatQueueSnapshot,
  CoachTurnEventNotificationEnvelope,
  TurnEvent,
} from "@enduragent/coach-contract";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import { CoachClientDisconnectedError } from "@enduragent/coach-client";
import { createChatController } from "../src/chat/controller";
import {
  CHAT_QUEUE_REMOVE_FAILURE_COPY,
  type ChatViewControls,
} from "../src/chat/controller-helpers";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import type { ChatState } from "../src/turn-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function notification(
  method: "resumeChatQueue" | "runQueuedCommand" | "retryQueuedTurn",
  event: TurnEvent,
): CoachTurnEventNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: { requestId: 1, requestMethod: method, turnId: event.turnId, event },
  };
}

function deliver(
  method: "resumeChatQueue" | "runQueuedCommand" | "retryQueuedTurn",
  options: CoachClientCallOptions<"chat">,
  event: TurnEvent,
): void {
  options.onNotificationEnvelope?.(notification(method, event));
  options.onEvent?.(event);
}

function harness(
  client: CoachClient,
  canChat: () => boolean = () => true,
  clientProvider?: DesktopCoachClientProvider,
) {
  const states: ChatState[] = [];
  const controls: ChatViewControls[] = [];
  const provider: DesktopCoachClientProvider = clientProvider ?? {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    onConnectionOpen: () => () => {},
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: {
      render: (state, nextControls) => {
        states.push(structuredClone(state));
        if (nextControls !== undefined) controls.push(structuredClone(nextControls));
      },
    },
    refreshTrainingContext: async () => {},
    refreshSpend: async () => {},
    canChat,
  });
  return { controller, states, controls, provider };
}

function ordinaryQueueItem(
  id: number,
  text: string,
  position: number,
): ChatQueueSnapshot["items"][number] {
  return {
    queuedMessageId: `queued-${id}`,
    messageId: `message-${id}`,
    submissionId: `submission-${id}`,
    text,
    kind: "ordinary",
    attachmentIds: [],
    position,
    restored: false,
  };
}

function disconnectedQueueHarness(
  recovered: CoachClient,
  enqueueSnapshots: readonly ChatQueueSnapshot[],
) {
  const activeRun = deferred<ChatQueueRunResult>();
  let activeOptions: CoachClientCallOptions<"chat"> | undefined;
  let disconnected = false;
  let enqueueCount = 0;
  const failed: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call: vi.fn((method, _request, options) => {
      if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
      if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
      if (method === "getChatQueue") {
        return disconnected
          ? (Promise.reject(new CoachClientDisconnectedError(1006, "lost")) as never)
          : (Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never);
      }
      if (method === "enqueueChatMessage") {
        const snapshot = enqueueSnapshots[enqueueCount];
        enqueueCount += 1;
        if (snapshot === undefined) throw new TypeError("Unexpected enqueue");
        return Promise.resolve(snapshot) as never;
      }
      if (method === "resumeChatQueue") {
        activeOptions = options as CoachClientCallOptions<"chat">;
        return activeRun.promise as never;
      }
      throw new TypeError(String(method));
    }),
    close: vi.fn(async () => {}),
  };
  let providerClient = failed;
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => providerClient),
    reconnect: vi.fn(async () => {
      providerClient = recovered;
      return recovered;
    }),
    onConnectionOpen: () => () => {},
    close: vi.fn(async () => {}),
  };
  const subject = harness(failed, () => true, provider);
  return {
    ...subject,
    activeOptions: () => activeOptions,
    disconnect() {
      disconnected = true;
      activeRun.reject(new CoachClientDisconnectedError(1006, "lost"));
    },
  };
}

describe("durable chat queue controller", () => {
  it("projects neither a queue row nor athlete text before durable enqueue acknowledgment", async () => {
    const enqueue = deferred<ChatQueueSnapshot>();
    const run = deferred<ChatQueueRunResult>();
    let runOptions: CoachClientCallOptions<"chat"> | undefined;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "enqueueChatMessage") return enqueue.promise as never;
        if (method === "resumeChatQueue") {
          runOptions = options as CoachClientCallOptions<"chat">;
          return run.promise as never;
        }
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    const submission = controller.submit("Hello");
    await Promise.resolve();
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages).toEqual([]);

    enqueue.resolve({
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          messageId: "message-1",
          submissionId: "submission-1",
          text: "Hello",
          kind: "ordinary",
          attachmentIds: [],
          position: 0,
          restored: false,
        },
      ],
    });
    await vi.waitFor(() => expect(runOptions).toBeDefined());
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Hello" },
      { role: "coach" },
    ]);
    expect(states.at(-1)?.queued).toHaveLength(1);

    const start = { type: "turn-start", turnId: "turn-1", chatId: "desktop" } as const;
    const final = { type: "final-text", turnId: "turn-1", text: "Hi" } as const;
    deliver("resumeChatQueue", runOptions!, start);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    deliver("resumeChatQueue", runOptions!, final);
    runOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    run.resolve({
      snapshot: { schemaVersion: 1, revision: 2, items: [] },
      response: { text: "Hi" },
    });
    await submission;
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Hello" },
      { role: "coach", text: "Hi", delivery: "complete" },
    ]);
  });

  it("uses collision-resistant submission ids across renderer relaunches", async () => {
    const submissionIds: string[] = [];
    let revision = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, request, options) => {
        if (method === "enqueueChatMessage") {
          const input = request as { submissionId: string; text: string };
          submissionIds.push(input.submissionId);
          revision += 1;
          return {
            schemaVersion: 1,
            revision,
            items: [
              {
                queuedMessageId: `queued-${revision}`,
                messageId: `message-${revision}`,
                submissionId: input.submissionId,
                text: input.text,
                kind: "ordinary",
                attachmentIds: [],
                position: 0,
                restored: false,
              },
            ],
          } as never;
        }
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: revision,
            result: {},
          });
          return {
            snapshot: { schemaVersion: 1, revision, items: [] },
          } as never;
        }
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") return { schemaVersion: 1, revision, items: [] } as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const first = harness(client).controller;
    await first.start();
    await first.submit("First launch");
    const second = harness(client).controller;
    await second.start();
    await second.submit("Second launch");
    expect(submissionIds).toHaveLength(2);
    expect(submissionIds[0]).not.toBe(submissionIds[1]);
    expect(submissionIds.every((id) => /^[0-9a-f-]{36}$/u.test(id))).toBe(true);
  });

  it("holds restored commands for Run command and ignores stale snapshots", async () => {
    const restored: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 4,
      items: [
        {
          queuedMessageId: "command-1",
          messageId: "message-command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const calls: string[] = [];
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, _request, options) => {
        calls.push(method);
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") return restored as never;
        if (method === "runQueuedCommand") {
          const stream = options as CoachClientCallOptions<"chat">;
          deliver("runQueuedCommand", stream, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("runQueuedCommand", stream, {
            type: "final-text",
            turnId: "turn-2",
            text: "Review",
          });
          stream.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return {
            snapshot: { schemaVersion: 1, revision: 5, items: [] },
            response: { text: "Review" },
          } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.resume();
    expect(calls).not.toContain("resumeChatQueue");
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1", restored: true }]);

    await controller.runQueuedCommand("command-1");
    expect(calls).toContain("runQueuedCommand");
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("opens New chat for a restored queue-only command", async () => {
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          messageId: "message-command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") return queued as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);

    await controller.start();

    expect(states.at(-1)).toMatchObject({
      messages: [],
      queued: [{ id: "command-1" }],
      session: { presence: "absent" },
    });
    expect(controller.openNewConversation()).toBe(true);
  });

  it("auto-resumes restored ordinary work and discards a blocked no-response run", async () => {
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          messageId: "message-1",
          submissionId: "submission-1",
          text: "Restored",
          kind: "ordinary",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, _request, options) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: true } as never;
        if (method === "getChatQueue") return queued as never;
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: {},
          });
          return { snapshot: queued } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "resumeChatQueue")).toBe(
      true,
    );
    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Restored" }]);
  });

  it("blocks Send after queue hydration fails and recovers through reconnect retry", async () => {
    let queueReads = 0;
    let enqueueCalls = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method, request, options) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: false } as never;
        if (method === "getChatQueue") {
          queueReads += 1;
          if (queueReads === 1) throw new Error("transient queue read failure");
          return { schemaVersion: 1, revision: 0, items: [] } as never;
        }
        if (method === "enqueueChatMessage") {
          enqueueCalls += 1;
          const input = request as { submissionId: string; text: string };
          return {
            schemaVersion: 1,
            revision: 1,
            items: [
              {
                queuedMessageId: "queued-1",
                messageId: "message-1",
                submissionId: input.submissionId,
                text: input.text,
                kind: "ordinary",
                attachmentIds: [],
                position: 0,
                restored: false,
              },
            ],
          } as never;
        }
        if (method === "resumeChatQueue") {
          (options as CoachClientCallOptions<"chat">).onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            result: {},
          });
          return { snapshot: { schemaVersion: 1, revision: 1, items: [] } } as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller } = harness(client);
    await controller.start();
    await expect(controller.submit("Blocked")).resolves.toBe(false);
    expect(enqueueCalls).toBe(0);
    await controller.retryDecision();
    await expect(controller.submit("Allowed")).resolves.toBe(true);
    expect(enqueueCalls).toBe(1);
  });

  it("keeps a queued row visible until durable removal is acknowledged", async () => {
    const removal = deferred<ChatQueueSnapshot>();
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          messageId: "message-command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatQueue") return Promise.resolve(queued) as never;
        if (method === "removeQueuedChatMessage") return removal.promise as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();

    controller.removeQueued("command-1");
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1" }]);

    removal.resolve({ schemaVersion: 1, revision: 2, items: [] });
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
  });

  it("waits for durable queue removal before opening New chat", async () => {
    const removal = deferred<ChatQueueSnapshot>();
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          messageId: "message-command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatQueue") return Promise.resolve(queued) as never;
        if (method === "removeQueuedChatMessage") return removal.promise as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();

    controller.removeQueued("command-1");
    expect(controller.openNewConversation()).toBe(false);

    removal.resolve({ schemaVersion: 1, revision: 2, items: [] });
    await vi.waitFor(() => expect(states.at(-1)?.queued).toEqual([]));
    expect(controller.openNewConversation()).toBe(true);
  });

  it("keeps a queued row and reports visible feedback when durable removal fails", async () => {
    const queued: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "command-1",
          messageId: "message-command-1",
          submissionId: "submission-1",
          text: "/review",
          kind: "slash-command",
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method) => {
        if (method === "getCoachDecision") return { decision: null } as never;
        if (method === "hasSession") return { hasSession: true } as never;
        if (method === "getChatQueue") return queued as never;
        if (method === "removeQueuedChatMessage") throw new Error("storage unavailable");
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, controls } = harness(client);
    await controller.start();

    controller.removeQueued("command-1");
    await vi.waitFor(() =>
      expect(controls.at(-1)?.queueMutationError).toBe(CHAT_QUEUE_REMOVE_FAILURE_COPY),
    );
    expect(states.at(-1)?.queued).toMatchObject([{ id: "command-1" }]);
  });

  it("shows a message queued during streaming and dispatches it exactly once after success", async () => {
    const firstRun = deferred<ChatQueueRunResult>();
    const secondRun = deferred<ChatQueueRunResult>();
    let firstOptions: CoachClientCallOptions<"chat"> | undefined;
    let secondOptions: CoachClientCallOptions<"chat"> | undefined;
    const first = {
      queuedMessageId: "queued-1",
      messageId: "message-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 0,
      restored: false,
    };
    const later = {
      queuedMessageId: "queued-2",
      messageId: "message-2",
      submissionId: "submission-2",
      text: "Later",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 1,
      restored: false,
    };
    let enqueueCount = 0;
    let runCount = 0;
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        if (method === "enqueueChatMessage") {
          enqueueCount += 1;
          return Promise.resolve(
            enqueueCount === 1
              ? { schemaVersion: 1, revision: 1, items: [first] }
              : { schemaVersion: 1, revision: 2, items: [first, later] },
          ) as never;
        }
        if (method === "resumeChatQueue") {
          runCount += 1;
          if (runCount === 1) {
            firstOptions = options as CoachClientCallOptions<"chat">;
            return firstRun.promise as never;
          }
          secondOptions = options as CoachClientCallOptions<"chat">;
          return secondRun.promise as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();

    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(firstOptions).toBeDefined());
    deliver("resumeChatQueue", firstOptions!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });

    await expect(controller.submit("Later")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["Later"]);
    expect(runCount).toBe(1);

    deliver("resumeChatQueue", firstOptions!, {
      type: "final-text",
      turnId: "turn-1",
      text: "First reply",
    });
    firstOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    firstRun.resolve({
      snapshot: { schemaVersion: 1, revision: 3, items: [later] },
      response: { text: "First reply" },
    });

    await vi.waitFor(() => expect(secondOptions).toBeDefined());
    expect(runCount).toBe(2);
    deliver("resumeChatQueue", secondOptions!, {
      type: "turn-start",
      turnId: "turn-2",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", secondOptions!, {
      type: "final-text",
      turnId: "turn-2",
      text: "Later reply",
    });
    secondOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
    secondRun.resolve({
      snapshot: { schemaVersion: 1, revision: 4, items: [] },
      response: { text: "Later reply" },
    });

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("idle"));
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.map((message) => [message.role, message.text])).toEqual([
      ["athlete", "First"],
      ["coach", "First reply"],
      ["athlete", "Later"],
      ["coach", "Later reply"],
    ]);
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "resumeChatQueue"),
    ).toHaveLength(2);
  });

  it("keeps a claimed head hidden when enqueue acknowledges a full durable snapshot", async () => {
    const run = deferred<ChatQueueRunResult>();
    let options: CoachClientCallOptions<"chat"> | undefined;
    const head = {
      queuedMessageId: "queued-1",
      messageId: "message-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 0,
      restored: true,
    };
    const later = {
      queuedMessageId: "queued-2",
      messageId: "message-2",
      submissionId: "submission-2",
      text: "Later",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 1,
      restored: false,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, callOptions) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: true }) as never;
        if (method === "getChatQueue")
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [head] }) as never;
        if (method === "resumeChatQueue") {
          options = callOptions as CoachClientCallOptions<"chat">;
          return run.promise as never;
        }
        if (method === "enqueueChatMessage")
          return Promise.resolve({
            schemaVersion: 1,
            revision: 2,
            items: [head, later],
          }) as never;
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    const active = controller.resume();
    await vi.waitFor(() => expect(options).toBeDefined());
    deliver("resumeChatQueue", options!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    expect(states.at(-1)?.queued).toEqual([]);

    await expect(controller.submit("Later")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.id)).toEqual(["queued-2"]);
    expect(states.at(-1)?.activeQueueClaimIds).toEqual(["queued-1"]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);

    deliver("resumeChatQueue", options!, {
      type: "interrupted",
      turnId: "turn-1",
      chatId: "desktop",
      text: "Partial",
    });
    options!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
    run.resolve({
      snapshot: {
        schemaVersion: 1,
        revision: 3,
        items: [head, later],
        retryRequired: {
          claimId: "claim-1",
          queuedMessageIds: ["queued-1"],
          turnId: "turn-1",
          status: "retry-required",
        },
      },
      response: { text: "Partial" },
    });
    await active;
    expect(states.at(-1)?.queued.map((item) => item.id)).toEqual(["queued-1", "queued-2"]);
    expect(states.at(-1)?.activeQueueClaimIds).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
  });

  it("does not replay a queue-origin turn after the recovered queue shows it completed", async () => {
    const head = ordinaryQueueItem(1, "First", 0);
    const recoveredMethods: string[] = [];
    const recovered: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        recoveredMethods.push(method);
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: 3, items: [] }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, provider, activeOptions, disconnect } = disconnectedQueueHarness(
      recovered,
      [{ schemaVersion: 1, revision: 1, items: [head] }],
    );
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions()).toBeDefined());
    deliver("resumeChatQueue", activeOptions()!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", activeOptions()!, {
      type: "text_delta",
      turnId: "turn-1",
      delta: "Partial",
    });

    disconnect();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    await controller.retryInterrupted();

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(recoveredMethods).toEqual(["getChatQueue"]);
    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.queued).toEqual([]);
    expect(
      states.at(-1)?.messages.map((message) => ({
        role: message.role,
        text: message.text,
        delivery: message.delivery,
      })),
    ).toEqual([
      { role: "athlete", text: "First", delivery: "complete" },
      { role: "coach", text: "Partial", delivery: "interrupted" },
    ]);
  });

  it("resumes a queue-origin turn when recovery still shows its exact unclaimed head", async () => {
    const head = ordinaryQueueItem(1, "First", 0);
    const recoveredMethods: string[] = [];
    const recovered: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        recoveredMethods.push(method);
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: 3, items: [head] }) as never;
        }
        if (method === "resumeChatQueue") {
          const resumeOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", resumeOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", resumeOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Recovered",
          });
          resumeOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 5, items: [] },
            response: { text: "Recovered" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, provider, activeOptions, disconnect } = disconnectedQueueHarness(
      recovered,
      [{ schemaVersion: 1, revision: 1, items: [head] }],
    );
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions()).toBeDefined());
    deliver("resumeChatQueue", activeOptions()!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", activeOptions()!, {
      type: "text_delta",
      turnId: "turn-1",
      delta: "Partial",
    });

    disconnect();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    await controller.retryInterrupted();

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(recoveredMethods).toEqual(["getChatQueue", "resumeChatQueue"]);
    expect(recoveredMethods).not.toContain("chat");
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "coach")
        .map((message) => ({ text: message.text, delivery: message.delivery })),
    ).toEqual([
      { text: "Partial", delivery: "interrupted" },
      { text: "Recovered", delivery: "complete" },
    ]);
  });

  it("drains later ordinary work when a promoted exact retry is already resolved", async () => {
    const head = ordinaryQueueItem(1, "First", 0);
    const later = ordinaryQueueItem(2, "Later", 1);
    const recoveredMethods: string[] = [];
    const recovered: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, request, options) => {
        recoveredMethods.push(method);
        if (method === "getChatQueue") {
          return Promise.resolve({
            schemaVersion: 1,
            revision: 5,
            items: [head, later],
            retryRequired: {
              claimId: "claim-1",
              queuedMessageIds: [head.queuedMessageId],
              turnId: "turn-1",
              status: "retry-required",
            },
          }) as never;
        }
        if (method === "retryQueuedTurn") {
          expect(request).toEqual({ chatId: "desktop", claimId: "claim-1" });
          return Promise.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 7,
              items: [{ ...later, position: 0 }],
            },
          }) as never;
        }
        if (method === "resumeChatQueue") {
          const resumeOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", resumeOptions, {
            type: "turn-start",
            turnId: "turn-3",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", resumeOptions, {
            type: "final-text",
            turnId: "turn-3",
            text: "Later reply",
          });
          resumeOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 3, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 9, items: [] },
            response: { text: "Later reply" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, provider, activeOptions, disconnect } = disconnectedQueueHarness(
      recovered,
      [
        { schemaVersion: 1, revision: 1, items: [head] },
        { schemaVersion: 1, revision: 3, items: [head, later] },
      ],
    );
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions()).toBeDefined());
    deliver("resumeChatQueue", activeOptions()!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", activeOptions()!, {
      type: "text_delta",
      turnId: "turn-1",
      delta: "Partial",
    });
    await expect(controller.submit("Later")).resolves.toBe(true);

    disconnect();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    await controller.retryInterrupted();

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(recoveredMethods).toEqual(["getChatQueue", "retryQueuedTurn", "resumeChatQueue"]);
    expect(recoveredMethods).not.toContain("chat");
    expect(states.at(-1)?.queued).toEqual([]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "athlete")
        .map((message) => message.text),
    ).toEqual(["First", "Later"]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "coach")
        .map((message) => ({ text: message.text, delivery: message.delivery })),
    ).toEqual([
      { text: "Partial", delivery: "interrupted" },
      { text: "Later reply", delivery: "complete" },
    ]);
  });

  it("does not drain when a response-less exact retry leaves its claim unresolved", async () => {
    const head = ordinaryQueueItem(1, "First", 0);
    const later = ordinaryQueueItem(2, "Later", 1);
    const retryRequired = {
      claimId: "claim-1",
      queuedMessageIds: [head.queuedMessageId],
      turnId: "turn-1",
      status: "retry-required" as const,
    };
    const recoveredMethods: string[] = [];
    const recovered: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method) => {
        recoveredMethods.push(method);
        if (method === "getChatQueue") {
          return Promise.resolve({
            schemaVersion: 1,
            revision: 5,
            items: [head, later],
            retryRequired,
          }) as never;
        }
        if (method === "retryQueuedTurn") {
          return Promise.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 6,
              items: [head, later],
              retryRequired,
            },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states, activeOptions, disconnect } = disconnectedQueueHarness(recovered, [
      { schemaVersion: 1, revision: 1, items: [head] },
      { schemaVersion: 1, revision: 3, items: [head, later] },
    ]);
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions()).toBeDefined());
    deliver("resumeChatQueue", activeOptions()!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", activeOptions()!, {
      type: "text_delta",
      turnId: "turn-1",
      delta: "Partial",
    });
    await expect(controller.submit("Later")).resolves.toBe(true);

    disconnect();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    await controller.retryInterrupted();

    expect(recoveredMethods).toEqual(["getChatQueue", "retryQueuedTurn"]);
    expect(states.at(-1)?.retryRequired).toMatchObject({ claimId: "claim-1" });
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["First", "Later"]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "Partial",
      delivery: "interrupted",
    });
  });

  it("reconciles a disconnected queue claim before retrying and drains later work once", async () => {
    const activeRun = deferred<ChatQueueRunResult>();
    let activeOptions: CoachClientCallOptions<"chat"> | undefined;
    let disconnected = false;
    let enqueueCount = 0;
    const head = {
      queuedMessageId: "queued-1",
      messageId: "message-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 0,
      restored: false,
    };
    const laterOne = {
      queuedMessageId: "queued-2",
      messageId: "message-2",
      submissionId: "submission-2",
      text: "Later one",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 1,
      restored: false,
    };
    const laterTwo = {
      queuedMessageId: "queued-3",
      messageId: "message-3",
      submissionId: "submission-3",
      text: "Later two",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 2,
      restored: false,
    };
    const failed: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue") {
          return disconnected
            ? (Promise.reject(new CoachClientDisconnectedError(1006, "lost")) as never)
            : (Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never);
        }
        if (method === "enqueueChatMessage") {
          enqueueCount += 1;
          return Promise.resolve(
            enqueueCount === 1
              ? { schemaVersion: 1, revision: 1, items: [head] }
              : enqueueCount === 2
                ? { schemaVersion: 1, revision: 3, items: [head, laterOne] }
                : { schemaVersion: 1, revision: 4, items: [head, laterOne, laterTwo] },
          ) as never;
        }
        if (method === "resumeChatQueue") {
          activeOptions = options as CoachClientCallOptions<"chat">;
          return activeRun.promise as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const recoveredMethods: string[] = [];
    const recovered: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, request, options) => {
        recoveredMethods.push(method);
        if (method === "getChatQueue") {
          return Promise.resolve({
            schemaVersion: 1,
            revision: 5,
            items: [head, laterOne, laterTwo],
            retryRequired: {
              claimId: "claim-1",
              queuedMessageIds: [head.queuedMessageId],
              turnId: "turn-1",
              status: "retry-required",
            },
          }) as never;
        }
        if (method === "retryQueuedTurn") {
          expect(request).toEqual({ chatId: "desktop", claimId: "claim-1" });
          const retryOptions = options as CoachClientCallOptions<"chat">;
          deliver("retryQueuedTurn", retryOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("retryQueuedTurn", retryOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Recovered",
          });
          retryOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 7,
              items: [
                { ...laterOne, position: 0 },
                { ...laterTwo, position: 1 },
              ],
            },
            response: { text: "Recovered" },
          }) as never;
        }
        if (method === "resumeChatQueue") {
          const laterOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", laterOptions, {
            type: "turn-start",
            turnId: "turn-3",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", laterOptions, {
            type: "final-text",
            turnId: "turn-3",
            text: "Later reply",
          });
          laterOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 3, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 9, items: [] },
            response: { text: "Later reply" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    let providerClient = failed;
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => providerClient),
      reconnect: vi.fn(async () => {
        providerClient = recovered;
        return recovered;
      }),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(failed, () => true, provider);
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions).toBeDefined());
    deliver("resumeChatQueue", activeOptions!, {
      type: "turn-start",
      turnId: "turn-1",
      chatId: "desktop",
    });
    deliver("resumeChatQueue", activeOptions!, {
      type: "text_delta",
      turnId: "turn-1",
      delta: "Partial",
    });
    await expect(controller.submit("Later one")).resolves.toBe(true);
    await expect(controller.submit("Later two")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["Later one", "Later two"]);

    disconnected = true;
    activeRun.reject(new CoachClientDisconnectedError(1006, "lost"));
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("interrupted"));
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "Partial",
      delivery: "interrupted",
    });
    expect(states.at(-1)?.retryRequired).toBeNull();
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);

    await controller.retryInterrupted();

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(recoveredMethods).toEqual(["getChatQueue", "retryQueuedTurn", "resumeChatQueue"]);
    expect(recoveredMethods).not.toContain("chat");
    expect(states.at(-1)?.queued).toEqual([]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "athlete")
        .map((message) => message.text),
    ).toEqual(["First", "Later one\n\nLater two"]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "coach")
        .map((message) => ({ text: message.text, delivery: message.delivery })),
    ).toEqual([
      { text: "Partial", delivery: "interrupted" },
      { text: "Recovered", delivery: "complete" },
      { text: "Later reply", delivery: "complete" },
    ]);
  });

  it("reconciles a generic queue failure to the queue-aware retry path", async () => {
    let queueReads = 0;
    const head = {
      queuedMessageId: "queued-1",
      messageId: "message-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 0,
      restored: false,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, _request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue") {
          queueReads += 1;
          return Promise.resolve(
            queueReads === 1
              ? { schemaVersion: 1, revision: 0, items: [] }
              : {
                  schemaVersion: 1,
                  revision: 3,
                  items: [head],
                  retryRequired: {
                    claimId: "claim-1",
                    queuedMessageIds: [head.queuedMessageId],
                    turnId: "turn-1",
                    status: "retry-required",
                  },
                },
          ) as never;
        }
        if (method === "enqueueChatMessage") {
          return Promise.resolve({ schemaVersion: 1, revision: 1, items: [head] }) as never;
        }
        if (method === "resumeChatQueue") {
          const runOptions = options as CoachClientCallOptions<"chat">;
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-1",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "text_delta",
            turnId: "turn-1",
            delta: "Partial",
          });
          runOptions.onTerminalEnvelope?.({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "Internal error" },
          });
          return Promise.reject(new Error("terminal failure")) as never;
        }
        if (method === "retryQueuedTurn") {
          const retryOptions = options as CoachClientCallOptions<"chat">;
          deliver("retryQueuedTurn", retryOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("retryQueuedTurn", retryOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Recovered",
          });
          retryOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 5, items: [] },
            response: { text: "Recovered" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1"));

    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["First"]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "Partial",
      delivery: "interrupted",
    });

    await controller.retryQueuedTurn("claim-1");

    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "retryQueuedTurn"),
    ).toHaveLength(1);
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "chat")).toBe(false);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
  });

  it("preserves Stop recovery and drains ordinary work queued during streaming", async () => {
    const activeRun = deferred<ChatQueueRunResult>();
    let activeOptions: CoachClientCallOptions<"chat"> | undefined;
    let enqueueCount = 0;
    let resumeCount = 0;
    const head = {
      queuedMessageId: "queued-1",
      messageId: "message-1",
      submissionId: "submission-1",
      text: "First",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 0,
      restored: false,
    };
    const laterOne = {
      queuedMessageId: "queued-2",
      messageId: "message-2",
      submissionId: "submission-2",
      text: "Later one",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 1,
      restored: false,
    };
    const laterTwo = {
      queuedMessageId: "queued-3",
      messageId: "message-3",
      submissionId: "submission-3",
      text: "Later two",
      kind: "ordinary" as const,
      attachmentIds: [],
      position: 2,
      restored: false,
    };
    const client: CoachClient = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn((method, request, options) => {
        if (method === "getCoachDecision") return Promise.resolve({ decision: null }) as never;
        if (method === "hasSession") return Promise.resolve({ hasSession: false }) as never;
        if (method === "getChatQueue") {
          return Promise.resolve({ schemaVersion: 1, revision: 0, items: [] }) as never;
        }
        if (method === "enqueueChatMessage") {
          enqueueCount += 1;
          return Promise.resolve(
            enqueueCount === 1
              ? { schemaVersion: 1, revision: 1, items: [head] }
              : enqueueCount === 2
                ? { schemaVersion: 1, revision: 3, items: [head, laterOne] }
                : { schemaVersion: 1, revision: 4, items: [head, laterOne, laterTwo] },
          ) as never;
        }
        if (method === "resumeChatQueue") {
          resumeCount += 1;
          const runOptions = options as CoachClientCallOptions<"chat">;
          if (resumeCount === 1) {
            activeOptions = runOptions;
            deliver("resumeChatQueue", runOptions, {
              type: "turn-start",
              turnId: "turn-1",
              chatId: "desktop",
            });
            deliver("resumeChatQueue", runOptions, {
              type: "text_delta",
              turnId: "turn-1",
              delta: "Partial",
            });
            return activeRun.promise as never;
          }
          deliver("resumeChatQueue", runOptions, {
            type: "turn-start",
            turnId: "turn-3",
            chatId: "desktop",
          });
          deliver("resumeChatQueue", runOptions, {
            type: "final-text",
            turnId: "turn-3",
            text: "Later reply",
          });
          runOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 3, result: {} });
          return Promise.resolve({
            snapshot: { schemaVersion: 1, revision: 9, items: [] },
            response: { text: "Later reply" },
          }) as never;
        }
        if (method === "stopChat") {
          expect(request).toEqual({ chatId: "desktop", turnId: "turn-1" });
          deliver("resumeChatQueue", activeOptions!, {
            type: "interrupted",
            turnId: "turn-1",
            chatId: "desktop",
            text: "Partial",
          });
          activeOptions!.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: {} });
          activeRun.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 5,
              items: [head, laterOne, laterTwo],
              retryRequired: {
                claimId: "claim-1",
                queuedMessageIds: [head.queuedMessageId],
                turnId: "turn-1",
                status: "retry-required",
              },
            },
            response: { text: "Partial" },
          });
          return Promise.resolve({ stopped: true }) as never;
        }
        if (method === "retryQueuedTurn") {
          expect(request).toEqual({ chatId: "desktop", claimId: "claim-1" });
          const retryOptions = options as CoachClientCallOptions<"chat">;
          deliver("retryQueuedTurn", retryOptions, {
            type: "turn-start",
            turnId: "turn-2",
            chatId: "desktop",
          });
          deliver("retryQueuedTurn", retryOptions, {
            type: "final-text",
            turnId: "turn-2",
            text: "Recovered",
          });
          retryOptions.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: {} });
          return Promise.resolve({
            snapshot: {
              schemaVersion: 1,
              revision: 7,
              items: [
                { ...laterOne, position: 0 },
                { ...laterTwo, position: 1 },
              ],
            },
            response: { text: "Recovered" },
          }) as never;
        }
        throw new TypeError(String(method));
      }),
      close: vi.fn(async () => {}),
    };
    const { controller, states } = harness(client);
    await controller.start();
    await expect(controller.submit("First")).resolves.toBe(true);
    await vi.waitFor(() => expect(activeOptions).toBeDefined());
    await expect(controller.submit("Later one")).resolves.toBe(true);
    await expect(controller.submit("Later two")).resolves.toBe(true);
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual(["Later one", "Later two"]);

    controller.stop();
    await vi.waitFor(() => expect(states.at(-1)?.retryRequired?.claimId).toBe("claim-1"));
    expect(states.at(-1)?.status).toBe("interrupted");
    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "Partial",
      delivery: "interrupted",
    });
    expect(states.at(-1)?.queued.map((item) => item.text)).toEqual([
      "First",
      "Later one",
      "Later two",
    ]);

    await controller.retryQueuedTurn("claim-1");

    expect(resumeCount).toBe(2);
    expect(
      vi.mocked(client.call).mock.calls.filter(([method]) => method === "retryQueuedTurn"),
    ).toHaveLength(1);
    expect(vi.mocked(client.call).mock.calls.some(([method]) => method === "chat")).toBe(false);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "athlete")
        .map((message) => message.text),
    ).toEqual(["First", "Later one\n\nLater two"]);
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "coach")
        .map((message) => ({ text: message.text, delivery: message.delivery })),
    ).toEqual([
      { text: "Partial", delivery: "interrupted" },
      { text: "Recovered", delivery: "complete" },
      { text: "Later reply", delivery: "complete" },
    ]);
  });
});
