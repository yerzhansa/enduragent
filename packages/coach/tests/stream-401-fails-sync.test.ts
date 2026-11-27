import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { encodeIntervalsOAuthCredential } from "../../core/src/intervals-credential.js";
import { runIntervalsBackfillInWriter } from "../src/backfill.js";
import { runReferenceCapture } from "../src/capture.js";
import { createCoachOperations } from "../src/operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createStoreRuntime } from "../src/store-runtime.js";

const ATHLETE_ID = "synthetic-athlete";
const NOW = Date.parse("1998-07-18T12:00:00.000Z");
const CAPTURE_ID = "12345678-1234-4123-8123-123456789abc";
const CAPTURE_OLDEST = "1998-04-25";
const NO_DROPS = { total: 0, visible: 0, restrictions: [], other: 0 };
const DIRECT_REQUEST = "the sync called intervals.icu without the store runtime's fetch";

const profile = {
  sportSettings: [
    {
      id: 7,
      athlete_id: ATHLETE_ID,
      types: ["Ride"],
      updated: "1998-07-01T00:00:00.000Z",
      ftp: 250,
      lthr: 165,
      power_zones: [0, 125, 200, 250],
    },
  ],
};
const ride = {
  id: 42,
  type: "Ride",
  start_date: "1998-07-17T10:00:00.000Z",
  start_date_local: "1998-07-17T12:00:00",
  moving_time: 3600,
  elapsed_time: 3700,
  distance: 40_000,
};
const wellness = [{ id: "1998-07-17", weight: 70, restingHR: 50, hrv: 60 }];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function runtimeSnapshot(): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: ATHLETE_ID,
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
}

describe("a 401 while the sync downloads ride streams", () => {
  const roots: string[] = [];
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(DIRECT_REQUEST);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function syncWithStreams401(credential: string) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "stream-401-"));
    roots.push(root);
    const home: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    mkdirSync(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    await runMigrations(store, MIGRATIONS);
    const context: CoachStoreWriterContext = {
      home,
      store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
    const config: Config = {
      dataSource: "store",
      llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
      intervals: { apiKey: credential, athleteId: ATHLETE_ID },
      telegram: { botToken: "" },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 1000,
      dataDir: "unused",
    };
    const streamStatuses: number[] = [];
    const intervals: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/streams.json")) {
        streamStatuses.push(401);
        return new Response(JSON.stringify({ status: 401, error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === `/api/v1/athlete/${ATHLETE_ID}`) return json(profile);
      if (url.pathname.endsWith("/activities")) {
        return json(url.searchParams.get("oldest") === CAPTURE_OLDEST ? [ride] : []);
      }
      if (url.pathname.endsWith("/wellness")) return json(wellness);
      return new Response("", { status: 404 });
    };
    let monotonic = 0;
    const runtime = createStoreRuntime({
      env: {},
      config,
      home,
      writerContext: context,
      reference: {
        scheduler: { stop: vi.fn() },
        services: {},
        runScheduledOnce: async () => ({
          kind: "ran",
          lastSyncAt: "1998-07-18T12:00:00.000Z",
          refreshed: [],
          droppedActivities: { overall: NO_DROPS, recent7Days: NO_DROPS },
        }),
      } as unknown as ReferenceRuntime,
      dependencies: {
        capture: (options) =>
          runReferenceCapture(options, {
            wallClock: () => new Date(NOW),
            uuid: () => CAPTURE_ID,
            monotonicNow: () => (monotonic += 250),
            sleep: async () => {},
          }),
        fetch: intervals,
        now: () => new Date(NOW),
        monotonicNow: () => (monotonic += 250),
      },
    });
    const operations = createCoachOperations(
      {
        home,
        context,
        runtime,
        intervalsCredentials: { read: async () => ({ apiKey: credential, athleteId: ATHLETE_ID }) },
        historyNewestDate: () => "1998-07-18",
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig: async () => {},
        readRuntimeConfig: runtimeSnapshot,
      },
      {
        backfill: (options) =>
          runIntervalsBackfillInWriter({
            ...options,
            clock: { now: () => NOW, monotonicNow: () => (monotonic += 250) },
            sleep: async () => {},
          }),
      },
    );
    try {
      const result = await operations.sync({}).then(
        (value) => ({ resolved: true as const, value }),
        (error: unknown) => ({
          resolved: false as const,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      const afterSync = await operations.getRuntimeConfig({});
      const signInRejected = afterSync.intervals.credential_rejected === true;
      const athleteSeesGreen =
        result.resolved &&
        result.value.backfill !== "pending-verification" &&
        result.value.referenceSucceeded &&
        !signInRejected;
      const summary = result.resolved
        ? {
            backfill: result.value.backfill,
            published: result.value.published,
            referenceSucceeded: result.value.referenceSucceeded,
          }
        : { rejected: result.error };
      return { summary, streamStatuses, signInRejected, athleteSeesGreen };
    } finally {
      await runtime.close();
      await store.close();
    }
  }

  it("does not end green for an API-key sign-in whose stream downloads got 401", async () => {
    const outcome = await syncWithStreams401("synthetic-api-key-stream-401");
    expect(outcome.streamStatuses.length, "stream downloads the sync attempted").toBeGreaterThan(0);
    expect(
      { athleteSeesGreen: outcome.athleteSeesGreen },
      `what the window shows after the sync answered ${JSON.stringify(outcome.summary)}`,
    ).toEqual({ athleteSeesGreen: false });
  });

  it("asks an OAuth sign-in to sign in again after its stream downloads got 401", async () => {
    const outcome = await syncWithStreams401(
      encodeIntervalsOAuthCredential("synthetic-oauth-token-stream-401"),
    );
    expect(outcome.streamStatuses.length, "stream downloads the sync attempted").toBeGreaterThan(0);
    expect(
      { athleteSeesGreen: outcome.athleteSeesGreen, signInRejected: outcome.signInRejected },
      `what the window shows after the sync answered ${JSON.stringify(outcome.summary)}`,
    ).toEqual({ athleteSeesGreen: false, signInRejected: true });
  });
});
