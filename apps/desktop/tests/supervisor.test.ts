import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPreferredSystemLanguages: () => ["en-US"] },
  utilityProcess: { fork: vi.fn() },
}));

import type {
  DesktopDaemonResolution,
  ResolveDesktopDaemonInput,
} from "@enduragent/coach/enduragent";
import {
  UTILITY_EXIT_TIMEOUT_MS,
  UTILITY_FORCE_EXIT_TIMEOUT_MS,
  UTILITY_SPAWN_TIMEOUT_MS,
} from "../src/main/constants.js";
import { DesktopDaemonLifecycle } from "../src/main/daemon-lifecycle.js";
import {
  DesktopDaemonSupervisor,
  forkAppSupervisedDaemon,
  terminateOwnedUtilityProcess,
} from "../src/main/supervisor.js";

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 91;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => {
    this.emit("exit", 1);
    return true;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

function capability(fill: string, suffix = "A"): string {
  return `${fill.repeat(42)}${suffix}`;
}

function connected(
  port: number,
  exit: ReturnType<typeof deferred<{ readonly exitCode: number | null }>>,
) {
  const close = vi.fn(async () => {});
  let alive = true;
  void exit.promise.then(() => {
    alive = false;
  });
  return {
    status: "connected" as const,
    url: `ws://127.0.0.1:${port}/rpc` as const,
    token: "s".repeat(43),
    athleteHome: "/synthetic/athlete",
    rendererCapability: capability("r"),
    owner: "app-supervised" as const,
    supervision: "app-supervised" as const,
    exited: exit.promise,
    isAlive: () => alive,
    close,
  };
}

afterEach(() => vi.useRealTimers());

describe("desktop main supervisor", () => {
  it("binds the exact utility start frame to the supervisor's desktop app version", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const exit = deferred<{ readonly exitCode: number | null }>();
    const home = {
      root: "/synthetic/athlete",
      storeDir: "/synthetic/athlete/store",
      archiveDir: "/synthetic/athlete/archive",
      configDir: "/synthetic/athlete/config",
    };
    const resolveDaemon = vi.fn(async (input: ResolveDesktopDaemonInput) => {
      const started = input.startAppSupervisedDaemon({ home });
      child.emit("spawn");
      await started;
      return connected(45_001, exit);
    });
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "2026.8.0",
        signal: new AbortController().signal,
      },
      "/synthetic/daemon-utility.js",
      resolveDaemon,
    );

    await supervisor.resolve();

    expect(child.postMessage).toHaveBeenCalledWith({
      type: "start",
      preferredLanguages: ["en-US"],
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
  });

  it("deduplicates concurrent resolution and clears only after owned close", async () => {
    const close = vi.fn(async () => {});
    const connected: DesktopDaemonResolution = {
      status: "connected",
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "app-supervised",
      supervision: "app-supervised",
      exited: new Promise(() => {}),
      isAlive: () => true,
      close,
    };
    const resolveDaemon = vi.fn(async () => connected);
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
      },
      "/synthetic/daemon-utility.js",
      resolveDaemon,
    );
    const first = supervisor.resolve();
    const second = supervisor.resolve();
    expect(first).toBe(second);
    const resolution = await first;
    expect(resolveDaemon).toHaveBeenCalledTimes(1);
    if (resolution.status === "connected")
      await Promise.all([resolution.close(), resolution.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    await supervisor.resolve();
    expect(resolveDaemon).toHaveBeenCalledTimes(2);
  });

  it("accepts a live app-supervised Windows resolution", async () => {
    const exit = deferred<{ readonly exitCode: number | null }>();
    const resolution = connected(45_001, exit);
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "C:\\Program Files\\Enduragent\\Enduragent.exe",
        appVersion: "0.1.0",
        platform: "win32",
        signal: new AbortController().signal,
      },
      "C:\\Program Files\\Enduragent\\daemon-utility.js",
      vi.fn(async () => resolution),
    );

    await expect(supervisor.resolve()).resolves.toMatchObject({
      status: "connected",
      supervision: "app-supervised",
    });
    expect(resolution.close).not.toHaveBeenCalled();
  });

  it("refuses a Windows daemon without a current app child handle", async () => {
    const close = vi.fn(async () => {});
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "C:\\synthetic\\athlete",
      rendererCapability: capability("r"),
      owner: "app-supervised" as const,
      supervision: "attached" as const,
      close,
      kill: vi.fn(),
      hardStop: vi.fn(),
    };
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "C:\\Program Files\\Enduragent\\Enduragent.exe",
        appVersion: "0.1.0",
        platform: "win32",
        signal: new AbortController().signal,
      },
      "C:\\Program Files\\Enduragent\\daemon-utility.js",
      vi.fn(async () => attached),
    );

    await expect(supervisor.resolve()).resolves.toEqual({
      status: "refused",
      exitCode: 3,
      classification: "contention-family",
      cause: "contention",
      retryable: false,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(attached.kill).not.toHaveBeenCalled();
    expect(attached.hardStop).not.toHaveBeenCalled();
  });

  it("refuses a dead Windows app child instead of claiming ownership", async () => {
    const stopOwnedChild = vi.fn();
    const close = vi.fn(async () => stopOwnedChild());
    const resolution = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "C:\\synthetic\\athlete",
      rendererCapability: capability("r"),
      owner: "app-supervised" as const,
      supervision: "app-supervised" as const,
      exited: Promise.resolve({ exitCode: 1 }),
      isAlive: () => false,
      close,
      kill: vi.fn(),
      hardStop: vi.fn(),
    };
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "C:\\Program Files\\Enduragent\\Enduragent.exe",
        appVersion: "0.1.0",
        platform: "win32",
        signal: new AbortController().signal,
      },
      "C:\\Program Files\\Enduragent\\daemon-utility.js",
      vi.fn(async () => resolution),
    );

    await expect(supervisor.resolve()).resolves.toMatchObject({
      status: "refused",
      cause: "contention",
      retryable: false,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(stopOwnedChild).toHaveBeenCalledOnce();
    expect(resolution.kill).not.toHaveBeenCalled();
    expect(resolution.hardStop).not.toHaveBeenCalled();
  });

  it("uses one closed path-free stage for Windows ownership refusal at startup and recovery", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source.match(/desktop-daemon-ownership-refusal unowned\\n/g)).toHaveLength(2);
    expect(source).not.toContain("desktop-daemon-ownership-refusal ${");
  });

  it("propagates an active resolution close rejection", async () => {
    const failure = new Error("synthetic close rejection");
    const resolution: DesktopDaemonResolution = {
      status: "connected",
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "app-supervised",
      supervision: "app-supervised",
      exited: new Promise(() => {}),
      isAlive: () => true,
      close: vi.fn(async () => {
        throw failure;
      }),
    };
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "2026.7.23",
        signal: new AbortController().signal,
      },
      "/synthetic/daemon-utility.js",
      vi.fn(async () => resolution),
    );
    await supervisor.resolve();

    await expect(supervisor.close()).rejects.toBe(failure);
  });

  it("rejects a close that exceeds the bounded supervisor deadline", async () => {
    vi.useFakeTimers();
    const resolution: DesktopDaemonResolution = {
      status: "connected",
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "app-supervised",
      supervision: "app-supervised",
      exited: new Promise(() => {}),
      isAlive: () => true,
      close: vi.fn(() => new Promise<void>(() => {})),
    };
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "2026.7.23",
        signal: new AbortController().signal,
      },
      "/synthetic/daemon-utility.js",
      vi.fn(async () => resolution),
    );
    await supervisor.resolve();
    const closing = supervisor.close();
    const rejected = expect(closing).rejects.toThrow(
      "desktop daemon supervisor close deadline exceeded",
    );

    await vi.advanceTimersByTimeAsync(UTILITY_EXIT_TIMEOUT_MS + UTILITY_FORCE_EXIT_TIMEOUT_MS * 2);
    await rejected;
  });

  it("starts over the closed control protocol and acknowledges one exact terminal frame", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
      handoffCapability: "h".repeat(43),
    });
    child.emit("spawn");
    const handle = await started;
    expect(handle.pid).toBe(91);
    expect(fork).toHaveBeenCalledWith(
      "/synthetic/daemon-utility.js",
      [],
      expect.objectContaining({
        serviceName: "enduragent serve",
        stdio: "ignore",
      }),
    );
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "start",
      preferredLanguages: ["en-US"],
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
      handoffCapability: "h".repeat(43),
    });
    child.emit("message", { type: "terminal", exitCode: 0 });
    expect(child.postMessage).toHaveBeenCalledWith({ type: "terminal-ack" });
    const stopping = handle.stop();
    expect(child.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    child.emit("exit", 0);
    await stopping;
    await expect(handle.exited).resolves.toEqual({ exitCode: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("ignores terminal frames received before posting the validated start frame", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });

    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "unreadable" });
    expect(child.postMessage).not.toHaveBeenCalledWith({ type: "terminal-ack" });
    child.emit("spawn");
    const handle = await started;
    child.postMessage.mockClear();
    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "malformed" });
    child.emit("exit", 1);

    expect(child.postMessage).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledWith({ type: "terminal-ack" });
    await expect(handle.exited).resolves.toEqual({
      exitCode: 1,
      readinessFailure: "malformed",
    });
  });

  it("lets the first valid terminal frame own the claim and ignores typed duplicates", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
    child.emit("spawn");
    const handle = await started;
    child.postMessage.mockClear();

    child.emit("message", { type: "terminal", exitCode: 1 });
    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "unreadable" });
    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "malformed" });
    child.emit("exit", 1);

    expect(child.postMessage).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledWith({ type: "terminal-ack" });
    await expect(handle.exited).resolves.toEqual({ exitCode: 1 });
  });

  it("exposes only the first typed terminal claim when its code exactly matches the exit", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
    child.emit("spawn");
    const handle = await started;
    child.postMessage.mockClear();

    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "unreadable" });
    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "malformed" });
    child.emit("exit", 1);

    expect(child.postMessage).toHaveBeenCalledOnce();
    await expect(handle.exited).resolves.toEqual({
      exitCode: 1,
      readinessFailure: "unreadable",
    });
  });

  it.each([
    ["a mismatched exit code", 0],
    ["a signal exit", null],
  ] as const)("does not expose terminal metadata for %s", async (_case, actualExit) => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
    child.emit("spawn");
    const handle = await started;
    child.postMessage.mockClear();

    child.emit("message", { type: "terminal", exitCode: 1, readinessFailure: "unreadable" });
    child.emit("exit", actualExit);

    expect(child.postMessage).toHaveBeenCalledOnce();
    await expect(handle.exited).resolves.toEqual({ exitCode: actualExit });
  });

  it("rejects invalid terminal metadata without acknowledgement or exit exposure", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
    child.emit("spawn");
    const handle = await started;
    child.postMessage.mockClear();

    child.emit("message", {
      type: "terminal",
      exitCode: 1,
      readinessFailure: "malformed",
      error: "synthetic-private-detail",
    });
    expect(child.postMessage).not.toHaveBeenCalled();
    child.emit("exit", 1);
    await expect(handle.exited).resolves.toEqual({ exitCode: 1 });
  });

  it("uses one bounded kill fallback and only succeeds after observed exit", async () => {
    vi.useFakeTimers();
    const exit = deferred<{ readonly exitCode: number | null }>();
    let exited = false;
    const child = { postMessage: vi.fn(), kill: vi.fn(() => false) };
    const hardStop = vi.fn();
    const stopping = terminateOwnedUtilityProcess({
      child,
      pid: 91,
      exited: exit.promise,
      hasExited: () => exited,
      hardStop,
    });
    const settled = vi.fn();
    void stopping.then(settled);

    await vi.advanceTimersByTimeAsync(UTILITY_EXIT_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(hardStop).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    exited = true;
    exit.resolve({ exitCode: 0 });
    await stopping;
    expect(settled).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(hardStop).not.toHaveBeenCalled();
  });

  it("bounds startup when a utility child emits neither spawn nor exit", async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      appVersion: "2026.8.0",
    });
    const rejected = expect(started).rejects.toMatchObject({
      name: "AppSupervisedDaemonStartError",
      cause: "spawn-failed",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("skips an owned hard stop when exit is observed in the force-wait reap gap", async () => {
    vi.useFakeTimers();
    const exit = deferred<{ readonly exitCode: number | null }>();
    let exited = false;
    const child = { postMessage: vi.fn(), kill: vi.fn(() => false) };
    const hardStop = vi.fn();
    const stopping = terminateOwnedUtilityProcess({
      child,
      get pid() {
        exited = true;
        return 91;
      },
      exited: exit.promise,
      hasExited: () => exited,
      hardStop,
    });
    const settled = vi.fn();
    void stopping.then(settled);

    await vi.advanceTimersByTimeAsync(UTILITY_EXIT_TIMEOUT_MS + UTILITY_FORCE_EXIT_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(hardStop).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    exit.resolve({ exitCode: 0 });
    await stopping;
    expect(settled).toHaveBeenCalledOnce();
    expect(hardStop).not.toHaveBeenCalled();
  });

  it("skips an unacknowledged hard stop when exit is observed in the force-wait reap gap", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(() => false),
    });
    Object.defineProperty(child, "pid", {
      get: vi.fn(() => {
        child.emit("exit", 0);
        return 91;
      }),
    });
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const hardStop = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const started = forkAppSupervisedDaemon({
        utilityEntry: "/synthetic/daemon-utility.js",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0",
      });
      const rejected = expect(started).rejects.toMatchObject({
        name: "AppSupervisedDaemonStartError",
        cause: "spawn-failed",
      });

      await vi.advanceTimersByTimeAsync(UTILITY_SPAWN_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(UTILITY_FORCE_EXIT_TIMEOUT_MS);
      await rejected;
      expect(hardStop).not.toHaveBeenCalled();
    } finally {
      hardStop.mockRestore();
    }
  });

  it("keeps the Darwin default hard-stop ladder and stage-coded deadline unchanged", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const child = {
      postMessage: vi.fn(() => order.push("shutdown")),
      kill: vi.fn(() => {
        order.push("kill");
        return false;
      }),
    };
    const hardStop = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      order.push(`hard-stop:${pid}:${String(signal)}`);
      return true;
    });
    try {
      const stopping = terminateOwnedUtilityProcess({
        child,
        pid: 91,
        exited: new Promise(() => {}),
        hasExited: () => false,
      });
      const settled = vi.fn();
      void stopping.then(settled, settled);
      const rejected = expect(stopping).rejects.toThrowError(
        /^utility process termination deadline exceeded$/,
      );

      expect(UTILITY_EXIT_TIMEOUT_MS).toBe(5_000);
      expect(UTILITY_FORCE_EXIT_TIMEOUT_MS).toBe(2_000);
      expect(order).toEqual(["shutdown"]);
      await vi.advanceTimersByTimeAsync(UTILITY_EXIT_TIMEOUT_MS - 1);
      expect(order).toEqual(["shutdown"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(order).toEqual(["shutdown", "kill"]);
      await vi.advanceTimersByTimeAsync(UTILITY_FORCE_EXIT_TIMEOUT_MS - 1);
      expect(order).toEqual(["shutdown", "kill"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(order).toEqual(["shutdown", "kill", "hard-stop:91:SIGKILL"]);
      expect(hardStop.mock.calls).toEqual([[91, "SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(UTILITY_FORCE_EXIT_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      hardStop.mockRestore();
    }
  });

  it("bounds a refused utility kill and uses only the validated owned pid for hard stop", async () => {
    vi.useFakeTimers();
    let resolveExit!: (value: { readonly exitCode: number | null }) => void;
    let exited = false;
    const exit = new Promise<{ readonly exitCode: number | null }>((resolve) => {
      resolveExit = (value) => {
        exited = true;
        resolve(value);
      };
    });
    const child = { pid: 777, postMessage: vi.fn(), kill: vi.fn(() => false) };
    const hardStop = vi.fn((pid: number) => resolveExit({ exitCode: pid === 91 ? 137 : 1 }));
    const stopping = terminateOwnedUtilityProcess({
      child,
      pid: 91,
      exited: exit,
      hasExited: () => exited,
      hardStop,
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await stopping;
    expect(child.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(hardStop).toHaveBeenCalledTimes(1);
    expect(hardStop.mock.calls).toEqual([[91]]);
  });

  it("restarts after an unexpected child exit and publishes the new live coordinates", async () => {
    let now = 0;
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const secondExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const second = connected(45_002, secondExit);
    const supervisor = {
      resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
        budget.remainingAttempts -= 1;
        return second;
      }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, first, {
      delay: async (ms: number) => {
        now += ms;
      },
      monotonicNow: () => now,
      onReady,
    });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(1);
    expect(runtime.connection().url).toBe("ws://127.0.0.1:45002/rpc");
    expect(runtime.currentPort()).toBe(45_002);
    expect(runtime.connection().generation).toBe(2);
    expect(runtime.connection().supervision).toBe("app-supervised");
    await expect(runtime.recover(1)).resolves.toMatchObject({ generation: 2 });
    expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(1);
  });

  it("prepares the successor coordinates before publishing them", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const successor = connected(45_002, deferred<{ readonly exitCode: number | null }>());
    const order: string[] = [];
    const supervisor = {
      resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
        budget.remainingAttempts -= 1;
        return successor;
      }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    let runtime!: DesktopDaemonLifecycle;
    let activeGeneration = 1;
    let preparedGeneration: number | undefined;
    const prepareReady = vi.fn(async ({ connection }: { readonly connection: unknown }) => {
      order.push("prepare");
      expect(connection).toMatchObject({
        url: "ws://127.0.0.1:45002/rpc",
        token: "s".repeat(43),
        generation: 2,
      });
      expect(() => runtime.connection()).toThrow("desktop daemon connection unavailable");
      expect(activeGeneration).toBe(1);
      preparedGeneration = 2;
    });
    runtime = new DesktopDaemonLifecycle(supervisor, first, {
      delay: async () => {},
      prepareReady,
      onReady: ({ current }) => {
        order.push("ready");
        expect(preparedGeneration).toBe(current.generation);
        activeGeneration = current.generation;
      },
    });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(runtime.connection().generation).toBe(2));
    expect(prepareReady).toHaveBeenCalledTimes(1);
    expect(activeGeneration).toBe(2);
    expect(order).toEqual(["prepare", "ready"]);
  });

  it("does not publish a successor when prepared credential replay fails", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const successor = connected(45_002, deferred<{ readonly exitCode: number | null }>());
    const supervisor = {
      resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
        budget.remainingAttempts -= 1;
        return successor;
      }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, first, {
      delay: async () => {},
      prepareReady: async () => {
        throw new Error("synthetic Telegram replay failure");
      },
      onReady,
    });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });

    await vi.waitFor(() =>
      expect(runtime.snapshot()).toEqual({
        status: "terminal",
        generation: 1,
        cause: "unavailable",
      }),
    );
    expect(successor.close).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(() => runtime.connection()).toThrow("desktop daemon connection unavailable");
  });

  it("does not restart when shutdown requested the child exit", async () => {
    const exit = deferred<{ readonly exitCode: number | null }>();
    const initial = connected(45_001, exit);
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {
        exit.resolve({ exitCode: 0 });
        await initial.close();
      }),
    };
    const onReady = vi.fn();
    const onTransition = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, initial, {
      delay: async () => {},
      onReady,
      onTransition,
    });
    runtime.start();
    await runtime.close();
    await Promise.resolve();
    expect(supervisor.resolveForRecovery).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onTransition).toHaveBeenLastCalledWith({ status: "closing", generation: 1 });
  });

  it("propagates a lifecycle resolver close rejection", async () => {
    const failure = new Error("synthetic lifecycle close rejection");
    const resolver = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {
        throw failure;
      }),
    };
    const runtime = new DesktopDaemonLifecycle(
      resolver,
      connected(45_001, deferred<{ readonly exitCode: number | null }>()),
    );

    await expect(runtime.close()).rejects.toBe(failure);
  });

  it("rejects a lifecycle close that exceeds its bounded deadline", async () => {
    vi.useFakeTimers();
    const resolver = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(),
      close: vi.fn(() => new Promise<void>(() => {})),
    };
    const runtime = new DesktopDaemonLifecycle(
      resolver,
      connected(45_001, deferred<{ readonly exitCode: number | null }>()),
    );
    const closing = runtime.close();
    const rejected = expect(closing).rejects.toThrow(
      "desktop daemon lifecycle close deadline exceeded",
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });

  it("stops after three quick restart attempts when children keep dying", async () => {
    let now = 0;
    const delays: number[] = [];
    const exits = Array.from({ length: 4 }, () => deferred<{ readonly exitCode: number | null }>());
    const generations = exits.map((exit, index) => connected(45_001 + index, exit));
    const supervisor = {
      resolveForRecovery: vi
        .fn()
        .mockResolvedValueOnce(generations[1])
        .mockResolvedValueOnce(generations[2])
        .mockResolvedValueOnce(generations[3]),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const onTransition = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, generations[0]!, {
      delay: async (ms: number) => {
        delays.push(ms);
        now += ms;
      },
      monotonicNow: () => now,
      onReady,
      onTransition,
    });
    runtime.start();
    for (let index = 0; index < 3; index += 1) {
      exits[index]!.resolve({ exitCode: 1 });
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(index + 1));
    }
    exits[3]!.resolve({ exitCode: 1 });
    await vi.waitFor(() =>
      expect(onTransition).toHaveBeenCalledWith({
        status: "terminal",
        generation: 4,
        cause: "restart-exhausted",
      }),
    );
    expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(3);
    expect(onReady).toHaveBeenCalledTimes(3);
    expect(delays.filter((value) => value < 5_000)).toEqual([500, 1_000, 2_000]);
    expect(() => runtime.connection()).toThrow("desktop daemon connection unavailable");
  });

  it("returns current coordinates for stale and healthy current-generation hints", async () => {
    const exit = deferred<{ readonly exitCode: number | null }>();
    const initial = connected(45_001, exit);
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, initial);
    runtime.start();
    await expect(runtime.recover(1)).resolves.toMatchObject({ generation: 1 });
    await expect(runtime.recover(1)).resolves.toMatchObject({ generation: 1 });
    expect(supervisor.resolveForRecovery).not.toHaveBeenCalled();
    expect(initial.close).not.toHaveBeenCalled();
  });

  it("coalesces current-generation recovery and closes a successor that arrives after close", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const successorExit = deferred<{ readonly exitCode: number | null }>();
    const successor = connected(45_002, successorExit);
    const resolution = deferred<ReturnType<typeof connected>>();
    const supervisor = {
      resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
        budget.remainingAttempts -= 1;
        return resolution.promise;
      }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, first, {
      delay: async () => {},
      onReady,
    });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(1));
    const recovery = runtime.recover(1);
    await runtime.close();
    resolution.resolve(successor);
    await expect(recovery).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(successor.close).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toEqual({ status: "closing", generation: 1 });
  });

  it("joins a newer in-flight recovery when a stale generation reports failure", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const secondExit = deferred<{ readonly exitCode: number | null }>();
    const thirdExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const second = connected(45_002, secondExit);
    const third = connected(45_003, thirdExit);
    const pendingThird = deferred<ReturnType<typeof connected>>();
    const supervisor = {
      resolveForRecovery: vi
        .fn()
        .mockImplementationOnce(async (budget: { remainingAttempts: number }) => {
          budget.remainingAttempts -= 1;
          return second;
        })
        .mockImplementationOnce(async (budget: { remainingAttempts: number }) => {
          budget.remainingAttempts -= 1;
          return pendingThird.promise;
        }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, first, { delay: async () => {} });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(runtime.connection().generation).toBe(2));
    secondExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(2));
    const currentRecovery = runtime.recover(2);
    const staleRecovery = runtime.recover(1);
    expect(staleRecovery).toBe(currentRecovery);
    pendingThird.resolve(third);
    await expect(staleRecovery).resolves.toMatchObject({ generation: 3 });
    expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(2);
  });

  it("rediscovers an attached replacement without closing the attached peer", async () => {
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "service-managed" as const,
      supervision: "attached" as const,
      close: vi.fn(async () => {}),
    };
    const successor = {
      ...attached,
      url: "ws://127.0.0.1:45002/rpc" as const,
      token: "t".repeat(43),
      close: vi.fn(async () => {}),
    };
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(async () => successor),
      close: vi.fn(async () => {}),
    };
    const replayTelegramCredential = vi.fn(async () => {});
    let activeGeneration = 1;
    const runtime = new DesktopDaemonLifecycle(supervisor, attached, {
      prepareReady: async ({ connection }) => {
        if (connection.supervision === "app-supervised") {
          await replayTelegramCredential();
        }
      },
      onReady: ({ current }) => {
        activeGeneration = current.generation;
      },
    });
    runtime.start();
    await expect(runtime.recover(1)).resolves.toMatchObject({
      url: "ws://127.0.0.1:45002/rpc",
      generation: 2,
      supervision: "attached",
    });
    expect(attached.close).not.toHaveBeenCalled();
    expect(supervisor.resolveForRecovery).not.toHaveBeenCalled();
    expect(replayTelegramCredential).not.toHaveBeenCalled();
    expect(activeGeneration).toBe(2);
  });

  it("treats a changed token at the same attached URL as a new generation", async () => {
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "service-managed" as const,
      supervision: "attached" as const,
      close: vi.fn(async () => {}),
    };
    const successor = { ...attached, token: "t".repeat(43), close: vi.fn(async () => {}) };
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(async () => successor),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, attached);
    runtime.start();
    await expect(runtime.recover(1)).resolves.toMatchObject({
      url: attached.url,
      token: "t".repeat(43),
      generation: 2,
    });
    expect(attached.close).not.toHaveBeenCalled();
  });

  it("treats a changed renderer capability as a new attached generation", async () => {
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "service-managed" as const,
      supervision: "attached" as const,
      close: vi.fn(async () => {}),
    };
    const successor = {
      ...attached,
      rendererCapability: capability("q"),
      close: vi.fn(async () => {}),
    };
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(async () => successor),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, attached);
    runtime.start();

    await expect(runtime.recover(1)).resolves.toMatchObject({
      url: attached.url,
      rendererCapability: capability("q"),
      generation: 2,
    });
    expect(attached.close).not.toHaveBeenCalled();
  });

  it("never publishes an attached successor for a different athlete home", async () => {
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "service-managed" as const,
      supervision: "attached" as const,
      close: vi.fn(async () => {}),
    };
    const successor = {
      ...attached,
      athleteHome: "/synthetic/other-athlete",
      rendererCapability: capability("q"),
      close: vi.fn(async () => {}),
    };
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(async () => successor),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, attached);
    runtime.start();

    await expect(runtime.recover(1)).rejects.toThrow("desktop daemon home mismatch");
    expect(successor.close).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toEqual({
      status: "terminal",
      generation: 1,
      cause: "unavailable",
    });
  });

  it("shares one three-attempt budget after attached re-observation", async () => {
    let now = 0;
    const delays: number[] = [];
    const budgets: Array<{ remainingAttempts: number; readonly deadline: number }> = [];
    const refusal = {
      status: "refused" as const,
      exitCode: 3 as const,
      classification: "contention-family" as const,
      cause: "unavailable" as const,
      retryable: true,
    };
    const attached = {
      status: "connected" as const,
      url: "ws://127.0.0.1:45001/rpc" as const,
      token: "s".repeat(43),
      athleteHome: "/synthetic/athlete",
      rendererCapability: capability("r"),
      owner: "service-managed" as const,
      supervision: "attached" as const,
      close: vi.fn(async () => {}),
    };
    const supervisor = {
      reobserveAttached: vi.fn(async (budget: (typeof budgets)[number]) => {
        budgets.push(budget);
        return refusal;
      }),
      resolveForRecovery: vi.fn(async (budget: (typeof budgets)[number]) => {
        budgets.push(budget);
        budget.remainingAttempts -= 1;
        return refusal;
      }),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, attached, {
      delay: async (ms) => {
        delays.push(ms);
        now += ms;
      },
      monotonicNow: () => now,
    });
    runtime.start();
    await expect(runtime.recover(1)).rejects.toThrow("restart budget exhausted");
    expect(supervisor.reobserveAttached).toHaveBeenCalledTimes(1);
    expect(supervisor.resolveForRecovery).toHaveBeenCalledTimes(3);
    expect(budgets).toHaveLength(4);
    expect(budgets.every((budget) => budget === budgets[0])).toBe(true);
    expect(delays).toEqual([500, 1_000, 2_000]);
  });

  it("does not start a successor after the previous child cannot be terminated", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    first.close.mockRejectedValueOnce(new Error("synthetic termination failure"));
    const supervisor = {
      resolveForRecovery: vi.fn(),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runtime = new DesktopDaemonLifecycle(supervisor, first, { delay: async () => {} });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() =>
      expect(runtime.snapshot()).toEqual({
        status: "terminal",
        generation: 1,
        cause: "termination-failed",
      }),
    );
    expect(supervisor.resolveForRecovery).not.toHaveBeenCalled();
  });

  it("cancels pending credential replay and never publishes its successor", async () => {
    const firstExit = deferred<{ readonly exitCode: number | null }>();
    const first = connected(45_001, firstExit);
    const successor = connected(45_002, deferred<{ readonly exitCode: number | null }>());
    const replay = deferred<void>();
    const replayStarted = vi.fn();
    const supervisor = {
      resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
        budget.remainingAttempts -= 1;
        return successor;
      }),
      reobserveAttached: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const runtime = new DesktopDaemonLifecycle(supervisor, first, {
      delay: async () => {},
      prepareReady: async () => {
        replayStarted();
        await replay.promise;
      },
      onReady,
    });
    runtime.start();
    firstExit.resolve({ exitCode: 1 });
    await vi.waitFor(() => expect(replayStarted).toHaveBeenCalledTimes(1));
    await runtime.close();
    replay.resolve();
    await vi.waitFor(() => expect(successor.close).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalled();
  });
});
