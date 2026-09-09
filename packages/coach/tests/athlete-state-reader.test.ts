import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AthleteStateSchema,
  type TrainingHistoryComputed,
  type TrainingHistoryProjection,
} from "@enduragent/coach-contract";
import {
  ERROR_STATE_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  SCHEDULER_SCHEMA_VERSION,
} from "@enduragent/kernel/reference/schemas";
import {
  AthleteStateUnavailableError,
  createPersistedAthleteStateSource,
} from "../src/athlete-state-reader.js";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import("node:fs/promises").readFile>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMocks.readFile };
});

const roots: string[] = [];
const T0 = "1998-07-17T23:59:58.000Z";
const T1 = "1998-07-18T00:00:00.000Z";
const T2 = "1998-07-18T06:00:01+06:00";

async function home(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-athlete-state-"));
  roots.push(root);
  await mkdir(join(root, "data"));
  return root;
}

function latest(
  freshness: "fresh" | "flag" | "stale" | "critical" = "fresh",
  lastUpdated = "2026-07-18T00:00:00.000Z",
) {
  return {
    metadata: {
      schema_version: LATEST_SCHEMA_VERSION,
      last_updated: lastUpdated,
      freshness,
    },
    athlete_profile: { name: "Synthetic Athlete" },
    current_status: { summary: "ready" },
    derived_metrics: {
      eftp: 250,
      acwr: 1.2,
      "capability.dfa_a1_profile": { value: 0.7 },
      future_metric: { value: 1 },
    },
    derived_metrics_meta: {
      sportFamily: "cycling",
      prescriptionBasis: "power",
      anchorType: "ftp",
      analysisBasis: "power",
    },
    recent_activities: [{ id: "activity-1" }],
    planned_workouts: [{ id: "workout-1" }],
    wellness_data: { restingHr: 45 },
  };
}

function schedulerState(lastSyncAt: string | null = T2) {
  return {
    schema_version: SCHEDULER_SCHEMA_VERSION,
    last_sync_at: lastSyncAt,
    next_sync_at: "1998-07-18T01:00:00.000Z",
  };
}

function errorState(mitigation: "block_coaching" | "warn_only" = "warn_only") {
  return {
    schema_version: ERROR_STATE_SCHEMA_VERSION,
    step: "synthetic",
    detail: "synthetic outage",
    ts: "2026-07-18T01:00:00.000Z",
    mitigation,
  };
}

async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(root, "data", name), JSON.stringify(value));
}

const resolver: CyclingFtpAnchorResolver = {
  resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }),
};

function trainingHistoryRide(id: string, localDate: string, startEpochSeconds: number) {
  return {
    id: id.repeat(64),
    title: "Synthetic ride",
    subSport: "road",
    startEpochSeconds,
    timezoneOffsetSeconds: 21_600,
    localDate,
    ridingSeconds: 3_600,
    ridingTimeBasis: "moving" as const,
    elapsedSeconds: 3_700,
    distanceMeters: 40_000,
    load: 70,
    averagePowerWatts: 200,
    averageHeartRateBpm: 140,
    perceivedExertion: 5,
    energyKilojoules: 720,
  };
}

