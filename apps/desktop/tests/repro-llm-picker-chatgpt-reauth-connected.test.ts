import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { EMPTY_DROPPED_ACTIVITIES } from "@enduragent/coach-contract";
import {
  bundledAcceptedCatalog,
  readAcceptedInstallationCatalog,
  type Config,
} from "@enduragent/core";
import {
  LATEST_SCHEMA_VERSION,
  SCHEDULER_SCHEMA_VERSION,
} from "@enduragent/kernel/reference/schemas";
import { createPhysicalRequestLedger } from "@enduragent/kernel/store";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import {
  createLocalCoachComposition,
  type LocalStoreRuntime,
} from "../../../packages/coach/src/composition.js";
import type { CoachStoreWriterContext } from "../../../packages/coach/src/runtime.js";
import { createChatGptAuth } from "../src/main/chatgpt-auth.js";
import {
  chatGptUiPhase,
  createOnboardingState,
} from "../../desktop-renderer/src/onboarding/machine.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
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
  "COACH_TZ",
  "ENDURAGENT_CLAUDE_CLI_DISABLED",
  "CLAUDE_CLI_PATH",
  "CODEX_CLI_PATH",
] as const;

const roots: string[] = [];

function syntheticCodexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "repro-llm-picker-reauth-"));
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

function chatGptConfig(home: AthleteHome): Config {
  return {
    dataSource: "store",
    llm: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      apiKey: "",
      authProfile: "openai-codex",
      compactModel: "gpt-5.6-sol",
    },
    intervals: { apiKey: "", athleteId: "synthetic" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 272_000,
    dataDir: home.root,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("llm-picker bug 2: revoked ChatGPT sign-in", () => {
  it("stops reporting ChatGPT as Connected once the coach has seen the sign-in rejected", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        data_source: "store",
        data_dir: home.root,
        llm: { provider: "openai-codex", model: "gpt-5.6-sol", auth_profile: "openai-codex" },
      }),
      { mode: 0o600 },
    );
    const profileFile = join(home.configDir, "auth-profiles.json");
    const storedAccess = syntheticCodexAccessToken("synthetic-account");
    await writeFile(
      profileFile,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: storedAccess,
          refresh: "synthetic-revoked-refresh",
          expires: 0,
          accountId: "synthetic-account",
        },
      }),
      { mode: 0o600 },
    );

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (url === "https://chatgpt.com/backend-api/codex/responses") {
        return new Response(
          JSON.stringify({ error: { code: "invalid_token", message: "expired" } }),
          { status: 401 },
        );
      }
      throw new Error(`unexpected network request in repro: ${url}`);
    });

    const catalog = readAcceptedInstallationCatalog(home.root) ?? bundledAcceptedCatalog();
    const lifecycle = await createLocalCoachComposition(
      {
        env: { ENDURAGENT_HOME: home.root },
        home,
        context: fakeContext(home),
        config: chatGptConfig(home),
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
      },
    );
    try {
      const events: Array<{ type: string; kind?: string; athleteMessage?: string }> = [];
      await lifecycle.engine
        .chat({ chatId: "desktop", message: "How should I ride today?" }, (event) => {
          events.push(event as (typeof events)[number]);
        })
        .catch(() => undefined);
      expect(requests.filter((url) => url.includes("/oauth/token"))).toHaveLength(2);
      const chatError = events.find((event) => event.type === "error");
      expect(chatError).toMatchObject({ kind: "provider-auth" });
      expect(chatError?.athleteMessage).toContain("Open Setup and sign in again");

      const auth = createChatGptAuth({
        configDir: home.configDir,
        applyRuntimeConfig: async () => {
          throw new Error("not used");
        },
        getRuntimeConfig: () => lifecycle.operations.getRuntimeConfig({}),
        openExternal: async () => {},
      });
      const status = await auth.status();
      const setupPhase = chatGptUiPhase(createOnboardingState([], status));

      expect({ status, setupPhase }).toEqual({
        status: { state: "configured", runtimeReady: false, reason: "sign-in-expired" },
        setupPhase: "sign-in-expired",
      });
    } finally {
      await lifecycle.close();
    }
  }, 30_000);
});
