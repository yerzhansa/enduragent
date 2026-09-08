import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { LocalStoreRuntime } from "../src/composition.js";
import { EMPTY_DROPPED_ACTIVITIES, type DroppedActivities } from "@enduragent/coach-contract";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createCoachOperations } from "../src/operations.js";

const home: AthleteHome = {
  root: "/synthetic/athlete",
  storeDir: "/synthetic/athlete/store",
  archiveDir: "/synthetic/athlete/archive",
  configDir: "/synthetic/athlete/config",
};

function context(): CoachStoreWriterContext {
  return {
    home,
    store: {} as CoachStoreWriterContext["store"],
    listener: {} as CoachStoreWriterContext["listener"],
  };
}

function requestCounts(storeRequests: number, legacyRequests: number) {
  return {
    storeRequests,
    legacyRequests,
    totalRequests: storeRequests + legacyRequests,
    byTag: {
      "store:activities": 0,
      "store:analytics-curves": 0,
      "store:wellness": 0,
      "store:settings": 0,
      "store:streams": 0,
      "legacy:reference": 0,
    },
  };
}

function intervalsCredentials(apiKey = "", athleteId = "0") {
  return {
    read: vi.fn(async () => ({ apiKey, athleteId })),
  };
}

function promiseGate(): { readonly promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function operationRuntime(
  runWindowAfter: (work: (signal: AbortSignal) => Promise<void>) => Promise<
    Omit<Awaited<ReturnType<LocalStoreRuntime["runWindowAfter"]>>, "droppedActivities"> & {
      readonly droppedActivities?: DroppedActivities;
    }
  > = async (work) => {
    await work(new AbortController().signal);
    return {
      published: false,
      legacySucceeded: true,
      counts: requestCounts(0, 0),
    };
  },
): Pick<LocalStoreRuntime, "runWindowAfter" | "runExclusive" | "runActivityWrite"> {
  let tail = Promise.resolve();
  const runExclusive: LocalStoreRuntime["runExclusive"] = (work) => {
    const run = () => work(new AbortController().signal);
    const task = tail.then(run, run);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  return {
    runExclusive,
    runActivityWrite: async (work) => ({
      value: await runExclusive(work),
      activityReadAvailable: true,
    }),
    runWindowAfter: (work) =>
      runExclusive(async () => {
        const result = await runWindowAfter(work);
        return {
          ...result,
          droppedActivities: result.droppedActivities ?? EMPTY_DROPPED_ACTIVITIES,
        };
      }),
  };
}

describe("coach operations", () => {
  it("validates transcript requests and responses around the read-only composition lane", async () => {
    const readTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [],
      nextCursor: null,
    }));
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      readTranscriptPage,
      applyRuntimeConfig: async () => {},
    });

    await expect(operations.getTranscriptPage({ cursor: null, limit: 25 })).resolves.toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });
    expect(readTranscriptPage).toHaveBeenCalledWith({ cursor: null, limit: 25 });
    expect(() => operations.getTranscriptPage({ cursor: null, limit: 51 } as never)).toThrow();
    expect(readTranscriptPage).toHaveBeenCalledOnce();
  });

  it("validates archived conversation requests and refuses an unwired archive lane", async () => {
    const boundaryRef = "c".repeat(64);
    const readArchivedConversations = vi.fn(async () => ({
      schemaVersion: 1 as const,
      conversations: [
        {
          boundaryRef,
          boundaryAt: "1998-07-06T00:00:00.000Z",
          reason: "explicit-reset" as const,
          turnCount: 1,
        },
      ],
      truncated: false,
    }));
    const readArchivedTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [],
      nextCursor: null,
    }));
    const deleteArchivedConversation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "deleted" as const,
    }));
    const wiring = {
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
    };
    const operations = createCoachOperations({
      ...wiring,
      readArchivedConversations,
      readArchivedTranscriptPage,
      deleteArchivedConversation,
    });

    await expect(operations.listArchivedConversations({})).resolves.toEqual({
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef,
          boundaryAt: "1998-07-06T00:00:00.000Z",
          reason: "explicit-reset",
          turnCount: 1,
        },
      ],
      truncated: false,
    });
    await expect(
      operations.getArchivedTranscriptPage({ boundaryRef, cursor: null, limit: 25 }),
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });
    expect(readArchivedTranscriptPage).toHaveBeenCalledWith({
      boundaryRef,
      cursor: null,
      limit: 25,
    });
    expect(() =>
      operations.getArchivedTranscriptPage({
        boundaryRef: "z".repeat(64),
        cursor: null,
        limit: 25,
      } as never),
    ).toThrow();
    expect(() => operations.listArchivedConversations({ chatId: "other" } as never)).toThrow();
    expect(readArchivedConversations).toHaveBeenCalledOnce();
    expect(readArchivedTranscriptPage).toHaveBeenCalledOnce();
    await expect(operations.deleteArchivedConversation({ boundaryRef })).resolves.toEqual({
      schemaVersion: 1,
      status: "deleted",
    });
    expect(deleteArchivedConversation).toHaveBeenCalledWith({ boundaryRef });
    expect(() =>
      operations.deleteArchivedConversation({ boundaryRef: "invalid" } as never),
    ).toThrow();
    expect(deleteArchivedConversation).toHaveBeenCalledOnce();

    const unwired = createCoachOperations(wiring);
    expect(() => unwired.listArchivedConversations({})).toThrow(TypeError);
    expect(() =>
      unwired.getArchivedTranscriptPage({ boundaryRef, cursor: null, limit: 25 }),
    ).toThrow(TypeError);
    expect(() => unwired.deleteArchivedConversation({ boundaryRef })).toThrow(TypeError);
  });

  it("imports synthetic activity files through the live store and deduplicates reruns", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-operations-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const databasePath = join(root, "coach.db");
    let store = openSqliteStorage(databasePath);
    try {
      await runMigrations(store, MIGRATIONS);
      const liveContext: CoachStoreWriterContext = {
        home: liveHome,
        store,
        listener: {} as CoachStoreWriterContext["listener"],
      };
      const operations = createCoachOperations({
        home: liveHome,
        context: liveContext,
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      });
      const paths = ["brick-cycling.fit", "fallback-cycling.tcx", "fallback-cycling.gpx"].map(
        (name) => resolve(import.meta.dirname, "../../kernel-node/tests/fixtures/ingest", name),
      );
      const first = await operations.importFiles({ paths });
      expect(first.files).toEqual({ total: 3, imported: 3, quarantined: 0 });
      expect(first.changes.rawFilesInserted).toBe(3);
      expect(Number((await store.get("SELECT count(*) AS count FROM raw_file"))?.count)).toBe(3);
      expect(
        (await readdir(liveHome.archiveDir, { recursive: true })).filter((entry) =>
          /\.(fit|tcx|gpx)$/u.test(entry),
        ),
      ).toHaveLength(3);
      const second = await operations.importFiles({ paths });
      expect(second.changes.rawFilesInserted).toBe(0);
      expect(Number((await store.get("SELECT count(*) AS count FROM raw_file"))?.count)).toBe(3);
      await expect(operations.getSetupStatus?.({})).resolves.toEqual({
        schemaVersion: 1,
        intake: null,
        durableTrainingData: true,
      });
      await store.close();
      store = openSqliteStorage(databasePath);
      await runMigrations(store, MIGRATIONS);
      const relaunchedOperations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      });
      await expect(relaunchedOperations.getSetupStatus?.({})).resolves.toEqual({
        schemaVersion: 1,
        intake: null,
        durableTrainingData: true,
      });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("idempotently replaces one daemon-authored intake row", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-intake-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      const operations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      });
      await expect(
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
        }),
      ).resolves.toEqual({ schemaVersion: 1, saved: true });
      const first = await store.get("SELECT * FROM intake_flags");
      await operations.saveIntake({
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: true,
        clinician_cleared: true,
        injury_status: "none",
      });
      const historical = await store.get("SELECT * FROM intake_flags");
      expect(historical).toMatchObject({ clinician_cleared: null, injury_status: "none" });
      expect(historical).not.toHaveProperty("prior_bsi");
      await operations.saveIntake({
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: false,
        clinician_cleared: false,
        injury_status: "managing",
      });
      const second = await store.get("SELECT * FROM intake_flags");
      expect(await store.all("SELECT id FROM intake_flags")).toHaveLength(1);
      expect(second).toMatchObject({
        clinician_cleared: 0,
        injury_status: "managing",
        device_id: first?.device_id,
      });
      expect(second?.id).not.toBe(first?.id);
      expect(Number(second?.hlc_counter)).toBeGreaterThanOrEqual(Number(first?.hlc_counter));
      await expect(
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "managing",
        }),
      ).resolves.toEqual({ schemaVersion: 1, saved: true });
      expect(await store.get("SELECT * FROM intake_flags")).toMatchObject({
        clinician_cleared: null,
        injury_status: "managing",
      });
      await expect(operations.getSetupStatus?.({})).resolves.toEqual({
        schemaVersion: 1,
        intake: {
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "managing",
        },
        durableTrainingData: false,
      });
      await expect(async () =>
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
          extra: true,
        } as never),
      ).rejects.toThrow();
      await expect(
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "returning",
        }),
      ).resolves.toEqual({ schemaVersion: 1, saved: true });
      expect(await store.get("SELECT * FROM intake_flags")).toMatchObject({
        clinician_cleared: null,
        injury_status: "returning",
      });
      await expect(async () =>
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: true,
          injury_status: "none",
        }),
      ).rejects.toThrow();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects setup status when persisted intake is unreadable", async () => {
    const unreadableStore = {
      get: vi.fn(async () => ({ present: 1 })),
    } as unknown as CoachStoreWriterContext["store"];
    const operations = createCoachOperations(
      {
        home,
        context: {
          home,
          store: unreadableStore,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      {
        createIntakeRepository: () => ({
          replace: async () => {},
          read: async () => {
            throw new TypeError("corrupt intake row");
          },
        }),
      },
    );

    await expect(operations.getSetupStatus?.({})).rejects.toThrow("corrupt intake row");
  });

  it("rejects setup status when durable workout evidence is unreadable", async () => {
    const unreadableStore = {
      get: vi.fn(async () => {
        throw new TypeError("corrupt workout store");
      }),
    } as unknown as CoachStoreWriterContext["store"];
    const operations = createCoachOperations(
      {
        home,
        context: {
          home,
          store: unreadableStore,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      {
        createIntakeRepository: () => ({
          replace: async () => {},
          read: async () => undefined,
        }),
      },
    );

    await expect(operations.getSetupStatus?.({})).rejects.toThrow("corrupt workout store");
  });

  it("maps canonical import and sync reports with exact progress", async () => {
    const importFiles = vi.fn(async () => ({
      files: [{ outcome: "imported" }, { outcome: "quarantined" }],
      inserts: { raw_file: 1, source_record: 2 },
      updates: { source_record: 3, relinked_source_records: 4 },
    })) as unknown as Parameters<typeof createCoachOperations>[1] extends infer D
      ? D extends { importFiles: infer F }
        ? F
        : never
      : never;
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      await work(new AbortController().signal);
      return {
        published: true,
        legacySucceeded: false,
        counts: requestCounts(2, 1),
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: operationRuntime(runWindowAfter),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );
    const importEvents: unknown[] = [];
    await expect(
      operations.importFiles({ paths: ["/synthetic/a.fit", "/synthetic/b.tcx"] }, (event) =>
        importEvents.push(event),
      ),
    ).resolves.toEqual({
      schemaVersion: 2,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 2,
        sourceRecordsUpdated: 3,
        relinkedSourceRecords: 4,
      },
      publication: {
        scope: "activities-and-streams",
        status: "available",
      },
    });
    expect(importEvents).toEqual([
      { phase: "started", completed: 0, total: 2 },
      { phase: "completed", completed: 2, total: 2 },
    ]);
    await expect(
      operations.sync({}, () => {
        throw new Error("advisory");
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      backfill: "skipped-no-credential",
      published: true,
      referenceSucceeded: false,
      requests: { store: 2, reference: 1, total: 3 },
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    expect(importFiles).toHaveBeenCalledTimes(1);
    expect(runWindowAfter).toHaveBeenCalledTimes(1);
  });

  it("reports retryable publication failure without rejecting a completed import", async () => {
    const importFiles = vi.fn(async () => ({
      files: [{ outcome: "imported" }],
      inserts: { raw_file: 1, source_record: 1 },
      updates: { source_record: 0, relinked_source_records: 0 },
    })) as unknown as Parameters<typeof createCoachOperations>[1] extends infer D
      ? D extends { importFiles: infer F }
        ? F
        : never
      : never;
    const base = operationRuntime();
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: {
          ...base,
          async runActivityWrite(work) {
            return {
              value: await base.runExclusive(work),
              activityReadAvailable: false,
            };
          },
        },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );

    await expect(
      operations.importFiles({ paths: ["/synthetic/durable.fit"] }),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      changes: { rawFilesInserted: 1 },
      publication: {
        scope: "activities-and-streams",
        status: "retryable-failure",
      },
    });
  });

  it("serializes store operations in admission order and recovers after rejection", async () => {
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const importFiles = vi.fn(async () => {
      trace.push("import-start");
      await latch;
      trace.push("import-end");
      throw new Error("synthetic failure");
    }) as unknown as Parameters<typeof createCoachOperations>[1] extends infer D
      ? D extends { importFiles: infer F }
        ? F
        : never
      : never;
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      await work(new AbortController().signal);
      trace.push("sync");
      return {
        published: false,
        legacySucceeded: true,
        counts: requestCounts(0, 0),
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: operationRuntime(runWindowAfter),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );
    const first = operations.importFiles({ paths: ["/synthetic/a.fit"] });
    const second = operations.sync({});
    await Promise.resolve();
    expect(trace).toEqual(["import-start"]);
    release();
    await expect(first).rejects.toThrow("synthetic failure");
    await expect(second).resolves.toMatchObject({ schemaVersion: 1 });
    expect(trace).toEqual(["import-start", "import-end", "sync"]);
  });

  it("reports pending verification instead of a completed keyless sync", async () => {
    const backfill = vi.fn(async () => ({
      pages: 0,
      artifacts: 0,
      reports: [],
      droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
    }));
    const pending = { value: true };
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        intervalsVerificationPending: () => pending.value,
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { backfill },
    );
    await expect(operations.sync({})).resolves.toMatchObject({
      schemaVersion: 1,
      backfill: "pending-verification",
    });
    expect(backfill).not.toHaveBeenCalled();
    pending.value = false;
    await expect(operations.sync({})).resolves.toMatchObject({
      backfill: "skipped-no-credential",
    });
    expect(backfill).not.toHaveBeenCalled();
  });

  it("reads live credentials after admission and orders backfill before refresh and completion", async () => {
    const trace: string[] = [];
    const selectedContext = context();
    const credentials = {
      read: vi.fn(async () => {
        trace.push("credentials");
        return {
          apiKey: String.fromCharCode(116, 101, 115, 116),
          athleteId: "synthetic-athlete",
        };
      }),
    };
    const backfill = vi.fn(async () => {
      trace.push("backfill");
      return {
        pages: 1,
        artifacts: 1,
        reports: [],
        droppedActivityRows: { sourceRestricted: 60, other: 2, datedLocalDates: [], undatedCount: 62 },
      };
    });
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      trace.push("admitted");
      await work(new AbortController().signal);
      trace.push("window");
      return {
        published: true,
        legacySucceeded: true,
        counts: requestCounts(3, 2),
        droppedActivities: {
          overall: {
            total: 67,
            visible: 5,
            restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 60 }],
            other: 2,
          },
          recent7Days: {
            total: 5,
            visible: 1,
            restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 4 }],
            other: 0,
          },
        },
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: selectedContext,
        runtime: operationRuntime(runWindowAfter),
        intervalsCredentials: credentials,
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      },
      { backfill },
    );
    const result = await operations.sync({}, (event) => trace.push(event.phase));
    trace.push("terminal");
    expect(trace).toEqual([
      "started",
      "admitted",
      "credentials",
      "backfill",
      "window",
      "completed",
      "terminal",
    ]);
    expect(credentials.read).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith({
      home,
      store: selectedContext.store,
      apiKey: String.fromCharCode(116, 101, 115, 116),
      athleteId: "synthetic-athlete",
      historyNewestDate: "1998-07-18",
      calendarTimeZone: "UTC",
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      schemaVersion: 1,
      backfill: "completed",
      published: true,
      referenceSucceeded: true,
      requests: { store: 3, reference: 2, total: 5 },
      droppedActivities: {
        overall: {
          total: 67,
          visible: 5,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
          other: 2,
        },
        recent7Days: {
          total: 5,
          visible: 1,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
          other: 0,
        },
      },
    });
    const terminal = JSON.stringify(result);
    for (const privateValue of [
      String.fromCharCode(116, 101, 115, 116),
      "synthetic-athlete",
      "1998-07-18",
      home.archiveDir,
      "cursor",
      "payload",
      "cause",
    ]) {
      expect(terminal).not.toContain(privateValue);
    }
  });

  it("skips backfill for every empty-key state and defaults an empty athlete id", async () => {
    const pairs = [
      { apiKey: "", athleteId: "", outcome: "skip" },
      { apiKey: "", athleteId: "0", outcome: "skip" },
      { apiKey: "", athleteId: "synthetic-athlete", outcome: "skip" },
      { apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "0", outcome: "backfill" },
      {
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        outcome: "backfill",
      },
      { apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "", outcome: "backfill" },
    ] as const;
    for (const options of pairs) {
      const events: unknown[] = [];
      const backfill = vi.fn(async () => ({
        pages: 1,
        artifacts: 0,
        reports: [],
        droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
      }));
      const refresh = vi.fn();
      const runtime = {
        credentials: intervalsCredentials(options.apiKey, options.athleteId),
        ...operationRuntime(async (work: (signal: AbortSignal) => Promise<void>) => {
          await work(new AbortController().signal);
          refresh();
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
      };
      const operations = createCoachOperations(
        {
          home,
          context: context(),
          runtime,
          intervalsCredentials: runtime.credentials,
          historyNewestDate: () => "1998-07-18",
          calendarTimeZone: () => "UTC",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({}, (event) => events.push(event))).resolves.toMatchObject({
        schemaVersion: 1,
      });
      expect(events).toEqual([
        { phase: "started", completed: 0, total: 1 },
        { phase: "completed", completed: 1, total: 1 },
      ]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(backfill).toHaveBeenCalledTimes(options.outcome === "backfill" ? 1 : 0);
      if (options.outcome === "backfill") {
        expect(backfill).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: options.apiKey,
            athleteId: options.athleteId === "" ? "0" : options.athleteId,
          }),
        );
      }
    }
  });

  it("emits no false completion when backfill or the following refresh fails", async () => {
    for (const failurePoint of ["backfill", "window"] as const) {
      const events: unknown[] = [];
      const refresh = vi.fn();
      const backfill = vi.fn(async () => {
        if (failurePoint === "backfill") throw new Error("synthetic backfill failure");
        return {
          pages: 1,
          artifacts: 1,
          reports: [],
          droppedActivityRows: { sourceRestricted: 60, other: 2, datedLocalDates: [], undatedCount: 62 },
        };
      });
      const runtime = {
        intervals: intervalsCredentials(
          String.fromCharCode(116, 101, 115, 116),
          "synthetic-athlete",
        ),
        ...operationRuntime(async (work: (signal: AbortSignal) => Promise<void>) => {
          await work(new AbortController().signal);
          refresh();
          if (failurePoint === "window") throw new Error("synthetic window failure");
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
      };
      const operations = createCoachOperations(
        {
          home,
          context: context(),
          runtime,
          intervalsCredentials: runtime.intervals,
          historyNewestDate: () => "1998-07-18",
          calendarTimeZone: () => "UTC",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({}, (event) => events.push(event))).rejects.toThrow(
        `synthetic ${failurePoint} failure`,
      );
      expect(events).toEqual([{ phase: "started", completed: 0, total: 1 }]);
      expect(refresh).toHaveBeenCalledTimes(failurePoint === "window" ? 1 : 0);
    }
  });

  it("resumes a committed synthetic backfill step without duplicating input rows", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-sync-resume-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      await store.exec("CREATE TABLE synthetic_backfill_checkpoint (id TEXT PRIMARY KEY NOT NULL)");
      let attempt = 0;
      const backfill = vi.fn(async () => {
        await store.run("INSERT OR IGNORE INTO synthetic_backfill_checkpoint (id) VALUES (?)", [
          "page-1",
        ]);
        attempt += 1;
        if (attempt === 1) throw new Error("synthetic interruption");
        return {
          pages: 1,
          artifacts: 0,
          reports: [],
          droppedActivityRows: { sourceRestricted: 0, other: 0, datedLocalDates: [], undatedCount: 0 },
        };
      });
      const runtime = {
        intervals: intervalsCredentials(
          String.fromCharCode(116, 101, 115, 116),
          "synthetic-athlete",
        ),
        ...operationRuntime(async (work: (signal: AbortSignal) => Promise<void>) => {
          await work(new AbortController().signal);
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
      };
      const operations = createCoachOperations(
        {
          home: liveHome,
          context: {
            home: liveHome,
            store,
            listener: {} as CoachStoreWriterContext["listener"],
          },
          runtime,
          intervalsCredentials: runtime.intervals,
          historyNewestDate: () => "1998-07-18",
          calendarTimeZone: () => "UTC",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({})).rejects.toThrow("synthetic interruption");
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });
      expect(
        await store.get("SELECT count(*) AS count FROM synthetic_backfill_checkpoint"),
      ).toEqual({ count: 1 });
      expect(backfill).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies session configuration through its FIFO without waiting for the store lane", async () => {
    const syncStarted = promiseGate();
    const releaseSync = promiseGate();
    const trace: string[] = [];
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(async (work) => {
        trace.push("sync-start");
        syncStarted.release();
        await releaseSync.promise;
        await work(new AbortController().signal);
        trace.push("sync-end");
        return {
          published: true,
          legacySucceeded: true,
          counts: requestCounts(0, 0),
        };
      }),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {
        trace.push("configure");
      },
    });

    const sync = operations.sync({});
    await syncStarted.promise;
    await expect(
      operations.configureRuntime({
        session: { dailyResetHour: 6, timezone: "Europe/Berlin" },
      }),
    ).resolves.toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: false, intervals: false, session: true },
    });
    expect(trace).toEqual(["sync-start", "configure"]);

    releaseSync.release();
    await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
    expect(trace).toEqual(["sync-start", "configure", "sync-end"]);
  });

  it("propagates caller cancellation into runtime configuration", async () => {
    const started = promiseGate();
    let observedSignal: AbortSignal | undefined;
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async (_request, signal) => {
        observedSignal = signal;
        started.release();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = operations.configureRuntime(
      { llm: { provider: "openai-codex", model: "gpt-5.5" } },
      controller.signal,
    );
    await started.promise;

    controller.abort(new DOMException("Detached", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("validates intervals credential preflight requests and results", async () => {
    const verifyIntervalsCredential = vi.fn(async () => ({ approval: "a".repeat(64) }));
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
      verifyIntervalsCredential,
    });

    await expect(
      operations.verify_intervals_credential!({ api_key: "synthetic-candidate-key" }),
    ).resolves.toEqual({ approval: "a".repeat(64) });
    expect(verifyIntervalsCredential).toHaveBeenCalledWith(
      { api_key: "synthetic-candidate-key" },
      expect.any(AbortSignal),
    );
    expect(() =>
      operations.verify_intervals_credential!({
        api_key: "synthetic-candidate-key",
        extra: true,
      } as never),
    ).toThrow();
    expect(verifyIntervalsCredential).toHaveBeenCalledOnce();

    const refused = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
      verifyIntervalsCredential: async () => ({ reason: "credential-rejected" }),
    });
    await expect(
      refused.verify_intervals_credential!({ api_key: "synthetic-candidate-key" }),
    ).resolves.toEqual({ reason: "credential-rejected" });

    const malformed = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
      verifyIntervalsCredential: async () => ({ approval: "A".repeat(64) }),
    });
    await expect(
      malformed.verify_intervals_credential!({ api_key: "synthetic-candidate-key" }),
    ).rejects.toThrow();

    const unavailable = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
    });
    expect(() =>
      unavailable.verify_intervals_credential!({ api_key: "synthetic-candidate-key" }),
    ).toThrow("Intervals credential verification is unavailable.");
  });

  it("propagates caller cancellation into intervals credential preflight", async () => {
    const started = promiseGate();
    let observedSignal: AbortSignal | undefined;
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
      verifyIntervalsCredential: async (_request, signal): Promise<never> => {
        observedSignal = signal;
        started.release();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = operations.verify_intervals_credential!(
      { api_key: "synthetic-candidate-key" },
      controller.signal,
    );
    await started.promise;

    controller.abort(new DOMException("Detached", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    "credential-required",
    "ownership-unavailable",
    "training-account-mismatch",
    "managed-by-environment",
  ] as const)(
    "returns a strict fixed %s runtime refusal without echoing request values",
    async (reason) => {
      const operations = createCoachOperations({
        home,
        context: context(),
        runtime: operationRuntime(),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => reason,
      });

      const result = await operations.configureRuntime({
        intervals: {
          api_key: "obviously-fake-private-credential",
          athlete_id: "private-candidate-athlete",
        },
      });

      expect(result).toEqual({ schemaVersion: 3, status: "refused", reason });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("reads runtime configuration while a store sync is blocked", async () => {
    const syncStarted = promiseGate();
    const releaseSync = promiseGate();
    const trace: string[] = [];
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(async (work) => {
        trace.push("sync-start");
        syncStarted.release();
        await releaseSync.promise;
        await work(new AbortController().signal);
        trace.push("sync-end");
        return {
          published: true,
          legacySucceeded: true,
          counts: requestCounts(0, 0),
        };
      }),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async () => {},
      readRuntimeConfig: () => {
        trace.push("read");
        return {
          schemaVersion: 3,
          llm: { provider: "openai", model: "model-a", credential_configured: true },
          intervals: {
            athlete_id: "synthetic-athlete",
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
      },
    });

    const sync = operations.sync({});
    await syncStarted.promise;
    await expect(operations.getRuntimeConfig({})).resolves.toMatchObject({
      schemaVersion: 3,
      llm: { model: "model-a" },
    });
    expect(trace).toEqual(["sync-start", "read"]);

    releaseSync.release();
    await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
    expect(trace).toEqual(["sync-start", "read", "sync-end"]);
  });

  it("holds intervals configuration behind store sync without allowing later runtime operations to overtake", async () => {
    const syncStarted = promiseGate();
    const releaseSync = promiseGate();
    const trace: string[] = [];
    let activeModel = "initial";
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(async (work) => {
        trace.push("sync-start");
        syncStarted.release();
        await releaseSync.promise;
        await work(new AbortController().signal);
        trace.push("sync-end");
        return {
          published: true,
          legacySucceeded: true,
          counts: requestCounts(0, 0),
        };
      }),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async (request) => {
        if (request.intervals !== undefined) trace.push("intervals");
        if (request.llm !== undefined) {
          const model = request.llm.model;
          if (model === undefined) throw new Error("Expected a model patch.");
          activeModel = model;
          trace.push(`llm-${activeModel}`);
        }
      },
      readRuntimeConfig: () => {
        trace.push(`read-${activeModel}`);
        return {
          schemaVersion: 3,
          llm: { provider: "openai", model: activeModel, credential_configured: true },
          intervals: {
            athlete_id: "synthetic-athlete",
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
      },
    });

    const sync = operations.sync({});
    await syncStarted.promise;
    let intervalsSettled = false;
    const intervals = operations
      .configureRuntime({
        llm: { provider: "openai", model: "model-a", api_key: "placeholder-a" },
        intervals: { api_key: "placeholder-intervals", athlete_id: "synthetic-athlete" },
      })
      .then((result) => {
        intervalsSettled = true;
        return result;
      });
    const laterLlm = operations.configureRuntime({
      llm: { provider: "openai", model: "model-b", api_key: "placeholder-b" },
    });
    const laterRead = operations.getRuntimeConfig({});
    await Promise.resolve();
    expect(intervalsSettled).toBe(false);
    expect(trace).toEqual(["sync-start"]);

    releaseSync.release();
    const [syncResult, intervalsResult, laterLlmResult, laterReadResult] = await Promise.all([
      sync,
      intervals,
      laterLlm,
      laterRead,
    ]);
    expect(syncResult).toMatchObject({ schemaVersion: 1 });
    expect(intervalsResult).toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: true, session: false },
    });
    expect(laterLlmResult).toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    });
    expect(laterReadResult.llm.model).toBe("model-b");
    expect(trace).toEqual([
      "sync-start",
      "sync-end",
      "intervals",
      "llm-model-a",
      "llm-model-b",
      "read-model-b",
    ]);
  });

  it("expires an intervals configuration before delayed store admission without late mutation", async () => {
    const syncStarted = promiseGate();
    const releaseSync = promiseGate();
    const applyRuntimeConfig = vi.fn(async () => {});
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: operationRuntime(async (work) => {
          syncStarted.release();
          await releaseSync.promise;
          await work(new AbortController().signal);
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig,
      },
      { runtimeConfigurationDeadlineMs: 5 },
    );

    const sync = operations.sync({});
    await syncStarted.promise;
    const stale = operations
      .configureRuntime({
        intervals: { api_key: "placeholder-intervals", athlete_id: "synthetic-athlete" },
      })
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSync.release();

    await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
    expect(await stale).toBeInstanceOf(Error);
    expect(applyRuntimeConfig).not.toHaveBeenCalled();
    await expect(
      operations.configureRuntime({
        llm: { provider: "openai", model: "recovered-model", api_key: "placeholder" },
      }),
    ).resolves.toMatchObject({ applied: { llm: true, intervals: false } });
    expect(applyRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("serializes runtime configuration writes and reads in strict admission order", async () => {
    const firstStarted = promiseGate();
    const releaseFirst = promiseGate();
    const trace: string[] = [];
    let activeModel = "initial";
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async (request) => {
        const model = request.llm?.model ?? "intervals-only";
        trace.push(`configure-${model}-start`);
        if (model === "model-a") {
          firstStarted.release();
          await releaseFirst.promise;
        }
        activeModel = model;
        trace.push(`configure-${model}-end`);
      },
      readRuntimeConfig: () => {
        trace.push(`read-${activeModel}`);
        return {
          schemaVersion: 3,
          llm: { provider: "openai", model: activeModel, credential_configured: true },
          intervals: {
            athlete_id: "synthetic-athlete",
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
      },
    });

    const first = operations.configureRuntime({
      llm: { provider: "openai", model: "model-a", api_key: "placeholder-a" },
    });
    await firstStarted.promise;
    const second = operations.configureRuntime({
      llm: { provider: "openai", model: "model-b", api_key: "placeholder-b" },
    });
    const read = operations.getRuntimeConfig({});
    await Promise.resolve();
    expect(trace).toEqual(["configure-model-a-start"]);

    releaseFirst.release();
    const [firstResult, secondResult, readResult] = await Promise.all([first, second, read]);
    expect(firstResult).toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    });
    expect(secondResult).toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    });
    expect(readResult.llm.model).toBe("model-b");
    expect(trace).toEqual([
      "configure-model-a-start",
      "configure-model-a-end",
      "configure-model-b-start",
      "configure-model-b-end",
      "read-model-b",
    ]);
  });

  it("continues both serialized lanes after an intervals configuration rejection", async () => {
    const syncStarted = promiseGate();
    const releaseSync = promiseGate();
    const trace: string[] = [];
    let syncAttempt = 0;
    let activeModel = "initial";
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(async (work) => {
        syncAttempt += 1;
        trace.push(`sync-${syncAttempt}-start`);
        if (syncAttempt === 1) {
          syncStarted.release();
          await releaseSync.promise;
        }
        await work(new AbortController().signal);
        trace.push(`sync-${syncAttempt}-end`);
        return {
          published: true,
          legacySucceeded: true,
          counts: requestCounts(0, 0),
        };
      }),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig: async (request) => {
        if (request.intervals !== undefined) {
          trace.push("intervals-reject");
          throw new Error("synthetic configuration failure");
        }
        activeModel = request.llm?.model ?? activeModel;
        trace.push(`llm-${activeModel}`);
      },
      readRuntimeConfig: () => ({
        schemaVersion: 3,
        llm: { provider: "openai", model: activeModel, credential_configured: true },
        intervals: {
          athlete_id: "synthetic-athlete",
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
      }),
    });

    const firstSync = operations.sync({});
    await syncStarted.promise;
    const intervals = operations.configureRuntime({
      intervals: { api_key: "placeholder-intervals", athlete_id: "synthetic-athlete" },
    });
    const intervalsFailure = intervals.catch((error: unknown) => error);
    await Promise.resolve();
    const laterLlm = operations.configureRuntime({
      llm: { provider: "openai", model: "model-b", api_key: "placeholder-b" },
    });
    const laterRead = operations.getRuntimeConfig({});
    const nextSync = operations.sync({});
    await Promise.resolve();
    expect(trace).toEqual(["sync-1-start"]);

    releaseSync.release();
    await expect(firstSync).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(intervalsFailure).resolves.toEqual(
      expect.objectContaining({ message: "synthetic configuration failure" }),
    );
    await expect(laterLlm).resolves.toEqual({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    });
    await expect(laterRead).resolves.toMatchObject({ llm: { model: "model-b" } });
    await expect(nextSync).resolves.toMatchObject({ schemaVersion: 1 });
    expect(trace.slice(0, 3)).toEqual(["sync-1-start", "sync-1-end", "intervals-reject"]);
    expect(trace.indexOf("llm-model-b")).toBeGreaterThan(trace.indexOf("intervals-reject"));
    expect(trace.indexOf("sync-2-start")).toBeGreaterThan(trace.indexOf("intervals-reject"));
    expect(trace.indexOf("sync-2-end")).toBeGreaterThan(trace.indexOf("sync-2-start"));
  });

  it("applies llm-only, intervals-only, both, and superseding runtime requests without echo", async () => {
    const applied: unknown[] = [];
    const applyRuntimeConfig = vi.fn(async (request) => {
      applied.push(request);
    });
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: operationRuntime(),
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig,
      readRuntimeConfig: () => ({
        schemaVersion: 3,
        llm: { provider: "google", model: "third", credential_configured: true },
        intervals: {
          athlete_id: "athlete-b",
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
      }),
    });
    const llmFirst = {
      llm: { provider: "anthropic" as const, model: "first", api_key: "placeholder" },
    };
    const intervalsOnly = {
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    };
    const both = {
      llm: { provider: "openrouter" as const, model: "second", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-b" },
    };
    const results = [
      await operations.configureRuntime(llmFirst),
      await operations.configureRuntime(intervalsOnly),
      await operations.configureRuntime(both),
      await operations.configureRuntime({
        llm: { provider: "google", model: "third", api_key: "placeholder" },
      }),
    ];
    expect(results).toEqual([
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: false, session: false },
      },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: false, intervals: true, session: false },
      },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: false },
      },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: false, session: false },
      },
    ]);
    expect(applied).toEqual([
      llmFirst,
      intervalsOnly,
      both,
      {
        llm: { provider: "google", model: "third", api_key: "placeholder" },
      },
    ]);
    const serializedResults = JSON.stringify(results);
    for (const value of ["first", "second", "third", "placeholder", "athlete"]) {
      expect(serializedResults).not.toContain(value);
    }
    await expect(operations.getRuntimeConfig({})).resolves.toEqual({
      schemaVersion: 3,
      llm: { provider: "google", model: "third", credential_configured: true },
      intervals: {
        athlete_id: "athlete-b",
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
    });
  });

  it("serializes persisted units reads and writes through the same operation FIFO", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-units-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    try {
      await runMigrations(store, MIGRATIONS);
      const operations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(async (work) => {
          order.push("sync-start");
          await gate;
          await work(new AbortController().signal);
          order.push("sync-end");
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      });
      const sync = operations.sync({});
      const write = operations.setUnitsPreference!({ value: "imperial" }).then((result) => {
        order.push("write");
        return result;
      });
      const read = operations.getUnitsPreference!({}).then((result) => {
        order.push("read");
        return result;
      });
      await Promise.resolve();
      expect(order).toEqual(["sync-start"]);
      release();
      await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(write).resolves.toEqual({ value: "imperial", source: "cycling" });
      await expect(read).resolves.toEqual({ value: "imperial", source: "cycling" });
      expect(order).toEqual(["sync-start", "sync-end", "write", "read"]);
      await expect(
        store.get("SELECT preferred_units, device_id FROM sport_settings"),
      ).resolves.toMatchObject({
        preferred_units: "imperial",
        device_id: expect.stringMatching(/^desktop:[0-9A-HJKMNP-TV-Z]{26}$/u),
      });
    } finally {
      release();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes persisted language reads and writes through the same operation FIFO", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-language-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    try {
      await runMigrations(store, MIGRATIONS);
      const operations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: operationRuntime(async (work) => {
          order.push("sync-start");
          await gate;
          await work(new AbortController().signal);
          order.push("sync-end");
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        }),
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
      });
      const sync = operations.sync({});
      const write = operations.setLanguagePreference!({ value: "it" }).then((result) => {
        order.push("write");
        return result;
      });
      const read = operations.getLanguagePreference!({}).then((result) => {
        order.push("read");
        return result;
      });
      await Promise.resolve();
      expect(order).toEqual(["sync-start"]);
      release();
      await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(write).resolves.toEqual({ value: "it" });
      await expect(read).resolves.toEqual({ value: "it" });
      expect(order).toEqual(["sync-start", "sync-end", "write", "read"]);
      await expect(
        store.get("SELECT language, device_id FROM athlete_language"),
      ).resolves.toMatchObject({
        language: "it",
        device_id: expect.stringMatching(/^desktop:[0-9A-HJKMNP-TV-Z]{26}$/u),
      });
      await expect(operations.setLanguagePreference!({ value: null })).resolves.toEqual({
        value: null,
      });
      await expect(operations.getLanguagePreference!({})).resolves.toEqual({ value: null });
      await store.run("UPDATE athlete_language SET language = 'xx'");
      await expect(operations.getLanguagePreference!({})).resolves.toEqual({ value: null });
    } finally {
      release();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