function computedTrainingHistory(): TrainingHistoryComputed {
  const anchorRide = trainingHistoryRide("a", "1998-07-17", 900_000_000);
  const previousRide = trainingHistoryRide("b", "1998-07-10", 899_400_000);
  const week = (
    id: "anchor" | "previous",
    window: { readonly start: string; readonly end: string },
    ride: ReturnType<typeof trainingHistoryRide>,
  ) => ({
    id,
    window,
    calendarState: id === "anchor" ? ("open" as const) : ("closed" as const),
    coverage: { kind: "complete" as const },
    totals: {
      rideCount: { kind: "computed" as const, value: 1 },
      ridingSeconds: { kind: "computed" as const, value: 3_600 },
      distanceMeters: { kind: "computed" as const, value: 40_000 },
      load: { kind: "computed" as const, value: 70 },
    },
    rides: {
      count: { kind: "exact" as const, value: 1 },
      items: [ride],
      truncated: false,
    },
    trend: { kind: "unavailable" as const, reason: "limited-history" as const },
    callout:
      id === "anchor"
        ? {
            kind: "longest-ride-28d" as const,
            rideId: ride.id,
            durationSeconds: ride.ridingSeconds,
            window: { start: "1998-06-21", end: "1998-07-18" },
            comparisonRideCount: 4,
          }
        : null,
  });
  return {
    kind: "computed",
    asOf: T1,
    calendarTimeZone: "UTC",
    displayMode: "current",
    coverage: {
      kind: "contiguous",
      start: "1998-01-01",
      through: "1998-07-18",
      committedAt: T0,
    },
    anchorWeek: week("anchor", { start: "1998-07-13", end: "1998-07-19" }, anchorRide),
    previousWeek: week("previous", { start: "1998-07-06", end: "1998-07-12" }, previousRide),
  };
}

