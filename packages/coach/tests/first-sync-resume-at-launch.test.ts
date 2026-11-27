import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledAcceptedCatalog,
  recordIntervalsCredentialResponse,
  type Config,
} from "@enduragent/core";
import { createPhysicalRequestLedger, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { encodeIntervalsOAuthCredential } from "../../core/src/intervals-credential.js";
import {
  createLocalCoachComposition,
  type LocalCoachComposition,
  type LocalStoreRuntime,
} from "../src/composition.js";

const EMPTY_DROPPED = {
  overall: { total: 0, visible: 0, restrictions: [], other: 0 },
  recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
};

const IN_PROGRESS_CURSOR = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "1997-12-08",
  window_end: "1998-12-07",
  last_key: "synthetic-activity-0420",
  complete: false,
});

const COMPLETE_CURSOR = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "1997-12-08",
  window_end: "1998-12-07",
  last_key: null,
  complete: true,
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureRuntime() {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const windows: string[] = [];
  const offStoreLaneFetch: typeof globalThis.fetch = async () => {
    throw new Error("synthetic history download does not fetch");
  };
  const capture = async () => {
    windows.push("captured");
    return {
      published: true,
      counts: ledger.snapshot(),
      legacySucceeded: true,
      droppedActivities: EMPTY_DROPPED,
    };
  };
  const runExclusive: LocalStoreRuntime["runExclusive"] = (work) =>
    work(new AbortController().signal);
  const runtime: LocalStoreRuntime = {
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
    } as never,
    currentDroppedActivities: () => EMPTY_DROPPED,
    attemptLedgerForRun: () => ledger,
    runWindow: capture,
    async runWindowAfter(work) {
      await work(new AbortController().signal, offStoreLaneFetch);
      return capture();
    },
    runExclusive,
    runOutsideWindow: runExclusive,
    async runActivityWrite(work) {
      return { value: await runExclusive(work), activityReadAvailable: true };
    },
    startScheduler() {},
    async close() {},
  };
  return { runtime, windows, offStoreLaneFetch };
}

async function relaunchedCoach(savedHistoryCursor: string | null) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "first-sync-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await mkdir(home.storeDir, { recursive: true });
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  cleanups.push(() => store.close());
  await runMigrations(store, MIGRATIONS);
  if (savedHistoryCursor !== null) {
    await store.run(
      "INSERT INTO source_watermark (source, lane, watermark) VALUES ('intervals-icu', 'bulk-fit', ?)",
      [savedHistoryCursor],
    );
  }
  const config: Config = {
    dataSource: "store",
    llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
    intervals: { apiKey: "", athleteId: "" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1000,
    dataDir: root,
  };
  const captures = captureRuntime();
  const historyDownloads = vi.fn(async () => ({
    pages: 1,
    artifacts: 0,
    reports: [],
    droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
  }));
  const catalog = bundledAcceptedCatalog();
  const lifecycle: LocalCoachComposition = await createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: root },
      home,
      context: { home, store, listener: inertWriterProtocolListener },
      config,
      catalog,
      readCatalog: () => catalog,
      deferInitialRefresh: true,
    },
    {
      bootstrap: async () => ({
        scheduler: { stop() {} },
        async runScheduledOnce() {
          return { kind: "skipped", reason: "cooldown" } as never;
        },
      }),
      createRuntime: () => captures.runtime,
      createBackend: () =>
        ({
          chat: async () => ({ text: "ok" }),
          getCoachDecision: async () => ({ decision: null }),
          resetSession: async () => ({ memoryFlushed: true }),
          hasSession: async () => ({ hasSession: false }),
        }) as never,
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => ({
        resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }) as never,
      }),
      assertRuntimeAthleteOwner: async () => {},
      operationsDependencies: { backfill: historyDownloads },
    },
  );
  cleanups.push(() => lifecycle.close());
  return { lifecycle, historyDownloads, captures };
}

async function launch(app: Awaited<ReturnType<typeof relaunchedCoach>>, apiKey: string) {
  await expect(
    app.lifecycle.operations.configureRuntime({ intervals: { api_key: apiKey } }),
  ).resolves.toMatchObject({ status: "applied" });
  await app.lifecycle.startInitialRefresh();
}

describe("quitting during the first sync", () => {
  it("finishes the unfinished history download in the startup refresh", async () => {
    const app = await relaunchedCoach(IN_PROGRESS_CURSOR);

    await launch(app, "synthetic-key");

    expect(app.historyDownloads).toHaveBeenCalledOnce();
    expect(app.historyDownloads).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "synthetic-key",
        athleteId: "0",
        baseFetch: app.captures.offStoreLaneFetch,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(app.captures.windows).toEqual(["captured"]);
  });

  it.each([
    ["complete", COMPLETE_CURSOR],
    ["never started", null],
  ])("leaves a %s history download alone at launch", async (_state, savedHistoryCursor) => {
    const app = await relaunchedCoach(savedHistoryCursor);

    await launch(app, "synthetic-key");

    expect(app.historyDownloads).not.toHaveBeenCalled();
    expect(app.captures.windows).toEqual(["captured"]);
  });

  it("does not resume the history download while intervals.icu rejects the sign-in", async () => {
    const signedIn = encodeIntervalsOAuthCredential("fixture-first-sync-resume-rejected-token");
    cleanups.push(async () => recordIntervalsCredentialResponse(signedIn, 200));
    const app = await relaunchedCoach(IN_PROGRESS_CURSOR);
    await expect(
      app.lifecycle.operations.configureRuntime({ intervals: { api_key: signedIn } }),
    ).resolves.toMatchObject({ status: "applied" });

    recordIntervalsCredentialResponse(signedIn, 401);
    await app.lifecycle.startInitialRefresh();

    expect(app.historyDownloads).not.toHaveBeenCalled();
    expect(app.captures.windows).toEqual(["captured"]);
  });

  it("still downloads the history when the athlete presses Sync now", async () => {
    const app = await relaunchedCoach(COMPLETE_CURSOR);
    await launch(app, "synthetic-key");

    await app.lifecycle.operations.sync({});

    expect(app.historyDownloads).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "synthetic-key",
        baseFetch: app.captures.offStoreLaneFetch,
      }),
    );
  });
});
