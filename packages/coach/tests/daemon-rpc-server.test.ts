import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  WindowsPrivatePathPolicyError,
  type CreateTelegramChannelInput,
  type TelegramChannelRuntime,
} from "@enduragent/core";
import {
  COACH_RPC_METHOD_REGISTRY,
  PROTOCOL_VERSION,
  ServerHandshakeFrameSchema,
  createClientHandshakeFrame,
  parseCoachRpcEnvelope,
  type AthleteState,
  type CoachDecisionReadModel,
  type CoachEngine,
  type CoachOperations,
  type PlanCreationCardModel,
  type PlanCreationOperations,
  type PlanningReadOperations,
  type PlanningOperations,
  type PlanReadModel,
  type SpendSummary,
  type TelegramControlSnapshot,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  createCoachRpcServer as createCoachRpcServerProduction,
  ensureDaemonToken,
  UPGRADE_DRAIN_TIMEOUT_MS,
  type CoachRpcServerInput,
} from "../src/daemon/rpc-server.js";
import { createDaemonHealthState } from "../src/daemon/healthz-server.js";
import { createInvocationCoordinator } from "../src/daemon/invocation-coordinator.js";
import type { MonotonicTimer, ScheduledMonotonicTimer } from "../src/daemon/upgrade-fence.js";
import type { DesktopTelegramController } from "../src/desktop-telegram-controller.js";
import { createDesktopTelegramRuntimeFactory } from "../src/desktop-telegram-runtime.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";
import { planCreationOperationStubs } from "./helpers/plan-creation-operation-stubs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const planState: PlanReadModel = {
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
};

const unansweredDecision = {
  decisionId: "decision-1",
  chatId: "desktop",
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
  status: "unanswered",
} satisfies CoachDecisionReadModel;

const completedDecision = {
  ...unansweredDecision,
  status: "answered" as const,
  answer: { kind: "option" as const, optionId: "option-1" },
  consequence: "Tomorrow stays easy.",
  continuation: {
    continuationId: "continuation-1",
    status: "completed" as const,
    turnId: "turn-1",
    coachText: "Keep tomorrow easy.",
  },
} satisfies CoachDecisionReadModel;

