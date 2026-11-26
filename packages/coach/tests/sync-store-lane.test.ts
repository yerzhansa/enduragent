import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runIntervalsBackfillInWriter } from "../src/backfill.js";
import { createCoachOperations } from "../src/operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createStoreRuntime } from "../src/store-runtime.js";

const ATHLETE_ID = "synthetic-athlete";
const API_KEY = String.fromCharCode(116, 101, 115, 116);
const NOW = Date.UTC(1900, 0, 1);

const config: Config = {
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: API_KEY, athleteId: ATHLETE_ID },
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
const manifest = {
  capture_id: "12345678-1234-4123-8123-123456789abc",
  plan: {
    capture_epoch_ms: NOW,
    frozenNow: "1900-01-01T00:00:00.000Z",
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
  bundle: { activities: [], wellness: [], ftpHistory: [], athlete: { sportSettings: [] } },
};

interface HeldRequest {
  readonly endpoint: "profile" | "activities";
  answer(): void;
}

function heldProvider(): {
  readonly baseFetch: typeof globalThis.fetch;
  nextRequest(): Promise<HeldRequest>;
} {
  const held: HeldRequest[] = [];
  let arrived: (() => void) | undefined;
  const profilePath = `/api/v1/athlete/${ATHLETE_ID}`;
  return {
    baseFetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const endpoint = url.pathname === profilePath ? "profile" : "activities";
      await new Promise<void>((answer, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        held.push({ endpoint, answer });
        arrived?.();
      });
      const body =
        endpoint === "profile"
          ? {
              sportSettings: [
                { id: 1, athlete_id: ATHLETE_ID, types: ["Ride"], updated: "1900-01-01" },
              ],
            }
          : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async nextRequest() {
      while (held.length === 0) {
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
      return held.shift()!;
    },
  };
}

function answersWhileSyncWaits<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    call,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the call waited for the sync")), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("store work during a sync that waits on intervals.icu", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function syncingCoach() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "sync-store-lane-"));
    roots.push(root);
    const home: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    const context: CoachStoreWriterContext = {
      home,
      store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
    const provider = heldProvider();
    const runtime = createStoreRuntime({
      env: {},
      config,
      home,
      reference: {
        scheduler: { stop: vi.fn() },
        services: {},
        runScheduledOnce: async () => ({
          kind: "ran",
          lastSyncAt: "1900-01-01T00:00:00.000Z",
          refreshed: [],
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        }),
      } as unknown as ReferenceRuntime,
      dependencies: {
        capture: async () => ({ manifest }),
        refreshCurves: async (options) => ({
          kind: "skipped" as const,
          generationId: "a".repeat(64),
          frozenAt: options.frozenAt.toISOString(),
          physicalRequests: 0,
          decodedBytes: 0,
          failure: "request-budget-exhausted" as const,
        }),
        produce: async () => produced,
        fetch: provider.baseFetch,
        now: () => new Date(NOW),
        monotonicNow: () => 1,
        openReadonlyStore: () => ({
          get: async () => undefined,
          all: async () => [],
          close: async () => {},
        }),
      },
    });
    const applyRuntimeConfig = vi.fn(async () => {});
    const operations = createCoachOperations(
      {
        home,
        context,
        runtime,
        intervalsCredentials: { read: async () => ({ apiKey: API_KEY, athleteId: ATHLETE_ID }) },
        historyNewestDate: () => new Date(NOW).toISOString().slice(0, 10),
        calendarTimeZone: () => "UTC",
        applyRuntimeConfig,
      },
      {
        backfill: (options) =>
          runIntervalsBackfillInWriter({
            ...options,
            clock: { now: () => NOW, monotonicNow: () => 1_000 },
            sleep: async () => {},
          }),
      },
    );
    return {
      operations,
      runtime,
      provider,
      applyRuntimeConfig,
      async close() {
        await runtime.close();
        await store.close();
      },
    };
  }

  it("answers preference, setup-status and other store calls while each sync request is unanswered", async () => {
    const coach = await syncingCoach();
    try {
      const sync = coach.operations.sync({});
      const finished = sync.then(() => "finished" as const);
      const endpoints: string[] = [];
      for (;;) {
        const request = await Promise.race([coach.provider.nextRequest(), finished]);
        if (request === "finished") break;
        endpoints.push(request.endpoint);
        await expect(
          answersWhileSyncWaits(coach.operations.getLanguagePreference!({})),
        ).resolves.toEqual({ value: null });
        await expect(
          answersWhileSyncWaits(coach.operations.setUnitsPreference!({ value: "imperial" })),
        ).resolves.toEqual({ value: "imperial", source: "cycling" });
        await expect(answersWhileSyncWaits(coach.operations.getSetupStatus!({}))).resolves.toEqual({
          schemaVersion: 1,
          durableTrainingData: false,
        });
        await expect(
          answersWhileSyncWaits(coach.runtime.runExclusive(async () => "draft saved")),
        ).resolves.toBe("draft saved");
        request.answer();
      }
      expect(endpoints).toEqual(["profile", "activities"]);
      await expect(sync).resolves.toMatchObject({ schemaVersion: 1, backfill: "completed" });
    } finally {
      await coach.close();
    }
  });

  it("holds an intervals.icu sign-in change until the sync has finished", async () => {
    const coach = await syncingCoach();
    try {
      const sync = coach.operations.sync({});
      const profile = await coach.provider.nextRequest();
      const signIn = coach.operations.configureRuntime({
        intervals: { api_key: "placeholder-intervals", athlete_id: ATHLETE_ID },
      });
      await coach.runtime.runExclusive(async () => {});
      expect(coach.applyRuntimeConfig).not.toHaveBeenCalled();
      profile.answer();
      (await coach.provider.nextRequest()).answer();
      await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(signIn).resolves.toMatchObject({ status: "applied" });
      expect(coach.applyRuntimeConfig).toHaveBeenCalledTimes(1);
    } finally {
      await coach.close();
    }
  });
});
