import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/reference/sync/scheduler.js";
import type { SyncResult } from "../src/reference/sync/run-sync.js";

const okResult = (lastSyncAt: string): SyncResult => ({
  kind: "ran",
  lastSyncAt,
  refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
  droppedActivities: {
    overall: { total: 0, visible: 0, restrictions: [], other: 0 },
    recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
  },
});

describe("Scheduler", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-scheduler-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT register a timer at construction (two-phase API per ADR-0011)", () => {
    const runSyncSpy = vi.fn();

    new Scheduler({ dataDir: dir, runSync: runSyncSpy, intervalMs: 30_000 });

    vi.advanceTimersByTime(60_000);
    expect(runSyncSpy).not.toHaveBeenCalled();
  });

  it("registers setTimeout(nextSyncAt - now) on start() when .scheduler.json says next sync is in the future", async () => {
    const fixedNow = new Date("2026-05-09T14:00:00Z");
    vi.setSystemTime(fixedNow);

    writeFileSync(
      join(dir, ".scheduler.json"),
      JSON.stringify({
        schema_version: "1",
        last_sync_at: new Date(fixedNow.getTime() - 25 * 60_000).toISOString(),
        next_sync_at: new Date(fixedNow.getTime() + 5 * 60_000).toISOString(),
      }),
    );

    const runSyncSpy = vi.fn().mockResolvedValue(okResult(fixedNow.toISOString()));
    const scheduler = new Scheduler({
      dataDir: dir,
      runSync: runSyncSpy,
      intervalMs: 30 * 60_000,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runSyncSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(runSyncSpy).toHaveBeenCalledOnce();
    expect(runSyncSpy).toHaveBeenCalledWith({ caller: "scheduled" });
  });

  it("schedules immediately on start() in the cold-start case (no .scheduler.json)", async () => {
    const runSyncSpy = vi.fn().mockResolvedValue(okResult("2026-05-09T14:00:00Z"));

    const scheduler = new Scheduler({
      dataDir: dir,
      runSync: runSyncSpy,
      intervalMs: 30 * 60_000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSyncSpy).toHaveBeenCalledOnce();
  });

  it("schedules immediately when .scheduler.json's next_sync_at is in the past (warm-start with stale next)", async () => {
    const fixedNow = new Date("2026-05-09T14:00:00Z");
    vi.setSystemTime(fixedNow);

    writeFileSync(
      join(dir, ".scheduler.json"),
      JSON.stringify({
        schema_version: "1",
        last_sync_at: new Date(fixedNow.getTime() - 60 * 60_000).toISOString(),
        next_sync_at: new Date(fixedNow.getTime() - 5 * 60_000).toISOString(),
      }),
    );

    const runSyncSpy = vi.fn().mockResolvedValue(okResult(fixedNow.toISOString()));
    const scheduler = new Scheduler({
      dataDir: dir,
      runSync: runSyncSpy,
      intervalMs: 30 * 60_000,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSyncSpy).toHaveBeenCalledOnce();
  });

  it("unref's the production timer handle when it exposes unref (defense-in-depth)", () => {
    const fixedNow = new Date("2026-05-09T14:00:00Z");
    const fakeHandle = { unref: vi.fn() };
    const runSyncSpy = vi.fn();

    const scheduler = new Scheduler({
      dataDir: dir,
      runSync: runSyncSpy,
      intervalMs: 30 * 60_000,
      clock: {
        now: () => fixedNow,
        setTimeout: () => fakeHandle,
        clearTimeout: () => {},
      },
    });
    scheduler.start();

    expect(fakeHandle.unref).toHaveBeenCalledOnce();
  });

  it("stop() cancels the pending timer; subsequent ticks do not fire", async () => {
    const fixedNow = new Date("2026-05-09T14:00:00Z");
    vi.setSystemTime(fixedNow);

    writeFileSync(
      join(dir, ".scheduler.json"),
      JSON.stringify({
        schema_version: "1",
        last_sync_at: null,
        next_sync_at: new Date(fixedNow.getTime() + 60_000).toISOString(),
      }),
    );

    const runSyncSpy = vi.fn();
    const scheduler = new Scheduler({
      dataDir: dir,
      runSync: runSyncSpy,
      intervalMs: 30 * 60_000,
    });
    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runSyncSpy).not.toHaveBeenCalled();
  });
});
