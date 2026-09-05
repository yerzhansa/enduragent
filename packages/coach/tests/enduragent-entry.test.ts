import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_OAUTH_OWNERSHIP_FILE } from "@enduragent/core";
import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
  JsonRpcSuccessResponseEnvelopeSchema,
  SelfTestCommandTerminalSchema,
  PROTOCOL_VERSION,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
} from "@enduragent/coach-contract";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import {
  CoachRemoteError,
  type CoachVerbRequest,
  type CoachVerbTransport,
} from "@enduragent/coach-cli";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener, PORT_FILE_NAME } from "@enduragent/kernel-node/lock";
import { StoreNewerThanAppError } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  runAppSupervisedEnduragent,
  runEnduragent,
  startDesktopDaemonInitialRefresh,
  type EnduragentDependencies,
  type RunEnduragentInput,
} from "../src/enduragent.js";
import {
  withLocalCoach,
  type LocalCoachLifecycle,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "../src/local-runner.js";
import { CoachStoreWriterError, withCoachStoreWriter } from "../src/runtime.js";
import type { SpendMeterService } from "../src/spend-meter.js";

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

const operations: CoachOperations = {
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

const spendMeter: SpendMeterService = {
  getSpendSummary: async () => {
    throw new Error("unused spend meter");
  },
  setDailySpendCap: async () => {
    throw new Error("unused spend meter");
  },
};

const confirmations: LocalCoachLifecycle["confirmations"] = {
  peek: () => undefined,
  confirm: async () => ({ status: "none" }),
  cancel: () => "none",
};

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

function terminal(
  input = new PassThrough(),
  isTTY = false,
): {
  readonly input: PassThrough;
  readonly stdout: ReturnType<typeof capture>;
  readonly stderr: ReturnType<typeof capture>;
  readonly value: RunEnduragentInput["terminal"];
} {
  const stdout = capture();
  const stderr = capture();
  return {
    input,
    stdout,
    stderr,
    value: { input, stdout: stdout.stream, stderr: stderr.stream, isTTY },
  };
}

function mockEngine(
  implementation: CoachEngine["chat"] = async ({ message }) => ({ text: `${message}-response` }),
): {
  readonly engine: CoachEngine;
  readonly chat: ReturnType<typeof vi.fn<CoachEngine["chat"]>>;
} {
  const chat = vi.fn<CoachEngine["chat"]>(implementation);
  const resetSession = vi.fn<CoachEngine["resetSession"]>(async () => ({
    memoryFlushed: true,
  }));
  const hasSession = vi.fn<CoachEngine["hasSession"]>(async () => ({
    hasSession: false,
  }));
  const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
  return {
    engine: {
      chat,
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
      resetSession,
      hasSession,
      getAthleteState,
    },
    chat,
  };
}

function remoteTransport(
  result: unknown,
  input: {
    readonly close?: () => Promise<void>;
    readonly received?: CoachVerbRequest[];
  } = {},
): CoachVerbTransport {
  return {
    kind: "remote",
    async request(request) {
      input.received?.push(request);
      const envelope = JsonRpcSuccessResponseEnvelopeSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        result,
      });
      request.onTerminalEnvelope(envelope);
      return envelope;
    },
    close: input.close ?? (async () => {}),
  };
}

const roots: string[] = [];
let scratch: string;
let home: AthleteHome;
let env: Record<string, string | undefined>;

const hasLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPERM") {
      process.stderr.write("SKIP_MARKER loopback-listen EPERM enduragent-entry\n");
    }
    resolve(false);
  });
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolve(true));
  });
});

