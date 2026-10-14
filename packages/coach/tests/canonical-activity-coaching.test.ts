import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import { createCanonicalActivityReader, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { createNodeImportRuntime, importFilesWithReport } from "@enduragent/kernel-node/ingest";
import { openReadonlySqliteStorage, openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { mapActivityLanding } from "@enduragent/sync-intervals-icu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoachOperations } from "../src/operations.js";
import { createPersistedAthleteStateSource } from "../src/athlete-state-reader.js";
import { createRecentRidesSource } from "../src/recent-rides.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createStoreRuntime, type StoreRuntimeDependencies } from "../src/store-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config = (root: string): Config => ({
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: "", athleteId: "" },
  telegram: { botToken: "" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1_000,
  dataDir: root,
});

function runtimeFor(
  home: AthleteHome,
  context: CoachStoreWriterContext,
  dependencies: StoreRuntimeDependencies = {},
): {
  readonly runtime: ReturnType<typeof createStoreRuntime>;
  readonly operations: ReturnType<typeof createCoachOperations>;
} {
  const reference = {
    scheduler: { stop: vi.fn() },
    services: {},
    runScheduledOnce: vi.fn(async () => ({
      kind: "ran",
      lastSyncAt: "1998-07-18T12:00:00.000Z",
      refreshed: [],
    })),
  } as unknown as ReferenceRuntime;
  const runtime = createStoreRuntime({
    env: {},
    config: config(home.root),
    home,
    reference,
    writerContext: context,
    dependencies: {
      now: () => new Date("1998-07-18T12:00:00.000Z"),
      monotonicNow: () => 1,
      ...dependencies,
    },
  });
  const operations = createCoachOperations({
    home,
    context,
    runtime,
    intervalsCredentials: { read: async () => ({ apiKey: "", athleteId: "" }) },
    historyNewestDate: () => "1998-07-18",
    calendarTimeZone: () => "UTC",
    applyRuntimeConfig: async () => {},
  });
  return { runtime, operations };
}

async function fixture(dependencies: StoreRuntimeDependencies = {}): Promise<{
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: ReturnType<typeof createStoreRuntime>;
  readonly operations: ReturnType<typeof createCoachOperations>;
}> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "canonical-activity-coaching-"));
  roots.push(root);
  const home: AthleteHome = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await Promise.all([
    mkdir(home.storeDir, { recursive: true }),
    mkdir(home.archiveDir, { recursive: true }),
    mkdir(home.configDir, { recursive: true }),
  ]);
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  await runMigrations(store, MIGRATIONS);
  const context: CoachStoreWriterContext = {
    home,
    store,
    listener: {} as CoachStoreWriterContext["listener"],
  };
  return { home, context, ...runtimeFor(home, context, dependencies) };
}

const importPath = resolve(
  import.meta.dirname,
  "../../kernel-node/tests/fixtures/ingest/triathlon-multisport.fit",
);
const mixedImportPath = resolve(
  import.meta.dirname,
  "../../kernel-node/tests/fixtures/ingest/brick-cycling.fit",
);

async function coachingSnapshot(
  runtime: ReturnType<typeof createStoreRuntime>,
  range: { readonly start: string; readonly end: string } = {
    start: "1998-07-01",
    end: "1998-07-31",
  },
) {
  const listed = await runtime.athleteData.listActivities({
    start: range.start,
    end: range.end,
  });
  expect(listed.ok).toBe(true);
  const activities = listed.ok ? listed.value : [];
  const cycling = activities.find(
    (activity) => (activity as { sport?: unknown }).sport === "cycling",
  ) as { id: string } | undefined;
  expect(cycling?.id).toMatch(/^[0-9a-f]{64}$/);
  const detail = await runtime.athleteData.getActivity({ id: cycling!.id });
  const streams = await runtime.athleteData.getStreams({
    id: cycling!.id,
    keys: ["time"],
  });
  expect(detail).toMatchObject({ ok: true, value: { id: cycling!.id } });
  expect(streams).toMatchObject({ ok: true, value: { time: expect.any(Array) } });
  return { listed, detail, streams };
}

