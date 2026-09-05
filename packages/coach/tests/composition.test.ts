import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  EMPTY_DROPPED_ACTIVITIES,
  type AthleteState,
  type CoachEngine,
} from "@enduragent/coach-contract";
import {
  RefreshTokenReusedError,
  engineConfigFromConfig,
  loadConfig,
  loadStoredProfileSnapshot,
  saveStoredProfile,
  type Config,
  type OAuthCredentialOwner,
} from "@enduragent/core";
import type {
  AthleteDataReaderPort,
  CreateCoachEngineInput,
  ModelTransportDecorator,
} from "@enduragent/engine";
import { LATEST_SCHEMA_VERSION } from "@enduragent/kernel/reference/schemas";
import { createPhysicalRequestLedger, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { SCHEDULER_SCHEMA_VERSION } from "@enduragent/kernel/reference/schemas";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanIntakeRepository, createPlanRepository } from "@enduragent/kernel/planning";
import {
  createLocalCoachComposition,
  type LocalCoachCompositionDependencies,
  type LocalReferenceRuntime,
  type LocalStoreRuntime,
  type LocalStoreRuntimeOptions,
} from "../src/composition.js";
import { RuntimeAthleteOwnerRefusal } from "../src/backfill.js";
import { readIntervalsStoreOwnerState } from "../src/account-identity.js";
import { INTERVALS_CREDENTIAL_APPROVAL_TTL_MS } from "../src/intervals-credential-approval.js";
import { checkHomeReadiness } from "../src/readiness.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const roots: string[] = [];
const stores: CoachStoreWriterContext["store"][] = [];

const state: AthleteState = {
  schemaVersion: LATEST_SCHEMA_VERSION,
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: true,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: { name: "Synthetic Athlete" },
  currentStatus: { summary: "current" },
  derivedMetrics: { eftp: 260, future_metric: 1 },
  derivedMetricsMeta: {
    sportFamily: "cycling",
    prescriptionBasis: "power",
    anchorType: "ftp",
    analysisBasis: "power",
  },
  recentActivities: [{ id: "activity-1" }],
  plannedWorkouts: [{ id: "workout-1" }],
  wellness: { restingHr: 45 },
  trainingContext: {
    performanceProgress: { kind: "unavailable", reason: "not-synced" },
    recentRides: { kind: "unknown", reason: "no-recent-rides" },
    trainingHistory: { kind: "unavailable", reason: "not-synced" },
    anchorZones: { kind: "unknown", reason: "missing-anchor" },
    cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
    plan: { kind: "unknown", reason: "no-plan" },
    adherence: { kind: "unknown", reason: "insufficient-data" },
    wellnessTrend: { kind: "unknown", reason: "no-wellness" },
  },
};

function latest() {
  return {
    metadata: {
      schema_version: LATEST_SCHEMA_VERSION,
      last_updated: state.lastUpdated,
      freshness: state.freshness,
    },
    athlete_profile: state.athleteProfile,
    current_status: state.currentStatus,
    derived_metrics: state.derivedMetrics,
    derived_metrics_meta: state.derivedMetricsMeta,
    recent_activities: state.recentActivities,
    planned_workouts: state.plannedWorkouts,
    wellness_data: state.wellness,
  };
}

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-composition-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await writeFile(join(root, "data", "latest.json"), JSON.stringify(latest()));
  await writeFile(
    join(root, "data", ".scheduler.json"),
    JSON.stringify({
      schema_version: SCHEDULER_SCHEMA_VERSION,
      last_sync_at: state.lastSynced,
      next_sync_at: "2026-07-18T01:00:00.000Z",
    }),
  );
  await writeFile(
    join(root, "data", "error_state.json"),
    JSON.stringify({
      schema_version: "1",
      step: "synthetic",
      detail: "synthetic outage",
      ts: "2026-07-18T01:00:00.000Z",
      mitigation: "block_coaching",
    }),
  );
  return home;
}

function config(
  home: AthleteHome,
  intervals: Config["intervals"] = { apiKey: "", athleteId: "synthetic" },
): Config {
  return {
    dataSource: "store",
    llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
    intervals,
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1000,
    dataDir: home.root,
  };
}

function intervalsAccountFingerprint(account: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["store-owner-v1", account]))
    .digest("hex");
}

function athleteData(): AthleteDataReaderPort {
  return {
    async getAthlete() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async listWellness() {
      return { ok: true, value: [] };
    },
    async listActivities() {
      return { ok: true, value: [] };
    },
    async getActivity() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async getStreams() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async listCalendar() {
      return { ok: true, value: [] };
    },
    freshness() {
      return undefined;
    },
  };
}

function reference(trace: string[] = []): LocalReferenceRuntime {
  return {
    scheduler: {
      stop: () => {
        trace.push("reference-stop");
      },
    },
    async runScheduledOnce() {
      return { kind: "skipped", reason: "cooldown" };
    },
  };
}

function runtime(
  trace: string[] = [],
  options: {
    runWindow?: () => Promise<{
      published: boolean;
      counts: ReturnType<ReturnType<typeof createPhysicalRequestLedger>["snapshot"]>;
      legacySucceeded: boolean;
      droppedActivities?: typeof EMPTY_DROPPED_ACTIVITIES;
    }>;
    close?: () => Promise<void>;
  } = {},
): LocalStoreRuntime {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const runWindow =
    options.runWindow ??
    (async () => {
      trace.push("run-window");
      return { published: true, counts: ledger.snapshot(), legacySucceeded: true };
    });
  let admission = Promise.resolve();
  const runExclusive: LocalStoreRuntime["runExclusive"] = (work) => {
    const run = () => work(new AbortController().signal);
    const task = admission.then(run, run);
    admission = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  return {
    athleteData: athleteData(),
    currentDroppedActivities: () => EMPTY_DROPPED_ACTIVITIES,
    attemptLedgerForRun: () => ledger,
    runWindow: async () => ({
      ...(await runWindow()),
      droppedActivities: EMPTY_DROPPED_ACTIVITIES,
    }),
    async runWindowAfter(work) {
      await work(new AbortController().signal);
      return { ...(await runWindow()), droppedActivities: EMPTY_DROPPED_ACTIVITIES };
    },
    runExclusive,
    async runActivityWrite(work) {
      return {
        value: await runExclusive(work),
        activityReadAvailable: true,
      };
    },
    startScheduler() {
      trace.push("start-scheduler");
    },
    close:
      options.close ??
      (async () => {
        trace.push("runtime-close");
      }),
  };
}

function backend(overrides: Partial<CoachEngine> = {}): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => {
      throw new Error("not implemented");
    },
    skipCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resumeCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
    ...overrides,
  };
}

function missingResolver(): CyclingFtpAnchorResolver {
  return { resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }) };
}

function fakeContext(home: AthleteHome): CoachStoreWriterContext {
  return {
    home,
    listener: inertWriterProtocolListener,
    store: {
      async exec() {},
      async run() {},
      async get() {
        return undefined;
      },
      async all() {
        return [];
      },
      async close() {},
      async getUserVersion() {
        return 0;
      },
      async setUserVersion() {},
      async transaction<T>(operation: () => Promise<T>) {
        return operation();
      },
    },
  };
}

