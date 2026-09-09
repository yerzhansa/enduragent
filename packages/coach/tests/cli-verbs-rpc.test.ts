import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  CoachClientDisconnectedError,
  connectCoachClient,
  type CoachClient,
} from "@enduragent/coach-client";
import {
  Memory,
  classifyFailure,
  createConversationStore,
  createMissingPlatformCalendarMutations,
  engineConfigFromConfig,
  extractRetryAfterMs,
  type Config,
} from "@enduragent/core";
import {
  createCoachEngine,
  type EngineHostPorts,
  type ModelTransportDecorator,
  type ModelTransportRequest,
} from "@enduragent/engine";
import type { GenerateResult } from "@enduragent/engine/sport";
import { cyclingSport } from "@enduragent/sport-cycling";
import {
  CoachRemoteError,
  connectCoachVerbTransport,
  connectRemoteCoachTransport,
  createCoachVerbRequest,
  runCoachVerb,
  type CoachVerbTransport,
} from "@enduragent/coach-cli";
import {
  EXIT_SUCCESS,
  serializeCoachRpcEnvelope,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
  type PlanCreationOperations,
  type PlanChangeOperations,
  type TelegramControlSnapshot,
  type TurnEvent,
} from "@enduragent/coach-contract";
import { createCoachRpcServer, type CoachRpcServer } from "../src/daemon/rpc-server.js";
import type { DesktopTelegramController } from "../src/desktop-telegram-controller.js";
import { planCreationOperationStubs } from "./helpers/plan-creation-operation-stubs.js";

const token = "s".repeat(43);
const disabledTelegramSnapshot: TelegramControlSnapshot = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
};
const disabledTelegram: DesktopTelegramController = {
  getStatus: () => disabledTelegramSnapshot,
  configure: async () => ({ outcome: "applied", current: disabledTelegramSnapshot }),
  enable: async () => disabledTelegramSnapshot,
  disable: async () => disabledTelegramSnapshot,
  replace: async () => ({ outcome: "applied", current: disabledTelegramSnapshot }),
  reconcile: async () => disabledTelegramSnapshot,
  inspectTelegramCredential: async () => ({ status: "invalid-token" }),
  deleteTelegramWebhook: async () => ({ status: "invalid-token" }),
  forgetTelegramCredential: async () => disabledTelegramSnapshot,
  resetTelegramAccess: async () => disabledTelegramSnapshot,
  beginTelegramPairing: async () => disabledTelegramSnapshot,
  cancelTelegramPairing: async () => disabledTelegramSnapshot,
  listTelegramAllowedSenders: async () => ({ senders: [] }),
  addTelegramAllowedSender: async () => ({
    outcome: "applied" as const,
    current: { senders: [] },
  }),
  removeTelegramAllowedSender: async () => ({
    outcome: "applied" as const,
    current: { senders: [] },
  }),
  stopPolling: async () => disabledTelegramSnapshot,
  resumePolling: async () => disabledTelegramSnapshot,
  drainPending: async () => disabledTelegramSnapshot,
  close: async () => disabledTelegramSnapshot,
};
const operations: CoachOperations & PlanCreationOperations & PlanChangeOperations = {
  ...planCreationOperationStubs,
  importFiles: async ({ paths }) => ({
    schemaVersion: 2,
    files: { total: paths.length, imported: paths.length, quarantined: 0 },
    changes: {
      rawFilesInserted: paths.length,
      sourceRecordsInserted: paths.length,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
  }),
  sync: async () => ({
    schemaVersion: 1,
    published: true,
    referenceSucceeded: true,
    requests: { store: 1, reference: 1, total: 2 },
    droppedActivities: {
      overall: { total: 0, visible: 0, restrictions: [], other: 0 },
      recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
    },
  }),
  saveIntake: async () => ({ schemaVersion: 1, saved: true }),
  getTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  listArchivedConversations: async () => ({
    schemaVersion: 1,
    conversations: [],
    truncated: false,
  }),
  deleteArchivedConversation: async () => ({ schemaVersion: 1, status: "deleted" }),
  getArchivedTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  configureRuntime: async ({ llm, intervals, session }) => ({
    schemaVersion: 3,
    status: "applied",
    applied: {
      llm: llm !== undefined,
      intervals: intervals !== undefined,
      session: session !== undefined,
    },
  }),
  getRuntimeConfig: async () => ({
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: false },
    intervals: {
      athlete_id: "synthetic-athlete",
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
  }),
};
const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2000-01-01T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2000-01-01T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

function capture(): { readonly stream: Writable; read(): string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    }),
    read: () => value,
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM cli-verbs-rpc\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

