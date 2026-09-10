import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";
import { Cooldown } from "../src/concurrency/cooldown.js";
import {
  createRunSync,
  type FetchedReference,
  BODY_AFTER_TIMEOUT_LOG_PREFIX,
} from "../src/reference/sync/run-sync.js";
import { SCHEDULED_SYNC_INTERVAL_MS } from "../src/reference/freshness.js";
import { LATEST_SCHEMA_VERSION, LatestJsonSchema } from "../src/reference/schemas/latest.js";
import { readLatestVersioned } from "../src/reference/io/read-latest-versioned.js";
import { bootstrapReference } from "../src/reference/runtime.js";
import type { Sport } from "../src/sport.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

describe("createRunSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-run-sync-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns kind:skipped reason:cooldown without acquiring the mutex or fetching when the /sync caller is within the cooldown window", async () => {
    let now = 1_000_000;
    const cooldown = new Cooldown(() => now);
    cooldown.record("telegram:123");
    now += 5_000;

    const fetchSpy = vi.fn();
    const mutex = new AsyncMutex();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => new Date(now),
    });

    const result = await runSync({ caller: "/sync", chatId: "telegram:123" });

    expect(result).toEqual({
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 25_000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("settles an external abort while fetch ignores cancellation without persisting diagnostics", async () => {
    const controller = new AbortController();
    let releaseFetch!: (value: FetchedReference) => void;
    let fetchSignal!: AbortSignal;
    const syncHistory = vi.fn();
    const atomicWrite = vi.fn(async () => {});
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: (signal) => {
        fetchSignal = signal;
        return new Promise<FetchedReference>((resolve) => {
          releaseFetch = resolve;
        });
      },
      atomicWrite,
      syncHistory,
    });

    const running = runSync({ caller: "scheduled", signal: controller.signal });
    while (fetchSignal === undefined) await Promise.resolve();
    controller.abort(new Error("store runtime closed"));

    await expect(running).rejects.toThrow("store runtime closed");
    expect(fetchSignal.aborted).toBe(true);
    expect(syncHistory).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(() => readFileSync(join(dir, "error_state.json"), "utf8")).toThrow();

    releaseFetch(emptyFetched);
    await Promise.resolve();
    await Promise.resolve();
    expect(syncHistory).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it("does not let an externally aborted predecessor replace a successor cache", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");
    let releaseWrites!: () => void;
    const writesGate = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let marked = false;
    const pendingWrites: Array<Promise<void>> = [];
    const predecessor = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      atomicWrite: async (path, value, opts) => {
        if (!marked) {
          marked = true;
          markWriteStarted();
        }
        await writesGate;
        const pending = realAtomicWrite(path, value, opts);
        pendingWrites.push(pending);
        await pending;
      },
      now: () => new Date("1998-01-01T00:00:00.000Z"),
    });

    const predecessorRun = predecessor({ caller: "scheduled", signal: controller.signal });
    await writeStarted;
    controller.abort(new Error("store runtime closed"));
    await expect(predecessorRun).rejects.toThrow("store runtime closed");
    expect(mutex.isHeld()).toBe(false);

    const successor = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      now: () => new Date("1998-01-02T00:00:00.000Z"),
    });
    await successor({ caller: "scheduled" });
    releaseWrites();
    await vi.waitFor(() => expect(pendingWrites).toHaveLength(5));
    await Promise.allSettled(pendingWrites);

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.last_updated).toBe("1998-01-02T00:00:00.000Z");
  });

  it("does not let an externally aborted predecessor clear a successor error state", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const { clearErrorState: realClearError } =
      await import("../src/reference/sync/error-state-writer.js");
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let markClearStarted!: () => void;
    const clearStarted = new Promise<void>((resolve) => {
      markClearStarted = resolve;
    });
    const predecessor = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      clearError: async (dataDir, opts) => {
        markClearStarted();
        await clearGate;
        await realClearError(dataDir, opts);
      },
      now: () => new Date("1998-01-01T00:00:00.000Z"),
    });

    const predecessorRun = predecessor({ caller: "scheduled", signal: controller.signal });
    await clearStarted;
    controller.abort(new Error("store runtime closed"));
    await expect(predecessorRun).rejects.toThrow("store runtime closed");
    expect(mutex.isHeld()).toBe(false);

    const successor = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockRejectedValue(new Error("successor fetch failed")),
      now: () => new Date("1998-01-02T00:00:00.000Z"),
    });
    const successorResult = await successor({ caller: "scheduled" });
    expect(successorResult).toMatchObject({ kind: "failed", reason: "fetch_failed" });
    releaseClear();
    await clearGate;
    await Promise.resolve();

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("fetch_failed");
    expect(errorState.detail).toBe("successor fetch failed");
  });

  it("settles an external abort while queued for the mutex without starting sync work", async () => {
    const mutex = new AsyncMutex();
    let releaseHolder!: () => void;
    let markHolderEntered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      markHolderEntered = resolve;
    });
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = mutex.runExclusive(
      async () => {
        markHolderEntered();
        await holderGate;
      },
      { acquireTimeoutMs: 1_000, hotWarnMs: 500, caller: "holder" },
    );
    await holderEntered;

    const controller = new AbortController();
    const reason = new Error("store runtime closed while queued");
    const fetchReferenceData = vi.fn().mockResolvedValue(emptyFetched);
    const atomicWrite = vi.fn(async () => {});
    const syncHistory = vi.fn();
    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData,
      atomicWrite,
      syncHistory,
      timing: { acquireTimeoutMs: 1_000, hotWarnMs: 500 },
    });
    const running = runSync({ caller: "scheduled", signal: controller.signal });
    const observed = running.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    controller.abort(reason);
    const early = await Promise.race([
      observed,
      new Promise<{ kind: "pending" }>((resolve) => {
        setImmediate(() => resolve({ kind: "pending" }));
      }),
    ]);
    releaseHolder();
    await holder;
    const outcome = await observed;

    expect(early).toEqual({ kind: "error", error: reason });
    expect(outcome).toEqual({ kind: "error", error: reason });
    expect(fetchReferenceData).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(syncHistory).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("waits for an active timeout record before settling a later external abort", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const reason = new Error("store runtime closed during timeout write");
    let releaseWrite!: () => void;
    let markWriteEntered!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      markWriteEntered = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const atomicWrite = vi.fn(async () => {
      markWriteEntered();
      await writeGate;
    });
    const syncHistory = vi.fn();
    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: async () => await new Promise<FetchedReference>(() => {}),
      atomicWrite,
      syncHistory,
      timing: { outerTimeoutMs: 10 },
    });
    const running = runSync({ caller: "scheduled", signal: controller.signal });
    const observed = running.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    await writeEntered;
    controller.abort(reason);
    const early = await Promise.race([
      observed,
      new Promise<{ kind: "pending" }>((resolve) => {
        setImmediate(() => resolve({ kind: "pending" }));
      }),
    ]);
    releaseWrite();
    const outcome = await observed;

    expect(early).toEqual({ kind: "pending" });
    expect(outcome).toEqual({ kind: "error", error: reason });
    expect(atomicWrite).toHaveBeenCalledOnce();
    expect(syncHistory).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("writes 5 cache files first then .scheduler.json (commit-marker) and returns kind:ran with the refreshed list", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue({
      ...emptyFetched,
      latest: { ...emptyFetched.latest, athlete_profile: { id: "test-athlete" } },
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result).toEqual({
      kind: "ran",
      lastSyncAt: now.toISOString(),
      refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.schema_version).toBe(LATEST_SCHEMA_VERSION);
    expect(latest.metadata.last_updated).toBe(now.toISOString());
    expect(latest.metadata.freshness).toBe("fresh");
    expect(latest.athlete_profile).toEqual({ id: "test-athlete" });

    const scheduler = JSON.parse(readFileSync(join(dir, ".scheduler.json"), "utf-8"));
    expect(scheduler.last_sync_at).toBe(now.toISOString());
    expect(scheduler.next_sync_at).toBe(
      new Date(now.getTime() + SCHEDULED_SYNC_INTERVAL_MS).toISOString(),
    );

    expect(mutex.isHeld()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns kind:skipped reason:mutex_held when a second concurrent runSync waits past acquireTimeoutMs", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let resolveSlow!: () => void;
    const slowFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
      return emptyFetched;
    });
    const fastFetch = vi.fn().mockResolvedValue(emptyFetched);

    const runSyncSlow = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: slowFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 5_000, hotWarnMs: 1_000 },
    });
    const runSyncFast = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fastFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 30, hotWarnMs: 10 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    const p2 = runSyncFast({ caller: "scheduled" });

    const r2 = await p2;
    expect(r2).toEqual({ kind: "skipped", reason: "mutex_held" });
    expect(fastFetch).not.toHaveBeenCalled();

    resolveSlow();
    const r1 = await p1;
    expect(r1.kind).toBe("ran");
    expect(slowFetch).toHaveBeenCalledOnce();
  });

  it("interactive /sync fails fast on a held mutex: returns mutex_held promptly without fetching or waiting the acquire timeout", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let resolveSlow!: () => void;
    const slowFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
      return emptyFetched;
    });
    const fastFetch = vi.fn().mockResolvedValue(emptyFetched);

    const runSyncSlow = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: slowFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 5_000, hotWarnMs: 1_000 },
    });
    const runSyncInteractive = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fastFetch,
      now: () => now,
      // A LONG acquire timeout: if the fast-path did not short-circuit, the
      // interactive call would hang here, so a prompt resolution proves the
      // `isHeld()` guard fired before the blocking acquire.
      timing: { acquireTimeoutMs: 60_000, hotWarnMs: 1_000 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    // Let the slow sync acquire and start holding the mutex.
    await Promise.resolve();
    expect(mutex.isHeld()).toBe(true);

    const r2 = await runSyncInteractive({ caller: "/sync", chatId: "telegram:1" });
    expect(r2).toEqual({ kind: "skipped", reason: "mutex_held" });
    expect(fastFetch).not.toHaveBeenCalled();

    resolveSlow();
    const r1 = await p1;
    expect(r1.kind).toBe("ran");
  });

  it("scheduled caller does NOT short-circuit on a held mutex: it reaches the blocking acquire and waits", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let resolveSlow!: () => void;
    const slowFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
      return emptyFetched;
    });
    const fastFetch = vi.fn().mockResolvedValue(emptyFetched);

    const runSyncSlow = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: slowFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 5_000, hotWarnMs: 1_000 },
    });
    const runSyncScheduled = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fastFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 30, hotWarnMs: 10 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    await Promise.resolve();
    expect(mutex.isHeld()).toBe(true);

    // The scheduled caller queue-waits and times out (kind:skipped after the
    // acquire timeout), proving the fast-path guard did not fire for it.
    const r2 = await runSyncScheduled({ caller: "scheduled" });
    expect(r2).toEqual({ kind: "skipped", reason: "mutex_held" });
    expect(fastFetch).not.toHaveBeenCalled();

    resolveSlow();
    await p1;
  });

  it("times out at outerTimeoutMs: aborts the controller, writes error_state.json with phase, releases mutex, returns kind:failed", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let capturedSignal: AbortSignal | null = null;
    const hangingFetch = vi.fn(async (signal: AbortSignal): Promise<FetchedReference> => {
      capturedSignal = signal;
      return await new Promise<FetchedReference>(() => {});
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: hangingFetch,
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result).toEqual({ kind: "failed", reason: "outer_timeout", failures: [] });
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
    expect(mutex.isHeld()).toBe(false);

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("fetching");

    // No cache files were written
    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();
  });

  it("on gate rejection writes error_state.json with step=gate_rejected (no phase) and returns kind:failed reason:gate_rejected", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const rejectingGate = vi.fn().mockReturnValue({
      ok: false,
      failures: [{ step: "ftp_source_check", detail: "FTP source missing on athlete profile" }],
      warnings: [],
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: rejectingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("gate_rejected");
      expect(result.failures).toEqual([
        { file: "latest", reason: "ftp_source_check: FTP source missing on athlete profile" },
      ]);
    }

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("gate_rejected");
    expect(errorState.detail).toContain("ftp_source_check");
    expect(errorState.phase).toBeUndefined();

    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();
    expect(mutex.isHeld()).toBe(false);
  });

  it("a fetched bundle carrying fetch_errors hard-fails the gate, writes error_state, and never writes latest.json", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue({
      ...emptyFetched,
      fetch_errors: [{ endpoint: "athlete", detail: "timeout" }],
    });
    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");
    // The gate-reject error_state write now routes through the injectable seam
    // (deps.atomicWrite), so forward it to the real writer for the on-disk
    // assertion below; cache/scheduler writes are still recorded as spy calls.
    const writeSpy = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        await realAtomicWrite(path, value, opts);
      },
    );

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: writeSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("gate_rejected");
      expect(result.failures.some((f) => f.reason.includes("athlete"))).toBe(true);
    }

    // The prior cache is preserved: no latest.json (or any cache file) write fired.
    const wrotePaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(wrotePaths.some((p) => p.endsWith("latest.json"))).toBe(false);
    expect(wrotePaths.some((p) => p.endsWith(".scheduler.json"))).toBe(false);

    // error_state.json names the failed endpoint (real write, gate-rejection path).
    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("gate_rejected");
    expect(errorState.detail).toContain("athlete");

    expect(mutex.isHeld()).toBe(false);
  });

  it("composition: fetch_errors AND an independent hard check (weight band) both fail the real gate → block_coaching, no cache/scheduler write", async () => {
    // Invariant: when a single cycle trips TWO independent HARD checks — a
    // partial fetch failure (fetch_errors channel, step0) AND an out-of-band
    // wellness weight (step4) — the REAL default gate aggregates both and the
    // cycle BLOCKS coaching. The mitigation is `block_coaching`, NOT the
    // `warn_only` reserved for the soft path; a blocked cycle persists no
    // cache or scheduler file. Distinct from the fetch_errors-ALONE test above:
    // this pins the COMPOSITION of two sources plus the block-vs-warn record.
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue({
      ...emptyFetched,
      // Source #1: a partial-fetch error channel naming the athlete endpoint
      // → step0_data_fetch HARD failure.
      fetch_errors: [{ endpoint: "athlete", detail: "timeout" }],
      // Source #2 (independent): wellness weight=500 is outside the [30,200]
      // band → step4_tolerance_band HARD failure, on its own merits.
      latest: {
        ...emptyFetched.latest,
        wellness_data: { days: [{ id: "1998-04-11", weight: 500, restingHR: 50 }] },
      },
    });
    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");
    // Forward to the real writer so the on-disk error_state read below works,
    // while still recording every write path the cycle attempted.
    const writeSpy = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        await realAtomicWrite(path, value, opts);
      },
    );

    // No `gate` override: the whole point is that the REAL default gate maps
    // fetch_errors -> block_coaching alongside the independent band failure.
    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: writeSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("gate_rejected");
      // BOTH sources must be present — asserting both guarantees the test is
      // green because BOTH checks fired, not because only one did. Each source
      // is pinned by its step identifier (not just an endpoint name) so the
      // assertion cannot pass on an unrelated check that happens to echo it.
      expect(
        result.failures.some(
          (f) => f.reason.includes("step0_data_fetch") && f.reason.includes("athlete"),
        ),
      ).toBe(true);
      expect(result.failures.some((f) => f.reason.includes("step4_tolerance_band"))).toBe(true);
    }

    // A blocked cycle persists no cache (latest.json) and no commit marker
    // (.scheduler.json) — the prior cache stays untouched.
    const wrotePaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(wrotePaths.some((p) => p.endsWith("latest.json"))).toBe(false);
    expect(wrotePaths.some((p) => p.endsWith(".scheduler.json"))).toBe(false);

    // error_state.json records the block-coaching mitigation and names BOTH
    // independent failures (step0 endpoint + step4 band).
    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.mitigation).toBe("block_coaching");
    expect(errorState.step).toBe("gate_rejected");
    expect(errorState.detail).toContain("step0_data_fetch");
    expect(errorState.detail).toContain("athlete");
    expect(errorState.detail).toContain("step4_tolerance_band");

    expect(mutex.isHeld()).toBe(false);
  });

  it("no-op cycle: a re-fetch with byte-identical data leaves all 5 cache files byte-identical (frozen last_updated)", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const first = new Date("2026-05-09T14:00:00Z");
    const second = new Date("2026-05-09T14:30:00Z");
    const fetchSpy = vi.fn().mockResolvedValue({
      ...emptyFetched,
      latest: { ...emptyFetched.latest, athlete_profile: { id: "test-athlete" } },
    });

    const makeRunSync = (now: Date) =>
      createRunSync({
        dataDir: dir,
        mutex,
        cooldown,
        cooldownWindowMs: 30_000,
        fetchReferenceData: fetchSpy,
        now: () => now,
      });

    const files = ["latest", "history", "intervals", "routes", "ftp_history"];

    const r1 = await makeRunSync(first)({ caller: "scheduled" });
    expect(r1.kind).toBe("ran");
    const afterFirst = files.map((f) => readFileSync(join(dir, `${f}.json`), "utf-8"));

    const r2 = await makeRunSync(second)({ caller: "scheduled" });
    expect(r2.kind).toBe("ran");
    const afterSecond = files.map((f) => readFileSync(join(dir, `${f}.json`), "utf-8"));

    expect(afterSecond).toEqual(afterFirst);
    if (r2.kind === "ran") expect(r2.refreshed).toEqual([]);

    // The commit marker still advanced even though no cache file was rewritten.
    const scheduler = JSON.parse(readFileSync(join(dir, ".scheduler.json"), "utf-8"));
    expect(scheduler.last_sync_at).toBe(second.toISOString());
    // latest.json kept the FIRST run's timestamp (skipped, not rewritten).
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.last_updated).toBe(first.toISOString());
  });

  it("no-op cycle: a re-fetch with the same data but a different top-level key order still short-circuits", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const first = new Date("2026-05-09T14:00:00Z");
    const second = new Date("2026-05-09T14:30:00Z");

    // The on-disk file is read back through a Zod re-parse, which rebuilds the
    // payload in schema-declaration order; the live producer emits it in
    // insertion order. A future producer (or a re-ordered nested object) can
    // legitimately differ in key order while carrying identical data — the
    // short-circuit must not be defeated by that.
    const profile = { name: "test", id: "test-athlete", ftp: 250 };
    const reordered = { ftp: 250, id: "test-athlete", name: "test" };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ...emptyFetched,
        latest: { ...emptyFetched.latest, athlete_profile: profile },
      })
      .mockResolvedValueOnce({
        ...emptyFetched,
        latest: { ...emptyFetched.latest, athlete_profile: reordered },
      });

    const makeRunSync = (now: Date) =>
      createRunSync({
        dataDir: dir,
        mutex,
        cooldown,
        cooldownWindowMs: 30_000,
        fetchReferenceData: fetchSpy,
        now: () => now,
      });

    await makeRunSync(first)({ caller: "scheduled" });
    const latestBefore = readFileSync(join(dir, "latest.json"), "utf-8");

    const r2 = await makeRunSync(second)({ caller: "scheduled" });
    if (r2.kind === "ran") expect(r2.refreshed).toEqual([]);
    expect(readFileSync(join(dir, "latest.json"), "utf-8")).toBe(latestBefore);
  });

  it("changed-file-only: a second fetch that changes intervals rewrites only intervals.json; siblings keep their bytes", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const first = new Date("2026-05-09T14:00:00Z");
    const second = new Date("2026-05-09T14:30:00Z");

    const base = {
      ...emptyFetched,
      latest: { ...emptyFetched.latest, athlete_profile: { id: "test-athlete" } },
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({
        ...base,
        intervals: { by_activity: { a1: [{ id: "i1" }] } },
      });

    const makeRunSync = (now: Date) =>
      createRunSync({
        dataDir: dir,
        mutex,
        cooldown,
        cooldownWindowMs: 30_000,
        fetchReferenceData: fetchSpy,
        now: () => now,
      });

    await makeRunSync(first)({ caller: "scheduled" });
    const latestBefore = readFileSync(join(dir, "latest.json"), "utf-8");

    const r2 = await makeRunSync(second)({ caller: "scheduled" });
    if (r2.kind === "ran") expect(r2.refreshed).toEqual(["intervals"]);

    const intervals = JSON.parse(readFileSync(join(dir, "intervals.json"), "utf-8"));
    expect(intervals.metadata.last_updated).toBe(second.toISOString());
    expect(intervals.by_activity).toEqual({ a1: [{ id: "i1" }] });
    // latest.json untouched (no data change) — bytes + timestamp frozen at run 1.
    expect(readFileSync(join(dir, "latest.json"), "utf-8")).toBe(latestBefore);
  });

  it("when outer timeout fires during writing_scheduler phase, error_state.phase reflects it and caches survive", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");

    // The scheduler write parks on schedulerGate, so the body sits inside the
    // .scheduler.json write (phase === "writing_scheduler") until the hand-fired
    // outer timer wins the race — no wall-clock dependence. `arrivedAtGate`
    // resolves the instant the body reaches the parked scheduler write, so the
    // test fires the timer at exactly the right phase regardless of how long the
    // upstream cache writes take.
    let releaseScheduler!: () => void;
    const schedulerGate = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    let signalArrived!: () => void;
    const arrivedAtGate = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    const pendingWrites: Array<Promise<unknown>> = [];
    const latchedSchedulerWrite = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        if (path.endsWith(".scheduler.json")) {
          signalArrived();
          await schedulerGate;
        }
        const w = realAtomicWrite(path, value, opts);
        pendingWrites.push(w);
        await w;
      },
    );

    let capturedTimeoutFn!: () => void;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      capturedTimeoutFn = fn;
      return 1;
    });
    const clearTimeoutFn = vi.fn();

    // Suppress the expected body-after-timeout warn from the dangling
    // scheduler write that completes after the orchestrator returns.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: latchedSchedulerWrite,
      clock: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
      now: () => now,
      timing: { outerTimeoutMs: 300 },
    });

    const p = runSync({ caller: "scheduled" });

    // Synchronize on the body parking at the scheduler write (phase ===
    // "writing_scheduler"), then fire the captured outer-timer callback by hand.
    await arrivedAtGate;
    await Promise.resolve();

    capturedTimeoutFn();
    const result = await p;

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("writing_scheduler");

    // All 5 cache files survived the partial commit; only .scheduler.json never landed.
    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "history.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "intervals.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "routes.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "ftp_history.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();

    expect(mutex.isHeld()).toBe(false);

    // Let the dangling scheduler write settle before afterEach removes the dir.
    releaseScheduler();
    await schedulerGate;
    await Promise.resolve();
    await Promise.allSettled(pendingWrites);
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();
  });

  // ── A1: body must NOT proceed past writing_cache once outer timeout fired ──

  it("A1: when outer timeout fires during writing_cache, body bails before writing .scheduler.json", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");

    // Every cache write parks on cacheGate, so the body sits at
    // phase === "writing_cache" until the hand-fired outer timer wins; abort
    // then runs while in writing_cache, so the A1 guard bails the body before
    // the scheduler write. `arrivedAtGate` resolves the instant the first cache
    // write reaches the gate, so the timer fires at exactly the writing_cache
    // phase regardless of upstream timing.
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let signalArrived: (() => void) | null = () => {};
    const arrivedAtGate = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    const pendingWrites: Array<Promise<unknown>> = [];
    const latchedCacheWrite = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        // Park only the cache writes; the post-timeout error_state record (which
        // now routes through this same seam, signal-less) must pass straight
        // through so the orchestrator can land the authoritative timeout record.
        if (!path.endsWith(".scheduler.json") && !path.endsWith("error_state.json")) {
          if (signalArrived !== null) {
            signalArrived();
            signalArrived = null;
          }
          await cacheGate;
        }
        // Forward the threaded signal so the real abort-aware helper sees the
        // aborted state once the hand-fired timer ran — the rename-skip fires
        // exactly as in production.
        const w = realAtomicWrite(path, value, opts);
        pendingWrites.push(w);
        await w;
      },
    );

    let capturedTimeoutFn!: () => void;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      capturedTimeoutFn = fn;
      return 1;
    });
    const clearTimeoutFn = vi.fn();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: latchedCacheWrite,
      clock: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const p = runSync({ caller: "scheduled" });

    // Synchronize on the body parking inside the held cache writes (phase ===
    // "writing_cache"), then fire the captured outer-timer callback by hand.
    await arrivedAtGate;
    await Promise.resolve();

    capturedTimeoutFn();
    const result = await p;

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("writing_cache");

    // With A1 + the abort-aware write helper, .scheduler.json must NOT exist
    // (the body bailed before the commit-marker write).
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();

    expect(mutex.isHeld()).toBe(false);

    // Let the held cache writes finish, then drain microtasks so the body runs
    // through its aborted-guard and returns, all before afterEach removes the dir.
    releaseCache();
    await cacheGate;
    await Promise.allSettled(pendingWrites);
    await Promise.resolve();
    await Promise.resolve();

    // The rename-boundary check skips any cache write that had not yet reached
    // its rename commit when the abort fired. This test's cacheGate parks all 5
    // writes BEFORE they delegate to the real helper, so the hand-fired abort
    // lands while every write is still ahead of its check — deterministically
    // forcing all 5 into the skip window, so NONE of the payload files land.
    // Production does NOT gate the writes (run-sync fires them concurrently), so
    // an abort at an arbitrary instant may leave a PARTIAL subset renamed: any
    // write already past its check is uncancellable and still commits, while
    // writes still ahead of the check skip. The guarantee the check delivers is
    // per-write ("no write renames after observing the abort"), not an
    // all-or-nothing across the 5 files. Either way, a dead cycle's payload that
    // had not yet committed never replaces the live file after the mutex was
    // handed to the successor cycle.
    for (const file of [
      "latest.json",
      "history.json",
      "intervals.json",
      "routes.json",
      "ftp_history.json",
    ]) {
      expect(() => readFileSync(join(dir, file), "utf-8")).toThrow();
    }
    // No temp siblings linger — the aborted branch unlinked each one.
    const orphans = readdirSync(dir).filter((e) => e.includes(".tmp."));
    expect(orphans).toEqual([]);
  });

  // ── A2: body throws after timeout — error must NOT be silently swallowed ──

  it("A2: a body throw after outer timeout fired is logged via console.warn (not silently swallowed)", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");
    // atomicWrite that throws (simulating disk-full or fs error) AFTER a 200ms
    // delay. With outerTimeoutMs: 20, the outer race wins ("timeout") at ~20ms;
    // the body's await of this write rejects at ~200ms. The 10× gap keeps the
    // test deterministic on slow CI runners. The timeout-path error_state write
    // now routes through this same seam — forward it to the real writer so the
    // authoritative timeout record still lands and only the body's cache write
    // simulates the disk failure under test.
    const failingWrite = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        if (path.endsWith("error_state.json")) {
          await realAtomicWrite(path, value, opts);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error("simulated disk-full mid-write");
      },
    );

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: failingWrite,
      now: () => now,
      timing: { outerTimeoutMs: 20 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    // The body throws ~200ms AFTER the orchestrator returned. Its error reaches
    // the bodySettled handler, which logs via console.warn. Wait explicitly with
    // a generous timeout so a slow CI runner doesn't false-fail.
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(BODY_AFTER_TIMEOUT_LOG_PREFIX),
        );
      },
      { timeout: 1_000, interval: 10 },
    );

    expect(mutex.isHeld()).toBe(false);
  });

  // Records cooldown only on success (kind:ran), never on skipped/failed.
  it("records cooldown for /sync only after a successful kind:ran result", async () => {
    let nowMs = 1_000_000;
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown(() => nowMs);
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => new Date(nowMs),
    });

    // First /sync — succeeds, records cooldown.
    const r1 = await runSync({ caller: "/sync", chatId: "chat-1" });
    expect(r1.kind).toBe("ran");

    // Second /sync within window — gated by cooldown.
    nowMs += 5_000;
    const r2 = await runSync({ caller: "/sync", chatId: "chat-1" });
    expect(r2).toEqual({
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 25_000,
    });
  });

  it("soft-fail path: gate warnings → latest.json + .scheduler.json written, error_state mitigation:warn_only, kind:ran", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const warningGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [{ step: "step6_freshness_24h", detail: "data freshness=stale" }],
      freshness: "stale",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: warningGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.freshness).toBe("stale");

    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).not.toThrow();

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("gate_warnings");
    expect(errorState.mitigation).toBe("warn_only");
    expect(errorState.detail).toContain("step6_freshness_24h");
  });

  it("clear-on-success: a clean sync removes a pre-existing error_state.json, only after the commit marker", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    // Pre-create a stale error_state.json from a prior failed run.
    const { writeErrorState } = await import("../src/reference/sync/error-state-writer.js");
    await writeErrorState(dir, { step: "outer_timeout", detail: "prior failure" });
    expect(() => readFileSync(join(dir, "error_state.json"), "utf-8")).not.toThrow();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    expect(() => readFileSync(join(dir, "error_state.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).not.toThrow();
  });

  it("freshness wiring: gate's freshness band lands on latest.json.metadata.freshness (not hardcoded fresh)", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const flaggingGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [],
      freshness: "flag",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: flaggingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.freshness).toBe("flag");
  });

  it("uses the injected clock.setTimeout/clearTimeout for the outer timer with the configured ms", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const setSpy = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearSpy = vi.fn((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    );

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      clock: { setTimeout: setSpy, clearTimeout: clearSpy },
      timing: { outerTimeoutMs: 7_777 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("ran");
    // The outer-timeout race calls setTimeoutFn with the configured ms.
    // Asserting the ms argument prevents a regression where someone calls
    // global setTimeout directly while still touching the spy elsewhere.
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 7_777);
    // clearTimeoutFn must receive the handle that setTimeoutFn returned.
    const expectedHandle = setSpy.mock.results[0]?.value;
    expect(clearSpy).toHaveBeenCalledWith(expectedHandle);
  });
});