describe("canonical activity coaching cutover", () => {
  it("returns partial Training state from a file-only canonical import", async () => {
    const selected = await fixture();
    try {
      await expect(
        selected.operations.importFiles({ paths: [mixedImportPath] }),
      ).resolves.toMatchObject({
        files: { imported: 1, quarantined: 0 },
        publication: { scope: "activities-and-streams", status: "available" },
      });

      const state = await createPersistedAthleteStateSource({
        dataDir: selected.home.root,
        cyclingFtpAnchorResolver: {
          resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }),
        },
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        recentRidesSource: createRecentRidesSource(
          createCanonicalActivityReader(selected.context.store),
        ),
      }).getAthleteState();

      expect(state.trainingContext?.recentRides).toMatchObject({
        kind: "computed",
        windowDays: 28,
        items: [
          {
            id: expect.stringMatching(/^[0-9a-f]{64}$/u),
            localDate: "1998-07-04",
          },
        ],
      });
      expect(state.trainingContext?.performanceProgress).toEqual({
        kind: "unavailable",
        reason: "not-synced",
      });
      expect(state.lastSynced).toBeNull();
    } finally {
      await selected.runtime.close();
      await selected.context.store.close();
    }
  });

  it("reads an import immediately and identically after a credential-free restart", async () => {
    const first = await fixture();
    let firstWriterOpen = true;
    let reopened:
      | {
          readonly store: ReturnType<typeof openSqliteStorage>;
          readonly runtime: ReturnType<typeof createStoreRuntime>;
        }
      | undefined;
    try {
      await expect(first.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject({
        schemaVersion: 2,
        files: { total: 1, imported: 1, quarantined: 0 },
        publication: { scope: "activities-and-streams", status: "available" },
      });
      const immediate = await coachingSnapshot(first.runtime);
      await first.runtime.close();
      await first.context.store.close();
      firstWriterOpen = false;
      const store = openSqliteStorage(join(first.home.storeDir, "store.db"));
      const context: CoachStoreWriterContext = {
        home: first.home,
        store,
        listener: {} as CoachStoreWriterContext["listener"],
      };
      reopened = { store, runtime: runtimeFor(first.home, context).runtime };
      expect(await coachingSnapshot(reopened.runtime)).toEqual(immediate);
    } finally {
      await first.runtime.close();
      if (firstWriterOpen) await first.context.store.close();
      await reopened?.runtime.close();
      await reopened?.store.close();
    }
  });

  it("preserves one FIT-winning mixed-source presentation through a full store reopen", async () => {
    const bytes = new Uint8Array(await readFile(mixedImportPath));
    const probeRoot = await mkdtemp(join(await realpath(tmpdir()), "canonical-mixed-probe-"));
    roots.push(probeRoot);
    const probeStore = openSqliteStorage(join(probeRoot, "store.db"));
    await runMigrations(probeStore, MIGRATIONS);
    let fit: {
      readonly sport: string;
      readonly start: number;
      readonly elapsed: number;
      readonly distance: number;
      readonly localDate: string;
    };
    try {
      const probeNode = createNodeImportRuntime({
        archiveDir: join(probeRoot, "archive"),
        store: probeStore,
      });
      await probeNode.importBatchWithReport({
        files: [{ input_path: "probe.fit", bytes, ext: "fit" }],
        platform_records: [],
      });
      const row = await probeStore.get(
        `SELECT sport, start_utc, elapsed_s, distance_m, local_date_key
FROM session`,
      );
      expect(row).toBeDefined();
      const compactDate = String(row!.local_date_key).padStart(8, "0");
      fit = {
        sport: String(row!.sport),
        start: Number(row!.start_utc),
        elapsed: Number(row!.elapsed_s),
        distance: Number(row!.distance_m),
        localDate: `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6)}`,
      };
      expect(fit.distance).toBeGreaterThan(0);
    } finally {
      await probeStore.close();
    }

    const selected = await fixture();
    let selectedWriterOpen = true;
    let reopened:
      | {
          readonly store: ReturnType<typeof openSqliteStorage>;
          readonly runtime: ReturnType<typeof createStoreRuntime>;
        }
      | undefined;
    try {
      const node = createNodeImportRuntime({
        archiveDir: selected.home.archiveDir,
        store: selected.context.store,
      });
      const platformDistance = fit.distance * 0.95;
      const activity = {
        id: "synthetic-mixed-activity",
        start_date: new Date(fit.start * 1_000).toISOString(),
        start_date_local: `${fit.localDate}T00:00:00`,
        type: fit.sport === "running" ? "Run" : "Ride",
        moving_time: Math.max(0, fit.elapsed - 1),
        elapsed_time: fit.elapsed,
        distance: platformDistance,
      };
      const archiveInstant = { epochSeconds: fit.start };
      const archive = await node.archive.writeSnapshot(activity, archiveInstant);
      const platform = await mapActivityLanding({
        normalized: activity,
        archiveInstant,
        archive,
      });
      await node.importBatchWithReport({ files: [], platform_records: [platform] });

      await expect(
        selected.operations.importFiles({ paths: [mixedImportPath] }),
      ).resolves.toMatchObject({
        files: { imported: 1, quarantined: 0 },
        publication: { status: "available" },
      });
      const immediate = await coachingSnapshot(selected.runtime, {
        start: fit.localDate,
        end: fit.localDate,
      });
      expect(immediate.listed).toMatchObject({ ok: true, value: [expect.any(Object)] });
      expect(immediate.detail).toMatchObject({
        ok: true,
        value: { distanceMeters: fit.distance },
      });
      expect(immediate.detail).not.toMatchObject({
        ok: true,
        value: { distanceMeters: platformDistance },
      });
      if (!immediate.detail.ok) throw new Error("mixed-source detail read failed");
      const activityId = (immediate.detail.value as { readonly id: string }).id;
      await expect(
        selected.runtime.athleteData.getStreams({ id: activityId, keys: ["time", "power"] }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          time: expect.any(Array),
          power: expect.arrayContaining([expect.any(Number)]),
        },
      });

      await selected.runtime.close();
      await selected.context.store.close();
      selectedWriterOpen = false;
      const store = openSqliteStorage(join(selected.home.storeDir, "store.db"));
      const context: CoachStoreWriterContext = {
        home: selected.home,
        store,
        listener: {} as CoachStoreWriterContext["listener"],
      };
      reopened = { store, runtime: runtimeFor(selected.home, context).runtime };
      expect(
        await coachingSnapshot(reopened.runtime, {
          start: fit.localDate,
          end: fit.localDate,
        }),
      ).toEqual(immediate);
      await expect(
        reopened.runtime.athleteData.getStreams({ id: activityId, keys: ["time", "power"] }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          time: expect.any(Array),
          power: expect.arrayContaining([expect.any(Number)]),
        },
      });
    } finally {
      await selected.runtime.close();
      if (selectedWriterOpen) await selected.context.store.close();
      await reopened?.runtime.close();
      await reopened?.store.close();
    }
  });

  it("does not mistake an unrelated readable activity for the imported workout", async () => {
    const selected = await fixture();
    let addAbsentWorkout = false;
    const absentWorkoutKey = "f".repeat(64);
    const importFiles = vi.fn(async (options: Parameters<typeof importFilesWithReport>[0]) => {
      const report = await importFilesWithReport(options);
      if (!addAbsentWorkout) return report;
      const importedAddresses = new Set(
        report.files.filter((file) => file.outcome === "imported").map((file) => file.address),
      );
      const matching = report.clusters.find((cluster) =>
        cluster.members.some((member) => importedAddresses.has(member)),
      );
      expect(matching).toBeDefined();
      return {
        ...report,
        clusters: [...report.clusters, { ...matching!, workout_key: absentWorkoutKey }],
      };
    });
    const operations = createCoachOperations(
      {
        home: selected.home,
        context: selected.context,
        runtime: selected.runtime,
        intervalsCredentials: { read: async () => ({ apiKey: "", athleteId: "" }) },
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );
    try {
      await expect(operations.importFiles({ paths: [importPath] })).resolves.toMatchObject({
        changes: { rawFilesInserted: 1 },
        publication: { status: "available" },
      });
      await coachingSnapshot(selected.runtime);

      addAbsentWorkout = true;
      await expect(operations.importFiles({ paths: [importPath] })).resolves.toMatchObject({
        changes: { rawFilesInserted: 0 },
        publication: { status: "retryable-failure" },
      });
      await coachingSnapshot(selected.runtime);
    } finally {
      await selected.runtime.close();
      await selected.context.store.close();
    }
  });

  it("prefers a sampled session and still publishes a workout with no streams", async () => {
    const streamReads: string[] = [];
    const selected = await fixture({
      openReadonlyStore(path) {
        const store = openReadonlySqliteStorage(path);
        return {
          get: store.get.bind(store),
          async all(sql, params) {
            if (sql.includes("WITH selected AS")) streamReads.push(String(params?.at(-1)));
            return store.all(sql, params);
          },
          close: store.close.bind(store),
        };
      },
    });
    try {
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          publication: { status: "available" },
        },
      );
      const sessions = await selected.context.store.all(
        `SELECT s.session_key, s.session_seq, count(st.channel) AS stream_count
FROM session AS s
LEFT JOIN stream AS st ON st.session_key = s.session_key
GROUP BY s.session_key, s.session_seq
ORDER BY s.session_seq ASC, s.session_key ASC`,
      );
      expect(sessions.length).toBeGreaterThan(1);
      const firstSessionId = String(sessions[0]!.session_key);
      const sampledLaterSession = sessions.find(
        (row, index) => index > 0 && Number(row.stream_count) > 0,
      );
      expect(sampledLaterSession).toBeDefined();
      await selected.context.store.run("DELETE FROM stream WHERE session_key = ?", [
        firstSessionId,
      ]);

      streamReads.length = 0;
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          changes: { rawFilesInserted: 0 },
          publication: { status: "available" },
        },
      );
      expect(streamReads).toEqual([sampledLaterSession!.session_key]);

      await selected.context.store.run("DELETE FROM stream");
      streamReads.length = 0;
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          changes: { rawFilesInserted: 0 },
          publication: { status: "available" },
        },
      );
      expect(streamReads).toEqual([]);
      await expect(
        selected.runtime.athleteData.getActivity({ id: firstSessionId }),
      ).resolves.toMatchObject({
        ok: true,
        value: { id: firstSessionId },
      });
      await expect(
        selected.runtime.athleteData.getStreams({ id: firstSessionId, keys: ["time"] }),
      ).resolves.toEqual({ ok: true, value: {} });
    } finally {
      await selected.runtime.close();
      await selected.context.store.close();
    }
  });

  it("keeps durable ingestion when publication fails and makes a zero-insert retry available", async () => {
    let attempts = 0;
    const selected = await fixture({
      openReadonlyStore(path) {
        attempts += 1;
        if (attempts <= 1) throw new Error("synthetic read handle failure");
        return openReadonlySqliteStorage(path);
      },
    });
    let selectedWriterOpen = true;
    let reopened:
      | {
          readonly store: ReturnType<typeof openSqliteStorage>;
          readonly runtime: ReturnType<typeof createStoreRuntime>;
        }
      | undefined;
    try {
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          schemaVersion: 2,
          changes: { rawFilesInserted: 1 },
          publication: { status: "retryable-failure" },
        },
      );
      await expect(
        selected.context.store.get("SELECT count(*) AS count FROM raw_file"),
      ).resolves.toEqual({ count: 1 });
      await selected.runtime.close();
      await selected.context.store.close();
      selectedWriterOpen = false;
      const store = openSqliteStorage(join(selected.home.storeDir, "store.db"));
      const context: CoachStoreWriterContext = {
        home: selected.home,
        store,
        listener: {} as CoachStoreWriterContext["listener"],
      };
      const pair = runtimeFor(selected.home, context);
      reopened = { store, runtime: pair.runtime };
      await expect(pair.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject({
        schemaVersion: 2,
        changes: { rawFilesInserted: 0 },
        publication: { status: "available" },
      });
      await coachingSnapshot(reopened.runtime);
    } finally {
      await selected.runtime.close();
      if (selectedWriterOpen) await selected.context.store.close();
      await reopened?.runtime.close();
      await reopened?.store.close();
    }
  });
});
