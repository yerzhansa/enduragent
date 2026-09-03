import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  COACH_RPC_METHOD_REGISTRY,
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  parseCoachRpcEnvelope,
  serializeCoachRpcEnvelope,
  type CoachRpcMethodName,
  type CoachTurnEventNotificationEnvelope,
  type JsonRpcProtocolErrorResponseEnvelope,
} from "@enduragent/coach-contract";
import {
  CoachClientBackpressureError,
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachClientVersionMismatchError,
  CoachRpcRemoteError,
  connectCoachClient,
  resolveCoachWebSocketFactory,
  type CoachClient,
  type CoachClientCallOptions,
  type CoachClientTerminalCause,
  type CoachClientTerminalEnvelope,
  type ConnectCoachClientOptions,
} from "../src/index.js";

const token = "synthetic-test-token";
const athleteHome = "/synthetic/athlete";
const acceptedHandshakeBinding = {
  athleteHome,
  rendererCapability: "A".repeat(43),
} as const;
const telegramControlSnapshot = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
} as const;
const planReadModel = {
  schemaVersion: 1,
  scenarioId: "PL-S001",
  lifecycle: "none",
  planId: null,
  revision: 0,
  title: "Plan",
  summary: "No active Plan",
  projection: "no-plan",
  transitions: [{ transitionId: "PL-T01", status: "available", reason: null }],
  reconciliation: {
    status: "not-applicable",
    created: 0,
    pending: 0,
    failed: 0,
    total: 0,
    currentThrough: null,
    error: null,
  },
  attention: { count: 0, destination: "none", items: [] },
  activeOperation: null,
  data: {},
} as const;

const rpcDeadlineCases = [
  ["chat", { chatId: "chat-1", message: "deadline" }, 660_000],
  ["stopChat", { chatId: "chat-1", turnId: "turn-1" }, 10_000],
  [
    "admitChatAttachment",
    {
      chatId: "desktop",
      selectionId: "selection-1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: "/tmp/activity.fit" },
    },
    120_000,
  ],
  [
    "admitPastedChatAttachment",
    {
      chatId: "desktop",
      selectionId: "selection-paste-1",
      displayName: "clipboard.png",
      dataBase64: "AA==",
    },
    120_000,
  ],
  ["getChatAttachmentComposer", { chatId: "desktop" }, 120_000],
  ["saveChatAttachmentDraftText", { chatId: "desktop", text: "Review this" }, 30_000],
  ["removeChatAttachment", { chatId: "desktop", attachmentId: "attachment-1" }, 30_000],
  ["retryChatAttachment", { chatId: "desktop", attachmentId: "attachment-1" }, 120_000],
  [
    "selectChatAttachmentWorkout",
    { chatId: "desktop", attachmentId: "attachment-1", workoutId: "workout-1" },
    120_000,
  ],
  ["clearChatAttachmentDraft", { chatId: "desktop" }, 120_000],
  ["enqueueChatMessage", { chatId: "chat-1", submissionId: "submission-1", text: "Hello" }, 30_000],
  ["getChatQueue", { chatId: "chat-1" }, 30_000],
  ["removeQueuedChatMessage", { chatId: "chat-1", queuedMessageId: "queued-1" }, 30_000],
  ["resumeChatQueue", { chatId: "chat-1" }, 660_000],
  ["runQueuedCommand", { chatId: "chat-1", queuedMessageId: "queued-1" }, 660_000],
  ["retryQueuedTurn", { chatId: "chat-1", claimId: "claim-1" }, 660_000],
  ["getCoachDecision", { chatId: "chat-1" }, 30_000],
  [
    "answerCoachDecision",
    {
      chatId: "chat-1",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "option-1" },
    },
    660_000,
  ],
  ["skipCoachDecision", { chatId: "chat-1", decisionId: "decision-1" }, 30_000],
  ["resumeCoachDecision", { chatId: "chat-1", decisionId: "decision-1" }, 660_000],
  ["resetSession", { chatId: "chat-1" }, 660_000],
  ["hasSession", { chatId: "chat-1" }, 30_000],
  ["getTranscriptPage", { cursor: null, limit: 25 }, 30_000],
  ["listArchivedConversations", {}, 30_000],
  ["deleteArchivedConversation", { boundaryRef: "a".repeat(64) }, 30_000],
  ["getArchivedTranscriptPage", { boundaryRef: "a".repeat(64), cursor: null, limit: 25 }, 30_000],
  ["getAthleteState", {}, 30_000],
  ["getPlanningReadModel", {}, 30_000],
  [
    "getActivityAnalysis",
    { canonicalActivityId: "a".repeat(64), sections: ["aerobic-drift"] },
    90_000,
  ],
  [
    "exportTrainingFile",
    {
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      format: "fit",
      destinationPath: "/synthetic/ride.fit",
    },
    120_000,
  ],
  ["importFiles", { paths: ["/synthetic/ride.fit"] }, 3_600_000],
  ["sync", {}, 86_400_000],
  ["getSetupStatus", {}, 30_000],
  [
    "saveIntake",
    {
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    },
    30_000,
  ],
  ["configureRuntime", { llm: { provider: "openai" } }, 30_000],
  ["verify_intervals_credential", { api_key: "placeholder" }, 30_000],
  ["getRuntimeConfig", {}, 30_000],
  ["getUnitsPreference", {}, 30_000],
  ["setUnitsPreference", { value: "metric" }, 30_000],
  ["configureTelegram", { token: "bot-token" }, 30_000],
  ["enableTelegram", {}, 30_000],
  ["disableTelegram", {}, 30_000],
  ["suspendTelegramPolling", {}, 30_000],
  ["resumeTelegramPolling", {}, 30_000],
  ["drainTelegram", {}, 30_000],
  ["replaceTelegram", { token: "new-token" }, 30_000],
  ["getTelegramStatus", {}, 30_000],
  ["reconcileTelegram", {}, 30_000],
  ["inspectTelegramCredential", { token: "bot-token" }, 30_000],
  ["deleteTelegramWebhook", { token: "bot-token" }, 30_000],
  ["forgetTelegramCredential", {}, 30_000],
  ["resetTelegramAccess", {}, 30_000],
  ["beginTelegramPairing", {}, 30_000],
  ["cancelTelegramPairing", {}, 30_000],
  ["listTelegramAllowedSenders", {}, 30_000],
  ["addTelegramAllowedSender", { senderId: 123_456 }, 30_000],
  ["removeTelegramAllowedSender", { senderId: 123_456 }, 30_000],
  ["getSpendSummary", {}, 30_000],
  ["setDailySpendCap", { dailyCapUsd: 25 }, 30_000],
  ["selfTest", {}, 120_000],
  ["getPlanState", {}, 30_000],
  [
    "executePlanTransition",
    { transitionId: "PL-T01", commandId: "command-1", sourceConversationId: null },
    660_000,
  ],
  [
    "createPlanningRequest",
    {
      payload: {
        requestId: "request-1",
        kind: "plan_question",
        intent: "Review the current week.",
        source: { chatId: "chat-1", messageId: "message-1" },
        sourceSnapshot: {
          capturedAt: "1998-08-24T08:00:00.000Z",
          attachment: null,
          selectedWorkout: null,
        },
      },
    },
    30_000,
  ],
  [
    "createWorkoutPlanningRequest",
    {
      requestId: "request-workout",
      intent: "Review Tempo 3 × 12.",
      source: {
        chatId: "chat-1",
        messageId: "message-workout",
        attachmentId: "attachment-1",
      },
      requestedDate: "1998-08-26",
    },
    30_000,
  ],
  ["getPlanningRequest", { requestId: "request-1" }, 30_000],
  ["retryPlanningRequest", { requestId: "request-1" }, 30_000],
  ["resumePlanningRequests", {}, 30_000],
  ["listPlanningRequests", { chatId: "chat-1" }, 30_000],
  ["plan_creation.start", { commandId: "plan-start" }, 30_000],
  [
    "plan_creation.answer",
    {
      commandId: "plan-answer",
      creationId: "00000000000000000000000000",
      expectedVersion: 1,
      answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build power" } },
    },
    30_000,
  ],
] as const satisfies ReadonlyArray<readonly [CoachRpcMethodName, unknown, number]>;

class ControllableSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  sendHook: ((text: string) => void) | undefined;
  closeSynchronously = false;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const text = String(data);
    this.sent.push(text);
    this.sendHook?.(text);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
    if (this.closeSynchronously) this.emitClose(code ?? 1000, reason ?? "");
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }

  emitClose(code = 1006, reason = "closed"): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function acceptedSocket(
  owner = "service-managed" as const,
  options: Pick<ConnectCoachClientOptions, "onTerminal"> = {},
): {
  readonly socket: ControllableSocket;
  readonly connecting: Promise<CoachClient>;
} {
  const socket = new ControllableSocket();
  socket.sendHook = (text) => {
    const frame = JSON.parse(text) as { type?: string };
    if (frame.type === "handshake") {
      socket.emitMessage(
        JSON.stringify(
          createAcceptedServerHandshakeFrame(owner, PROTOCOL_VERSION, acceptedHandshakeBinding),
        ),
      );
    }
  };
  const connecting = connectCoachClient({
    url: "ws://127.0.0.1:49152",
    token,
    webSocketFactory: () => socket as unknown as WebSocket,
    ...options,
  });
  socket.emitOpen();
  return { socket, connecting };
}

const servers: WebSocketServer[] = [];
const serverSockets: ServerWebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of serverSockets.splice(0)) socket.terminate();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startServer(
  onConnection: (socket: ServerWebSocket, requestUrl: string | undefined) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    serverSockets.push(socket);
    onConnection(socket, request.url);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("missing server address");
  return `ws://127.0.0.1:${address.port}`;
}

describe("connection and transport", () => {
  it("uses the Node global, sends the token frame first, and accepts a verbatim browser factory", async () => {
    const firstFrame = deferred<Record<string, unknown>>();
    const urls: Array<string | undefined> = [];
    let url: string;
    try {
      url = await startServer((socket, requestUrl) => {
        urls.push(requestUrl);
        socket.once("message", (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          firstFrame.resolve(frame);
          socket.send(
            JSON.stringify(
              createAcceptedServerHandshakeFrame(
                "service-managed",
                PROTOCOL_VERSION,
                acceptedHandshakeBinding,
              ),
            ),
          );
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      process.stderr.write("SKIP_MARKER loopback-listen EPERM coach-client\n");
      return;
    }
    const client = await connectCoachClient({ url, token, expectedAthleteHome: athleteHome });
    expect(await firstFrame.promise).toEqual({
      type: "handshake",
      token,
      clientProtocolVersion: PROTOCOL_VERSION,
    });
    expect(urls).toEqual(["/"]);
    expect(client.handshake.owner).toBe("service-managed");
    expect(client.handshake.athleteHome).toBe(athleteHome);
    expect(client.handshake.rendererCapability).toBe(acceptedHandshakeBinding.rendererCapability);
    await client.close();

    const socket = new ControllableSocket();
    const factory = vi.fn(() => socket as unknown as WebSocket);
    expect(resolveCoachWebSocketFactory(factory)).toBe(factory);
    socket.sendHook = () =>
      socket.emitMessage(
        JSON.stringify(
          createAcceptedServerHandshakeFrame(
            "unmanaged-foreground",
            PROTOCOL_VERSION,
            acceptedHandshakeBinding,
          ),
        ),
      );
    const browserConnection = connectCoachClient({
      url: "ws://127.0.0.1:49153",
      token,
      webSocketFactory: factory,
    });
    socket.emitOpen();
    const browserClient = await browserConnection;
    expect(factory).toHaveBeenCalledExactlyOnceWith("ws://127.0.0.1:49153");
    socket.closeSynchronously = true;
    await browserClient.close();
  });

  it("maps missing and throwing transports to the stable unavailable error", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: undefined });
    try {
      expect(() => resolveCoachWebSocketFactory()).toThrow(CoachClientTransportUnavailableError);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "WebSocket", descriptor);
    }
    const error = await connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: () => {
        throw new Error("private constructor detail");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoachClientTransportUnavailableError);
    expect(error).toMatchObject({
      name: "CoachClientTransportUnavailableError",
      message: "WebSocket transport is unavailable",
    });
    expect(String(error)).not.toContain("private constructor detail");
  });

  it.each([
    "not a url",
    "http://127.0.0.1:80",
    "https://127.0.0.1:443",
    "wss://127.0.0.1:443",
    "ws://127.0.0.1",
    "ws://127.0.0.1:80",
    "ws://user@127.0.0.1:49152",
    "ws://user:pass@127.0.0.1:49152",
    "ws://127.0.0.1:49152?token=synthetic-test-token",
    "ws://127.0.0.1:49152#fragment",
    "ws://localhost:49152",
    "ws://127.0.0.2:49152",
    "ws://[::1]:49152",
  ])("rejects forbidden URL %s before transport", async (url) => {
    const factory = vi.fn();
    const error = await connectCoachClient({ url, token, webSocketFactory: factory }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoachClientProtocolError);
    expect(error).toMatchObject({
      name: "CoachClientProtocolError",
      message: "Coach client protocol error",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(token);
  });

  it.each([
    { token: "" },
    { expectedAthleteHome: "relative/athlete" },
    { connectTimeoutMs: NaN },
    { connectTimeoutMs: Infinity },
    { handshakeTimeoutMs: -1 },
    { closeTimeoutMs: 0 },
    { maxQueuedSends: 1.5 },
    { maxQueuedSends: Number.MAX_SAFE_INTEGER + 1 },
    { highWaterMarkBytes: 0 },
    { highWaterMarkBytes: -Infinity },
    { lowWaterMarkBytes: -1 },
    { lowWaterMarkBytes: NaN },
    { highWaterMarkBytes: 10, lowWaterMarkBytes: 10 },
    { highWaterMarkBytes: 10, lowWaterMarkBytes: 11 },
  ])("rejects invalid options before transport: %o", async (override) => {
    const factory = vi.fn();
    const error = await connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: factory,
      ...override,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoachClientProtocolError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("times out an inert connection exactly and cleans up", async () => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      connectTimeoutMs: 37,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    let settled = false;
    void connection.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(36);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await connection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client connection timed out",
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("distinguishes pre-aborted and mid-connect aborted signals", async () => {
    const before = new AbortController();
    before.abort();
    const factory = vi.fn();
    await expect(
      connectCoachClient({
        url: "ws://127.0.0.1:49152",
        token,
        signal: before.signal,
        webSocketFactory: factory,
      }),
    ).rejects.toMatchObject({ message: "Coach client connection aborted" });
    expect(factory).not.toHaveBeenCalled();

    const during = new AbortController();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      signal: during.signal,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    during.abort();
    await expect(connection).rejects.toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client connection aborted",
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toHaveLength(1);
  });
});

describe("handshake failures", () => {
  it("refuses an accepted daemon whose authenticated home differs from the expected home", async () => {
    const socket = new ControllableSocket();
    socket.sendHook = () => {
      socket.emitMessage(
        JSON.stringify(
          createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
            ...acceptedHandshakeBinding,
            athleteHome: "/synthetic/other-athlete",
          }),
        ),
      );
    };
    const outcome = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      expectedAthleteHome: athleteHome,
      webSocketFactory: () => socket as unknown as WebSocket,
    }).catch((error: unknown) => error);
    socket.emitOpen();

    const error = await outcome;
    expect(error).toBeInstanceOf(CoachClientProtocolError);
    expect(socket.closeCalls).toEqual([{ code: 1002, reason: undefined }]);
  });

  it("terminalizes a socket error delivered after handshake acceptance but before resolution", async () => {
    const socket = new ControllableSocket();
    const observer = vi.fn();
    socket.sendHook = () => {
      socket.emitMessage(
        JSON.stringify(
          createAcceptedServerHandshakeFrame(
            "service-managed",
            PROTOCOL_VERSION,
            acceptedHandshakeBinding,
          ),
        ),
      );
      socket.emitError();
    };
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      onTerminal: observer,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.emitOpen();

    const client = await connection;
    const cause = await client
      .call("hasSession", { chatId: "chat-1" })
      .catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(CoachClientDisconnectedError);
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, cause);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it.each([
    {
      kind: "timeout",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake timed out",
    },
    {
      kind: "close",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake failed",
    },
    {
      kind: "error",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake failed",
    },
    { kind: "binary", expected: CoachClientProtocolError, message: "Coach client protocol error" },
    {
      kind: "unknown-owner",
      expected: CoachClientProtocolError,
      message: "Coach client protocol error",
    },
    {
      kind: "invalid-accepted",
      expected: CoachClientProtocolError,
      message: "Coach client protocol error",
    },
  ])("fails closed for $kind", async ({ kind, expected, message }) => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      handshakeTimeoutMs: 23,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const outcome = connection.catch((caught: unknown) => caught);
    socket.emitOpen();
    await Promise.resolve();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(23);
    if (kind === "close") socket.emitClose();
    if (kind === "error") socket.emitError();
    if (kind === "binary") socket.emitMessage(new Uint8Array([1]));
    if (kind === "unknown-owner")
      socket.emitMessage(
        JSON.stringify({
          type: "handshake",
          status: "accepted",
          clientProtocolVersion: 2,
          serverProtocolVersion: 2,
          owner: "unknown-owner",
        }),
      );
    if (kind === "invalid-accepted")
      socket.emitMessage(
        JSON.stringify({
          type: "handshake",
          status: "accepted",
          clientProtocolVersion: 1,
          serverProtocolVersion: 2,
          owner: "service-managed",
        }),
      );
    const error = await outcome;
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ name: expected.name, message });
    expect(String(error)).not.toContain(token);
  });

  it("maps handshake send throws without retry", async () => {
    const socket = new ControllableSocket();
    socket.sendHook = () => {
      throw new Error("raw send detail");
    };
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.emitOpen();
    const error = await connection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client handshake send failed",
    });
    expect(socket.sent).toHaveLength(1);
    expect(String(error)).not.toContain(token);
  });

  it.each([
    [PROTOCOL_VERSION, PROTOCOL_VERSION + 1, "client-older", "ephemeral-client-started"],
    [PROTOCOL_VERSION, PROTOCOL_VERSION - 1, "client-newer", "unmanaged-foreground"],
  ] as const)(
    "exposes a trusted mismatch %s/%s",
    async (clientVersion, serverVersion, direction, owner) => {
      const socket = new ControllableSocket();
      socket.sendHook = () =>
        socket.emitMessage(
          JSON.stringify(
            createVersionMismatchServerHandshakeFrame(owner, clientVersion, serverVersion),
          ),
        );
      const connection = connectCoachClient({
        url: "ws://127.0.0.1:49152",
        token,
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      socket.emitOpen();
      const error = await connection.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CoachClientVersionMismatchError);
      expect(error).toMatchObject({
        name: "CoachClientVersionMismatchError",
        message: "Coach protocol version mismatch",
        clientProtocolVersion: clientVersion,
        serverProtocolVersion: serverVersion,
        direction,
        owner,
      });
    },
  );
});