const fakeSport = (): Sport =>
  ({
    intervalsActivityTypes: [],
    referenceAdapters: undefined,
  }) as unknown as Sport;

// A v2-shaped body the schema accepts on its own merits — used to prove the
// version-equality gate runs AFTER safeReadJson (safeReadJson types
// schema_version only as z.string(), so a shape-valid stale file parses clean).
const v2BodyShapeValid = {
  athlete_profile: { id: "test-athlete" },
  current_status: {},
  derived_metrics: { acwr: null, monotony: 1.2 },
  recent_activities: [],
  planned_workouts: [],
  wellness_data: {},
};

const onDiskWithVersion = (version: string) => ({
  metadata: {
    schema_version: version,
    last_updated: "1998-06-20T00:00:00.000Z",
    freshness: "fresh" as const,
  },
  ...v2BodyShapeValid,
});

describe("latest derived_metrics structured schema + version gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-run-schema-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('the current cache schema version is "4"', () => {
    expect(LATEST_SCHEMA_VERSION).toBe("4");
  });

  it("a sparse running derived_metrics map (power keys absent, others null) parses clean", () => {
    const sparse = {
      ...onDiskWithVersion(LATEST_SCHEMA_VERSION),
      derived_metrics: {
        acwr: null,
        monotony: null,
        strain: null,
        easy_time_ratio: null,
        consistency_index: null,
        seiler_tid_7d: null,
        seasonal_context: null,
        "capability.durability": null,
        "capability.efficiency_factor": null,
      },
    };
    expect(() => LatestJsonSchema.parse(sparse)).not.toThrow();
  });

  it("the 8 dotted capability.* keys round-trip verbatim as FLAT properties", () => {
    const withCapabilities = {
      ...onDiskWithVersion(LATEST_SCHEMA_VERSION),
      derived_metrics: {
        "capability.durability": { score: 1 },
        "capability.efficiency_factor": { ef: 2 },
        "capability.hrrc": { v: 3 },
        "capability.tid_comparison": { v: 4 },
        "capability.power_curve_delta": null,
        "capability.hr_curve_delta": null,
        "capability.sustainability_profile": { v: 7 },
        "capability.dfa_a1_profile": { v: 8 },
      },
    };
    const parsed = LatestJsonSchema.parse(withCapabilities);
    expect(parsed.derived_metrics["capability.durability"]).toEqual({ score: 1 });
    expect(parsed.derived_metrics["capability.dfa_a1_profile"]).toEqual({ v: 8 });
    // The flat dotted key is NOT a nested capability object.
    expect((parsed.derived_metrics as Record<string, unknown>).capability).toBeUndefined();
  });

  it("readLatestVersioned returns the parsed envelope for a current-v2 file", () => {
    const path = join(dir, "latest.json");
    writeFileSync(path, JSON.stringify(onDiskWithVersion(LATEST_SCHEMA_VERSION)), "utf-8");
    const result = readLatestVersioned(path);
    expect(result).not.toBeNull();
    expect(result?.metadata.schema_version).toBe(LATEST_SCHEMA_VERSION);
  });

  it("readLatestVersioned routes a stale v1 file to discard-and-resync (null) even when its body fits v2", () => {
    const path = join(dir, "latest.json");
    // Deliberately schema_version "1" — do NOT bump this literal.
    writeFileSync(path, JSON.stringify(onDiskWithVersion("1")), "utf-8");
    expect(readLatestVersioned(path)).toBeNull();
  });

  it("readLatestVersioned returns null for a missing or corrupt file (safeReadJson behavior preserved)", () => {
    expect(readLatestVersioned(join(dir, "does-not-exist.json"))).toBeNull();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not valid json", "utf-8");
    expect(readLatestVersioned(corrupt)).toBeNull();
  });

  it("runtime loadLatest (delegating to readLatestVersioned) returns null for a stale v1 cache that fits v2", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const runtime = await bootstrapReference({
      dataDir: dir,
      intervals: { apiKey: "test-key" },
      readCalendarTimeZone: () => "UTC",
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });
    runtime.scheduler.stop();

    // Overwrite the freshly-synced cache with a stale v1 file whose body is
    // otherwise v2-shape-valid. loadLatest must treat it as a cache miss.
    const latestPath = join(dir, "data", "latest.json");
    writeFileSync(latestPath, JSON.stringify(onDiskWithVersion("1")), "utf-8");
    expect(runtime.services.loadLatest()).toBeNull();
  });
});