beforeEach(async () => {
  scratch = await mkdtemp(join(await realpath(tmpdir()), "enduragent-entry-"));
  roots.push(scratch);
  home = {
    root: join(scratch, "athlete-home"),
    storeDir: join(scratch, "athlete-home", "store"),
    archiveDir: join(scratch, "athlete-home", "archive"),
    configDir: join(scratch, "athlete-home", "config"),
  };
  env = {
    HOME: join(scratch, "home"),
    ENDURAGENT_HOME: home.root,
    XDG_CONFIG_HOME: join(scratch, "xdg-config"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    TMPDIR: join(scratch, "tmp"),
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  await Promise.all([
    mkdir(env.HOME!, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME!, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME!, { recursive: true }),
    mkdir(env.TMPDIR!, { recursive: true }),
  ]);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("enduragent executable composition", () => {
  it("starts initial refresh through one authenticated control socket and closes it", async () => {
    expect(PROTOCOL_VERSION).toBe(33);
    const startInitialRefresh = vi.fn(async () => ({ status: "accepted" as const }));
    const close = vi.fn(async () => {});
    const openControl = vi.fn(async () => ({ startInitialRefresh, close }));

    await expect(
      startDesktopDaemonInitialRefresh(
        {
          url: "ws://127.0.0.1:45010/rpc",
          token: "x".repeat(43),
          owner: "app-supervised",
        },
        openControl as never,
      ),
    ).resolves.toEqual({ status: "accepted" });
    expect(openControl).toHaveBeenCalledWith({
      port: 45_010,
      token: "x".repeat(43),
      incumbentProtocolVersion: PROTOCOL_VERSION,
      expectedOwner: "app-supervised",
    });
    expect(startInitialRefresh).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("short-circuits version without resolving or composing", async () => {
    let homeCalls = 0;
    let runnerCalls = 0;
    const dependencies: EnduragentDependencies = {
      resolveAthleteHome: () => {
        homeCalls += 1;
        return home;
      },
      withLocalCoach: async () => {
        runnerCalls += 1;
        return { status: "not-configured", configPath: "unused" };
      },
      readPackageVersion: async () => "0.1.2",
    };
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["version"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        dependencies,
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe("enduragent 0.1.2\n");
    expect(io.stderr.read()).toBe("");
    expect(homeCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("short-circuits invalid usage without resolving or composing", async () => {
    let homeCalls = 0;
    let runnerCalls = 0;
    const dependencies: EnduragentDependencies = {
      resolveAthleteHome: () => {
        homeCalls += 1;
        return home;
      },
      withLocalCoach: async () => {
        runnerCalls += 1;
        return { status: "not-configured", configPath: "unused" };
      },
      readPackageVersion: async () => "unused",
    };
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["unknown"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        dependencies,
      ),
    ).resolves.toBe(EXIT_USAGE);
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("Usage: enduragent [version|serve|self-test]\n");
    expect(homeCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("runs self-test through the remote client before local composition", async () => {
    const preparedHome = Object.freeze({ ...home });
    const prepareAthleteHome = vi.fn(async () => preparedHome);
    const digest = "a".repeat(64);
    const selfTestResult = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: true,
      runtime: { node: "24.18.0", electron: "43.1.1", v8: "15.0" },
      resources: {
        algorithm: "sha256",
        matrixSha256: digest,
        insideAsarSha256: digest,
        extraResourcesSha256: digest,
        byteIdentical: true,
      },
      suites: {
        parity: { cases: 2, passed: 2 },
        differential: { cases: 3, passed: 3 },
      },
    } as const;
    const call = vi.fn(
      async (_method: string, _params: unknown, options?: CoachClientCallOptions<"selfTest">) => {
        for (const event of [
          { phase: "started", completed: 0, total: 1 },
          { phase: "completed", completed: 1, total: 1 },
        ] as const) {
          options?.onNotificationEnvelope?.({
            jsonrpc: "2.0",
            method: "coach.operationProgress",
            params: { requestId: 1, requestMethod: "selfTest", event },
          });
          options?.onEvent?.(event);
        }
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: selfTestResult });
        return selfTestResult;
      },
    );
    const close = vi.fn(async () => {});
    const connectSelfTestClient = vi.fn(async () => ({ call, close }) as unknown as CoachClient);
    const withLocalCoachDependency = vi.fn();
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["self-test"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome,
          withLocalCoach: withLocalCoachDependency,
          readPackageVersion: async () => "unused",
          connectSelfTestClient,
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    const lines = io.stdout.read().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(SelfTestCommandTerminalSchema.parse(JSON.parse(lines[0]!))).toEqual(selfTestResult);
    expect(io.stderr.read()).toBe("");
    expect(connectSelfTestClient).toHaveBeenCalledOnce();
    expect(connectSelfTestClient).toHaveBeenCalledWith(preparedHome, undefined);
    expect(prepareAthleteHome).toHaveBeenCalledWith(home);
    expect(call).toHaveBeenCalledWith("selfTest", {}, expect.any(Object));
    expect(close).toHaveBeenCalledOnce();
    expect(withLocalCoachDependency).not.toHaveBeenCalled();
  });

  it("explains desktop-owned home refusal before connecting the self-test client", async () => {
    await mkdir(home.configDir, { recursive: true });
    await writeFile(
      join(home.configDir, DESKTOP_OAUTH_OWNERSHIP_FILE),
      JSON.stringify({ schemaVersion: 1, owner: "desktop" }),
    );
    const connectSelfTestClient = vi.fn();
    const prepareAthleteHome = vi.fn(async () => home);
    const withLocalCoachDependency = vi.fn();
    const io = terminal();

    await expect(
      runEnduragent(
        {
          argv: ["self-test"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome,
          connectSelfTestClient,
          withLocalCoach: withLocalCoachDependency,
          readPackageVersion: async () => "0.0.1",
        },
      ),
    ).resolves.toBe(EXIT_AGENT_ERROR);
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe(
      "This home belongs to Enduragent desktop. Stop shared-home CLI processes and use a separate CLI home, then sign in there.\n",
    );
    expect(prepareAthleteHome).not.toHaveBeenCalled();
    expect(connectSelfTestClient).not.toHaveBeenCalled();
    expect(withLocalCoachDependency).not.toHaveBeenCalled();
  });

  it("renders readiness outcomes with unchanged exit codes", async () => {
    const configPath = join(home.configDir, "config.yaml");
    const rows: ReadonlyArray<{
      readonly result: LocalCoachRunResult<never>;
      readonly exitCode: 1 | 4;
      readonly stderr: string;
    }> = [
      {
        result: { status: "not-configured", configPath },
        exitCode: 4,
        stderr: `Enduragent is not configured. Provision ${configPath} with provider credentials, then run: enduragent\n`,
      },
      {
        result: { status: "unreadable" },
        exitCode: 1,
        stderr:
          "Enduragent cannot read the existing configuration. Check that config.yaml is a readable file, then retry.\n",
      },
      {
        result: { status: "malformed" },
        exitCode: 1,
        stderr:
          "Enduragent cannot use the existing configuration. Correct or replace config.yaml, then retry.\n",
      },
    ];

    for (const row of rows) {
      let captured: WithLocalCoachInput<unknown> | undefined;
      let operationCalls = 0;
      const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
        input: WithLocalCoachInput<T>,
      ): Promise<LocalCoachRunResult<T>> => {
        captured = input as unknown as WithLocalCoachInput<unknown>;
        return row.result as LocalCoachRunResult<T>;
      };
      const io = terminal(new PassThrough(), true);
      const result = await runEnduragent(
        {
          argv: [],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async <T>(
            input: WithLocalCoachInput<T>,
          ): Promise<LocalCoachRunResult<T>> => {
            const value = await runner(input);
            const originalOperation = input.operation;
            captured = {
              ...input,
              operation: async (lifecycle: LocalCoachLifecycle) => {
                operationCalls += 1;
                return originalOperation(lifecycle);
              },
            } as unknown as WithLocalCoachInput<unknown>;
            return value;
          },
          readPackageVersion: async () => "unused",
        },
      );
      expect(result).toBe(row.exitCode);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
      expect(operationCalls).toBe(0);
      expect(captured?.home).toEqual(home);
    }
  });

  it.each(["", "latest", " 2026.8.0", `1.0.0-${"a".repeat(65)}`])(
    "rejects an invalid app-supervised version before resolving the athlete home",
    async (appVersion) => {
      const io = terminal();
      const result = await runAppSupervisedEnduragent({
        env,
        terminal: io.value,
        signal: new AbortController().signal,
        appVersion,
      });

      expect(result).toEqual({ exitCode: EXIT_AGENT_ERROR });
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe("Enduragent could not start.\n");
    },
  );

  it.each([
    ["not-configured", 4],
    ["unreadable", 1],
    ["malformed", 1],
  ] as const)(
    "returns a safe typed app-supervised %s outcome while keeping the ordinary exit code",
    async (status, exitCode) => {
      const io = terminal();
      const preparedHome = Object.freeze({ ...home });
      const prepareAthleteHome = vi.fn(async () => preparedHome);
      let withLocalCoachCalls = 0;
      const withLocalCoachDependency: EnduragentDependencies["withLocalCoach"] = async <T>(
        input: WithLocalCoachInput<T>,
      ): Promise<LocalCoachRunResult<T>> => {
        withLocalCoachCalls += 1;
        expect(input.home).toBe(preparedHome);
        return status === "not-configured" ? { status, configPath: privateConfigPath } : { status };
      };
      const privateConfigPath = join(home.configDir, "synthetic-private-profile-token");
      const readPackageVersion = vi.fn(async () => "0.1.0-internal");
      const result = await runAppSupervisedEnduragent(
        {
          env,
          terminal: io.value,
          signal: new AbortController().signal,
          appVersion: "2026.8.0",
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome,
          withLocalCoach: withLocalCoachDependency,
          readPackageVersion,
        },
      );

      expect(result).toEqual({ exitCode, readinessFailure: status });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-profile-token");
      expect(Object.keys(result).sort()).toEqual(["exitCode", "readinessFailure"]);
      expect(prepareAthleteHome).toHaveBeenCalledWith(home);
      expect(withLocalCoachCalls).toBe(1);
      expect(readPackageVersion).not.toHaveBeenCalled();
    },
  );

  it("returns a Windows app-supervised writer race to Electron without launching a successor", async () => {
    const io = terminal();
    const contention = new CoachStoreWriterError("writer-lock-held", null, undefined, {
      kind: "holder",
      pid: 42,
      port: 43_101,
    });
    const resolveSecondStarter = vi.fn(
      async () =>
        ({
          status: "refuse",
          exitCode: 3,
          stdout: "",
          stderr: "",
        }) as const,
    );
    const createLaunchdServiceIdentity = vi.fn(() => {
      throw new Error("launchd identity must not be constructed");
    });
    const readServiceStatus = vi.fn(async () => {
      throw new Error("launchd status must not be observed");
    });
    const serviceRegistrationState = vi.fn(async () => "present" as const);
    const startEphemeralSuccessor = vi.fn(async () => {});

    await expect(
      runAppSupervisedEnduragent(
        {
          env,
          terminal: io.value,
          signal: new AbortController().signal,
          appVersion: "2026.8.0",
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome: async (selectedHome) => selectedHome,
          withLocalCoach: async () => {
            throw contention;
          },
          readPackageVersion: async () => "unused",
          platform: "win32",
          resolveSecondStarter,
          createLaunchdServiceIdentity,
          readServiceStatus,
          serviceRegistrationState,
          startEphemeralSuccessor,
        },
      ),
    ).resolves.toEqual({ exitCode: EXIT_SUCCESS });
    expect(resolveSecondStarter).not.toHaveBeenCalled();
    expect(createLaunchdServiceIdentity).not.toHaveBeenCalled();
    expect(readServiceStatus).not.toHaveBeenCalled();
    expect(serviceRegistrationState).not.toHaveBeenCalled();
    expect(startEphemeralSuccessor).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("");
  });

  it("preserves FIFO and lifecycle close ordering after physical EOF", async () => {
    const trace: string[] = [];
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    const mocked = mockEngine(async ({ message }) => {
      trace.push(`${message}-chat-start`);
      const response = await (message === "first" ? first.promise : second.promise);
      trace.push(`${message}-chat-end`);
      return response;
    });
    const lifecycle = {
      home,
      engine: mocked.engine,
      operations,
      spendMeter,
      confirmations,
      listener: inertWriterProtocolListener,
      async startInitialRefresh() {},
      close: async () => {
        trace.push("lifecycle-close");
      },
    };
    const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
      input: WithLocalCoachInput<T>,
    ): Promise<LocalCoachRunResult<T>> => {
      try {
        const value = await input.operation(lifecycle);
        trace.push("repl-return");
        return { status: "completed", value };
      } finally {
        await lifecycle.close();
        trace.push("store-close", "writer-release");
      }
    };
    const io = terminal();
    io.input.once("end", () => trace.push("input-eof"));
    io.input.end("first\nsecond\n");
    const result = runEnduragent(
      {
        argv: [],
        env,
        terminal: io.value,
        signal: new AbortController().signal,
      },
      {
        resolveAthleteHome: () => home,
        withLocalCoach: runner,
        readPackageVersion: async () => "unused",
      },
    );
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    first.resolve({ text: "first-response" });
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(2));
    second.resolve({ text: "second-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe("first-response\nsecond-response\n");
    for (const [earlier, later] of [
      ["first-chat-start", "first-chat-end"],
      ["first-chat-end", "second-chat-start"],
      ["second-chat-start", "second-chat-end"],
      ["second-chat-end", "repl-return"],
      ["repl-return", "lifecycle-close"],
      ["lifecycle-close", "store-close"],
      ["store-close", "writer-release"],
      ["input-eof", "repl-return"],
    ] as const) {
      expect(trace.indexOf(earlier)).toBeLessThan(trace.indexOf(later));
    }
  });

  it("routes serve through one local runner", async () => {
    const controller = new AbortController();
    controller.abort();
    const mocked = mockEngine();
    let captured: WithLocalCoachInput<unknown> | undefined;
    let packageReads = 0;
    const preparedHome = Object.freeze({ ...home });
    const prepareAthleteHome = vi.fn(async () => preparedHome);
    const io = terminal(new PassThrough(), true);
    await expect(
      runEnduragent(
        {
          argv: ["serve"],
          env,
          terminal: io.value,
          signal: controller.signal,
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome,
          readPackageVersion: async () => {
            packageReads += 1;
            return "0.1.0-synthetic";
          },
          withLocalCoach: async <T>(input: WithLocalCoachInput<T>) => {
            captured = input as unknown as WithLocalCoachInput<unknown>;
            const value = await input.operation({
              home,
              engine: mocked.engine,
              operations,
              spendMeter,
              confirmations,
              listener: inertWriterProtocolListener,
              async startInitialRefresh() {},
              async close() {},
            });
            return { status: "completed", value };
          },
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(packageReads).toBe(1);
    expect(captured).toMatchObject({
      env,
      home: preparedHome,
      deferInitialRefresh: true,
    });
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("");
    expect(prepareAthleteHome).toHaveBeenCalledWith(home);
  });

  it.each([{ argv: [] as readonly string[] }, { argv: ["serve"] as readonly string[] }])(
    "maps the exact typed newer-store cause to exit 5 for $argv",
    async ({ argv }) => {
      const newer = new StoreNewerThanAppError(3, 2);
      const failure = new CoachStoreWriterError("writer-failed", "run migrations", {
        cause: newer,
      });
      const io = terminal();
      await expect(
        runEnduragent(
          {
            argv,
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            withLocalCoach: async () => {
              throw failure;
            },
            readPackageVersion: async () => "0.1.0-synthetic",
          },
        ),
      ).resolves.toBe(EXIT_VERSION_MISMATCH);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(
        "Enduragent cannot start: this athlete store was created by a newer app version. Update Enduragent and retry.\n",
      );
    },
  );

  it.runIf(hasLoopback)(
    "preserves a real newer store and releases the writer after serve exits 5",
    async () => {
      await mkdir(home.storeDir, { recursive: true, mode: 0o700 });
      const databasePath = join(home.storeDir, "store.db");
      const maximum = MIGRATIONS.at(-1)!.version;
      const seed = openSqliteStorage(databasePath);
      await seed.setUserVersion(maximum + 1);
      await seed.close();
      const beforeNames = (await readdir(home.storeDir)).sort();
      const beforeHash = createHash("sha256")
        .update(await readFile(databasePath))
        .digest("hex");
      const io = terminal();

      await expect(
        runEnduragent(
          {
            argv: ["serve"],
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            readPackageVersion: async () => "0.1.0-synthetic",
            withLocalCoach: async <T>(): Promise<LocalCoachRunResult<T>> => {
              await withCoachStoreWriter(env, async () => {
                throw new Error("operation must not run for a newer store");
              });
              throw new Error("newer store unexpectedly opened");
            },
          },
        ),
      ).resolves.toBe(EXIT_VERSION_MISMATCH);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(
        "Enduragent cannot start: this athlete store was created by a newer app version. Update Enduragent and retry.\n",
      );
      expect((await readdir(home.storeDir)).sort()).toEqual(beforeNames);
      expect(
        createHash("sha256")
          .update(await readFile(databasePath))
          .digest("hex"),
      ).toBe(beforeHash);
      await expect(readFile(join(home.configDir, PORT_FILE_NAME), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(home.configDir, "store-writer.lock"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(home.configDir, "daemon.token"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("uses typed writer errors and redacts every other startup failure", async () => {
    const holder = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private holder detail",
      code: "writer-lock-held" as const,
      stage: null,
      contention: { kind: "holder" as const, pid: null, port: 43100 },
    }) as CoachStoreWriterError;
    const foreignPortFile = join(home.configDir, "store-writer.port");
    const foreign = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private foreign detail",
      code: "writer-lock-held" as const,
      stage: null,
      contention: { kind: "foreign" as const, port: 43101, portFile: foreignPortFile },
    }) as CoachStoreWriterError;
    const failed = Object.assign(Object.create(CoachStoreWriterError.prototype), {
      name: "CoachStoreWriterError",
      message: "private writer detail",
      code: "writer-failed" as const,
      stage: "open store" as const,
      contention: null,
    }) as CoachStoreWriterError;
    const rows = [
      {
        error: holder,
        exitCode: EXIT_DAEMON_UNAVAILABLE,
        stderr:
          "Enduragent cannot start: another writer holds this athlete home (pid unknown, port 43100). Stop it or wait, then retry.\n",
      },
      {
        error: foreign,
        exitCode: EXIT_DAEMON_UNAVAILABLE,
        stderr: `Enduragent cannot start: 127.0.0.1:43101 is held by a foreign process; change or remove the port file at ${foreignPortFile}, then retry.\n`,
      },
      {
        error: failed,
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start.\n",
      },
      {
        error: new Error("private unrelated detail"),
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start.\n",
      },
    ];

    for (const row of rows) {
      const io = terminal();
      const result = await runEnduragent(
        {
          argv: [],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async <T>(
            input: WithLocalCoachInput<T>,
          ): Promise<LocalCoachRunResult<T>> => {
            void input;
            throw row.error;
          },
          readPackageVersion: async () => "unused",
        },
      );
      expect(result).toBe(row.exitCode);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
    }
  });

  it("reports real contention and drains an in-flight turn before release", async () => {
    if (hasLoopback) {
      const writerAcquired = deferred<void>();
      const releaseWriter = deferred<void>();
      const holdingWriter = withCoachStoreWriter(env, async () => {
        writerAcquired.resolve(undefined);
        await releaseWriter.promise;
      });
      await Promise.race([
        writerAcquired.promise,
        holdingWriter.then(() => Promise.reject(new Error("writer ended early"))),
      ]);
      try {
        const port = Number.parseInt(
          await readFile(join(home.configDir, PORT_FILE_NAME), "utf8"),
          10,
        );
        const io = terminal();
        await expect(
          runEnduragent(
            {
              argv: [],
              env,
              terminal: io.value,
              signal: new AbortController().signal,
            },
            {
              resolveAthleteHome: () => home,
              withLocalCoach,
              readPackageVersion: async () => "unused",
            },
          ),
        ).resolves.toBe(EXIT_DAEMON_UNAVAILABLE);
        expect(io.stdout.read()).toBe("");
        expect(io.stderr.read()).toBe(
          `Enduragent cannot start: another writer holds this athlete home (pid ${process.pid}, port ${port}). Stop it or wait, then retry.\n`,
        );
      } finally {
        releaseWriter.resolve(undefined);
        await holdingWriter;
      }
    }

    const trace: string[] = [];
    const response = deferred<{ text: string }>();
    const mocked = mockEngine(async () => {
      trace.push("turn-start");
      const value = await response.promise;
      trace.push("turn-end");
      return value;
    });
    const controller = new AbortController();
    const io = terminal();
    const runner: EnduragentDependencies["withLocalCoach"] = async <T>(
      input: WithLocalCoachInput<T>,
    ): Promise<LocalCoachRunResult<T>> => {
      const lifecycle = {
        home,
        engine: mocked.engine,
        operations,
        spendMeter,
        confirmations,
        listener: inertWriterProtocolListener,
        async startInitialRefresh() {},
        close: async () => {
          trace.push("lifecycle-close");
        },
      };
      try {
        const value = await input.operation(lifecycle);
        trace.push("repl-return");
        return { status: "completed", value };
      } finally {
        await lifecycle.close();
        trace.push("store-close", "writer-release");
      }
    };
    const result = runEnduragent(
      {
        argv: [],
        env,
        terminal: io.value,
        signal: controller.signal,
      },
      {
        resolveAthleteHome: () => home,
        withLocalCoach: runner,
        readPackageVersion: async () => "unused",
      },
    );
    io.input.write("turn\n");
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    controller.abort();
    response.resolve({ text: "turn-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    for (const [earlier, later] of [
      ["turn-start", "turn-end"],
      ["turn-end", "repl-return"],
      ["repl-return", "lifecycle-close"],
      ["lifecycle-close", "store-close"],
      ["store-close", "writer-release"],
    ] as const) {
      expect(trace.indexOf(earlier)).toBeLessThan(trace.indexOf(later));
    }
  });

  it("runs a remote-default verb without registration or spawn work on a warm daemon", async () => {
    const preparedHome = Object.freeze({ ...home });
    const prepareAthleteHome = vi.fn(async () => preparedHome);
    const received: CoachVerbRequest[] = [];
    const connectRemoteTransport = vi.fn(async () =>
      remoteTransport({ text: "remote" }, { received }),
    );
    const serviceRegistrationState = vi.fn(async () => "absent" as const);
    const startEphemeralDaemon = vi.fn();
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["ask", "hello", "--json", "--session", "RaceA"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          prepareAthleteHome,
          withLocalCoach: async () => {
            throw new Error("local runner must not be used");
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport,
          serviceRegistrationState,
          startEphemeralDaemon,
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(received).toHaveLength(1);
    expect(connectRemoteTransport).toHaveBeenCalledWith(preparedHome);
    expect(prepareAthleteHome).toHaveBeenCalledWith(home);
    expect(received[0]).toMatchObject({
      method: "chat",
      params: { chatId: "cli:RaceA", message: "hello" },
    });
    expect(serviceRegistrationState).not.toHaveBeenCalled();
    expect(startEphemeralDaemon).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe('{"text":"remote"}\n');
    expect(io.stderr.read()).toBe("");
  });

  it("runs local state through one lifecycle and never connects remotely", async () => {
    const mocked = mockEngine();
    const connectRemoteTransport = vi.fn();
    let localCalls = 0;
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["state", "--json", "--local"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async <T>(input: WithLocalCoachInput<T>) => {
            localCalls += 1;
            return {
              status: "completed",
              value: await input.operation({
                home,
                engine: mocked.engine,
                operations,
                spendMeter,
                confirmations,
                listener: inertWriterProtocolListener,
                async startInitialRefresh() {},
                async close() {},
              }),
            };
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport,
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(localCalls).toBe(1);
    expect(connectRemoteTransport).not.toHaveBeenCalled();
    expect(mocked.chat).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe(`${JSON.stringify(state)}\n`);
    expect(io.stderr.read()).toBe("");
  });

  it("falls through from a held local writer only to an authenticated remote transport", async () => {
    const contention = new CoachStoreWriterError("writer-lock-held", null, undefined, {
      kind: "holder",
      pid: 41,
      port: 43_101,
    });
    const received: CoachVerbRequest[] = [];
    const connectRemoteTransport = vi.fn(async () =>
      remoteTransport({ text: "attached" }, { received }),
    );
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["plan", "week", "--local"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw contention;
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport,
          startEphemeralDaemon: vi.fn(),
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(connectRemoteTransport).toHaveBeenCalledTimes(1);
    expect(received[0]).toMatchObject({
      method: "chat",
      params: { chatId: "cli:default", message: "/plan" },
    });
    expect(io.stdout.read()).toBe("attached\n");
    expect(io.stderr.read()).toBe("");
  });

  it("preserves contention diagnostics when local fall-through cannot authenticate", async () => {
    const rows = [
      {
        contention: { kind: "holder" as const, pid: null, port: 43_102 },
        stderr:
          "Enduragent cannot start: another writer holds this athlete home (pid unknown, port 43102). Stop it or wait, then retry.\n",
      },
      {
        contention: {
          kind: "foreign" as const,
          port: 43_103,
          portFile: join(home.configDir, "store-writer.port"),
        },
        stderr: `Enduragent cannot start: 127.0.0.1:43103 is held by a foreign process; change or remove the port file at ${join(home.configDir, "store-writer.port")}, then retry.\n`,
      },
    ];
    for (const row of rows) {
      const failure = new CoachStoreWriterError(
        "writer-lock-held",
        null,
        undefined,
        row.contention,
      );
      const io = terminal();
      await expect(
        runEnduragent(
          {
            argv: ["ask", "hello", "--local"],
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: () => home,
            withLocalCoach: async () => {
              throw failure;
            },
            readPackageVersion: async () => "unused",
            connectRemoteTransport: async () => {
              throw new CoachRemoteError({ kind: "unavailable" });
            },
          },
        ),
      ).resolves.toBe(EXIT_DAEMON_UNAVAILABLE);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
    }
  });

  it("maps a local fall-through version mismatch to exit 5", async () => {
    const failure = new CoachStoreWriterError("writer-lock-held", null, undefined, {
      kind: "holder",
      pid: 41,
      port: 43_104,
    });
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["ask", "hello", "--local"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw failure;
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport: async () => {
            throw new CoachRemoteError({
              kind: "version-mismatch",
              direction: "client-newer",
            });
          },
        },
      ),
    ).resolves.toBe(EXIT_VERSION_MISMATCH);
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe(
      "Enduragent protocol versions do not match; update this client.\n",
    );
  });

  it("fails closed on unknown registration and never starts a daemon", async () => {
    const startEphemeralDaemon = vi.fn();
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["state", "--json"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw new Error("local runner must not be used");
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport: async () => {
            throw new CoachRemoteError({ kind: "unavailable" });
          },
          serviceRegistrationState: async () => "unknown",
          startEphemeralDaemon,
        },
      ),
    ).resolves.toBe(EXIT_DAEMON_UNAVAILABLE);
    expect(startEphemeralDaemon).not.toHaveBeenCalled();
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe("Enduragent could not reach the local service.\n");
  });

  it("keeps one close owner and maps a close-only failure after success", async () => {
    const close = vi.fn(async () => {
      throw new Error("private close cause");
    });
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["ask", "hello"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw new Error("local runner must not be used");
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport: async () => remoteTransport({ text: "answer" }, { close }),
        },
      ),
    ).resolves.toBe(EXIT_AGENT_ERROR);
    expect(close).toHaveBeenCalledTimes(1);
    expect(io.stdout.read()).toBe("answer\n");
    expect(io.stderr.read()).toBe("Enduragent could not close the command transport.\n");
  });

  it("keeps a primary command failure when close also fails", async () => {
    const close = vi.fn(async () => {
      throw new Error("private close cause");
    });
    const io = terminal();
    await expect(
      runEnduragent(
        {
          argv: ["ask", "hello", "--stream-json"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw new Error("local runner must not be used");
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport: async () => ({
            kind: "remote",
            async request(request) {
              const envelope = {
                jsonrpc: "2.0" as const,
                id: 1,
                error: { code: -32603, message: "Internal error" },
              };
              request.onTerminalEnvelope(envelope);
              return envelope;
            },
            close,
          }),
        },
      ),
    ).resolves.toBe(EXIT_AGENT_ERROR);
    expect(close).toHaveBeenCalledTimes(1);
    expect(io.stdout.read()).toBe(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error"}}\n',
    );
    expect(io.stderr.read()).toBe("Enduragent could not complete this command.\n");
  });

  it("maps invalid named and fresh sessions before resolving the athlete home", async () => {
    const rows = [
      {
        argv: ["ask", "hello", "--session", "a:b"],
        createFreshId: undefined,
        exitCode: EXIT_USAGE,
        stderr:
          "Usage: enduragent <ask|state|analyze|import|plan week|sync|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]\n",
      },
      {
        argv: ["ask", "hello", "--fresh"],
        createFreshId: () => {
          throw new Error("private UUID cause");
        },
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start a chat session.\n",
      },
      {
        argv: ["ask", "hello", "--fresh"],
        createFreshId: () => "invalid",
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not start a chat session.\n",
      },
    ];
    for (const row of rows) {
      const resolveHome = vi.fn(() => home);
      const connectRemoteTransport = vi.fn();
      const io = terminal();
      await expect(
        runEnduragent(
          {
            argv: row.argv,
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: resolveHome,
            withLocalCoach: async () => {
              throw new Error("local runner must not be used");
            },
            readPackageVersion: async () => "unused",
            connectRemoteTransport,
            createFreshId: row.createFreshId,
          },
        ),
      ).resolves.toBe(row.exitCode);
      expect(resolveHome).not.toHaveBeenCalled();
      expect(connectRemoteTransport).not.toHaveBeenCalled();
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
    }
  });

  it("reads split UTF-8 stdin before transport and strips one terminal newline", async () => {
    const input = new PassThrough();
    const received: CoachVerbRequest[] = [];
    const io = terminal(input, true);
    input.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));
    input.end(Buffer.from([0xa9, 0x0d, 0x0a]));
    await expect(
      runEnduragent(
        {
          argv: ["ask", "-"],
          env,
          terminal: io.value,
          signal: new AbortController().signal,
        },
        {
          resolveAthleteHome: () => home,
          withLocalCoach: async () => {
            throw new Error("local runner must not be used");
          },
          readPackageVersion: async () => "unused",
          connectRemoteTransport: async () => remoteTransport({ text: "ok" }, { received }),
        },
      ),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(received[0]).toMatchObject({ params: { message: "café" } });
    expect(io.stdout.read()).toBe("ok\n");
  });

  it("rejects TTY-empty, malformed, NUL, blank, and string stdin before transport", async () => {
    const inputs: Array<{
      readonly argv: readonly string[];
      readonly input: PassThrough;
      readonly isTTY: boolean;
    }> = [];
    const tty = new PassThrough();
    inputs.push({ argv: ["ask"], input: tty, isTTY: true });
    const malformed = new PassThrough();
    malformed.end(Buffer.from([0xc3, 0x28]));
    inputs.push({ argv: ["ask", "-"], input: malformed, isTTY: true });
    const nul = new PassThrough();
    nul.end(Buffer.from("bad\0text"));
    inputs.push({ argv: ["ask", "-"], input: nul, isTTY: true });
    const blank = new PassThrough();
    blank.end(Buffer.from(" \r\n"));
    inputs.push({ argv: ["ask", "-"], input: blank, isTTY: true });
    const strings = new PassThrough();
    strings.setEncoding("utf8");
    strings.end("text");
    inputs.push({ argv: ["ask", "-"], input: strings, isTTY: true });
    for (const row of inputs) {
      const io = terminal(row.input, row.isTTY);
      const connectRemoteTransport = vi.fn();
      const resolveHome = vi.fn(() => home);
      await expect(
        runEnduragent(
          {
            argv: row.argv,
            env,
            terminal: io.value,
            signal: new AbortController().signal,
          },
          {
            resolveAthleteHome: resolveHome,
            withLocalCoach: async () => {
              throw new Error("local runner must not be used");
            },
            readPackageVersion: async () => "unused",
            connectRemoteTransport,
          },
        ),
      ).resolves.toBe(EXIT_USAGE);
      expect(resolveHome).not.toHaveBeenCalled();
      expect(connectRemoteTransport).not.toHaveBeenCalled();
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(
        "Usage: enduragent <ask|state|analyze|import|plan week|sync|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]\n",
      );
    }
  });
});
