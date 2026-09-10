import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const opts = { acquireTimeoutMs: 5_000, hotWarnMs: 1_000, caller: "test" };

// Fake-timer-driven body delay: under vi.useFakeTimers() this is advanced
// deterministically by vi.advanceTimersByTimeAsync(ms), so no real wall time
// elapses and the timing tests can't race a slow runner.
const sleep = (ms: number) => new Promise<void>((done) => void setTimeout(done, ms));

describe("AsyncMutex.runExclusive", () => {
  it("serializes concurrent callers — second body starts only after the first resolves", async () => {
    vi.useFakeTimers();
    const mutex = new AsyncMutex();
    const events: Array<{ caller: string; phase: "start" | "end"; t: number }> = [];

    const body = (caller: string, durationMs: number) => async () => {
      events.push({ caller, phase: "start", t: Date.now() });
      await sleep(durationMs);
      events.push({ caller, phase: "end", t: Date.now() });
      return caller;
    };

    const p1 = mutex.runExclusive(body("first", 50), opts);
    const p2 = mutex.runExclusive(body("second", 20), opts);

    // Drive the first body's 50ms sleep, then the queued second body's 20ms.
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(20);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ kind: "ran", value: "first" });
    expect(r2).toEqual({ kind: "ran", value: "second" });

    const firstEnd = events.find((e) => e.caller === "first" && e.phase === "end")!.t;
    const secondStart = events.find((e) => e.caller === "second" && e.phase === "start")!.t;
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
  });

  it("preserves FIFO order across N concurrent waiters", async () => {
    vi.useFakeTimers();
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const body = (caller: string) => async () => {
      order.push(caller);
      await sleep(5);
      return caller;
    };

    const all = Promise.all([
      mutex.runExclusive(body("A"), opts),
      mutex.runExclusive(body("B"), opts),
      mutex.runExclusive(body("C"), opts),
      mutex.runExclusive(body("D"), opts),
      mutex.runExclusive(body("E"), opts),
    ]);

    // Each body sleeps 5ms and they run serially; drain the chain.
    await vi.advanceTimersByTimeAsync(5 * 5);
    await all;

    expect(order).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns { kind: 'timeout' } and does NOT run the body when acquire wait exceeds acquireTimeoutMs", async () => {
    vi.useFakeTimers();
    const mutex = new AsyncMutex();
    let secondBodyRan = false;

    const slow = async () => {
      await sleep(200);
      return "first";
    };

    const fast = async () => {
      secondBodyRan = true;
      return "second";
    };

    const p1 = mutex.runExclusive(slow, {
      acquireTimeoutMs: 5_000,
      hotWarnMs: 1_000,
      caller: "first",
    });
    const p2 = mutex.runExclusive(fast, { acquireTimeoutMs: 30, hotWarnMs: 10, caller: "second" });

    // Fire the fast caller's 30ms acquire-timeout before the slow body's 200ms
    // sleep completes, then drain the slow body.
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(200);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ kind: "ran", value: "first" });
    expect(r2).toEqual({ kind: "timeout" });
    expect(secondBodyRan).toBe(false);
  });

  it("releases the lock when the body throws so subsequent callers can run", async () => {
    const mutex = new AsyncMutex();
    let secondRan = false;

    const throwing = async () => {
      throw new Error("body fail");
    };
    const success = async () => {
      secondRan = true;
      return "second";
    };

    const p1 = mutex.runExclusive(throwing, opts);
    const p2 = mutex.runExclusive(success, opts);

    await expect(p1).rejects.toThrow("body fail");
    expect(await p2).toEqual({ kind: "ran", value: "second" });
    expect(secondRan).toBe(true);
  });

  // Regression for ADR-0011: AsyncMutex is non-reentrant. A nested call from
  // inside a held body must NOT deadlock — the inner call's own acquire
  // timeout fires and surfaces the bug as a 30s soft-skip rather than a hang.
  it("returns timeout (never deadlocks) when runExclusive is called from inside a held body", async () => {
    vi.useFakeTimers();
    const mutex = new AsyncMutex();
    let innerResult: { kind: "ran"; value: string } | { kind: "timeout" } | null = null;

    const outer = mutex.runExclusive(
      async () => {
        const inner = mutex.runExclusive(async () => "inner-body-ran", {
          acquireTimeoutMs: 50,
          hotWarnMs: 10,
          caller: "inner",
        });
        // Fire the inner re-entrant call's 50ms acquire-timeout — the outer
        // body holds the lock, so the inner can only ever time out.
        await vi.advanceTimersByTimeAsync(50);
        innerResult = await inner;
        return "outer-body-ran";
      },
      { acquireTimeoutMs: 5_000, hotWarnMs: 1_000, caller: "outer" },
    );

    const outerResult = await outer;

    expect(outerResult).toEqual({ kind: "ran", value: "outer-body-ran" });
    expect(innerResult).toEqual({ kind: "timeout" });
  });

  it("emits a structured mutex_hot warn to stderr when acquire wait exceeds hotWarnMs", async () => {
    vi.useFakeTimers();
    const mutex = new AsyncMutex();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const HOT_WARN_MS = 50;
    const slow = async () => {
      // Hold the mutex for substantially longer than HOT_WARN_MS so the
      // warn definitively fires before slow releases.
      await sleep(200);
      return "first";
    };
    const fast = async () => "second";

    const all = Promise.all([
      mutex.runExclusive(slow, {
        acquireTimeoutMs: 5_000,
        hotWarnMs: 1_000, // first never waits, never warns
        caller: "scheduled",
      }),
      mutex.runExclusive(fast, {
        acquireTimeoutMs: 5_000,
        hotWarnMs: HOT_WARN_MS,
        caller: "/sync",
      }),
    ]);

    // Fire the fast caller's hot-warn timer (it is enqueued behind the slow
    // body's hold), then drain the slow body's remaining sleep.
    await vi.advanceTimersByTimeAsync(HOT_WARN_MS);
    await vi.advanceTimersByTimeAsync(200);
    await all;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(payload.event).toBe("mutex_hot");
    expect(payload.caller).toBe("/sync");
    expect(typeof payload.wait_ms).toBe("number");
    expect(payload.wait_ms).toBeGreaterThanOrEqual(HOT_WARN_MS);
    expect(typeof payload.ts).toBe("string");
    expect(new Date(payload.ts).toString()).not.toBe("Invalid Date");
  });
});