describe("createRunSync sync-history emit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-run-sync-history-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const okGate = vi.fn().mockReturnValue({ ok: true, failures: [], warnings: [] });

  it("clean ran: emits exactly one line with kind:ran, no reason, finite duration ≥ 0", async () => {
    const syncHistory = vi.fn();
    // Advancing clock so duration is a positive measured delta, not zero.
    let t = Date.parse("2026-05-09T14:00:00.000Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue({
        ...emptyFetched,
        latest: { ...emptyFetched.latest, athlete_profile: { id: "a" } },
      }),
      gate: okGate,
      syncHistory,
      now: () => new Date((t += 5)),
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("ran");
    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.schema_version).toBe("1");
    expect(line.kind).toBe("ran");
    expect(line.caller).toBe("scheduled");
    expect(line.reason).toBeUndefined();
    expect(typeof line.duration_ms).toBe("number");
    expect(Number.isFinite(line.duration_ms)).toBe(true);
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof line.ts).toBe("string");
  });

  it("clamps duration_ms to 0 when the wall clock steps backward mid-tick", async () => {
    const syncHistory = vi.fn();
    // Clock steps backward between startedAt and the emit (a backward NTP step):
    // the recorded duration must clamp to 0, never a negative number.
    const times = [
      Date.parse("2026-05-09T14:00:10.000Z"),
      Date.parse("2026-05-09T14:00:00.000Z"),
      Date.parse("2026-05-09T14:00:00.000Z"),
    ];
    let i = 0;
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: okGate,
      syncHistory,
      now: () => new Date(times[Math.min(i++, times.length - 1)]!),
    });

    await runSync({ caller: "scheduled" });

    expect(syncHistory).toHaveBeenCalledOnce();
    expect(syncHistory.mock.calls[0]![0].duration_ms).toBe(0);
  });

  it("gate_rejected: emits one line with kind:failed reason:gate_rejected", async () => {
    const syncHistory = vi.fn();
    const now = new Date("2026-05-09T14:00:00Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: vi.fn().mockReturnValue({
        ok: false,
        failures: [{ step: "ftp_source_check", detail: "missing" }],
        warnings: [],
      }),
      syncHistory,
      now: () => now,
    });

    await runSync({ caller: "lazy" });

    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.kind).toBe("failed");
    expect(line.reason).toBe("gate_rejected");
    expect(line.caller).toBe("lazy");
  });

  it("fetch_failed (fetcher rejects): emits one line with kind:failed reason:fetch_failed", async () => {
    const syncHistory = vi.fn();
    const now = new Date("2026-05-09T14:00:00Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockRejectedValue(new Error("net down")),
      syncHistory,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.kind).toBe("failed");
    expect(line.reason).toBe("fetch_failed");
  });

  it("outer_timeout: emits one line with kind:failed reason:outer_timeout", async () => {
    const syncHistory = vi.fn();
    const now = new Date("2026-05-09T14:00:00Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(
        async (): Promise<FetchedReference> => await new Promise<FetchedReference>(() => {}),
      ),
      syncHistory,
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    await runSync({ caller: "scheduled" });

    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.kind).toBe("failed");
    expect(line.reason).toBe("outer_timeout");
  });

  it("mutex_held skip: a contended scheduled tick emits one line with kind:skipped reason:mutex_held", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const syncHistory = vi.fn();

    let resolveSlow!: () => void;
    const slowFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
      return emptyFetched;
    });

    const runSyncSlow = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: slowFetch,
      gate: okGate,
      now: () => now,
      timing: { acquireTimeoutMs: 5_000, hotWarnMs: 1_000 },
    });
    const runSyncFast = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: okGate,
      syncHistory,
      now: () => now,
      timing: { acquireTimeoutMs: 30, hotWarnMs: 10 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    const r2 = await runSyncFast({ caller: "scheduled" });

    expect(r2).toEqual({ kind: "skipped", reason: "mutex_held" });
    expect(syncHistory).toHaveBeenCalledOnce();
    expect(syncHistory.mock.calls[0]![0].kind).toBe("skipped");
    expect(syncHistory.mock.calls[0]![0].reason).toBe("mutex_held");

    resolveSlow();
    await p1;
  });

  it("/sync cooldown skip: emits one line with kind:skipped reason:cooldown (early-return path)", async () => {
    let now = 1_000_000;
    const cooldown = new Cooldown(() => now);
    cooldown.record("telegram:123");
    now += 5_000;
    const syncHistory = vi.fn();

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(),
      syncHistory,
      now: () => new Date(now),
    });

    const result = await runSync({ caller: "/sync", chatId: "telegram:123" });

    expect(result.kind).toBe("skipped");
    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.kind).toBe("skipped");
    expect(line.reason).toBe("cooldown");
    expect(line.caller).toBe("/sync");
  });

  it("a body that throws still leaves exactly one failed line before the throw propagates", async () => {
    const syncHistory = vi.fn();
    const now = new Date("2026-05-09T14:00:00Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      // An unguarded throw from inside the mutex body (here the gate) re-throws
      // out of runExclusive — the path that previously bypassed the emit.
      gate: vi.fn(() => {
        throw new Error("gate blew up");
      }),
      syncHistory,
      now: () => now,
    });

    await expect(runSync({ caller: "scheduled" })).rejects.toThrow("gate blew up");

    expect(syncHistory).toHaveBeenCalledOnce();
    const line = syncHistory.mock.calls[0]![0];
    expect(line.kind).toBe("failed");
    expect(line.reason).toBe("unexpected_error");
    expect(line.caller).toBe("scheduled");
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("a throwing syncHistory spy cannot break the tick: runSync still resolves to the correct result", async () => {
    const throwingHistory = vi.fn(() => {
      throw new Error("history write blew up");
    });
    const now = new Date("2026-05-09T14:00:00Z");
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: vi.fn().mockReturnValue({
        ok: false,
        failures: [{ step: "ftp_source_check", detail: "missing" }],
        warnings: [],
      }),
      syncHistory: throwingHistory,
      now: () => now,
    });

    // The wiring positions the emit so its throw cannot escape the tick: the
    // real writer never throws, but a defensive guard keeps a misbehaving
    // injected writer from corrupting the SyncResult.
    await expect(runSync({ caller: "scheduled" })).resolves.toMatchObject({
      kind: "failed",
      reason: "gate_rejected",
    });
  });
});
