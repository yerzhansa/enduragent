import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_SUCCESS,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
  type PlanCreationOperations,
  type SpendSummary,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type {
  WriterProtocolBinding,
  WriterProtocolHandlers,
  WriterProtocolListener,
} from "@enduragent/kernel-node/lock";
import { runCoachServe, type CoachServeDependencies } from "../src/serve.js";
import { createInvocationCoordinator } from "../src/daemon/invocation-coordinator.js";
import type { CoachRpcServerInput } from "../src/daemon/rpc-server.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";
import { planCreationOperationStubs } from "./helpers/plan-creation-operation-stubs.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

const engine: CoachEngine = {
  chat: async () => ({ text: "ok" }),
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
  getAthleteState: async () => state,
};

const operations: CoachOperations & PlanCreationOperations = {
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

const spendSummary = {
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
} satisfies SpendSummary;

const home: AthleteHome = {
  root: "/synthetic/athlete",
  storeDir: "/synthetic/athlete/store",
  archiveDir: "/synthetic/athlete/archive",
  configDir: "/synthetic/athlete/config",
};

function harness(
  options: {
    readonly token?: Promise<{ readonly path: string; readonly value: string }>;
    readonly bind?: Promise<WriterProtocolBinding>;
    readonly shutdownRequested?: Promise<void>;
    readonly onCreateRpc?: () => void;
  } = {},
) {
  const trace: string[] = [];
  let handlers: WriterProtocolHandlers | undefined;
  const binding: WriterProtocolBinding = {
    port: 42_001,
    async close() {
      trace.push("protocol-stop");
      await Promise.resolve();
      trace.push("protocol-closed");
    },
  };
  const listener: WriterProtocolListener = {
    async bind(value) {
      trace.push("protocol-bind");
      handlers = value;
      return options.bind ?? binding;
    },
  };
  const startInitialRefresh = vi.fn(async () => {
    trace.push("initial-refresh");
  });
  const lifecycle: LocalCoachLifecycle = {
    home,
    engine,
    operations,
    spendMeter: {
      getSpendSummary: vi.fn(async () => spendSummary),
      setDailySpendCap: vi.fn(async () => spendSummary),
    },
    confirmations: {
      peek: vi.fn(),
      confirm: vi.fn(),
      cancel: vi.fn(),
    },
    listener,
    startInitialRefresh,
    async close() {
      trace.push("lifecycle-close");
    },
  };
  const ensureToken = vi.fn(async () => {
    trace.push("token-ready");
    return options.token ?? { path: `${home.configDir}/daemon.token`, value: "x".repeat(43) };
  });
  const rpcClose = vi.fn(async () => {
    trace.push("rpc-drained");
  });
  let rpcInput: CoachRpcServerInput | undefined;
  const createRpcServer = vi.fn((input: CoachRpcServerInput) => {
    rpcInput = input;
    trace.push("rpc-created");
    options.onCreateRpc?.();
    return {
      handleUpgrade: vi.fn(),
      shutdownRequested: options.shutdownRequested ?? new Promise<void>(() => {}),
      close: rpcClose,
    };
  });
  const createHealthzHandler = vi.fn(() => {
    trace.push("health-handler-created");
    return vi.fn() as unknown as (request: IncomingMessage, response: ServerResponse) => void;
  });
  const createInvocations = vi.fn(() => {
    const coordinator = createInvocationCoordinator();
    return {
      reserve: coordinator.reserve,
      invoke: coordinator.invoke,
      closeAdmission() {
        trace.push("admission-close");
        const fence = coordinator.closeAdmission();
        return {
          seal: () => fence.seal(),
          reopen: () => fence.reopen(),
          async drain() {
            trace.push("shared-drain");
            await fence.drain();
          },
        };
      },
    };
  });
  const telegramSnapshot = {
    channel: { desiredState: "disabled" as const, state: "disabled" as const },
    bot: { state: "unconfigured" as const },
    pairing: { state: "unpaired" as const },
  };
  const telegram = {
    getStatus: vi.fn(() => telegramSnapshot),
    configure: vi.fn(async () => telegramSnapshot),
    enable: vi.fn(async () => telegramSnapshot),
    disable: vi.fn(async () => telegramSnapshot),
    replace: vi.fn(async () => telegramSnapshot),
    reconcile: vi.fn(async () => telegramSnapshot),
    inspectTelegramCredential: vi.fn(async () => ({ status: "invalid-token" as const })),
    deleteTelegramWebhook: vi.fn(async () => ({ status: "invalid-token" as const })),
    forgetTelegramCredential: vi.fn(async () => telegramSnapshot),
    resetTelegramAccess: vi.fn(async () => telegramSnapshot),
    beginTelegramPairing: vi.fn(async () => telegramSnapshot),
    cancelTelegramPairing: vi.fn(async () => telegramSnapshot),
    listTelegramAllowedSenders: vi.fn(async () => ({ senders: [] })),
    addTelegramAllowedSender: vi.fn(async () => ({
      outcome: "applied" as const,
      current: { senders: [] },
    })),
    removeTelegramAllowedSender: vi.fn(async () => ({
      outcome: "applied" as const,
      current: { senders: [] },
    })),
    stopPolling: vi.fn(async () => {
      trace.push("telegram-stop");
      return telegramSnapshot;
    }),
    resumePolling: vi.fn(async () => {
      trace.push("telegram-resume");
      return telegramSnapshot;
    }),
    drainPending: vi.fn(async () => {
      trace.push("telegram-drain");
      return telegramSnapshot;
    }),
    close: vi.fn(async () => {
      trace.push("telegram-close");
      return telegramSnapshot;
    }),
  };
  const createTelegramController = vi.fn(() => telegram);
  const createTelegramRuntimeFactory = vi.fn(() => () => {
    throw new Error("unused Telegram runtime");
  });
  const dependencies = {
    ensureToken,
    createRpcServer,
    createHealthzHandler,
    createHealthState: () => ({ healthy: true, setHealthy: vi.fn() }),
    createInvocations,
    createTelegramController,
    createTelegramRuntimeFactory,
  } as unknown as CoachServeDependencies;
  return {
    input: { lifecycle, appVersion: "0.1.0", signal: new AbortController().signal },
    lifecycle,
    dependencies,
    binding,
    trace,
    handlers: () => handlers,
    rpcInput: () => rpcInput,
    ensureToken,
    createRpcServer,
    createHealthzHandler,
    startInitialRefresh,
    rpcClose,
    createInvocations,
    createTelegramController,
    createTelegramRuntimeFactory,
    telegram,
  };
}

describe("runCoachServe", () => {
  it("does no private setup for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic secret reason"));
    const test = harness();
    await expect(
      runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(test.ensureToken).not.toHaveBeenCalled();
    expect(test.createRpcServer).not.toHaveBeenCalled();
    expect(test.trace).toEqual([]);
  });

  it("publishes the handler pair only at bind and quiesces both ingresses before transport close", async () => {
    const controller = new AbortController();
    const test = harness();
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.handlers()).toBeDefined());
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
      "initial-refresh",
    ]);
    expect(test.handlers()?.upgrade).toBe(
      test.createRpcServer.mock.results[0]?.value.handleUpgrade,
    );
    expect(test.createRpcServer).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteHome: home.root,
        selfTestOperations: { selfTest: expect.any(Function) },
        telegram: test.telegram,
      }),
    );
    expect(test.createTelegramController).toHaveBeenCalledWith({
      dataDir: home.root,
      createRuntime: test.createTelegramRuntimeFactory.mock.results[0]?.value,
    });
    expect(test.ensureToken).toHaveBeenCalledWith(test.lifecycle.home.configDir);
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
      "initial-refresh",
      "admission-close",
      "telegram-stop",
      "telegram-drain",
      "shared-drain",
      "protocol-stop",
      "rpc-drained",
      "protocol-closed",
      "telegram-close",
    ]);
  });

  it("keeps serving when the post-publication initial refresh fails", async () => {
    const controller = new AbortController();
    const failure = new Error("synthetic persistence failure");
    const test = harness();
    test.startInitialRefresh.mockRejectedValueOnce(failure);
    let settled = false;

    const result = runCoachServe(
      { ...test.input, signal: controller.signal },
      test.dependencies,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(test.startInitialRefresh).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(test.handlers()).toBeDefined();
    expect(settled).toBe(false);
    controller.abort();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
  });

  it("waits for privileged release when app-supervised and keeps serving after refresh rejection", async () => {
    const controller = new AbortController();
    const test = harness();
    test.startInitialRefresh.mockRejectedValueOnce(new Error("synthetic refresh failure"));
    const result = runCoachServe(
      { ...test.input, owner: "app-supervised", signal: controller.signal },
      test.dependencies,
    );
    await vi.waitFor(() => expect(test.rpcInput()).toBeDefined());

    expect(test.startInitialRefresh).not.toHaveBeenCalled();
    expect(test.rpcInput()?.scheduleInitialRefresh).toEqual(expect.any(Function));
    expect(() => test.rpcInput()?.scheduleInitialRefresh?.()).not.toThrow();
    await Promise.resolve();
    expect(test.startInitialRefresh).toHaveBeenCalledOnce();

    controller.abort();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
  });

  it("wires the invocation-drain callbacks to stop, drain, and resume Telegram", async () => {
    const controller = new AbortController();
    const test = harness();
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.rpcInput()).toBeDefined());
    const rpcInput = test.rpcInput();
    expect(rpcInput?.beforeInvocationDrain).toEqual(expect.any(Function));
    expect(rpcInput?.afterInvocationDrainRefusal).toEqual(expect.any(Function));

    test.trace.length = 0;
    const stopSettled = deferred<void>();
    test.telegram.stopPolling.mockImplementationOnce(async () => {
      test.trace.push("telegram-stop");
      await stopSettled.promise;
      test.trace.push("telegram-stopped");
      return test.telegram.getStatus();
    });
    const draining = rpcInput?.beforeInvocationDrain?.();
    await vi.waitFor(() => expect(test.trace).toEqual(["telegram-stop"]));
    expect(test.telegram.drainPending).not.toHaveBeenCalled();

    stopSettled.resolve();
    await draining;
    expect(test.trace).toEqual(["telegram-stop", "telegram-stopped", "telegram-drain"]);

    await rpcInput?.afterInvocationDrainRefusal?.();
    expect(test.trace).toEqual([
      "telegram-stop",
      "telegram-stopped",
      "telegram-drain",
      "telegram-resume",
    ]);

    controller.abort();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
  });

  it("stops before RPC construction when abort arrives during token setup", async () => {
    const controller = new AbortController();
    const token = deferred<{ path: string; value: string }>();
    const test = harness({ token: token.promise });
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.ensureToken).toHaveBeenCalledTimes(1));
    controller.abort();
    token.resolve({ path: `${home.configDir}/daemon.token`, value: "x".repeat(43) });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.createRpcServer).not.toHaveBeenCalled();
    expect(test.createHealthzHandler).not.toHaveBeenCalled();
  });

  it("closes RPC without binding when abort arrives immediately before bind", async () => {
    const controller = new AbortController();
    const test = harness({ onCreateRpc: () => controller.abort() });
    await expect(
      runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(test.rpcClose).toHaveBeenCalledTimes(1);
    expect(test.createHealthzHandler).not.toHaveBeenCalled();
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "admission-close",
      "telegram-stop",
      "telegram-drain",
      "shared-drain",
      "rpc-drained",
      "telegram-close",
    ]);
  });

  it("awaits an asynchronous bind raced by abort before complete shutdown", async () => {
    const controller = new AbortController();
    const bind = deferred<WriterProtocolBinding>();
    const test = harness({ bind: bind.promise });
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.createHealthzHandler).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(test.rpcClose).not.toHaveBeenCalled();
    bind.resolve(test.binding);
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.rpcClose).toHaveBeenCalledTimes(1);
  });

  it("returns from the local operation only after the upgrade response flush signal", async () => {
    const shutdown = deferred<void>();
    const test = harness({ shutdownRequested: shutdown.promise });
    const result = runCoachServe(test.input, test.dependencies);
    await vi.waitFor(() => expect(test.handlers()).toBeDefined());
    shutdown.resolve();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.trace.slice(-8)).toEqual([
      "admission-close",
      "telegram-stop",
      "telegram-drain",
      "shared-drain",
      "protocol-stop",
      "rpc-drained",
      "protocol-closed",
      "telegram-close",
    ]);
  });

  it("rethrows bind failure only after closing the constructed RPC server", async () => {
    const failure = new Error("bind failed");
    const bind = deferred<WriterProtocolBinding>();
    bind.reject(failure);
    const test = harness({ bind: bind.promise });
    await expect(runCoachServe(test.input, test.dependencies)).rejects.toBe(failure);
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
      "admission-close",
      "telegram-stop",
      "telegram-drain",
      "shared-drain",
      "rpc-drained",
      "telegram-close",
    ]);
  });
});
