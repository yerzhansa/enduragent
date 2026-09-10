import { afterEach, describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../src/concurrency/retry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("retryWithBackoff", () => {
  it("resolves on first success — no sleep, no onRetry, no jitter draw", async () => {
    const randomSpy = vi.spyOn(Math, "random");
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      baseMs: 100,
      capMs: 1_000,
      shouldRetry: () => true,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it("retries then succeeds — onRetry fired once with attempt 1 and a full-jitter delay in [0, baseMs)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const onRetry = vi.fn();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      baseMs: 100,
      capMs: 1_000,
      shouldRetry: () => true,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0][0] as { attempt: number; delayMs: number };
    expect(info.attempt).toBe(1);
    expect(info.delayMs).toBeGreaterThanOrEqual(0);
    expect(info.delayMs).toBeLessThan(100);
  });

  it("exhausts attempts and rethrows the last error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRetry = vi.fn();
    const last = new Error("final");
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(last);

    await expect(
      retryWithBackoff(fn, {
        attempts: 3,
        baseMs: 10,
        capMs: 1_000,
        shouldRetry: () => true,
        onRetry,
      }),
    ).rejects.toBe(last);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("shouldRetry=false short-circuits — rethrows immediately, no onRetry, one call", async () => {
    const onRetry = vi.fn();
    const err = new Error("non-retryable");
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(
      retryWithBackoff(fn, {
        attempts: 5,
        baseMs: 10,
        capMs: 1_000,
        shouldRetry: () => false,
        onRetry,
      }),
    ).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("full jitter stays within [0, min(baseMs*2^(n-1), capMs)) and capMs bounds it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("always"));

    const baseMs = 100;
    const capMs = 250;
    await expect(
      retryWithBackoff(fn, {
        attempts: 4,
        baseMs,
        capMs,
        shouldRetry: () => true,
        onRetry,
      }),
    ).rejects.toThrow("always");

    // attempts 1..3 produce backoffs; intervals = min(100,250)=100, min(200,250)=200, min(400,250)=250.
    const delays = onRetry.mock.calls.map((c) => (c[0] as { delayMs: number }).delayMs);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeLessThan(100);
    expect(delays[1]).toBeLessThan(200);
    expect(delays[2]).toBeLessThan(250); // bounded by capMs, never the un-jittered interval (400)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(capMs);
    }
  });

  it("honored Retry-After is a lower bound; jittered sleep is never less than the hint", async () => {
    vi.useFakeTimers();
    const hint = 5_000;
    const onRetry = vi.fn();
    const makeFn = (): (() => Promise<string>) =>
      vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("429"))
        .mockResolvedValue("ok");
    const opts = (): Parameters<typeof retryWithBackoff>[1] => ({
      attempts: 2,
      baseMs: 100,
      capMs: 120_000,
      shouldRetry: () => true,
      retryAfterMs: () => hint,
      onRetry,
    });

    // Math.random -> 0: floor, delay equals the hint exactly.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const floorRun = retryWithBackoff(makeFn(), opts());
    await vi.advanceTimersByTimeAsync(hint + 1);
    await floorRun;
    const floorDelay = (onRetry.mock.calls[0][0] as { delayMs: number }).delayMs;
    expect(floorDelay).toBeGreaterThanOrEqual(hint);
    expect(floorDelay).toBe(hint);

    onRetry.mockReset();

    // Math.random -> 0.5: additive, strictly above the hint, never below.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const spreadRun = retryWithBackoff(makeFn(), opts());
    await vi.advanceTimersByTimeAsync(hint + 1_000);
    await spreadRun;
    const spreadDelay = (onRetry.mock.calls[0][0] as { delayMs: number }).delayMs;
    expect(spreadDelay).toBeGreaterThan(hint);
  });

  it("abortable sleep — abort during backoff resolves early and stops retrying", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("retryable"));

    const promise = retryWithBackoff(fn, {
      attempts: 5,
      baseMs: 1_000,
      capMs: 10_000,
      shouldRetry: () => true,
      signal: controller.signal,
    });
    // Avoid an unhandled-rejection warning while the loop is parked in backoff.
    const settled = promise.catch((e) => e);

    // Let the first attempt run and enter the backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(settled).resolves.toBeInstanceOf(Error);
    // The loop stopped after the abort — fn was not re-invoked.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
