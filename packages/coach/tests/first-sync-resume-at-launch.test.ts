import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import type { runIntervalsBackfillInWriter } from "../src/backfill.js";
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
  window_start: "1998-01-01",
  window_end: "1998-12-31",
  last_key: "synthetic-activity-0420",
  complete: false,
});

const COMPLETE_CURSOR = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "1998-01-01",
  window_end: "1998-12-31",
  last_key: null,
  complete: true,
});

const HISTORY_DOWNLOADED = {
  pages: 1,
  artifacts: 0,
  reports: [],
  droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
};

type HistoryDownload = typeof runIntervalsBackfillInWriter;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function slowHistoryDownload() {
  let finish = (): void => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const download: HistoryDownload = ({ signal }) =>
    new Promise((resolve, reject) => {
      void finished.then(() => resolve(HISTORY_DOWNLOADED));
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { download, finish };
}

function captureRuntime() {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const windows: string[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      () => inFlight.delete(work),
    );
    return work;
  };
  const settled = async (): Promise<void> => {
    do {
      await Promise.allSettled(inFlight);
      await new Promise((resolve) => setImmediate(resolve));
    } while (inFlight.size > 0);
  };
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
    track(work(new AbortController().signal));
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
    runWindowAfter: (work) =>
      track(
        (async () => {
          await work(new AbortController().signal, offStoreLaneFetch);
          return capture();
        })(),
      ),
    runExclusive,
    runOutsideWindow: runExclusive,
    async runActivityWrite(work) {
      return { value: await runExclusive(work), activityReadAvailable: true };
    },
    startScheduler() {},
    async close() {},
  };
  return { runtime, windows, offStoreLaneFetch, settled };
}

async function relaunchedCoach(
  savedHistoryCursor: string | null,
  download: HistoryDownload = async () => HISTORY_DOWNLOADED,
) {
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
  const historyDownloads = vi.fn(download);
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
  const loggedEvents = async (): Promise<string[]> => {
    const log = await readFile(join(root, "logs", "log.jsonl"), "utf8").catch(() => "");
    return log
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { event: string }).event);
  };
  return { lifecycle, historyDownloads, captures, loggedEvents };
}

async function signIn(app: Awaited<ReturnType<typeof relaunchedCoach>>, apiKey: string) {
  await expect(
    app.lifecycle.operations.configureRuntime({ intervals: { api_key: apiKey } }),
  ).resolves.toMatchObject({ status: "applied" });
}

async function launch(app: Awaited<ReturnType<typeof relaunchedCoach>>, apiKey: string) {
  await signIn(app, apiKey);
  await app.lifecycle.startInitialRefresh();
  await app.captures.settled();
}

describe("quitting during the first sync", () => {
  it("finishes the unfinished history download after the launch snapshot", async () => {
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
    expect(app.captures.windows).toEqual(["captured", "captured"]);
  });

  it("publishes the launch snapshot before a slow history download finishes", async () => {
    const slow = slowHistoryDownload();
    const app = await relaunchedCoach(IN_PROGRESS_CURSOR, slow.download);
    await signIn(app, "synthetic-key");

    const launched = app.lifecycle.startInitialRefresh();
    try {
      await vi.waitFor(() => expect(app.captures.windows).toEqual(["captured"]));
      expect(app.historyDownloads).toHaveBeenCalledOnce();
    } finally {
      slow.finish();
    }

    await expect(launched).resolves.toBeUndefined();
    await app.captures.settled();
    expect(app.captures.windows).toEqual(["captured", "captured"]);
  });

  it.each([
    [
      "the history download fails",
      IN_PROGRESS_CURSOR,
      async () => {
        throw new Error("synthetic history download failure");
      },
    ],
    ["the saved history cursor does not parse", "{", async () => HISTORY_DOWNLOADED],
  ])(
    "still publishes the launch snapshot when %s",
    async (_failure, savedHistoryCursor, download: HistoryDownload) => {
      const app = await relaunchedCoach(savedHistoryCursor, download);
      await signIn(app, "synthetic-key");

      const launched = app.lifecycle.startInitialRefresh();
      await expect(launched).resolves.toBeUndefined();
      await app.captures.settled();

      expect(app.captures.windows).toEqual(["captured"]);
      expect(app.lifecycle.startInitialRefresh()).toBe(launched);
      expect(await app.loggedEvents()).toContain("history_download_resume_failed");
      expect(await app.loggedEvents()).not.toContain("initial_store_refresh_failed");
    },
  );

  it("stops the resumed history download when the app quits", async () => {
    const slow = slowHistoryDownload();
    const app = await relaunchedCoach(IN_PROGRESS_CURSOR, slow.download);
    await signIn(app, "synthetic-key");
    const launched = app.lifecycle.startInitialRefresh();
    await vi.waitFor(() => expect(app.historyDownloads).toHaveBeenCalledOnce());

    await app.lifecycle.close();
    await app.captures.settled();

    await expect(launched).resolves.toBeUndefined();
    expect(app.historyDownloads.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(app.captures.windows).toEqual(["captured"]);
    expect(await app.loggedEvents()).not.toContain("history_download_resume_failed");
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
    await app.captures.settled();

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
