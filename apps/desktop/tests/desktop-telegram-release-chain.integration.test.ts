import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  createClientHandshakeFrame,
  type CoachEngine,
  type CoachOperations,
  type PlanCreationOperations,
  type PlanChangeOperations,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramControlCoordinator } from "../src/main/telegram-control.js";
import type { TelegramCredentialVault } from "../src/main/telegram-credential-vault.js";
import type { TelegramPowerMonitorPort } from "../src/main/telegram-power.js";
import type { CoachRpcServer } from "../../../packages/coach/src/daemon/rpc-server.js";
import type { DaemonHealthState } from "../../../packages/coach/src/daemon/healthz-server.js";
import type { InvocationCoordinator } from "../../../packages/coach/src/daemon/invocation-coordinator.js";
import type { DesktopTelegramController } from "../../../packages/coach/src/desktop-telegram-controller.js";
import type { LocalCoachLifecycle } from "../../../packages/coach/src/local-runner.js";

const telegramTransport = vi.hoisted(() => ({
  construct: undefined as ((token: string) => unknown) | undefined,
}));

vi.mock("grammy", () => ({
  Bot: function FakeBot(token: string) {
    if (telegramTransport.construct === undefined) {
      throw new Error("Telegram transport fixture is not installed");
    }
    return telegramTransport.construct(token);
  },
  InputFile: class FakeInputFile {},
}));

vi.mock("../../../packages/core/node_modules/grammy/out/mod.js", () => ({
  Bot: function FakeBot(token: string) {
    if (telegramTransport.construct === undefined) {
      throw new Error("Telegram transport fixture is not installed");
    }
    return telegramTransport.construct(token);
  },
  InputFile: class FakeInputFile {},
}));

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: () => (previous: ApiCall, method: string, payload: ApiPayload, signal?: AbortSignal) =>
    previous(method, payload, signal),
}));

vi.mock("../../../packages/core/node_modules/@grammyjs/auto-retry/out/mod.js", () => ({
  autoRetry: () => (previous: ApiCall, method: string, payload: ApiPayload, signal?: AbortSignal) =>
    previous(method, payload, signal),
}));

const DAEMON_TOKEN = "d".repeat(43);
const TELEGRAM_TOKEN_A = "synthetic-telegram-token-a";
const TELEGRAM_TOKEN_B = "synthetic-telegram-token-b";
const INVALID_TELEGRAM_TOKEN = "synthetic-invalid-token";
const BOT = { id: 424_242, username: "synthetic_coach_bot" } as const;
const PRIMARY_SENDER = 73_001;
const STRANGER_SENDER = 73_002;
const UPGRADE_DRAIN_TIMEOUT_MS = 30_000;
const PAIRING_NOW = Date.UTC(1998, 6, 19, 8);