async function intervalsApprovalFixture(
  now: () => number,
  options: {
    athleteId?: string;
    env?: Record<string, string | undefined>;
    legacyData?: boolean;
    ownerAccount?: string;
    responseForPath?: (path: string) => Response | Promise<Response>;
  } = {},
) {
  const home = await freshHome();
  await mkdir(home.storeDir, { recursive: true });
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  stores.push(store);
  await runMigrations(store, MIGRATIONS);
  if (options.ownerAccount !== undefined) {
    await store.run("INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)", [
      intervalsAccountFingerprint(options.ownerAccount),
    ]);
  }
  if (options.legacyData === true) {
    await store.run(
      "INSERT INTO source_watermark (source, lane, watermark) VALUES ('intervals-icu', 'activities', 'synthetic-legacy-watermark')",
    );
  }
  const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (options.responseForPath !== undefined) return options.responseForPath(url.pathname);
    if (url.pathname !== "/api/v1/athlete/0") throw new Error("unexpected request");
    return new Response(
      JSON.stringify({
        sportSettings: [
          {
            id: 1,
            athlete_id: "synthetic-approved-owner",
            types: ["Ride"],
            updated: "2026-01-01",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const ownerGuard = vi.fn(async () => {});
  const lifecycle = await compose(
    home,
    {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      assertRuntimeAthleteOwner: ownerGuard,
      now,
    },
    { home, store, listener: inertWriterProtocolListener },
    { apiKey: "", athleteId: options.athleteId ?? "" },
    undefined,
    { ENDURAGENT_HOME: home.root, ...options.env },
  );
  return { home, store, lifecycle, ownerGuard, fetchStub };
}

async function compose(
  home: AthleteHome,
  dependencies: LocalCoachCompositionDependencies,
  context = fakeContext(home),
  intervals?: Config["intervals"],
  configOverride?: Config,
  env: Record<string, string | undefined> = { ENDURAGENT_HOME: home.root },
  deferInitialRefresh?: boolean,
  oauthOwner?: OAuthCredentialOwner,
) {
  const coreConfig = configOverride ?? config(home, intervals);
  return createLocalCoachComposition(
    {
      env,
      home,
      context,
      config: coreConfig,
      ...(oauthOwner === undefined ? {} : { oauthOwner }),
      engineConfig: engineConfigFromConfig(coreConfig),
      ...(deferInitialRefresh === undefined ? {} : { deferInitialRefresh }),
    },
    {
      assertRuntimeAthleteOwner: async () => {},
      ...dependencies,
    },
  );
}

function generation(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

function codexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

function tokenResponse(access: string, refresh = "synthetic-rotated-refresh"): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    { status: 200 },
  );
}

function codexTextResponse(text: string): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: { type: "message", content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: {
        id: "synthetic-response",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function writeExpiredOAuthProfile(home: AthleteHome): Promise<void> {
  await writeFile(
    join(home.configDir, "auth-profiles.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "synthetic-expired-access",
        refresh: "synthetic-refresh",
        expires: 0,
        accountId: "synthetic-account",
      },
    }),
    { mode: 0o600 },
  );
}

async function composeWithCapturedEngineInput(home: AthleteHome, now = 1_000) {
  let engineInput: CreateCoachEngineInput | undefined;
  const lifecycle = await compose(home, {
    bootstrap: async () => reference(),
    createRuntime: () => runtime(),
    createBackend: (input) => {
      engineInput = input;
      return backend();
    },
    createRepository: () => ({
      insertIfAbsent: async () => false,
      readCurrent: async () => undefined,
    }),
    createResolver: () => missingResolver(),
    now: () => now,
  });
  if (engineInput === undefined) throw new Error("Expected a captured engine input.");
  return { engineInput, lifecycle };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("local coach composition", () => {
  it("uses trusted channel identity to require Telegram confirmation without changing Desktop execution", async () => {
    const home = await freshHome();
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);
    const policy = engineInput.ports.toolConfirmations;

    expect(policy).toBeDefined();
    expect(policy!.requiresConfirmation({ chatId: "telegram:73", toolName: "plan_save" })).toBe(
      true,
    );
    expect(policy!.requiresConfirmation({ chatId: "desktop", toolName: "plan_save" })).toBe(false);
    expect(policy!.requiresConfirmation({ chatId: "cli", toolName: "plan_save" })).toBe(false);
    expect(policy!.requiresConfirmation({ chatId: "cli:default", toolName: "plan_save" })).toBe(
      false,
    );
    expect(
      policy!.requiresConfirmation({ chatId: "cli:fresh:synthetic", toolName: "plan_save" }),
    ).toBe(false);
    expect(policy!.requiresConfirmation({ chatId: "unknown", toolName: "plan_save" })).toBe(true);
    expect(lifecycle.confirmations.peek("telegram:73")).toBeUndefined();

    await lifecycle.close();
  });

  it("composes guarded workout updates with the confirmation policy", async () => {
    const home = await freshHome();
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    expect(engineInput.ports.platform.calendarMutations.updateEvent).toBeTypeOf("function");
    expect(
      engineInput.ports.toolConfirmations!.gatedToolNames.has("intervals_update_workout"),
    ).toBe(true);

    await lifecycle.close();
  });

  it("invalidates executable confirmation closures when the runtime bundle is replaced", async () => {
    const home = await freshHome();
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);
    const run = vi.fn(async () => ({ saved: true }));

    await engineInput.ports.toolConfirmations!.propose({
      chatId: "telegram:73",
      toolName: "plan_save",
      toolInput: { plan: { name: "Build" } },
      run,
    });
    const pending = lifecycle.confirmations.peek("telegram:73");
    expect(pending).toBeDefined();

    const replacement = lifecycle.operations.configureRuntime({
      llm: { model: "replacement-model", api_key: "obviously-fake-replacement-key" },
    });
    await vi.waitFor(() => expect(lifecycle.confirmations.peek("telegram:73")).toBeUndefined());
    expect(lifecycle.confirmations.cancel("telegram:73", pending!.nonce)).toBe("none");
    await replacement;

    await expect(lifecycle.confirmations.confirm("telegram:73", pending!.nonce)).resolves.toEqual({
      status: "none",
    });
    expect(run).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("rejects configured data directories outside the selected athlete home", async () => {
    const home = await freshHome();
    const otherHome = await freshHome();
    const dependencies: LocalCoachCompositionDependencies = {};

    for (const dataDir of ["", "relative", home.configDir, otherHome.root]) {
      await expect(
        compose(home, dependencies, fakeContext(home), undefined, {
          ...config(home),
          dataDir,
        }),
      ).rejects.toThrowError(
        new TypeError("Configured data directory does not match the selected athlete home."),
      );
    }
  });

  it("reuses the lifecycle writer in the first store window without nested acquisition", async () => {
    const home = await freshHome();
    const context = fakeContext(home);
    const nestedWriterAcquisition = vi.fn(() => {
      throw new Error("nested writer acquisition");
    });
    const manifest = {
      capture_id: "12345678-1234-4123-8123-123456789abc",
      plan: {
        capture_epoch_ms: Date.parse("1998-07-18T12:00:00.000Z"),
        frozenNow: "1998-07-18T12:00:00.000Z",
        calendar_timezone: "UTC",
      },
    } as ReferenceCaptureManifest;
    const produced: ProducedLocalBundle = {
      captureId: manifest.capture_id,
      captureClock: {
        captureEpochMs: manifest.plan.capture_epoch_ms,
        civilDateTime: manifest.plan.frozenNow,
        calendarTimeZone: "UTC",
      },
      bundle: { activities: [], wellness: [], ftpHistory: [] },
    };
    const capture = vi.fn(
      async (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
        if (options.writerContext === undefined) nestedWriterAcquisition();
        expect(options.writerContext).toBe(context);
        return manifest;
      },
    );
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        runtimeDependencies: {
          capture,
          produce: async () => produced,
          now: () => new Date("1998-07-18T12:00:00.000Z"),
          monotonicNow: () => 1,
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      context,
      { apiKey: "dummy", athleteId: "synthetic" },
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(nestedWriterAcquisition).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("constructs the complete object-shaped engine input from named host owners", async () => {
    const home = await freshHome();
    const selectedRuntime = runtime();
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => selectedRuntime,
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1000,
      randomId: () => "synthetic-id",
    });
    expect(received?.sport.id).toBe("cycling");
    expect(Object.keys(received!.ports).sort()).toEqual([
      "attachmentCapabilities",
      "chatAttachments",
      "chatStore",
      "classifyFailure",
      "coachDecisions",
      "config",
      "extractRetryAfterMs",
      "getAccessToken",
      "logger",
      "memory",
      "modelTransportDecorator",
      "now",
      "onToolsAssembled",
      "planningRead",
      "platform",
      "randomId",
      "readReferenceState",
      "secrets",
      "stateReader",
      "toolConfirmations",
      "transcriptWriter",
      "usage",
    ]);
    expect(received?.ports.platform.legacyClient).toBeNull();
    expect(received?.ports.platform.athleteData).toBe(selectedRuntime.athleteData);
    expect(received?.ports.config).toEqual(engineConfigFromConfig(config(home)));
    await expect(lifecycle.spendMeter.getSpendSummary()).resolves.toMatchObject({
      timezone: "UTC",
      dailyCapUsd: 0.5,
    });
    received!.ports.transcriptWriter.appendCompletedTurn({
      chatId: "other",
      turnId: "other-turn",
      completedAt: "1998-07-06T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    received!.ports.transcriptWriter.appendCompletedTurn({
      chatId: "desktop",
      turnId: "desktop-turn",
      completedAt: "1998-07-06T00:00:01.000Z",
      athleteText: "c",
      coachText: "d",
    });
    await expect(
      lifecycle.operations.getTranscriptPage({ cursor: null, limit: 25 }),
    ).resolves.toMatchObject({
      status: "page",
      turns: [{ turnId: "desktop-turn" }],
      nextCursor: null,
    });
    await expect(lifecycle.operations.listArchivedConversations({})).resolves.toEqual({
      schemaVersion: 1,
      conversations: [],
      truncated: false,
    });
    await expect(
      lifecycle.operations.getArchivedTranscriptPage({
        boundaryRef: "d".repeat(64),
        cursor: null,
        limit: 25,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    });
    await lifecycle.close();
  });

  it("deletes one archived Desktop conversation through the application operation", async () => {
    const home = await freshHome();
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);
    const lineage = {
      templateHash: "template",
      assembledHash: "assembled",
      provider: "synthetic",
      model: "synthetic",
      lineageVersion: "1",
    };
    const seedArchivedTurn = (turnId: string, boundaryAt: string): void => {
      engineInput.ports.chatStore.appendTurn("desktop", turnId, `coach-${turnId}`, lineage);
      engineInput.ports.transcriptWriter.appendCompletedTurn({
        chatId: "desktop",
        turnId,
        completedAt: boundaryAt,
        athleteText: turnId,
        coachText: `coach-${turnId}`,
      });
      engineInput.ports.chatStore.resetConversation({
        chatId: "desktop",
        boundaryAt,
        reason: "explicit-reset",
      });
    };
    seedArchivedTurn("turn-first", "1998-07-06T00:00:01.000Z");
    seedArchivedTurn("turn-second", "1998-07-06T00:00:02.000Z");
    const archive = await lifecycle.operations.listArchivedConversations({});
    const firstBoundary = await Promise.all(
      archive.conversations.map(async (conversation) => ({
        boundaryRef: conversation.boundaryRef,
        page: await lifecycle.operations.getArchivedTranscriptPage({
          boundaryRef: conversation.boundaryRef,
          cursor: null,
          limit: 25,
        }),
      })),
    ).then((entries) =>
      entries.find(({ page }) => page.turns.some((turn) => turn.turnId === "turn-first")),
    );
    if (firstBoundary === undefined) throw new Error("Expected the first archived conversation.");

    await expect(
      lifecycle.operations.deleteArchivedConversation({
        boundaryRef: firstBoundary.boundaryRef,
      }),
    ).resolves.toEqual({ schemaVersion: 1, status: "deleted" });
    await expect(
      lifecycle.operations.deleteArchivedConversation({
        boundaryRef: firstBoundary.boundaryRef,
      }),
    ).resolves.toEqual({ schemaVersion: 1, status: "not-found" });
    await expect(lifecycle.operations.listArchivedConversations({})).resolves.toMatchObject({
      conversations: [{ turnCount: 1 }],
    });
    await expect(
      lifecycle.operations.getArchivedTranscriptPage({
        boundaryRef: firstBoundary.boundaryRef,
        cursor: null,
        limit: 25,
      }),
    ).resolves.toMatchObject({ status: "restart-required", turns: [] });
    await lifecycle.close();
  });

  it.each([
    { skewHours: -2, expiresFromServerNowMs: -60 * 60_000, rejectedByServer: true },
    { skewHours: 2, expiresFromServerNowMs: 60 * 60_000, rejectedByServer: false },
  ])(
    "completes a ChatGPT-lane turn with a $skewHours-hour local clock skew",
    async ({ skewHours, expiresFromServerNowMs, rejectedByServer }) => {
      const home = await freshHome();
      const serverNow = Date.parse("1998-07-18T12:00:00.000Z");
      const storedAccess = codexAccessToken("synthetic-stored-account");
      const refreshedAccess = codexAccessToken("synthetic-refreshed-account");
      const profilesPath = join(home.configDir, "auth-profiles.json");
      await writeFile(
        profilesPath,
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: storedAccess,
            refresh: "synthetic-refresh",
            expires: serverNow + expiresFromServerNowMs,
            accountId: "synthetic-stored-account",
          },
        }),
        { mode: 0o600 },
      );
      let tokenRequests = 0;
      const authorizations: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          tokenRequests++;
          return tokenResponse(refreshedAccess);
        }
        if (url === "https://chatgpt.com/backend-api/codex/responses") {
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          authorizations.push(authorization);
          if (rejectedByServer && authorization === `Bearer ${storedAccess}`) {
            return new Response(
              JSON.stringify({ error: { code: "invalid_token", message: "expired" } }),
              { status: 401 },
            );
          }
          return codexTextResponse("clock-safe reply");
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const base = config(home);
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => runtime(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          now: () => serverNow + skewHours * 60 * 60_000,
          randomId: () => `synthetic-skew-${skewHours}`,
        },
        fakeContext(home),
        undefined,
        {
          ...base,
          contextWindowTokens: 120_000,
          llm: {
            provider: "openai-codex",
            model: "gpt-5.4",
            apiKey: "",
            authProfile: "openai-codex",
          },
        },
      );

      try {
        await expect(
          lifecycle.engine.chat({ chatId: "desktop", message: "hello" }),
        ).resolves.toEqual({ text: "clock-safe reply" });
        expect(tokenRequests).toBe(rejectedByServer ? 1 : 0);
        expect(authorizations[0]).toBe(`Bearer ${storedAccess}`);
        expect(authorizations.length).toBeGreaterThan(0);
        const acceptedAccess = rejectedByServer ? refreshedAccess : storedAccess;
        expect(authorizations.slice(1).every((value) => value === `Bearer ${acceptedAccess}`)).toBe(
          true,
        );
      } finally {
        await lifecycle.close();
      }
    },
  );

  it("carries an explicit refresh rejection through the composed desktop ports", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
      );
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1_000,
    });

    vi.useFakeTimers();
    const settled = received!.ports
      .getAccessToken("openai-codex", undefined, "synthetic-expired-access")
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(2_000);
    const failure = await settled;

    expect(failure).toBeInstanceOf(RefreshTokenReusedError);
    expect(failure).toMatchObject({ refreshFailureReason: "reauth" });
    expect(received!.ports.classifyFailure(failure)).toBe("reauth");
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await lifecycle.close();
  });

  it("carries a server refresh failure through the composed desktop ports", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 503 }));
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1_000,
    });

    const failure = await received!.ports
      .getAccessToken("openai-codex", undefined, "synthetic-expired-access")
      .catch((error) => error);

    expect(received!.ports.classifyFailure(failure)).toBe("server_error");
    expect(failure).toMatchObject({ refreshFailureReason: "server_error" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it("refreshes once while preserving queued readers, metadata, and a concurrent profile", async () => {
    const home = await freshHome();
    const profilesPath = join(home.configDir, "auth-profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "synthetic-expired-access",
          refresh: "synthetic-refresh",
          expires: 0,
          accountId: "synthetic-old-account",
          email: "synthetic@example.test",
          future: { nested: { generation: 1, retained: true } },
        },
        unrelated: { kind: "future-provider", retained: true },
      }),
      { mode: 0o600 },
    );
    const refreshedAccess = codexAccessToken("synthetic-new-account");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saveStoredProfile(profilesPath, "concurrent-provider", {
        kind: "concurrent-login",
        retained: true,
      });
      return tokenResponse(refreshedAccess);
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(
      Promise.all([
        engineInput.ports.getAccessToken("openai-codex", undefined, "synthetic-expired-access"),
        engineInput.ports.getAccessToken("openai-codex", undefined, "synthetic-expired-access"),
      ]),
    ).resolves.toEqual([refreshedAccess, refreshedAccess]);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      "openai-codex": {
        type: "oauth",
        access: refreshedAccess,
        refresh: "synthetic-rotated-refresh",
        accountId: "synthetic-new-account",
        email: "synthetic@example.test",
        future: { nested: { generation: 1, retained: true } },
      },
      unrelated: { kind: "future-provider", retained: true },
      "concurrent-provider": { kind: "concurrent-login", retained: true },
    });
    await lifecycle.close();
  });

  it("retries a first reauthentication rejection with the current shared refresh token", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const refreshedAccess = codexAccessToken("synthetic-confirmed-account");
    const requestBodies: string[] = [];
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        saveStoredProfile(profilesPath, "openai-codex", {
          type: "oauth",
          access: "synthetic-shared-access",
          refresh: "synthetic-shared-refresh",
          expires: 0,
          accountId: "synthetic-shared-account",
          future: { source: "concurrent-login" },
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return tokenResponse(refreshedAccess, "synthetic-confirmed-refresh");
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const pending = engineInput.ports.getAccessToken(
      "openai-codex",
      undefined,
      "synthetic-expired-access",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe(refreshedAccess);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toContain("refresh_token=synthetic-refresh");
    expect(requestBodies[1]).toContain("refresh_token=synthetic-shared-refresh");
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toMatchObject({
      access: refreshedAccess,
      refresh: "synthetic-confirmed-refresh",
      future: { source: "concurrent-login" },
    });
    await lifecycle.close();
  });

  it("does not retry or resurrect a profile deleted before reauthentication confirmation", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      unlinkSync(profilesPath);
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const settled = engineInput.ports
      .getAccessToken("openai-codex", undefined, "synthetic-expired-access")
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toMatchObject({ message: "OAuth profile is invalid." });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.close();
  });

  it("does not resurrect a profile deleted during the confirmation request", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      )
      .mockImplementationOnce(() => {
        unlinkSync(profilesPath);
        return Promise.resolve(tokenResponse(codexAccessToken("synthetic-stale-confirmation")));
      });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const settled = engineInput.ports
      .getAccessToken("openai-codex", undefined, "synthetic-expired-access")
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toMatchObject({ message: "OAuth profile is invalid." });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.close();
  });

  it("aborts the reauthentication delay without a second request or commit", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const originalBytes = await readFile(profilesPath, "utf8");
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);
    const controller = new AbortController();
    const abortReason = new Error("synthetic caller abort");

    vi.useFakeTimers();
    const settled = engineInput.ports
      .getAccessToken("openai-codex", controller.signal, "synthetic-expired-access")
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    controller.abort(abortReason);

    await expect(settled).resolves.toBe(abortReason);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(await readFile(profilesPath, "utf8")).toBe(originalBytes);
    expect(vi.getTimerCount()).toBe(0);
    await lifecycle.close();
  });

  it("commits a successful token rotation despite a late abort", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const controller = new AbortController();
    const abortReason = new DOMException("Cancelled after endpoint success", "AbortError");
    const refreshedAccess = codexAccessToken("synthetic-late-abort-account");
    const response = tokenResponse(refreshedAccess, "synthetic-late-abort-refresh");
    const decodeResponse = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(async () => {
      const body = await decodeResponse();
      controller.abort(abortReason);
      return body;
    });
    const fetchStub = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(
      engineInput.ports.getAccessToken(
        "openai-codex",
        controller.signal,
        "synthetic-expired-access",
      ),
    ).resolves.toBe(refreshedAccess);

    expect(controller.signal.reason).toBe(abortReason);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toMatchObject({
      access: refreshedAccess,
      refresh: "synthetic-late-abort-refresh",
      accountId: "synthetic-late-abort-account",
    });
    await lifecycle.close();
  });

  it("returns a concurrently replaced profile instead of overwriting the newer login", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saveStoredProfile(profilesPath, "openai-codex", {
        type: "oauth",
        access: "synthetic-concurrent-access",
        refresh: "synthetic-concurrent-refresh",
        expires: 4_102_444_800_000,
        accountId: "synthetic-concurrent-account",
        email: "concurrent@example.test",
      });
      return tokenResponse(codexAccessToken("synthetic-stale-account"));
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(
      engineInput.ports.getAccessToken("openai-codex", undefined, "synthetic-expired-access"),
    ).resolves.toBe("synthetic-concurrent-access");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toEqual({
      type: "oauth",
      access: "synthetic-concurrent-access",
      refresh: "synthetic-concurrent-refresh",
      expires: 4_102_444_800_000,
      accountId: "synthetic-concurrent-account",
      email: "concurrent@example.test",
    });
    await lifecycle.close();
  });

  it("rejects without resurrecting a profile deleted during refresh", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await rm(profilesPath);
      return tokenResponse(codexAccessToken("synthetic-stale-account"));
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(
      engineInput.ports.getAccessToken("openai-codex", undefined, "synthetic-expired-access"),
    ).rejects.toThrow("OAuth profile is invalid.");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.close();
  });

  it("binds one persisted source to both state paths while keeping tool and disclosure readers separate", async () => {
    const home = await freshHome();
    const selectedRuntime = runtime();
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => selectedRuntime,
      createBackend: (input) => {
        received = input;
        return backend({ getAthleteState: () => input.ports.stateReader.getAthleteState() });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => Date.parse(state.lastUpdated),
    });
    const projectedState = await received!.ports.stateReader.getAthleteState();
    const projectedTrainingContext = projectedState.trainingContext;
    const expectedTrainingContext = state.trainingContext;
    if (projectedTrainingContext === undefined || expectedTrainingContext === undefined) {
      throw new TypeError("training context is missing");
    }
    expect({
      ...projectedState,
      trainingContext: {
        ...projectedTrainingContext,
        recentRides: expectedTrainingContext.recentRides,
        trainingHistory: expectedTrainingContext.trainingHistory,
      },
    }).toEqual(state);
    expect(projectedTrainingContext.recentRides).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
    expect(projectedTrainingContext.trainingHistory).toMatchObject({
      kind: "computed",
      calendarTimeZone: "UTC",
      coverage: { kind: "incomplete", reason: "source-degraded" },
      anchorWeek: { coverage: { kind: "incomplete", reason: "source-degraded" } },
      previousWeek: { coverage: { kind: "incomplete", reason: "source-degraded" } },
    });
    await expect(lifecycle.engine.getAthleteState()).resolves.toEqual(projectedState);
    expect(received!.ports.platform.athleteData).toBe(selectedRuntime.athleteData);
    expect(received!.ports.readReferenceState).not.toBe(
      received!.ports.stateReader.getAthleteState,
    );
    expect(received!.ports.readReferenceState().latest?.metadata?.last_updated).toBe(
      state.lastUpdated,
    );
    await lifecycle.close();
  });

  it("awaits cold start before scheduling and exposes no engine after cold-start failure", async () => {
    const home = await freshHome();
    await rm(join(home.root, "data", "latest.json"));
    const failure = { kind: "cold-start" };
    const trace: string[] = [];
    const createBackend = vi.fn<(input: CreateCoachEngineInput) => CoachEngine>(() => backend());
    await expect(
      compose(home, {
        bootstrap: async () => reference(trace),
        createRuntime: () =>
          runtime(trace, {
            runWindow: async () => {
              trace.push("run-window");
              throw failure;
            },
          }),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      }),
    ).rejects.toBe(failure);
    expect(createBackend).not.toHaveBeenCalled();
    expect(trace).toEqual(["run-window", "reference-stop", "runtime-close"]);
  });

  it("does not start the scheduler after a credential-free deferred refresh", async () => {
    const home = await freshHome();
    const trace: string[] = [];
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(trace),
        createRuntime: () => runtime(trace),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      { apiKey: "", athleteId: "" },
      undefined,
      { ENDURAGENT_HOME: home.root },
      true,
    );

    await expect(lifecycle.startInitialRefresh()).resolves.toBeUndefined();
    expect(trace).toEqual(["run-window"]);
    await lifecycle.close();
  });

  it("defers the daemon refresh, tracks one start, and schedules retries after capture failure", async () => {
    const home = await freshHome();
    const failure = new Error("synthetic persistence failure");
    const trace: string[] = [];
    const ownerGuard = vi.fn(async () => {
      trace.push("owner-ready");
    });
    const selectedRuntime = runtime(trace, {
      runWindow: async () => {
        trace.push("run-window");
        throw failure;
      },
    });
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(trace),
        createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: ownerGuard,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    expect(ownerGuard).not.toHaveBeenCalled();
    expect(runWindowAfter).not.toHaveBeenCalled();
    expect(trace).toEqual([]);

    const first = lifecycle.startInitialRefresh();
    const second = lifecycle.startInitialRefresh();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);

    expect(ownerGuard).toHaveBeenCalledOnce();
    expect(runWindowAfter).toHaveBeenCalledOnce();
    expect(trace).toEqual(["owner-ready", "run-window", "start-scheduler"]);
    await lifecycle.close();
  });

  it("retries deferred owner verification after a transient failure and recovers", async () => {
    vi.useFakeTimers();
    try {
      const home = await freshHome();
      const trace: string[] = [];
      let runtimeOptions: LocalStoreRuntimeOptions | undefined;
      const ownerGuard = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("synthetic network outage"));
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(trace),
          createRuntime: (options) => {
            runtimeOptions = options;
            return runtime(trace);
          },
          createBackend: () => backend(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner: ownerGuard,
        },
        fakeContext(home),
        undefined,
        config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
        { ENDURAGENT_HOME: home.root },
        true,
      );

      await expect(lifecycle.startInitialRefresh()).rejects.toThrow("synthetic network outage");
      expect(trace).not.toContain("start-scheduler");
      expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("");
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        intervals: { credential_verification_pending: true },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(ownerGuard).toHaveBeenCalledTimes(2);
      expect(trace).toContain("start-scheduler");
      expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("configured-key");
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        intervals: { credential_verification_pending: false },
      });
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule an automatic retry after a deferred owner refusal", async () => {
    vi.useFakeTimers();
    try {
      const home = await freshHome();
      const failure = new RuntimeAthleteOwnerRefusal("candidate-unresolved");
      const ownerGuard = vi.fn(async () => {
        throw failure;
      });
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => runtime(),
          createBackend: () => backend(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner: ownerGuard,
        },
        fakeContext(home),
        undefined,
        config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
        { ENDURAGENT_HOME: home.root },
        true,
      );

      await expect(lifecycle.startInitialRefresh()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(ownerGuard).toHaveBeenCalledOnce();

      await expect(lifecycle.startInitialRefresh()).rejects.toBe(failure);
      expect(ownerGuard).toHaveBeenCalledTimes(2);
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries deferred owner verification after a transient refusal and recovers", async () => {
    vi.useFakeTimers();
    try {
      const home = await freshHome();
      const trace: string[] = [];
      let runtimeOptions: LocalStoreRuntimeOptions | undefined;
      const ownerGuard = vi
        .fn(async () => {})
        .mockRejectedValueOnce(
          new RuntimeAthleteOwnerRefusal("candidate-unresolved", {
            transient: true,
            cause: new Error("synthetic lookup outage"),
          }),
        );
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(trace),
          createRuntime: (options) => {
            runtimeOptions = options;
            return runtime(trace);
          },
          createBackend: () => backend(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner: ownerGuard,
        },
        fakeContext(home),
        undefined,
        config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
        { ENDURAGENT_HOME: home.root },
        true,
      );

      await expect(lifecycle.startInitialRefresh()).rejects.toThrow(
        "training account owner unresolved",
      );
      expect(trace).not.toContain("start-scheduler");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(ownerGuard).toHaveBeenCalledTimes(2);
      expect(trace).toContain("start-scheduler");
      expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("configured-key");
      await lifecycle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kicks a refresh for credentials saved while the deferred refresh interleaves", async () => {
    const home = await freshHome();
    const trace: string[] = [];
    const windows: Config["intervals"][] = [];
    let runtimeOptions: LocalStoreRuntimeOptions | undefined;
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let markOwnerEntered!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const counts = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    }).snapshot();
    const selectedRuntime = runtime(trace);
    const runWindowAfter = vi.fn<LocalStoreRuntime["runWindowAfter"]>(async (work) => {
      await work(new AbortController().signal);
      const current = runtimeOptions?.readConfig?.();
      if (current === undefined) throw new Error("Expected live runtime configuration.");
      windows.push({ ...current.intervals });
      return {
        published: true,
        counts,
        legacySucceeded: true,
        droppedActivities: EMPTY_DROPPED_ACTIVITIES,
      };
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(trace),
        createRuntime: (options) => {
          runtimeOptions = options;
          return { ...selectedRuntime, runWindowAfter };
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async () => {
          markOwnerEntered();
          await ownerGate;
        },
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "", athleteId: "" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    const replacement = lifecycle.operations.configureRuntime({
      intervals: { api_key: "fresh-key", athlete_id: "fresh-athlete" },
    });
    await ownerEntered;
    await expect(lifecycle.startInitialRefresh()).resolves.toBeUndefined();
    expect(windows).toEqual([{ apiKey: "", athleteId: "" }]);

    releaseOwner();
    await expect(replacement).resolves.toMatchObject({ status: "applied" });
    await vi.waitFor(() =>
      expect(windows).toEqual([
        { apiKey: "", athleteId: "" },
        { apiKey: "fresh-key", athleteId: "fresh-athlete" },
      ]),
    );
    expect(trace).toContain("start-scheduler");
    await lifecycle.close();
  });

  it("does not capture or schedule when deferred owner verification fails", async () => {
    const home = await freshHome();
    const failure = new RuntimeAthleteOwnerRefusal("candidate-unresolved");
    const trace: string[] = [];
    const selectedRuntime = runtime(trace);
    const runWindow = vi.fn(selectedRuntime.runWindow);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(trace),
        createRuntime: () => ({ ...selectedRuntime, runWindow }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async () => {
          throw failure;
        },
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    await expect(lifecycle.startInitialRefresh()).rejects.toBe(failure);
    expect(runWindow).not.toHaveBeenCalled();
    expect(trace).toEqual([]);
    await lifecycle.close();
  });

  it("rechecks a same-value credential after deferred owner failure without capturing", async () => {
    const home = await freshHome();
    const failure = new RuntimeAthleteOwnerRefusal("candidate-unresolved");
    const selectedRuntime = runtime();
    const runWindow = vi.fn(selectedRuntime.runWindow);
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const assertRuntimeAthleteOwner = vi.fn(async () => {
      throw failure;
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({ ...selectedRuntime, runWindow, runWindowAfter }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    await expect(lifecycle.startInitialRefresh()).rejects.toBe(failure);
    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { api_key: "configured-key", athlete_id: "configured-athlete" },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "refused",
      reason: "ownership-unavailable",
    });
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(2);
    expect(runWindow).not.toHaveBeenCalled();
    expect(runWindowAfter).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("retains an LLM replacement that lands while deferred owner verification is stalled", async () => {
    const home = await freshHome();
    let releaseOwner!: () => void;
    let markOwnerEntered!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const received: CreateCoachEngineInput[] = [];
    let runtimeOptions: LocalStoreRuntimeOptions | undefined;
    let readReferenceIntervals:
      | (() => { readonly apiKey: string; readonly athleteId?: string })
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async (options) => {
          readReferenceIntervals = options.readIntervals;
          return reference();
        },
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async () => {
          markOwnerEntered();
          await ownerGate;
        },
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    expect(runtimeOptions?.config.intervals.apiKey).toBe("");
    expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("");
    expect(readReferenceIntervals?.().apiKey).toBe("");
    expect(received.at(-1)?.ports.platform.legacyClient).toBeNull();

    const initialization = lifecycle.startInitialRefresh();
    await ownerEntered;
    await expect(
      lifecycle.operations.configureRuntime({ llm: { model: "retained-model" } }),
    ).resolves.toMatchObject({ status: "applied", applied: { llm: true } });
    expect(received.at(-1)?.ports.config.llm.model).toBe("retained-model");
    expect(received.at(-1)?.ports.platform.legacyClient).toBeNull();

    releaseOwner();
    await expect(initialization).resolves.toBeUndefined();
    expect(received.at(-1)?.ports.config.llm.model).toBe("retained-model");
    expect(received.at(-1)?.ports.platform.legacyClient).not.toBeNull();
    expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("configured-key");
    expect(readReferenceIntervals?.().apiKey).toBe("configured-key");
    await lifecycle.close();
  });

  it("keeps manual sync keyless before deferred owner approval", async () => {
    const home = await freshHome();
    const context = fakeContext(home);
    const backfill = vi.fn(async () => ({
      pages: 1,
      artifacts: 0,
      reports: [],
      droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
    }));
    let runtimeOptions: LocalStoreRuntimeOptions | undefined;
    let readReferenceIntervals:
      | (() => { readonly apiKey: string; readonly athleteId?: string })
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async (options) => {
          readReferenceIntervals = options.readIntervals;
          return reference();
        },
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        operationsDependencies: { backfill },
      },
      context,
      undefined,
      config(home, { apiKey: "unapproved-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    const fetchStub = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
    await expect(lifecycle.operations.sync({})).resolves.toMatchObject({
      published: true,
      backfill: "pending-verification",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: {
        credential_configured: true,
        credential_verification_pending: true,
      },
    });
    if (lifecycle.operations.exportTrainingFile === undefined) {
      throw new Error("Expected training export support.");
    }
    await expect(
      lifecycle.operations.exportTrainingFile({
        kind: "workout-archive",
        oldest: "1998-07-01",
        newest: "1998-07-18",
        format: "zwo",
        destinationPath: join(home.root, "training.zip"),
      }),
    ).resolves.toEqual({ status: "refused", reason: "not-configured" });
    expect(backfill).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(runtimeOptions?.readConfig?.().intervals.apiKey).toBe("");
    expect(readReferenceIntervals?.().apiKey).toBe("");
    await lifecycle.close();
  });

  it("reuses queued credential approval when explicit startup reaches the refresh window", async () => {
    const home = await freshHome();
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let markTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => {
      markTurnEntered = resolve;
    });
    const windows: Config["intervals"][] = [];
    const trace: string[] = [];
    let runtimeOptions: LocalStoreRuntimeOptions | undefined;
    const ownerCandidates: Config["intervals"][] = [];
    const counts = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    }).snapshot();
    const selectedRuntime = runtime(trace);
    const runWindowAfter = vi.fn<LocalStoreRuntime["runWindowAfter"]>((work) =>
      selectedRuntime.runExclusive(async (signal) => {
        await work(signal);
        const current = runtimeOptions?.readConfig?.();
        if (current === undefined) throw new Error("Expected live runtime configuration.");
        windows.push({ ...current.intervals });
        return {
          published: true,
          counts,
          legacySucceeded: true,
          droppedActivities: EMPTY_DROPPED_ACTIVITIES,
        };
      }),
    );
    let holdTurn = true;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return { ...selectedRuntime, runWindowAfter };
        },
        createBackend: () =>
          backend({
            chat: async () => {
              if (holdTurn) {
                holdTurn = false;
                markTurnEntered();
                await turnGate;
              }
              return { text: "ok" };
            },
          }),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async (_store, options) => {
          if (ownerCandidates.length > 0) {
            throw new RuntimeAthleteOwnerRefusal("candidate-unresolved");
          }
          ownerCandidates.push({
            apiKey: options.candidate.apiKey,
            athleteId: options.candidate.athleteId,
          });
        },
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "old-key", athleteId: "old-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    const activeTurn = lifecycle.engine.chat({ chatId: "race", message: "hold" });
    await turnEntered;
    const replacement = lifecycle.operations.configureRuntime({
      intervals: { api_key: "new-key", athlete_id: "new-athlete" },
    });
    await vi.waitFor(() => expect(ownerCandidates).toHaveLength(1));
    await Promise.resolve();
    const initialization = lifecycle.startInitialRefresh();

    releaseTurn();
    await activeTurn;
    await expect(replacement).resolves.toMatchObject({ status: "applied" });
    await expect(initialization).resolves.toBeUndefined();
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    expect(windows).toEqual([{ apiKey: "new-key", athleteId: "new-athlete" }]);
    expect(ownerCandidates).toEqual([{ apiKey: "new-key", athleteId: "new-athlete" }]);
    expect(trace).toContain("start-scheduler");
    await lifecycle.close();
  });

  it("aborts and awaits deferred initialization during lifecycle close", async () => {
    const home = await freshHome();
    const shutdownFailure = new Error("synthetic lifecycle close");
    let windowController: AbortController | undefined;
    let activeWindow: ReturnType<LocalStoreRuntime["runWindow"]> | undefined;
    let markOwnerEntered!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    let ownerSettled = false;
    const counts = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    }).snapshot();
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn<LocalStoreRuntime["runWindowAfter"]>((work) => {
      windowController = new AbortController();
      activeWindow = (async () => {
        await work(windowController!.signal);
        return {
          published: true,
          counts,
          legacySucceeded: true,
          droppedActivities: EMPTY_DROPPED_ACTIVITIES,
        };
      })();
      return activeWindow;
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({
          ...selectedRuntime,
          runWindowAfter,
          async close() {
            windowController?.abort(shutdownFailure);
            await activeWindow?.catch(() => {});
          },
        }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async (_store, options) => {
          markOwnerEntered();
          try {
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                once: true,
              });
            });
          } finally {
            ownerSettled = true;
          }
        },
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "configured-athlete" }),
      { ENDURAGENT_HOME: home.root },
      true,
    );

    const initializationOutcome = lifecycle.startInitialRefresh().catch((error) => error);
    await ownerEntered;
    await expect(lifecycle.close()).resolves.toBeUndefined();

    await expect(initializationOutcome).resolves.toMatchObject({
      message: "Coach lifecycle closed.",
    });
    expect(ownerSettled).toBe(true);
  });

  it("backs all four methods with a real writer store, repository, resolver, and persisted render", async () => {
    const home = await freshHome();
    await mkdir(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    stores.push(store);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "anchor-1",
        "cycling",
        "ftp",
        275,
        "W",
        1_752_796_000,
        "synthetic",
        "manual",
        null,
        "manual",
        null,
        null,
        null,
      ],
    );
    let chatRequest: Parameters<CoachEngine["chat"]>[0] | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) =>
          backend({
            chat: async (request) => {
              chatRequest = request;
              return { text: "anchored" };
            },
            getAthleteState: () => input.ports.stateReader.getAthleteState(),
            hasSession: async () => ({ hasSession: true }),
            resetSession: async () => ({ memoryFlushed: true }),
          }),
        now: () => 1_752_796_800_000,
      },
      { home, store, listener: inertWriterProtocolListener },
    );
    await expect(lifecycle.engine.chat({ chatId: "x", message: "status" })).resolves.toEqual({
      text: "anchored",
    });
    expect(chatRequest?.turn?.resolvedCs).toMatchObject({ kind: "ftp", watts: 275 });
    await expect(lifecycle.engine.hasSession({ chatId: "x" })).resolves.toEqual({
      hasSession: true,
    });
    await expect(lifecycle.engine.resetSession({ chatId: "x" })).resolves.toEqual({
      memoryFlushed: true,
    });
    await expect(lifecycle.engine.getAthleteState()).resolves.toMatchObject({
      currentStatus: state.currentStatus,
      derivedMetrics: state.derivedMetrics,
      plannedWorkouts: state.plannedWorkouts,
      degraded: true,
    });
    await lifecycle.close();
  });

  it("composes Plan FTP precedence from Intervals anchors, eFTP, and athlete input", async () => {
    const home = await freshHome();
    await mkdir(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    stores.push(store);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "intervals-ftp",
        "cycling",
        "ftp",
        275,
        "W",
        1_752_796_000,
        "intervals-icu",
        "platform",
        null,
        "sync",
        null,
        null,
        null,
      ],
    );
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        now: () => 1_752_796_800_000,
      },
      { home, store, listener: inertWriterProtocolListener },
    );
    const started = await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    expect(started).toMatchObject({
      status: "completed",
      state: {
        data: {
          ftp: {
            usedSource: "intervals-ftp",
            usedWatts: 275,
            intervalsEftp: { watts: 260 },
            conflict: true,
          },
        },
      },
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await expect(
      lifecycle.operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-2",
        conversationId,
        source: "manual",
        watts: 282,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S060",
        data: { ftp: { usedSource: "manual", usedWatts: 282, conflict: true } },
      },
    });
    await expect(
      lifecycle.operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-3",
        conversationId,
        source: "manual",
        watts: 285,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { data: { ftp: { usedSource: "manual", usedWatts: 285 } } },
    });
    await expect(
      store.get(
        "SELECT value, source, confidence FROM anchor_history WHERE sport = ? AND anchor_type = ? AND confidence = ?",
        ["cycling", "ftp", "manual"],
      ),
    ).resolves.toEqual({ value: 285, source: "athlete", confidence: "manual" });
    await lifecycle.close();
  });

  it("composes durable Plan intake through a structured Draft and activates locally before provider work", async () => {
    const home = await freshHome();
    await mkdir(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    stores.push(store);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "plan-draft-ftp",
        "cycling",
        "ftp",
        282,
        "W",
        899_510_400,
        "intervals-icu",
        "platform",
        null,
        "sync",
        null,
        null,
        null,
      ],
    );
    const chat: CoachEngine["chat"] = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "plan-intake-turn", chatId: request.chatId });
      onEvent?.({
        type: "final-text",
        turnId: "plan-intake-turn",
        text: "I have enough information to create your Draft.",
      });
      return {
        text: "I have enough information to create your Draft.",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A" as const,
          targetDate: "1998-10-04",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
          currentTrainingSummary: "Three rides each week with a weekend long ride",
        },
      };
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () =>
          backend({
            chat,
            getChatQueue: async () => ({ schemaVersion: 1, revision: 0, items: [] }),
          }),
        now: () => Date.UTC(1998, 6, 13, 12),
      },
      { home, store, listener: inertWriterProtocolListener },
      undefined,
      undefined,
      { ENDURAGENT_HOME: home.root },
      true,
    );

    await expect(lifecycle.operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S001" },
    });
    const started = await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "plan-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    expect(started.state).toMatchObject({ scenarioId: "PL-S017" });
    const conversationId = String(started.state.data.conversationId);
    await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "plan-course-omitted",
      conversationId,
    });
    await expect(
      lifecycle.operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "plan-intake",
        conversationId,
        text: "I can train Tuesday, Thursday, Saturday, and Sunday.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      eventName: "Gran Fondo Almaty",
      eventPriority: "A",
      eventDateKey: 19981004,
      sourceTurnSequence: 1,
    });

    const phases: string[] = [];
    const formed = await lifecycle.operations.executePlanTransition?.(
      {
        transitionId: "PL-T06",
        commandId: "plan-create-draft",
        conversationId,
      },
      (event) => phases.push(event.phase),
    );
    expect(phases.at(0)).toBe("running");
    expect(phases.at(-1)).toBe("completed");
    expect(phases.filter((phase) => phase === "running").length).toBeGreaterThan(2);
    expect(formed).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S002", lifecycle: "draft", revision: 1 },
    });
    if (formed?.status !== "completed" || formed.state.planId === null) {
      throw new TypeError("Structured Draft was not formed.");
    }
    const plans = createPlanRepository(store);
    await expect(plans.read(formed.state.planId)).resolves.toMatchObject({
      status: "draft",
      name: "Gran Fondo Almaty Plan",
      startDateKey: 19980713,
      targetDateKey: 19981004,
      totalWeeks: 12,
    });
    const workouts = await plans.readWorkouts(formed.state.planId);
    expect(workouts).toHaveLength(48);
    expect(workouts.at(-1)).toMatchObject({
      dateKey: 19981004,
      name: "Gran Fondo Almaty",
    });
    expect(await plans.readLatest()).toMatchObject({ status: "draft" });
    await expect(
      store.get("SELECT id FROM plan_draft_build_checkpoint WHERE conversation_id=?", [
        conversationId,
      ]),
    ).resolves.toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(1);

    const provider = vi.spyOn(globalThis, "fetch");
    const providerCallsBeforeActivation = provider.mock.calls.length;
    await store.run(
      "CREATE TRIGGER fail_plan_mirror_job BEFORE INSERT ON plan_reconciliation_job BEGIN SELECT RAISE(FAIL, 'synthetic mirror job failure'); END",
    );
    const draft = formed.state.data.draft as { id: string; revision: number };
    const activationPhases: string[] = [];
    const activated = await lifecycle.operations.executePlanTransition?.(
      {
        transitionId: "PL-T11",
        commandId: "plan-activate-locally",
        draftId: draft.id,
        expectedRevision: draft.revision,
      },
      (event) => activationPhases.push(event.phase),
    );
    expect(activationPhases).toEqual(["running", "failed"]);
    expect(activated).toMatchObject({
      status: "rejected",
      error: {
        code: "persistence-failed",
        retryable: true,
      },
      state: {
        lifecycle: "active",
        scenarioId: "PL-S039",
        reconciliation: {
          status: "failed",
          error: { code: "persistence-failed", retryable: true },
        },
        attention: { count: 1, destination: "direct" },
      },
    });
    expect(provider.mock.calls).toHaveLength(providerCallsBeforeActivation);
    await expect(plans.read(formed.state.planId)).resolves.toMatchObject({ status: "active" });
    await expect(lifecycle.operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        lifecycle: "active",
        scenarioId: "PL-S037",
        reconciliation: { status: "not-started" },
      },
    });
    await store.run("DROP TRIGGER fail_plan_mirror_job");
    await expect(
      lifecycle.operations.executePlanTransition?.({
        transitionId: "PL-T12",
        commandId: "plan-retry-mirror",
        planId: formed.state.planId,
        mode: "reconcile",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { scenarioId: "PL-S039" },
    });
    await expect(
      store.get("SELECT plan_id, kind FROM plan_reconciliation_job WHERE plan_id=?", [
        formed.state.planId,
      ]),
    ).resolves.toEqual({ plan_id: formed.state.planId, kind: "mirror" });
    await lifecycle.close();
  });

  it("keeps the active Plan while composing replacement intake into a structured Draft", async () => {
    const home = await freshHome();
    await mkdir(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    stores.push(store);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "replacement-draft-ftp",
        "cycling",
        "ftp",
        282,
        "W",
        899_510_400,
        "intervals-icu",
        "platform",
        null,
        "sync",
        null,
        null,
        null,
      ],
    );
    const plans = createPlanRepository(store);
    const activePlanId = `${"0".repeat(25)}8`;
    await plans.replaceNew(
      {
        id: activePlanId,
        originId: null,
        name: "Current Plan",
        primaryGoal: "Build endurance",
        startDateKey: 19980713,
        targetDateKey: 19981004,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 10,
        updatedAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      [],
      19980713,
    );
    const chat: CoachEngine["chat"] = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "replacement-intake-turn", chatId: request.chatId });
      onEvent?.({
        type: "final-text",
        turnId: "replacement-intake-turn",
        text: "The replacement Draft is ready to build.",
      });
      return {
        text: "The replacement Draft is ready to build.",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "B" as const,
          targetDate: "1998-10-04",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
          currentTrainingSummary: "Three rides each week with a weekend long ride",
        },
      };
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () =>
          backend({
            chat,
            getChatQueue: async () => ({ schemaVersion: 1, revision: 0, items: [] }),
          }),
        now: () => Date.UTC(1998, 6, 13, 12),
      },
      { home, store, listener: inertWriterProtocolListener },
      undefined,
      undefined,
      { ENDURAGENT_HOME: home.root },
      true,
    );
    const started = await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "replacement-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Replacement intake did not start.");
    expect(started.state).toMatchObject({
      scenarioId: "PL-S079",
      data: { replacement: true },
    });
    const conversationId = String(started.state.data.conversationId);
    await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "replacement-course-omitted",
      conversationId,
    });
    await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T05",
      commandId: "replacement-intake",
      conversationId,
      text: "Use four days and make this my B event.",
    });
    const formed = await lifecycle.operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "replacement-create-draft",
      conversationId,
    });
    expect(formed).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S080", lifecycle: "replacement-draft", revision: 1 },
    });
    if (formed?.status !== "completed" || formed.state.planId === null) {
      throw new TypeError("Replacement Draft was not formed.");
    }
    await expect(plans.read(activePlanId)).resolves.toMatchObject({ status: "active" });
    await expect(plans.read(formed.state.planId)).resolves.toMatchObject({
      status: "draft",
      name: "Gran Fondo Almaty Plan",
    });
    await expect(
      store.get("SELECT replaces_plan_id FROM plan_conversation WHERE id=?", [conversationId]),
    ).resolves.toEqual({ replaces_plan_id: activePlanId });
    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      eventPriority: "B",
      sourceTurnSequence: 1,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it("uses the extracted engine FIFO per chat id while allowing different ids to overlap", async () => {
    const home = await freshHome();
    let generateCalls = 0;
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const decorator: ModelTransportDecorator = () => ({
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          markEntered();
          await firstGate;
        }
        return generation(`reply-${generateCalls}`);
      },
    });
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        modelTransportDecorator: decorator,
      },
      fakeContext(home),
      undefined,
      { ...config(home), contextWindowTokens: 120_000 },
    );
    const completion: string[] = [];
    const first = lifecycle.engine.chat({ chatId: "same", message: "first" }).then((value) => {
      completion.push("first");
      return value;
    });
    await entered;
    const second = lifecycle.engine.chat({ chatId: "same", message: "second" }).then((value) => {
      completion.push("second");
      return value;
    });
    await Promise.resolve();
    expect(generateCalls).toBe(1);
    const other = lifecycle.engine.chat({ chatId: "other", message: "other" }).then((value) => {
      completion.push("other");
      return value;
    });
    while (generateCalls < 2) await Promise.resolve();
    expect(generateCalls).toBe(2);
    releaseFirst();
    await Promise.all([first, second, other]);
    expect(completion.indexOf("first")).toBeLessThan(completion.indexOf("second"));
    await lifecycle.close();
  });

  it("atomically supersedes the in-memory runtime overlay for later turns and store windows", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime();
      },
      createBackend: (input) => {
        received.push(input);
        const selected = `${input.ports.config.llm.provider}:${input.ports.config.llm.model}`;
        return backend({ chat: async () => ({ text: selected }) });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });

    await expect(lifecycle.engine.chat({ chatId: "runtime", message: "initial" })).resolves.toEqual(
      {
        text: "anthropic:synthetic",
      },
    );
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openrouter", model: "model-first", api_key: "placeholder" },
    });
    await expect(
      lifecycle.engine.chat({ chatId: "runtime", message: "after-first" }),
    ).resolves.toEqual({
      text: "openrouter:model-first",
    });
    await lifecycle.operations.configureRuntime({
      intervals: { api_key: "placeholder" },
    });
    await lifecycle.operations.configureRuntime({
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "google", model: "model-second", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-b" },
    });
    await expect(
      lifecycle.engine.chat({ chatId: "runtime", message: "after-second" }),
    ).resolves.toEqual({
      text: "google:model-second",
    });

    expect(
      received.map((input) => ({
        provider: input.ports.config.llm.provider,
        model: input.ports.config.llm.model,
        apiKey: input.ports.config.llm.apiKey,
        intervals: input.ports.platform.legacyClient === null,
      })),
    ).toEqual([
      { provider: "anthropic", model: "synthetic", apiKey: "", intervals: true },
      { provider: "openrouter", model: "model-first", apiKey: "placeholder", intervals: true },
      { provider: "openrouter", model: "model-first", apiKey: "placeholder", intervals: false },
      { provider: "openrouter", model: "model-first", apiKey: "placeholder", intervals: false },
      { provider: "google", model: "model-second", apiKey: "placeholder", intervals: false },
    ]);
    expect(new Set(received.map((input) => input.ports.transcriptWriter)).size).toBe(
      received.length,
    );
    expect(new Set(received.map((input) => input.ports.chatStore)).size).toBe(received.length);
    expect(
      received.every((input) => Object.is(input.ports.chatStore, input.ports.transcriptWriter)),
    ).toBe(true);
    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "placeholder",
      athleteId: "athlete-b",
    });
    await lifecycle.close();
  });

  it("publishes engine, memory, session archive, and spend timezone as one drained bundle", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    let enterOld!: () => void;
    let releaseOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      enterOld = resolve;
    });
    const oldRelease = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
      createBackend: (input) => {
        received.push(input);
        const generation = received.length;
        return backend({
          chat: async () => {
            if (generation === 1) {
              enterOld();
              await oldRelease;
            }
            return { text: input.ports.config.session.timezone };
          },
        });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });

    const oldTurn = lifecycle.engine.chat({ chatId: "bundle", message: "hold old bundle" });
    await oldEntered;
    let configurationSettled = false;
    const configuration = lifecycle.operations
      .configureRuntime({
        session: {
          historyTokenBudgetRatio: 0.45,
          idleMinutes: 25,
          dailyResetHour: 6,
          resetArchiveRetentionDays: 9,
          timezone: "America/Los_Angeles",
        },
      })
      .then((result) => {
        configurationSettled = true;
        return result;
      });
    for (let attempt = 0; attempt < 20 && received.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(received).toHaveLength(2);

    let spendSettled = false;
    const postCommitSpend = lifecycle.spendMeter.getSpendSummary().then((summary) => {
      spendSettled = true;
      return summary;
    });
    await Promise.resolve();
    expect(configurationSettled).toBe(false);
    expect(spendSettled).toBe(false);
    expect(runWindowAfter).not.toHaveBeenCalled();

    releaseOld();
    await expect(oldTurn).resolves.toEqual({ text: "UTC" });
    await expect(configuration).resolves.toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: false, intervals: false, session: true },
    });
    await expect(postCommitSpend).resolves.toMatchObject({
      timezone: "America/Los_Angeles",
    });
    await expect(
      lifecycle.engine.chat({ chatId: "bundle", message: "use new bundle" }),
    ).resolves.toEqual({ text: "America/Los_Angeles" });

    expect(received[1]?.ports.config.session).toEqual({
      historyTokenBudgetRatio: 0.45,
      idleMinutes: 25,
      dailyResetHour: 6,
      resetArchiveRetentionDays: 9,
      timezone: "America/Los_Angeles",
    });
    expect(received[1]?.ports.memory).not.toBe(received[0]?.ports.memory);
    expect(received[1]?.ports.chatStore).not.toBe(received[0]?.ports.chatStore);
    expect((received[1]!.ports.memory as unknown as { readonly tz: string }).tz).toBe(
      "America/Los_Angeles",
    );
    expect(
      (
        received[1]!.ports.chatStore as unknown as {
          readonly chatStore: { readonly resetArchiveRetentionDays: number };
        }
      ).chatStore.resetArchiveRetentionDays,
    ).toBe(9);
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      schemaVersion: 3,
      session: {
        historyTokenBudgetRatio: 0.45,
        idleMinutes: 25,
        dailyResetHour: 6,
        resetArchiveRetentionDays: 9,
        timezone: "America/Los_Angeles",
      },
    });
    await lifecycle.close();
  });

  it("drains the active turn before clearing an LLM credential and reports truthful readiness", async () => {
    const home = await freshHome();
    let buildCount = 0;
    const readiness: boolean[] = [];
    let enterOld!: () => void;
    let releaseOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      enterOld = resolve;
    });
    const oldRelease = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const initial: Config = {
      ...config(home),
      llm: { ...config(home).llm, apiKey: "synthetic" },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          buildCount += 1;
          const generation = buildCount;
          readiness.push(input.ports.config.llm.apiKey.length > 0);
          return backend({
            chat: async () => {
              if (generation === 1) {
                enterOld();
                await oldRelease;
              }
              return { text: String(input.ports.config.llm.apiKey.length > 0) };
            },
          });
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    const oldTurn = lifecycle.engine.chat({ chatId: "credential", message: "hold" });
    await oldEntered;
    let deletionSettled = false;
    const deletion = lifecycle.operations
      .configureRuntime({ llm: { provider: "anthropic", clear_credential: true } })
      .then((result) => {
        deletionSettled = true;
        return result;
      });
    for (let attempt = 0; attempt < 20 && buildCount < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(readiness).toEqual([true, false]);
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    releaseOld();
    await expect(oldTurn).resolves.toEqual({ text: "true" });
    await expect(deletion).resolves.toMatchObject({
      status: "applied",
      applied: { llm: true, intervals: false },
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { credential_configured: false },
    });
    await expect(
      lifecycle.engine.chat({ chatId: "credential", message: "after" }),
    ).resolves.toEqual({ text: "false" });
    await lifecycle.close();
  });

  it("refuses to clear a different active LLM credential", async () => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: { ...config(home).llm, apiKey: "synthetic" },
    };
    const createBackend = vi.fn(() => backend());
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await expect(
      lifecycle.operations.configureRuntime({
        llm: { provider: "openai", clear_credential: true },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "refused",
      reason: "credential-required",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "anthropic", credential_configured: true },
    });
    expect(createBackend).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("clears the intervals credential without changing or reclaiming the training-store owner", async () => {
    const home = await freshHome();
    const assertOwner = vi.fn(async () => {});
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: assertOwner,
      },
      fakeContext(home),
      { apiKey: "synthetic", athleteId: "fixed-athlete" },
    );
    const ownerChecksBefore = assertOwner.mock.calls.length;

    await expect(
      lifecycle.operations.configureRuntime({ intervals: { clear_credential: true } }),
    ).resolves.toMatchObject({
      status: "applied",
      applied: { llm: false, intervals: true },
    });

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: {
        athlete_id: "fixed-athlete",
        credential_configured: false,
      },
    });
    expect(assertOwner).toHaveBeenCalledTimes(ownerChecksBefore);
    expect(runWindowAfter).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it.each([
    {
      request: { llm: { provider: "anthropic", clear_credential: true } },
      env: { ANTHROPIC_API_KEY: "synthetic" },
      slot: "llm",
    },
    {
      request: { intervals: { clear_credential: true } },
      env: { INTERVALS_API_KEY: "synthetic" },
      slot: "intervals",
    },
  ] as const)("refuses environment-managed $slot credential deletion", async ({ request, env }) => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home, { apiKey: "synthetic", athleteId: "fixed-athlete" }),
      llm: { ...config(home).llm, apiKey: "synthetic" },
    };
    const createBackend = vi.fn(() => backend());
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
      { ENDURAGENT_HOME: home.root, ...env },
    );

    await expect(lifecycle.operations.configureRuntime(request)).resolves.toEqual({
      schemaVersion: 3,
      status: "refused",
      reason: "managed-by-environment",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      [request.llm === undefined ? "intervals" : "llm"]: {
        credential_configured: true,
      },
    });
    expect(createBackend).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("deletes an active ChatGPT profile inside the drained credential cutover", async () => {
    const home = await freshHome();
    saveStoredProfile(join(home.configDir, "auth-profiles.json"), "openai-codex", {
      type: "oauth",
      access: "synthetic",
      refresh: "synthetic",
      expires: 4_102_444_800_000,
    });
    const initial: Config = {
      ...config(home),
      llm: {
        ...config(home).llm,
        provider: "openai-codex",
        apiKey: "",
        authProfile: "openai-codex",
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await expect(
      lifecycle.operations.configureRuntime({
        llm: { provider: "openai-codex", clear_credential: true },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { llm: true } });
    expect(
      loadStoredProfileSnapshot(join(home.configDir, "auth-profiles.json"), "openai-codex"),
    ).toBeNull();
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "openai-codex", credential_configured: false },
    });
    await lifecycle.close();
  });

  it.each(["claude-cli", "codex-agent"] as const)(
    "reports %s as credential configured without an API key",
    async (provider) => {
      const home = await freshHome();
      const initial: Config = {
        ...config(home),
        llm: { ...config(home).llm, provider, model: "sonnet", apiKey: "" },
      };
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => runtime(),
          createBackend: () => backend(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
        },
        fakeContext(home),
        undefined,
        initial,
      );

      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        llm: { provider, model: "sonnet", credential_configured: true },
      });
      await lifecycle.close();
    },
  );

  it("keeps the ChatGPT profile check ahead of the keyless short circuit", async () => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: {
        ...config(home).llm,
        provider: "openai-codex",
        apiKey: "",
        authProfile: "openai-codex",
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    expect(existsSync(join(home.configDir, "auth-profiles.json"))).toBe(false);
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "openai-codex", credential_configured: false },
    });
    await lifecycle.close();
  });

  it("still reports a keyed provider from its stored API key alone", async () => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: { ...config(home).llm, provider: "anthropic", apiKey: "" },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "anthropic", credential_configured: false },
    });

    await lifecycle.operations.configureRuntime({
      llm: { provider: "anthropic", api_key: "obviously-fake-anthropic-key" },
    });

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "anthropic", credential_configured: true },
    });
    await lifecycle.close();
  });

  it("resolves a blank configured timezone once for every active session consumer", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    const initial = {
      ...config(home),
      session: { ...config(home).session, timezone: "" },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );
    const expectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";

    expect(received[0]?.ports.config.session.timezone).toBe(expectedTimezone);
    expect((received[0]!.ports.memory as unknown as { readonly tz: string }).tz).toBe(
      expectedTimezone,
    );
    await expect(lifecycle.spendMeter.getSpendSummary()).resolves.toMatchObject({
      timezone: expectedTimezone,
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      session: { timezone: expectedTimezone },
    });
    await lifecycle.close();
  });

  it("persists only requested session keys, preserves unknown YAML, and reopens exact values", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        data_source: "store",
        data_dir: home.root,
        retained_top_level: { future: true },
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          resetArchiveRetentionDays: 0,
          timezone: "UTC",
          retained_session_field: { future: true },
        },
      }),
      { mode: 0o600 },
    );
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      config(home),
    );

    await lifecycle.operations.configureRuntime({ session: { idleMinutes: 12 } });
    expect(
      (
        parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8")) as {
          session: Record<string, unknown>;
        }
      ).session,
    ).not.toHaveProperty("timezonePinned");

    await lifecycle.operations.configureRuntime({
      session: { timezone: "Europe/Berlin" },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      data_source: "store",
      data_dir: home.root,
      retained_top_level: { future: true },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 12,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "Europe/Berlin",
        timezonePinned: true,
        retained_session_field: { future: true },
      },
    });

    await lifecycle.operations.configureRuntime({
      session: {
        historyTokenBudgetRatio: 0.55,
        idleMinutes: 35,
        dailyResetHour: 8,
        resetArchiveRetentionDays: 21,
      },
    });
    expect(loadConfig(home.configDir).session).toEqual({
      historyTokenBudgetRatio: 0.55,
      idleMinutes: 35,
      dailyResetHour: 8,
      resetArchiveRetentionDays: 21,
      timezone: "Europe/Berlin",
    });
    expect(
      (
        parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8")) as {
          session: Record<string, unknown>;
        }
      ).session.retained_session_field,
    ).toEqual({ future: true });
    const persistedSession = (
      parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8")) as {
        session: Record<string, unknown>;
      }
    ).session;
    expect(persistedSession.timezonePinned).toBe(true);
    expect((await lifecycle.operations.getRuntimeConfig({})).session).not.toHaveProperty(
      "timezonePinned",
    );
    expect(runWindowAfter).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it.each([
    {
      field: "historyTokenBudgetRatio",
      env: { HISTORY_TOKEN_BUDGET_RATIO: "0.7" },
      patch: { historyTokenBudgetRatio: 0.4, timezone: "Europe/Berlin" },
    },
    {
      field: "idleMinutes",
      env: { SESSION_IDLE_MINUTES: "20" },
      patch: { idleMinutes: 15, timezone: "Europe/Berlin" },
    },
    {
      field: "dailyResetHour",
      env: { SESSION_DAILY_RESET_HOUR: "5" },
      patch: { dailyResetHour: 7, idleMinutes: 15 },
    },
    {
      field: "resetArchiveRetentionDays",
      env: { SESSION_RESET_ARCHIVE_RETENTION_DAYS: "30" },
      patch: { resetArchiveRetentionDays: 14, idleMinutes: 15 },
    },
    {
      field: "timezone",
      env: { COACH_TZ: "UTC" },
      patch: { timezone: "Europe/Berlin", idleMinutes: 15 },
    },
  ] as const)(
    "rejects an atomic session patch when $field is environment-managed",
    async ({ field, env, patch }) => {
      const home = await freshHome();
      const originalYaml = "sentinel: unchanged\n";
      await writeFile(join(home.configDir, "config.yaml"), originalYaml, { mode: 0o600 });
      const createBackend = vi.fn(() => backend());
      const selectedRuntime = runtime();
      const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
          createBackend,
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
        },
        fakeContext(home),
        undefined,
        config(home),
        { ENDURAGENT_HOME: home.root, ...env },
      );
      const before = await lifecycle.operations.getRuntimeConfig({});

      await expect(lifecycle.operations.configureRuntime({ session: patch })).rejects.toThrow(
        `runtime session ${field} is controlled by the daemon environment`,
      );
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual(before);
      expect(before.session.managedByEnvironment[field]).toBe(true);
      expect(createBackend).toHaveBeenCalledOnce();
      expect(runWindowAfter).not.toHaveBeenCalled();
      await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(
        originalYaml,
      );
      await lifecycle.close();
    },
  );

  it("rolls back a session replacement that expires while the active bundle drains", async () => {
    vi.useRealTimers();
    const home = await freshHome();
    let enterOld!: () => void;
    let releaseOld!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      enterOld = resolve;
    });
    const oldRelease = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let builds = 0;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        builds += 1;
        const generation = builds;
        return backend({
          chat: async () => {
            if (generation === 1) {
              enterOld();
              await oldRelease;
            }
            return { text: input.ports.config.session.timezone };
          },
        });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      operationsDependencies: { runtimeConfigurationDeadlineMs: 5 },
    });

    const oldTurn = lifecycle.engine.chat({ chatId: "timeout", message: "hold" });
    await oldEntered;
    const expired = lifecycle.operations.configureRuntime({
      session: { timezone: "Europe/Berlin" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseOld();

    await expect(oldTurn).resolves.toEqual({ text: "UTC" });
    await expect(expired).rejects.toThrow();
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      session: { timezone: "UTC" },
    });
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lifecycle.engine.chat({ chatId: "timeout", message: "still old" }),
    ).resolves.toEqual({ text: "UTC" });
    await lifecycle.close();
  });

  it("forwards scoped chat cancellation through the reconfigurable engine", async () => {
    const home = await freshHome();
    const stopChat = vi.fn(async () => ({ stopped: true }));
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: () => backend({ stopChat }),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });

    await expect(
      lifecycle.engine.stopChat?.({ chatId: "desktop", turnId: "turn-1" }),
    ).resolves.toEqual({
      stopped: true,
    });
    expect(stopChat).toHaveBeenCalledWith({ chatId: "desktop", turnId: "turn-1" });
    await lifecycle.close();
  });

  it("passes reference bootstrap live credentials and calendar zone readers", async () => {
    const home = await freshHome();
    let referenceOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["bootstrap"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async (options) => {
          referenceOptions = options;
          return reference();
        },
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      { apiKey: "current-key", athleteId: "fake-initial-athlete" },
    );

    await lifecycle.operations.configureRuntime({
      intervals: {
        api_key: "placeholder",
        athlete_id: "fake-configured-athlete",
      },
      session: { timezone: "Europe/Berlin" },
    });

    expect(referenceOptions?.readIntervals?.()).toEqual({
      apiKey: "placeholder",
      athleteId: "fake-configured-athlete",
    });
    expect(referenceOptions?.readCalendarTimeZone()).toBe("Europe/Berlin");
    await lifecycle.close();
  });

  it("refreshes the store once with newly applied intervals credentials", async () => {
    const home = await freshHome();
    const windows: Config["intervals"][] = [];
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const counts = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    }).snapshot();
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime([], {
            runWindow: async () => {
              const current = options.readConfig?.();
              if (current === undefined) throw new Error("Expected live runtime configuration.");
              windows.push({ ...current.intervals });
              return {
                published: true,
                counts,
                legacySucceeded: true,
                droppedActivities: EMPTY_DROPPED_ACTIVITIES,
              };
            },
          });
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "current-key", athleteId: "current-athlete" }),
    );

    expect(windows).toEqual([{ apiKey: "current-key", athleteId: "current-athlete" }]);

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "obviously-fake-replayed-key",
          athlete_id: "replayed-athlete",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });

    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "obviously-fake-replayed-key",
      athleteId: "replayed-athlete",
    });
    expect(windows).toEqual([
      { apiKey: "current-key", athleteId: "current-athlete" },
      { apiKey: "obviously-fake-replayed-key", athleteId: "replayed-athlete" },
    ]);
    await lifecycle.close();
  });

  it.each([
    {
      label: "a daemon athlete override",
      activeApiKey: "current-key",
      candidateApiKey: "candidate-key",
      envAthleteId: "environment-athlete",
      ownerFailure: undefined,
      expectedReason: "managed-by-environment",
      expectedOwnerChecks: 0,
    },
    {
      label: "an empty daemon athlete override",
      activeApiKey: "current-key",
      candidateApiKey: "candidate-key",
      envAthleteId: "",
      ownerFailure: undefined,
      expectedReason: "managed-by-environment",
      expectedOwnerChecks: 0,
    },
    {
      label: "a missing active credential",
      activeApiKey: "",
      candidateApiKey: undefined,
      envAthleteId: undefined,
      ownerFailure: "current-credential-missing",
      expectedReason: "credential-required",
      expectedOwnerChecks: 1,
    },
    {
      label: "an unresolved current owner",
      activeApiKey: "current-key",
      candidateApiKey: "candidate-key",
      envAthleteId: undefined,
      ownerFailure: "current-unresolved",
      expectedReason: "ownership-unavailable",
      expectedOwnerChecks: 1,
    },
    {
      label: "an unresolved candidate owner",
      activeApiKey: "current-key",
      candidateApiKey: "candidate-key",
      envAthleteId: undefined,
      ownerFailure: "candidate-unresolved",
      expectedReason: "ownership-unavailable",
      expectedOwnerChecks: 1,
    },
    {
      label: "a mismatched candidate owner",
      activeApiKey: "current-key",
      candidateApiKey: "candidate-key",
      envAthleteId: undefined,
      ownerFailure: "mismatch",
      expectedReason: "training-account-mismatch",
      expectedOwnerChecks: 1,
    },
  ] as const)(
    "fails closed before runtime mutation for $label and keeps serialized lanes usable",
    async ({
      activeApiKey,
      candidateApiKey,
      envAthleteId,
      ownerFailure,
      expectedReason,
      expectedOwnerChecks,
    }) => {
      const home = await freshHome();
      const initialYaml = "sentinel: unchanged\n";
      await writeFile(join(home.configDir, "config.yaml"), initialYaml);
      const selectedRuntime = runtime();
      const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
      const createBackend = vi.fn(() => backend());
      let remainingOwnerFailures = ownerFailure === undefined ? 0 : 1;
      const assertRuntimeAthleteOwner = vi.fn(
        async (
          _store: Parameters<
            NonNullable<LocalCoachCompositionDependencies["assertRuntimeAthleteOwner"]>
          >[0],
          options: Parameters<
            NonNullable<LocalCoachCompositionDependencies["assertRuntimeAthleteOwner"]>
          >[1],
        ) => {
          if (
            ownerFailure !== undefined &&
            remainingOwnerFailures > 0 &&
            (options.current.apiKey !== options.candidate.apiKey ||
              options.current.athleteId !== options.candidate.athleteId)
          ) {
            remainingOwnerFailures -= 1;
            throw new RuntimeAthleteOwnerRefusal(ownerFailure);
          }
        },
      );
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
          createBackend,
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner,
        },
        fakeContext(home),
        undefined,
        config(home, { apiKey: activeApiKey, athleteId: "current-athlete" }),
        {
          ENDURAGENT_HOME: home.root,
          ...(envAthleteId === undefined ? {} : { INTERVALS_ATHLETE_ID: envAthleteId }),
        },
      );
      const ownerChecksBefore = assertRuntimeAthleteOwner.mock.calls.length;
      const before = await lifecycle.operations.getRuntimeConfig({});

      const result = await lifecycle.operations.configureRuntime({
        intervals: {
          ...(candidateApiKey === undefined ? {} : { api_key: candidateApiKey }),
          athlete_id: "candidate-athlete",
        },
      });
      expect(result).toEqual({
        schemaVersion: 3,
        status: "refused",
        reason: expectedReason,
      });

      await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(
        initialYaml,
      );
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual(before);
      expect(createBackend).toHaveBeenCalledTimes(1);
      expect(runWindowAfter).not.toHaveBeenCalled();
      expect(assertRuntimeAthleteOwner.mock.calls.length - ownerChecksBefore).toBe(
        expectedOwnerChecks,
      );
      if (expectedOwnerChecks === 1) {
        expect(assertRuntimeAthleteOwner).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            current: expect.objectContaining({
              apiKey: activeApiKey,
              athleteId: "current-athlete",
            }),
            candidate: expect.objectContaining({
              apiKey: candidateApiKey ?? activeApiKey,
              athleteId: "candidate-athlete",
            }),
          }),
        );
      }

      await expect(
        lifecycle.operations.configureRuntime({ llm: { model: "queue-recovered-model" } }),
      ).resolves.toMatchObject({
        status: "applied",
        applied: { llm: true, intervals: false },
      });
      await expect(
        lifecycle.operations.configureRuntime({ intervals: { api_key: "writer-recovered-key" } }),
      ).resolves.toMatchObject({
        status: "applied",
        applied: { llm: false, intervals: true },
      });
      expect(createBackend).toHaveBeenCalledTimes(3);
      expect(runWindowAfter).toHaveBeenCalledOnce();
      await lifecycle.close();
    },
  );

  it("uses a fresh daemon approval without repeating the owner guard request", async () => {
    const { lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(() =>
      Date.parse("2026-08-11T00:00:00.000Z"),
    );
    const verification = await lifecycle.operations.verify_intervals_credential!({
      api_key: "candidate-key",
    });
    if (!("approval" in verification)) throw new Error("expected credential approval");

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(ownerGuard).not.toHaveBeenCalled();
    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "candidate-key",
          verification_approval: verification.approval,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("repairs a stale configured athlete selector from a verified current-athlete approval", async () => {
    const requestPaths: string[] = [];
    const account = "synthetic-repaired-owner";
    const { home, store, lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "synthetic",
        ownerAccount: account,
        responseForPath: (path) => {
          requestPaths.push(path);
          if (path === "/api/v1/athlete/synthetic") {
            return new Response(null, { status: 403 });
          }
          if (path !== "/api/v1/athlete/0") throw new Error("unexpected request");
          return new Response(
            JSON.stringify({
              sportSettings: [
                {
                  id: 1,
                  athlete_id: account,
                  types: ["Ride"],
                  updated: "2026-01-01",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const verification = await lifecycle.operations.verify_intervals_credential!({
      api_key: "candidate-key",
    });
    if (!("approval" in verification)) throw new Error("expected credential approval");

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "candidate-key",
          verification_approval: verification.approval,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "0", credential_configured: true },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toMatchObject({
      intervals: { athlete_id: "0" },
    });
    await expect(readIntervalsStoreOwnerState(store)).resolves.toEqual({
      status: "owned",
      fingerprint: intervalsAccountFingerprint(account),
    });
    expect(requestPaths).toEqual(["/api/v1/athlete/synthetic", "/api/v1/athlete/0"]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("retains a working custom athlete selector without a fallback request", async () => {
    const requestPaths: string[] = [];
    const { lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "selected-athlete",
        responseForPath: (path) => {
          requestPaths.push(path);
          if (path !== "/api/v1/athlete/selected-athlete") {
            throw new Error("unexpected request");
          }
          return new Response(
            JSON.stringify({
              sportSettings: [
                {
                  id: 1,
                  athlete_id: "synthetic-selected-owner",
                  types: ["Ride"],
                  updated: "2026-01-01",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const verification = await lifecycle.operations.verify_intervals_credential!({
      api_key: "candidate-key",
    });
    if (!("approval" in verification)) throw new Error("expected credential approval");

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "candidate-key",
          verification_approval: verification.approval,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "selected-athlete", credential_configured: true },
    });
    expect(requestPaths).toEqual(["/api/v1/athlete/selected-athlete"]);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("rejects an invalid credential after checking the configured and current-athlete selectors", async () => {
    const requestPaths: string[] = [];
    const { store, lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "synthetic",
        responseForPath: (path) => {
          requestPaths.push(path);
          return new Response(null, { status: 403 });
        },
      },
    );

    await expect(
      lifecycle.operations.verify_intervals_credential!({ api_key: "invalid-key" }),
    ).resolves.toEqual({ reason: "credential-rejected" });
    expect(requestPaths).toEqual(["/api/v1/athlete/synthetic", "/api/v1/athlete/0"]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(ownerGuard).not.toHaveBeenCalled();
    await expect(readIntervalsStoreOwnerState(store)).resolves.toEqual({ status: "unowned" });
    await lifecycle.close();
  });

  it("refuses selector repair when the verified current athlete differs from the stored owner", async () => {
    const requestPaths: string[] = [];
    const existingAccount = "synthetic-existing-owner";
    const { home, store, lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "synthetic",
        ownerAccount: existingAccount,
        responseForPath: (path) => {
          requestPaths.push(path);
          if (path === "/api/v1/athlete/synthetic") {
            return new Response(null, { status: 403 });
          }
          if (path !== "/api/v1/athlete/0") throw new Error("unexpected request");
          return new Response(
            JSON.stringify({
              sportSettings: [
                {
                  id: 1,
                  athlete_id: "synthetic-different-owner",
                  types: ["Ride"],
                  updated: "2026-01-01",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const initialYaml = "sentinel: unchanged\n";
    await writeFile(join(home.configDir, "config.yaml"), initialYaml);
    const before = await lifecycle.operations.getRuntimeConfig({});

    await expect(
      lifecycle.operations.verify_intervals_credential!({ api_key: "candidate-key" }),
    ).resolves.toEqual({ reason: "training-account-mismatch" });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual(before);
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(initialYaml);
    await expect(readIntervalsStoreOwnerState(store)).resolves.toEqual({
      status: "owned",
      fingerprint: intervalsAccountFingerprint(existingAccount),
    });
    expect(requestPaths).toEqual(["/api/v1/athlete/synthetic", "/api/v1/athlete/0"]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it.each([
    { label: "bare unowned store", legacyData: false },
    { label: "unowned store with legacy data", legacyData: true },
  ])("refuses selector repair for a $label", async ({ legacyData }) => {
    const requestPaths: string[] = [];
    const { home, store, lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "synthetic",
        legacyData,
        responseForPath: (path) => {
          requestPaths.push(path);
          if (path === "/api/v1/athlete/synthetic") {
            return new Response(null, { status: 403 });
          }
          if (path !== "/api/v1/athlete/0") throw new Error("unexpected request");
          return new Response(
            JSON.stringify({
              sportSettings: [
                {
                  id: 1,
                  athlete_id: "synthetic-unowned-owner",
                  types: ["Ride"],
                  updated: "2026-01-01",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const initialYaml = "sentinel: unchanged\n";
    await writeFile(join(home.configDir, "config.yaml"), initialYaml);
    const before = await lifecycle.operations.getRuntimeConfig({});

    await expect(
      lifecycle.operations.verify_intervals_credential!({ api_key: "candidate-key" }),
    ).resolves.toEqual({ reason: "owner-unresolved" });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual(before);
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(initialYaml);
    await expect(readIntervalsStoreOwnerState(store)).resolves.toEqual({ status: "unowned" });
    await expect(store.get("SELECT count(*) AS count FROM source_watermark")).resolves.toEqual({
      count: legacyData ? 1 : 0,
    });
    expect(requestPaths).toEqual(["/api/v1/athlete/synthetic", "/api/v1/athlete/0"]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("refuses selector repair when the athlete selector is managed by the environment", async () => {
    const requestPaths: string[] = [];
    const account = "synthetic-managed-owner";
    const { home, store, lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(
      () => Date.parse("2026-08-11T00:00:00.000Z"),
      {
        athleteId: "synthetic",
        env: { INTERVALS_ATHLETE_ID: "synthetic" },
        ownerAccount: account,
        responseForPath: (path) => {
          requestPaths.push(path);
          if (path === "/api/v1/athlete/synthetic") {
            return new Response(null, { status: 403 });
          }
          if (path !== "/api/v1/athlete/0") throw new Error("unexpected request");
          return new Response(
            JSON.stringify({
              sportSettings: [
                {
                  id: 1,
                  athlete_id: account,
                  types: ["Ride"],
                  updated: "2026-01-01",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const initialYaml = "sentinel: unchanged\n";
    await writeFile(join(home.configDir, "config.yaml"), initialYaml);
    const before = await lifecycle.operations.getRuntimeConfig({});
    const verification = await lifecycle.operations.verify_intervals_credential!({
      api_key: "candidate-key",
    });
    if (!("approval" in verification)) throw new Error("expected credential approval");

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "candidate-key",
          verification_approval: verification.approval,
        },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "refused",
      reason: "managed-by-environment",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual(before);
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(initialYaml);
    await expect(readIntervalsStoreOwnerState(store)).resolves.toEqual({
      status: "owned",
      fingerprint: intervalsAccountFingerprint(account),
    });
    expect(requestPaths).toEqual(["/api/v1/athlete/synthetic", "/api/v1/athlete/0"]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(ownerGuard).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it.each(["invalid", "expired", "reused"] as const)(
    "falls back to the existing owner guard for an %s approval",
    async (scenario) => {
      let now = Date.parse("2026-08-11T00:00:00.000Z");
      const { lifecycle, ownerGuard, fetchStub } = await intervalsApprovalFixture(() => now);
      const verification = await lifecycle.operations.verify_intervals_credential!({
        api_key: "candidate-key",
      });
      if (!("approval" in verification)) throw new Error("expected credential approval");
      let approval = verification.approval;

      if (scenario === "invalid") {
        approval = `${approval[0] === "0" ? "1" : "0"}${approval.slice(1)}`;
      } else if (scenario === "expired") {
        now += INTERVALS_CREDENTIAL_APPROVAL_TTL_MS;
      } else {
        await expect(
          lifecycle.operations.configureRuntime({
            intervals: { api_key: "candidate-key", verification_approval: approval },
          }),
        ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
        await expect(
          lifecycle.operations.configureRuntime({ intervals: { clear_credential: true } }),
        ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
      }

      const ownerCallsBefore = ownerGuard.mock.calls.length;
      await expect(
        lifecycle.operations.configureRuntime({
          intervals: { api_key: "candidate-key", verification_approval: approval },
        }),
      ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
      expect(ownerGuard.mock.calls.length - ownerCallsBefore).toBe(1);
      expect(fetchStub).toHaveBeenCalledOnce();
      await lifecycle.close();
    },
  );

  it("refuses an environment-managed athlete field even when the requested value is unchanged", async () => {
    const home = await freshHome();
    const initialYaml = "sentinel: unchanged\n";
    await writeFile(join(home.configDir, "config.yaml"), initialYaml);
    const createBackend = vi.fn(() => backend());
    const assertRuntimeAthleteOwner = vi.fn(async () => {});
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "current-key", athleteId: "environment-athlete" }),
      {
        ENDURAGENT_HOME: home.root,
        COACH_TZ: "UTC",
        INTERVALS_ATHLETE_ID: "environment-athlete",
      },
    );
    const ownerChecksBefore = assertRuntimeAthleteOwner.mock.calls.length;
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: {
        athlete_id: "environment-athlete",
        credential_configured: true,
        managedByEnvironment: { athleteId: true },
      },
    });

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { athlete_id: "environment-athlete" },
        session: { timezone: "Asia/Almaty" },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "refused",
      reason: "managed-by-environment",
    });
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(ownerChecksBefore);
    expect(createBackend).toHaveBeenCalledOnce();
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(initialYaml);
    await lifecycle.close();
  });

  it.each([
    { envApiKey: "environment-key", rejected: true },
    { envApiKey: "", rejected: false },
  ])(
    "treats daemon API-key environment value '$envApiKey' as effective authority: $rejected",
    async ({ envApiKey, rejected }) => {
      const home = await freshHome();
      const selectedRuntime = runtime();
      const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
      const createBackend = vi.fn(() => backend());
      const assertRuntimeAthleteOwner = vi.fn(async () => {});
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
          createBackend,
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner,
        },
        fakeContext(home),
        { apiKey: "current-key", athleteId: "0" },
        undefined,
        { ENDURAGENT_HOME: home.root, INTERVALS_API_KEY: envApiKey },
      );
      const ownerChecksBefore = assertRuntimeAthleteOwner.mock.calls.length;
      const change = lifecycle.operations.configureRuntime({
        intervals: { api_key: "candidate-key" },
      });

      if (rejected) {
        await expect(change).rejects.toThrow(
          "runtime intervals credential is controlled by the daemon environment",
        );
        expect(createBackend).toHaveBeenCalledTimes(1);
        expect(runWindowAfter).not.toHaveBeenCalled();
        expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(ownerChecksBefore);
      } else {
        await expect(change).resolves.toMatchObject({
          status: "applied",
          applied: { intervals: true },
        });
        expect(createBackend).toHaveBeenCalledTimes(2);
        expect(runWindowAfter).toHaveBeenCalledOnce();
        expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(ownerChecksBefore + 1);
      }
      await lifecycle.close();
    },
  );

  it("guards a combined first credential and canonical athlete selection", async () => {
    const home = await freshHome();
    const assertRuntimeAthleteOwner = vi.fn(async () => {});
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "", athleteId: "" }),
    );

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { api_key: "candidate-key", athlete_id: "first-athlete" },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledOnce();
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        current: expect.objectContaining({ apiKey: "", athleteId: "0" }),
        candidate: expect.objectContaining({
          apiKey: "candidate-key",
          athleteId: "first-athlete",
        }),
        claimUnownedCandidateWithoutCurrent: true,
      }),
    );
    await lifecycle.close();
  });

  it.each(["oauth-validation", "persistence"] as const)(
    "does not claim a first credential after downstream %s failure",
    async (failurePoint) => {
      const home = await freshHome();
      if (failurePoint === "oauth-validation") {
        await writeFile(
          join(home.configDir, "auth-profiles.json"),
          JSON.stringify({ "openai-codex": { type: "oauth" } }),
          { mode: 0o600 },
        );
      }
      const claim = vi.fn(async () => {});
      const createBackend = vi.fn(() => backend());
      const selectedRuntime = runtime();
      const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
      const lifecycle = await compose(
        home,
        {
          bootstrap: async () => reference(),
          createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
          createBackend,
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner: async () => ({ claim }),
          ...(failurePoint === "persistence"
            ? {
                persistRuntimeConfig: () => {
                  throw new Error("synthetic persistence failure");
                },
              }
            : {}),
        },
        fakeContext(home),
        undefined,
        config(home, { apiKey: "", athleteId: "" }),
      );

      await expect(
        lifecycle.operations.configureRuntime({
          intervals: { api_key: "candidate-key", athlete_id: "first-athlete" },
          ...(failurePoint === "oauth-validation"
            ? { llm: { provider: "openai-codex", model: "gpt-5.5" } }
            : {}),
        }),
      ).rejects.toThrow(
        failurePoint === "oauth-validation"
          ? "OAuth profile is invalid."
          : "synthetic persistence failure",
      );
      expect(claim).not.toHaveBeenCalled();
      expect(createBackend).toHaveBeenCalledTimes(failurePoint === "oauth-validation" ? 1 : 2);
      expect(runWindowAfter).not.toHaveBeenCalled();
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        intervals: { athlete_id: "" },
      });
      await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await lifecycle.close();
    },
  );

  it("restores runtime configuration when a deferred first-account claim fails", async () => {
    const home = await freshHome();
    const originalYaml = "sentinel: unchanged\n";
    await writeFile(join(home.configDir, "config.yaml"), originalYaml, { mode: 0o600 });
    const claim = vi.fn(async () => {
      throw new Error("synthetic owner claim failure");
    });
    const createBackend = vi.fn(() => backend());
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({ ...selectedRuntime, runWindowAfter }),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner: async () => ({ claim }),
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "", athleteId: "" }),
    );

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { api_key: "candidate-key", athlete_id: "first-athlete" },
      }),
    ).rejects.toThrow("synthetic owner claim failure");
    expect(claim).toHaveBeenCalledOnce();
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(runWindowAfter).not.toHaveBeenCalled();
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "" },
    });
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).resolves.toBe(originalYaml);
    await lifecycle.close();
  });

  it("guards a key-only change for canonical athlete zero", async () => {
    const home = await freshHome();
    const assertRuntimeAthleteOwner = vi.fn(
      async (
        _store: Parameters<
          NonNullable<LocalCoachCompositionDependencies["assertRuntimeAthleteOwner"]>
        >[0],
        _options: Parameters<
          NonNullable<LocalCoachCompositionDependencies["assertRuntimeAthleteOwner"]>
        >[1],
      ) => {},
    );
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "current-key", athleteId: "" }),
    );
    const ownerChecksBefore = assertRuntimeAthleteOwner.mock.calls.length;

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { api_key: "candidate-key" },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(ownerChecksBefore + 1);
    expect(assertRuntimeAthleteOwner.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        current: expect.objectContaining({ apiKey: "current-key", athleteId: "0" }),
        candidate: expect.objectContaining({ apiKey: "candidate-key", athleteId: "0" }),
      }),
    );
    await lifecycle.close();
  });

  it("validates and canonicalizes a configured account before the first provider window", async () => {
    const home = await freshHome();
    const trace: string[] = [];
    const selectedRuntime = runtime();
    const assertRuntimeAthleteOwner = vi.fn(async (_store, options) => {
      trace.push(`owner:${options.candidate.athleteId}`);
    });
    const createRuntime = vi.fn((options: LocalStoreRuntimeOptions) => {
      if (options.readConfig === undefined) throw new Error("Expected live runtime configuration.");
      const readConfig = options.readConfig;
      trace.push(`runtime:${options.config.intervals.athleteId}`);
      return {
        ...selectedRuntime,
        async runWindow() {
          trace.push(`window:${readConfig().intervals.athleteId}`);
          return selectedRuntime.runWindow();
        },
      };
    });

    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime,
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      undefined,
      config(home, { apiKey: "configured-key", athleteId: "" }),
    );

    expect(trace.slice(0, 3)).toEqual(["owner:0", "runtime:0", "window:0"]);
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("does not create a provider runtime after configured account ownership is refused", async () => {
    const home = await freshHome();
    const bootstrap = vi.fn(async () => reference());
    const createRuntime = vi.fn(() => runtime());

    await expect(
      compose(
        home,
        {
          bootstrap,
          createRuntime,
          createBackend: () => backend(),
          createRepository: () => ({
            insertIfAbsent: async () => false,
            readCurrent: async () => undefined,
          }),
          createResolver: () => missingResolver(),
          assertRuntimeAthleteOwner: async () => {
            throw new Error("synthetic configured account mismatch");
          },
        },
        fakeContext(home),
        { apiKey: "configured-key", athleteId: "configured-athlete" },
      ),
    ).rejects.toThrow("synthetic configured account mismatch");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("does not resolve identity when the athlete ID is unchanged", async () => {
    const home = await freshHome();
    const assertRuntimeAthleteOwner = vi.fn(async () => {});
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      { apiKey: "current-key", athleteId: "current-athlete" },
    );
    const ownerChecksBefore = assertRuntimeAthleteOwner.mock.calls.length;

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: { api_key: "current-key", athlete_id: "current-athlete" },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(assertRuntimeAthleteOwner).toHaveBeenCalledTimes(ownerChecksBefore);
    await lifecycle.close();
  });

  it("applies an owner-approved athlete ID change before replacing and refreshing", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        retained_root: true,
        intervals: { athlete_id: "current-athlete", retained_intervals: true },
      }),
    );
    const selectedRuntime = runtime();
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const createBackend = vi.fn(() => backend());
    const assertRuntimeAthleteOwner = vi.fn(async () => {});
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return { ...selectedRuntime, runWindowAfter };
        },
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        assertRuntimeAthleteOwner,
      },
      fakeContext(home),
      { apiKey: "current-key", athleteId: "current-athlete" },
    );

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "candidate-key",
          athlete_id: "candidate-athlete",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });

    expect(assertRuntimeAthleteOwner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        current: expect.objectContaining({
          apiKey: "current-key",
          athleteId: "current-athlete",
        }),
        candidate: expect.objectContaining({
          apiKey: "candidate-key",
          athleteId: "candidate-athlete",
        }),
      }),
    );
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      retained_root: true,
      intervals: {
        athlete_id: "candidate-athlete",
        retained_intervals: true,
      },
    });
    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "candidate-key",
      athleteId: "candidate-athlete",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "candidate-athlete" },
    });
    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(runWindowAfter).toHaveBeenCalledOnce();
    await lifecycle.close();
  });

  it("does not refresh the store after an LLM-only runtime patch", async () => {
    const home = await freshHome();
    const selectedRuntime = runtime();
    const runWindow = vi.fn(selectedRuntime.runWindow);
    const runWindowAfter = vi.fn(selectedRuntime.runWindowAfter);
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => ({ ...selectedRuntime, runWindow, runWindowAfter }),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });

    expect(runWindow).toHaveBeenCalledTimes(1);
    expect(runWindowAfter).not.toHaveBeenCalled();

    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "openrouter",
        model: "replacement-model",
        api_key: "obviously-fake-llm-key",
      },
    });

    expect(runWindow).toHaveBeenCalledTimes(1);
    expect(runWindowAfter).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("queues a new-credential store window behind an active old-credential window", async () => {
    const home = await freshHome();
    const windows: Config["intervals"][] = [];
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    let releaseOldWindow!: () => void;
    const oldWindowGate = new Promise<void>((resolve) => {
      releaseOldWindow = resolve;
    });
    let markOldWindowStarted!: () => void;
    const oldWindowStarted = new Promise<void>((resolve) => {
      markOldWindowStarted = resolve;
    });
    let markSuccessorStarted!: () => void;
    const successorStarted = new Promise<void>((resolve) => {
      markSuccessorStarted = resolve;
    });
    const counts = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    }).snapshot();
    const result = {
      published: true,
      counts,
      legacySucceeded: true,
      droppedActivities: EMPTY_DROPPED_ACTIVITIES,
    };
    let active: ReturnType<LocalStoreRuntime["runWindow"]> | undefined;
    let windowCount = 0;
    const launchWindow = (): ReturnType<LocalStoreRuntime["runWindow"]> => {
      const current = runtimeOptions?.readConfig?.();
      if (current === undefined) throw new Error("Expected live runtime configuration.");
      windows.push({ ...current.intervals });
      windowCount += 1;
      const currentWindow = (async () => {
        if (windowCount === 2) {
          markOldWindowStarted();
          await oldWindowGate;
        }
        if (windowCount === 3) markSuccessorStarted();
        return result;
      })();
      active = currentWindow;
      void currentWindow
        .finally(() => {
          if (active === currentWindow) active = undefined;
        })
        .catch(() => {});
      return currentWindow;
    };
    const runWindow = vi.fn<LocalStoreRuntime["runWindow"]>(() => active ?? launchWindow());
    const runWindowAfter = vi.fn<LocalStoreRuntime["runWindowAfter"]>(async (work) => {
      const previous = active;
      if (previous !== undefined) {
        try {
          await previous;
        } catch {}
      }
      await work(new AbortController().signal);
      return launchWindow();
    });
    const baseRuntime = runtime();
    const selectedRuntime: LocalStoreRuntime = {
      ...baseRuntime,
      runWindow,
      runWindowAfter,
      async close() {
        try {
          await active;
        } catch {}
        await baseRuntime.close();
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return selectedRuntime;
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      config(home, {
        apiKey: "obviously-fake-old-key",
        athleteId: "old-athlete",
      }),
    );
    expect(windows).toEqual([{ apiKey: "obviously-fake-old-key", athleteId: "old-athlete" }]);

    const oldWindow = selectedRuntime.runWindow();
    await oldWindowStarted;
    expect(windows).toEqual([
      { apiKey: "obviously-fake-old-key", athleteId: "old-athlete" },
      { apiKey: "obviously-fake-old-key", athleteId: "old-athlete" },
    ]);

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "obviously-fake-new-key",
          athlete_id: "new-athlete",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(runWindowAfter).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(2);

    releaseOldWindow();
    await oldWindow;
    await successorStarted;

    expect(windows).toEqual([
      { apiKey: "obviously-fake-old-key", athleteId: "old-athlete" },
      { apiKey: "obviously-fake-old-key", athleteId: "old-athlete" },
      { apiKey: "obviously-fake-new-key", athleteId: "new-athlete" },
    ]);
    await lifecycle.close();
  });

  it("keeps runtime configuration successful when its background store refresh fails", async () => {
    const home = await freshHome();
    const failure = new Error("synthetic background capture failure");
    let rejectRefresh!: (reason: unknown) => void;
    const initial = runtime();
    const runWindowAfter = vi.fn<LocalStoreRuntime["runWindowAfter"]>().mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => ({ ...initial, runWindowAfter }),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      { apiKey: "current-key", athleteId: "current-athlete" },
    );

    await expect(
      lifecycle.operations.configureRuntime({
        intervals: {
          api_key: "obviously-fake-replayed-key",
          athlete_id: "replayed-athlete",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", applied: { intervals: true } });
    expect(runWindowAfter).toHaveBeenCalledTimes(1);

    rejectRefresh(failure);
    await Promise.resolve();
    await Promise.resolve();

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "replayed-athlete" },
    });
    await lifecycle.close();
  });

  it("persists a keyless Codex selection that reloads as ready with a valid profile", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
          accountId: "obviously-fake-account",
        },
      }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received.push(input);
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    expect(received.at(-1)?.ports.config.llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    const persisted = await readFile(join(home.configDir, "config.yaml"), "utf8");
    expect(persisted).toContain("provider: openai-codex");
    expect(persisted).not.toContain("api_key");
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    await expect(checkHomeReadiness(home)).resolves.toMatchObject({ status: "ready" });
    await lifecycle.close();
  });

  it("activates the default Codex profile for an explicit same-provider selection", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "test-profile": {
          type: "oauth",
          access: "obviously-fake-custom-access",
          refresh: "obviously-fake-custom-refresh",
          expires: 4_102_444_800_000,
        },
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-default-access",
          refresh: "obviously-fake-default-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        llm: {
          provider: "openai-codex",
          model: "custom-chat-model",
          auth_profile: "test-profile",
        },
      }),
      { mode: 0o600 },
    );
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openai-codex",
        model: "custom-chat-model",
        apiKey: "",
        authProfile: "test-profile",
        compactModel: "custom-chat-model",
      },
    };
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "custom-chat-model",
      authProfile: "test-profile",
    });
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );
    expect(received[0]?.ports.config.llm.authProfile).toBe("test-profile");
    await expect(received[0]?.ports.getAccessToken("test-profile")).resolves.toBe(
      "obviously-fake-custom-access",
    );

    await lifecycle.operations.configureRuntime({ llm: { provider: "openai-codex" } });

    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "custom-chat-model",
      authProfile: "openai-codex",
      compactModel: "custom-chat-model",
    });
    expect(received).toHaveLength(2);
    expect(received.at(-1)?.ports.config.llm.authProfile).toBe("openai-codex");
    await expect(received.at(-1)?.ports.getAccessToken("openai-codex")).resolves.toBe(
      "obviously-fake-default-access",
    );
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toMatchObject({
      llm: { auth_profile: "openai-codex" },
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "openai-codex",
      model: "custom-chat-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("test-profile");
    expect(JSON.stringify(snapshot)).not.toContain(home.configDir);
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-default-access");
    await rm(join(home.configDir, "auth-profiles.json"));
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "openai-codex", credential_configured: false },
    });
    await lifecycle.close();
  });

  it("preserves a custom Codex profile when a live LLM patch omits provider", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "test-profile": {
          type: "oauth",
          access: "obviously-fake-custom-access",
          refresh: "obviously-fake-custom-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        llm: {
          provider: "openai-codex",
          model: "custom-chat-model",
          auth_profile: "test-profile",
        },
      }),
      { mode: 0o600 },
    );
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openai-codex",
        model: "custom-chat-model",
        apiKey: "",
        authProfile: "test-profile",
        compactModel: "custom-chat-model",
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({ llm: { model: "new-chat-model" } });

    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "new-chat-model",
      authProfile: "test-profile",
      compactModel: "new-chat-model",
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "openai-codex",
      model: "new-chat-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("test-profile");
    await lifecycle.close();
  });

  it("preserves an implicit-provider YAML key across a model-only patch and reload", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        data_source: "store",
        data_dir: home.root,
        llm: {
          model: "old-model",
          api_key: "obviously-fake-implicit-provider-key",
          retained_llm_field: true,
        },
      }),
      { mode: 0o600 },
    );
    const initial = loadConfig(home.configDir);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({ llm: { model: "new-model" } });

    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      data_source: "store",
      data_dir: home.root,
      llm: {
        provider: "anthropic",
        model: "new-model",
        api_key: "obviously-fake-implicit-provider-key",
        compact_model: "claude-haiku-4-5-20251001",
        retained_llm_field: true,
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "anthropic",
      model: "new-model",
      apiKey: "obviously-fake-implicit-provider-key",
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toMatchObject({
      provider: "anthropic",
      model: "new-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-implicit-provider-key");
    await lifecycle.close();
  });

  it("forwards a claude-cli runtime block into the resolved and persisted configuration", async () => {
    const home = await freshHome();
    const initial = config(home);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "claude-cli",
        model: "sonnet",
        claude_cli: {
          enabled: true,
          binary_path: "/synthetic/bin/claude",
          billing: "api-key",
        },
      },
    });

    const persisted = parseYaml(
      await readFile(join(home.configDir, "config.yaml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(persisted.llm!.claude_cli).toEqual({
      enabled: true,
      binary_path: "/synthetic/bin/claude",
      billing: "api-key",
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "claude-cli",
      model: "sonnet",
      claudeCli: {
        enabled: true,
        binaryPath: "/synthetic/bin/claude",
        billing: "api-key",
      },
    });
    await lifecycle.close();
  });

  it("starts and snapshots the Desktop seeded blank athlete ID", async () => {
    const home = await freshHome();
    const initial = config(home, { apiKey: "", athleteId: "" });
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { credential_configured: false },
      intervals: {
        athlete_id: "",
        credential_configured: false,
        managedByEnvironment: { athleteId: false },
      },
    });
    expect(() =>
      lifecycle.operations.configureRuntime({ intervals: { athlete_id: "" } } as never),
    ).toThrow("Too small");

    await lifecycle.operations.configureRuntime({
      intervals: { api_key: "obviously-fake-intervals-key" },
    });

    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "obviously-fake-intervals-key",
      athleteId: "0",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: {
        athlete_id: "0",
        credential_configured: true,
        managedByEnvironment: { athleteId: false },
      },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toMatchObject({
      intervals: { athlete_id: "0" },
    });
    expect(loadConfig(home.configDir).intervals.athleteId).toBe("0");
    await lifecycle.close();
  });

  it.each([
    ["ordinary custom endpoint", "https://api.example.invalid/tenant/opaque-access-segment/v1"],
    ["path-bearing opaque value", "opaque-endpoint/tenant/opaque-access-segment/v1"],
  ])("omits a configured %s from runtime snapshots", async (_case, baseUrl) => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "anthropic",
        model: "synthetic",
        apiKey: "",
        baseUrl,
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "anthropic",
      model: "synthetic",
      credential_configured: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(baseUrl);
    await lifecycle.close();
  });

  it.each([
    ["newline", "https://api.example.invalid/v1\nobviously-fake-marker"],
    ["tab", "https://api.example.invalid/v1\tobviously-fake-marker"],
    ["leading whitespace", " https://api.example.invalid/obviously-fake-marker"],
    ["trailing whitespace", "https://api.example.invalid/obviously-fake-marker "],
    ["empty query", "https://api.example.invalid/obviously-fake-marker?"],
    ["empty fragment", "https://api.example.invalid/obviously-fake-marker#"],
    ["backslashes", "https:\\api.example.invalid\\obviously-fake-marker"],
    ["host case normalization", "https://API.EXAMPLE.INVALID/obviously-fake-marker"],
    ["default port normalization", "https://api.example.invalid:443/obviously-fake-marker"],
    ["userinfo", "https://obviously-fake-marker:synthetic-pass@api.example.invalid/v1"],
    ["query", "https://api.example.invalid/v1?signature=obviously-fake-marker"],
    ["fragment", "https://api.example.invalid/v1#obviously-fake-marker"],
    ["non-HTTP protocol", "ftp://api.example.invalid/obviously-fake-marker"],
    ["invalid", "not-a-url-obviously-fake-marker"],
  ])("omits a legacy %s base URL from runtime snapshots", async (_case, baseUrl) => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: { provider: "anthropic", model: "synthetic", apiKey: "", baseUrl },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "anthropic",
      model: "synthetic",
      credential_configured: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-marker");
    await lifecycle.close();
  });

  it("preserves custom same-provider settings and the athlete ID for credential-only patches", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        retained_top_level: true,
        llm: {
          provider: "openrouter",
          model: "previous-model",
          auth_profile: "openai-codex",
          api_key: "obviously-fake-persisted-llm-key",
          base_url: "https://invalid.example.test/v1",
          flush_model: "previous-flush-model",
          compact_model: "previous-compact-model",
          retained_llm_field: true,
        },
        intervals: {
          athlete_id: "previous-athlete",
          api_key: "obviously-fake-persisted-intervals-key",
          retained_intervals_field: true,
        },
      }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openrouter",
        model: "previous-model",
        apiKey: "obviously-fake-active-llm-key",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: {
        apiKey: "obviously-fake-active-intervals-key",
        athleteId: "previous-athlete",
      },
      contextWindowTokens: 200_000,
    };
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );
    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "openrouter",
        api_key: "obviously-fake-request-llm-key",
      },
      intervals: {
        api_key: "obviously-fake-request-intervals-key",
      },
    });
    const persisted = parseYaml(
      await readFile(join(home.configDir, "config.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "openrouter",
        model: "previous-model",
        api_key: "obviously-fake-persisted-llm-key",
        base_url: "https://invalid.example.test/v1",
        flush_model: "previous-flush-model",
        compact_model: "previous-compact-model",
        retained_llm_field: true,
      },
      intervals: {
        athlete_id: "previous-athlete",
        api_key: "obviously-fake-persisted-intervals-key",
        retained_intervals_field: true,
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("obviously-fake-request");
    expect(loadConfig(home.configDir)).toMatchObject({
      llm: {
        provider: "openrouter",
        model: "previous-model",
        apiKey: "obviously-fake-persisted-llm-key",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: {
        athleteId: "previous-athlete",
        apiKey: "obviously-fake-persisted-intervals-key",
      },
    });
    expect(received.at(-1)?.ports.config.llm).toMatchObject({
      provider: "openrouter",
      model: "previous-model",
      apiKey: "obviously-fake-request-llm-key",
      baseUrl: "https://invalid.example.test/v1",
      flushModel: "previous-flush-model",
      compactModel: "previous-compact-model",
    });
    expect(runtimeOptions?.readConfig?.()).toMatchObject({
      llm: {
        provider: "openrouter",
        model: "previous-model",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: { athleteId: "previous-athlete" },
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual({
      schemaVersion: 3,
      llm: {
        provider: "openrouter",
        model: "previous-model",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "previous-athlete",
        credential_configured: true,
        credential_verification_pending: false,
        managedByEnvironment: { athleteId: false },
      },
      session: {
        ...initial.session,
        managedByEnvironment: {
          historyTokenBudgetRatio: false,
          idleMinutes: false,
          dailyResetHour: false,
          resetArchiveRetentionDays: false,
          timezone: false,
        },
      },
    });
    await lifecycle.close();
  });

  it("applies canonical defaults when switching from a one-million to a 200k context", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "obviously-fake-anthropic-key",
        baseUrl: "https://invalid.example.test/old",
        flushModel: "old-flush-model",
        compactModel: "old-compact-model",
      },
      contextWindowTokens: 1_000_000,
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({
      llm: { provider: "zai", api_key: "obviously-fake-zai-key" },
    });

    expect(received.at(-1)?.ports.config).toMatchObject({
      contextWindowTokens: 200_000,
      llm: {
        provider: "zai",
        model: "glm-4.7",
        apiKey: "obviously-fake-zai-key",
        baseUrl: "https://api.z.ai/api/openai/v1",
        flushModel: undefined,
        compactModel: "glm-4.7",
      },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      llm: {
        provider: "zai",
        model: "glm-4.7",
        base_url: "https://api.z.ai/api/openai/v1",
        compact_model: "glm-4.7",
      },
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: {
        provider: "zai",
        model: "glm-4.7",
      },
    });
    await lifecycle.close();
  });

  it("drops provider-scoped fields on switches and updates Codex auth profile ownership", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        retained_top_level: true,
        llm: {
          provider: "openai-codex",
          model: "previous-model",
          auth_profile: "openai-codex",
          api_key: "obviously-fake-stale-key",
          base_url: "https://invalid.example.test/v1",
          flush_model: "previous-flush-model",
          compact_model: "previous-compact-model",
          retained_llm_field: true,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "google",
        model: "replacement-model",
        api_key: "obviously-fake-request-key",
      },
    });
    let persisted = parseYaml(
      await readFile(join(home.configDir, "config.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "google",
        model: "replacement-model",
        compact_model: "replacement-model",
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "google",
      model: "replacement-model",
      apiKey: "",
      authProfile: undefined,
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    persisted = parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "openai-codex",
        model: "gpt-5.5",
        auth_profile: "openai-codex",
        compact_model: "gpt-5.5",
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    await lifecycle.close();
  });

  it("rejects a Codex runtime selection before replacement when its profile is invalid", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({ "openai-codex": { type: "oauth" } }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received.push(input);
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await expect(
      lifecycle.operations.configureRuntime({
        llm: { provider: "openai-codex", model: "gpt-5.5" },
      }),
    ).rejects.toThrow("OAuth profile is invalid.");
    expect(received).toHaveLength(1);
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await lifecycle.close();
  });

  it.each(["build", "persist"] as const)(
    "does not publish or overwrite YAML after a failed candidate %s",
    async (failurePoint) => {
      const home = await freshHome();
      const originalYaml = toYaml({
        retained_top_level: true,
        llm: { provider: "anthropic", model: "synthetic" },
      });
      await writeFile(join(home.configDir, "config.yaml"), originalYaml, { mode: 0o600 });
      let builds = 0;
      const lifecycle = await compose(home, {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          builds += 1;
          if (failurePoint === "build" && builds === 2) {
            throw new Error("synthetic candidate build failure");
          }
          return backend({
            chat: async () => ({ text: input.ports.config.llm.model }),
          });
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        ...(failurePoint === "persist"
          ? {
              persistRuntimeConfig: () => {
                throw new Error("synthetic persistence failure");
              },
            }
          : {}),
      });

      await expect(
        lifecycle.operations.configureRuntime({
          llm: { model: "candidate-model", api_key: "obviously-fake-candidate-key" },
        }),
      ).rejects.toThrow(
        failurePoint === "build"
          ? "synthetic candidate build failure"
          : "synthetic persistence failure",
      );
      await expect(
        lifecycle.engine.chat({ chatId: "atomic", message: "active model" }),
      ).resolves.toEqual({ text: "synthetic" });
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        llm: { provider: "anthropic", model: "synthetic" },
      });
      expect(await readFile(join(home.configDir, "config.yaml"), "utf8")).toBe(originalYaml);
      await lifecycle.close();
    },
  );

  it("passes the live intervals authority and calendar plan into sync", async () => {
    const home = await freshHome();
    const context = fakeContext(home);
    const selectedRuntime = runtime();
    const backfill = vi.fn(async () => ({
      pages: 1,
      artifacts: 0,
      reports: [],
      droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
    }));
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => selectedRuntime,
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        now: () => Date.parse("1998-07-18T23:59:59.000Z"),
        operationsDependencies: { backfill },
      },
      context,
      { apiKey: String.fromCharCode(111, 108, 100), athleteId: "stale-athlete" },
    );
    await lifecycle.operations.configureRuntime({
      intervals: { api_key: String.fromCharCode(110, 101, 119), athlete_id: "live-athlete" },
      session: { timezone: "Asia/Almaty" },
    });
    await expect(lifecycle.operations.sync({})).resolves.toMatchObject({
      published: true,
      referenceSucceeded: true,
    });
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith({
      home,
      store: context.store,
      apiKey: String.fromCharCode(110, 101, 119),
      athleteId: "live-athlete",
      historyNewestDate: "1998-07-19",
      calendarTimeZone: "Asia/Almaty",
      signal: expect.any(AbortSignal),
    });
    expect(backfill).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: String.fromCharCode(111, 108, 100) }),
    );
    expect(JSON.stringify(backfill.mock.calls)).not.toContain("stale-athlete");
    await lifecycle.close();
  });

  it("closes host adapters, reference scheduling, and an active store runtime once in order", async () => {
    const home = await freshHome();
    const trace: string[] = [];
    const hostFailure = { kind: "host-close" };
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let runtimeCloseCalls = 0;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(trace),
      createRuntime: () =>
        runtime(trace, {
          close: async () => {
            runtimeCloseCalls += 1;
            trace.push("runtime-close-start");
            markCloseStarted();
            await closeGate;
            trace.push("runtime-close-end");
          },
        }),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      closeHostAdapters: async () => {
        trace.push("host-close");
        throw hostFailure;
      },
    });
    const first = lifecycle.close();
    const second = lifecycle.close();
    await closeStarted;
    expect(trace.slice(-3)).toEqual(["host-close", "reference-stop", "runtime-close-start"]);
    releaseClose();
    await expect(first).rejects.toBe(hostFailure);
    await expect(second).rejects.toBe(hostFailure);
    expect(runtimeCloseCalls).toBe(1);
    expect(trace.at(-1)).toBe("runtime-close-end");
  });
  it("uses the private desktop owner for custom-profile status, access, refresh, and deletion", async () => {
    const home = await freshHome();
    const legacyPath = join(home.configDir, "auth-profiles.json");
    await writeFile(legacyPath, "synthetic malformed legacy bytes");
    let present = true;
    const oauthOwner: OAuthCredentialOwner = {
      hasProfile: vi.fn(
        async (name) => name === "openai-codex" || (name === "custom-desktop" && present),
      ),
      getAccessToken: vi.fn(async () => "synthetic-private-access"),
      deleteProfile: vi.fn(async () => {
        present = false;
      }),
    };
    let received: CreateCoachEngineInput | undefined;
    const initial: Config = {
      ...config(home),
      llm: {
        ...config(home).llm,
        provider: "openai-codex",
        apiKey: "",
        authProfile: "custom-desktop",
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received = input;
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
      { ENDURAGENT_HOME: home.root },
      true,
      oauthOwner,
    );
    try {
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        llm: { credential_configured: true },
      });
      const signal = new AbortController().signal;
      await expect(
        received!.ports.getAccessToken("custom-desktop", signal, "synthetic-rejected"),
      ).resolves.toBe("synthetic-private-access");
      expect(oauthOwner.getAccessToken).toHaveBeenCalledWith(
        "custom-desktop",
        signal,
        "synthetic-rejected",
      );
      await expect(
        lifecycle.operations.configureRuntime({
          llm: { provider: "openai-codex", clear_credential: true },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      expect(oauthOwner.deleteProfile).toHaveBeenCalledWith("custom-desktop");
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        llm: { credential_configured: false },
      });
      expect(await readFile(join(home.configDir, "config.yaml"), "utf8")).toContain(
        "auth_profile: custom-desktop",
      );
      expect(await oauthOwner.hasProfile("openai-codex")).toBe(true);
      expect(await readFile(legacyPath, "utf8")).toBe("synthetic malformed legacy bytes");
    } finally {
      await lifecycle.close();
    }
  });
});
