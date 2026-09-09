import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";
import { Cooldown } from "../src/concurrency/cooldown.js";
import { createRunSync } from "../src/reference/sync/run-sync.js";
import { writeErrorState } from "../src/reference/sync/error-state-writer.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

describe("block_coaching write side (gate-reject mitigation)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "block-coaching-write-"));
  });

  afterEach(() => {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    vi.restoreAllMocks();
  });

  function readErrorState(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
  }

  it("a HARD gate rejection stamps mitigation:block_coaching on error_state.json", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const rejectingGate = vi.fn().mockReturnValue({
      ok: false,
      failures: [{ step: "step1_ftp_source", detail: "FTP source missing on athlete profile" }],
      warnings: [],
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: rejectingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("gate_rejected");

    const errorState = readErrorState();
    // Required-red: without the S3 write the field is absent / undefined here.
    expect(errorState.mitigation).toBe("block_coaching");
    expect(errorState.step).toBe("gate_rejected");
  });

  it("soft warnings still write mitigation:warn_only, never block_coaching", async () => {
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
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: warningGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const errorState = readErrorState();
    expect(errorState.mitigation).toBe("warn_only");
    expect(errorState.mitigation).not.toBe("block_coaching");
  });

  it("a later outer_timeout cycle preserves a prior block_coaching (does not re-open coaching while the cache is still unvalidated)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");

    // Cycle 1: a HARD gate rejection stamps block_coaching.
    const rejectingSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockResolvedValue(emptyFetched),
      gate: vi.fn().mockReturnValue({
        ok: false,
        failures: [{ step: "step1_ftp_source", detail: "FTP source missing" }],
        warnings: [],
      }),
      now: () => now,
    });
    await rejectingSync({ caller: "scheduled" });
    expect(readErrorState().mitigation).toBe("block_coaching");

    // Cycle 2: a transient outer timeout — the cache was never re-validated, so
    // the corruption-class block must survive the mitigation-less timeout write.
    const timingOutSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(() => new Promise<never>(() => {})),
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });
    const result = await timingOutSync({ caller: "scheduled" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("outer_timeout");

    const errorState = readErrorState();
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.mitigation).toBe("block_coaching");
  });

  it("a pre-existing block_coaching survives an outer_timeout cycle: the timeout-path record still carries the block (carry-forward)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");

    // Pre-seed a corruption-class block from an earlier HARD gate rejection.
    await writeErrorState(dir, {
      step: "gate_rejected",
      detail: "FTP source missing",
      mitigation: "block_coaching",
    });
    expect(readErrorState().mitigation).toBe("block_coaching");

    // A later tick times out (hanging fetch). The cache was never re-validated,
    // so the mitigation-less timeout write must NOT demote the block — the
    // timeout path carries the prior block_coaching forward off disk.
    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn(() => new Promise<never>(() => {})),
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("outer_timeout");

    const errorState = readErrorState();
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.mitigation).toBe("block_coaching");
  });

  it("intra-cycle: a same-cycle gate-reject + outer-timeout keeps mitigation:block_coaching on the timeout record (and the abort-skipped gate write never clobbers it)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const mutex = new AsyncMutex();
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const rejectingGate = vi.fn().mockReturnValue({
      ok: false,
      failures: [{ step: "step1_ftp_source", detail: "FTP source missing on athlete profile" }],
      warnings: [],
    });

    const { atomicWriteJson: realAtomicWrite } = await import("../src/io/atomic-write-json.js");

    // Park the FIRST error_state.json write (the gate-reject write) on a gate so
    // the outer timer can fire while it is still in flight; later writes (the
    // timeout-path record) pass straight through.
    let releaseGate!: () => void;
    const gateLatch = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalArrived: (() => void) | null = () => {};
    const arrivedAtGate = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    let signalParkedWriteSettled!: () => void;
    const parkedWriteSettled = new Promise<void>((resolve) => {
      signalParkedWriteSettled = resolve;
    });
    const writes: Array<{ path: string; value: unknown }> = [];
    let parkedFirst = false;
    const latchedWrite = vi.fn(
      async (path: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
        writes.push({ path, value });
        const isParkedWrite = path.endsWith("error_state.json") && !parkedFirst;
        if (isParkedWrite) {
          parkedFirst = true;
          if (signalArrived !== null) {
            signalArrived();
            signalArrived = null;
          }
          await gateLatch;
        }
        // Forward the threaded opts so the released gate-reject write honours the
        // abort (rename-skip) exactly as production does.
        try {
          await realAtomicWrite(path, value, opts);
        } finally {
          if (isParkedWrite) signalParkedWriteSettled();
        }
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
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: rejectingGate,
      atomicWrite: latchedWrite,
      clock: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
      now: () => now,
      timing: { outerTimeoutMs: 300 },
    });

    const p = runSync({ caller: "scheduled" });

    await arrivedAtGate;
    await Promise.resolve();

    // Fire the outer timeout while the gate-reject write is STILL parked.
    capturedTimeoutFn();
    const result = await p;

    // (1) The cycle fails on the outer timeout.
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("outer_timeout");

    // (2) The timeout-path record carries block_coaching from the synchronous
    // in-cycle cycleBlockCoaching flag. Without the flag the timeout path would
    // read priorBlockCoaching off disk, but the gate-reject write is still parked
    // / never landed, so it would be undefined — which is exactly why this
    // assertion fails if the flag is neutralised.
    const timeoutRecord = writes.find(
      (w) =>
        w.path.endsWith("error_state.json") &&
        (w.value as { step?: string }).step === "outer_timeout",
    );
    expect(timeoutRecord).toBeDefined();
    expect((timeoutRecord!.value as { mitigation?: string }).mitigation).toBe("block_coaching");

    // (3) The timeout force-released the mutex.
    expect(mutex.isHeld()).toBe(false);

    // (4) Release the parked gate-reject write and drain. Its threaded (aborted)
    // signal makes the abort-aware helper skip its rename, so it never clobbers
    // the already-landed timeout record on disk.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    releaseGate();
    await parkedWriteSettled;
    await Promise.resolve();
    await Promise.resolve();
    warnSpy.mockRestore();

    const onDisk = readErrorState();
    expect(onDisk.step).toBe("outer_timeout");
    expect(onDisk.mitigation).toBe("block_coaching");
  });

  it("a clean sync leaves no error_state.json (the block write never leaks onto the happy path)", async () => {
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const cleanGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [],
      freshness: "fresh",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: cleanGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");
    expect(existsSync(join(dir, "error_state.json"))).toBe(false);
  });
});
