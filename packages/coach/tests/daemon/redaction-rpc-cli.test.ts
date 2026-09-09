import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CoachRpcRemoteError, connectCoachClient } from "@enduragent/coach-client";
import { connectCoachVerbTransport } from "@enduragent/coach-cli";
import {
  ClientHandshakeFrameSchema,
  EXIT_AGENT_ERROR,
  JsonRpcErrorResponseEnvelopeSchema,
  type AthleteState,
  type CoachEngine,
  type JsonRpcErrorResponseEnvelope,
  type TelegramControlSnapshot,
} from "@enduragent/coach-contract";
import { resolveAthleteHome } from "@enduragent/kernel-node/home";
import { runEnduragent } from "../../src/enduragent.js";
import {
  createCoachRpcServer,
  ensureDaemonToken,
  type CoachRpcServer,
} from "../../src/daemon/rpc-server.js";
import type { DesktopTelegramController } from "../../src/desktop-telegram-controller.js";
import { planCreationOperationStubs } from "../helpers/plan-creation-operation-stubs.js";

const AUTH_TOKEN = "F8_AUTH_TOKEN_MUST_NOT_BE_LOGGED12345678901";
const API_KEY_SECRET = "F8_API_KEY_MUST_NOT_ESCAPE";
const MESSAGE_SECRET = "F8_MESSAGE_MUST_NOT_ESCAPE";
const STACK_SECRET = "F8_STACK_MUST_NOT_ESCAPE";
const URL_SECRET = "F8_URL_MUST_NOT_ESCAPE";
const PROVIDER_SECRET = "F8_PROVIDER_MUST_NOT_ESCAPE";
const ARBITRARY_SECRET = "F8_ARBITRARY_TEXT_MUST_NOT_ESCAPE";
const NON_ERROR_SECRET = "F8_NON_ERROR_TEXT_MUST_NOT_ESCAPE";
const NESTED_SECRET = "F8_NESTED_AUTH_MUST_NOT_ESCAPE";
const HOSTILE_SECRET = "F8_HOSTILE_PROXY_MUST_NOT_ESCAPE";
const roots: string[] = [];
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function fabricatedError(): Error {
  const error = Object.assign(new Error(`synthetic failure ${MESSAGE_SECRET}`), {
    apiKey: API_KEY_SECRET,
    statusCode: 503,
    nested: { authorization: `Bearer ${NESTED_SECRET}` },
    url: `https://example.invalid/${URL_SECRET}`,
    provider: PROVIDER_SECRET,
    diagnosticNote: ARBITRARY_SECRET,
  });
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: `Error: synthetic failure ${STACK_SECRET}`,
  });
  return error;
}

function hostileError(): Error {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(HOSTILE_SECRET);
      },
    },
  );
  return Object.assign(new Error("synthetic hostile failure"), { statusCode: hostile });
}