type Middleware = (context: FakeContext, next: () => Promise<void>) => unknown;
type ApiPayload = Readonly<Record<string, unknown>>;
type ApiCall = (method: string, payload: ApiPayload, signal?: AbortSignal) => Promise<unknown>;
type ApiTransformer = (
  previous: ApiCall,
  method: string,
  payload: ApiPayload,
  signal?: AbortSignal,
) => Promise<unknown>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface FakeContext {
  readonly update?: { readonly update_id?: number };
  readonly chat?: { readonly id: number; readonly type?: string };
  readonly from?: { readonly id: number; readonly first_name?: string };
  readonly message?: { readonly text?: string; readonly message_id?: number };
  readonly callbackQuery?: { readonly data?: string };
  readonly match?: string;
  reply(text: string, options?: Record<string, unknown>): Promise<unknown>;
  replyWithChatAction(action: string): Promise<unknown>;
  replyWithDocument?(file: unknown, options?: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery?(): Promise<unknown>;
  editMessageReplyMarkup?(): Promise<unknown>;
}

interface ApiGate {
  readonly entered: Deferred<void>;
  readonly released: Deferred<void>;
  readonly rejection?: unknown;
}

class ComposingFakeBot {
  readonly middleware: Middleware[] = [];
  readonly transformers: ApiTransformer[] = [];
  readonly commands = new Map<string, (context: FakeContext) => Promise<void>>();
  readonly events = new Map<string, (context: FakeContext) => Promise<void>>();
  readonly rawApiCalls: Array<{ readonly method: string; readonly payload: ApiPayload }> = [];
  readonly startSettled = deferred<void>();
  readonly apiGates = new Map<string, ApiGate[]>();
  readonly gates = new Set<ApiGate>();
  readonly api: {
    readonly config: { use(transformer: ApiTransformer): void };
    readonly setMyCommands: (commands: unknown) => Promise<unknown>;
    readonly sendMessage: (
      chatId: string | number,
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    readonly sendChatAction: (chatId: string | number, action: string) => Promise<unknown>;
  };
  startCalls = 0;
  stopCalls = 0;
  readonly stopEntered = deferred<void>();
  private errorHandler:
    | ((error: { readonly error: unknown; readonly ctx: FakeContext }) => Promise<void>)
    | undefined;
  private stopTask: Promise<void> | undefined;
  private finalPollGate: ApiGate | undefined;

  constructor(readonly token: string) {
    this.api = {
      config: { use: (transformer) => this.transformers.push(transformer) },
      setMyCommands: (commands) => this.callApi("setMyCommands", { commands }),
      sendMessage: (chatId, text, options) =>
        this.callApi("sendMessage", {
          chat_id: chatId,
          text,
          ...options,
        }),
      sendChatAction: (chatId, action) =>
        this.callApi("sendChatAction", { chat_id: chatId, action }),
    };
  }

  use(handler: Middleware): void {
    this.middleware.push(handler);
  }

  command(name: string, handler: (context: FakeContext) => Promise<void>): void {
    this.commands.set(name, handler);
  }

  on(name: string, handler: (context: FakeContext) => Promise<void>): void {
    this.events.set(name, handler);
  }

  catch(
    handler: (error: { readonly error: unknown; readonly ctx: FakeContext }) => Promise<void>,
  ): void {
    this.errorHandler = handler;
  }

  async start(options?: { readonly onStart?: () => void }): Promise<void> {
    this.startCalls += 1;
    options?.onStart?.();
    await this.callApi("deleteWebhook", {});
    await this.callApi("getUpdates", { phase: "poll" });
    await this.startSettled.promise;
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopEntered.resolve(undefined);
    this.stopTask ??= (async () => {
      await this.callApi("getUpdates", { phase: "final-offset" });
      this.startSettled.resolve(undefined);
    })();
    return this.stopTask;
  }

  holdFinalPoll(): ApiGate {
    const gate = { entered: deferred<void>(), released: deferred<void>() };
    this.gates.add(gate);
    this.finalPollGate = gate;
    return gate;
  }

  holdNextApi(method: string, rejection?: unknown): ApiGate {
    const gate = { entered: deferred<void>(), released: deferred<void>(), rejection };
    this.gates.add(gate);
    const queued = this.apiGates.get(method) ?? [];
    queued.push(gate);
    this.apiGates.set(method, queued);
    return gate;
  }

  poll(phase: string): Promise<unknown> {
    return this.callApi("getUpdates", { phase });
  }

  releasePendingGates(): void {
    for (const gate of this.gates) gate.released.resolve(undefined);
  }

  async dispatch(context: FakeContext): Promise<void> {
    const command = /^\/([^\s]+)/.exec(context.message?.text ?? "")?.[1];
    const terminal =
      command !== undefined && this.commands.has(command)
        ? () => this.commands.get(command)!(context)
        : typeof context.message?.text === "string" && this.events.has("message:text")
          ? () => this.events.get("message:text")!(context)
          : async () => undefined;
    const composed = this.middleware.reduceRight<() => Promise<void>>(
      (next, handler) => async () => {
        await handler(context, next);
      },
      terminal,
    );
    try {
      await composed();
    } catch (error) {
      if (this.errorHandler === undefined) throw error;
      await this.errorHandler({ error, ctx: context });
    }
  }

  private callApi(method: string, payload: ApiPayload, signal?: AbortSignal): Promise<unknown> {
    const composed = this.transformers.reduce<ApiCall>(
      (previous, transformer) => (nextMethod, nextPayload, nextSignal) =>
        transformer(previous, nextMethod, nextPayload, nextSignal),
      (nextMethod, nextPayload) => this.rawApi(nextMethod, nextPayload),
    );
    return composed(method, payload, signal);
  }

  private async rawApi(method: string, payload: ApiPayload): Promise<unknown> {
    this.rawApiCalls.push({ method, payload });
    const gate =
      method === "getUpdates" && payload.phase === "final-offset"
        ? this.finalPollGate
        : this.apiGates.get(method)?.shift();
    if (gate !== undefined) {
      gate.entered.resolve(undefined);
      await gate.released.promise;
      if (gate.rejection !== undefined) throw gate.rejection;
    }
    return { ok: true, result: method === "getUpdates" ? [] : true };
  }
}

class FakeTelegramNetwork {
  readonly bots: ComposingFakeBot[] = [];

  createBot(token: string): ComposingFakeBot {
    const bot = new ComposingFakeBot(token);
    this.bots.push(bot);
    return bot;
  }

  bot(token: string, ordinal = 0): ComposingFakeBot {
    const matches = this.bots.filter((bot) => bot.token === token);
    const bot = matches[ordinal];
    if (bot === undefined) throw new Error(`Missing fake Bot generation ${ordinal}`);
    return bot;
  }
}

class ManualTimer {
  private current = 0;
  private readonly scheduled = new Set<{
    readonly deadline: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.current;
  }

  schedule(delayMs: number, callback: () => void): { cancel(): void } {
    const entry = { deadline: this.current + delayMs, callback, cancelled: false };
    this.scheduled.add(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this.scheduled.delete(entry);
      },
    };
  }

  advance(ms: number): void {
    this.current += ms;
    const scheduledAtAdvance = Array.from(this.scheduled);
    for (const entry of scheduledAtAdvance) {
      if (entry.cancelled || entry.deadline > this.current) continue;
      this.scheduled.delete(entry);
      entry.callback();
    }
  }
}

interface FrameQueue {
  next(): Promise<string>;
}

function frameQueue(socket: WebSocket): FrameQueue {
  const frames: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") throw new TypeError("Expected a text RPC frame");
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(event.data);
    else waiter(event.data);
  });
  return {
    next() {
      const frame = frames.shift();
      return frame === undefined
        ? new Promise<string>((resolve) => waiters.push(resolve))
        : Promise.resolve(frame);
    },
  };
}