const operations: CoachOperations & PlanningReadOperations & PlanCreationOperations = {
  ...planCreationOperationStubs,
  exportTrainingFile: async () => ({
    status: "exported",
    byteLength: 4_096,
    suggestedFilename: "synthetic.fit",
    contentType: "application/octet-stream",
  }),
  getActivityAnalysis: async ({ canonicalActivityId }) => ({
    schemaVersion: 1,
    activity: {
      id: canonicalActivityId,
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
    sections: { aerobicDrift: { kind: "unavailable", reason: "unsupported" } },
  }),
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
  deleteArchivedConversation: async () => ({
    schemaVersion: 1,
    status: "deleted",
  }),
  getArchivedTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  getPlanningReadModel: async () => ({
    schemaVersion: 1,
    status: "no-plan",
    asOfDateKey: 20260826,
    plan: null,
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
  getUnitsPreference: async () => ({ value: "metric", source: "default" }),
  setUnitsPreference: async ({ value }) => ({ value, source: "cycling" }),
};

const spendSummary: SpendSummary = {
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
};

const spend = {
  getSpendSummary: async () => spendSummary,
  setDailySpendCap: async () => spendSummary,
};

const TEST_ATHLETE_HOME = "/tmp/enduragent-test-athlete";
const TEST_RENDERER_CAPABILITY_BYTES = Buffer.alloc(32, 9);

function telegramController(
  overrides: Partial<DesktopTelegramController> = {},
): DesktopTelegramController {
  const snapshot: TelegramControlSnapshot = {
    channel: { desiredState: "disabled", state: "disabled" },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
  };
  return {
    getStatus: () => snapshot,
    configure: async () => ({ outcome: "applied", current: snapshot }),
    enable: async () => snapshot,
    disable: async () => snapshot,
    replace: async () => ({ outcome: "applied", current: snapshot }),
    reconcile: async () => snapshot,
    inspectTelegramCredential: async () => ({ status: "invalid-token" }),
    deleteTelegramWebhook: async () => ({ status: "invalid-token" }),
    forgetTelegramCredential: async () => snapshot,
    resetTelegramAccess: async () => snapshot,
    beginTelegramPairing: async () => snapshot,
    cancelTelegramPairing: async () => snapshot,
    listTelegramAllowedSenders: async () => ({ senders: [] }),
    addTelegramAllowedSender: async () => ({
      outcome: "applied" as const,
      current: { senders: [] },
    }),
    removeTelegramAllowedSender: async () => ({
      outcome: "applied" as const,
      current: { senders: [] },
    }),
    stopPolling: async () => snapshot,
    resumePolling: async () => snapshot,
    drainPending: async () => snapshot,
    close: async () => snapshot,
    ...overrides,
  };
}

function createCoachRpcServer(
  input: Omit<
    CoachRpcServerInput,
    "operations" | "spend" | "selfTestOperations" | "telegram" | "athleteHome"
  > &
    Partial<
      Pick<
        CoachRpcServerInput,
        "operations" | "spend" | "selfTestOperations" | "telegram" | "athleteHome"
      >
    >,
) {
  return createCoachRpcServerProduction({
    ...input,
    athleteHome: input.athleteHome ?? TEST_ATHLETE_HOME,
    rendererCapabilityRandomBytes:
      input.rendererCapabilityRandomBytes ?? (() => TEST_RENDERER_CAPABILITY_BYTES),
    operations: input.operations ?? operations,
    spend: input.spend ?? spend,
    telegram: input.telegram ?? telegramController(),
    selfTestOperations: input.selfTestOperations ?? {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
  });
}

function engine(overrides: Partial<CoachEngine> = {}): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => ({ decision: completedDecision }),
    skipCoachDecision: async () => ({
      decision: { ...unansweredDecision, status: "skipped" },
    }),
    resumeCoachDecision: async () => ({ decision: completedDecision, resumed: true }),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
    ...overrides,
  };
}

class CaptureSocket extends Duplex {
  readonly writes: Buffer[] = [];

  _read(): void {}

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

function request(url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return { url, headers } as IncomingMessage;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeTimer implements MonotonicTimer {
  private now = 0;
  private readonly callbacks = new Set<{
    readonly deadline: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.now;
  }

  schedule(delayMs: number, callback: () => void): ScheduledMonotonicTimer {
    const scheduled = { deadline: this.now + delayMs, callback, cancelled: false };
    this.callbacks.add(scheduled);
    return {
      cancel: () => {
        scheduled.cancelled = true;
        this.callbacks.delete(scheduled);
      },
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (const scheduled of this.callbacks) {
      if (!scheduled.cancelled && scheduled.deadline <= this.now) {
        this.callbacks.delete(scheduled);
        scheduled.callback();
      }
    }
  }
}

describe("daemon token", () => {
  it("creates and reuses one exact 0600 base64url token", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-"));
    roots.push(root);
    const bytes = Buffer.alloc(32, 7);
    const created = await ensureDaemonToken(root, { randomBytes: () => bytes });
    expect(created.path).toBe(join(root, "daemon.token"));
    expect(created.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(created.path, "utf8")).toBe(`${created.value}\n`);
    expect((await lstat(created.path)).mode & 0o777).toBe(0o600);
    await expect(ensureDaemonToken(root)).resolves.toEqual(created);
  });

  it("fails closed for symlinks, invalid content, and over-permissive modes", async () => {
    for (const fixture of ["symlink", "invalid", "mode"] as const) {
      const root = await mkdtemp(join(await realpath(tmpdir()), `daemon-token-${fixture}-`));
      roots.push(root);
      const path = join(root, "daemon.token");
      if (fixture === "symlink") {
        const target = join(root, "target");
        await writeFile(target, `${"x".repeat(43)}\n`, { mode: 0o600 });
        await symlink(target, path);
      } else {
        await writeFile(path, fixture === "invalid" ? "not-a-token\n" : `${"x".repeat(43)}\n`, {
          mode: 0o600,
        });
        if (fixture === "mode") await chmod(path, 0o644);
      }
      await expect(ensureDaemonToken(root)).rejects.toThrow("daemon token file is invalid");
      if (fixture === "mode") expect((await lstat(path)).mode & 0o777).toBe(0o644);
    }
  });

  it("creates and reuses a token through injected Windows semantics", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-"));
    roots.push(root);
    const bytes = Buffer.alloc(32, 9);

    const created = await ensureDaemonToken(root, {
      platform: "win32",
      randomBytes: () => bytes,
    });

    await expect(ensureDaemonToken(root, { platform: "win32" })).resolves.toEqual(created);
    expect(await readFile(created.path, "utf8")).toBe(`${created.value}\n`);
  });

  it.runIf(process.platform !== "win32")(
    "does not inspect or repair POSIX token modes under injected Windows semantics",
    async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-mode-"));
      roots.push(root);
      const path = join(root, "daemon.token");
      await writeFile(path, `${"x".repeat(43)}\n`, { mode: 0o644 });
      await chmod(path, 0o644);

      await expect(ensureDaemonToken(root, { platform: "win32" })).resolves.toEqual({
        path,
        value: "x".repeat(43),
      });
      expect((await lstat(path)).mode & 0o777).toBe(0o644);
    },
  );

  it("rejects oversized Windows token state as path-free corruption", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-corrupt-"));
    roots.push(root);
    const path = join(root, "daemon.token");
    const corrupt = `${"x".repeat(44)}\n`;
    await writeFile(path, corrupt, { mode: 0o600 });

    const failure = await ensureDaemonToken(root, { platform: "win32" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("does not swallow a Windows sharing violation during token creation", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-locked-"));
    roots.push(root);
    const path = join(root, "daemon.token");

    const failure = await ensureDaemonToken(root, {
      platform: "win32",
      openFile: async () => {
        throw Object.assign(new Error(`locked ${path}`), { code: "EACCES", path });
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "content-write", category: "sharing-violation" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
  });

  it("rejects a sharing-locked Windows token on restart", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-read-lock-"));
    roots.push(root);
    const path = join(root, "daemon.token");
    const persisted = `${"x".repeat(43)}\n`;
    await writeFile(path, persisted, { mode: 0o600 });

    const failure = await ensureDaemonToken(root, {
      platform: "win32",
      openFile: async () => {
        throw Object.assign(new Error(`locked ${path}`), { code: "EACCES", path });
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "sharing-violation" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(await readFile(path, "utf8")).toBe(persisted);
  });

  it("keeps a missing Windows config binding path-free and stage-coded", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-windows-missing-"));
    roots.push(root);
    const configDir = join(root, "missing-config");

    const failure = await ensureDaemonToken(configDir, { platform: "win32" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "binding-check", category: "io-failure" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(configDir);
    expect(JSON.stringify(failure)).not.toContain(configDir);
  });
});

describe("RPC upgrade refusal", () => {
  it.each([
    [
      "Origin wins over bad path and query",
      "/bad?token=x",
      { origin: "" },
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "bad relative target",
      "http://example.test/rpc",
      {},
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "path wins over query",
      "/bad?token=x",
      {},
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "empty query is rejected",
      "/rpc?",
      {},
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
  ])("writes exact bytes once: %s", async (_name, url, headers, expected) => {
    const rpc = createCoachRpcServer({
      engine: engine(),
      token: "x".repeat(43),
      owner: "unmanaged-foreground",
    });
    const socket = new CaptureSocket();
    rpc.handleUpgrade(request(url, headers), socket, Buffer.alloc(0));
    await turn();
    expect(Buffer.concat(socket.writes).toString("ascii")).toBe(expected);
    expect(socket.writes).toHaveLength(1);
    expect(socket.destroyed).toBe(true);
    await rpc.close();
  });
});

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM daemon-rpc-server\n");
        resolve(false);
        return;
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
}

const hasLoopback = await loopbackAvailable();

interface FrameQueue {
  next(): Promise<string>;
}

function frameQueue(ws: WebSocket): FrameQueue {
  const frames: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  ws.on("message", (data) => {
    const frame = data.toString();
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
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

async function openSocket(
  rpc: ReturnType<typeof createCoachRpcServer>,
): Promise<{ readonly ws: WebSocket; readonly frames: FrameQueue; close(): Promise<void> }> {
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    frames: frameQueue(ws),
    async close() {
      await rpc.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe.skipIf(!hasLoopback)("authenticated RPC projection", () => {
  it("keeps initial refresh scheduling in the strict privileged control namespace", async () => {
    const token = "x".repeat(43);
    const scheduleInitialRefresh = vi.fn();
    const rpc = createCoachRpcServer({
      token,
      owner: "app-supervised",
      engine: engine(),
      scheduleInitialRefresh,
    });
    const privileged = await openSocket(rpc);
    privileged.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await privileged.frames.next();

    privileged.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "initial-refresh",
        method: "daemon.startInitialRefresh",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await privileged.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "initial-refresh",
      result: { status: "accepted" },
    });
    expect(scheduleInitialRefresh).toHaveBeenCalledOnce();

    for (const params of [undefined, [], { extra: true }]) {
      privileged.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `invalid-${JSON.stringify(params)}`,
          method: "daemon.startInitialRefresh",
          ...(params === undefined ? {} : { params }),
        }),
      );
      expect(parseCoachRpcEnvelope(await privileged.frames.next())).toMatchObject({
        error: { code: params === undefined ? -32600 : -32602 },
      });
    }
    expect(scheduleInitialRefresh).toHaveBeenCalledOnce();

    scheduleInitialRefresh.mockImplementationOnce(() => {
      throw new Error("synthetic scheduling failure");
    });
    privileged.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "scheduling-failed",
        method: "daemon.startInitialRefresh",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await privileged.frames.next())).toMatchObject({
      id: "scheduling-failed",
      error: { code: -32603, message: "Internal error" },
    });
    expect(scheduleInitialRefresh).toHaveBeenCalledTimes(2);

    const renderer = await openSocket(rpc);
    renderer.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await renderer.frames.next();
    renderer.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "renderer-initial-refresh",
        method: "daemon.startInitialRefresh",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await renderer.frames.next())).toMatchObject({
      id: "renderer-initial-refresh",
      error: { code: -32601, message: "Method not found" },
    });
    expect(scheduleInitialRefresh).toHaveBeenCalledTimes(2);

    await renderer.close();
    await privileged.close();
  });

  it("accepts the first-frame token and projects engine plus activity-analysis methods", async () => {
    const token = "x".repeat(43);
    const calls: string[] = [];
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({
        chat: async (chatRequest, onEvent) => {
          calls.push(`chat:${chatRequest.chatId}`);
          onEvent?.({ type: "turn-start", turnId: "turn-1", chatId: chatRequest.chatId });
          onEvent?.({ type: "final-text", turnId: "turn-1", text: "done" });
          return { text: "done" };
        },
        resetSession: async ({ chatId }) => {
          calls.push(`resetSession:${chatId}`);
          return { memoryFlushed: true };
        },
        hasSession: async ({ chatId }) => {
          calls.push(`hasSession:${chatId}`);
          return { hasSession: true };
        },
        getCoachDecision: async ({ chatId }) => {
          calls.push(`getCoachDecision:${chatId}`);
          return { decision: null };
        },
        answerCoachDecision: async ({ chatId }) => {
          calls.push(`answerCoachDecision:${chatId}`);
          return { decision: { ...completedDecision, chatId } };
        },
        skipCoachDecision: async ({ chatId }) => {
          calls.push(`skipCoachDecision:${chatId}`);
          return { decision: { ...unansweredDecision, chatId, status: "skipped" } };
        },
        resumeCoachDecision: async ({ chatId }) => {
          calls.push(`resumeCoachDecision:${chatId}`);
          return { decision: { ...completedDecision, chatId }, resumed: true };
        },
        enqueueChatMessage: async ({ chatId }) => {
          calls.push(`enqueueChatMessage:${chatId}`);
          return { schemaVersion: 1, revision: 1, items: [] };
        },
        getChatQueue: async ({ chatId }) => {
          calls.push(`getChatQueue:${chatId}`);
          return { schemaVersion: 1, revision: 1, items: [] };
        },
        removeQueuedChatMessage: async ({ chatId }) => {
          calls.push(`removeQueuedChatMessage:${chatId}`);
          return { schemaVersion: 1, revision: 2, items: [] };
        },
        resumeChatQueue: async ({ chatId }) => {
          calls.push(`resumeChatQueue:${chatId}`);
          return { snapshot: { schemaVersion: 1, revision: 2, items: [] } };
        },
        runQueuedCommand: async ({ chatId }) => {
          calls.push(`runQueuedCommand:${chatId}`);
          return { snapshot: { schemaVersion: 1, revision: 2, items: [] } };
        },
        retryQueuedTurn: async ({ chatId }) => {
          calls.push(`retryQueuedTurn:${chatId}`);
          return { snapshot: { schemaVersion: 1, revision: 2, items: [] } };
        },
        getAthleteState: async () => {
          calls.push("getAthleteState");
          return state;
        },
      }),
      operations: {
        ...operations,
        getPlanningReadModel: async () => {
          calls.push("getPlanningReadModel");
          return { schemaVersion: 1, status: "no-plan", asOfDateKey: 20260826, plan: null };
        },
        exportTrainingFile: async (request, signal) => {
          calls.push("exportTrainingFile");
          return operations.exportTrainingFile!(request, signal);
        },
        getActivityAnalysis: async (request) => {
          calls.push("getActivityAnalysis");
          return operations.getActivityAnalysis!(request);
        },
      },
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()))).toEqual({
      type: "handshake",
      status: "accepted",
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION,
      owner: "unmanaged-foreground",
      athleteHome: TEST_ATHLETE_HOME,
      rendererCapability: TEST_RENDERER_CAPABILITY_BYTES.toString("base64url"),
    });

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "chat-1",
        method: "chat",
        params: { chatId: "chat", message: "hello" },
      }),
    );
    const firstEvent = parseCoachRpcEnvelope(await client.frames.next());
    const secondEvent = parseCoachRpcEnvelope(await client.frames.next());
    const chatTerminal = parseCoachRpcEnvelope(await client.frames.next());
    expect(firstEvent).toMatchObject({
      method: "coach.turnEvent",
      params: { requestId: "chat-1", requestMethod: "chat", turnId: "turn-1" },
    });
    expect(secondEvent).toMatchObject({
      method: "coach.turnEvent",
      params: { event: { type: "final-text", text: "done" } },
    });
    expect(chatTerminal).toEqual({ jsonrpc: "2.0", id: "chat-1", result: { text: "done" } });

    const requests = [
      { id: 2, method: "resetSession", params: { chatId: "chat" } },
      { id: 3, method: "hasSession", params: { chatId: "chat" } },
      { id: 31, method: "getCoachDecision", params: { chatId: "chat" } },
      {
        id: 32,
        method: "answerCoachDecision",
        params: {
          chatId: "chat",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "option-1" },
        },
      },
      {
        id: 33,
        method: "skipCoachDecision",
        params: { chatId: "chat", decisionId: "decision-1" },
      },
      {
        id: 34,
        method: "resumeCoachDecision",
        params: { chatId: "chat", decisionId: "decision-1" },
      },
      {
        id: 35,
        method: "enqueueChatMessage",
        params: { chatId: "chat", submissionId: "submission-1", text: "Hello" },
      },
      { id: 36, method: "getChatQueue", params: { chatId: "chat" } },
      {
        id: 37,
        method: "removeQueuedChatMessage",
        params: { chatId: "chat", queuedMessageId: "queued-1" },
      },
      { id: 38, method: "resumeChatQueue", params: { chatId: "chat" } },
      {
        id: 39,
        method: "runQueuedCommand",
        params: { chatId: "chat", queuedMessageId: "queued-1" },
      },
      { id: 40, method: "retryQueuedTurn", params: { chatId: "chat", claimId: "claim-1" } },
      { id: 4, method: "getAthleteState", params: {} },
      { id: 41, method: "getPlanningReadModel", params: {} },
      {
        id: 5,
        method: "getActivityAnalysis",
        params: { canonicalActivityId: "a".repeat(64), sections: ["aerobic-drift"] },
      },
      {
        id: 6,
        method: "exportTrainingFile",
        params: {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          format: "fit",
          destinationPath: "/tmp/synthetic-export.fit",
        },
      },
    ];
    for (const value of requests) {
      client.ws.send(JSON.stringify({ jsonrpc: "2.0", ...value }));
      const response = parseCoachRpcEnvelope(await client.frames.next());
      expect(response).toMatchObject({ jsonrpc: "2.0", id: value.id });
    }
    expect(calls).toEqual([
      "chat:chat",
      "resetSession:chat",
      "hasSession:chat",
      "getCoachDecision:chat",
      "answerCoachDecision:chat",
      "skipCoachDecision:chat",
      "resumeCoachDecision:chat",
      "enqueueChatMessage:chat",
      "getChatQueue:chat",
      "removeQueuedChatMessage:chat",
      "resumeChatQueue:chat",
      "runQueuedCommand:chat",
      "retryQueuedTurn:chat",
      "getAthleteState",
      "getPlanningReadModel",
      "getActivityAnalysis",
      "exportTrainingFile",
    ]);
    await client.close();
  });

  it("forwards decision continuation events with their exact request method", async () => {
    const token = "x".repeat(43);
    const emit = (chatId: string, onEvent?: (event: TurnEvent) => void): void => {
      onEvent?.({ type: "turn-start", turnId: "turn-1", chatId });
      onEvent?.({ type: "final-text", turnId: "turn-1", text: "Keep tomorrow easy." });
    };
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({
        answerCoachDecision: async ({ chatId }, onEvent) => {
          emit(chatId, onEvent);
          return { decision: { ...completedDecision, chatId } };
        },
        resumeCoachDecision: async ({ chatId }, onEvent) => {
          emit(chatId, onEvent);
          return { decision: { ...completedDecision, chatId }, resumed: true };
        },
      }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    for (const [id, method] of [
      ["answer", "answerCoachDecision"],
      ["resume", "resumeCoachDecision"],
    ] as const) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params:
            method === "answerCoachDecision"
              ? {
                  chatId: "desktop",
                  decisionId: "decision-1",
                  answer: { kind: "option", optionId: "option-1" },
                }
              : { chatId: "desktop", decisionId: "decision-1" },
        }),
      );
      const start = parseCoachRpcEnvelope(await client.frames.next());
      const final = parseCoachRpcEnvelope(await client.frames.next());
      const terminal = parseCoachRpcEnvelope(await client.frames.next());
      expect(start).toMatchObject({
        method: "coach.turnEvent",
        params: { requestId: id, requestMethod: method, event: { type: "turn-start" } },
      });
      expect(final).toMatchObject({
        method: "coach.turnEvent",
        params: { requestId: id, requestMethod: method, event: { type: "final-text" } },
      });
      expect(terminal).toMatchObject({ jsonrpc: "2.0", id, result: { decision: {} } });
    }
    await client.close();
  });

  it("does not let a same-session reset overtake a running chat", async () => {
    const token = "x".repeat(43);
    const chatResult = deferred<{ text: string }>();
    const chat = vi.fn(() => chatResult.promise);
    const resetSession = vi.fn(async () => ({ memoryFlushed: true }));
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({ chat, resetSession }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "chat",
        method: "chat",
        params: { chatId: "desktop", message: "hold" },
      }),
    );
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reset",
        method: "resetSession",
        params: { chatId: "desktop" },
      }),
    );
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(resetSession).not.toHaveBeenCalled();

    chatResult.resolve({ text: "done" });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({ id: "chat" });
    await vi.waitFor(() => expect(resetSession).toHaveBeenCalledOnce());
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({ id: "reset" });

    await client.close();
  });

  it("lets scoped Stop reach the engine while the same chat request is running", async () => {
    const token = "x".repeat(43);
    const chatResult = deferred<{ text: string }>();
    const chat = vi.fn(() => chatResult.promise);
    const stopChat = vi.fn(async () => ({ stopped: true }));
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({ chat, stopChat }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "chat",
        method: "chat",
        params: { chatId: "desktop", message: "hold" },
      }),
    );
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "stop",
        method: "stopChat",
        params: { chatId: "desktop", turnId: "turn-1" },
      }),
    );

    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "stop",
      result: { stopped: true },
    });
    expect(stopChat).toHaveBeenCalledWith({ chatId: "desktop", turnId: "turn-1" });

    chatResult.resolve({ text: "partial" });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "chat",
      result: { text: "partial" },
    });
    await client.close();
  });

  it("lets scoped Stop reach an active decision continuation", async () => {
    const token = "x".repeat(43);
    const answerResult = deferred<{ decision: CoachDecisionReadModel }>();
    const answerCoachDecision = vi.fn(() => answerResult.promise);
    const stopChat = vi.fn(async () => ({ stopped: true }));
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({ answerCoachDecision, stopChat }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "answer",
        method: "answerCoachDecision",
        params: {
          chatId: "desktop",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "option-1" },
        },
      }),
    );
    await vi.waitFor(() => expect(answerCoachDecision).toHaveBeenCalledOnce());
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "stop-decision",
        method: "stopChat",
        params: { chatId: "desktop", turnId: "turn-2" },
      }),
    );

    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "stop-decision",
      result: { stopped: true },
    });
    expect(stopChat).toHaveBeenCalledWith({ chatId: "desktop", turnId: "turn-2" });

    answerResult.resolve({ decision: completedDecision });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "answer",
      result: { decision: completedDecision },
    });
    await client.close();
  });

  it("dispatches authenticated setup, intake, and runtime operations without value echo", async () => {
    const token = "x".repeat(43);
    const saveIntake = vi.fn(async () => ({ schemaVersion: 1 as const, saved: true as const }));
    const getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: {
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: false,
        clinician_cleared: true,
        injury_status: "returning" as const,
      },
      durableTrainingData: true,
    }));
    const configureRuntime = vi.fn(async ({ llm, intervals, session }) => ({
      schemaVersion: 3 as const,
      status: "applied" as const,
      applied: {
        llm: llm !== undefined,
        intervals: intervals !== undefined,
        session: session !== undefined,
      },
    }));
    const runtimeSnapshot = {
      schemaVersion: 3 as const,
      llm: {
        provider: "openrouter" as const,
        model: "model-a",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "athlete-a",
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
    };
    const getRuntimeConfig = vi.fn(async () => runtimeSnapshot);
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: {
        ...operations,
        getSetupStatus,
        saveIntake,
        configureRuntime,
        getRuntimeConfig,
      },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const intake = {
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    } as const;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intake",
        method: "saveIntake",
        params: intake,
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "intake",
      result: { schemaVersion: 1, saved: true },
    });
    expect(saveIntake).toHaveBeenCalledWith(intake);

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "setup-status",
        method: "getSetupStatus",
        params: {},
      }),
    );
    const setupStatusResponse = parseCoachRpcEnvelope(await client.frames.next());
    expect(setupStatusResponse).toEqual({
      jsonrpc: "2.0",
      id: "setup-status",
      result: {
        schemaVersion: 1,
        intake: {
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: true,
          injury_status: "returning",
        },
        durableTrainingData: true,
      },
    });
    expect(JSON.stringify(setupStatusResponse)).not.toContain("placeholder");
    expect(getSetupStatus).toHaveBeenCalledWith({});

    const runtime = {
      llm: { provider: "openrouter", model: "model-a", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    } as const;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime",
        method: "configureRuntime",
        params: runtime,
      }),
    );
    const response = parseCoachRpcEnvelope(await client.frames.next());
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "runtime",
      result: {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: false },
      },
    });
    expect(configureRuntime).toHaveBeenCalledWith(runtime, expect.any(AbortSignal));
    expect(JSON.stringify(response)).not.toContain("placeholder");
    expect(JSON.stringify(response)).not.toContain("athlete-a");
    expect(JSON.stringify(response)).not.toContain("model-a");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime-read",
        method: "getRuntimeConfig",
        params: {},
      }),
    );
    const snapshotResponse = parseCoachRpcEnvelope(await client.frames.next());
    expect(snapshotResponse).toEqual({
      jsonrpc: "2.0",
      id: "runtime-read",
      result: runtimeSnapshot,
    });
    expect(getRuntimeConfig).toHaveBeenCalledWith({});
    expect(JSON.stringify(snapshotResponse)).not.toContain("api_key");
    expect(JSON.stringify(snapshotResponse)).not.toContain("token");
    expect(JSON.stringify(snapshotResponse)).not.toContain("path");
    await client.close();
  });

  it("aborts runtime configuration when its requesting connection detaches", async () => {
    const token = "x".repeat(43);
    const started = deferred<void>();
    let operationSignal: AbortSignal | undefined;
    const configureRuntime = vi.fn(async (_request, signal?: AbortSignal): Promise<never> => {
      operationSignal = signal;
      started.resolve(undefined);
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, configureRuntime },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime-detach",
        method: "configureRuntime",
        params: { llm: { provider: "openai-codex", model: "gpt-5.5" } },
      }),
    );
    await started.promise;

    const closed = new Promise<void>((resolve) => client.ws.once("close", () => resolve()));
    client.ws.close();
    await closed;
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));

    await client.close();
  });

  it("dispatches strict intervals credential preflight results without echoing the candidate", async () => {
    const token = "x".repeat(43);
    let refuse = false;
    const verifyIntervalsCredential = vi.fn(async () =>
      refuse ? { reason: "credential-rejected" as const } : { approval: "a".repeat(64) },
    );
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, verify_intervals_credential: verifyIntervalsCredential },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intervals-preflight",
        method: "verify_intervals_credential",
        params: { api_key: "synthetic-candidate-key" },
      }),
    );
    const approved = parseCoachRpcEnvelope(await client.frames.next());
    expect(approved).toEqual({
      jsonrpc: "2.0",
      id: "intervals-preflight",
      result: { approval: "a".repeat(64) },
    });
    expect(JSON.stringify(approved)).not.toContain("synthetic-candidate-key");
    expect(verifyIntervalsCredential).toHaveBeenLastCalledWith(
      { api_key: "synthetic-candidate-key" },
      expect.any(AbortSignal),
    );

    refuse = true;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intervals-refusal",
        method: "verify_intervals_credential",
        params: { api_key: "synthetic-candidate-key" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "intervals-refusal",
      result: { reason: "credential-rejected" },
    });

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intervals-invalid",
        method: "verify_intervals_credential",
        params: { api_key: "synthetic-candidate-key", athlete_id: "synthetic-athlete" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "intervals-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(verifyIntervalsCredential).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("aborts intervals credential preflight when its requesting connection detaches", async () => {
    const token = "x".repeat(43);
    const started = deferred<void>();
    let operationSignal: AbortSignal | undefined;
    const verifyIntervalsCredential = vi.fn(
      async (_request, signal?: AbortSignal): Promise<never> => {
        operationSignal = signal;
        started.resolve(undefined);
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, verify_intervals_credential: verifyIntervalsCredential },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intervals-preflight-detach",
        method: "verify_intervals_credential",
        params: { api_key: "synthetic-candidate-key" },
      }),
    );
    await started.promise;

    const closed = new Promise<void>((resolve) => client.ws.once("close", () => resolve()));
    client.ws.close();
    await closed;
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));

    await client.close();
  });

  it("aborts activity analysis when its requesting connection detaches", async () => {
    const token = "x".repeat(43);
    const started = deferred<void>();
    let operationSignal: AbortSignal | undefined;
    const getActivityAnalysis = vi.fn(async (_request, signal?: AbortSignal): Promise<never> => {
      operationSignal = signal;
      started.resolve(undefined);
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, getActivityAnalysis },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "activity-analysis-detach",
        method: "getActivityAnalysis",
        params: { canonicalActivityId: "a".repeat(64), sections: ["aerobic-drift"] },
      }),
    );
    await started.promise;

    const closed = new Promise<void>((resolve) => client.ws.once("close", () => resolve()));
    client.ws.close();
    await closed;
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));

    await client.close();
  });

  it("delivers fixed runtime refusals without serializing submitted credentials or account IDs", async () => {
    const token = "x".repeat(43);
    const reasons = [
      "credential-required",
      "ownership-unavailable",
      "training-account-mismatch",
      "managed-by-environment",
    ] as const;
    let call = 0;
    const configureRuntime = vi.fn(async () => ({
      schemaVersion: 3 as const,
      status: "refused" as const,
      reason: reasons[call++]!,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, configureRuntime },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    for (const [index, reason] of reasons.entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `refusal-${index}`,
          method: "configureRuntime",
          params: {
            intervals: {
              api_key: `obviously-fake-private-key-${index}`,
              athlete_id: `private-athlete-${index}`,
            },
          },
        }),
      );
      const response = parseCoachRpcEnvelope(await client.frames.next());
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: `refusal-${index}`,
        result: { schemaVersion: 3, status: "refused", reason },
      });
      expect(JSON.stringify(response)).not.toContain("private");
    }

    expect(configureRuntime).toHaveBeenCalledTimes(reasons.length);
    await client.close();
  });

  it("dispatches strict authenticated units reads and writes through the operations object", async () => {
    const token = "x".repeat(43);
    const getUnitsPreference = vi.fn(async () => ({
      value: "metric" as const,
      source: "athlete" as const,
    }));
    const setUnitsPreference = vi.fn(async ({ value }: { value: "metric" | "imperial" }) => ({
      value,
      source: "cycling" as const,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, getUnitsPreference, setUnitsPreference },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-read",
        method: "getUnitsPreference",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "units-read",
      result: { value: "metric", source: "athlete" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-write",
        method: "setUnitsPreference",
        params: { value: "imperial" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "units-write",
      result: { value: "imperial", source: "cycling" },
    });
    expect(getUnitsPreference).toHaveBeenCalledWith({});
    expect(setUnitsPreference).toHaveBeenCalledWith({ value: "imperial" });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-invalid",
        method: "setUnitsPreference",
        params: { value: "other" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "units-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    await client.close();
  });

  it("dispatches bounded transcript reads and refuses malformed hydration requests", async () => {
    const token = "x".repeat(43);
    const getTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
        },
      ],
      nextCursor: null,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, getTranscriptPage },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "transcript-page",
        method: "getTranscriptPage",
        params: { cursor: null, limit: 25 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "transcript-page",
      result: await getTranscriptPage.mock.results[0]!.value,
    });
    expect(getTranscriptPage).toHaveBeenCalledWith({ cursor: null, limit: 25 });

    for (const [index, params] of [
      {},
      { cursor: null, limit: 0 },
      { cursor: null, limit: 51 },
      { cursor: "a".repeat(152), limit: 25 },
      { cursor: null, limit: 25, chatId: "other" },
    ].entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `transcript-invalid-${index}`,
          method: "getTranscriptPage",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: `transcript-invalid-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("dispatches archived conversation reads and refuses malformed archive requests", async () => {
    const token = "x".repeat(43);
    const boundaryRef = "b".repeat(64);
    const listArchivedConversations = vi.fn(async () => ({
      schemaVersion: 1 as const,
      conversations: [
        {
          boundaryRef,
          boundaryAt: "1998-07-06T00:00:00.000Z",
          reason: "explicit-reset" as const,
          turnCount: 2,
        },
      ],
      truncated: false,
    }));
    const getArchivedTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
        },
      ],
      nextCursor: null,
    }));
    const deleteArchivedConversation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "deleted" as const,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: {
        ...operations,
        listArchivedConversations,
        deleteArchivedConversation,
        getArchivedTranscriptPage,
      },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-list",
        method: "listArchivedConversations",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-list",
      result: await listArchivedConversations.mock.results[0]!.value,
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-page",
        method: "getArchivedTranscriptPage",
        params: { boundaryRef, cursor: null, limit: 25 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-page",
      result: await getArchivedTranscriptPage.mock.results[0]!.value,
    });
    expect(getArchivedTranscriptPage).toHaveBeenCalledWith({
      boundaryRef,
      cursor: null,
      limit: 25,
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-delete",
        method: "deleteArchivedConversation",
        params: { boundaryRef },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-delete",
      result: { schemaVersion: 1, status: "deleted" },
    });
    expect(deleteArchivedConversation).toHaveBeenCalledWith({ boundaryRef });

    const renderer = await openSocket(rpc);
    renderer.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await renderer.frames.next();
    renderer.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "renderer-archive-delete",
        method: "deleteArchivedConversation",
        params: { boundaryRef },
      }),
    );
    expect(parseCoachRpcEnvelope(await renderer.frames.next())).toMatchObject({
      id: "renderer-archive-delete",
      result: { schemaVersion: 1, status: "deleted" },
    });

    for (const [index, params] of [
      {},
      { boundaryRef, cursor: null, limit: 0 },
      { boundaryRef, cursor: null, limit: 51 },
      { boundaryRef: "z".repeat(64), cursor: null, limit: 25 },
      { boundaryRef, cursor: "a".repeat(152), limit: 25 },
      { boundaryRef, cursor: null, limit: 25, chatId: "other" },
    ].entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `archive-invalid-${index}`,
          method: "getArchivedTranscriptPage",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: `archive-invalid-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-list-invalid",
        method: "listArchivedConversations",
        params: { chatId: "other" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-list-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    for (const [index, params] of [
      {},
      { boundaryRef: boundaryRef.toUpperCase() },
      { boundaryRef, chatId: "other" },
    ].entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `archive-delete-invalid-${index}`,
          method: "deleteArchivedConversation",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: `archive-delete-invalid-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(listArchivedConversations).toHaveBeenCalledTimes(1);
    expect(deleteArchivedConversation).toHaveBeenCalledTimes(2);
    expect(getArchivedTranscriptPage).toHaveBeenCalledTimes(1);
    await renderer.close();
    await client.close();
  });

  it("dispatches strict spend reads and cap writes exactly once without notifications", async () => {
    const token = "x".repeat(43);
    const getSpendSummary = vi.fn(async () => spendSummary);
    const setDailySpendCap = vi.fn(async ({ dailyCapUsd }: { dailyCapUsd: number }) => ({
      ...spendSummary,
      dailyCapUsd,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      spend: { getSpendSummary, setDailySpendCap },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "spend-read", method: "getSpendSummary", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "spend-read",
      result: spendSummary,
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-write",
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0.75 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-write",
      result: { dailyCapUsd: 0.75 },
    });
    expect(getSpendSummary).toHaveBeenCalledOnce();
    expect(setDailySpendCap).toHaveBeenCalledWith({ dailyCapUsd: 0.75 });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-invalid",
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    getSpendSummary.mockResolvedValueOnce({
      ...spendSummary,
      knownSpendUsd: 1,
    } as SpendSummary);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-invalid-result",
        method: "getSpendSummary",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-invalid-result",
      error: { code: -32603, message: "Internal error" },
    });
    await client.close();
  });

  it("dispatches selfTest with request-correlated progress before one terminal", async () => {
    const token = "x".repeat(43);
    const selfTest = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ phase: "started", completed: 0, total: 1 });
      onEvent?.({ phase: "completed", completed: 1, total: 1 });
      return {
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      } as const;
    });
    const rpc = createCoachRpcServer({
      engine: engine(),
      selfTestOperations: { selfTest },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "diagnostic", method: "selfTest", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      method: "coach.operationProgress",
      params: {
        requestId: "diagnostic",
        requestMethod: "selfTest",
        event: { phase: "started", completed: 0, total: 1 },
      },
    });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      method: "coach.operationProgress",
      params: {
        requestId: "diagnostic",
        requestMethod: "selfTest",
        event: { phase: "completed", completed: 1, total: 1 },
      },
    });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "diagnostic",
      result: { ok: false, error: { code: "RUNNER_ERROR" } },
    });
    expect(selfTest).toHaveBeenCalledOnce();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-diagnostic",
        method: "selfTest",
        params: { extra: true },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "invalid-diagnostic",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(selfTest).toHaveBeenCalledOnce();
    await client.close();
  });

  it("returns an explicit unsupported Planning result when operations are not installed", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    for (const request of [
      { jsonrpc: "2.0", id: "plan-read", method: "getPlanState", params: {} },
      {
        jsonrpc: "2.0",
        id: "plan-write",
        method: "executePlanTransition",
        params: { transitionId: "PL-T01", commandId: "command-1", sourceConversationId: null },
      },
    ]) {
      client.ws.send(JSON.stringify(request));
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        id: request.id,
        result: { status: "unsupported-capability", capability: "planning" },
      });
    }

    await client.close();
  });

  it("dispatches strict Planning operations and request-correlated progress", async () => {
    const token = "x".repeat(43);
    const getPlanState = vi.fn(async (_request: Record<string, never>) => ({
      status: "ready" as const,
      state: planState,
    }));
    const executePlanTransition = vi.fn(
      async (
        request: Parameters<NonNullable<PlanningOperations["executePlanTransition"]>>[0],
        onEvent?: Parameters<NonNullable<PlanningOperations["executePlanTransition"]>>[1],
      ) => {
        onEvent?.({
          commandId: request.commandId,
          transitionId: request.transitionId,
          operationId: "operation-1",
          phase: "completed",
          completed: 1,
          total: 1,
        });
        return { status: "completed" as const, state: planState };
      },
    );
    const planning: PlanningOperations = { getPlanState, executePlanTransition };
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, ...planning },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "plan-read", method: "getPlanState", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "plan-read",
      result: { status: "ready", state: { scenarioId: "PL-S001" } },
    });

    const command = {
      transitionId: "PL-T01" as const,
      commandId: "command-1",
      sourceConversationId: null,
    };
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "plan-write",
        method: "executePlanTransition",
        params: command,
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      method: "coach.planProgress",
      params: {
        requestId: "plan-write",
        requestMethod: "executePlanTransition",
        event: { transitionId: "PL-T01", phase: "completed" },
      },
    });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "plan-write",
      result: { status: "completed", state: { scenarioId: "PL-S001" } },
    });
    expect(getPlanState).toHaveBeenCalledWith({});
    expect(executePlanTransition).toHaveBeenCalledWith(command, expect.any(Function));

    await client.close();
  });

  it("dispatches strict Chat-to-Plan request delivery operations", async () => {
    const token = "x".repeat(43);
    const createPlanningRequest = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "invalid_request" as const,
    }));
    const createWorkoutPlanningRequest = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "invalid_request" as const,
    }));
    const getPlanningRequest = vi.fn(async () => ({ status: "missing" as const }));
    const retryPlanningRequest = vi.fn(async () => ({ status: "missing" as const }));
    const resumePlanningRequests = vi.fn(async () => ({ deliveries: [] }));
    const listPlanningRequests = vi.fn(async () => ({ deliveries: [], planCreation: null }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: {
        ...operations,
        createPlanningRequest,
        createWorkoutPlanningRequest,
        getPlanningRequest,
        retryPlanningRequest,
        resumePlanningRequests,
        listPlanningRequests,
      },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    const payload = {
      requestId: "request-1",
      kind: "plan_question",
      intent: "Review the current week.",
      source: { chatId: "desktop", messageId: "message-1" },
      sourceSnapshot: {
        capturedAt: "1998-08-24T08:00:00.000Z",
        attachment: null,
        selectedWorkout: null,
      },
    };
    for (const request of [
      { id: "create-request", method: "createPlanningRequest", params: { payload } },
      {
        id: "create-workout-request",
        method: "createWorkoutPlanningRequest",
        params: {
          requestId: "request-workout",
          intent: "Review Tempo 3 × 12.",
          source: {
            chatId: "desktop",
            messageId: "message-workout",
            attachmentId: "attachment-1",
          },
        },
      },
      { id: "get-request", method: "getPlanningRequest", params: { requestId: "request-1" } },
      { id: "retry-request", method: "retryPlanningRequest", params: { requestId: "request-1" } },
      { id: "resume-requests", method: "resumePlanningRequests", params: {} },
      { id: "list-requests", method: "listPlanningRequests", params: { chatId: "desktop" } },
    ]) {
      client.ws.send(JSON.stringify({ jsonrpc: "2.0", ...request }));
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        id: request.id,
        result:
          request.method === "createPlanningRequest" ||
          request.method === "createWorkoutPlanningRequest"
            ? { status: "rejected", reason: "invalid_request" }
            : request.method === "resumePlanningRequests" ||
                request.method === "listPlanningRequests"
              ? { deliveries: [] }
              : { status: "missing" },
      });
    }
    expect(createPlanningRequest).toHaveBeenCalledWith({ payload });
    expect(createWorkoutPlanningRequest).toHaveBeenCalledWith({
      requestId: "request-workout",
      intent: "Review Tempo 3 × 12.",
      source: {
        chatId: "desktop",
        messageId: "message-workout",
        attachmentId: "attachment-1",
      },
    });
    expect(getPlanningRequest).toHaveBeenCalledWith({ requestId: "request-1" });
    expect(retryPlanningRequest).toHaveBeenCalledWith({ requestId: "request-1" });
    expect(resumePlanningRequests).toHaveBeenCalledWith({});
    expect(listPlanningRequests).toHaveBeenCalledWith({ chatId: "desktop" });

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-request",
        method: "resumePlanningRequests",
        params: { extra: true },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "invalid-request",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(resumePlanningRequests).toHaveBeenCalledOnce();
    await client.close();
  });

  it("dispatches strict Plan Creation operations for the renderer", async () => {
    const token = "x".repeat(43);
    const creationId = "01J00000000000000000000000";
    const startedCard: PlanCreationCardModel = {
      creationId,
      version: 1,
      status: "in-progress",
      answeredSummaries: [],
      openQuestion: { kind: "goal-question", prompt: "Goal?", candidates: [] },
    };
    const answeredCard: PlanCreationCardModel = {
      creationId,
      version: 2,
      status: "in-progress",
      answeredSummaries: [{ answerKey: "goal", title: "Goal", detail: "Build power" }],
      openQuestion: {
        kind: "success-question",
        prompt: "Success?",
        input: { kind: "authored", placeholder: "Describe success" },
      },
    };
    const startPlanCreation = vi.fn<PlanCreationOperations["plan_creation.start"]>(async () => ({
      status: "started",
      outcome: "created",
      planCreation: startedCard,
    }));
    const answerPlanCreation = vi.fn<PlanCreationOperations["plan_creation.answer"]>(async () => ({
      status: "answered",
      planCreation: answeredCard,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: {
        ...operations,
        "plan_creation.start": startPlanCreation,
        "plan_creation.answer": answerPlanCreation,
      },
      token,
      owner: "app-supervised",
    });
    const renderer = await openSocket(rpc);
    renderer.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await renderer.frames.next();
    const startParams = { commandId: "start-1" };
    const answerParams = {
      commandId: "answer-1",
      creationId,
      expectedVersion: 1,
      answer: { kind: "goal" as const, goal: { kind: "fitness" as const, outcome: "Build power" } },
    };
    for (const request of [
      { id: "start", method: "plan_creation.start", params: startParams },
      { id: "answer", method: "plan_creation.answer", params: answerParams },
    ]) {
      renderer.ws.send(JSON.stringify({ jsonrpc: "2.0", ...request }));
      expect(parseCoachRpcEnvelope(await renderer.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "plan_creation.start"
            ? { status: "started", outcome: "created", planCreation: startedCard }
            : { status: "answered", planCreation: answeredCard },
      });
    }
    expect(startPlanCreation).toHaveBeenCalledWith(startParams);
    expect(answerPlanCreation).toHaveBeenCalledWith(answerParams);

    for (const request of [
      {
        id: "invalid-start",
        method: "plan_creation.start",
        params: { ...startParams, extra: true },
      },
      {
        id: "invalid-answer",
        method: "plan_creation.answer",
        params: { ...answerParams, extra: true },
      },
    ]) {
      renderer.ws.send(JSON.stringify({ jsonrpc: "2.0", ...request }));
      expect(parseCoachRpcEnvelope(await renderer.frames.next())).toMatchObject({
        id: request.id,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(startPlanCreation).toHaveBeenCalledOnce();
    expect(answerPlanCreation).toHaveBeenCalledOnce();
    await renderer.close();
  });

  it.each([
    {
      name: "command id",
      events: [
        {
          commandId: "command-2",
          transitionId: "PL-T01" as const,
          operationId: "operation-1",
          phase: "completed" as const,
          completed: 1,
          total: 1,
        },
      ],
      acceptedOperationId: null,
      validEvents: 0,
    },
    {
      name: "transition id",
      events: [
        {
          commandId: "command-1",
          transitionId: "PL-T02" as const,
          operationId: "operation-1",
          phase: "completed" as const,
          completed: 1,
          total: 1,
        },
      ],
      acceptedOperationId: null,
      validEvents: 0,
    },
    {
      name: "progress operation id",
      events: [
        {
          commandId: "command-1",
          transitionId: "PL-T01" as const,
          operationId: "operation-1",
          phase: "queued" as const,
          completed: 0,
          total: 1,
        },
        {
          commandId: "command-1",
          transitionId: "PL-T01" as const,
          operationId: "operation-2",
          phase: "completed" as const,
          completed: 1,
          total: 1,
        },
      ],
      acceptedOperationId: null,
      validEvents: 1,
    },
    {
      name: "accepted operation id",
      events: [
        {
          commandId: "command-1",
          transitionId: "PL-T01" as const,
          operationId: "operation-1",
          phase: "completed" as const,
          completed: 1,
          total: 1,
        },
      ],
      acceptedOperationId: "operation-2",
      validEvents: 1,
    },
  ])(
    "rejects Planning $name correlation mismatches",
    async ({ events, acceptedOperationId, validEvents }) => {
      const token = "x".repeat(43);
      const rpc = createCoachRpcServer({
        engine: engine(),
        operations: {
          ...operations,
          executePlanTransition: async (_request, onEvent) => {
            for (const event of events) onEvent?.(event);
            return acceptedOperationId === null
              ? { status: "completed", state: planState }
              : { status: "accepted", operationId: acceptedOperationId, state: planState };
          },
        },
        token,
        owner: "app-supervised",
      });
      const client = await openSocket(rpc);
      client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
      await client.frames.next();
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "plan-write",
          method: "executePlanTransition",
          params: {
            transitionId: "PL-T01",
            commandId: "command-1",
            sourceConversationId: null,
          },
        }),
      );
      for (let index = 0; index < validEvents; index += 1) {
        expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
          method: "coach.planProgress",
        });
      }
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        jsonrpc: "2.0",
        id: "plan-write",
        error: { code: -32603, message: "Internal error" },
      });
      await client.close();
    },
  );

  it("ignores Planning progress emitted after the transition result", async () => {
    const token = "x".repeat(43);
    let emitLate: Parameters<NonNullable<PlanningOperations["executePlanTransition"]>>[1];
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: {
        ...operations,
        getPlanState: async () => ({ status: "ready", state: planState }),
        executePlanTransition: async (_request, onEvent) => {
          emitLate = onEvent;
          return { status: "completed", state: planState };
        },
      },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "plan-write",
        method: "executePlanTransition",
        params: {
          transitionId: "PL-T01",
          commandId: "command-1",
          sourceConversationId: null,
        },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "plan-write",
      result: { status: "completed" },
    });
    emitLate?.({
      commandId: "command-1",
      transitionId: "PL-T01",
      operationId: "operation-1",
      phase: "completed",
      completed: 1,
      total: 1,
    });
    await turn();
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "plan-read", method: "getPlanState", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "plan-read",
      result: { status: "ready" },
    });
    await client.close();
  });

  it("uses authoritative protocol errors, recoverable ids, and method lookup order", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "unmanaged-foreground",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const cases = [
      ["{", { id: null, error: { code: -32700, message: "Parse error" } }],
      [JSON.stringify([]), { id: null, error: { code: -32600, message: "Invalid Request" } }],
      [
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unknown", params: {} }),
        { id: 7, error: { code: -32601, message: "Method not found" } },
      ],
      [
        JSON.stringify({ jsonrpc: "2.0", id: "known", method: "chat", params: {} }),
        { id: "known", error: { code: -32602, message: "Invalid params" } },
      ],
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: "strict-intake",
          method: "saveIntake",
          params: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            prior_bsi: false,
            clinician_cleared: null,
            injury_status: "none",
            extra: true,
          },
        }),
        { id: "strict-intake", error: { code: -32602, message: "Invalid params" } },
      ],
      [
        JSON.stringify({ jsonrpc: "1.0", id: "recoverable", method: "chat", params: {} }),
        { id: "recoverable", error: { code: -32600, message: "Invalid Request" } },
      ],
    ] as const;
    for (const [payload, expected] of cases) {
      client.ws.send(payload);
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject(expected);
    }
    await client.close();
  });

  it("converts a non-JSON registry result into one fixed internal terminal error", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine({
        getAthleteState: async () => ({
          ...state,
          athleteProfile: 1n,
        }),
      }),
      token,
      owner: "unmanaged-foreground",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "non-json-result",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "non-json-result",
      error: {
        code: -32603,
        message: "Internal error",
        data: { name: "Error" },
      },
    });
    await client.close();
  });

  it("returns schema-valid mismatch frames in both directions without dispatch", async () => {
    const token = "x".repeat(43);
    for (const clientProtocolVersion of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
      const chat = vi.fn(async () => ({ text: "unused" }));
      const selfTest = vi.fn();
      const rpc = createCoachRpcServer({
        engine: engine({ chat }),
        selfTestOperations: { selfTest },
        token,
        owner: "unmanaged-foreground",
      });
      const client = await openSocket(rpc);
      client.ws.send(
        JSON.stringify({
          type: "handshake",
          token,
          clientProtocolVersion,
        }),
      );
      const frame = ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()));
      expect(frame).toMatchObject({
        status: "version-mismatch",
        clientProtocolVersion,
        serverProtocolVersion: PROTOCOL_VERSION,
        direction: clientProtocolVersion < PROTOCOL_VERSION ? "client-older" : "client-newer",
      });
      expect(chat).not.toHaveBeenCalled();
      expect(selfTest).not.toHaveBeenCalled();
      await client.close();
    }
  });
});

describe.skipIf(!hasLoopback)("RPC authority boundaries", () => {
  it("admits native paths only for privileged Desktop-main callers and fails closed before storage", async () => {
    const token = "x".repeat(43);
    const admitChatAttachment = vi.fn(async (request) => ({
      selectionId: request.selectionId,
      displayName: "activity.fit",
      status: "storage_failed" as const,
      failureCode: "admission_unavailable" as const,
      retryable: false,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, admitChatAttachment },
      token,
      owner: "app-supervised",
    });
    const privileged = await openSocket(rpc);
    privileged.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await privileged.frames.next();

    const request = {
      chatId: "desktop",
      selectionId: "selection-1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: "/tmp/activity.fit" },
    } as const;
    privileged.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "privileged-admission",
        method: "admitChatAttachment",
        params: request,
      }),
    );
    expect(parseCoachRpcEnvelope(await privileged.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "privileged-admission",
      result: {
        selectionId: "selection-1",
        displayName: "activity.fit",
        status: "storage_failed",
        failureCode: "admission_unavailable",
        retryable: false,
      },
    });
    expect(admitChatAttachment).toHaveBeenCalledWith(request);

    privileged.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "foreign-admission",
        method: "admitChatAttachment",
        params: { ...request, chatId: "other" },
      }),
    );
    expect(parseCoachRpcEnvelope(await privileged.frames.next())).toMatchObject({
      id: "foreign-admission",
      error: { code: -32602, message: "Invalid params" },
    });

    const renderer = await openSocket(rpc);
    renderer.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await renderer.frames.next();
    renderer.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "renderer-admission",
        method: "admitChatAttachment",
        params: request,
      }),
    );
    expect(parseCoachRpcEnvelope(await renderer.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "renderer-admission",
      error: { code: -32601, message: "Method not found" },
    });
    expect(admitChatAttachment).toHaveBeenCalledOnce();

    await renderer.close();
    await privileged.close();
  });

  it("returns a typed unavailable result when durable admission is not installed", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations,
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "unavailable",
        method: "admitChatAttachment",
        params: {
          chatId: "desktop",
          selectionId: "selection-1",
          source: "drop",
          candidate: { kind: "native-path", sourcePath: "C:\\rides\\activity.fit" },
        },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "unavailable",
      result: {
        selectionId: "selection-1",
        displayName: "activity.fit",
        status: "storage_failed",
        failureCode: "admission_unavailable",
        retryable: false,
      },
    });
    await client.close();
  });

  it("binds renderer capabilities to the ordinary Chat and dedicated Plan namespaces", async () => {
    const token = "x".repeat(43);
    const chat = vi.fn(async () => ({ text: "ok" }));
    const resetSession = vi.fn(async () => ({ memoryFlushed: true }));
    const hasSession = vi.fn(async () => ({ hasSession: true }));
    const getCoachDecision = vi.fn(async () => ({ decision: null }));
    const answerCoachDecision = vi.fn(async () => ({ decision: completedDecision }));
    const skipCoachDecision = vi.fn(async () => ({
      decision: { ...unansweredDecision, status: "skipped" as const },
    }));
    const resumeCoachDecision = vi.fn(async () => ({
      decision: completedDecision,
      resumed: true,
    }));
    const getChatQueue = vi.fn(async () => ({ schemaVersion: 1 as const, revision: 0, items: [] }));
    const getActivityAnalysis = vi.fn(operations.getActivityAnalysis!);
    const rpc = createCoachRpcServer({
      engine: engine({
        chat,
        resetSession,
        hasSession,
        getCoachDecision,
        answerCoachDecision,
        skipCoachDecision,
        resumeCoachDecision,
        getChatQueue,
      }),
      operations: { ...operations, getActivityAnalysis },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    const rendererCapability = TEST_RENDERER_CAPABILITY_BYTES.toString("base64url");
    client.ws.send(JSON.stringify(createClientHandshakeFrame(rendererCapability)));
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()))).toMatchObject({
      status: "accepted",
      athleteHome: TEST_ATHLETE_HOME,
      rendererCapability,
    });

    const foreignChatIds = [
      "cli:default",
      "other",
      "telegram:1",
      "",
      " ",
      "desktop\0",
      "../desktop",
    ];
    const scopedMethods = [
      "chat",
      "getCoachDecision",
      "answerCoachDecision",
      "skipCoachDecision",
      "resumeCoachDecision",
      "resetSession",
      "hasSession",
    ] as const;
    const paramsFor = (method: (typeof scopedMethods)[number], chatId: string) => {
      if (method === "chat") return { chatId, message: "hello" };
      if (method === "answerCoachDecision") {
        return {
          chatId,
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "option-1" },
        };
      }
      if (method === "getCoachDecision") return { chatId };
      if (method === "skipCoachDecision" || method === "resumeCoachDecision") {
        return { chatId, decisionId: "decision-1" };
      }
      return { chatId };
    };
    let id = 0;
    for (const method of scopedMethods) {
      for (const chatId of foreignChatIds) {
        id += 1;
        client.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: paramsFor(method, chatId),
          }),
        );
        expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
          id,
          error: { code: -32602, message: "Invalid params" },
        });
      }
    }
    expect(chat).not.toHaveBeenCalled();
    expect(getCoachDecision).not.toHaveBeenCalled();
    expect(answerCoachDecision).not.toHaveBeenCalled();
    expect(skipCoachDecision).not.toHaveBeenCalled();
    expect(resumeCoachDecision).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();

    for (const method of scopedMethods) {
      id += 1;
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: paramsFor(method, "desktop"),
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({ id, result: {} });
    }
    expect(chat).toHaveBeenCalledOnce();
    expect(getCoachDecision).toHaveBeenCalledOnce();
    expect(answerCoachDecision).toHaveBeenCalledOnce();
    expect(skipCoachDecision).toHaveBeenCalledOnce();
    expect(resumeCoachDecision).toHaveBeenCalledOnce();
    expect(resetSession).toHaveBeenCalledOnce();
    expect(hasSession).toHaveBeenCalledOnce();

    const planChatId = `plan:${"0".repeat(25)}1`;
    id += 1;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "getChatQueue",
        params: { chatId: planChatId },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id,
      result: { schemaVersion: 1, revision: 0, items: [] },
    });
    expect(getChatQueue).toHaveBeenCalledWith({ chatId: planChatId });
    id += 1;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "chat",
        params: { chatId: planChatId, message: "bypass" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id,
      error: { code: -32602, message: "Invalid params" },
    });
    expect(chat).toHaveBeenCalledOnce();

    id += 1;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "getActivityAnalysis",
        params: { canonicalActivityId: "a".repeat(64), sections: ["aerobic-drift"] },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id,
      result: { schemaVersion: 1, sections: { aerobicDrift: { kind: "unavailable" } } },
    });
    expect(getActivityAnalysis).toHaveBeenCalledOnce();
    await client.close();
  });

  it("denies Telegram sessions to every network authority", async () => {
    const token = "x".repeat(43);
    const chat = vi.fn(async () => ({ text: "ok" }));
    const resetSession = vi.fn(async () => ({ memoryFlushed: true }));
    const hasSession = vi.fn(async () => ({ hasSession: true }));
    const getCoachDecision = vi.fn(async () => ({ decision: null }));
    const answerCoachDecision = vi.fn(async () => ({ decision: completedDecision }));
    const skipCoachDecision = vi.fn(async () => ({
      decision: { ...unansweredDecision, status: "skipped" as const },
    }));
    const resumeCoachDecision = vi.fn(async () => ({
      decision: completedDecision,
      resumed: true,
    }));
    const rpc = createCoachRpcServer({
      engine: engine({
        chat,
        resetSession,
        hasSession,
        getCoachDecision,
        answerCoachDecision,
        skipCoachDecision,
        resumeCoachDecision,
      }),
      token,
      owner: "unmanaged-foreground",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    const methods = [
      "chat",
      "getCoachDecision",
      "answerCoachDecision",
      "skipCoachDecision",
      "resumeCoachDecision",
      "resetSession",
      "hasSession",
    ] as const;
    for (const [index, method] of methods.entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: index,
          method,
          params:
            method === "chat"
              ? { chatId: "telegram:777", message: "hello" }
              : method === "answerCoachDecision"
                ? {
                    chatId: "telegram:777",
                    decisionId: "decision-1",
                    answer: { kind: "option", optionId: "option-1" },
                  }
                : method === "skipCoachDecision" || method === "resumeCoachDecision"
                  ? { chatId: "telegram:777", decisionId: "decision-1" }
                  : { chatId: "telegram:777" },
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        id: index,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(chat).not.toHaveBeenCalled();
    expect(getCoachDecision).not.toHaveBeenCalled();
    expect(answerCoachDecision).not.toHaveBeenCalled();
    expect(skipCoachDecision).not.toHaveBeenCalled();
    expect(resumeCoachDecision).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "cli",
        method: "chat",
        params: { chatId: "cli:default", message: "hello" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "cli",
      result: { text: "ok" },
    });
    expect(chat).toHaveBeenCalledOnce();
    await client.close();
  });

  it("projects closed Telegram control only to the privileged bearer", async () => {
    const token = "x".repeat(43);
    const disabledSnapshot: TelegramControlSnapshot = {
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
    };
    const onlineSnapshot: TelegramControlSnapshot = {
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "CoachBot" },
      pairing: { state: "paired" },
    };
    const credentialInspection = {
      status: "ready" as const,
      bot: { id: 10001, username: "CoachBot" },
    };
    const senderList = {
      senders: [{ senderId: 12345, role: "primary" as const }],
    };
    const configure = vi.fn(async (_token: string) => ({
      outcome: "applied" as const,
      current: onlineSnapshot,
    }));
    const enable = vi.fn(async () => onlineSnapshot);
    const disable = vi.fn(async () => disabledSnapshot);
    const stopPolling = vi.fn(async () => ({
      ...onlineSnapshot,
      channel: { desiredState: "enabled" as const, state: "suspended" as const },
    }));
    const resumePolling = vi.fn(async () => onlineSnapshot);
    const drainPending = vi.fn(async () => onlineSnapshot);
    const replace = vi.fn(async (_token: string) => ({
      outcome: "applied" as const,
      current: onlineSnapshot,
    }));
    const reconcile = vi.fn(async () => onlineSnapshot);
    const inspectTelegramCredential = vi.fn(async (_token: string) => credentialInspection);
    const deleteTelegramWebhook = vi.fn(async (_token: string) => credentialInspection);
    const forgetTelegramCredential = vi.fn(async () => disabledSnapshot);
    const resetTelegramAccess = vi.fn(async () => disabledSnapshot);
    const beginTelegramPairing = vi.fn(async () => onlineSnapshot);
    const cancelTelegramPairing = vi.fn(async () => onlineSnapshot);
    const listTelegramAllowedSenders = vi.fn(async () => senderList);
    const addTelegramAllowedSender = vi.fn(async (_senderId: number) => ({
      outcome: "applied" as const,
      current: senderList,
    }));
    const removeTelegramAllowedSender = vi.fn(async (_senderId: number) => ({
      outcome: "uncertain" as const,
      reason: "storage-uncertain" as const,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      telegram: telegramController({
        getStatus: () => disabledSnapshot,
        configure,
        enable,
        disable,
        stopPolling,
        resumePolling,
        drainPending,
        replace,
        reconcile,
        inspectTelegramCredential,
        deleteTelegramWebhook,
        forgetTelegramCredential,
        resetTelegramAccess,
        beginTelegramPairing,
        cancelTelegramPairing,
        listTelegramAllowedSenders,
        addTelegramAllowedSender,
        removeTelegramAllowedSender,
      }),
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    const requests = [
      { method: "configureTelegram", params: { token: "first-private-token" } },
      { method: "enableTelegram", params: {} },
      { method: "replaceTelegram", params: { token: "second-private-token" } },
      { method: "getTelegramStatus", params: {} },
      { method: "reconcileTelegram", params: {} },
      { method: "disableTelegram", params: {} },
      { method: "suspendTelegramPolling", params: {} },
      { method: "resumeTelegramPolling", params: {} },
      { method: "drainTelegram", params: {} },
      { method: "inspectTelegramCredential", params: { token: "inspection-private-token" } },
      { method: "deleteTelegramWebhook", params: { token: "webhook-private-token" } },
      { method: "forgetTelegramCredential", params: {} },
      { method: "resetTelegramAccess", params: {} },
      { method: "beginTelegramPairing", params: {} },
      { method: "cancelTelegramPairing", params: {} },
      { method: "listTelegramAllowedSenders", params: {} },
      {
        method: "addTelegramAllowedSender",
        params: { senderId: Number.MAX_SAFE_INTEGER },
      },
      { method: "removeTelegramAllowedSender", params: { senderId: 67890 } },
    ] as const;
    for (const [id, request] of requests.entries()) {
      client.ws.send(JSON.stringify({ jsonrpc: "2.0", id, ...request }));
      const response = parseCoachRpcEnvelope(await client.frames.next());
      expect(response).toMatchObject({ id, result: expect.any(Object) });
      if (request.method === "configureTelegram") {
        expect(response).toMatchObject({
          result: { outcome: "applied", current: onlineSnapshot },
        });
      }
      if (request.method === "replaceTelegram") {
        expect(response).toMatchObject({
          result: { outcome: "applied", current: onlineSnapshot },
        });
      }
      if (request.method === "addTelegramAllowedSender") {
        expect(response).toMatchObject({
          result: { outcome: "applied", current: senderList },
        });
      }
      if (request.method === "removeTelegramAllowedSender") {
        expect(response).toMatchObject({
          result: { outcome: "uncertain", reason: "storage-uncertain" },
        });
      }
      expect(JSON.stringify(response)).not.toContain("private-token");
      expect(JSON.stringify(response)).not.toContain("api.telegram.org");
    }
    expect(configure).toHaveBeenCalledWith("first-private-token");
    expect(replace).toHaveBeenCalledWith("second-private-token");
    expect(enable).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
    expect(stopPolling).toHaveBeenCalledOnce();
    expect(resumePolling).toHaveBeenCalledOnce();
    expect(drainPending).toHaveBeenCalledOnce();
    expect(inspectTelegramCredential).toHaveBeenCalledWith("inspection-private-token");
    expect(deleteTelegramWebhook).toHaveBeenCalledWith("webhook-private-token");
    expect(forgetTelegramCredential).toHaveBeenCalledOnce();
    expect(resetTelegramAccess).toHaveBeenCalledOnce();
    expect(beginTelegramPairing).toHaveBeenCalledOnce();
    expect(cancelTelegramPairing).toHaveBeenCalledOnce();
    expect(listTelegramAllowedSenders).toHaveBeenCalledOnce();
    expect(addTelegramAllowedSender).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    expect(removeTelegramAllowedSender).toHaveBeenCalledWith(67890);

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "unsafe-sender",
        method: "addTelegramAllowedSender",
        params: { senderId: Number.MAX_SAFE_INTEGER + 1 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "unsafe-sender",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(addTelegramAllowedSender).toHaveBeenCalledOnce();

    addTelegramAllowedSender.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: { senders: [] },
      privateDetail: "private daemon mutation detail",
    } as never);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "malformed-mutation",
        method: "addTelegramAllowedSender",
        params: { senderId: 67890 },
      }),
    );
    const malformedMutation = parseCoachRpcEnvelope(await client.frames.next());
    expect(malformedMutation).toMatchObject({
      id: "malformed-mutation",
      error: { code: -32603, message: "Internal error" },
    });
    expect(JSON.stringify(malformedMutation)).not.toContain("private daemon mutation detail");
    await client.close();
  });

  it("holds privileged drainTelegram until drain settlement without other Telegram mutations", async () => {
    const token = "x".repeat(43);
    const snapshot: TelegramControlSnapshot = {
      channel: { desiredState: "enabled", state: "suspended" },
      bot: { state: "ready", username: "CoachBot" },
      pairing: { state: "paired" },
    };
    const drain = deferred<TelegramControlSnapshot>();
    const configure = vi.fn(async () => ({ outcome: "applied" as const, current: snapshot }));
    const enable = vi.fn(async () => snapshot);
    const disable = vi.fn(async () => snapshot);
    const stopPolling = vi.fn(async () => snapshot);
    const resumePolling = vi.fn(async () => snapshot);
    const replace = vi.fn(async () => ({ outcome: "applied" as const, current: snapshot }));
    const beginTelegramPairing = vi.fn(async () => snapshot);
    const resetTelegramAccess = vi.fn(async () => snapshot);
    const drainPending = vi.fn(() => drain.promise);
    const rpc = createCoachRpcServer({
      engine: engine(),
      telegram: telegramController({
        configure,
        enable,
        disable,
        stopPolling,
        resumePolling,
        drainPending,
        replace,
        beginTelegramPairing,
        resetTelegramAccess,
      }),
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "drain", method: "drainTelegram", params: {} }),
    );
    await vi.waitFor(() => expect(drainPending).toHaveBeenCalledOnce());
    let delivered = false;
    const response = client.frames.next().then((frame) => {
      delivered = true;
      return parseCoachRpcEnvelope(frame);
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(stopPolling).not.toHaveBeenCalled();
    expect(resumePolling).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(beginTelegramPairing).not.toHaveBeenCalled();
    expect(resetTelegramAccess).not.toHaveBeenCalled();

    drain.resolve(snapshot);
    await expect(response).resolves.toMatchObject({ id: "drain", result: snapshot });
    await client.close();
  });

  it("keeps every Telegram control method absent from renderer authority", async () => {
    const token = "x".repeat(43);
    const snapshot: TelegramControlSnapshot = {
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
    };
    const telegram = telegramController({
      getStatus: vi.fn(() => snapshot),
      configure: vi.fn(async () => ({ outcome: "applied" as const, current: snapshot })),
      enable: vi.fn(async () => snapshot),
      disable: vi.fn(async () => snapshot),
      drainPending: vi.fn(async () => snapshot),
      replace: vi.fn(async () => ({ outcome: "applied" as const, current: snapshot })),
      reconcile: vi.fn(async () => snapshot),
      inspectTelegramCredential: vi.fn(async () => ({ status: "invalid-token" as const })),
      deleteTelegramWebhook: vi.fn(async () => ({ status: "invalid-token" as const })),
      forgetTelegramCredential: vi.fn(async () => snapshot),
      resetTelegramAccess: vi.fn(async () => snapshot),
      beginTelegramPairing: vi.fn(async () => snapshot),
      cancelTelegramPairing: vi.fn(async () => snapshot),
      listTelegramAllowedSenders: vi.fn(async () => ({ senders: [] })),
      addTelegramAllowedSender: vi.fn(async () => ({
        outcome: "applied" as const,
        current: { senders: [] },
      })),
      removeTelegramAllowedSender: vi.fn(async () => ({
        outcome: "applied" as const,
        current: { senders: [] },
      })),
    });
    const rpc = createCoachRpcServer({
      engine: engine(),
      telegram,
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await client.frames.next();

    const telegramRequests = [
      { method: "configureTelegram", params: { token: "renderer-private-token" } },
      { method: "enableTelegram", params: {} },
      { method: "disableTelegram", params: {} },
      { method: "suspendTelegramPolling", params: {} },
      { method: "resumeTelegramPolling", params: {} },
      { method: "drainTelegram", params: {} },
      { method: "replaceTelegram", params: { token: "renderer-private-token" } },
      { method: "getTelegramStatus", params: {} },
      { method: "reconcileTelegram", params: {} },
      {
        method: "inspectTelegramCredential",
        params: { token: "renderer-private-token" },
      },
      { method: "deleteTelegramWebhook", params: { token: "renderer-private-token" } },
      { method: "forgetTelegramCredential", params: {} },
      { method: "resetTelegramAccess", params: {} },
      { method: "beginTelegramPairing", params: {} },
      { method: "cancelTelegramPairing", params: {} },
      { method: "listTelegramAllowedSenders", params: {} },
      { method: "addTelegramAllowedSender", params: { senderId: 12345 } },
      { method: "removeTelegramAllowedSender", params: { senderId: 12345 } },
    ] as const;
    for (const [id, request] of telegramRequests.entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...request,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        id,
        error: { code: -32601, message: "Method not found" },
      });
    }
    expect(telegram.getStatus).not.toHaveBeenCalled();
    expect(telegram.configure).not.toHaveBeenCalled();
    expect(telegram.enable).not.toHaveBeenCalled();
    expect(telegram.disable).not.toHaveBeenCalled();
    expect(telegram.drainPending).not.toHaveBeenCalled();
    expect(telegram.replace).not.toHaveBeenCalled();
    expect(telegram.reconcile).not.toHaveBeenCalled();
    expect(telegram.inspectTelegramCredential).not.toHaveBeenCalled();
    expect(telegram.deleteTelegramWebhook).not.toHaveBeenCalled();
    expect(telegram.forgetTelegramCredential).not.toHaveBeenCalled();
    expect(telegram.resetTelegramAccess).not.toHaveBeenCalled();
    expect(telegram.beginTelegramPairing).not.toHaveBeenCalled();
    expect(telegram.cancelTelegramPairing).not.toHaveBeenCalled();
    expect(telegram.listTelegramAllowedSenders).not.toHaveBeenCalled();
    expect(telegram.addTelegramAllowedSender).not.toHaveBeenCalled();
    expect(telegram.removeTelegramAllowedSender).not.toHaveBeenCalled();
    await client.close();
  });

  it("limits renderer configuration to athlete and session settings", async () => {
    const token = "x".repeat(43);
    const configureRuntime = vi.fn(async ({ llm, intervals, session }) => ({
      schemaVersion: 3 as const,
      status: "applied" as const,
      applied: {
        llm: llm !== undefined,
        intervals: intervals !== undefined,
        session: session !== undefined,
      },
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, configureRuntime },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await client.frames.next();

    const restrictedPatches = [
      { llm: { api_key: "secret" } },
      { llm: { clear_credential: true } },
      { llm: { provider: "anthropic" } },
      { llm: { base_url: "https://attacker.invalid" } },
      { llm: { claude_cli: { binary_path: "/tmp/attacker" } } },
      { llm: { codex_agent: { binary_path: "/tmp/attacker" } } },
      { intervals: { api_key: "secret" } },
      { intervals: { clear_credential: true } },
    ];
    for (const [index, params] of restrictedPatches.entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `secret-${index}`,
          method: "configureRuntime",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
        id: `secret-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(configureRuntime).not.toHaveBeenCalled();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "ordinary-config",
        method: "configureRuntime",
        params: { session: { idleMinutes: 30 } },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "ordinary-config",
      result: { status: "applied" },
    });
    expect(configureRuntime).toHaveBeenCalledOnce();

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "athlete-config",
        method: "configureRuntime",
        params: { intervals: { athlete_id: "i1" } },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "athlete-config",
      result: { status: "applied" },
    });
    expect(configureRuntime).toHaveBeenCalledTimes(2);

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "upgrade",
        method: "daemon.reserveUpgrade",
        params: {
          targetProtocolVersion: PROTOCOL_VERSION + 1,
          handoffCapability: Buffer.alloc(32, 1).toString("base64url"),
        },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "upgrade",
      error: { code: -32601, message: "Method not found" },
    });
    await client.close();
  });

  it("regenerates a renderer capability that collides with the privileged token", async () => {
    const colliding = Buffer.alloc(32, 1);
    const replacement = Buffer.alloc(32, 2);
    const random = vi
      .fn<(size: number) => Buffer>()
      .mockReturnValueOnce(colliding)
      .mockReturnValueOnce(replacement);
    const token = colliding.toString("base64url");
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "app-supervised",
      rendererCapabilityRandomBytes: random,
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()))).toMatchObject({
      rendererCapability: replacement.toString("base64url"),
    });
    expect(random).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("keeps one renderer capability stable for every connection in a daemon process", async () => {
    const token = "x".repeat(43);
    const capabilityBytes = Buffer.alloc(32, 3);
    const random = vi.fn(() => capabilityBytes);
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "app-supervised",
      rendererCapabilityRandomBytes: random,
    });
    const privileged = await openSocket(rpc);
    const renderer = await openSocket(rpc);

    privileged.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    const privilegedFrame = ServerHandshakeFrameSchema.parse(
      JSON.parse(await privileged.frames.next()),
    );
    expect(privilegedFrame.status).toBe("accepted");
    if (privilegedFrame.status !== "accepted") throw new Error("expected accepted handshake");

    renderer.ws.send(
      JSON.stringify(createClientHandshakeFrame(privilegedFrame.rendererCapability)),
    );
    const rendererFrame = ServerHandshakeFrameSchema.parse(
      JSON.parse(await renderer.frames.next()),
    );
    expect(rendererFrame).toMatchObject({
      status: "accepted",
      rendererCapability: privilegedFrame.rendererCapability,
    });
    expect(random).toHaveBeenCalledExactlyOnceWith(32);

    await privileged.close();
    await renderer.close();
  });

  it("rotates renderer capabilities between daemon processes and rejects the prior process capability", async () => {
    const token = "x".repeat(43);
    const firstCapability = Buffer.alloc(32, 4).toString("base64url");
    const secondCapability = Buffer.alloc(32, 5).toString("base64url");
    const firstRpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "app-supervised",
      rendererCapabilityRandomBytes: () => Buffer.alloc(32, 4),
    });
    const firstClient = await openSocket(firstRpc);
    firstClient.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    expect(
      ServerHandshakeFrameSchema.parse(JSON.parse(await firstClient.frames.next())),
    ).toMatchObject({
      rendererCapability: firstCapability,
    });
    await firstClient.close();

    const secondRpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "app-supervised",
      rendererCapabilityRandomBytes: () => Buffer.alloc(32, 5),
    });
    const currentClient = await openSocket(secondRpc);
    currentClient.ws.send(JSON.stringify(createClientHandshakeFrame(secondCapability)));
    expect(
      ServerHandshakeFrameSchema.parse(JSON.parse(await currentClient.frames.next())),
    ).toMatchObject({
      status: "accepted",
      rendererCapability: secondCapability,
    });

    const staleClient = await openSocket(secondRpc);
    const staleClosed = new Promise<number>((resolve) => {
      staleClient.ws.once("close", (code) => resolve(code));
    });
    staleClient.ws.send(JSON.stringify(createClientHandshakeFrame(firstCapability)));
    await expect(staleClosed).resolves.toBe(1008);

    currentClient.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "current",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await currentClient.frames.next())).toMatchObject({
      id: "current",
      result: { schemaVersion: "3" },
    });

    await staleClient.close();
    await currentClient.close();
  });

  it("fails closed after four unusable renderer capability candidates", () => {
    const colliding = Buffer.alloc(32, 6);
    const random = vi.fn(() => colliding);

    expect(() =>
      createCoachRpcServer({
        engine: engine(),
        token: colliding.toString("base64url"),
        owner: "app-supervised",
        rendererCapabilityRandomBytes: random,
      }),
    ).toThrow("renderer capability generation failed");
    expect(random).toHaveBeenCalledTimes(4);
    expect(random).toHaveBeenCalledWith(32);
  });

  it("denies a newly registered method until the renderer allowlist admits it", async () => {
    const futureMethod = "futureRendererMethod";
    const mutableRegistry = COACH_RPC_METHOD_REGISTRY as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(mutableRegistry, futureMethod)).toBe(false);
    mutableRegistry[futureMethod] = COACH_RPC_METHOD_REGISTRY.getAthleteState;

    const rpc = createCoachRpcServer({
      engine: engine(),
      token: "x".repeat(43),
      owner: "app-supervised",
    });
    let client: Awaited<ReturnType<typeof openSocket>> | undefined;
    try {
      client = await openSocket(rpc);
      client.ws.send(
        JSON.stringify(
          createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
        ),
      );
      await client.frames.next();
      client.ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: "future", method: futureMethod, params: {} }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: "future",
        error: { code: -32601, message: "Method not found" },
      });
    } finally {
      delete mutableRegistry[futureMethod];
      if (client === undefined) await rpc.close();
      else await client.close();
    }
  });

  it("keeps file export outside renderer authority", async () => {
    const exportTrainingFile = vi.fn(operations.exportTrainingFile!);
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, exportTrainingFile },
      token: "x".repeat(43),
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(
      JSON.stringify(
        createClientHandshakeFrame(TEST_RENDERER_CAPABILITY_BYTES.toString("base64url")),
      ),
    );
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "export",
        method: "exportTrainingFile",
        params: {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          format: "fit",
          destinationPath: "/tmp/renderer-must-not-write.fit",
        },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "export",
      error: { code: -32601, message: "Method not found" },
    });
    expect(exportTrainingFile).not.toHaveBeenCalled();
    await client.close();
  });
});