interface RunningRpc {
  readonly rpc: CoachRpcServer;
  readonly server: Server;
  readonly url: string;
  nextClientDisconnect(): Promise<void>;
}

async function startRpc(engine: CoachEngine): Promise<RunningRpc> {
  const rpc = createCoachRpcServer({
    engine,
    operations,
    spend: {
      getSpendSummary: () => Promise.reject(new Error("Spend handler is not used.")),
      setDailySpendCap: () => Promise.reject(new Error("Spend handler is not used.")),
    },
    selfTestOperations: {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
    telegram: disabledTelegram,
    token,
    owner: "unmanaged-foreground",
    athleteHome: "/tmp/enduragent-cli-rpc-test",
  });
  const server = createServer();
  const disconnectWaiters: Array<() => void> = [];
  server.on("connection", (socket) => {
    socket.once("close", () => disconnectWaiters.shift()?.());
  });
  server.on("upgrade", rpc.handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("missing test port");
  return {
    rpc,
    server,
    url: `ws://127.0.0.1:${address.port}/rpc`,
    nextClientDisconnect: () => new Promise((resolve) => disconnectWaiters.push(resolve)),
  };
}

async function closeServer(
  running: RunningRpc,
  clients: readonly CoachClient[] = [],
): Promise<void> {
  for (const client of clients) await client.close().catch(() => {});
  await running.rpc.close();
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function closeTransport(transport: CoachVerbTransport | undefined): Promise<void> {
  await transport?.close().catch(() => {});
}

describe.skipIf(!hasLoopback)("CLI verbs over real RPC framing", () => {
  it("replays an active exact retry after a second disconnect and drains later work once", async () => {
    const dataDir = await mkdtemp(join(await realpath(tmpdir()), "coach-queue-rpc-"));
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const requests: ModelTransportRequest[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let announceRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      announceRetryStarted = resolve;
    });
    let finishRetry: (() => void) | undefined;
    const generated = (text: string): GenerateResult => {
      const usage = {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      };
      return { text, toolCalls: [], finishReason: "stop", usage, totalUsage: usage, steps: 1 };
    };
    const modelTransportDecorator: ModelTransportDecorator = () => ({
      generate(request): Promise<GenerateResult> {
        requests.push(request);
        if (requests.length === 1) {
          request.options.onTextDelta?.("Partial");
          started();
          return new Promise<GenerateResult>((_resolve, reject) => {
            request.options.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
              once: true,
            });
          });
        }
        if (requests.length === 2) {
          announceRetryStarted();
          return new Promise<GenerateResult>((resolve, reject) => {
            finishRetry = () => resolve(generated("Recovered"));
            request.options.signal?.addEventListener(
              "abort",
              () => reject(new Error("retry stopped")),
              { once: true },
            );
          });
        }
        return Promise.resolve(generated("Later reply"));
      },
    });
    const config: Config = {
      dataSource: "platform",
      llm: {
        provider: "openai-codex",
        model: "gpt-5.4",
        apiKey: "",
        authProfile: "openai-codex",
      },
      intervals: { apiKey: "", athleteId: "0" },
      telegram: { botToken: "" },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 272_000,
      dataDir,
    };
    const conversation = createConversationStore(dataDir);
    let idSequence = 0;
    const ports: EngineHostPorts = {
      config: engineConfigFromConfig(config),
      memory: new Memory(dataDir, "UTC"),
      chatStore: conversation,
      transcriptWriter: conversation,
      coachDecisions: conversation,
      secrets: { resolve: async () => "" },
      platform: {
        legacyClient: null,
        athleteData: undefined,
        calendarMutations: createMissingPlatformCalendarMutations(),
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      usage: { append: () => {} },
      stateReader: {
        getAthleteState: async () => {
          throw new Error("Athlete state is unavailable in this test.");
        },
      },
      readReferenceState: () => ({ errorState: null, latest: null }),
      getAccessToken: async () => "token",
      classifyFailure,
      extractRetryAfterMs,
      now: () => 0,
      randomId: () => `rpc-queue-${++idSequence}`,
      modelTransportDecorator,
    };
    const queueEngine = createCoachEngine({ sport: cyclingSport, ports });
    const directChat = vi.spyOn(queueEngine, "chat");
    const running = await startRpc(queueEngine);
    const clients: CoachClient[] = [];
    const chatId = "desktop";
    let firstTurnId: string | undefined;
    try {
      const first = await connectCoachClient({ url: running.url, token, closeTimeoutMs: 250 });
      clients.push(first);
      await first.call("enqueueChatMessage", {
        chatId,
        submissionId: "submission-first",
        text: "First",
      });
      const firstEvents: TurnEvent[] = [];
      const firstRun = first.call(
        "resumeChatQueue",
        { chatId },
        {
          onEvent: (event) => {
            firstEvents.push(event);
            if (event.type === "turn-start") firstTurnId = event.turnId;
          },
        },
      );
      const firstOutcome = firstRun.catch((error: unknown) => error);
      await firstStarted;
      await vi.waitFor(() =>
        expect(firstEvents.map((event) => event.type)).toEqual(["turn-start", "text_delta"]),
      );
      expect(firstTurnId).toBeDefined();
      expect(firstEvents[1]).toMatchObject({ type: "text_delta", delta: "Partial" });
      await first.call("enqueueChatMessage", {
        chatId,
        submissionId: "submission-later-one",
        text: "Later one",
      });
      await first.call("enqueueChatMessage", {
        chatId,
        submissionId: "submission-later-two",
        text: "Later two",
      });

      const serverObservedDisconnect = running.nextClientDisconnect();
      await first.close();
      await serverObservedDisconnect;
      expect(await firstOutcome).toBeInstanceOf(CoachClientDisconnectedError);

      const retryClient = await connectCoachClient({
        url: running.url,
        token,
        closeTimeoutMs: 250,
      });
      clients.push(retryClient);
      const recovery = await retryClient.call("getChatQueue", { chatId });
      expect(recovery.items.map((item) => item.text)).toEqual(["First", "Later one", "Later two"]);
      expect(recovery.retryRequired).toMatchObject({
        queuedMessageIds: [recovery.items[0]!.queuedMessageId],
        status: "retry-required",
      });

      const retryEvents: TurnEvent[] = [];
      const retryRun = retryClient.call(
        "retryQueuedTurn",
        { chatId, claimId: recovery.retryRequired!.claimId },
        { onEvent: (event) => retryEvents.push(event) },
      );
      const retryOutcome = retryRun.catch((error: unknown) => error);
      await retryStarted;
      await vi.waitFor(() =>
        expect(retryEvents.map((event) => event.type)).toEqual(["turn-start"]),
      );
      expect(retryEvents[0]?.turnId).toBe(firstTurnId);

      const serverObservedRetryDisconnect = running.nextClientDisconnect();
      const retryClosing = retryClient.close();
      expect(await retryOutcome).toBeInstanceOf(CoachClientDisconnectedError);
      await serverObservedRetryDisconnect;
      await retryClosing;

      const recovered = await connectCoachClient({ url: running.url, token, closeTimeoutMs: 250 });
      clients.push(recovered);
      const replayedEvents: TurnEvent[] = [];
      const retriedRun = recovered.call(
        "retryQueuedTurn",
        { chatId, claimId: recovery.retryRequired!.claimId },
        { onEvent: (event) => replayedEvents.push(event) },
      );
      await vi.waitFor(() =>
        expect(replayedEvents.map((event) => event.type)).toEqual(["turn-start"]),
      );
      expect(replayedEvents[0]).toEqual(retryEvents[0]);
      expect(requests).toHaveLength(2);
      if (finishRetry === undefined) throw new Error("retry model did not start");
      finishRetry();
      const retried = await retriedRun;
      expect(retried.response?.text).toBe("Recovered");
      expect(retried.snapshot.retryRequired).toBeUndefined();
      expect(retried.snapshot.items.map((item) => item.text)).toEqual(["Later one", "Later two"]);
      expect(retryEvents.map((event) => event.type)).toEqual(["turn-start"]);
      expect(replayedEvents.map((event) => event.type)).toEqual(["turn-start", "final-text"]);
      expect(replayedEvents[0]).toEqual(retryEvents[0]);

      const laterEvents: TurnEvent[] = [];
      const drained = await recovered.call(
        "resumeChatQueue",
        { chatId },
        { onEvent: (event) => laterEvents.push(event) },
      );
      expect(drained.response?.text).toBe("Later reply");
      expect(drained.snapshot.items).toEqual([]);
      expect(laterEvents.map((event) => event.type)).toEqual(["turn-start", "final-text"]);
      const userMessages = requests.map(
        (request) =>
          request.options.messages?.at(-1) as { readonly role: string; readonly content: string },
      );
      expect(userMessages.map((message) => message.role)).toEqual(["user", "user", "user"]);
      expect(userMessages.map((message) => message.content.split("\nCurrent time:", 1)[0])).toEqual(
        ["First", "First", "Later one\n\nLater two"],
      );
      expect(directChat).not.toHaveBeenCalled();
      expect(requests).toHaveLength(3);

      const relaunched = createConversationStore(dataDir);
      const persisted = relaunched.readCurrentConversationPage(chatId, { cursor: null, limit: 10 });
      expect(
        persisted.turns.map(({ turnId, athleteText, coachText, delivery }) => ({
          turnId,
          athleteText,
          coachText,
          delivery,
        })),
      ).toEqual([
        {
          turnId: firstTurnId,
          athleteText: "First",
          coachText: "Partial",
          delivery: "interrupted",
        },
        {
          turnId: firstTurnId,
          athleteText: "First",
          coachText: "Recovered",
          delivery: undefined,
        },
        {
          turnId: expect.any(String),
          athleteText: "Later one\n\nLater two",
          coachText: "Later reply",
          delivery: undefined,
        },
      ]);
      expect(persisted.turns[2]?.turnId).not.toBe(firstTurnId);
    } finally {
      finishRetry?.();
      if (firstTurnId !== undefined) {
        await queueEngine.stopChat?.({ chatId, turnId: firstTurnId }).catch(() => undefined);
      }
      await closeServer(running, clients);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs all five verbs, preserves stream envelopes, and serves warm state under 500 ms", async () => {
    const chatCalls: Parameters<CoachEngine["chat"]>[0][] = [];
    const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
    const engine: CoachEngine = {
      chat: vi.fn(async (request, onEvent) => {
        chatCalls.push(request);
        const event: TurnEvent = {
          type: "turn-start",
          turnId: `turn-${chatCalls.length}`,
          chatId: request.chatId,
        };
        onEvent?.(event);
        return { text: request.message };
      }),
      getCoachDecision: async () => ({ decision: null }),
      answerCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      skipCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      resumeCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      getAthleteState,
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
    };
    const running = await startRpc(engine);
    const transports: CoachVerbTransport[] = [];
    try {
      const rows = [
        {
          verb: { name: "ask", input: { kind: "argv", text: "hello" } } as const,
          outputMode: "stream-json" as const,
          expected: "hello",
        },
        {
          verb: { name: "state" } as const,
          outputMode: "json" as const,
          expected: undefined,
        },
        {
          verb: { name: "analyze", target: "last ride" } as const,
          outputMode: "json" as const,
          expected: '/analyze "last ride"',
        },
        {
          verb: { name: "plan-week" } as const,
          outputMode: "text" as const,
          expected: "/plan",
        },
        {
          verb: {
            name: "wellness-set",
            entries: [{ key: "sleep", value: "good" }],
          } as const,
          outputMode: "json" as const,
          expected: '/wellness set [{"key":"sleep","value":"good"}]',
        },
      ];
      let streamOutput = "";
      for (const row of rows) {
        const stdout = capture();
        const stderr = capture();
        const transport = await connectCoachVerbTransport({ url: running.url, token });
        transports.push(transport);
        const request = createCoachVerbRequest({
          verb: row.verb,
          chatId: row.verb.name === "state" ? undefined : "cli:RaceA",
          stdinText: undefined,
          signal: new AbortController().signal,
          callerCwd: "/synthetic/caller",
        });
        await expect(
          runCoachVerb({
            request,
            outputMode: row.outputMode,
            terminal: { stdout: stdout.stream, stderr: stderr.stream },
            transport,
          }),
        ).resolves.toBe(EXIT_SUCCESS);
        expect(stderr.read()).toBe("");
        if (row.outputMode === "stream-json") streamOutput = stdout.read();
        await transport.close();
      }
      expect(chatCalls).toEqual([
        { chatId: "cli:RaceA", message: "hello" },
        { chatId: "cli:RaceA", message: '/analyze "last ride"' },
        { chatId: "cli:RaceA", message: "/plan" },
        {
          chatId: "cli:RaceA",
          message: '/wellness set [{"key":"sleep","value":"good"}]',
        },
      ]);
      expect(getAthleteState).toHaveBeenCalledOnce();
      expect(getAthleteState).toHaveBeenCalledWith();
      const lines = streamOutput
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "coach.turnEvent",
        params: { requestMethod: "chat", event: { type: "turn-start" } },
      });
      expect(lines[1]).toMatchObject({ jsonrpc: "2.0", result: { text: "hello" } });
      expect(streamOutput).toBe(lines.map(serializeCoachRpcEnvelope).join("\n") + "\n");

      const warm = await connectCoachVerbTransport({ url: running.url, token });
      transports.push(warm);
      const stdout = capture();
      const stderr = capture();
      const startedAt = performance.now();
      await expect(
        runCoachVerb({
          request: createCoachVerbRequest({
            verb: { name: "state" },
            chatId: undefined,
            stdinText: undefined,
            signal: new AbortController().signal,
            callerCwd: "/synthetic/caller",
          }),
          outputMode: "json",
          terminal: { stdout: stdout.stream, stderr: stderr.stream },
          transport: warm,
        }),
      ).resolves.toBe(EXIT_SUCCESS);
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(stdout.read()).toBe(`${JSON.stringify(state)}\n`);
      expect(stderr.read()).toBe("");
    } finally {
      for (const transport of transports) await closeTransport(transport);
      await closeServer(running);
    }
  });

  it("enforces per-key FIFO, cross-key fairness, queued removal, and in-flight detach", async () => {
    const gates = new Map<string, Deferred<{ text: string }>>();
    const entered: string[] = [];
    const engine: CoachEngine = {
      async chat(request) {
        entered.push(request.message);
        const gate = gates.get(request.message);
        return gate === undefined ? { text: request.message } : gate.promise;
      },
      getCoachDecision: async () => ({ decision: null }),
      answerCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      skipCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      resumeCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      getAthleteState: async () => state,
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
    };
    const running = await startRpc(engine);
    const clients: CoachClient[] = [];
    const transports: CoachVerbTransport[] = [];
    try {
      const a1Gate = deferred<{ text: string }>();
      gates.set("A1", a1Gate);
      const a1 = await connectCoachClient({ url: running.url, token });
      const a2 = await connectCoachClient({ url: running.url, token });
      const b1 = await connectCoachClient({ url: running.url, token });
      clients.push(a1, a2, b1);
      const a1Call = a1.call("chat", { chatId: "cli:A", message: "A1" });
      await vi.waitFor(() => expect(entered).toEqual(["A1"]));
      const a2Call = a2.call("chat", { chatId: "cli:A", message: "A2" });
      const b1Call = b1.call("chat", { chatId: "cli:B", message: "B1" });
      await expect(b1Call).resolves.toEqual({ text: "B1" });
      expect(entered).toEqual(["A1", "B1"]);
      a1Gate.resolve({ text: "A1" });
      await expect(a1Call).resolves.toEqual({ text: "A1" });
      await expect(a2Call).resolves.toEqual({ text: "A2" });
      expect(entered).toEqual(["A1", "B1", "A2"]);

      const heldGate = deferred<{ text: string }>();
      gates.set("held", heldGate);
      const held = await connectCoachClient({ url: running.url, token });
      const queued = await connectCoachClient({ url: running.url, token });
      clients.push(held, queued);
      const heldCall = held.call("chat", { chatId: "cli:cancel", message: "held" });
      await vi.waitFor(() => expect(entered).toContain("held"));
      const queuedCall = queued.call("chat", { chatId: "cli:cancel", message: "cancelled" });
      const queuedRejection = expect(queuedCall).rejects.toBeInstanceOf(
        CoachClientDisconnectedError,
      );
      const serverObservedDisconnect = running.nextClientDisconnect();
      await queued.close();
      await queuedRejection;
      await serverObservedDisconnect;
      heldGate.resolve({ text: "held" });
      await expect(heldCall).resolves.toEqual({ text: "held" });
      await Promise.resolve();
      expect(entered).not.toContain("cancelled");

      const detachedGate = deferred<{ text: string }>();
      gates.set("detached", detachedGate);
      const detachedTransport = await connectCoachVerbTransport({ url: running.url, token });
      const followerTransport = await connectCoachVerbTransport({ url: running.url, token });
      transports.push(detachedTransport, followerTransport);
      const controller = new AbortController();
      const detachedCall = detachedTransport.request({
        method: "chat",
        params: { chatId: "cli:detach", message: "detached" },
        signal: controller.signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      });
      await vi.waitFor(() => expect(entered).toContain("detached"));
      const followerCall = followerTransport.request({
        method: "chat",
        params: { chatId: "cli:detach", message: "follower" },
        signal: new AbortController().signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      });
      controller.abort();
      await expect(detachedCall).rejects.toMatchObject({ failure: { kind: "detached" } });
      expect(entered).not.toContain("follower");
      detachedGate.resolve({ text: "detached" });
      await expect(followerCall).resolves.toMatchObject({ result: { text: "follower" } });
      expect(entered.indexOf("detached")).toBeLessThan(entered.indexOf("follower"));
    } finally {
      for (const transport of transports) await closeTransport(transport);
      await closeServer(running, clients);
    }
  });

  it("auto-starts once only after absence and reaps the created child on timeout", async () => {
    const winner = {
      kind: "remote",
      request: vi.fn(),
      close: vi.fn(async () => {}),
    } as CoachVerbTransport;
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(winner);
    const detachAfterHealthy = vi.fn();
    const disposeAfterFailedStart = vi.fn(async () => {});
    let now = 0;
    await expect(
      connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: async () => "absent",
        startEphemeralDaemon: async () => ({ detachAfterHealthy, disposeAfterFailedStart }),
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).resolves.toBe(winner);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(detachAfterHealthy).toHaveBeenCalledOnce();
    expect(disposeAfterFailedStart).not.toHaveBeenCalled();

    for (const registration of ["present", "unknown"] as const) {
      const start = vi.fn();
      await expect(
        connectRemoteCoachTransport({
          connect: async () => {
            throw new CoachRemoteError({ kind: "unavailable" });
          },
          serviceRegistrationState: async () => registration,
          startEphemeralDaemon: start,
          delay: async () => {},
          monotonicNow: () => 0,
        }),
      ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
      expect(start).not.toHaveBeenCalled();
    }

    const reap = vi.fn(async () => {});
    now = 0;
    await expect(
      connectRemoteCoachTransport({
        connect: async () => {
          throw new CoachRemoteError({ kind: "unavailable" });
        },
        serviceRegistrationState: async () => "absent",
        startEphemeralDaemon: async () => ({
          detachAfterHealthy: vi.fn(),
          disposeAfterFailedStart: reap,
        }),
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    expect(reap).toHaveBeenCalledOnce();
  });
});