interface RawRpcSession {
  readonly socket: WebSocket;
  readonly frames: FrameQueue;
}

interface ReleaseChainFixture {
  readonly root: string;
  readonly athleteHome: string;
  readonly network: FakeTelegramNetwork;
  readonly timer: ManualTimer;
  readonly healthState: DaemonHealthState;
  readonly invocations: InvocationCoordinator;
  readonly telegram: DesktopTelegramController;
  readonly rpc: CoachRpcServer;
  readonly vault: TelegramCredentialVault;
  readonly coordinator: TelegramControlCoordinator;
  readonly inspections: string[];
  readonly recoveries: string[];
  readonly server: Server;
  readonly url: string;
  coordinatorFor(supervision: "app-supervised" | "attached"): TelegramControlCoordinator;
  openRawRpc(): Promise<RawRpcSession>;
  close(): Promise<void>;
}

const fixtures: ReleaseChainFixture[] = [];

function encryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      return Buffer.concat([
        Buffer.from("SAFE:"),
        Buffer.from(value, "utf8").reverse(),
        Buffer.from(":END"),
      ]);
    },
    decryptString(value: Buffer) {
      if (
        !value.subarray(0, 5).equals(Buffer.from("SAFE:")) ||
        !value.subarray(-4).equals(Buffer.from(":END"))
      ) {
        throw new TypeError("Invalid synthetic ciphertext");
      }
      return Buffer.from(value.subarray(5, -4)).reverse().toString("utf8");
    },
  };
}

