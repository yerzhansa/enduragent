import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DROPPED_ACTIVITIES } from "@enduragent/coach-contract";
import {
  bundledAcceptedCatalog,
  readAcceptedInstallationCatalog,
  type Config,
} from "@enduragent/core";
import type { ModelTransportDecorator } from "@enduragent/engine";
import {
  LATEST_SCHEMA_VERSION,
  SCHEDULER_SCHEMA_VERSION,
} from "@enduragent/kernel/reference/schemas";
import { createPhysicalRequestLedger } from "@enduragent/kernel/store";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import {
  createLocalCoachComposition,
  type LocalCoachCompositionDependencies,
  type LocalStoreRuntime,
} from "../src/composition.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ALIBABA_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_FLUSH_MODEL",
  "LLM_COMPACT_MODEL",
  "LLM_BASE_URL",
  "CONTEXT_WINDOW_TOKENS",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "TELEGRAM_BOT_TOKEN",
  "HISTORY_TOKEN_BUDGET_RATIO",
  "SESSION_IDLE_MINUTES",
  "SESSION_DAILY_RESET_HOUR",
  "SESSION_RESET_ARCHIVE_RETENTION_DAYS",
  "COACH_TZ",
  "ENDURAGENT_CLAUDE_CLI_DISABLED",
  "CLAUDE_CLI_PATH",
  "CODEX_CLI_PATH",
] as const;

const roots: string[] = [];

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-change-during-reply-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await writeFile(
    join(root, "data", "latest.json"),
    JSON.stringify({
      metadata: {
        schema_version: LATEST_SCHEMA_VERSION,
        last_updated: "1998-07-18T00:00:00.000Z",
        freshness: "fresh",
      },
      athlete_profile: { name: "Synthetic Athlete" },
      current_status: { summary: "current" },
      derived_metrics: { eftp: 260 },
      recent_activities: [],
      planned_workouts: [],
      wellness_data: {},
    }),
  );
  await writeFile(
    join(root, "data", ".scheduler.json"),
    JSON.stringify({
      schema_version: SCHEDULER_SCHEMA_VERSION,
      last_sync_at: "1998-07-18T00:00:00.000Z",
      next_sync_at: "1998-07-18T01:00:00.000Z",
    }),
  );
  return home;
}

function storeRuntime(): LocalStoreRuntime {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  let admission = Promise.resolve();
  const runExclusive: LocalStoreRuntime["runExclusive"] = (work) => {
    const run = () => work(new AbortController().signal);
    const task = admission.then(run, run);
    admission = Promise.allSettled([task]).then(() => undefined);
    return task;
  };
  const runWindow = async () => ({
    published: true,
    counts: ledger.snapshot(),
    legacySucceeded: true,
    droppedActivities: EMPTY_DROPPED_ACTIVITIES,
  });
  return {
    athleteData: {
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
    },
    currentDroppedActivities: () => EMPTY_DROPPED_ACTIVITIES,
    attemptLedgerForRun: () => ledger,
    runWindow,
    async runWindowAfter(work) {
      await work(new AbortController().signal, globalThis.fetch);
      return runWindow();
    },
    runExclusive,
    runOutsideWindow: runExclusive,
    async runActivityWrite(work) {
      return { value: await runExclusive(work), activityReadAvailable: true };
    },
    abortActiveWindow: () => () => {},
    startScheduler() {},
    async close() {},
  } as LocalStoreRuntime;
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
  } as CoachStoreWriterContext;
}

function anthropicConfig(home: AthleteHome): Config {
  return {
    dataSource: "store",
    llm: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "synthetic-anthropic-key" },
    intervals: { apiKey: "", athleteId: "synthetic" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 200_000,
    dataDir: home.root,
  };
}

async function compose(home: AthleteHome, extra: LocalCoachCompositionDependencies) {
  const catalog = readAcceptedInstallationCatalog(home.root) ?? bundledAcceptedCatalog();
  return createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: home.root },
      home,
      context: fakeContext(home),
      config: anthropicConfig(home),
      catalog,
      readCatalog: () => readAcceptedInstallationCatalog(home.root) ?? catalog,
    },
    {
      assertRuntimeAthleteOwner: async () => {},
      bootstrap: async () => ({
        scheduler: { stop() {} },
        async runScheduledOnce() {
          return { kind: "skipped", reason: "cooldown" } as never;
        },
      }),
      createRuntime: () => storeRuntime(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => ({
        resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }),
      }),
      ...extra,
    },
  );
}