describe("AsyncMutex.runExclusive — abort signal", () => {
  it("rejects with the abort reason and never runs the body when the signal is pre-aborted", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    const body = vi.fn(async () => "x");

    await expect(mutex.runExclusive(body, { ...opts, signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(body).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("rejects a queued waiter with the abort reason and removes it from the queue", async () => {
    const mutex = new AsyncMutex();
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = mutex.runExclusive(async () => {
      await holderGate;
      return "holder";
    }, opts);

    const controller = new AbortController();
    const reason = new Error("aborted while queued");
    const queuedBody = vi.fn(async () => "queued");
    const queued = mutex.runExclusive(queuedBody, { ...opts, signal: controller.signal });
    const after = mutex.runExclusive(async () => "after", opts);

    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    expect(queuedBody).not.toHaveBeenCalled();

    releaseHolder();
    expect(await holder).toEqual({ kind: "ran", value: "holder" });
    expect(await after).toEqual({ kind: "ran", value: "after" });
    expect(mutex.isHeld()).toBe(false);
  });

  it("aborts the lease with the external reason mid-body without rejecting the run", async () => {
    const mutex = new AsyncMutex();
    const controller = new AbortController();
    const reason = new Error("aborted mid-body");
    let observedAborted: boolean | null = null;
    let observedReason: unknown = null;

    const result = await mutex.runExclusive(
      async (lease) => {
        expect(lease.aborted).toBe(false);
        controller.abort(reason);
        observedAborted = lease.aborted;
        observedReason = lease.reason;
        return "done";
      },
      { ...opts, signal: controller.signal },
    );

    expect(result).toEqual({ kind: "ran", value: "done" });
    expect(observedAborted).toBe(true);
    expect(observedReason).toBe(reason);
    expect(mutex.isHeld()).toBe(false);
  });

  it("aborts the lease when the lock is released after a clean body", async () => {
    const mutex = new AsyncMutex();
    let lease!: AbortSignal;

    const result = await mutex.runExclusive(async (l) => {
      lease = l;
      expect(l.aborted).toBe(false);
      return "clean";
    }, opts);

    expect(result).toEqual({ kind: "ran", value: "clean" });
    expect(lease.aborted).toBe(true);
  });

  it("aborts the lease when the lock is released after a throwing body", async () => {
    const mutex = new AsyncMutex();
    let lease!: AbortSignal;

    await expect(
      mutex.runExclusive(async (l) => {
        lease = l;
        throw new Error("body fail");
      }, opts),
    ).rejects.toThrow("body fail");

    expect(lease.aborted).toBe(true);
    expect(mutex.isHeld()).toBe(false);
  });
});

describe("AsyncMutex.runExclusive — input validation (B2 from QA review)", () => {
  it("throws when acquireTimeoutMs is zero", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: 0,
        hotWarnMs: 0,
        caller: "test",
      }),
    ).rejects.toThrow(/acquireTimeoutMs must be a finite positive number/);
  });

  it("throws when acquireTimeoutMs is negative", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: -100,
        hotWarnMs: 0,
        caller: "test",
      }),
    ).rejects.toThrow(/acquireTimeoutMs must be a finite positive number/);
  });

  it("throws when acquireTimeoutMs is NaN", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: Number.NaN,
        hotWarnMs: 0,
        caller: "test",
      }),
    ).rejects.toThrow(/acquireTimeoutMs must be a finite positive number/);
  });

  it("throws when acquireTimeoutMs is Infinity", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: Number.POSITIVE_INFINITY,
        hotWarnMs: 0,
        caller: "test",
      }),
    ).rejects.toThrow(/acquireTimeoutMs must be a finite positive number/);
  });

  it("throws when hotWarnMs is negative", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: 1_000,
        hotWarnMs: -1,
        caller: "test",
      }),
    ).rejects.toThrow(/hotWarnMs must be a finite non-negative number/);
  });

  it("throws when hotWarnMs equals acquireTimeoutMs (warn would never fire)", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: 1_000,
        hotWarnMs: 1_000,
        caller: "test",
      }),
    ).rejects.toThrow(/hotWarnMs.*must be less than acquireTimeoutMs/);
  });

  it("throws when hotWarnMs exceeds acquireTimeoutMs", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => "x", {
        acquireTimeoutMs: 1_000,
        hotWarnMs: 2_000,
        caller: "test",
      }),
    ).rejects.toThrow(/hotWarnMs.*must be less than acquireTimeoutMs/);
  });

  it("accepts hotWarnMs === 0 (warn fires immediately when waiting)", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => "ok", {
      acquireTimeoutMs: 1_000,
      hotWarnMs: 0,
      caller: "test",
    });
    expect(result).toEqual({ kind: "ran", value: "ok" });
  });
});