function source(dataDir: string) {
  return createPersistedAthleteStateSource({ dataDir, cyclingFtpAnchorResolver: resolver });
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.readFile.mockReset();
  fsMocks.readFile.mockImplementation(actual.readFile);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted athlete state source", () => {
  it("returns a stale last-good panel for thrown and malformed section reads", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    let response: TrainingHistoryProjection | "throw" | "malformed" = computedTrainingHistory();
    const readTrainingHistory = vi.fn(async (): Promise<TrainingHistoryProjection> => {
      if (response === "throw") throw new Error("private training history failure");
      if (response === "malformed") return { kind: "computed" } as never;
      return response;
    });
    const reader = createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => new Date(T2),
      trainingHistorySource: { readTrainingHistory },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    });

    const computed = (await reader.getAthleteState()).trainingContext?.trainingHistory;
    expect(computed).toMatchObject({
      kind: "computed",
      anchorWeek: { callout: { kind: "longest-ride-28d" } },
      previousWeek: { callout: null },
    });
    response = "throw";
    const thrown = (await reader.getAthleteState()).trainingContext?.trainingHistory;
    expect(thrown).toMatchObject({
      kind: "stale",
      failedAt: new Date(T2).toISOString(),
      reason: "temporary-failure",
      lastGood: { anchorWeek: { callout: null }, previousWeek: { callout: null } },
    });
    expect(JSON.stringify(thrown)).not.toContain("private training history failure");

    response = "malformed";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toMatchObject({
      kind: "stale",
      lastGood: { anchorWeek: { callout: null }, previousWeek: { callout: null } },
    });
  });

  it("drops last-good history when the source owner or calendar timezone changes", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    let sourceOwner = "synthetic-athlete-a";
    let calendarTimeZone = "UTC";
    let fail = false;
    const reader = createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      trainingHistorySource: {
        readTrainingHistory: async () => {
          if (fail) return { kind: "unavailable", reason: "temporary-failure" };
          return computedTrainingHistory();
        },
      },
      sourceOwner: () => sourceOwner,
      calendarTimeZone: () => calendarTimeZone,
    });

    await reader.getAthleteState();
    fail = true;
    sourceOwner = "synthetic-athlete-b";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
    sourceOwner = "synthetic-athlete-a";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });

    fail = false;
    await reader.getAthleteState();
    fail = true;
    calendarTimeZone = "Asia/Almaty";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
    calendarTimeZone = "UTC";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
  });

  it("uses last-good history for returned temporary failures only", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    let response: TrainingHistoryProjection | "throw" = computedTrainingHistory();
    const reader = createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      trainingHistorySource: {
        readTrainingHistory: async () => {
          if (response === "throw") throw new Error("synthetic");
          return response;
        },
      },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
      now: () => new Date(T1),
    });

    await reader.getAthleteState();
    for (const reason of ["coverage-unavailable", "invalid-data"] as const) {
      response = { kind: "unavailable", reason };
      expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toEqual(response);
    }
    response = { kind: "unavailable", reason: "temporary-failure" };
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory).toMatchObject({
      kind: "stale",
      failedAt: T1,
      reason: "temporary-failure",
      lastGood: { anchorWeek: { callout: null }, previousWeek: { callout: null } },
    });
    response = "throw";
    expect((await reader.getAthleteState()).trainingContext?.trainingHistory.kind).toBe("stale");

    const withoutCache = createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      trainingHistorySource: {
        readTrainingHistory: async () => ({ kind: "computed" }) as never,
      },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    });
    expect((await withoutCache.getAthleteState()).trainingContext?.trainingHistory).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
  });

  it("projects training history without a Reference snapshot", async () => {
    const root = await home();
    const now = new Date("1998-07-18T12:00:00.000Z");
    const readTrainingHistory = vi.fn(async () => computedTrainingHistory());

    const state = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => now,
      trainingHistorySource: { readTrainingHistory },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    }).getAthleteState();

    expect(AthleteStateSchema.parse(state)).toEqual(state);
    expect(readTrainingHistory).toHaveBeenCalledWith({
      asOf: now.toISOString(),
      asOfEpochSeconds: now.getTime() / 1_000,
      calendarTimeZone: "UTC",
      freshness: "fresh",
      sourceRestricted: false,
    });
    expect(state.trainingContext?.recentRides).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
    expect(state.trainingContext?.trainingHistory).toMatchObject({ kind: "computed" });
  });

  it("derives canonical-store training-history freshness from the successful sync marker", async () => {
    const root = await home();
    const now = new Date("1998-07-23T00:00:00.000Z");
    await writeJson(root, ".scheduler.json", schedulerState(T1));
    const readTrainingHistory = vi.fn(async () => computedTrainingHistory());

    const state = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => now,
      trainingHistorySource: { readTrainingHistory },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    }).getAthleteState();

    expect(readTrainingHistory).toHaveBeenCalledWith({
      asOf: now.toISOString(),
      asOfEpochSeconds: now.getTime() / 1_000,
      calendarTimeZone: "UTC",
      freshness: "stale",
      sourceRestricted: false,
    });
    expect(state.freshness).toBe("stale");
    expect(state.lastUpdated).toBe(T1);
    expect(state.lastSynced).toBe(T1);
  });

  it("evaluates training history now and prefers the successful sync marker for freshness", async () => {
    const root = await home();
    const now = new Date("1998-07-23T00:00:00.000Z");
    await writeJson(root, "latest.json", latest("critical", T1));
    await writeJson(root, ".scheduler.json", schedulerState(now.toISOString()));
    const readTrainingHistory = vi.fn(async () => computedTrainingHistory());

    await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => now,
      trainingHistorySource: { readTrainingHistory },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    }).getAthleteState();

    expect(readTrainingHistory).toHaveBeenCalledWith({
      asOf: now.toISOString(),
      asOfEpochSeconds: now.getTime() / 1_000,
      calendarTimeZone: "UTC",
      freshness: "fresh",
      sourceRestricted: false,
    });
  });

  it("falls back to payload time when no successful sync marker exists", async () => {
    const root = await home();
    const now = new Date("1998-07-23T00:00:00.000Z");
    await writeJson(root, "latest.json", latest("fresh", T1));
    const readTrainingHistory = vi.fn(async () => computedTrainingHistory());

    await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => now,
      trainingHistorySource: { readTrainingHistory },
      sourceOwner: () => "synthetic-athlete",
      calendarTimeZone: () => "UTC",
    }).getAthleteState();

    expect(readTrainingHistory).toHaveBeenCalledWith({
      asOf: now.toISOString(),
      asOfEpochSeconds: now.getTime() / 1_000,
      calendarTimeZone: "UTC",
      freshness: "stale",
      sourceRestricted: false,
    });
  });

  it("returns canonical recent rides without a Reference snapshot", async () => {
    const root = await home();
    const now = new Date("1998-07-18T12:00:00.000Z");
    const recentRide = {
      id: "a".repeat(64),
      subSport: "road",
      startEpochSeconds: 900_000_000,
      timezoneOffsetSeconds: 0,
      localDate: "1998-07-09",
      elapsedSeconds: 3_700,
      movingSeconds: 3_600,
      distanceMeters: 40_000,
    } as const;
    const readRecentRides = vi.fn(async () => ({
      kind: "computed" as const,
      asOf: now.toISOString(),
      windowDays: 28 as const,
      items: [recentRide],
    }));

    const state = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      now: () => now,
      recentRidesSource: { readRecentRides },
    }).getAthleteState();

    expect(AthleteStateSchema.parse(state)).toEqual(state);
    expect(readRecentRides).toHaveBeenCalledWith({
      asOf: now.toISOString(),
      asOfEpochSeconds: now.getTime() / 1_000,
    });
    expect(state).toMatchObject({
      lastUpdated: now.toISOString(),
      freshness: "fresh",
      degraded: false,
      lastSynced: null,
      athleteProfile: null,
      currentStatus: null,
      derivedMetrics: {},
      recentActivities: [],
      plannedWorkouts: [],
      wellness: null,
      trainingContext: {
        recentRides: { kind: "computed", items: [recentRide] },
        anchorZones: { kind: "unknown", reason: "not-synced" },
      },
    });
  });

  it("maps every persisted field into a contract-valid state", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    await writeJson(root, "error_state.json", errorState());
    await writeJson(root, ".scheduler.json", schedulerState());
    const state = await source(root).getAthleteState();
    expect(AthleteStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      schemaVersion: LATEST_SCHEMA_VERSION,
      lastUpdated: T1,
      lastSynced: T2,
      freshness: "fresh",
      degraded: false,
      athleteProfile: { name: "Synthetic Athlete" },
      currentStatus: { summary: "ready" },
      recentActivities: [{ id: "activity-1" }],
      plannedWorkouts: [{ id: "workout-1" }],
      wellness: { restingHr: 45 },
    });
  });

  it("removes both reveal-fenced keys and preserves future metric keys", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest());
    const state = await source(root).getAthleteState();
    expect(state.derivedMetrics).toEqual({ eftp: 250, future_metric: { value: 1 } });
    expect(Object.hasOwn(state.derivedMetrics, "acwr")).toBe(false);
    expect(Object.hasOwn(state.derivedMetrics, "capability.dfa_a1_profile")).toBe(false);
  });

  it("retains the prior latest bytes and marks block-coaching degradation", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("flag"));
    await writeJson(root, "error_state.json", errorState("block_coaching"));
    await writeJson(root, ".scheduler.json", schedulerState(T0));
    const state = await source(root).getAthleteState();
    expect(state.degraded).toBe(true);
    expect(state.freshness).toBe("flag");
    expect(state.currentStatus).toEqual({ summary: "ready" });
    expect(state.plannedWorkouts).toEqual([{ id: "workout-1" }]);
    expect(state.lastSynced).toBe(T0);
  });

  it("retains a committed sync marker older than the latest data mutation", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    await writeJson(root, ".scheduler.json", schedulerState(T0));
    await expect(source(root).getAthleteState()).resolves.toMatchObject({
      lastUpdated: T1,
      lastSynced: T0,
    });
  });

  it("keeps valid athlete state readable with null for every unusable scheduler state", async () => {
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly arrange: (root: string) => Promise<unknown>;
    }> = [
      { name: "missing", arrange: async () => {} },
      {
        name: "unreadable",
        arrange: async (root) => mkdir(join(root, "data", ".scheduler.json")),
      },
      {
        name: "malformed JSON",
        arrange: async (root) => writeFile(join(root, "data", ".scheduler.json"), "{"),
      },
      {
        name: "strict-schema-invalid",
        arrange: async (root) =>
          writeJson(root, ".scheduler.json", { ...schedulerState(), unexpected: true }),
      },
      {
        name: "wrong-version",
        arrange: async (root) =>
          writeJson(root, ".scheduler.json", {
            ...schedulerState(),
            schema_version: "different",
          }),
      },
      {
        name: "null marker",
        arrange: async (root) => writeJson(root, ".scheduler.json", schedulerState(null)),
      },
      {
        name: "invalid timestamp",
        arrange: async (root) =>
          writeJson(root, ".scheduler.json", schedulerState("1998-02-30T12:00:00.000Z")),
      },
    ];
    for (const variant of variants) {
      const root = await home();
      await writeJson(root, "latest.json", latest("fresh", T1));
      await variant.arrange(root);
      const state = await source(root).getAthleteState();
      expect(AthleteStateSchema.parse(state), variant.name).toEqual(state);
      expect(state, variant.name).toMatchObject({ lastUpdated: T1, lastSynced: null });
    }
  });

  it("does not fabricate first-sync success from latest, error, schedule, or file times", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    await writeJson(root, "error_state.json", errorState("block_coaching"));
    const future = new Date("2098-01-01T00:00:00.000Z");
    await utimes(join(root, "data", "latest.json"), future, future);
    const state = await source(root).getAthleteState();
    expect(state.lastUpdated).toBe(T1);
    expect(state.lastSynced).toBeNull();
  });

  it("changes only lastSynced on the next read when only the commit marker changes", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    await writeJson(root, ".scheduler.json", schedulerState(T0));
    const reader = source(root);
    const first = await reader.getAthleteState();
    await writeJson(root, ".scheduler.json", schedulerState(T2));
    const second = await reader.getAthleteState();
    const { lastSynced: firstLastSynced, ...firstRest } = first;
    const { lastSynced: secondLastSynced, ...secondRest } = second;
    expect(firstLastSynced).toBe(T0);
    expect(secondLastSynced).toBe(T2);
    expect(secondRest).toEqual(firstRest);
  });

  it("settles the scheduler read before starting one read of each snapshot path", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("fresh", T1));
    await writeJson(root, "error_state.json", errorState());
    const latestPath = join(root, "data", "latest.json");
    const errorPath = join(root, "data", "error_state.json");
    const schedulerPath = join(root, "data", ".scheduler.json");
    const reads = new Map<string, number>();
    const events: string[] = [];
    let markerAvailable = false;
    let rejectFirstSchedulerRead: (reason: unknown) => void = () => {
      throw new Error("scheduler read did not start");
    };
    const firstSchedulerRead = new Promise<never>((_resolve, reject) => {
      rejectFirstSchedulerRead = reject;
    });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fsMocks.readFile.mockImplementation(async (path, options) => {
      const persistedPath = path.toString();
      reads.set(persistedPath, (reads.get(persistedPath) ?? 0) + 1);
      events.push(`start:${persistedPath}`);
      if (persistedPath !== schedulerPath) return actual.readFile(path, options);
      if (!markerAvailable) return firstSchedulerRead;
      return JSON.stringify(schedulerState(T2));
    });

    const reader = source(root);
    const pendingFirst = reader.getAthleteState();
    expect(events).toEqual([`start:${schedulerPath}`]);
    expect(reads).toEqual(new Map([[schedulerPath, 1]]));

    events.push(`settle:${schedulerPath}`);
    rejectFirstSchedulerRead(new Error("synthetic missing marker"));
    markerAvailable = true;
    events.push(`available:${schedulerPath}`);
    const first = await pendingFirst;
    expect(first).toMatchObject({ lastUpdated: T1, lastSynced: null });
    expect(events).toEqual([
      `start:${schedulerPath}`,
      `settle:${schedulerPath}`,
      `available:${schedulerPath}`,
      `start:${latestPath}`,
      `start:${errorPath}`,
    ]);
    expect(reads).toEqual(
      new Map([
        [schedulerPath, 1],
        [latestPath, 1],
        [errorPath, 1],
      ]),
    );

    const second = await reader.getAthleteState();
    expect(second).toMatchObject({ lastUpdated: T1, lastSynced: T2 });
    expect(reads).toEqual(
      new Map([
        [schedulerPath, 2],
        [latestPath, 2],
        [errorPath, 2],
      ]),
    );
  });

  it("fails open for every absent, malformed, invalid, or mismatched error sidecar", async () => {
    const variants: unknown[] = [
      undefined,
      "{",
      { no: "schema" },
      {
        ...errorState("block_coaching"),
        schema_version: "different",
      },
    ];
    for (const variant of variants) {
      const root = await home();
      await writeJson(root, "latest.json", latest());
      if (variant !== undefined) {
        await writeFile(
          join(root, "data", "error_state.json"),
          typeof variant === "string" ? variant : JSON.stringify(variant),
        );
      }
      await expect(source(root).getAthleteState()).resolves.toMatchObject({ degraded: false });
    }
  });

  it("preserves all persisted freshness bands despite later file timestamps", async () => {
    for (const freshness of ["fresh", "flag", "stale", "critical"] as const) {
      const root = await home();
      await writeJson(root, "latest.json", latest(freshness));
      const future = new Date("2030-01-01T00:00:00.000Z");
      await utimes(join(root, "data", "latest.json"), future, future);
      await expect(source(root).getAthleteState()).resolves.toMatchObject({ freshness });
    }
  });

  it("throws the stable unavailable error for absent, invalid, and wrong-version latest", async () => {
    const variants: unknown[] = [
      undefined,
      "{",
      latest(),
      {
        ...latest(),
        metadata: { ...latest().metadata, schema_version: "different" },
      },
    ];
    (variants[2] as ReturnType<typeof latest>).metadata.freshness = "invalid" as never;
    for (const variant of variants) {
      const root = await home();
      await writeJson(root, ".scheduler.json", schedulerState());
      if (variant !== undefined) {
        await writeFile(
          join(root, "data", "latest.json"),
          typeof variant === "string" ? variant : JSON.stringify(variant),
        );
      }
      await expect(source(root).getAthleteState()).rejects.toEqual(
        new AthleteStateUnavailableError("No validated athlete state is available."),
      );
    }
  });

  it("reads a single persisted snapshot per call without exposing file paths or schema issues", async () => {
    const root = await home();
    const selected = latest();
    await writeJson(root, "latest.json", selected);
    await writeJson(root, "error_state.json", errorState());
    const reader = source(root);
    const first = await reader.getAthleteState();
    selected.current_status = { summary: "changed" };
    await writeJson(root, "latest.json", selected);
    const second = await reader.getAthleteState();
    expect(first.currentStatus).toEqual({ summary: "ready" });
    expect(second.currentStatus).toEqual({ summary: "changed" });
    const unavailableRoot = await home();
    const failure = await source(unavailableRoot)
      .getAthleteState()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AthleteStateUnavailableError);
    expect(String(failure)).not.toContain(unavailableRoot);
    expect(String(failure)).not.toContain("Zod");
  });

  it("resolves the anchor once at the persisted instant and always returns training context", async () => {
    const root = await home();
    const snapshot = latest();
    snapshot.recent_activities = [
      {
        id: "ride-1",
        start_date_local: "2026-07-17T08:00:00",
        type: "Ride",
        moving_time: 3600,
        elapsed_time: 3700,
        icu_training_load: 80,
      },
    ] as never;
    snapshot.planned_workouts = [
      {
        id: 1,
        category: "WORKOUT",
        start_date_local: "2026-07-19T08:00:00",
        name: "Endurance",
        type: "Ride",
      },
    ] as never;
    snapshot.wellness_data = [
      {
        id: "2026-07-17",
        weight: 70,
        restingHR: 48,
        hrv: 62,
        sleepSecs: 28_800,
        sleepQuality: 3,
      },
    ] as never;
    snapshot.derived_metrics = {
      consistency_index: 1,
      consistency_details: { planned_days: 1, completed_days: 1, matched_days: 1 },
    } as never;
    await writeJson(root, "latest.json", snapshot);
    const resolve = vi.fn(async () => ({
      kind: "ftp" as const,
      watts: 250,
      validFrom: "2026-06-01",
      source: "manual",
      confidence: "manual" as const,
      ageDays: 47,
      stalenessBand: "aging" as const,
      stale: true,
    }));
    const readPowerProgress = vi.fn(async () => ({
      kind: "unavailable" as const,
      reason: "insufficient-data" as const,
    }));
    const recentRide = {
      id: "a".repeat(64),
      subSport: "road",
      startEpochSeconds: 1_658_102_400,
      timezoneOffsetSeconds: 21_600,
      localDate: "2022-07-18",
      elapsedSeconds: 3_700,
      movingSeconds: 3_600,
      distanceMeters: 40_000,
    } as const;
    const readRecentRides = vi.fn(async () => ({
      kind: "computed" as const,
      asOf: snapshot.metadata.last_updated,
      windowDays: 28 as const,
      items: [recentRide],
    }));
    const state = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: { resolve },
      powerProgressSource: { readPowerProgress },
      recentRidesSource: { readRecentRides },
    }).getAthleteState();
    const expectedEpoch = Date.parse(snapshot.metadata.last_updated) / 1_000;
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      effectiveAtEpochS: expectedEpoch,
      evaluatedAtEpochS: expectedEpoch,
    });
    expect(readPowerProgress).toHaveBeenCalledOnce();
    expect(readRecentRides).toHaveBeenCalledWith({
      asOf: snapshot.metadata.last_updated,
      asOfEpochSeconds: expectedEpoch,
    });
    expect(state.trainingContext).toMatchObject({
      performanceProgress: { kind: "unavailable", reason: "insufficient-data" },
      recentRides: { kind: "computed", items: [recentRide] },
      anchorZones: { kind: "computed" },
      cyclingLoad: { kind: "computed", value: 80 },
      plan: { kind: "computed" },
      adherence: { kind: "computed", ratio: 1 },
      wellnessTrend: { kind: "computed" },
    });
  });

  it("isolates a Power Progress read failure from the rest of athlete state", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest());
    const state = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      powerProgressSource: {
        readPowerProgress: async () => Promise.reject(new Error("private archive path")),
      },
    }).getAthleteState();
    expect(state.trainingContext?.performanceProgress).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
    expect(JSON.stringify(state)).not.toContain("private archive path");
    const malformed = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      powerProgressSource: {
        readPowerProgress: async () => ({ kind: "computed" }) as never,
      },
    }).getAthleteState();
    expect(malformed.trainingContext?.performanceProgress).toEqual({
      kind: "unavailable",
      reason: "invalid-data",
    });
  });

  it("isolates invalid or failed recent-ride reads without leaking private errors", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest());
    const failed = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      recentRidesSource: {
        readRecentRides: async () => Promise.reject(new Error("private provider activity id")),
      },
    }).getAthleteState();
    expect(failed.trainingContext?.recentRides).toEqual({
      kind: "unknown",
      reason: "temporary-failure",
    });
    expect(JSON.stringify(failed)).not.toContain("private provider activity id");

    const malformed = await createPersistedAthleteStateSource({
      dataDir: root,
      cyclingFtpAnchorResolver: resolver,
      recentRidesSource: {
        readRecentRides: async () => ({ kind: "computed" }) as never,
      },
    }).getAthleteState();
    expect(malformed.trainingContext?.recentRides).toEqual({
      kind: "unknown",
      reason: "temporary-failure",
    });
  });

  it("degrades only anchor zones when persisted time or resolver is invalid", async () => {
    for (const lastUpdated of ["invalid", "2026-07-18T00:00:00.000Z"]) {
      const root = await home();
      const snapshot = latest();
      snapshot.metadata.last_updated = lastUpdated;
      await writeJson(root, "latest.json", snapshot);
      const state = await createPersistedAthleteStateSource({
        dataDir: root,
        cyclingFtpAnchorResolver: { resolve: async () => Promise.reject(new Error("synthetic")) },
      }).getAthleteState();
      expect(state.trainingContext?.anchorZones).toEqual({
        kind: "unknown",
        reason: "not-synced",
      });
      expect(state.trainingContext?.plan).toEqual({ kind: "unknown", reason: "no-plan" });
    }
  });
});
