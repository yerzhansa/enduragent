import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentRpcMethod, withRpcMethod } from "../src/rpc-diagnostics.js";
import { createStoreRuntime, type StoreRuntime } from "../src/store-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config: Config = {
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: "synthetic", athleteId: "synthetic-athlete" },
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
    capture_epoch_ms: Date.parse("1998-07-18T12:00:00.000Z"),
    frozenNow: "1998-07-18T12:00:00.000Z",
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

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function laneRuntime() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "store-lane-wait-"));
  roots.push(root);
  const clock = { ms: 0 };
  let runtime!: StoreRuntime;
  const reference = {
    scheduler: { stop: vi.fn() },
    services: {},
    runScheduledOnce: vi.fn(async () => {
      runtime.attemptLedgerForRun().charge("legacy", "legacy:reference");
      return {
        kind: "ran",
        lastSyncAt: "1998-07-18T12:00:00.000Z",
        refreshed: [],
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      } as const;
    }),
  } as unknown as ReferenceRuntime;
  const intervalsAnswer = gate();
  runtime = createStoreRuntime({
    env: {},
    config,
    home: {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    },
    reference,
    dependencies: {
      capture: async (options) => {
        options.attemptLedger!.charge("store", "store:settings");
        return { manifest };
      },
      refreshCurves: async (options) => ({
        kind: "skipped",
        generationId: "a".repeat(64),
        frozenAt: options.frozenAt.toISOString(),
        physicalRequests: 0,
        decodedBytes: 0,
        failure: "request-budget-exhausted",
      }),
      produce: async () => produced,
      fetch: async () => {
        await intervalsAnswer.opened;
        return new Response("{}");
      },
      now: () => new Date("1998-07-18T12:00:00.000Z"),
      monotonicNow: () => clock.ms,
      openReadonlyStore: () => ({
        get: async () => undefined,
        all: async () => [],
        close: async () => undefined,
      }),
    },
  });
  const laneWaits = async (): Promise<Record<string, unknown>[]> => {
    const raw = await readFile(join(root, "logs", "log.jsonl"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "store_lane_wait");
  };
  return { runtime, clock, intervalsAnswer, laneWaits };
}

describe("StoreRuntime store lane wait signal", () => {
  it("logs the RPC method and its wait when a call waits more than 5 s for the store lane", async () => {
    const { runtime, clock, laneWaits } = await laneRuntime();
    const holder = gate();
    const held = runtime.runExclusive(() => holder.opened);
    const read = withRpcMethod("getLanguagePreference", () =>
      runtime.runExclusive(async () => "read"),
    );

    clock.ms = 5_100;
    holder.open();

    await expect(read).resolves.toBe("read");
    await held;
    expect(await laneWaits()).toEqual([
      expect.objectContaining({
        level: "warn",
        component: "sync",
        event: "store_lane_wait",
        method: "getLanguagePreference",
        waitMs: 5_100,
      }),
    ]);
    await runtime.close();
  });

  it("logs nothing for a wait of 5 s or less", async () => {
    const { runtime, clock, laneWaits } = await laneRuntime();
    const holder = gate();
    const held = runtime.runExclusive(() => holder.opened);
    const read = withRpcMethod("getUnitsPreference", () =>
      runtime.runExclusive(async () => "read"),
    );

    clock.ms = 5_000;
    holder.open();

    await expect(read).resolves.toBe("read");
    await held;
    expect(await laneWaits()).toEqual([]);
    await runtime.close();
  });

  it("names no method for store work that no RPC call started", async () => {
    const { runtime, clock, laneWaits } = await laneRuntime();
    const holder = gate();
    const held = runtime.runExclusive(() => holder.opened);
    const scheduled = runtime.runExclusive(async () => "scheduled");

    clock.ms = 7_250;
    holder.open();

    await expect(scheduled).resolves.toBe("scheduled");
    await held;
    expect(await laneWaits()).toEqual([
      expect.objectContaining({ event: "store_lane_wait", method: null, waitMs: 7_250 }),
    ]);
    await runtime.close();
  });

  it("names no method for store work that a call started but that runs after the call finished", async () => {
    const { runtime, clock, laneWaits } = await laneRuntime();
    const holder = gate();
    const held = runtime.runExclusive(() => holder.opened);
    let later: Promise<string> | undefined;
    await withRpcMethod("configureRuntime", async () => {
      later = new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
        runtime.runExclusive(async () => "later"),
      );
    });
    await settle();

    clock.ms = 6_000;
    holder.open();

    await expect(later).resolves.toBe("later");
    await held;
    expect(await laneWaits()).toEqual([
      expect.objectContaining({ event: "store_lane_wait", method: null, waitMs: 6_000 }),
    ]);
    await runtime.close();
  });

  it("runs queued store work under its own call, not the call that released the lane", async () => {
    const { runtime } = await laneRuntime();
    const holder = gate();
    const held = withRpcMethod("sync", () => runtime.runExclusive(() => holder.opened));
    const queued = withRpcMethod("configureRuntime", () =>
      runtime.runExclusive(async () => currentRpcMethod()),
    );

    holder.open();

    await expect(queued).resolves.toBe("configureRuntime");
    await held;
    await runtime.close();
  });

  it("logs the sync's wait to take the store lane back after an intervals.icu request", async () => {
    const { runtime, clock, intervalsAnswer, laneWaits } = await laneRuntime();
    const draftSave = gate();
    let draftSaveStarted = false;
    const sync = withRpcMethod("sync", () =>
      runtime.runWindowAfter(async (_signal, fetchOffStoreLane) => {
        await fetchOffStoreLane("https://intervals.icu/synthetic-backfill");
      }),
    );
    await settle();
    const save = withRpcMethod("saveChatAttachmentDraftText", () =>
      runtime.runExclusive(async () => {
        draftSaveStarted = true;
        await draftSave.opened;
      }),
    );
    await settle();
    expect(draftSaveStarted).toBe(true);

    clock.ms = 1_000;
    intervalsAnswer.open();
    await settle();
    clock.ms = 7_500;
    draftSave.open();

    await save;
    await expect(sync).resolves.toMatchObject({ published: true });
    expect(await laneWaits()).toEqual([
      expect.objectContaining({ event: "store_lane_wait", method: "sync", waitMs: 6_500 }),
    ]);
    await runtime.close();
  });
});
