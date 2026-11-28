import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DROPPED_ACTIVITIES } from "@enduragent/coach-contract";
import {
  bundledAcceptedCatalog,
  loadConfig,
  readAcceptedInstallationCatalog,
  type Config,
} from "@enduragent/core";
import type { ModelTransportDecorator, ModelTransportRequest } from "@enduragent/engine";
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
  const root = await mkdtemp(join(await realpath(tmpdir()), "summary-model-choice-"));
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
    admission = task.then(
      () => undefined,
      () => undefined,
    );
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
    abortActiveWindow: () => () => {},
    runExclusive,
    runOutsideWindow: runExclusive,
    async runActivityWrite(work) {
      return { value: await runExclusive(work), activityReadAvailable: true };
    },
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

function baseConfig(home: AthleteHome, llm: Config["llm"]): Config {
  return {
    dataSource: "store",
    llm,
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

async function compose(
  home: AthleteHome,
  config: Config,
  extra: LocalCoachCompositionDependencies,
) {
  const catalog = readAcceptedInstallationCatalog(home.root) ?? bundledAcceptedCatalog();
  return createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: home.root },
      home,
      context: fakeContext(home),
      config,
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

interface SeenRequest {
  readonly model: string;
  readonly caller: string | undefined;
}

function recordingProvider(reply: (request: ModelTransportRequest) => string) {
  const seen: SeenRequest[] = [];
  const decorator: ModelTransportDecorator = () => ({
    generate: async (request) => {
      seen.push({ model: request.model, caller: request.options.caller });
      return generation(reply(request));
    },
  });
  return { seen, decorator };
}

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    throw new Error(`network disabled in test: ${url}`);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OPENROUTER_DEFAULT = "deepseek/deepseek-v4.1-flash-1017";
const OPENROUTER_PREMIUM = "moonshotai/kimi-k3";
const LONG_REPLY = "Steady endurance at a conversational effort. ".repeat(1_400);

async function chatUntilCompaction(
  lifecycle: Awaited<ReturnType<typeof compose>>,
  seen: readonly SeenRequest[],
) {
  for (let turn = 1; turn <= 12; turn += 1) {
    await lifecycle.engine.chat({
      chatId: "desktop",
      message: `Turn ${turn}: ${"How did my ride feel compared with last week? ".repeat(200)}`,
    });
    if (seen.some((request) => request.caller === "compact")) return;
  }
}

function modelsFor(seen: readonly SeenRequest[], caller: string): string[] {
  return [...new Set(seen.filter((request) => request.caller === caller).map((r) => r.model))];
}

describe("summary and memory model choice across coach model changes", () => {
  it("keeps OpenRouter compaction on the provider default after picking a premium chat model", async () => {
    const home = await freshHome();
    const { seen, decorator } = recordingProvider(() => LONG_REPLY);
    const lifecycle = await compose(
      home,
      baseConfig(home, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "" }),
      { modelTransportDecorator: decorator },
    );
    try {
      const catalogSnapshot = bundledAcceptedCatalog().snapshot;
      await expect(
        lifecycle.operations.configureRuntime({
          llm: {
            provider: "openrouter",
            model: OPENROUTER_DEFAULT,
            api_key: "synthetic-openrouter-key",
            catalog_snapshot: catalogSnapshot,
          },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      await expect(
        lifecycle.operations.configureRuntime({
          llm: { model: OPENROUTER_PREMIUM, catalog_snapshot: catalogSnapshot },
        }),
      ).resolves.toMatchObject({ status: "applied" });

      await chatUntilCompaction(lifecycle, seen);
      expect(modelsFor(seen, "chat")).toEqual([OPENROUTER_PREMIUM]);
      expect(modelsFor(seen, "compact")).toEqual([OPENROUTER_DEFAULT]);
      expect(loadConfig(home.configDir).llm.compactModel).toBe(OPENROUTER_DEFAULT);
    } finally {
      await lifecycle.close();
    }
  }, 120_000);

  it("keeps Anthropic compaction on Haiku after using Haiku as chat model and switching to Sonnet", async () => {
    const home = await freshHome();
    const { seen, decorator } = recordingProvider(() => LONG_REPLY);
    const lifecycle = await compose(
      home,
      baseConfig(home, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "" }),
      { modelTransportDecorator: decorator },
    );
    try {
      const catalogSnapshot = bundledAcceptedCatalog().snapshot;
      await expect(
        lifecycle.operations.configureRuntime({
          llm: {
            provider: "anthropic",
            model: "claude-haiku-5-5",
            api_key: "synthetic-anthropic-key",
            catalog_snapshot: catalogSnapshot,
          },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      await expect(
        lifecycle.operations.configureRuntime({
          llm: { model: "claude-sonnet-5-5", catalog_snapshot: catalogSnapshot },
        }),
      ).resolves.toMatchObject({ status: "applied" });

      await chatUntilCompaction(lifecycle, seen);
      expect(modelsFor(seen, "chat")).toEqual(["claude-sonnet-5-5"]);
      expect(modelsFor(seen, "compact")).toEqual(["claude-haiku-5-5"]);
      expect(loadConfig(home.configDir).llm.compactModel).toBe("claude-haiku-5-5");
    } finally {
      await lifecycle.close();
    }
  }, 120_000);

  it("moves OpenAI flush and compaction to Luna after Sol, then Astra, then Luna", async () => {
    const home = await freshHome();
    const { seen, decorator } = recordingProvider(() => LONG_REPLY);
    const lifecycle = await compose(
      home,
      baseConfig(home, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "" }),
      { modelTransportDecorator: decorator },
    );
    try {
      const catalogSnapshot = bundledAcceptedCatalog().snapshot;
      await expect(
        lifecycle.operations.configureRuntime({
          llm: {
            provider: "openai",
            model: "gpt-6.2-sol",
            api_key: "synthetic-openai-key",
            catalog_snapshot: catalogSnapshot,
          },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      for (const model of ["gpt-6-astra", "gpt-6-luna"]) {
        await expect(
          lifecycle.operations.configureRuntime({
            llm: { model, catalog_snapshot: catalogSnapshot },
          }),
        ).resolves.toMatchObject({ status: "applied" });
      }

      await chatUntilCompaction(lifecycle, seen);
      expect({
        chat: modelsFor(seen, "chat"),
        flush: modelsFor(seen, "flush"),
        compact: modelsFor(seen, "compact"),
      }).toEqual({
        chat: ["gpt-6-luna"],
        flush: ["gpt-6-luna"],
        compact: ["gpt-6-luna"],
      });
      const reloaded = loadConfig(home.configDir);
      expect(reloaded.llm.compactModel).toBe("gpt-6-luna");
      expect(reloaded.llm.flushModel).toBeUndefined();
    } finally {
      await lifecycle.close();
    }
  }, 120_000);

  it("keeps the pre-Astra OpenAI model across a restart and moves background models when leaving Astra", async () => {
    const home = await freshHome();
    const catalogSnapshot = bundledAcceptedCatalog().snapshot;
    const first = await compose(
      home,
      baseConfig(home, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "" }),
      {},
    );
    try {
      await expect(
        first.operations.configureRuntime({
          llm: {
            provider: "openai",
            model: "gpt-6-luna",
            api_key: "synthetic-openai-key",
            catalog_snapshot: catalogSnapshot,
          },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      await expect(
        first.operations.configureRuntime({
          llm: { model: "gpt-6-astra", catalog_snapshot: catalogSnapshot },
        }),
      ).resolves.toMatchObject({ status: "applied" });
    } finally {
      await first.close();
    }

    const reloaded = loadConfig(home.configDir, { defaultDataDir: home.root });
    expect(reloaded.llm.model).toBe("gpt-6-astra");
    expect(reloaded.llm.compactModel).toBe("gpt-6-luna");
    expect(reloaded.llm.flushModel).toBe("gpt-6-luna");

    const { seen, decorator } = recordingProvider(() => LONG_REPLY);
    const restarted = await compose(
      home,
      { ...reloaded, llm: { ...reloaded.llm, apiKey: "synthetic-openai-key" } },
      { modelTransportDecorator: decorator },
    );
    try {
      await expect(
        restarted.operations.configureRuntime({
          llm: { model: "gpt-6.2-sol", catalog_snapshot: catalogSnapshot },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      await chatUntilCompaction(restarted, seen);
      expect({
        chat: modelsFor(seen, "chat"),
        flush: modelsFor(seen, "flush"),
        compact: modelsFor(seen, "compact"),
      }).toEqual({
        chat: ["gpt-6.2-sol"],
        flush: ["gpt-6.2-sol"],
        compact: ["gpt-6.2-sol"],
      });
    } finally {
      await restarted.close();
    }
  }, 120_000);

  it("keeps explicit summary and memory models equal to chat across restart and model change", async () => {
    const home = await freshHome();
    const catalogSnapshot = bundledAcceptedCatalog().snapshot;
    const first = await compose(
      home,
      baseConfig(home, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "" }),
      {},
    );
    try {
      await expect(
        first.operations.configureRuntime({
          llm: {
            provider: "openai",
            model: "gpt-6-luna",
            api_key: "synthetic-openai-key",
            compact_model: "gpt-6-luna",
            flush_model: "gpt-6-luna",
            catalog_snapshot: catalogSnapshot,
          },
        }),
      ).resolves.toMatchObject({ status: "applied" });
    } finally {
      await first.close();
    }

    const reloaded = loadConfig(home.configDir, { defaultDataDir: home.root });
    const { seen, decorator } = recordingProvider(() => LONG_REPLY);
    const restarted = await compose(
      home,
      { ...reloaded, llm: { ...reloaded.llm, apiKey: "synthetic-openai-key" } },
      { modelTransportDecorator: decorator },
    );
    try {
      await expect(
        restarted.operations.configureRuntime({
          llm: { model: "gpt-6.2-sol", catalog_snapshot: catalogSnapshot },
        }),
      ).resolves.toMatchObject({ status: "applied" });
      await chatUntilCompaction(restarted, seen);
      expect({
        chat: modelsFor(seen, "chat"),
        flush: modelsFor(seen, "flush"),
        compact: modelsFor(seen, "compact"),
      }).toEqual({
        chat: ["gpt-6.2-sol"],
        flush: ["gpt-6-luna"],
        compact: ["gpt-6-luna"],
      });
    } finally {
      await restarted.close();
    }
  }, 120_000);
});