function engine(readFailure: () => unknown): CoachEngine {
  return {
    chat: async () => {
      throw readFailure();
    },
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => {
      throw readFailure();
    },
    skipCoachDecision: async () => {
      throw readFailure();
    },
    resumeCoachDecision: async () => {
      throw readFailure();
    },
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM redaction-rpc-cli\n");
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
}

async function startRpc(coachEngine: CoachEngine): Promise<RunningRpc> {
  const rpc = createCoachRpcServer({
    engine: coachEngine,
    telegram: disabledTelegram,
    selfTestOperations: {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
    operations: {
      ...planCreationOperationStubs,
      importFiles: async ({ paths }) => ({
        schemaVersion: 2,
        files: { total: paths.length, imported: paths.length, quarantined: 0 },
        changes: {
          rawFilesInserted: 0,
          sourceRecordsInserted: 0,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
      }),
      sync: async () => ({
        schemaVersion: 1,
        published: false,
        referenceSucceeded: true,
        requests: { store: 0, reference: 0, total: 0 },
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
        llm: {
          provider: "anthropic",
          model: "synthetic-model",
          credential_configured: false,
        },
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
    },
    spend: {
      getSpendSummary: () => Promise.reject(new Error("Spend handler is not used.")),
      setDailySpendCap: () => Promise.reject(new Error("Spend handler is not used.")),
    },
    token: AUTH_TOKEN,
    owner: "unmanaged-foreground",
    athleteHome: "/tmp/enduragent-redaction-rpc-test",
  });
  const server = createServer();
  server.on("upgrade", rpc.handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("missing test port");
  return { rpc, server, url: `ws://127.0.0.1:${address.port}/rpc` };
}

async function closeRpc(running: RunningRpc): Promise<void> {
  await running.rpc.close();
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function readTree(path: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(...(await readTree(child)));
    else if (entry.isFile()) values.push(await readFile(child, "utf8"));
  }
  return values;
}

async function expectRefused(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("error", () => resolve(), { once: true });
    socket.addEventListener(
      "open",
      () => {
        socket.close();
        reject(new Error("closed RPC port accepted a connection"));
      },
      { once: true },
    );
  });
}

function expectSafeError(envelope: JsonRpcErrorResponseEnvelope): void {
  expect(envelope.error.code).toBe(-32603);
  expect(envelope.error.message).toBe("Internal error");
  expect(envelope.error.data).toEqual({
    name: "Error",
    statusCode: 503,
    apiKey: "[redacted]",
    nested: { authorization: "[redacted]" },
    diagnosticNote: "[redacted]",
  });
}

describe.skipIf(!hasLoopback)("redaction over real RPC and CLI", () => {
  it("delivers only redacted diagnostics and never persists the daemon token", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "redaction-rpc-cli-"));
    roots.push(root);
    const home = resolveAthleteHome({ ENDURAGENT_HOME: root });
    await mkdir(home.configDir, { recursive: true, mode: 0o700 });
    await writeFile(join(home.configDir, "daemon.token"), `${AUTH_TOKEN}\n`, { mode: 0o600 });
    const tokenMetadata = await lstat(join(home.configDir, "daemon.token"));
    expect(tokenMetadata.isFile()).toBe(true);
    expect(tokenMetadata.isSymbolicLink()).toBe(false);
    expect(tokenMetadata.mode & 0o777).toBe(0o600);
    const token = await ensureDaemonToken(home.configDir);
    expect(token.value).toBe(AUTH_TOKEN);

    let failure: unknown = fabricatedError();
    const running = await startRpc(engine(() => failure));
    const clientConnections: string[][] = [];
    const serverFrames: string[] = [];
    const cliBytes: string[] = [];
    const webSocketFactory = (url: string): WebSocket => {
      const frames: string[] = [];
      clientConnections.push(frames);
      const socket = new WebSocket(url);
      const send = socket.send;
      Object.defineProperty(socket, "send", {
        configurable: true,
        value: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          frames.push(typeof data === "string" ? data : String(data));
          Reflect.apply(send, socket, [data]);
        },
      });
      socket.addEventListener("message", (event) => {
        serverFrames.push(String(event.data));
      });
      return socket;
    };
    const directClient = await connectCoachClient({
      url: running.url,
      token: token.value,
      webSocketFactory,
    });
    try {
      let observed: JsonRpcErrorResponseEnvelope | undefined;
      let terminalCount = 0;
      let rejected = false;
      const directCall = directClient.call(
        "chat",
        { chatId: "cli:synthetic", message: "synthetic request" },
        {
          onTerminalEnvelope(envelope) {
            expect(rejected).toBe(false);
            terminalCount += 1;
            if ("error" in envelope) observed = envelope;
          },
        },
      );
      await expect(directCall).rejects.toBeInstanceOf(CoachRpcRemoteError);
      rejected = true;
      expect(terminalCount).toBe(1);
      expect(observed).toBeDefined();
      if (observed === undefined) throw new TypeError("missing observed terminal");
      expectSafeError(observed);
      await directClient.close();

      for (const outputMode of ["--stream-json", "--json"] as const) {
        failure = fabricatedError();
        const stdout = capture();
        const stderr = capture();
        const result = await runEnduragent(
          {
            argv: ["ask", "synthetic request", outputMode, "--session", "synthetic"],
            env: { ENDURAGENT_HOME: root },
            terminal: {
              input: process.stdin,
              stdout: stdout.stream,
              stderr: stderr.stream,
              isTTY: false,
            },
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            withLocalCoach: async () => {
              throw new Error("local runner must not be used");
            },
            readPackageVersion: async () => "synthetic",
            connectRemoteTransport: async () =>
              connectCoachVerbTransport({
                url: running.url,
                token: token.value,
                webSocketFactory,
              }),
          },
        );
        expect(result).toBe(EXIT_AGENT_ERROR);
        expect(stderr.read()).toBe("Enduragent could not complete this command.\n");
        if (outputMode === "--stream-json") {
          const lines = stdout.read().trimEnd().split("\n");
          expect(lines).toHaveLength(1);
          const line = lines[0];
          if (line === undefined) throw new TypeError("missing CLI terminal line");
          expectSafeError(JsonRpcErrorResponseEnvelopeSchema.parse(JSON.parse(line)));
        } else {
          expect(stdout.read()).toBe("");
        }
        cliBytes.push(stdout.read(), stderr.read());
      }

      for (const variant of [
        {
          failure: NON_ERROR_SECRET,
          data: { name: "NonError" },
        },
        {
          failure: hostileError(),
          data: { name: "Error", statusCode: "[redacted]" },
        },
      ]) {
        failure = variant.failure;
        const client = await connectCoachClient({
          url: running.url,
          token: token.value,
          webSocketFactory,
        });
        let terminal: JsonRpcErrorResponseEnvelope | undefined;
        let terminalCount = 0;
        try {
          await expect(
            client.call(
              "chat",
              { chatId: "cli:synthetic", message: "synthetic request" },
              {
                onTerminalEnvelope(envelope) {
                  terminalCount += 1;
                  if ("error" in envelope) terminal = envelope;
                },
              },
            ),
          ).rejects.toBeInstanceOf(CoachRpcRemoteError);
          expect(terminalCount).toBe(1);
          expect(terminal?.error.data).toEqual(variant.data);
        } finally {
          await client.close();
        }
      }

      for (const frames of clientConnections) {
        expect(frames.length).toBeGreaterThan(1);
        const firstFrame = frames[0];
        if (firstFrame === undefined) throw new TypeError("missing client handshake frame");
        expect(ClientHandshakeFrameSchema.parse(JSON.parse(firstFrame))).toMatchObject({
          type: "handshake",
        });
      }
      const diagnosticFrames = [
        ...clientConnections.flatMap((frames) => frames.slice(1)),
        ...serverFrames,
      ];
      const logBytes = await readTree(join(home.root, "logs"));
      const diagnosticBytes = [...diagnosticFrames, ...cliBytes, ...logBytes].join("\n");
      for (const secret of [
        AUTH_TOKEN,
        API_KEY_SECRET,
        MESSAGE_SECRET,
        STACK_SECRET,
        URL_SECRET,
        PROVIDER_SECRET,
        ARBITRARY_SECRET,
        NON_ERROR_SECRET,
        NESTED_SECRET,
        HOSTILE_SECRET,
      ]) {
        expect(diagnosticBytes).not.toContain(secret);
      }
    } finally {
      await directClient.close().catch(() => {});
      await closeRpc(running);
    }
    await expectRefused(running.url);
  });
});
