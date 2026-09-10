import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { SqlReadStore } from "@enduragent/kernel/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoreRuntime,
  STORE_REFRESH_INTERVAL_MS,
  type StoreRuntime,
} from "../src/store-runtime.js";

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

async function skipCurveRefresh(
  options: Parameters<typeof import("../src/analytics-curves.js").runAnalyticsCurveRefresh>[0],
) {
  return {
    kind: "skipped" as const,
    generationId: "a".repeat(64),
    frozenAt: options.frozenAt.toISOString(),
    physicalRequests: 0,
    decodedBytes: 0,
    failure: "request-budget-exhausted" as const,
  };
}

function emptyReadonlyStore(): SqlReadStore {
  return {
    get: vi.fn(async () => undefined),
    all: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

async function makeRuntime(
  runtimeConfig: Config = config,
  readConfig?: () => Config,
  readonlyStore: SqlReadStore = emptyReadonlyStore(),
  platform?: NodeJS.Platform,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-"));
  roots.push(root);
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
  const capture = vi.fn(
    async (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
      options.attemptLedger!.charge("store", "store:settings");
      return manifest;
    },
  );
  const refreshCurves = vi.fn(
    async (
      options: Parameters<typeof import("../src/analytics-curves.js").runAnalyticsCurveRefresh>[0],
    ) => {
      const reservation = options.attemptLedger.tryReserve("store", "store:analytics-curves", 4);
      if (reservation === null) throw new Error("synthetic curve reservation failed");
      for (let index = 0; index < 4; index += 1) reservation.charge();
      reservation.release();
      return {
        kind: "promoted" as const,
        generationId: "a".repeat(64),
        frozenAt: options.frozenAt.toISOString(),
        physicalRequests: 4 as const,
        decodedBytes: 0,
      };
    },
  );
  const produce = vi.fn(async () => produced);
  runtime = createStoreRuntime({
    env: {},
    config: runtimeConfig,
    readConfig,
    home: {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    },
    reference,
    ...(platform === undefined ? {} : { platform }),
    dependencies: {
      capture,
      refreshCurves,
      produce,
      now: () => new Date("1998-07-18T12:00:00.000Z"),
      monotonicNow: () => 1,
      openReadonlyStore: () => readonlyStore,
    },
  });
  return { root, runtime, capture, refreshCurves, produce, reference, readonlyStore };
}

describe("StoreRuntime", () => {
  it("threads the resolved calendar timezone into Reference capture", async () => {
    const { runtime, capture } = await makeRuntime({
      ...config,
      session: { ...config.session, timezone: "Asia/Almaty" },
    });

    await runtime.runWindow();

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarTimeZone: "Asia/Almaty",
        reviewedOn: "1998-07-18",
      }),
    );
    await runtime.close();
  });

  it("threads injected win32 semantics into Reference capture", async () => {
    const { runtime, capture } = await makeRuntime(
      config,
      undefined,
      emptyReadonlyStore(),
      "win32",
    );

    await runtime.runWindow();

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ platform: "win32" }));
    await runtime.close();
  });

  it("runs base capture, curve acquisition, and legacy refresh in one ledger window", async () => {
    const { runtime, capture, refreshCurves, produce, reference } = await makeRuntime();
    const result = await runtime.runWindow();
    expect(result.counts).toMatchObject({
      storeRequests: 5,
      legacyRequests: 1,
      totalRequests: 6,
      byTag: { "store:settings": 1, "store:analytics-curves": 4 },
    });
    expect(refreshCurves).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "synthetic",
        athleteId: "synthetic-athlete",
        frozenAt: new Date("1998-07-18T12:00:00.000Z"),
        frozenOn: "1998-07-18",
      }),
    );
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
      refreshCurves.mock.invocationCallOrder[0]!,
    );
    expect(refreshCurves.mock.invocationCallOrder[0]).toBeLessThan(
      produce.mock.invocationCallOrder[0]!,
    );
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(1);
    expect(runtime.currentSnapshot()).toBe(produced);
    await runtime.close();
  });

  it("surfaces the current Reference restriction summary without persisting it", async () => {
    const { runtime, reference } = await makeRuntime();
    const droppedActivities = {
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
    };
    vi.mocked(reference.runScheduledOnce).mockImplementationOnce(async () => {
      runtime.attemptLedgerForRun().charge("legacy", "legacy:reference");
      return {
        kind: "ran",
        lastSyncAt: "1998-07-18T12:00:00.000Z",
        refreshed: [],
        droppedActivities,
      };
    });

    const result = await runtime.runWindow();

    expect(result.droppedActivities).toEqual(droppedActivities);
    expect(runtime.currentDroppedActivities()).toEqual(droppedActivities);
    vi.mocked(reference.runScheduledOnce).mockImplementationOnce(async () => {
      runtime.attemptLedgerForRun().charge("legacy", "legacy:reference");
      return { kind: "failed", reason: "fetch_failed", failures: [] };
    });

    const failedRefresh = await runtime.runWindow();

    expect(failedRefresh).toMatchObject({ legacySucceeded: false, droppedActivities });
    expect(runtime.currentDroppedActivities()).toEqual(droppedActivities);
    await runtime.close();
  });

  it("waits for both base lanes before reserving optional curve capacity", async () => {
    const { runtime, refreshCurves, reference } = await makeRuntime();
    let releaseLegacy!: () => void;
    let markLegacyStarted!: () => void;
    const legacyStarted = new Promise<void>((resolve) => {
      markLegacyStarted = resolve;
    });
    vi.mocked(reference.runScheduledOnce).mockImplementationOnce(async () => {
      runtime.attemptLedgerForRun().charge("legacy", "legacy:reference");
      markLegacyStarted();
      await new Promise<void>((resolve) => {
        releaseLegacy = resolve;
      });
      return {
        kind: "ran",
        lastSyncAt: "1998-07-18T12:00:00.000Z",
        refreshed: [],
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      };
    });

    const window = runtime.runWindow();
    await legacyStarted;
    await Promise.resolve();
    expect(refreshCurves).not.toHaveBeenCalled();
    releaseLegacy();
    await expect(window).resolves.toMatchObject({ published: true, legacySucceeded: true });
    expect(refreshCurves).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("skips both provider lanes when the intervals.icu API key is empty", async () => {
    const { runtime, capture, refreshCurves, produce, reference } = await makeRuntime({
      ...config,
      intervals: { ...config.intervals, apiKey: "" },
    });
    const result = await runtime.runWindow();
    expect(result).toMatchObject({
      published: false,
      counts: { storeRequests: 0, legacyRequests: 0, totalRequests: 0 },
      legacySucceeded: true,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(refreshCurves).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
    expect(reference.runScheduledOnce).not.toHaveBeenCalled();
    expect(runtime.currentSnapshot()).toBeUndefined();
    await runtime.close();
  });

  it("reads an applied intervals overlay at the next store window", async () => {
    let activeConfig: Config = {
      ...config,
      intervals: { apiKey: "", athleteId: "unconfigured" },
    };
    const { runtime, capture } = await makeRuntime(activeConfig, () => activeConfig);
    await runtime.runWindow();
    expect(capture).not.toHaveBeenCalled();
    activeConfig = {
      ...activeConfig,
      intervals: { apiKey: "placeholder", athleteId: "new-athlete" },
    };
    await runtime.runWindow();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "placeholder", athleteId: "new-athlete" }),
    );
    await runtime.close();
  });

  it("retains the prior complete snapshot after a later capture failure", async () => {
    const { runtime, capture, refreshCurves } = await makeRuntime();
    await runtime.runWindow();
    refreshCurves.mockClear();
    capture.mockRejectedValueOnce(new Error("capture failed"));
    await expect(runtime.runWindow()).rejects.toThrow("capture failed");
    expect(refreshCurves).not.toHaveBeenCalled();
    expect(runtime.currentSnapshot()).toBe(produced);
    await runtime.close();
  });

  it("isolates an unexpected curve refresh failure and publishes the base snapshot", async () => {
    const { root, runtime, refreshCurves, produce } = await makeRuntime();
    refreshCurves.mockRejectedValueOnce(
      Object.assign(new Error("curve adapter failed"), {
        apiKey: "SECRET-CURVE-KEY",
        authorization: "Basic SECRET",
      }),
    );

    await expect(runtime.runWindow()).resolves.toMatchObject({
      published: true,
      legacySucceeded: true,
      counts: { storeRequests: 1, legacyRequests: 1, totalRequests: 2 },
    });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(runtime.currentSnapshot()).toBe(produced);

    const raw = await readFile(join(root, "logs", "log.jsonl"), "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({
      level: "warn",
      component: "sync",
      event: "analytics_curve_refresh_failed",
      err: { name: "Error", authorization: "[redacted]" },
    });
    expect(raw).not.toContain("curve adapter failed");
    expect(JSON.parse(raw.trim()).err).not.toHaveProperty("message");
    expect(JSON.parse(raw.trim()).err).not.toHaveProperty("stack");
    expect(raw).not.toContain("SECRET-CURVE-KEY");
    expect(raw).not.toContain("Basic SECRET");
    await runtime.close();
  });

  it("logs a redacted scheduled refresh failure, retains the snapshot, and reschedules", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-scheduled-error-"));
    roots.push(root);
    const scheduled: Array<() => void> = [];
    let markRescheduled!: () => void;
    const rescheduled = new Promise<void>((resolve) => {
      markRescheduled = resolve;
    });
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    const reference = {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: vi.fn(async () => ({
        kind: "ran",
        lastSyncAt: "",
        refreshed: [],
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      })),
    } as unknown as ReferenceRuntime;
    const capture = vi
      .fn<() => Promise<ReferenceCaptureManifest>>()
      .mockResolvedValueOnce(manifest)
      .mockRejectedValueOnce(
        Object.assign(new Error("capture failed"), {
          payload: { apiKey: "SECRET-API-KEY" },
          authorization: "Bearer SECRET",
        }),
      );
    const runtime = createStoreRuntime({
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
        capture,
        refreshCurves: skipCurveRefresh,
        produce: vi.fn(async () => produced),
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        monotonicNow: () => 1,
        openReadonlyStore: () => emptyReadonlyStore(),
        schedulerDependencies: {
          nowEpochMs: () => new Date("1998-07-18T12:00:00.000Z").getTime(),
          setTimeout: vi.fn((callback: () => void) => {
            scheduled.push(callback);
            if (scheduled.length === 2) markRescheduled();
            return handle;
          }) as unknown as typeof setTimeout,
          clearTimeout: vi.fn() as unknown as typeof clearTimeout,
        },
      },
    });
    await runtime.runWindow();
    runtime.startScheduler();
    scheduled[0]!();
    await rescheduled;

    const raw = await readFile(join(root, "logs", "log.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      component: "sync",
      event: "scheduled_store_refresh_failed",
      err: {
        name: "Error",
        authorization: "[redacted]",
      },
    });
    expect(raw).not.toContain("capture failed");
    expect(JSON.parse(lines[0]!).err).not.toHaveProperty("message");
    expect(JSON.parse(lines[0]!).err).not.toHaveProperty("stack");
    expect(raw).not.toContain("SECRET-API-KEY");
    expect(raw).not.toContain("Bearer SECRET");
    expect(runtime.currentSnapshot()).toBe(produced);
    expect(scheduled).toHaveLength(2);
    await runtime.close();
  });

  it("owns one unref'd six-hour timer, skips overlap, and closes once", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-timer-"));
    roots.push(root);
    const unref = vi.fn(),
      clear = vi.fn();
    let delay = 0;
    const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
    let release!: () => void;
    const reference = {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: vi.fn(async () => ({
        kind: "ran",
        lastSyncAt: "",
        refreshed: [],
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      })),
    } as unknown as ReferenceRuntime;
    const runtime = createStoreRuntime({
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
        capture: vi.fn(
          () =>
            new Promise<ReferenceCaptureManifest>((resolve) => {
              release = () => resolve(manifest);
            }),
        ),
        refreshCurves: skipCurveRefresh,
        produce: vi.fn(async () => produced),
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        monotonicNow: () => 1,
        openReadonlyStore: () => emptyReadonlyStore(),
        schedulerDependencies: {
          nowEpochMs: () => new Date("1998-07-18T12:00:00.000Z").getTime(),
          setTimeout: ((_: () => void, ms: number) => {
            delay = ms;
            return handle;
          }) as typeof setTimeout,
          clearTimeout: clear as unknown as typeof clearTimeout,
        },
      },
    });
    runtime.startScheduler();
    runtime.startScheduler();
    expect(delay).toBe(STORE_REFRESH_INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
    const first = runtime.runWindow(),
      second = runtime.runWindow();
    expect(first).toBe(second);
    release();
    await first;
    await runtime.close();
    await runtime.close();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("settles an active window before exclusive work and coalesces refreshes behind it", async () => {
    const { runtime, capture, reference } = await makeRuntime();
    let releaseWindow!: () => void;
    let captureCalls = 0;
    capture.mockImplementation(async () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseWindow = resolve;
        });
      }
      return manifest;
    });
    const active = runtime.runWindow();
    while (releaseWindow === undefined) await Promise.resolve();
    let releaseWork!: () => void;
    let markWorkStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      markWorkStarted = resolve;
    });
    const trace: string[] = [];
    const after = runtime.runWindowAfter(async () => {
      trace.push("work");
      markWorkStarted();
      await new Promise<void>((resolve) => {
        releaseWork = resolve;
      });
    });
    await Promise.resolve();
    expect(trace).toEqual([]);
    releaseWindow();
    await active;
    await workStarted;
    const manual = runtime.runWindow();
    expect(manual).toBe(after);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(1);
    releaseWork();
    await expect(after).resolves.toMatchObject({ published: true });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("admits writes and refresh windows through one FIFO in both orders", async () => {
    const { runtime, capture } = await makeRuntime();
    let releaseWrite!: () => void;
    const trace: string[] = [];
    const write = runtime.runActivityWrite(
      async () => {
        trace.push("write:start");
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        trace.push("write:end");
        return "written";
      },
      () => [],
    );
    const windowAfterWrite = runtime.runWindow();
    expect(capture).not.toHaveBeenCalled();
    releaseWrite();
    await expect(write).resolves.toEqual({
      value: "written",
      activityReadAvailable: false,
    });
    await windowAfterWrite;
    expect(capture).toHaveBeenCalledTimes(1);

    let releaseWindow!: () => void;
    capture.mockImplementationOnce(async () => {
      trace.push("window:start");
      await new Promise<void>((resolve) => {
        releaseWindow = resolve;
      });
      trace.push("window:end");
      return manifest;
    });
    const window = runtime.runWindow();
    const writeAfterWindow = runtime.runActivityWrite(
      async () => {
        trace.push("write:after-window");
        return "second";
      },
      () => [],
    );
    await Promise.resolve();
    expect(trace).not.toContain("write:after-window");
    releaseWindow();
    await window;
    await expect(writeAfterWindow).resolves.toMatchObject({
      value: "second",
      activityReadAvailable: false,
    });
    expect(trace).toEqual([
      "write:start",
      "write:end",
      "window:start",
      "window:end",
      "write:after-window",
    ]);
    await runtime.close();
  });

  it("does not let failed work poison a later exclusive admission", async () => {
    const { runtime, capture } = await makeRuntime();
    await expect(
      runtime.runWindowAfter(async () => {
        throw new Error("synthetic work failure");
      }),
    ).rejects.toThrow("synthetic work failure");
    expect(capture).not.toHaveBeenCalled();
    await expect(runtime.runWindowAfter(async () => {})).resolves.toMatchObject({
      published: true,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(runtime.runWindowAfter(null as never)).rejects.toThrow(
      "Window work must be a function.",
    );
    await runtime.close();
  });

  it("aborts and drains pre-window work on close without starting the internal refresh", async () => {
    const { runtime, capture, reference } = await makeRuntime();
    let signal!: AbortSignal;
    let settlements = 0;
    const window = runtime.runWindowAfter(
      (selectedSignal) =>
        new Promise<void>((_, reject) => {
          signal = selectedSignal;
          selectedSignal.addEventListener(
            "abort",
            () => {
              settlements += 1;
              reject(selectedSignal.reason);
            },
            { once: true },
          );
        }),
    );
    while (signal === undefined) await Promise.resolve();
    const rejectedWindow = expect(window).rejects.toThrow("Store runtime closed.");
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(signal.aborted).toBe(true);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(secondClose).resolves.toBeUndefined();
    await rejectedWindow;
    expect(settlements).toBe(1);
    expect(capture).not.toHaveBeenCalled();
    expect(reference.runScheduledOnce).not.toHaveBeenCalled();
    await expect(runtime.runWindowAfter(async () => {})).rejects.toThrow(
      "Store runtime is closed.",
    );
  });

  it("aborts a completed activity write before publication attestation on close", async () => {
    const readonlyStore = emptyReadonlyStore();
    const { runtime } = await makeRuntime(config, undefined, readonlyStore);
    let signal!: AbortSignal;
    const write = runtime.runActivityWrite(
      async (selectedSignal) => {
        signal = selectedSignal;
        await new Promise<void>((resolve) => {
          selectedSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "written";
      },
      () => ["a".repeat(64)],
    );
    while (signal === undefined) await Promise.resolve();
    const rejectedWrite = expect(write).rejects.toThrow("Store runtime closed.");
    const close = runtime.close();
    expect(signal.aborted).toBe(true);
    await rejectedWrite;
    await expect(close).resolves.toBeUndefined();
    expect(readonlyStore.all).not.toHaveBeenCalled();
  });

  it("cancels an active window when closed and rejects later windows", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-close-"));
    roots.push(root);
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    let signal!: AbortSignal;
    let referenceSignal!: AbortSignal;
    const reference = {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: vi.fn(
        (selectedSignal: AbortSignal) =>
          new Promise<never>((_, reject) => {
            referenceSignal = selectedSignal;
            selectedSignal.addEventListener("abort", () => reject(selectedSignal.reason), {
              once: true,
            });
          }),
      ),
    } as unknown as ReferenceRuntime;
    const runtime = createStoreRuntime({
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
        capture: vi.fn(
          (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
            signal = options.budget!.signal;
            return new Promise<ReferenceCaptureManifest>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        ),
        refreshCurves: skipCurveRefresh,
        produce: vi.fn(async () => produced),
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        monotonicNow: () => 1,
        openReadonlyStore: () => emptyReadonlyStore(),
        schedulerDependencies: {
          nowEpochMs: () => new Date("1998-07-18T12:00:00.000Z").getTime(),
          setTimeout: vi.fn(() => handle) as unknown as typeof setTimeout,
          clearTimeout: vi.fn() as unknown as typeof clearTimeout,
        },
      },
    });
    const window = runtime.runWindow();
    const rejectedWindow = expect(window).rejects.toThrow("Store runtime closed.");
    const close = runtime.close();
    expect(signal.aborted).toBe(true);
    expect(referenceSignal.aborted).toBe(true);
    await expect(close).resolves.toBeUndefined();
    await rejectedWindow;
    expect(runtime.currentSnapshot()).toBeUndefined();
    await expect(runtime.runWindow()).rejects.toThrow("Store runtime is closed.");
  });

  it("shares close, aborts active work, rejects queued work, and closes the reader once", async () => {
    const readonlyStore = emptyReadonlyStore();
    const { runtime } = await makeRuntime(config, undefined, readonlyStore);
    const active = runtime.runExclusive(
      (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const queued = runtime.runExclusive(async () => "queued");
    const activeRejection = expect(active).rejects.toThrow("Store runtime closed.");
    const queuedRejection = expect(queued).rejects.toThrow("Store runtime is closed.");
    const first = runtime.close();
    const second = runtime.close();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await activeRejection;
    await queuedRejection;
    expect(readonlyStore.close).toHaveBeenCalledTimes(1);
  });
});