describe("RPC receive and observers", () => {
  it("rejects a malformed allowed-sender mutation envelope before typed delivery", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.closeSynchronously = true;
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { readonly id: number };
      socket.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            outcome: "uncertain",
            reason: "storage-uncertain",
            current: { senders: [] },
          },
        }),
      );
    };

    await expect(
      client.call("addTelegramAllowedSender", { senderId: 123_456 }),
    ).rejects.toBeInstanceOf(CoachClientProtocolError);
  });

  it("rejects a runtime snapshot without the strict credential evidence boolean", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.closeSynchronously = true;
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { readonly id: number };
      socket.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            schemaVersion: 3,
            llm: { provider: "anthropic", model: "synthetic-model" },
            intervals: {
              athlete_id: "",
              credential_configured: false,
              managedByEnvironment: { athleteId: false },
            },
            session: {
              historyTokenBudgetRatio: 0.3,
              idleMinutes: 0,
              dailyResetHour: 4,
              resetArchiveRetentionDays: 0,
              timezone: "UTC",
              managedByEnvironment: {
                historyTokenBudgetRatio: false,
                idleMinutes: false,
                dailyResetHour: false,
                resetArchiveRetentionDays: false,
                timezone: false,
              },
            },
          },
        }),
      );
    };

    await expect(client.call("getRuntimeConfig", {})).rejects.toBeInstanceOf(
      CoachClientProtocolError,
    );
  });

  it("rejects a contradictory spend response before typed delivery", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.closeSynchronously = true;
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { readonly id: number };
      socket.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            localDate: "1998-07-06",
            timezone: "UTC",
            dailyCapUsd: 0.5,
            knownSpendUsd: 0.1,
            generationCount: 0,
            pricedGenerationCount: 0,
            unpricedGenerationCount: 0,
            malformedLineCount: 0,
            spendComplete: true,
            capStatus: "below",
            cacheReadTokens: 0,
            knownCacheReadSavingsUsd: 0,
            cacheSavingsComplete: true,
            routes: [],
          },
        }),
      );
    };
    await expect(client.call("getSpendSummary", {})).rejects.toBeInstanceOf(
      CoachClientProtocolError,
    );
  });

  it("parses a bounded activity-analysis result before typed delivery", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { readonly id: number };
      socket.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            schemaVersion: 1,
            activity: {
              id: "a".repeat(64),
              workoutId: "b".repeat(64),
              sessionSequence: 0,
              isMultisport: false,
              sport: "cycling",
              subSport: null,
              isTransition: false,
              startEpochSeconds: 899_985_600,
              timezoneOffsetSeconds: 0,
              localDate: "1998-07-06",
              elapsedSeconds: 3_600,
              timerSeconds: 3_500,
              movingSeconds: 3_400,
              distanceMeters: 40_000,
            },
            revision: "c".repeat(64),
            sections: {
              intervals: { kind: "unavailable", reason: "not-provider-backed" },
            },
          },
        }),
      );
    };

    await expect(
      client.call("getActivityAnalysis", {
        canonicalActivityId: "a".repeat(64),
        sections: ["intervals"],
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      sections: { intervals: { kind: "unavailable", reason: "not-provider-backed" } },
    });
  });

  it("exercises all methods with monotonic strict requests and parsed results", async () => {
    const received: unknown[] = [];
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const decision = {
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
    };
    const completedDecision = {
      ...decision,
      status: "answered",
      answer: { kind: "option", optionId: "option-1" },
      consequence: "Tomorrow stays easy.",
      continuation: {
        continuationId: "continuation-1",
        status: "completed",
        turnId: "turn-1",
        coachText: "Keep tomorrow easy.",
      },
    };
    const attachmentComposer = {
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
    socket.sendHook = (text) => {
      const request = parseCoachRpcEnvelope(text);
      received.push(request);
      if (!("id" in request) || !("method" in request)) return;
      const results = {
        chat: { text: "answer" },
        stopChat: { stopped: true },
        admitChatAttachment: {
          selectionId: "selection-1",
          displayName: "activity.fit",
          status: "storage_failed",
          failureCode: "admission_unavailable",
          retryable: false,
        },
        admitPastedChatAttachment: {
          selectionId: "selection-paste-1",
          displayName: "clipboard.png",
          status: "storage_failed",
          failureCode: "admission_unavailable",
          retryable: false,
        },
        getChatAttachmentComposer: attachmentComposer,
        saveChatAttachmentDraftText: attachmentComposer,
        removeChatAttachment: attachmentComposer,
        retryChatAttachment: attachmentComposer,
        selectChatAttachmentWorkout: attachmentComposer,
        clearChatAttachmentDraft: attachmentComposer,
        enqueueChatMessage: { schemaVersion: 1, revision: 1, items: [] },
        getChatQueue: { schemaVersion: 1, revision: 1, items: [] },
        removeQueuedChatMessage: { schemaVersion: 1, revision: 2, items: [] },
        resumeChatQueue: { snapshot: { schemaVersion: 1, revision: 2, items: [] } },
        runQueuedCommand: { snapshot: { schemaVersion: 1, revision: 2, items: [] } },
        retryQueuedTurn: { snapshot: { schemaVersion: 1, revision: 2, items: [] } },
        getCoachDecision: { decision: { ...decision, status: "unanswered" } },
        answerCoachDecision: { decision: completedDecision },
        skipCoachDecision: { decision: { ...decision, status: "skipped" } },
        resumeCoachDecision: { decision: completedDecision, resumed: true },
        resetSession: { memoryFlushed: true },
        hasSession: { hasSession: true },
        getTranscriptPage: {
          schemaVersion: 1,
          status: "page",
          turns: [],
          nextCursor: null,
        },
        listArchivedConversations: {
          schemaVersion: 1,
          conversations: [],
          truncated: false,
        },
        deleteArchivedConversation: {
          schemaVersion: 1,
          status: "deleted",
        },
        getArchivedTranscriptPage: {
          schemaVersion: 1,
          status: "page",
          turns: [],
          nextCursor: null,
        },
        getAthleteState: {
          schemaVersion: "1",
          lastUpdated: "2020-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        },
        getPlanningReadModel: {
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey: 20260826,
          plan: null,
        },
        getActivityAnalysis: {
          schemaVersion: 1,
          activity: {
            id: "a".repeat(64),
            workoutId: "b".repeat(64),
            sessionSequence: 0,
            isMultisport: false,
            sport: "cycling",
            subSport: null,
            isTransition: false,
            startEpochSeconds: 899_985_600,
            timezoneOffsetSeconds: 0,
            localDate: "1998-07-06",
            elapsedSeconds: 3_600,
            timerSeconds: 3_500,
            movingSeconds: 3_400,
            distanceMeters: 40_000,
          },
          revision: "c".repeat(64),
          sections: { intervals: { kind: "unavailable", reason: "unsupported" } },
        },
        exportTrainingFile: {
          status: "exported",
          byteLength: 4_096,
          suggestedFilename: "synthetic.fit",
          contentType: "application/octet-stream",
        },
        importFiles: {
          schemaVersion: 2,
          files: { total: 1, imported: 1, quarantined: 0 },
          changes: {
            rawFilesInserted: 1,
            sourceRecordsInserted: 1,
            sourceRecordsUpdated: 0,
            relinkedSourceRecords: 0,
          },
          publication: { scope: "activities-and-streams", status: "available" },
        },
        sync: {
          schemaVersion: 1,
          published: true,
          referenceSucceeded: true,
          requests: { store: 1, reference: 1, total: 2 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        },
        getSetupStatus: {
          schemaVersion: 1,
          intake: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            prior_bsi: false,
            clinician_cleared: null,
            injury_status: "none",
          },
          durableTrainingData: true,
        },
        saveIntake: { schemaVersion: 1, saved: true },
        configureRuntime: {
          schemaVersion: 3,
          status: "applied",
          applied: { llm: true, intervals: false, session: false },
        },
        verify_intervals_credential: { approval: "a".repeat(64) },
        getRuntimeConfig: {
          schemaVersion: 3,
          llm: {
            provider: "anthropic",
            model: "synthetic-model",
            credential_configured: true,
          },
          intervals: {
            athlete_id: "synthetic-athlete",
            credential_configured: true,
            managedByEnvironment: { athleteId: false },
          },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
            managedByEnvironment: {
              historyTokenBudgetRatio: false,
              idleMinutes: false,
              dailyResetHour: false,
              resetArchiveRetentionDays: false,
              timezone: false,
            },
          },
        },
        getUnitsPreference: { value: "metric", source: "default" },
        setUnitsPreference: { value: "imperial", source: "cycling" },
        configureTelegram: { outcome: "applied", current: telegramControlSnapshot },
        enableTelegram: telegramControlSnapshot,
        disableTelegram: telegramControlSnapshot,
        suspendTelegramPolling: telegramControlSnapshot,
        resumeTelegramPolling: telegramControlSnapshot,
        drainTelegram: telegramControlSnapshot,
        replaceTelegram: {
          outcome: "refused",
          reason: "invalid-token",
          current: telegramControlSnapshot,
        },
        getTelegramStatus: telegramControlSnapshot,
        reconcileTelegram: telegramControlSnapshot,
        inspectTelegramCredential: {
          status: "ready",
          bot: { id: 10001, username: "sample_bot" },
        },
        deleteTelegramWebhook: {
          status: "ready",
          bot: { id: 10001, username: "sample_bot" },
        },
        forgetTelegramCredential: telegramControlSnapshot,
        resetTelegramAccess: telegramControlSnapshot,
        beginTelegramPairing: telegramControlSnapshot,
        cancelTelegramPairing: telegramControlSnapshot,
        listTelegramAllowedSenders: { senders: [] },
        addTelegramAllowedSender: { outcome: "applied", current: { senders: [] } },
        removeTelegramAllowedSender: {
          outcome: "uncertain",
          reason: "storage-uncertain",
        },
        getSpendSummary: {
          localDate: "1998-07-06",
          timezone: "UTC",
          dailyCapUsd: 0.5,
          knownSpendUsd: 0,
          generationCount: 0,
          pricedGenerationCount: 0,
          unpricedGenerationCount: 0,
          malformedLineCount: 0,
          spendComplete: true,
          capStatus: "below",
          cacheReadTokens: 0,
          knownCacheReadSavingsUsd: 0,
          cacheSavingsComplete: true,
          routes: [],
        },
        setDailySpendCap: {
          localDate: "1998-07-06",
          timezone: "UTC",
          dailyCapUsd: 0.75,
          knownSpendUsd: 0,
          generationCount: 0,
          pricedGenerationCount: 0,
          unpricedGenerationCount: 0,
          malformedLineCount: 0,
          spendComplete: true,
          capStatus: "below",
          cacheReadTokens: 0,
          knownCacheReadSavingsUsd: 0,
          cacheSavingsComplete: true,
          routes: [],
        },
        selfTest: {
          schemaVersion: 1,
          type: "self-test-terminal",
          ok: false,
          error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
        },
        getPlanState: { status: "unsupported-capability", capability: "planning" },
        executePlanTransition: {
          status: "unsupported-capability",
          capability: "planning",
        },
        createPlanningRequest: { status: "rejected", reason: "invalid_request" },
        createWorkoutPlanningRequest: { status: "rejected", reason: "invalid_request" },
        getPlanningRequest: { status: "missing" },
        retryPlanningRequest: { status: "missing" },
        resumePlanningRequests: { deliveries: [] },
        listPlanningRequests: { deliveries: [], planCreation: null },
        "plan_creation.start": { status: "rejected", reason: "command-conflict" },
        "plan_creation.answer": {
          status: "rejected",
          reason: "no-unfinished-creation",
          planCreation: null,
        },
      };
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          id: request.id,
          result: results[request.method],
        }),
      );
    };
    await expect(client.call("chat", { chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "answer",
    });
    await expect(client.call("stopChat", { chatId: "chat-1", turnId: "turn-1" })).resolves.toEqual({
      stopped: true,
    });
    await expect(client.call("resetSession", { chatId: "chat-1" })).resolves.toEqual({
      memoryFlushed: true,
    });
    await expect(client.call("hasSession", { chatId: "chat-1" })).resolves.toEqual({
      hasSession: true,
    });
    await expect(client.call("getCoachDecision", { chatId: "chat-1" })).resolves.toMatchObject({
      decision: { decisionId: "decision-1", status: "unanswered" },
    });
    await expect(
      client.call("answerCoachDecision", {
        chatId: "chat-1",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "option-1" },
      }),
    ).resolves.toMatchObject({ decision: { status: "answered" } });
    await expect(
      client.call("skipCoachDecision", { chatId: "chat-1", decisionId: "decision-1" }),
    ).resolves.toMatchObject({ decision: { status: "skipped" } });
    await expect(
      client.call("resumeCoachDecision", { chatId: "chat-1", decisionId: "decision-1" }),
    ).resolves.toMatchObject({ decision: { status: "answered" }, resumed: true });
    await expect(client.call("getTranscriptPage", { cursor: null, limit: 25 })).resolves.toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });
    await expect(client.call("listArchivedConversations", {})).resolves.toEqual({
      schemaVersion: 1,
      conversations: [],
      truncated: false,
    });
    await expect(
      client.call("deleteArchivedConversation", { boundaryRef: "a".repeat(64) }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "deleted",
    });
    await expect(
      client.call("getArchivedTranscriptPage", {
        boundaryRef: "a".repeat(64),
        cursor: null,
        limit: 25,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });
    await expect(client.call("getAthleteState", {})).resolves.toMatchObject({ schemaVersion: "1" });
    await expect(
      client.call("importFiles", { paths: ["/synthetic/ride.fit"] }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
    await expect(client.call("sync", {})).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(client.call("getSetupStatus", {})).resolves.toEqual({
      schemaVersion: 1,
      intake: {
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: false,
        clinician_cleared: null,
        injury_status: "none",
      },
      durableTrainingData: true,
    });
    await expect(
      client.call("saveIntake", {
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: false,
        clinician_cleared: null,
        injury_status: "none",
      }),
    ).resolves.toEqual({ schemaVersion: 1, saved: true });
    await expect(
      client.call("configureRuntime", {
        llm: { provider: "anthropic", model: "synthetic", api_key: "synthetic" },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    });
    await expect(client.call("getRuntimeConfig", {})).resolves.toMatchObject({
      llm: { provider: "anthropic", model: "synthetic-model" },
    });
    expect(received.map((value) => (value as { id: number }).id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(received.map((value) => (value as { method: string }).method)).toEqual([
      "chat",
      "stopChat",
      "resetSession",
      "hasSession",
      "getCoachDecision",
      "answerCoachDecision",
      "skipCoachDecision",
      "resumeCoachDecision",
      "getTranscriptPage",
      "listArchivedConversations",
      "deleteArchivedConversation",
      "getArchivedTranscriptPage",
      "getAthleteState",
      "importFiles",
      "sync",
      "getSetupStatus",
      "saveIntake",
      "configureRuntime",
      "getRuntimeConfig",
    ]);
    await expect(client.call("getUnitsPreference", {})).resolves.toEqual({
      value: "metric",
      source: "default",
    });
    await expect(client.call("setUnitsPreference", { value: "imperial" })).resolves.toEqual({
      value: "imperial",
      source: "cycling",
    });
    expect(received.slice(-2).map((value) => (value as { id: number }).id)).toEqual([20, 21]);
    expect(received.slice(-2).map((value) => (value as { method: string }).method)).toEqual([
      "getUnitsPreference",
      "setUnitsPreference",
    ]);
    await expect(client.call("configureTelegram", { token: "bot-token" })).resolves.toEqual({
      outcome: "applied",
      current: telegramControlSnapshot,
    });
    await expect(client.call("enableTelegram", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("disableTelegram", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("suspendTelegramPolling", {})).resolves.toEqual(
      telegramControlSnapshot,
    );
    await expect(client.call("resumeTelegramPolling", {})).resolves.toEqual(
      telegramControlSnapshot,
    );
    await expect(client.call("drainTelegram", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("replaceTelegram", { token: "new-token" })).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-token",
      current: telegramControlSnapshot,
    });
    await expect(client.call("getTelegramStatus", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("reconcileTelegram", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("inspectTelegramCredential", { token: "bot-token" })).resolves.toEqual(
      { status: "ready", bot: { id: 10001, username: "sample_bot" } },
    );
    await expect(client.call("deleteTelegramWebhook", { token: "bot-token" })).resolves.toEqual({
      status: "ready",
      bot: { id: 10001, username: "sample_bot" },
    });
    await expect(client.call("forgetTelegramCredential", {})).resolves.toEqual(
      telegramControlSnapshot,
    );
    await expect(client.call("resetTelegramAccess", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("beginTelegramPairing", {})).resolves.toEqual(telegramControlSnapshot);
    await expect(client.call("cancelTelegramPairing", {})).resolves.toEqual(
      telegramControlSnapshot,
    );
    await expect(client.call("listTelegramAllowedSenders", {})).resolves.toEqual({ senders: [] });
    await expect(client.call("addTelegramAllowedSender", { senderId: 123_456 })).resolves.toEqual({
      outcome: "applied",
      current: { senders: [] },
    });
    await expect(
      client.call("removeTelegramAllowedSender", { senderId: 123_456 }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "storage-uncertain" });
    expect(received.slice(-18).map((value) => (value as { method: string }).method)).toEqual([
      "configureTelegram",
      "enableTelegram",
      "disableTelegram",
      "suspendTelegramPolling",
      "resumeTelegramPolling",
      "drainTelegram",
      "replaceTelegram",
      "getTelegramStatus",
      "reconcileTelegram",
      "inspectTelegramCredential",
      "deleteTelegramWebhook",
      "forgetTelegramCredential",
      "resetTelegramAccess",
      "beginTelegramPairing",
      "cancelTelegramPairing",
      "listTelegramAllowedSenders",
      "addTelegramAllowedSender",
      "removeTelegramAllowedSender",
    ]);
    await expect(client.call("getSpendSummary", {})).resolves.toMatchObject({
      dailyCapUsd: 0.5,
    });
    await expect(client.call("setDailySpendCap", { dailyCapUsd: 0.75 })).resolves.toMatchObject({
      dailyCapUsd: 0.75,
    });
    expect(received.slice(-2).map((value) => (value as { id: number }).id)).toEqual([40, 41]);
    expect(received.slice(-2).map((value) => (value as { method: string }).method)).toEqual([
      "getSpendSummary",
      "setDailySpendCap",
    ]);
    await expect(
      client.call("verify_intervals_credential", { api_key: "placeholder" }),
    ).resolves.toEqual({ approval: "a".repeat(64) });
    expect(received.at(-1)).toMatchObject({
      id: 42,
      method: "verify_intervals_credential",
      params: { api_key: "placeholder" },
    });
    socket.closeSynchronously = true;
    await client.close();
  });

  it("rejects non-JSON chat params without sending or consuming an id", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sent.length = 0;
    await expect(
      client.call("chat", {
        chatId: "chat-1",
        message: "hello",
        turn: { resolvedCs: { nested: () => undefined } },
      }),
    ).rejects.toBeInstanceOf(CoachClientProtocolError);
    expect(socket.sent).toEqual([]);
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      socket.emitMessage(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "ok" } }),
      );
    };
    await expect(client.call("chat", { chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "ok",
    });
    expect((JSON.parse(socket.sent[0]!) as { id: number }).id).toBe(1);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("routes interleaved notifications in parser-object order and isolates observer throws", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const calls: Array<{ id: number; text: string }> = [];
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      calls.push({ id: request.id, text });
    };
    const observed: string[] = [];
    const envelopes: CoachTurnEventNotificationEnvelope[] = [];
    const first = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      {
        onNotificationEnvelope: (envelope) => {
          envelopes.push(envelope);
          observed.push(`envelope:${envelope.params.event.turnId}`);
          throw new Error("advisory");
        },
        onEvent: (event) => {
          observed.push(`event:${event.turnId}`);
        },
      },
    );
    const second = client.call(
      "chat",
      { chatId: "chat-2", message: "two" },
      {
        onNotificationEnvelope: (envelope) => {
          envelopes.push(envelope);
          observed.push(`envelope:${envelope.params.event.turnId}`);
        },
        onEvent: (event) => {
          observed.push(`event:${event.turnId}`);
          throw new Error("advisory");
        },
      },
    );
    for (const [id, turnId] of [
      [2, "turn-2"],
      [1, "turn-1"],
      [2, "turn-3"],
    ] as const) {
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.turnEvent",
          params: {
            requestId: id,
            requestMethod: "chat",
            turnId,
            event: { type: "turn-start", turnId, chatId: `chat-${id}` },
          },
        }),
      );
    }
    expect(observed).toEqual([
      "envelope:turn-2",
      "event:turn-2",
      "envelope:turn-1",
      "event:turn-1",
      "envelope:turn-3",
      "event:turn-3",
    ]);
    for (const envelope of envelopes)
      expect(parseCoachRpcEnvelope(serializeCoachRpcEnvelope(envelope))).toEqual(envelope);
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "one" } }));
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { text: "two" } }));
    await expect(first).resolves.toEqual({ text: "one" });
    await expect(second).resolves.toEqual({ text: "two" });
    expect(calls.map((call) => call.id)).toEqual([1, 2]);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("delivers terminal envelopes before settlement and preserves typed remote errors", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const order: string[] = [];
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      if (request.id === 1)
        socket.emitMessage(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hasSession: false } }),
        );
      else
        socket.emitMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32600, message: "public remote message", data: { safe: true } },
          }),
        );
    };
    const successEnvelopes: CoachClientTerminalEnvelope[] = [];
    const success = client.call(
      "hasSession",
      { chatId: "chat-1" },
      {
        onTerminalEnvelope: (envelope) => {
          successEnvelopes.push(envelope);
          order.push("success-observer");
          throw new Error("advisory");
        },
      },
    );
    await success.then(() => order.push("success-resolve"));
    expect(order).toEqual(["success-observer", "success-resolve"]);
    const failure = client.call(
      "hasSession",
      { chatId: "chat-1" },
      {
        onTerminalEnvelope: (envelope) => {
          successEnvelopes.push(envelope);
          order.push("error-observer");
        },
      },
    );
    const error = await failure.catch((caught: unknown) => {
      order.push("error-catch");
      return caught;
    });
    expect(order.slice(-2)).toEqual(["error-observer", "error-catch"]);
    expect(error).toBeInstanceOf(CoachRpcRemoteError);
    expect(error).toMatchObject({
      name: "CoachRpcRemoteError",
      message: "public remote message",
      code: -32600,
      data: { safe: true },
    });
    expect(successEnvelopes).toHaveLength(2);
    for (const envelope of successEnvelopes)
      expect(parseCoachRpcEnvelope(serializeCoachRpcEnvelope(envelope))).toEqual(envelope);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("correlates operational progress before terminal and fails closed on malformed progress", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const order: string[] = [];
    const operation = client.call(
      "sync",
      {},
      {
        onNotificationEnvelope: (envelope) => order.push(`envelope:${envelope.params.event.phase}`),
        onEvent: (event) => order.push(`event:${event.phase}`),
        onTerminalEnvelope: () => order.push("terminal"),
      },
    );
    for (const event of [
      { phase: "started", completed: 0, total: 1 },
      { phase: "completed", completed: 1, total: 1 },
    ] as const) {
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.operationProgress",
          params: { requestId: 1, requestMethod: "sync", event },
        }),
      );
    }
    socket.emitMessage(
      serializeCoachRpcEnvelope({
        jsonrpc: "2.0",
        id: 1,
        result: {
          schemaVersion: 1,
          published: false,
          referenceSucceeded: true,
          requests: { store: 0, reference: 0, total: 0 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        },
      }),
    );
    await operation;
    expect(order).toEqual([
      "envelope:started",
      "event:started",
      "envelope:completed",
      "event:completed",
      "terminal",
    ]);

    const observed = vi.fn();
    const malformed = client.call(
      "importFiles",
      { paths: ["/synthetic/ride.fit"] },
      { onEvent: observed },
    );
    socket.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "coach.operationProgress",
        params: {
          requestId: 2,
          requestMethod: "importFiles",
          event: { phase: "completed", completed: 0, total: 1 },
        },
      }),
    );
    await expect(malformed).rejects.toBeInstanceOf(CoachClientProtocolError);
    expect(observed).not.toHaveBeenCalled();
  });

  it("calls selfTest through the generic registry with validated progress and result", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const events: unknown[] = [];
    const operation = client.call("selfTest", {}, { onEvent: (event) => events.push(event) });
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "selfTest",
      params: {},
    });
    for (const event of [
      { phase: "started", completed: 0, total: 1 },
      { phase: "completed", completed: 1, total: 1 },
    ] as const) {
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.operationProgress",
          params: { requestId: 1, requestMethod: "selfTest", event },
        }),
      );
    }
    const result = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: false,
      error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
    } as const;
    socket.emitMessage(serializeCoachRpcEnvelope({ jsonrpc: "2.0", id: 1, result }));
    await expect(operation).resolves.toEqual(result);
    expect(events).toEqual([
      { phase: "started", completed: 0, total: 1 },
      { phase: "completed", completed: 1, total: 1 },
    ]);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("calls Planning through the generic registry with validated progress and result", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const events: unknown[] = [];
    const command = {
      transitionId: "PL-T01" as const,
      commandId: "command-1",
      sourceConversationId: null,
    };
    const operation = client.call("executePlanTransition", command, {
      onEvent: (event) => events.push(event),
    });
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "executePlanTransition",
      params: command,
    });
    const event = {
      commandId: "command-1",
      transitionId: "PL-T01" as const,
      operationId: "operation-1",
      phase: "completed" as const,
      completed: 1,
      total: 1,
    };
    socket.emitMessage(
      serializeCoachRpcEnvelope({
        jsonrpc: "2.0",
        method: "coach.planProgress",
        params: { requestId: 1, requestMethod: "executePlanTransition", event },
      }),
    );
    const result = { status: "completed" as const, state: planReadModel };
    socket.emitMessage(serializeCoachRpcEnvelope({ jsonrpc: "2.0", id: 1, result }));
    await expect(operation).resolves.toEqual(result);
    expect(events).toEqual([event]);
    socket.closeSynchronously = true;
    await client.close();
  });

  it.each([
    {
      name: "command id",
      frames: [
        {
          kind: "progress" as const,
          event: {
            commandId: "command-2",
            transitionId: "PL-T01" as const,
            operationId: "operation-1",
            phase: "completed" as const,
            completed: 1,
            total: 1,
          },
        },
      ],
      observedEvents: 0,
    },
    {
      name: "transition id",
      frames: [
        {
          kind: "progress" as const,
          event: {
            commandId: "command-1",
            transitionId: "PL-T02" as const,
            operationId: "operation-1",
            phase: "completed" as const,
            completed: 1,
            total: 1,
          },
        },
      ],
      observedEvents: 0,
    },
    {
      name: "progress operation id",
      frames: [
        {
          kind: "progress" as const,
          event: {
            commandId: "command-1",
            transitionId: "PL-T01" as const,
            operationId: "operation-1",
            phase: "queued" as const,
            completed: 0,
            total: 1,
          },
        },
        {
          kind: "progress" as const,
          event: {
            commandId: "command-1",
            transitionId: "PL-T01" as const,
            operationId: "operation-2",
            phase: "completed" as const,
            completed: 1,
            total: 1,
          },
        },
      ],
      observedEvents: 1,
    },
    {
      name: "accepted operation id",
      frames: [
        {
          kind: "progress" as const,
          event: {
            commandId: "command-1",
            transitionId: "PL-T01" as const,
            operationId: "operation-1",
            phase: "completed" as const,
            completed: 1,
            total: 1,
          },
        },
        { kind: "accepted" as const, operationId: "operation-2" },
      ],
      observedEvents: 1,
    },
  ])(
    "fails closed on Planning $name correlation mismatches",
    async ({ frames, observedEvents }) => {
      const { socket, connecting } = acceptedSocket();
      const client = await connecting;
      socket.sendHook = () => {};
      const events: unknown[] = [];
      const operation = client.call(
        "executePlanTransition",
        { transitionId: "PL-T01", commandId: "command-1", sourceConversationId: null },
        { onEvent: (event) => events.push(event) },
      );
      for (const frame of frames) {
        socket.emitMessage(
          frame.kind === "progress"
            ? serializeCoachRpcEnvelope({
                jsonrpc: "2.0",
                method: "coach.planProgress",
                params: {
                  requestId: 1,
                  requestMethod: "executePlanTransition",
                  event: frame.event,
                },
              })
            : serializeCoachRpcEnvelope({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  status: "accepted",
                  operationId: frame.operationId,
                  state: planReadModel,
                },
              }),
        );
      }
      await expect(operation).rejects.toBeInstanceOf(CoachClientProtocolError);
      expect(events).toHaveLength(observedEvents);
      expect(socket.closeCalls).toHaveLength(1);
      const closing = client.close();
      socket.emitClose(1002, "protocol");
      await closing;
    },
  );

  it.each([-32700, -32600] as const)(
    "treats null-id protocol error %s as connection-wide",
    async (code) => {
      const { socket, connecting } = acceptedSocket();
      const client = await connecting;
      socket.sendHook = () => {};
      const terminals = vi.fn();
      const first = client.call(
        "chat",
        { chatId: "chat-1", message: "one" },
        { onTerminalEnvelope: terminals },
      );
      const second = client.call(
        "hasSession",
        { chatId: "chat-2" },
        { onTerminalEnvelope: terminals },
      );
      socket.emitMessage(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: "protocol" } }),
      );
      const [a, b] = await Promise.all([
        first.catch((error: unknown) => error),
        second.catch((error: unknown) => error),
      ]);
      expect(a).toBeInstanceOf(CoachClientProtocolError);
      expect(b).toBe(a);
      expect(terminals).not.toHaveBeenCalled();
      await expect(client.call("hasSession", { chatId: "chat-1" })).rejects.toBe(a);
      const closing = client.close();
      socket.emitClose(1002, "protocol");
      await closing;
    },
  );

  it.each([
    JSON.stringify({ jsonrpc: "2.0", id: 999, result: { text: "unknown" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32700, message: "bad id" } }),
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "foreign" } }),
    "not-json",
    new Uint8Array([1, 2]),
  ])("fails all pending work for violating frame", async (frame) => {
    const observer = vi.fn();
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    socket.sendHook = () => {};
    const terminals = vi.fn();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRemove = vi.spyOn(firstController.signal, "removeEventListener");
    const secondRemove = vi.spyOn(secondController.signal, "removeEventListener");
    const first = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      { signal: firstController.signal, onTerminalEnvelope: terminals },
    );
    const second = client.call(
      "hasSession",
      { chatId: "chat-2" },
      { signal: secondController.signal, onTerminalEnvelope: terminals },
    );
    socket.emitMessage(frame);
    const [a, b] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);
    expect(a).toBeInstanceOf(CoachClientProtocolError);
    expect(b).toBe(a);
    expect(terminals).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, a);
    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(socket.closeCalls).toHaveLength(1);
    const closing = client.close();
    socket.emitClose(1002, "protocol");
    await closing;
    firstController.abort();
    secondController.abort();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "reserves a protocol close before a %s synchronous observer close",
    async (closeSynchronously) => {
      let observerClose: Promise<void> | undefined;
      const observer = vi.fn((terminalClient: CoachClient) => {
        observerClose = terminalClient.close();
      });
      const { socket, connecting } = acceptedSocket("service-managed", {
        onTerminal: observer,
      });
      const client = await connecting;
      socket.sendHook = () => {};
      socket.closeSynchronously = closeSynchronously;
      const call = client.call("hasSession", { chatId: "chat-1" }).catch((error: unknown) => error);

      socket.emitMessage("not-json");

      const cause = await call;
      expect(cause).toBeInstanceOf(CoachClientProtocolError);
      expect(observer).toHaveBeenCalledExactlyOnceWith(client, cause);
      expect(socket.closeCalls).toEqual([{ code: 1002, reason: undefined }]);
      await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(cause);
      expect(observerClose).toBeDefined();
      if (!closeSynchronously) socket.emitClose(1002, "protocol");
      await observerClose;
      expect(observer).toHaveBeenCalledTimes(1);
      expect(socket.closeCalls).toEqual([{ code: 1002, reason: undefined }]);
    },
  );
});