async function createFixture(): Promise<ReleaseChainFixture> {
  vi.resetModules();
  const network = new FakeTelegramNetwork();
  telegramTransport.construct = (token) => network.createBot(token);
  const [{ createTelegramBot }, { createAuthMiddleware }, { loadAllowedSendersFromFile }] =
    await Promise.all([
      import("../../../packages/core/src/channels/telegram.js"),
      import("../../../packages/core/src/channels/telegram-access.js"),
      import("../../../packages/core/src/channels/allowed-senders.js"),
    ]);
  const [
    { createTelegramCredentialVault },
    { createTelegramControlCoordinator },
    { createTelegramDaemonBinding },
    { createDesktopTelegramController },
    { createDesktopTelegramRuntimeFactory },
    { createCoachRpcServer },
    { createDaemonHealthState },
    { createInvocationCoordinator },
  ] = await Promise.all([
    import("../src/main/telegram-credential-vault.js"),
    import("../src/main/telegram-control.js"),
    import("../src/main/telegram-daemon-binding.js"),
    import("../../../packages/coach/src/desktop-telegram-controller.js"),
    import("../../../packages/coach/src/desktop-telegram-runtime.js"),
    import("../../../packages/coach/src/daemon/rpc-server.js"),
    import("../../../packages/coach/src/daemon/healthz-server.js"),
    import("../../../packages/coach/src/daemon/invocation-coordinator.js"),
  ]);

  const root = await mkdtemp(join(await realpath(tmpdir()), "desktop-telegram-chain-"));
  const athleteHome = await realpath(root);
  const storeDir = join(athleteHome, "store");
  const archiveDir = join(athleteHome, "archive");
  const configDir = join(athleteHome, "config");
  await Promise.all([
    mkdir(storeDir, { mode: 0o700 }),
    mkdir(archiveDir, { mode: 0o700 }),
    mkdir(configDir, { mode: 0o700 }),
  ]);
  const vault = createTelegramCredentialVault({
    root: join(athleteHome, "telegram-channel-v1"),
    athleteHome,
    encryption: encryption(),
  });
  const inspections: string[] = [];
  const inspect = async (token: string) => {
    inspections.push(token);
    if (token === TELEGRAM_TOKEN_A || token === TELEGRAM_TOKEN_B) {
      return { status: "ready" as const, bot: BOT };
    }
    return { status: "invalid-token" as const };
  };
  const engine = {
    chat: async () => ({ text: "synthetic reply" }),
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
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => ({}) as never,
  } satisfies CoachEngine;
  const operations = {
    "plan_creation.start": async () => ({
      status: "rejected" as const,
      reason: "command-conflict" as const,
    }),
    "plan_creation.answer": async () => ({
      status: "rejected" as const,
      reason: "no-unfinished-creation" as const,
      planCreation: null,
    }),
    sync: async () => ({
      schemaVersion: 1 as const,
      published: false,
      referenceSucceeded: true,
      requests: { store: 0, reference: 0, total: 0 },
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    }),
  } as unknown as CoachOperations & PlanCreationOperations & PlanChangeOperations;
  const confirmations = {
    peek: () => undefined,
    confirm: async () => ({ status: "none" as const }),
    cancel: () => "none" as const,
  };
  const invocations = createInvocationCoordinator();
  const lifecycle = {
    home: { root: athleteHome, storeDir, archiveDir, configDir },
    engine,
    operations,
    confirmations,
  } as Pick<LocalCoachLifecycle, "home" | "engine" | "operations" | "confirmations">;
  const createRuntime = createDesktopTelegramRuntimeFactory(
    {
      lifecycle,
      invocations,
      appVersion: "2098.1.1",
    },
    {
      createBot: createTelegramBot,
      createAccessMiddleware: createAuthMiddleware,
      loadAllowedSenders: loadAllowedSendersFromFile,
    },
  );
  const timer = new ManualTimer();
  const telegram = createDesktopTelegramController(
    { dataDir: athleteHome, createRuntime },
    {
      inspectTelegramCredential: inspect,
      deleteTelegramWebhook: inspect,
      now: () => PAIRING_NOW + timer.nowMs(),
      pairingRandomBytes: (size) => new Uint8Array(size).fill(0xa5),
    },
  );
  const healthState = createDaemonHealthState();
  const recoveries: string[] = [];
  const beforeInvocationDrain = async (): Promise<void> => {
    await telegram.stopPolling();
    await telegram.drainPending();
  };
  const rpc = createCoachRpcServer({
    engine,
    operations,
    spend: {
      getSpendSummary: async () => ({}) as never,
      setDailySpendCap: async () => ({}) as never,
    },
    selfTestOperations: { selfTest: async () => ({}) as never },
    telegram,
    token: DAEMON_TOKEN,
    owner: "app-supervised",
    athleteHome,
    healthState,
    timer,
    invocations,
    beforeInvocationDrain,
    afterInvocationDrainRefusal: async () => {
      recoveries.push("resume");
      await telegram.resumePolling();
    },
  });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", rpc.handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const url: `ws://127.0.0.1:${number}/rpc` = `ws://127.0.0.1:${port}/rpc`;
  const rawSockets = new Set<WebSocket>();
  const coordinatorFor = (
    supervision: "app-supervised" | "attached",
  ): TelegramControlCoordinator => {
    const binding = createTelegramDaemonBinding(
      { url, token: DAEMON_TOKEN, athleteHome, generation: 1, supervision },
      athleteHome,
    );
    return createTelegramControlCoordinator({
      selectedAthleteHome: () => athleteHome,
      vault,
      daemon: { current: () => binding },
      pairingLease: {
        now: () => PAIRING_NOW + timer.nowMs(),
        schedule: (callback, delayMs) => timer.schedule(delayMs, callback),
        cancel: (handle) => (handle as { cancel(): void }).cancel(),
      },
    });
  };
  const coordinator = coordinatorFor("app-supervised");

  let closed = false;
  const fixture: ReleaseChainFixture = {
    root,
    athleteHome,
    network,
    timer,
    healthState,
    invocations,
    telegram,
    rpc,
    vault,
    coordinator,
    inspections,
    recoveries,
    server,
    url,
    coordinatorFor,
    async openRawRpc() {
      const socket = new WebSocket(url);
      rawSockets.add(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("RPC socket failed")), {
          once: true,
        });
      });
      return { socket, frames: frameQueue(socket) };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const bot of network.bots) bot.releasePendingGates();
      await rpc.close().catch(() => undefined);
      await telegram.close().catch(() => undefined);
      for (const socket of rawSockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function storedToken(fixture: ReleaseChainFixture): Promise<string | undefined> {
  let token: string | undefined;
  await fixture.vault.applyStoredProfile(fixture.athleteHome, async (profile) => {
    token = profile.token;
  });
  return token;
}

async function startPairingA(fixture: ReleaseChainFixture): Promise<{
  readonly bot: ComposingFakeBot;
  readonly code: string;
}> {
  await expect(fixture.coordinator.configure(TELEGRAM_TOKEN_A)).resolves.toMatchObject({
    outcome: "applied",
  });
  const pairing = await fixture.coordinator.beginPairing();
  expect(pairing).toMatchObject({
    outcome: "applied",
    current: { pairing: { state: "awaiting-code" } },
  });
  if (pairing.outcome !== "applied" || pairing.current.pairing.state !== "awaiting-code") {
    throw new Error("Pairing did not start");
  }
  await waitUntil(() => fixture.network.bots.length >= 1, "generation A Bot construction");
  const bot = fixture.network.bot(TELEGRAM_TOKEN_A);
  await waitUntil(
    () =>
      bot.rawApiCalls.some((call) => call.method === "getUpdates" && call.payload.phase === "poll"),
    "generation A polling",
  );
  return { bot, code: pairing.current.pairing.code };
}

function messageContext(input: {
  readonly bot: ComposingFakeBot;
  readonly updateId: number;
  readonly senderId: number;
  readonly text: string;
  readonly reply?: FakeContext["reply"];
}): FakeContext {
  return {
    update: { update_id: input.updateId },
    chat: { id: input.senderId, type: "private" },
    from: { id: input.senderId, first_name: "Synthetic Athlete" },
    message: { text: input.text, message_id: input.updateId },
    reply:
      input.reply ?? ((text, options) => input.bot.api.sendMessage(input.senderId, text, options)),
    replyWithChatAction: (action) => input.bot.api.sendChatAction(input.senderId, action),
  };
}

async function pairAOnline(
  fixture: ReleaseChainFixture,
  started: { readonly bot: ComposingFakeBot; readonly code: string },
): Promise<ComposingFakeBot> {
  await started.bot.dispatch(
    messageContext({
      bot: started.bot,
      updateId: 1,
      senderId: PRIMARY_SENDER,
      text: started.code,
    }),
  );
  await waitUntil(
    () =>
      fixture.telegram.getStatus().pairing.state === "paired" &&
      fixture.telegram.getStatus().channel.state === "online",
    "generation A paired online status",
  );
  await expect(fixture.vault.desiredState()).resolves.toEqual({
    state: "configured",
    enabled: true,
  });
  expect(fixture.network.bots.filter((bot) => bot.token === TELEGRAM_TOKEN_A)).toHaveLength(1);
  return started.bot;
}

async function beginUpgrade(fixture: ReleaseChainFixture): Promise<{
  readonly session: RawRpcSession;
  readonly response: Promise<string>;
}> {
  const session = await fixture.openRawRpc();
  session.socket.send(JSON.stringify(createClientHandshakeFrame(DAEMON_TOKEN)));
  await session.frames.next();
  const handoffCapability = Buffer.alloc(32, 7).toString("base64url");
  session.socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "reserve",
      method: "daemon.reserveUpgrade",
      params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
    }),
  );
  expect(JSON.parse(await session.frames.next())).toEqual({
    jsonrpc: "2.0",
    id: "reserve",
    result: { status: "reserved" },
  });
  session.socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "shutdown",
      method: "daemon.shutdownForUpgrade",
      params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
    }),
  );
  return { session, response: session.frames.next() };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM desktop-telegram-release-chain\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
}

