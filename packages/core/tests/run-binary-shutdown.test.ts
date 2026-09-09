import { describe, it, expect, vi, type Mock } from "vitest";
import { makeBotShutdown } from "../src/run-binary.js";

interface Recorded {
  stop: Mock<() => Promise<void>>;
  drainPending: Mock<() => Promise<void>>;
  markCleanShutdown: Mock<(opts: { dataDir: string }) => void>;
  exit: Mock<(code: number) => void>;
}

function makeDeps(overrides?: {
  stop?: () => Promise<void>;
  drainPending?: () => Promise<void>;
  drainTimeoutMs?: number;
}): { shutdown: () => Promise<void>; rec: Recorded } {
  const rec: Recorded = {
    stop: vi.fn<() => Promise<void>>(overrides?.stop ?? (async () => undefined)),
    drainPending: vi.fn<() => Promise<void>>(overrides?.drainPending ?? (async () => undefined)),
    markCleanShutdown: vi.fn<(opts: { dataDir: string }) => void>(),
    exit: vi.fn<(code: number) => void>(),
  };
  const shutdown = makeBotShutdown({
    stop: rec.stop,
    drainPending: rec.drainPending,
    dataDir: "/tmp/cc-shutdown-test",
    markCleanShutdown: rec.markCleanShutdown,
    exit: rec.exit,
    drainTimeoutMs: overrides?.drainTimeoutMs,
    log: () => {},
  });
  return { shutdown, rec };
}

describe("makeBotShutdown — graceful shutdown ordering", () => {
  it("halts updates, drains in-flight turns, marks clean, then exits — in order", async () => {
    const { shutdown, rec } = makeDeps();

    await shutdown();

    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(rec.drainPending).toHaveBeenCalledTimes(1);
    expect(rec.markCleanShutdown).toHaveBeenCalledWith({ dataDir: "/tmp/cc-shutdown-test" });
    expect(rec.exit).toHaveBeenCalledWith(0);

    // stop before drain before markCleanShutdown before exit.
    expect(rec.stop.mock.invocationCallOrder[0]).toBeLessThan(
      rec.drainPending.mock.invocationCallOrder[0],
    );
    expect(rec.drainPending.mock.invocationCallOrder[0]).toBeLessThan(
      rec.markCleanShutdown.mock.invocationCallOrder[0],
    );
    expect(rec.markCleanShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      rec.exit.mock.invocationCallOrder[0],
    );
  });

  it("re-entry from a second signal is a no-op (teardown runs once)", async () => {
    const { shutdown, rec } = makeDeps();

    await Promise.all([shutdown(), shutdown()]);
    await shutdown();

    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(rec.drainPending).toHaveBeenCalledTimes(1);
    expect(rec.markCleanShutdown).toHaveBeenCalledTimes(1);
    expect(rec.exit).toHaveBeenCalledTimes(1);
  });

  it("a hung drain still exits via the bounded timeout (never wedges)", async () => {
    vi.useFakeTimers();
    try {
      const { shutdown, rec } = makeDeps({
        drainPending: () => new Promise<void>(() => {}),
        drainTimeoutMs: 10_000,
      });

      const done = shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(rec.stop).toHaveBeenCalledTimes(1);
      expect(rec.markCleanShutdown).toHaveBeenCalledTimes(1);
      expect(rec.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throw in stop() still reaches process.exit (shutdown never hangs)", async () => {
    const { shutdown, rec } = makeDeps({
      stop: async () => {
        throw Object.assign(new Error("synthetic-stop-secret"), { code: "EIO" });
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await shutdown();

    expect(rec.exit).toHaveBeenCalledWith(0);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("synthetic-stop-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("EIO");
    errorSpy.mockRestore();
  });

  it("stops the selected timer, closes Reference, then closes prepared composition exactly once", async () => {
    const order: string[] = [];
    const shutdown = makeBotShutdown({
      stop: async () => {
        order.push("stop");
      },
      drainPending: async () => {
        order.push("drain");
      },
      dataDir: "synthetic-data",
      stopTimer: () => {
        order.push("timer");
      },
      closeReference: () => {
        order.push("reference");
      },
      closePrepared: async () => {
        order.push("prepared");
      },
      markCleanShutdown: () => {
        order.push("clean");
      },
      exit: () => {
        order.push("exit");
      },
      log: () => {},
    });
    await shutdown();
    await shutdown();
    expect(order).toEqual(["stop", "drain", "timer", "reference", "prepared", "clean", "exit"]);
  });
});