describe("disconnect, close, and send bounds", () => {
  it("rejects a pre-aborted call without sending or consuming an id", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sent.length = 0;
    const controller = new AbortController();
    controller.abort(new Error("private abort detail"));

    const aborted = await client
      .call("hasSession", { chatId: "chat-1" }, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(aborted).toBeInstanceOf(CoachClientCallAbortedError);
    expect(aborted).toMatchObject({
      name: "CoachClientCallAbortedError",
      message: "Coach client call aborted",
      method: "hasSession",
    });
    expect(String(aborted)).not.toContain("private abort detail");
    expect(socket.sent).toEqual([]);

    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      socket.emitMessage(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { hasSession: true } }),
      );
    };
    await expect(client.call("hasSession", { chatId: "chat-2" })).resolves.toEqual({
      hasSession: true,
    });
    expect((JSON.parse(socket.sent[0]!) as { id: number }).id).toBe(1);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("covers every registered method in the deadline cases", () => {
    expect(rpcDeadlineCases.map(([method]) => method).sort()).toEqual(
      Object.keys(COACH_RPC_METHOD_REGISTRY).sort(),
    );
  });

  it.each(rpcDeadlineCases)(
    "applies the absolute %s deadline at %sms",
    async (method, params, timeoutMs) => {
      vi.useFakeTimers();
      const terminals: Array<{ client: CoachClient; cause: CoachClientTerminalCause }> = [];
      const { socket, connecting } = acceptedSocket("service-managed", {
        onTerminal: (client, cause) => terminals.push({ client, cause }),
      });
      const client = await connecting;
      socket.sendHook = () => {};
      let settled = false;
      const call = client.call(method, params as never).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);
      expect(terminals).toEqual([]);
      expect(socket.closeCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      const error = await call;
      expect(error).toBeInstanceOf(CoachClientCallTimeoutError);
      expect(error).toMatchObject({
        name: "CoachClientCallTimeoutError",
        message: "Coach client call timed out",
        method,
        timeoutMs,
      });
      expect(terminals).toEqual([{ client, cause: error }]);
      expect(socket.closeCalls).toHaveLength(1);
    },
  );

  it("lets a response just before the deadline win and times out at the exact boundary", async () => {
    vi.useFakeTimers();
    const before = acceptedSocket();
    const beforeClient = await before.connecting;
    before.socket.sendHook = () => {};
    const winning = beforeClient.call("hasSession", { chatId: "chat-1" });
    await vi.advanceTimersByTimeAsync(29_999);
    before.socket.emitMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hasSession: true } }),
    );
    await expect(winning).resolves.toEqual({ hasSession: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(before.socket.closeCalls).toEqual([]);
    before.socket.closeSynchronously = true;
    await beforeClient.close();

    const terminal = vi.fn();
    const exact = acceptedSocket("service-managed", { onTerminal: terminal });
    const exactClient = await exact.connecting;
    exact.socket.sendHook = () => {};
    const timedOut = exactClient
      .call("hasSession", { chatId: "chat-2" })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = await timedOut;
    exact.socket.emitMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hasSession: true } }),
    );
    expect(timeout).toBeInstanceOf(CoachClientCallTimeoutError);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(exactClient, timeout);
    expect(exact.socket.closeCalls).toHaveLength(1);
  });

  it("does not slide the self-test deadline when valid progress keeps arriving", async () => {
    vi.useFakeTimers();
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const progress = vi.fn();
    const call = client
      .call("selfTest", {}, { onEvent: progress })
      .catch((error: unknown) => error);
    for (let elapsed = 30_000; elapsed < 120_000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.operationProgress",
          params: {
            requestId: 1,
            requestMethod: "selfTest",
            event: { phase: "started", completed: 0, total: 1 },
          },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(call).resolves.toBeInstanceOf(CoachClientCallTimeoutError);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("latches one mid-flight abort across pending and future calls without replay", async () => {
    const observer = vi.fn(() => {
      throw new Error("advisory");
    });
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    socket.sent.length = 0;
    socket.sendHook = () => {};
    const controller = new AbortController();
    const secondController = new AbortController();
    const firstRemove = vi.spyOn(controller.signal, "removeEventListener");
    const secondRemove = vi.spyOn(secondController.signal, "removeEventListener");
    const terminalEnvelope = vi.fn();
    const first = client
      .call(
        "chat",
        { chatId: "chat-1", message: "one" },
        {
          signal: controller.signal,
          onTerminalEnvelope: terminalEnvelope,
        },
      )
      .catch((error: unknown) => error);
    const second = client
      .call("hasSession", { chatId: "chat-2" }, { signal: secondController.signal })
      .catch((error: unknown) => error);
    controller.abort(new Error("private abort detail"));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBeInstanceOf(CoachClientCallAbortedError);
    expect(a).toMatchObject({ method: "chat", message: "Coach client call aborted" });
    expect(String(a)).not.toContain("private abort detail");
    expect(b).toBe(a);
    await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(a);
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, a);
    expect(terminalEnvelope).not.toHaveBeenCalled();
    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.sent).toHaveLength(2);
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "late" } }));
    expect(observer).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(2);
  });

  it("clears queued sends and fans one timeout cause to all pending and future calls", async () => {
    vi.useFakeTimers();
    const observer = vi.fn();
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    socket.sent.length = 0;
    socket.bufferedAmount = 1_048_576;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRemove = vi.spyOn(firstController.signal, "removeEventListener");
    const secondRemove = vi.spyOn(secondController.signal, "removeEventListener");
    const first = client
      .call("hasSession", { chatId: "chat-1" }, { signal: firstController.signal })
      .catch((error: unknown) => error);
    const second = client
      .call(
        "chat",
        { chatId: "chat-2", message: "queued" },
        {
          signal: secondController.signal,
        },
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBeInstanceOf(CoachClientCallTimeoutError);
    expect(a).toMatchObject({ method: "hasSession", timeoutMs: 30_000 });
    expect(b).toBe(a);
    await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(a);
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, a);
    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(socket.closeCalls).toHaveLength(1);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent).toEqual([]);
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hasSession: true } }));
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "remote-error"] as const)(
    "cleans the call deadline and abort listener before %s terminal observation",
    async (kind) => {
      vi.useFakeTimers();
      const connectionTerminal = vi.fn();
      const { socket, connecting } = acceptedSocket("service-managed", {
        onTerminal: connectionTerminal,
      });
      const client = await connecting;
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      socket.sendHook = () => {};
      const call = client
        .call(
          "hasSession",
          { chatId: "chat-1" },
          {
            signal: controller.signal,
            onTerminalEnvelope: () => controller.abort(),
          },
        )
        .catch((error: unknown) => error);
      socket.emitMessage(
        JSON.stringify(
          kind === "success"
            ? { jsonrpc: "2.0", id: 1, result: { hasSession: true } }
            : { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "remote" } },
        ),
      );
      const outcome = await call;
      if (kind === "success") expect(outcome).toEqual({ hasSession: true });
      else expect(outcome).toBeInstanceOf(CoachRpcRemoteError);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(connectionTerminal).not.toHaveBeenCalled();
      expect(socket.closeCalls).toEqual([]);
      socket.closeSynchronously = true;
      await client.close();
    },
  );

  it("uses one first cause for socket error and later close while cleaning call listeners", async () => {
    const observer = vi.fn();
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    socket.sendHook = () => {};
    const call = client
      .call("hasSession", { chatId: "chat-1" }, { signal: controller.signal })
      .catch((error: unknown) => error);
    socket.emitError();
    const cause = await call;
    socket.emitClose(1006, "later close");
    controller.abort();

    expect(cause).toBeInstanceOf(CoachClientDisconnectedError);
    expect(cause).toMatchObject({ code: 1006, reason: "" });
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, cause);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(socket.closeCalls).toHaveLength(1);
    await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(cause);
  });

  it("fans an unexpected disconnect to every pending and future call", async () => {
    const observer = vi.fn();
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    socket.sendHook = () => {};
    const terminal = vi.fn();
    const a = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      { onTerminalEnvelope: terminal },
    );
    const b = client.call("hasSession", { chatId: "chat-2" }, { onTerminalEnvelope: terminal });
    socket.emitClose(1006, "network gone");
    const [first, second] = await Promise.all([
      a.catch((error: unknown) => error),
      b.catch((error: unknown) => error),
    ]);
    expect(first).toBeInstanceOf(CoachClientDisconnectedError);
    expect(first).toMatchObject({
      code: 1006,
      reason: "network gone",
      message: "Coach client disconnected",
    });
    expect(second).toBe(first);
    expect(terminal).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, first);
    await expect(client.call("hasSession", { chatId: "chat-1" })).rejects.toBe(first);
    socket.emitError();
    expect(observer).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("explicit close is idempotent, settles pending, and handles synchronous close", async () => {
    const observer = vi.fn();
    const { socket, connecting } = acceptedSocket("service-managed", { onTerminal: observer });
    const client = await connecting;
    socket.sendHook = () => {};
    socket.closeSynchronously = true;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      { signal: controller.signal },
    );
    const first = client.close(1000, "done");
    const second = client.close(1001, "ignored");
    expect(first).toBe(second);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientDisconnectedError",
      code: 1000,
      reason: "done",
    });
    await expect(first).resolves.toBeUndefined();
    expect(socket.closeCalls).toHaveLength(1);
    expect(observer).toHaveBeenCalledExactlyOnceWith(client, error);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("resolves explicit close at its bounded timeout when no event arrives", async () => {
    vi.useFakeTimers();
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const closing = client.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBeUndefined();
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("enforces high-low hysteresis, FIFO order, and 128 waiting sends", async () => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    socket.sendHook = (text) => {
      const frame = JSON.parse(text) as { type?: string; id?: number };
      if (frame.type === "handshake")
        socket.emitMessage(
          JSON.stringify(
            createAcceptedServerHandshakeFrame(
              "service-managed",
              PROTOCOL_VERSION,
              acceptedHandshakeBinding,
            ),
          ),
        );
      else if (frame.id !== undefined)
        socket.emitMessage(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { hasSession: true } }),
        );
    };
    const connecting = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      highWaterMarkBytes: 20,
      lowWaterMarkBytes: 5,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.emitOpen();
    const client = await connecting;
    socket.sent.length = 0;
    socket.bufferedAmount = 20;
    const admitted = Array.from({ length: 129 }, (_, index) =>
      client.call("hasSession", { chatId: `chat-${index}` }),
    );
    for (const promise of admitted) void promise.catch(() => undefined);
    await expect(client.call("hasSession", { chatId: "overflow" })).rejects.toBeInstanceOf(
      CoachClientBackpressureError,
    );
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 6;
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 5;
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(admitted);
    expect(socket.sent.map((text) => (JSON.parse(text) as { id: number }).id)).toEqual(
      Array.from({ length: 129 }, (_, index) => index + 1),
    );
    socket.closeSynchronously = true;
    await client.close();
  });

  it.each([1, 2])("latches a synchronous RPC send throw at position %s", async (throwAt) => {
    vi.useFakeTimers();
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    let sends = 0;
    socket.sendHook = () => {
      sends++;
      if (sends === throwAt) throw new Error("private send detail");
    };
    if (throwAt === 2) socket.bufferedAmount = 1_048_576;
    const first = client.call("hasSession", { chatId: "chat-1" }).catch((error: unknown) => error);
    const second = client.call("hasSession", { chatId: "chat-2" }).catch((error: unknown) => error);
    if (throwAt === 2) {
      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(10);
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(CoachClientProtocolError);
    expect(b).toBe(a);
    expect(String(a)).not.toContain("private send detail");
    await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(a);
    const closing = client.close();
    socket.emitClose(1002, "protocol");
    await closing;
  });
});

describe("public observer types", () => {
  it("exports the generic observers and excludes null-id protocol terminals", () => {
    expectTypeOf<CoachClientCallOptions<"chat">["signal"]>().toEqualTypeOf<
      AbortSignal | undefined
    >();
    expectTypeOf<CoachClientCallOptions<"chat">["onNotificationEnvelope"]>().toEqualTypeOf<
      ((envelope: CoachTurnEventNotificationEnvelope) => void) | undefined
    >();
    expectTypeOf<CoachClientCallOptions<"chat">["onTerminalEnvelope"]>().toEqualTypeOf<
      ((envelope: CoachClientTerminalEnvelope) => void) | undefined
    >();
    expectTypeOf<JsonRpcProtocolErrorResponseEnvelope>().not.toExtend<CoachClientTerminalEnvelope>();
  });
});