describe.skipIf(!hasLoopback)("authenticated upgrade control", () => {
  it("binds one reservation to the authenticated connection and consumes it once", async () => {
    const token = "x".repeat(43);
    const healthState = createDaemonHealthState();
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "service-managed",
      healthState,
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const handoffCapability = Buffer.alloc(32, 3).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "reserve",
      result: { status: "reserved" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "second",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "second",
      error: { code: -32_003, message: "handoff-reservation-refused" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "shutdown",
      result: { status: "accepted" },
    });
    await expect(rpc.shutdownRequested).resolves.toBeUndefined();
    expect(healthState.healthy).toBe(false);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "replay",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "replay",
      error: { code: -32_003, message: "handoff-reservation-refused" },
    });
    await client.close();
  });

  it("drains queued RPC work and a pre-admitted Telegram reservation before shutdown acceptance", async () => {
    const token = "x".repeat(43);
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    const telegramWork = deferred<void>();
    let call = 0;
    const healthState = createDaemonHealthState();
    const invocations = createInvocationCoordinator();
    const accessEntered = deferred<void>();
    const releaseAccess = deferred<void>();
    const recordOffset = vi.fn();
    const reserveLateUpdate = vi.fn(() => invocations.reserve({ key: "telegram:73" }));
    let projectedTelegram: CreateTelegramChannelInput | undefined;
    const telegramRuntime: TelegramChannelRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      captureDrain: vi.fn(() => ({ wait: vi.fn(async () => undefined) })),
      drainPending: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const runtimeFactory = createDesktopTelegramRuntimeFactory(
      {
        lifecycle: {
          home: { root: "/synthetic/home" },
          engine: engine(),
          operations,
          confirmations: {},
        } as unknown as Pick<
          LocalCoachLifecycle,
          "home" | "engine" | "operations" | "confirmations"
        >,
        invocations,
        appVersion: "1.2.3",
      },
      {
        createBot: (input) => {
          projectedTelegram = input;
          return telegramRuntime;
        },
        createAccessMiddleware: () => async (_context, next) => {
          accessEntered.resolve();
          await releaseAccess.promise;
          await next();
        },
        loadAllowedSenders: () => ({
          version: 1,
          dmPolicy: "allowlist",
          allowFrom: ["73"],
          primaryOperator: "73",
          capturedAt: null,
          addedAt: {},
        }),
      },
    );
    runtimeFactory({
      token: "synthetic-token",
      admitted: () => true,
      onStarted: vi.fn(),
      onPollingSuccess: vi.fn(),
      onPollingFailure: vi.fn(),
      consumePairing: vi.fn(async () => false),
    });
    const telegramReservation = invocations.reserve({ key: "telegram:73" });
    let telegramFlush: Promise<void> | undefined;
    const beforeInvocationDrain = vi.fn(async () => {
      telegramFlush ??= telegramReservation.run(() => telegramWork.promise);
    });
    const rpc = createCoachRpcServer({
      token,
      owner: "ephemeral-client-started",
      healthState,
      invocations,
      beforeInvocationDrain,
      engine: engine({
        chat: () => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
      }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    for (const id of ["chat-1", "chat-2"]) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "chat",
          params: { chatId: "same", message: id },
        }),
      );
    }
    await vi.waitFor(() => expect(call).toBe(1));
    const handoffCapability = Buffer.alloc(32, 4).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "reserve",
      result: { status: "reserved" },
    });
    const lateUpdate = projectedTelegram!.host.access.middleware({} as never, async () => {
      recordOffset();
      reserveLateUpdate();
    });
    await accessEntered.promise;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(healthState.healthy).toBe(false));
    expect(beforeInvocationDrain).toHaveBeenCalledOnce();
    expect(invocations.canAdmit()).toBe(false);
    releaseAccess.resolve();
    await expect(lateUpdate).resolves.toBeUndefined();
    expect(recordOffset).not.toHaveBeenCalled();
    expect(reserveLateUpdate).not.toHaveBeenCalled();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "post-close",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "post-close",
      error: { code: -32_005, message: "daemon-upgrading" },
    });
    first.resolve({ text: "first" });
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "chat-1" });
    await vi.waitFor(() => expect(call).toBe(2));
    second.resolve({ text: "second" });
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "chat-2",
      result: { text: "second" },
    });
    let shutdownResolved = false;
    void rpc.shutdownRequested.then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    telegramWork.resolve();
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "shutdown",
      result: { status: "accepted" },
    });
    await client.close();
  });

  it("restores intake and healthy state after the monotonic drain deadline", async () => {
    const token = "x".repeat(43);
    const work = deferred<{ text: string }>();
    const timer = new FakeTimer();
    const healthState = createDaemonHealthState();
    const chat = vi.fn(() => work.promise);
    const telegramDrain = deferred<void>();
    const beforeInvocationDrain = vi.fn(() => telegramDrain.promise);
    const recovery = deferred<void>();
    const afterInvocationDrainRefusal = vi.fn(() => recovery.promise);
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      healthState,
      timer,
      engine: engine({ chat }),
      beforeInvocationDrain,
      afterInvocationDrainRefusal,
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "running",
        method: "chat",
        params: { chatId: "same", message: "running" },
      }),
    );
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    const handoffCapability = Buffer.alloc(32, 5).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(healthState.healthy).toBe(false));
    expect(beforeInvocationDrain).toHaveBeenCalledOnce();
    timer.advance(30_000);
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "shutdown",
      error: { code: -32_004, message: "upgrade-drain-timeout" },
    });
    expect(healthState.healthy).toBe(true);
    expect(afterInvocationDrainRefusal).toHaveBeenCalledOnce();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "read-after-timeout",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "read-after-timeout" });
    work.resolve({ text: "done" });
    telegramDrain.resolve();
    recovery.resolve();
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "running" });
    await client.close();
  });

  it("does not retain a timed-out upgrade waiter and still awaits final retained generations", async () => {
    const token = "x".repeat(43);
    const timer = new FakeTimer();
    const abandonedUpgradeDrain = deferred<void>().promise;
    const retainedGenerationDrain = deferred<void>();
    let drainCalls = 0;
    const beforeInvocationDrain = vi.fn(() => {
      drainCalls += 1;
      return drainCalls === 1 ? abandonedUpgradeDrain : retainedGenerationDrain.promise;
    });
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      timer,
      engine: engine(),
      beforeInvocationDrain,
      afterInvocationDrainRefusal: vi.fn(async () => undefined),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const handoffCapability = Buffer.alloc(32, 8).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(beforeInvocationDrain).toHaveBeenCalledOnce());

    timer.advance(UPGRADE_DRAIN_TIMEOUT_MS);
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "shutdown",
      error: { code: -32_004, message: "upgrade-drain-timeout" },
    });

    const closing = rpc.close();
    await vi.waitFor(() => expect(beforeInvocationDrain).toHaveBeenCalledTimes(2));
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    retainedGenerationDrain.resolve(undefined);
    await closing;
    expect(closeSettled).toBe(true);
    await client.close();
  });

  it("keeps a later process close final when refusal recovery is already in flight", async () => {
    const token = "x".repeat(43);
    const timer = new FakeTimer();
    const healthState = createDaemonHealthState();
    const oldGenerationDrain = deferred<void>();
    const resumeEntered = deferred<void>();
    const resumeReleased = deferred<void>();
    const resumeFinished = deferred<void>();
    const events: string[] = [];
    let telegramState: "running" | "stopped" = "stopped";
    let drainCalls = 0;
    const beforeInvocationDrain = vi.fn(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        events.push("upgrade-stop");
        await oldGenerationDrain.promise;
        return;
      }
      events.push("process-stop-start");
      await resumeFinished.promise;
      telegramState = "stopped";
      events.push("process-stop-finished");
    });
    const afterInvocationDrainRefusal = vi.fn(async () => {
      events.push("resume-start");
      resumeEntered.resolve(undefined);
      await resumeReleased.promise;
      telegramState = "running";
      events.push("resume-finished");
      resumeFinished.resolve(undefined);
    });
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      healthState,
      timer,
      engine: engine(),
      beforeInvocationDrain,
      afterInvocationDrainRefusal,
    });
    const client = await openSocket(rpc);
    let closing: Promise<void> | undefined;
    try {
      client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
      await client.frames.next();
      const handoffCapability = Buffer.alloc(32, 7).toString("base64url");
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "reserve",
          method: "daemon.reserveUpgrade",
          params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
        }),
      );
      await client.frames.next();
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "shutdown",
          method: "daemon.shutdownForUpgrade",
          params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
        }),
      );
      await vi.waitFor(() => expect(beforeInvocationDrain).toHaveBeenCalledOnce());

      timer.advance(UPGRADE_DRAIN_TIMEOUT_MS);
      expect(JSON.parse(await client.frames.next())).toMatchObject({
        id: "shutdown",
        error: { code: -32_004, message: "upgrade-drain-timeout" },
      });
      await resumeEntered.promise;
      expect(healthState.healthy).toBe(true);
      expect(afterInvocationDrainRefusal).toHaveBeenCalledOnce();
      expect(telegramState).toBe("stopped");

      closing = rpc.close();
      await vi.waitFor(() => expect(beforeInvocationDrain).toHaveBeenCalledTimes(2));
      expect(healthState.healthy).toBe(false);
      expect(events).toEqual(["upgrade-stop", "resume-start", "process-stop-start"]);

      let closeSettled = false;
      void closing.then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      resumeReleased.resolve(undefined);
      await closing;
      expect(events).toEqual([
        "upgrade-stop",
        "resume-start",
        "process-stop-start",
        "resume-finished",
        "process-stop-finished",
      ]);
      expect(telegramState).toBe("stopped");
      expect(healthState.healthy).toBe(false);
    } finally {
      resumeReleased.resolve(undefined);
      resumeFinished.resolve(undefined);
      oldGenerationDrain.resolve(undefined);
      await closing?.catch(() => undefined);
      await client.close();
    }
  });

  it("does not restore health or Telegram after a later quiesce seals the timeout fence", async () => {
    const token = "x".repeat(43);
    const timer = new FakeTimer();
    const healthState = createDaemonHealthState();
    const invocations = createInvocationCoordinator();
    const telegramDrain = deferred<void>();
    const afterInvocationDrainRefusal = vi.fn(async () => undefined);
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      healthState,
      invocations,
      timer,
      engine: engine(),
      beforeInvocationDrain: () => telegramDrain.promise,
      afterInvocationDrainRefusal,
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const handoffCapability = Buffer.alloc(32, 6).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(healthState.healthy).toBe(false));

    invocations.closeAdmission().seal();
    timer.advance(UPGRADE_DRAIN_TIMEOUT_MS);
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "shutdown",
      error: { code: -32_004, message: "upgrade-drain-timeout" },
    });
    expect(healthState.healthy).toBe(false);
    expect(afterInvocationDrainRefusal).not.toHaveBeenCalled();

    telegramDrain.resolve();
    await client.close();
  });
});
