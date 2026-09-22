import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SHUTDOWN_DEADLINE_MS,
  DESKTOP_UPDATE_HANDOFF_DEADLINE_MS,
  completeDesktopShutdown,
  createDesktopQuitCoordinator,
  installDesktopTerminationSignalHandler,
} from "../src/main/quit-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deadlineHarness() {
  let callback: (() => void) | undefined;
  const handle = { unref: vi.fn() };
  const clearTimeout = vi.fn();
  const setTimeout = vi.fn((scheduled: () => void, _delayMs: number) => {
    callback = scheduled;
    return handle;
  });
  return {
    clearTimeout,
    fire: () => callback?.(),
    handle,
    setTimeout,
  };
}

describe("desktop quit coordinator", () => {
  it("coordinates the first termination signal and forces exactly once on repeats", async () => {
    const signalSource = new EventEmitter();
    const gate = deferred<void>();
    const drain = vi.fn(() => gate.promise);
    const exit = vi.fn();
    const install = vi.fn(() => "not-requested" as const);
    const deadline = deadlineHarness();
    const beforeQuitEvent = { preventDefault: vi.fn() };
    const coordinator = createDesktopQuitCoordinator({
      drain,
      updateController: { completeInstallAfterDrain: install },
      exit,
      ...deadline,
    });
    const application = new EventEmitter();
    application.on("before-quit", (event) => coordinator.beforeQuit(event));
    const requestQuit = vi.fn(() => application.emit("before-quit", beforeQuitEvent));
    const forceQuit = vi.fn(() => coordinator.forceQuit());
    installDesktopTerminationSignalHandler({ signalSource, requestQuit, forceQuit });

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");

    expect(requestQuit).toHaveBeenCalledOnce();
    expect(forceQuit).toHaveBeenCalledOnce();
    expect(beforeQuitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(deadline.handle.unref).toHaveBeenCalledOnce();
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);

    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("fails closed at the shutdown deadline and ignores late drain settlement", async () => {
    const gate = deferred<void>();
    const deadline = deadlineHarness();
    const install = vi.fn(() => "started" as const);
    const exit = vi.fn();
    const coordinator = createDesktopQuitCoordinator({
      drain: () => gate.promise,
      updateController: { completeInstallAfterDrain: install },
      exit,
      ...deadline,
    });

    expect(coordinator.beforeQuit({ preventDefault: vi.fn() })).toBe("draining");
    expect(deadline.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      DESKTOP_SHUTDOWN_DEADLINE_MS,
    );
    expect(deadline.handle.unref).toHaveBeenCalledOnce();

    deadline.fire();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);
    expect(install).not.toHaveBeenCalled();

    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("blocks repeated pre-drain quits and permits only the updater-generated post-drain quit", async () => {
    const gate = deferred<void>();
    const drain = vi.fn(() => gate.promise);
    const exit = vi.fn();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    const updaterQuit = { preventDefault: vi.fn() };
    const deadline = deadlineHarness();
    let coordinator!: ReturnType<typeof createDesktopQuitCoordinator>;
    const completeInstallAfterDrain = vi.fn((allowFinalQuit: () => void) => {
      allowFinalQuit();
      expect(coordinator.beforeQuit(updaterQuit)).toBe("allowed");
      return "started" as const;
    });
    coordinator = createDesktopQuitCoordinator({
      drain,
      updateController: { completeInstallAfterDrain },
      exit,
      ...deadline,
    });

    expect(coordinator.beforeQuit(first)).toBe("draining");
    expect(coordinator.beforeQuit(second)).toBe("draining");
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(completeInstallAfterDrain).not.toHaveBeenCalled();

    gate.resolve();
    await vi.waitFor(() => expect(completeInstallAfterDrain).toHaveBeenCalledOnce());

    expect(updaterQuit.preventDefault).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(deadline.handle.unref).toHaveBeenCalledOnce();
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);
  });

  it("permits a normal final exit only after a successful drain", async () => {
    const order: string[] = [];
    const deadline = deadlineHarness();
    const exitEvent = { preventDefault: vi.fn() };
    let coordinator!: ReturnType<typeof createDesktopQuitCoordinator>;
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
      expect(coordinator.beforeQuit(exitEvent)).toBe("allowed");
    });
    coordinator = createDesktopQuitCoordinator({
      drain: async () => {
        order.push("drain");
      },
      updateController: {
        completeInstallAfterDrain: () => {
          order.push("no-install");
          return "not-requested";
        },
      },
      exit,
      ...deadline,
    });

    coordinator.beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(order).toEqual(["drain", "no-install", "exit:0"]);
    expect(exitEvent.preventDefault).not.toHaveBeenCalled();
    expect(deadline.handle.unref).toHaveBeenCalledOnce();
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);
  });

  it("never permits install after drain rejection", async () => {
    const install = vi.fn(() => "started" as const);
    const exit = vi.fn();
    const deadline = deadlineHarness();
    await completeDesktopShutdown({
      drain: async () => {
        throw new Error("synthetic drain failure");
      },
      updateController: { completeInstallAfterDrain: install },
      allowFinalQuit: vi.fn(),
      exit,
      ...deadline,
    });

    expect(install).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);
  });

  it("never permits install when drain throws synchronously", async () => {
    const install = vi.fn(() => "started" as const);
    const exit = vi.fn();
    const deadline = deadlineHarness();
    await completeDesktopShutdown({
      drain: () => {
        throw new Error("synthetic synchronous drain failure");
      },
      updateController: { completeInstallAfterDrain: install },
      allowFinalQuit: vi.fn(),
      exit,
      ...deadline,
    });

    expect(install).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(deadline.clearTimeout).toHaveBeenCalledWith(deadline.handle);
  });

  it("exits unsuccessful when install handoff returns without quitting", async () => {
    const gate = deferred<void>();
    const deadline = deadlineHarness();
    const install = vi.fn(() => "started" as const);
    const exit = vi.fn();
    const coordinator = createDesktopQuitCoordinator({
      drain: () => gate.promise,
      updateController: { completeInstallAfterDrain: install },
      exit,
      ...deadline,
    });

    expect(coordinator.beforeQuit({ preventDefault: vi.fn() })).toBe("draining");
    gate.resolve();
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    expect(deadline.setTimeout).toHaveBeenLastCalledWith(
      expect.any(Function),
      DESKTOP_UPDATE_HANDOFF_DEADLINE_MS,
    );

    deadline.fire();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("cancels the handoff deadline when the updater quit arrives after install returns", async () => {
    const timers = new Map<object, () => void>();
    const setTimeout = vi.fn((callback: () => void) => {
      const handle = { unref: vi.fn() };
      timers.set(handle, callback);
      return handle;
    });
    const clearTimeout = vi.fn((handle: object) => {
      timers.delete(handle);
    });
    const gate = deferred<void>();
    const exit = vi.fn();
    let coordinator!: ReturnType<typeof createDesktopQuitCoordinator>;
    const install = vi.fn((allowFinalQuit: () => void) => {
      allowFinalQuit();
      return "started" as const;
    });
    coordinator = createDesktopQuitCoordinator({
      drain: () => gate.promise,
      updateController: { completeInstallAfterDrain: install },
      exit,
      setTimeout,
      clearTimeout,
    });

    coordinator.beforeQuit({ preventDefault: vi.fn() });
    gate.resolve();
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(timers.size).toBe(1);
    const quitEvent = { preventDefault: vi.fn() };
    expect(coordinator.beforeQuit(quitEvent)).toBe("allowed");

    expect(timers.size).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
    for (const callback of timers.values()) callback();
    expect(exit).not.toHaveBeenCalled();
  });
});