const hasLoopback = await loopbackAvailable();

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
  vi.restoreAllMocks();
  telegramTransport.construct = undefined;
});

describe.skipIf(!hasLoopback)("Desktop Telegram release chain", () => {
  it("keeps paired identity durably off across polling and coordinator reconstruction", async () => {
    const fixture = await createFixture();
    const started = await startPairingA(fixture);
    const active = await pairAOnline(fixture, started);
    const profileBefore = await fixture.vault.profileStatus();
    const accessBefore = await fixture.coordinator.listAllowedSenders();
    const inspectionsBefore = [...fixture.inspections];

    await expect(fixture.coordinator.disable()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: BOT.username },
        pairing: { state: "paired" },
      },
    });
    expect(active.stopCalls).toBe(1);
    expect(active.rawApiCalls).toContainEqual({
      method: "getUpdates",
      payload: { phase: "final-offset" },
    });
    await expect(fixture.telegram.drainPending()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    await expect(fixture.vault.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: false,
    });

    const callsAfterDisable = [...active.rawApiCalls];
    await active.dispatch(
      messageContext({
        bot: active,
        updateId: 2,
        senderId: PRIMARY_SENDER,
        text: "/version",
      }),
    );

    for (let pass = 0; pass < 3; pass += 1) {
      await expect(fixture.coordinator.status()).resolves.toMatchObject({
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "paired" },
      });
      await expect(fixture.coordinator.reconcile()).resolves.toMatchObject({
        outcome: "applied",
        current: {
          channel: { desiredState: "disabled", state: "disabled" },
          pairing: { state: "paired" },
        },
      });
    }

    const reconstructed = fixture.coordinatorFor("app-supervised");
    await expect(reconstructed.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    await expect(reconstructed.reconcile()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "paired" },
      },
    });

    expect(active.rawApiCalls).toEqual(callsAfterDisable);
    expect(fixture.network.bots.map(({ token }) => token)).toEqual([TELEGRAM_TOKEN_A]);
    expect(fixture.network.bots[0]).toBe(active);
    expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
    await expect(fixture.vault.profileStatus()).resolves.toEqual(profileBefore);
    await expect(reconstructed.listAllowedSenders()).resolves.toEqual(accessBefore);
    await expect(fixture.vault.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: false,
    });
    expect(fixture.inspections).toEqual(inspectionsBefore);

    await expect(reconstructed.enable()).resolves.toMatchObject({ outcome: "applied" });
    await waitUntil(
      () =>
        fixture.network.bots.length === 2 &&
        fixture.telegram.getStatus().channel.state === "online",
      "re-enabled paired generation",
    );
    const resumed = fixture.network.bot(TELEGRAM_TOKEN_A, 1);
    await expect(reconstructed.status()).resolves.toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: BOT.username },
      pairing: { state: "paired" },
    });
    expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
    await expect(fixture.vault.profileStatus()).resolves.toEqual(profileBefore);
    await expect(reconstructed.listAllowedSenders()).resolves.toEqual(accessBefore);
    expect(fixture.inspections).toEqual(inspectionsBefore);

    await resumed.dispatch(
      messageContext({
        bot: resumed,
        updateId: 3,
        senderId: PRIMARY_SENDER,
        text: "/version",
      }),
    );
    expect(resumed.rawApiCalls).toContainEqual({
      method: "sendMessage",
      payload: expect.objectContaining({
        chat_id: PRIMARY_SENDER,
        text: "Cycling Coach Desktop v2098.1.1",
      }),
    });
  }, 30_000);

  it("refuses invalid token B while coherent token A stays stored and online", async () => {
    const fixture = await createFixture();
    const started = await startPairingA(fixture);
    const active = await pairAOnline(fixture, started);

    const replacement = await fixture.coordinator.replace(INVALID_TELEGRAM_TOKEN);

    expect(replacement).toMatchObject({
      outcome: "refused",
      reason: "invalid-token",
      current: { channel: { state: "online" } },
    });
    expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
    expect(fixture.telegram.getStatus().channel.state).toBe("online");
    expect(fixture.network.bots.map((bot) => bot.token)).toEqual([TELEGRAM_TOKEN_A]);
    expect(active).toBe(started.bot);
    expect(started.bot.stopCalls).toBe(0);
    expect(active.stopCalls).toBe(0);
  }, 30_000);

  it("publishes and starts valid token B only after A's denied challenge, API, and poll acknowledgement settle", async () => {
    const fixture = await createFixture();
    const { bot } = await startPairingA(fixture);
    const challengeEntered = deferred<void>();
    const challengeReleased = deferred<void>();
    const challengeApi = bot.holdNextApi("sendMessage");
    const finalPoll = bot.holdFinalPoll();
    const deniedChallenge = bot.dispatch(
      messageContext({
        bot,
        updateId: 2,
        senderId: STRANGER_SENDER,
        text: "not-the-pairing-code",
        reply: async (text, options) => {
          challengeEntered.resolve(undefined);
          await challengeReleased.promise;
          return bot.api.sendMessage(STRANGER_SENDER, text, options);
        },
      }),
    );
    let replacement: ReturnType<typeof fixture.coordinator.replace> | undefined;
    try {
      await challengeEntered.promise;

      let replacementSettled = false;
      replacement = fixture.coordinator.replace(TELEGRAM_TOKEN_B).then((result) => {
        replacementSettled = true;
        return result;
      });
      await finalPoll.entered.promise;

      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
      expect(fixture.network.bots.map((entry) => entry.token)).toEqual([TELEGRAM_TOKEN_A]);
      expect(replacementSettled).toBe(false);

      finalPoll.released.resolve(undefined);
      await turn();
      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
      expect(fixture.network.bots.map((entry) => entry.token)).toEqual([TELEGRAM_TOKEN_A]);
      expect(replacementSettled).toBe(false);

      challengeReleased.resolve(undefined);
      await challengeApi.entered.promise;
      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
      expect(fixture.network.bots.map((entry) => entry.token)).toEqual([TELEGRAM_TOKEN_A]);
      expect(replacementSettled).toBe(false);

      challengeApi.released.resolve(undefined);
      await deniedChallenge;
      await expect(replacement).resolves.toMatchObject({ outcome: "applied" });
      await waitUntil(
        () => fixture.network.bots.some((entry) => entry.token === TELEGRAM_TOKEN_B),
        "generation B Bot construction",
      );
      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_B);
      expect(fixture.network.bots.map((entry) => entry.token)).toEqual([
        TELEGRAM_TOKEN_A,
        TELEGRAM_TOKEN_B,
      ]);
    } finally {
      finalPoll.released.resolve(undefined);
      challengeReleased.resolve(undefined);
      challengeApi.released.resolve(undefined);
      await Promise.allSettled([
        deniedChallenge,
        ...(replacement === undefined ? [] : [replacement]),
      ]);
    }
  }, 30_000);

  it("isolates timeout recovery from pending old-generation work and candidate token B", async () => {
    const fixture = await createFixture();
    const started = await startPairingA(fixture);
    const active = await pairAOnline(fixture, started);
    const latePoll = active.holdNextApi("getUpdates", new Error("old generation polling failure"));
    const latePollResult = active.poll("old-generation-late").then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await latePoll.entered.promise;
    const oldSend = active.holdNextApi("sendMessage");
    let oldSendSettled = false;
    const oldSendTask = active.api
      .sendMessage(PRIMARY_SENDER, "old generation send")
      .finally(() => {
        oldSendSettled = true;
      });
    await oldSend.entered.promise;
    const finalPoll = active.holdFinalPoll();
    const upgrade = await beginUpgrade(fixture);
    let replacement: ReturnType<typeof fixture.coordinator.replace> | undefined;
    try {
      await finalPoll.entered.promise;
      await waitUntil(() => !fixture.healthState.healthy, "upgrade admission closure");

      fixture.timer.advance(UPGRADE_DRAIN_TIMEOUT_MS);
      expect(JSON.parse(await upgrade.response)).toMatchObject({
        id: "shutdown",
        error: { code: -32_004, message: "upgrade-drain-timeout" },
      });
      expect(fixture.timer.nowMs()).toBe(UPGRADE_DRAIN_TIMEOUT_MS);
      expect(fixture.healthState.healthy).toBe(true);

      finalPoll.released.resolve(undefined);
      await waitUntil(() => fixture.recoveries.length === 1, "same-owner refusal recovery");
      await waitUntil(() => fixture.network.bots.length === 2, "fresh token A recovery generation");
      await waitUntil(
        () => fixture.telegram.getStatus().channel.state === "online",
        "fresh recovery online status",
      );
      const recoveredStatus = fixture.telegram.getStatus();
      const recovered = fixture.network.bots.at(1);
      if (recovered === undefined) throw new Error("Missing recovered Telegram generation");
      expect(fixture.network.bots.map((bot) => bot.token)).toEqual([
        TELEGRAM_TOKEN_A,
        TELEGRAM_TOKEN_A,
      ]);
      expect(recovered.stopCalls).toBe(0);
      expect(oldSendSettled).toBe(false);

      latePoll.released.resolve(undefined);
      expect(await latePollResult).toMatchObject({ status: "rejected" });
      expect(fixture.telegram.getStatus()).toEqual(recoveredStatus);

      let replacementSettled = false;
      replacement = fixture.coordinator.replace(TELEGRAM_TOKEN_B).then((result) => {
        replacementSettled = true;
        return result;
      });
      await recovered.stopEntered.promise;
      expect(recovered.stopCalls).toBe(1);
      await turn();
      expect(replacementSettled).toBe(false);
      expect(oldSendSettled).toBe(false);
      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
      expect(fixture.network.bots.map((bot) => bot.token)).toEqual([
        TELEGRAM_TOKEN_A,
        TELEGRAM_TOKEN_A,
      ]);

      oldSend.released.resolve(undefined);
      await oldSendTask;
      expect(oldSendSettled).toBe(true);
      await expect(replacement).resolves.toMatchObject({ outcome: "applied" });
      await waitUntil(
        () => fixture.network.bots.some((bot) => bot.token === TELEGRAM_TOKEN_B),
        "candidate B generation after old work release",
      );
    } finally {
      finalPoll.released.resolve(undefined);
      latePoll.released.resolve(undefined);
      oldSend.released.resolve(undefined);
      await Promise.allSettled([
        latePollResult,
        oldSendTask,
        ...(replacement === undefined ? [] : [replacement]),
      ]);
    }
  }, 30_000);

  it("keeps app-supervised sleep and wake transient without changing identity or access", async () => {
    const fixture = await createFixture();
    const started = await startPairingA(fixture);
    await pairAOnline(fixture, started);
    const accessBeforePower = await fixture.coordinator.addAllowedSender({
      senderId: STRANGER_SENDER,
    });
    expect(accessBeforePower).toMatchObject({
      outcome: "applied",
      current: {
        senders: [
          { senderId: PRIMARY_SENDER, role: "primary" },
          { senderId: STRANGER_SENDER, role: "additional" },
        ],
      },
    });
    const profileBeforePower = await fixture.vault.profileStatus();
    const statusBeforePower = await fixture.coordinator.status();
    expect(statusBeforePower).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: BOT.username },
      pairing: { state: "paired" },
    });
    const inspectionsBeforePower = fixture.inspections.length;
    const monitor = new EventEmitter() as EventEmitter & TelegramPowerMonitorPort;
    const { createDesktopTelegramPowerLifecycle } = await import("../src/main/telegram-power.js");
    const power = createDesktopTelegramPowerLifecycle({
      root: join(fixture.root, "power-state"),
      athleteHome: fixture.athleteHome,
      powerMonitor: monitor,
      controller: fixture.coordinator,
      now: () => Date.UTC(1998, 6, 19, 8),
    });
    await power.start();

    monitor.emit("suspend");
    await power.warning();
    expect(fixture.telegram.getStatus().channel.state).toBe("suspended");
    expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
    await expect(fixture.vault.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: true,
    });

    monitor.emit("resume");
    await power.warning();
    await waitUntil(
      () => fixture.telegram.getStatus().channel.state === "online",
      "app-supervised wake polling recovery",
    );
    expect(fixture.network.bots.map((bot) => bot.token)).toEqual([
      TELEGRAM_TOKEN_A,
      TELEGRAM_TOKEN_A,
    ]);
    expect(fixture.inspections).toHaveLength(inspectionsBeforePower);
    expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
    expect(await fixture.vault.profileStatus()).toEqual(profileBeforePower);
    await expect(fixture.vault.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: true,
    });
    expect(accessBeforePower.outcome).toBe("applied");
    if (accessBeforePower.outcome !== "applied") throw new TypeError();
    await expect(fixture.coordinator.listAllowedSenders()).resolves.toEqual(
      accessBeforePower.current,
    );
    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      bot: statusBeforePower.bot,
      pairing: statusBeforePower.pairing,
    });
    const resumedBot = fixture.network.bot(TELEGRAM_TOKEN_A, 1);
    await resumedBot.dispatch(
      messageContext({
        bot: resumedBot,
        updateId: 3,
        senderId: STRANGER_SENDER,
        text: "/version",
      }),
    );
    expect(resumedBot.rawApiCalls).toContainEqual({
      method: "sendMessage",
      payload: expect.objectContaining({
        chat_id: STRANGER_SENDER,
        text: "Cycling Coach Desktop v2098.1.1",
      }),
    });
    await power.close();
  }, 30_000);

  it.each([
    ["enabled", true],
    ["disabled", false],
  ] as const)(
    "keeps attached-owner power transient while Desktop intent is %s",
    async (_label, desktopEnabled) => {
      const fixture = await createFixture();
      const started = await startPairingA(fixture);
      await pairAOnline(fixture, started);
      const accessBefore = await fixture.coordinator.addAllowedSender({
        senderId: STRANGER_SENDER,
      });
      expect(accessBefore.outcome).toBe("applied");
      if (accessBefore.outcome !== "applied") throw new TypeError();
      if (!desktopEnabled) {
        await expect(fixture.vault.setDesiredState(false)).resolves.toEqual({
          status: "stored",
          enabled: false,
        });
      }
      const desiredBefore = await fixture.vault.desiredState();
      const profileBefore = await fixture.vault.profileStatus();
      const inspectionsBefore = [...fixture.inspections];
      const applySpy = vi.spyOn(fixture.vault, "applyStoredProfile");
      const replaceSpy = vi.spyOn(fixture.vault, "replaceProfile");
      const deleteSpy = vi.spyOn(fixture.vault, "deleteProfile");
      const desiredWriteSpy = vi.spyOn(fixture.vault, "setDesiredState");
      const monitor = new EventEmitter() as EventEmitter & TelegramPowerMonitorPort;
      const { createDesktopTelegramPowerLifecycle } = await import("../src/main/telegram-power.js");
      const power = createDesktopTelegramPowerLifecycle({
        root: join(fixture.root, "attached-power-state"),
        athleteHome: fixture.athleteHome,
        powerMonitor: monitor,
        controller: fixture.coordinatorFor("attached"),
        now: () => PAIRING_NOW,
      });
      await power.start();

      monitor.emit("suspend");
      await power.warning();
      expect(fixture.telegram.getStatus()).toMatchObject({
        channel: { desiredState: "enabled", state: "suspended" },
        bot: { state: "ready", username: BOT.username },
        pairing: { state: "paired" },
      });
      expect(started.bot.stopCalls).toBe(1);
      expect(fixture.network.bots.map(({ token }) => token)).toEqual([TELEGRAM_TOKEN_A]);
      await expect(fixture.vault.desiredState()).resolves.toEqual(desiredBefore);
      await expect(fixture.coordinator.listAllowedSenders()).resolves.toEqual(accessBefore.current);

      monitor.emit("resume");
      await power.warning();
      await waitUntil(
        () => fixture.telegram.getStatus().channel.state === "online",
        "attached wake polling recovery",
      );
      expect(fixture.telegram.getStatus()).toMatchObject({
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: BOT.username },
        pairing: { state: "paired" },
      });
      expect(fixture.network.bots.map(({ token }) => token)).toEqual([
        TELEGRAM_TOKEN_A,
        TELEGRAM_TOKEN_A,
      ]);
      await expect(fixture.vault.profileStatus()).resolves.toEqual(profileBefore);
      await expect(fixture.vault.desiredState()).resolves.toEqual(desiredBefore);
      await expect(fixture.coordinator.listAllowedSenders()).resolves.toEqual(accessBefore.current);
      expect(applySpy).not.toHaveBeenCalled();
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(desiredWriteSpy).not.toHaveBeenCalled();
      expect(fixture.inspections).toEqual(inspectionsBefore);

      const resumed = fixture.network.bot(TELEGRAM_TOKEN_A, 1);
      await resumed.dispatch(
        messageContext({
          bot: resumed,
          updateId: 3,
          senderId: STRANGER_SENDER,
          text: "/version",
        }),
      );
      expect(resumed.rawApiCalls).toContainEqual({
        method: "sendMessage",
        payload: expect.objectContaining({ chat_id: STRANGER_SENDER }),
      });
      applySpy.mockRestore();
      expect(await storedToken(fixture)).toBe(TELEGRAM_TOKEN_A);
      await power.close();
    },
    30_000,
  );

  it("lets later process quiesce seal admission before timeout and defeat pending refusal recovery", async () => {
    const fixture = await createFixture();
    const started = await startPairingA(fixture);
    const active = await pairAOnline(fixture, started);
    const finalPoll = active.holdFinalPoll();
    const upgrade = await beginUpgrade(fixture);
    await finalPoll.entered.promise;
    await waitUntil(() => !fixture.healthState.healthy, "upgrade admission closure");

    const closing = fixture.rpc.close();
    await turn();
    fixture.timer.advance(UPGRADE_DRAIN_TIMEOUT_MS);
    expect(JSON.parse(await upgrade.response)).toMatchObject({
      id: "shutdown",
      error: { code: -32_004, message: "upgrade-drain-timeout" },
    });
    expect(fixture.healthState.healthy).toBe(false);
    expect(fixture.recoveries).toEqual([]);
    expect(fixture.network.bots.map((bot) => bot.token)).toEqual([TELEGRAM_TOKEN_A]);

    finalPoll.released.resolve(undefined);
    await closing;
    expect(fixture.healthState.healthy).toBe(false);
    expect(fixture.recoveries).toEqual([]);
    expect(fixture.network.bots.map((bot) => bot.token)).toEqual([TELEGRAM_TOKEN_A]);
  }, 30_000);
});
