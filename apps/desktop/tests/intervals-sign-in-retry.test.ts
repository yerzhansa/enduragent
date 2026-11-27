import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialRuntimeRefusal } from "../src/main/credential-vault.js";
import { createIntervalsSignInRetry } from "../src/main/intervals-sign-in-retry.js";

type Outcome =
  | "active"
  | "ownership-unavailable"
  | "credential-required"
  | "coach-not-ready"
  | "vault-failed";

function subject(outcomes: Outcome[] = []) {
  let online = true;
  const powerMonitor = new EventEmitter();
  const shutdown = new AbortController();
  const attempts: number[] = [];
  const startedAt = Date.now();
  const reapply = async (outcome: Outcome) => {
    if (outcome === "active") return "active" as const;
    if (outcome === "coach-not-ready") throw new TypeError();
    throw outcome === "credential-required"
      ? new CredentialRuntimeRefusal("credential-required")
      : new CredentialRuntimeRefusal("ownership-unavailable");
  };
  const vault = {
    retryFailed: vi.fn(async () => {
      attempts.push(Date.now() - startedAt);
      const outcome = outcomes.shift() ?? "ownership-unavailable";
      if (outcome === "vault-failed") throw new Error("synthetic vault failure");
      await retry.observe("intervals-icu", () => reapply(outcome)).catch(() => undefined);
    }),
  };
  const retry = createIntervalsSignInRetry(
    { vault, net: { isOnline: () => online }, powerMonitor },
    shutdown.signal,
  );
  return {
    retry,
    vault,
    attempts,
    powerMonitor,
    shutdown,
    setOnline(next: boolean) {
      online = next;
    },
    async launchRefused(reason: Outcome = "ownership-unavailable") {
      await expect(retry.observe("intervals-icu", () => reapply(reason))).rejects.toBeInstanceOf(
        CredentialRuntimeRefusal,
      );
    },
  };
}

const MINUTE = 60_000;

describe("intervals.icu sign-in retry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes the first attempt 15 seconds after the network refusal", async () => {
    const test = subject(["active"]);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.attempts).toEqual([15_000]);
  });

  it("re-checks every 15 seconds while offline without spending an attempt", async () => {
    const test = subject(["ownership-unavailable", "active"]);
    test.setOnline(false);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();

    test.setOnline(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.attempts).toEqual([10 * MINUTE + 15_000]);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(test.attempts).toEqual([10 * MINUTE + 15_000, 11 * MINUTE + 15_000]);
  });

  it("stops after an attempt activates the sign-in", async () => {
    const test = subject(["active"]);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.attempts).toEqual([15_000]);
  });

  it("keeps the schedule when an attempt finds the coach not ready", async () => {
    const test = subject(["coach-not-ready", "active"]);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.attempts).toEqual([15_000, 15_000 + MINUTE]);
  });

  it("stops after a refusal that is not about the network", async () => {
    const test = subject(["credential-required"]);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.attempts).toEqual([15_000]);
  });

  it("does not schedule anything when the first refusal is not about the network", async () => {
    const test = subject();
    await test.launchRefused("credential-required");

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();
  });

  it("backs off 15 s, 1, 2, 5, 10 and 15 min, then keeps trying every 15 min", async () => {
    const test = subject();
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(63 * MINUTE);
    expect(test.attempts).toEqual(
      [
        15_000,
        15_000 + MINUTE,
        15_000 + 3 * MINUTE,
        15_000 + 8 * MINUTE,
        15_000 + 18 * MINUTE,
        15_000 + 33 * MINUTE,
        15_000 + 48 * MINUTE,
        15_000 + 63 * MINUTE,
      ].filter((at) => at <= 63 * MINUTE),
    );
  });

  it("counts a failed vault retry as a spent attempt and keeps going", async () => {
    const test = subject(["vault-failed", "active"]);
    await test.launchRefused();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.attempts).toEqual([15_000, 15_000 + MINUTE]);
  });

  it("restarts the schedule when the Mac wakes", async () => {
    const test = subject();
    await test.launchRefused();
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(test.attempts).toHaveLength(6);

    test.powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(test.attempts).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.attempts).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(test.attempts).toHaveLength(8);
  });

  it("restarts a pending schedule from the first delay when the Mac wakes", async () => {
    const test = subject();
    await test.launchRefused();
    await vi.advanceTimersByTimeAsync(15_000 + 3 * MINUTE);
    expect(test.attempts).toHaveLength(3);

    test.powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.attempts).toHaveLength(4);
    expect(test.attempts.at(-1)).toBe(30_000 + 3 * MINUTE);
  });

  it("does nothing on wake when no sign-in was refused", async () => {
    const test = subject();
    test.powerMonitor.emit("resume");

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();
  });

  it("closes on shutdown and ignores later wakes", async () => {
    const test = subject();
    await test.launchRefused();
    test.shutdown.abort();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    test.powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();
    expect(test.powerMonitor.listenerCount("resume")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing for a refusal that arrives after shutdown", async () => {
    const test = subject();
    test.shutdown.abort();
    await test.launchRefused();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes other credential slots through untouched", async () => {
    const test = subject();
    await expect(
      test.retry.observe("anthropic", async () => {
        throw new CredentialRuntimeRefusal("ownership-unavailable");
      }),
    ).rejects.toBeInstanceOf(CredentialRuntimeRefusal);
    await expect(test.retry.observe("anthropic", async () => "active" as const)).resolves.toBe(
      "active",
    );

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(test.vault.retryFailed).not.toHaveBeenCalled();
  });
});