function generation(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

function heldProvider() {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldSignal: AbortSignal | undefined;
  let held = false;
  const decorator: ModelTransportDecorator = () => ({
    generate: async (request) => {
      if (!held && request.options.caller === "chat") {
        held = true;
        heldSignal = request.options.signal;
        markEntered();
        await new Promise<void>((resolve, reject) => {
          void released.then(resolve);
          request.options.signal?.addEventListener(
            "abort",
            () => reject(request.options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      }
      return generation("A short synthetic coaching reply.");
    },
  });
  return {
    decorator,
    entered,
    release,
    signal: () => heldSignal,
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"still-pending">((resolve) => {
      timer = setTimeout(() => resolve("still-pending"), ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network disabled: ${String(input instanceof Request ? input.url : input)}`);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("llm-picker bug 4: Stop while a model change waits for the reply", () => {
  it("stops the streaming reply at once even though a Coach model change is waiting", async () => {
    const home = await freshHome();
    const provider = heldProvider();
    const lifecycle = await compose(home, { modelTransportDecorator: provider.decorator });
    try {
      let turnId: string | undefined;
      const reply = lifecycle.engine
        .chat({ chatId: "desktop", message: "Plan my week, please." }, (event) => {
          const id = (event as { turnId?: unknown }).turnId;
          if (turnId === undefined && typeof id === "string") turnId = id;
        })
        .catch((error: unknown) => error);
      await provider.entered;
      expect(turnId).toBeDefined();

      const modelChange = lifecycle.operations
        .configureRuntime({ llm: { model: "claude-opus-5" } })
        .catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stop = lifecycle.engine.stopChat!({ chatId: "desktop", turnId: turnId! });
      const stopOutcome = await settlesWithin(stop, 2_000);
      const replyAborted = provider.signal()?.aborted === true;

      expect({ stopOutcome, replyAborted }).toEqual({
        stopOutcome: "settled",
        replyAborted: true,
      });

      provider.release();
      await reply;
      await modelChange;
    } finally {
      provider.release();
      await lifecycle.close();
    }
  }, 30_000);

  it("control: with no model change waiting, the same Stop ends the reply at once", async () => {
    const home = await freshHome();
    const provider = heldProvider();
    const lifecycle = await compose(home, { modelTransportDecorator: provider.decorator });
    try {
      let turnId: string | undefined;
      const reply = lifecycle.engine
        .chat({ chatId: "desktop", message: "Plan my week, please." }, (event) => {
          const id = (event as { turnId?: unknown }).turnId;
          if (turnId === undefined && typeof id === "string") turnId = id;
        })
        .catch((error: unknown) => error);
      await provider.entered;
      const stop = lifecycle.engine.stopChat!({ chatId: "desktop", turnId: turnId! });
      expect(await settlesWithin(stop, 2_000)).toBe("settled");
      await expect(stop).resolves.toEqual({ stopped: true });
      expect(provider.signal()?.aborted).toBe(true);
      await reply;
    } finally {
      provider.release();
      await lifecycle.close();
    }
  }, 30_000);
});

describe("llm-picker G1b: daemon reads while a coach change waits", () => {
  it("still answers the runtime config and transcript reads Settings and Chat make", async () => {
    const home = await freshHome();
    const provider = heldProvider();
    const lifecycle = await compose(home, { modelTransportDecorator: provider.decorator });
    try {
      const reply = lifecycle.engine
        .chat({ chatId: "desktop", message: "Plan my week, please." })
        .catch((error: unknown) => error);
      await provider.entered;
      const modelChange = lifecycle.operations
        .configureRuntime({ llm: { model: "claude-opus-5" } })
        .catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runtimeRead = await settlesWithin(lifecycle.operations.getRuntimeConfig({}), 2_000);
      const transcriptRead = await settlesWithin(
        lifecycle.operations.getTranscriptPage({ cursor: null, limit: 25 }),
        2_000,
      );

      expect({ runtimeRead, transcriptRead }).toEqual({
        runtimeRead: "settled",
        transcriptRead: "settled",
      });
      provider.release();
      await reply;
      await modelChange;
    } finally {
      provider.release();
      await lifecycle.close();
    }
  }, 30_000);
});

describe("llm-picker bug 3: deleting the active key while a reply streams", () => {
  it("answers the runtime clear by its own deadline instead of holding it for the whole reply", async () => {
    const home = await freshHome();
    const provider = heldProvider();
    const deadlineMs = 300;
    const lifecycle = await compose(home, {
      modelTransportDecorator: provider.decorator,
      operationsDependencies: { runtimeConfigurationDeadlineMs: deadlineMs },
    });
    try {
      const reply = lifecycle.engine
        .chat({ chatId: "desktop", message: "Build me a training plan." })
        .catch((error: unknown) => error);
      await provider.entered;

      const clear = lifecycle.operations.configureRuntime({
        llm: { provider: "anthropic", clear_credential: true },
      });
      const clearResult = clear.then(
        (value) => ({ kind: "answered" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error: String(error) }),
      );
      const outcome = await settlesWithin(clear, deadlineMs + 1_000);

      provider.release();
      await reply;
      const afterReply = await clearResult;
      const keyStillActiveInCoach = (await lifecycle.operations.getRuntimeConfig({})).llm
        .credential_configured;

      expect({ outcomeByDeadline: outcome, afterReply, keyStillActiveInCoach }).toEqual({
        outcomeByDeadline: "settled",
        afterReply: {
          kind: "answered",
          value: { schemaVersion: 3, status: "refused", reason: "busy-replying" },
        },
        keyStillActiveInCoach: true,
      });
    } finally {
      provider.release();
      await lifecycle.close();
    }
  }, 30_000);
});
