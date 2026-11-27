import { describe, expect, it, vi } from "vitest";
import { createWallClockScheduler } from "../src/daemon/scheduler.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock(initialEpochMs: number) {
  let epochMs = initialEpochMs;
  let pending: { readonly callback: () => void; readonly delay: number } | undefined;
  const unref = vi.fn();
  const clearTimeout = vi.fn(() => {
    pending = undefined;
  });
  const setTimeout = vi.fn((callback: () => void, delay?: number) => {
    pending = { callback, delay: delay ?? 0 };
    return { unref } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  return {
    dependencies: {
      nowEpochMs: () => epochMs,
      setTimeout,
      clearTimeout: clearTimeout as unknown as typeof globalThis.clearTimeout,
    },
    setEpoch(value: number) {
      epochMs = value;
    },
    pending() {
      return pending;
    },
    fire() {
      const timer = pending;
      if (timer === undefined) throw new Error("no pending timer");
      pending = undefined;
      timer.callback();
    },
    unref,
    clearTimeout,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("wall-clock scheduler", () => {
  it("anchors 10:05 to 12:00 and recomputes 18:00 after a 12:07 completion", async () => {
    const cadenceMs = 6 * 60 * 60 * 1_000;
    const tenOhFive = Date.UTC(2026, 6, 18, 10, 5);
    const clock = fakeClock(tenOhFive);
    const run = deferred<void>();
    const execute = vi.fn(() => run.promise);
    const scheduler = createWallClockScheduler({
      cadenceMs,
      run: execute,
      dependencies: clock.dependencies,
    });

    scheduler.start();
    scheduler.start();
    expect(clock.unref).toHaveBeenCalledTimes(1);

    clock.setEpoch(Date.UTC(2026, 6, 18, 11, 59));
    clock.fire();
    await settle();
    expect(execute).not.toHaveBeenCalled();

    clock.setEpoch(Date.UTC(2026, 6, 18, 12));
    clock.fire();
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBeUndefined();

    clock.setEpoch(Date.UTC(2026, 6, 18, 12, 7));
    run.resolve();
    await settle();
    clock.setEpoch(Date.UTC(2026, 6, 18, 17, 59));
    clock.fire();
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);

    clock.setEpoch(Date.UTC(2026, 6, 18, 18));
    clock.fire();
    await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("skips elapsed boundaries, never overlaps, and continues after rejection", async () => {
    const clock = fakeClock(1);
    const first = deferred<void>();
    const failure = new Error("refresh failed");
    const onError = vi.fn();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const scheduler = createWallClockScheduler({
      cadenceMs: 100,
      run,
      onError,
      dependencies: clock.dependencies,
    });

    scheduler.start();
    clock.setEpoch(100);
    clock.fire();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    clock.setEpoch(450);
    first.resolve();
    await settle();
    expect(clock.pending()?.delay).toBe(50);

    clock.setEpoch(500);
    clock.fire();
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(clock.pending()?.delay).toBe(100);
    await scheduler.close();
  });

  it("drains an active run and closes idempotently without rescheduling", async () => {
    const clock = fakeClock(0);
    const active = deferred<void>();
    const scheduler = createWallClockScheduler({
      cadenceMs: 100,
      run: () => active.promise,
      dependencies: clock.dependencies,
    });

    scheduler.start();
    clock.setEpoch(100);
    clock.fire();
    await settle();
    let closed = false;
    const close = scheduler.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    active.resolve();
    await close;
    await scheduler.close();
    expect(clock.pending()).toBeUndefined();
  });

  it("rejects invalid cadence values", () => {
    for (const cadenceMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createWallClockScheduler({ cadenceMs, run: async () => {} })).toThrow(
        RangeError,
      );
    }
  });
});
