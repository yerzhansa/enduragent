import { describe, expect, it, vi } from "vitest";
import {
  copyDesktopUpdateState,
  createDesktopUpdateController,
  desktopUpdateAutoInstallOnAppQuit,
  DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
  DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
  DESKTOP_UPDATE_INTERVAL_MS,
  DESKTOP_UPDATE_PROGRESS_THROTTLE_MS,
  type DesktopAutoUpdater,
  type DesktopUpdateState,
} from "../src/main/update-controller.js";
import type { DesktopUpdateVersionFloor } from "../src/main/update-version-floor.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function updateResult(
  version: string,
  isUpdateAvailable = true,
  cancellationToken?: { readonly cancel: () => void },
) {
  return { cancellationToken, isUpdateAvailable, updateInfo: { version } } as never;
}

function fakeCancellationToken() {
  return { cancel: vi.fn() };
}

function readyVersionFloor(version?: string): DesktopUpdateVersionFloor {
  return {
    recordRunningVersion: vi.fn(async (runningVersion: string) => ({
      status: "ready" as const,
      version: version ?? runningVersion,
    })),
  };
}

function fakeDeadlines() {
  interface TestTimerHandle {
    unref(): void;
  }
  interface ScheduledTimeout {
    readonly callback: () => void;
    readonly timeout: number;
  }
  const scheduled = new Map<TestTimerHandle, ScheduledTimeout>();
  const setTimeout = vi.fn((callback: () => void, timeout: number) => {
    const handle = { unref: vi.fn() };
    scheduled.set(handle, { callback, timeout });
    return handle;
  });
  const clearTimeout = vi.fn((handle: TestTimerHandle) => {
    scheduled.delete(handle);
  });
  const latest = (timeout: number): TestTimerHandle | undefined => {
    let match: TestTimerHandle | undefined;
    for (const [handle, entry] of scheduled) {
      if (entry.timeout === timeout) match = handle;
    }
    return match;
  };
  const fire = (handle: TestTimerHandle): boolean => {
    const entry = scheduled.get(handle);
    if (entry === undefined) return false;
    scheduled.delete(handle);
    entry.callback();
    return true;
  };
  return {
    clearTimeout,
    fire,
    fireLatest(timeout: number) {
      const handle = latest(timeout);
      if (handle === undefined) throw new Error(`no deadline scheduled for ${timeout}`);
      fire(handle);
    },
    latest,
    pending: () => scheduled.size,
    setTimeout,
  };
}

function fakeNativeUpdater() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const updater = {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
      return updater;
    }),
    off: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return updater;
    }),
  };
  return {
    updater,
    emit(event: "update-downloaded" | "error", value?: unknown) {
      const handlers = listeners.get(event);
      if (handlers === undefined) return;
      for (const listener of handlers) listener(value as never);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
  };
}

function fakeUpdater() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const updater = {
    logger: {} as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    checkForUpdates: vi.fn<DesktopAutoUpdater["checkForUpdates"]>(),
    downloadUpdate: vi.fn<DesktopAutoUpdater["downloadUpdate"]>(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
      return updater;
    }),
    off: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return updater;
    }),
  };
  return {
    updater: updater as unknown as DesktopAutoUpdater,
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
  };
}

function activeController(
  updater: DesktopAutoUpdater,
  overrides: Partial<Parameters<typeof createDesktopUpdateController>[0]> = {},
) {
  const quit = vi.fn();
  const timer = { unref: vi.fn() };
  const deadlines = fakeDeadlines();
  let tick: (() => void) | undefined;
  const clearInterval = vi.fn();
  const controller = createDesktopUpdateController({
    releaseEligible: true,
    currentVersion: "0.1.0",
    platform: "linux",
    versionFloor: readyVersionFloor(),
    loadUpdater: vi.fn(async () => updater),
    requestQuit: quit,
    setInterval: vi.fn((callback, interval) => {
      expect(interval).toBe(DESKTOP_UPDATE_INTERVAL_MS);
      tick = callback;
      return timer;
    }),
    clearInterval,
    setTimeout: deadlines.setTimeout,
    clearTimeout: deadlines.clearTimeout,
    ...overrides,
  });
  return { clearInterval, controller, deadlines, quit, timer, tick: () => tick?.() };
}

describe("desktop update controller", () => {
  it("checks for updates every six hours", () => {
    expect(DESKTOP_UPDATE_INTERVAL_MS).toBe(6 * 60 * 60 * 1_000);
  });

  it("is silent when release eligibility is disabled", async () => {
    const loadUpdater = vi.fn();
    const setInterval = vi.fn();
    const versionFloor = readyVersionFloor();
    const controller = createDesktopUpdateController({
      releaseEligible: false,
      currentVersion: "0.1.0",
      versionFloor,
      loadUpdater,
      requestQuit: vi.fn(),
      setInterval,
    });

    await controller.start();
    await controller.check();

    expect(controller.state()).toEqual({ status: "disabled" });
    expect(versionFloor.recordRunningVersion).toHaveBeenCalledOnce();
    expect(versionFloor.recordRunningVersion).toHaveBeenCalledWith("0.1.0");
    expect(loadUpdater).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("requires an app restart when the packaged updater fails to load", async () => {
    const loadUpdater = vi.fn(async (): Promise<DesktopAutoUpdater> => {
      throw new Error("synthetic packaged updater load failure");
    });
    const setInterval = vi.fn();
    const controller = createDesktopUpdateController({
      releaseEligible: true,
      currentVersion: "0.1.0",
      versionFloor: readyVersionFloor(),
      loadUpdater,
      requestQuit: vi.fn(),
      setInterval,
    });

    await controller.start();

    expect(controller.state()).toEqual({ status: "restart-required", stage: "check" });
    await expect(controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "check",
    });
    await controller.start();
    expect(loadUpdater).toHaveBeenCalledOnce();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("retries floor initialization on a manual check after failing closed", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const recordRunningVersion = vi
      .fn<DesktopUpdateVersionFloor["recordRunningVersion"]>()
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce({ status: "ready", version: "0.1.0" });
    const loadUpdater = vi.fn(async () => fake.updater);
    const log = vi.fn();
    const timer = { unref: vi.fn() };
    const setInterval = vi.fn(() => timer);
    const controller = createDesktopUpdateController({
      releaseEligible: true,
      currentVersion: "0.1.0",
      versionFloor: { recordRunningVersion },
      loadUpdater,
      requestQuit: vi.fn(),
      log,
      setInterval,
    });

    await controller.start();

    expect(controller.state()).toEqual({ status: "failed", stage: "check" });
    expect(log).toHaveBeenCalledWith("desktop-update-version-floor-unavailable");
    expect(loadUpdater).not.toHaveBeenCalled();

    await expect(Promise.all([controller.check(), controller.check()])).resolves.toEqual([
      { status: "current" },
      { status: "current" },
    ]);
    expect(recordRunningVersion).toHaveBeenCalledTimes(2);
    expect(loadUpdater).toHaveBeenCalledOnce();
    expect(setInterval).toHaveBeenCalledOnce();
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(controller.state()).toEqual({ status: "current" });
    controller.close();
  });

  it.each([
    { platform: "darwin", autoInstallOnAppQuit: true },
    { platform: "win32", autoInstallOnAppQuit: false },
    { platform: "linux", autoInstallOnAppQuit: false },
  ] as const)(
    "configures autoInstallOnAppQuit=$autoInstallOnAppQuit for $platform",
    async ({ platform, autoInstallOnAppQuit }) => {
      expect(desktopUpdateAutoInstallOnAppQuit(platform)).toBe(autoInstallOnAppQuit);
      const fake = fakeUpdater();
      vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
      const subject = activeController(fake.updater, { platform });
      await subject.controller.start();
      expect(fake.updater.autoInstallOnAppQuit).toBe(autoInstallOnAppQuit);
      subject.controller.close();
    },
  );

  it("configures a quiet updater, performs startup and unref'd six-hour checks, and cleans up", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const subject = activeController(fake.updater);

    await subject.controller.start();

    expect(fake.updater).toMatchObject({
      logger: null,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(subject.timer.unref).toHaveBeenCalledOnce();
    expect(fake.listenerCount()).toBe(0);
    subject.tick();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(2));
    subject.controller.close();
    subject.controller.close();
    expect(subject.clearInterval).toHaveBeenCalledOnce();
    expect(fake.listenerCount()).toBe(0);
  });

  it("coalesces concurrent checks and retries after settlement", async () => {
    const fake = fakeUpdater();
    const first = deferred<never>();
    vi.mocked(fake.updater.checkForUpdates)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(updateResult("0.1.0"));
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce());

    const concurrent = subject.controller.check();
    first.resolve(updateResult("0.1.0"));
    await expect(concurrent).resolves.toEqual({ status: "current" });
    await startup;
    await subject.controller.check();
    expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("requires an app restart after a hung check and fences its late settlement", async () => {
    const fake = fakeUpdater();
    const first = deferred<never>();
    const lateToken = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(updateResult("0.1.0"));
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce());

    expect(subject.timer.unref).toHaveBeenCalledOnce();
    const concurrent = subject.controller.check();
    subject.deadlines.fireLatest(DESKTOP_UPDATE_CHECK_TIMEOUT_MS);
    await expect(concurrent).resolves.toEqual({ status: "restart-required", stage: "check" });
    await startup;
    await expect(subject.controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "check",
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    subject.tick();
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();

    first.resolve(updateResult("0.1.0", false, lateToken));
    await vi.waitFor(() => expect(lateToken.cancel).toHaveBeenCalledOnce());
    await expect(subject.controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "check",
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("downloads only a strictly newer stable target and accepts only its exact event", async () => {
    const fake = fakeUpdater();
    const token = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1", true, token));
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    expect(fake.updater.downloadUpdate).toHaveBeenCalledWith(token);
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "0.1.1",
    });
    expect(subject.quit).not.toHaveBeenCalled();
    fake.emit("update-downloaded", { version: "0.1.1", downloadedFile: "/private/raw.zip" });
    expect(subject.controller.state()).toEqual({
      status: "downloaded",
      version: "0.1.1",
    });
    await startup;
    expect(JSON.stringify(subject.controller.state())).not.toContain("raw.zip");
  });

  it("accepts a candidate equal to the recorded version floor", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.2.0"));
    const subject = activeController(fake.updater, {
      versionFloor: readyVersionFloor("0.2.0"),
    });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    await startup;
  });

  it("accepts a candidate higher than the recorded version floor", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.3.0"));
    const subject = activeController(fake.updater, {
      versionFloor: readyVersionFloor("0.2.0"),
    });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.3.0" });
    fake.emit("update-downloaded", { version: "0.3.0" });
    await startup;
  });

  it("refuses and reports a candidate lower than the recorded version floor", async () => {
    const fake = fakeUpdater();
    const token = fakeCancellationToken();
    const log = vi.fn();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1", true, token));
    const subject = activeController(fake.updater, {
      versionFloor: readyVersionFloor("0.2.0"),
      log,
    });
    const states: unknown[] = [];
    subject.controller.subscribe((state) => states.push(state));

    await subject.controller.start();

    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });
    expect(states).toContainEqual({ status: "failed", stage: "check" });
    expect(log).toHaveBeenCalledWith(
      "desktop-update-downgrade-refused candidate=0.1.1 floor=0.2.0",
    );
    expect(token.cancel).toHaveBeenCalledOnce();
    expect(fake.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("resets the no-progress deadline only when transferred bytes advance", async () => {
    const fake = fakeUpdater();
    const download = deferred<never>();
    const token = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates)
      .mockResolvedValueOnce(updateResult("0.1.1", true, token))
      .mockResolvedValueOnce(updateResult("0.1.0"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    const initialStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    expect(initialStall).toBeDefined();

    fake.emit("download-progress", { transferred: 1 });
    const advancedStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    expect(advancedStall).toBeDefined();
    expect(advancedStall).not.toBe(initialStall);
    expect(subject.deadlines.fire(initialStall!)).toBe(false);
    fake.emit("download-progress", { transferred: 1 });
    expect(subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS)).toBe(advancedStall);

    subject.deadlines.fireLatest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    await expect(startup).resolves.toBeUndefined();
    expect(subject.controller.state()).toEqual({
      status: "restart-required",
      stage: "download",
    });
    expect(token.cancel).toHaveBeenCalledOnce();
    await expect(subject.controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "download",
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.controller.state()).toEqual({
      status: "restart-required",
      stage: "download",
    });

    download.resolve([] as never);
    await download.promise;
    await expect(subject.controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "download",
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("enforces an absolute download cap even while progress continues", async () => {
    const fake = fakeUpdater();
    const download = deferred<never>();
    const token = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1", true, token));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    fake.emit("download-progress", { transferred: 1 });
    fake.emit("download-progress", { transferred: 2 });
    subject.deadlines.fireLatest(DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS);
    await expect(startup).resolves.toBeUndefined();
    expect(subject.controller.state()).toEqual({
      status: "restart-required",
      stage: "download",
    });
    expect(token.cancel).toHaveBeenCalledOnce();
  });

  it.each(["0.1.0", "0.0.9", "0.1.1-beta.1", "0.01.1", "0.1.9007199254740992", "not-a-version"])(
    "does not download a non-newer or non-stable target %s",
    async (version) => {
      const fake = fakeUpdater();
      vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult(version));
      const subject = activeController(fake.updater);
      await subject.controller.start();
      expect(subject.controller.state()).toEqual({ status: "current" });
      expect(fake.updater.downloadUpdate).not.toHaveBeenCalled();
    },
  );

  it("clears a failed candidate when the updater reports a newer version unavailable", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates)
      .mockResolvedValueOnce(updateResult("0.1.1"))
      .mockResolvedValueOnce(updateResult("0.1.2", false));
    vi.mocked(fake.updater.downloadUpdate).mockRejectedValueOnce(
      new Error("synthetic download failure"),
    );
    const subject = activeController(fake.updater);

    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    await subject.controller.check();

    expect(subject.controller.state()).toEqual({ status: "current" });
    expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce();
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.controller.state()).toEqual({ status: "current" });
  });

  it("fails closed on a mismatched downloaded event and contains updater diagnostics", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const states: unknown[] = [];
    const subject = activeController(fake.updater);
    subject.controller.subscribe((state) => states.push(state));
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", {
      version: "0.1.2",
      downloadedFile: "/Users/athlete/private/update.zip",
    });
    fake.emit("error", new Error("Authorization: secret"));
    await startup;

    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(JSON.stringify(states)).not.toContain("private/update");
    expect(JSON.stringify(states)).not.toContain("Authorization");
  });

  it("requests an explicit quit only after download and installs once after a successful drain", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    expect(subject.controller.restart()).toEqual({
      status: "downloading",
      version: "0.1.1",
    });
    fake.emit("update-downloaded", { version: "0.1.1" });
    await startup;
    expect(subject.controller.restart()).toEqual({
      status: "installing",
      version: "0.1.1",
    });
    subject.controller.restart();
    expect(subject.quit).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();

    const allowFinalQuit = vi.fn();
    subject.controller.close();
    expect(subject.controller.completeInstallAfterDrain(allowFinalQuit)).toBe("started");
    expect(subject.controller.completeInstallAfterDrain(allowFinalQuit)).toBe("started");
    expect(allowFinalQuit).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(allowFinalQuit.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fake.updater.quitAndInstall).mock.invocationCallOrder[0]!,
    );
  });

  it("cancels deadlines and the active download token when closed", async () => {
    const fake = fakeUpdater();
    const download = deferred<never>();
    const token = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1", true, token));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    expect(subject.deadlines.pending()).toBe(2);

    subject.controller.close();
    await startup;
    expect(token.cancel).toHaveBeenCalledOnce();
    expect(subject.clearInterval).toHaveBeenCalledOnce();
    expect(subject.deadlines.pending()).toBe(0);
    expect(fake.listenerCount()).toBe(0);
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.1.1" });
  });

  it("does not install on ordinary quit or failed download", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockRejectedValue(
      new Error("https://private.invalid/feed"),
    );
    const subject = activeController(fake.updater);
    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });
    expect(subject.controller.completeInstallAfterDrain(vi.fn())).toBe("not-requested");
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("enables macOS restart once after wrapper download followed by native readiness", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    const download = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.1.1" });
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.controller.state()).toEqual({ status: "preparing", version: "0.1.1" });
    expect(subject.controller.restart()).toEqual({ status: "preparing", version: "0.1.1" });
    expect(subject.quit).not.toHaveBeenCalled();

    native.emit("update-downloaded");

    expect(subject.controller.state()).toEqual({ status: "downloaded", version: "0.1.1" });
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("update-downloaded");
    expect(subject.controller.restart()).toEqual({ status: "installing", version: "0.1.1" });
    subject.controller.restart();
    expect(subject.quit).toHaveBeenCalledOnce();
    download.resolve([]);
    await startup;
  });

  it("ignores stale macOS native readiness arriving before the current archive finishes", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    const firstDownload = deferred<string[]>();
    const secondDownload = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates)
      .mockResolvedValueOnce(updateResult("0.1.1"))
      .mockResolvedValueOnce(updateResult("0.1.2"));
    vi.mocked(fake.updater.downloadUpdate)
      .mockReturnValueOnce(firstDownload.promise)
      .mockReturnValueOnce(secondDownload.promise);
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });

    const first = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    fake.emit("error", new Error("blockmap copy failed"));
    await first;
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });

    const second = subject.controller.check();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(native.listenerCount()).toBe(0);
    native.emit("update-downloaded");
    fake.emit("update-downloaded", { version: "0.1.2" });

    expect(subject.controller.state()).toEqual({ status: "preparing", version: "0.1.2" });
    expect(subject.controller.restart()).toEqual({ status: "preparing", version: "0.1.2" });
    expect(subject.quit).not.toHaveBeenCalled();

    native.emit("update-downloaded");
    await expect(second).resolves.toEqual({ status: "downloaded", version: "0.1.2" });
    firstDownload.resolve([]);
    secondDownload.resolve([]);
  });

  it("does not enable macOS restart when only the download promise resolves", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(fake.updater.downloadUpdate).mockResolvedValue([]);
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.1.1" });
    expect(subject.controller.restart()).toEqual({ status: "downloading", version: "0.1.1" });
    expect(subject.quit).not.toHaveBeenCalled();
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
    void startup;
  });

  it("keeps a macOS native rejection visible and does not drain the app", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("error", new Error("The application has an invalid version string"));
    await startup;

    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(subject.quit).not.toHaveBeenCalled();
    expect(subject.controller.restart()).toEqual({ status: "failed", stage: "download" });
    expect(subject.controller.completeInstallAfterDrain(vi.fn())).toBe("not-requested");
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("blocks a macOS retry after preparation timeout and ignores a late native event", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    const download = deferred<string[]>();
    const token = fakeCancellationToken();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1", true, token));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    const transferStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.deadlines.fire(transferStall!)).toBe(false);

    subject.deadlines.fireLatest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    await expect(startup).resolves.toBeUndefined();
    expect(subject.controller.state()).toEqual({ status: "restart-required", stage: "download" });
    native.emit("update-downloaded");
    fake.emit("update-downloaded", { version: "0.1.1" });
    expect(subject.controller.state()).toEqual({ status: "restart-required", stage: "download" });
    await expect(subject.controller.check()).resolves.toEqual({
      status: "restart-required",
      stage: "download",
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(subject.quit).not.toHaveBeenCalled();
  });

  it("does not let a macOS retry inherit readiness from the failed attempt", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates)
      .mockResolvedValueOnce(updateResult("0.1.1"))
      .mockResolvedValueOnce(updateResult("0.1.2"));
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("update-downloaded");
    expect(subject.controller.state()).toEqual({ status: "downloaded", version: "0.1.1" });
    await startup;
    await Promise.resolve();
    native.emit("error", new Error("native validation failed"));
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(native.listenerCount()).toBe(0);

    native.emit("update-downloaded");
    const retry = subject.controller.check();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledTimes(2));
    fake.emit("update-downloaded", { version: "0.1.2" });
    expect(subject.controller.state()).toEqual({ status: "preparing", version: "0.1.2" });
    expect(subject.controller.restart()).toEqual({ status: "preparing", version: "0.1.2" });
    native.emit("update-downloaded");
    expect(subject.controller.state()).toEqual({ status: "downloaded", version: "0.1.2" });
    await retry;
  });

  it("invalidates published macOS readiness when a late native error arrives", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("update-downloaded");
    await startup;
    expect(subject.controller.state()).toEqual({ status: "downloaded", version: "0.1.1" });

    native.emit("error", new Error("signature rejected"));
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(subject.controller.restart()).toEqual({ status: "failed", stage: "download" });
    expect(subject.quit).not.toHaveBeenCalled();
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("refuses macOS installation when native readiness fails after restart is requested", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("update-downloaded");
    await startup;
    expect(subject.controller.restart()).toEqual({ status: "installing", version: "0.1.1" });
    native.emit("error", new Error("shipit rejected"));
    subject.controller.close();

    expect(subject.controller.completeInstallAfterDrain(vi.fn())).toBe("failed");
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("fails a macOS download closed when native readiness cannot be observed", async () => {
    const fake = fakeUpdater();
    const log = vi.fn();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater, { platform: "darwin", log });
    await subject.controller.start();

    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(log).toHaveBeenCalledWith("desktop-update-native-readiness-unavailable");
    expect(fake.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(subject.quit).not.toHaveBeenCalled();
  });

  it("detaches a failed check so retry works even while the prior call stays pending", async () => {
    const fake = fakeUpdater();
    const hung = deferred<never>();
    vi.mocked(fake.updater.checkForUpdates)
      .mockReturnValueOnce(hung.promise)
      .mockResolvedValueOnce(updateResult("0.1.0"));
    const subject = activeController(fake.updater);

    const first = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce());
    fake.emit("error", new Error("network error"));
    await first;
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });

    await expect(subject.controller.check()).resolves.toEqual({ status: "current" });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    subject.controller.close();
  });

  it("resets the download stall deadline and progress when a differential download falls back to a full download", async () => {
    const fake = fakeUpdater();
    const download = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    let currentTime = 1_000;
    const subject = activeController(fake.updater, { now: () => currentTime });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("download-progress", {
      transferred: 18_000_000,
      total: 18_000_000,
      percent: 100,
      bytesPerSecond: 4_000_000,
    });
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "0.1.1",
      progress: {
        percent: 100,
        transferredBytes: 18_000_000,
        totalBytes: 18_000_000,
        bytesPerSecond: 4_000_000,
      },
    });
    const diffStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);

    currentTime += 50;
    fake.emit("download-progress", {
      transferred: 0,
      total: 146_000_000,
      percent: 0,
      bytesPerSecond: 0,
    });
    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.1.1" });

    currentTime += 50;
    fake.emit("download-progress", {
      transferred: 1_460_000,
      total: 146_000_000,
      percent: 1,
      bytesPerSecond: 2_000_000,
    });
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "0.1.1",
      progress: {
        percent: 1,
        transferredBytes: 1_460_000,
        totalBytes: 146_000_000,
        bytesPerSecond: 2_000_000,
      },
    });
    const fallbackStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    expect(fallbackStall).toBeDefined();
    expect(fallbackStall).not.toBe(diffStall);
    expect(subject.deadlines.fire(diffStall!)).toBe(false);

    currentTime += DESKTOP_UPDATE_PROGRESS_THROTTLE_MS;
    fake.emit("download-progress", {
      transferred: 14_600_000,
      total: 146_000_000,
      percent: 10,
      bytesPerSecond: 3_000_000,
    });
    const nextStall = subject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    expect(nextStall).not.toBe(fallbackStall);
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "0.1.1",
      progress: {
        percent: 10,
        transferredBytes: 14_600_000,
        totalBytes: 146_000_000,
        bytesPerSecond: 3_000_000,
      },
    });

    fake.emit("update-downloaded", { version: "0.1.1" });
    download.resolve([]);
    await startup;
    expect(subject.controller.state()).toEqual({ status: "downloaded", version: "0.1.1" });
    subject.controller.close();
  });

  it("does not commit an unconfigured updater when setup throws", async () => {
    let attempts = 0;
    const broken = fakeUpdater();
    Object.defineProperty(broken.updater, "disableWebInstaller", {
      set() {
        throw new Error("config failed");
      },
      get() {
        return false;
      },
    });
    const healthy = fakeUpdater();
    vi.mocked(healthy.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const loadUpdater = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? broken.updater : healthy.updater;
    });
    const subject = activeController(healthy.updater, { loadUpdater });

    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });
    expect(broken.updater.checkForUpdates).not.toHaveBeenCalled();

    await expect(subject.controller.check()).resolves.toEqual({ status: "current" });
    expect(loadUpdater).toHaveBeenCalledTimes(2);
    expect(healthy.updater.autoDownload).toBe(false);
    expect(healthy.updater.allowDowngrade).toBe(false);
    expect(healthy.updater.disableWebInstaller).toBe(true);
    expect(healthy.updater.checkForUpdates).toHaveBeenCalledOnce();
    subject.controller.close();
  });

  it("keeps periodic recovery scheduled after a transient startup floor failure", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const recordRunningVersion = vi
      .fn<DesktopUpdateVersionFloor["recordRunningVersion"]>()
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce({ status: "ready", version: "0.1.0" });
    const subject = activeController(fake.updater, {
      versionFloor: { recordRunningVersion },
    });

    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });

    subject.tick();
    await vi.waitFor(() => expect(subject.controller.state()).toEqual({ status: "current" }));
    expect(recordRunningVersion).toHaveBeenCalledTimes(2);
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    subject.controller.close();
  });

  it("keeps periodic recovery scheduled after a transient startup configuration failure", async () => {
    let attempts = 0;
    const broken = fakeUpdater();
    Object.defineProperty(broken.updater, "disableWebInstaller", {
      set() {
        throw new Error("config failed");
      },
      get() {
        return false;
      },
    });
    const healthy = fakeUpdater();
    vi.mocked(healthy.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const loadUpdater = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? broken.updater : healthy.updater;
    });
    const subject = activeController(healthy.updater, { loadUpdater });

    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });

    subject.tick();
    await vi.waitFor(() => expect(subject.controller.state()).toEqual({ status: "current" }));
    expect(loadUpdater).toHaveBeenCalledTimes(2);
    expect(healthy.updater.checkForUpdates).toHaveBeenCalledOnce();
    subject.controller.close();
  });

  it("locks out restart and detaches macOS readiness watch on ordinary quit close", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.1.1" });
    native.emit("update-downloaded");
    await startup;
    expect(native.listenerCount()).toBe(1);

    subject.controller.close();
    expect(native.listenerCount()).toBe(0);
    expect(subject.controller.isInstallRequested?.()).toBe(false);
    expect(subject.controller.restart()).toEqual({ status: "downloaded", version: "0.1.1" });
    expect(subject.quit).not.toHaveBeenCalled();
    expect(subject.controller.completeInstallAfterDrain(vi.fn())).toBe("not-requested");
  });

  it("handles macOS native readiness errors during drain, inside quitAndInstall, and asynchronously after handoff", async () => {
    const drainFake = fakeUpdater();
    const drainNative = fakeNativeUpdater();
    vi.mocked(drainFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const drainSubject = activeController(drainFake.updater, {
      platform: "darwin",
      nativeUpdater: drainNative.updater,
    });
    let restartedInSubscriber = false;
    drainSubject.controller.subscribe((next) => {
      if (next.status === "downloaded" && !restartedInSubscriber) {
        restartedInSubscriber = true;
        drainSubject.controller.restart();
      }
    });
    const drainStart = drainSubject.controller.start();
    await vi.waitFor(() => expect(drainFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    drainFake.emit("update-downloaded", { version: "0.1.1" });
    drainNative.emit("update-downloaded");
    await drainStart;
    expect(restartedInSubscriber).toBe(true);
    drainSubject.controller.close();
    drainNative.emit("error", new Error("invalidated after close during drain"));
    expect(drainSubject.controller.completeInstallAfterDrain(vi.fn())).toBe("failed");
    expect(drainSubject.controller.completeInstallAfterDrain(vi.fn())).toBe("failed");
    expect(drainFake.updater.quitAndInstall).not.toHaveBeenCalled();

    const syncNativeFake = fakeUpdater();
    const syncNative = fakeNativeUpdater();
    vi.mocked(syncNativeFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(syncNativeFake.updater.quitAndInstall).mockImplementation(() => {
      syncNative.emit("error", new Error("squirrel sync failure"));
      syncNativeFake.emit("error", new Error("forwarded sync failure"));
    });
    const syncNativeSubject = activeController(syncNativeFake.updater, {
      platform: "darwin",
      nativeUpdater: syncNative.updater,
    });
    const syncNativeStart = syncNativeSubject.controller.start();
    await vi.waitFor(() => expect(syncNativeFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    syncNativeFake.emit("update-downloaded", { version: "0.1.1" });
    syncNative.emit("update-downloaded");
    await syncNativeStart;
    syncNativeSubject.controller.restart();
    syncNativeSubject.controller.close();
    const syncOnInstallError = vi.fn();
    expect(
      syncNativeSubject.controller.completeInstallAfterDrain(vi.fn(), syncOnInstallError),
    ).toBe("failed");
    expect(syncOnInstallError).not.toHaveBeenCalled();
    expect(syncNativeSubject.controller.completeInstallAfterDrain(vi.fn())).toBe("failed");
    expect(syncNativeFake.listenerCount()).toBe(0);
    expect(syncNative.listenerCount()).toBe(0);

    const asyncNativeFake = fakeUpdater();
    const asyncNative = fakeNativeUpdater();
    vi.mocked(asyncNativeFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const asyncNativeSubject = activeController(asyncNativeFake.updater, {
      platform: "darwin",
      nativeUpdater: asyncNative.updater,
    });
    const asyncNativeStart = asyncNativeSubject.controller.start();
    await vi.waitFor(() => expect(asyncNativeFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    asyncNativeFake.emit("update-downloaded", { version: "0.1.1" });
    asyncNative.emit("update-downloaded");
    await asyncNativeStart;
    asyncNativeSubject.controller.restart();
    asyncNativeSubject.controller.close();
    const asyncOnInstallError = vi.fn();
    expect(
      asyncNativeSubject.controller.completeInstallAfterDrain(vi.fn(), asyncOnInstallError),
    ).toBe("started");
    asyncNative.emit("error", new Error("squirrel async failure"));
    asyncNativeFake.emit("error", new Error("forwarded async failure"));
    expect(asyncOnInstallError).toHaveBeenCalledOnce();
    expect(asyncNativeFake.listenerCount()).toBe(0);
    expect(asyncNative.listenerCount()).toBe(0);
  });

  it("reports synchronous and asynchronous quitAndInstall updater errors", async () => {
    const syncFake = fakeUpdater();
    vi.mocked(syncFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(syncFake.updater.quitAndInstall).mockImplementation(() => {
      syncFake.emit("error", new Error("Windows installer spawn failed"));
    });
    const syncSubject = activeController(syncFake.updater);
    const syncStart = syncSubject.controller.start();
    await vi.waitFor(() => expect(syncFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    syncFake.emit("update-downloaded", { version: "0.1.1" });
    await syncStart;
    syncSubject.controller.restart();
    syncSubject.controller.close();
    expect(syncSubject.controller.completeInstallAfterDrain(vi.fn(), vi.fn())).toBe("failed");
    expect(syncSubject.controller.completeInstallAfterDrain(vi.fn(), vi.fn())).toBe("failed");
    expect(syncFake.listenerCount()).toBe(0);

    const asyncFake = fakeUpdater();
    vi.mocked(asyncFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    const asyncSubject = activeController(asyncFake.updater);
    const asyncStart = asyncSubject.controller.start();
    await vi.waitFor(() => expect(asyncFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    asyncFake.emit("update-downloaded", { version: "0.1.1" });
    await asyncStart;
    asyncSubject.controller.restart();
    asyncSubject.controller.close();
    const onInstallError = vi.fn();
    expect(asyncSubject.controller.completeInstallAfterDrain(vi.fn(), onInstallError)).toBe(
      "started",
    );
    asyncFake.emit("error", new Error("async installer failure"));
    expect(onInstallError).toHaveBeenCalledOnce();
  });

  it("fences re-entrant close during publish and ignores duplicate macOS update-downloaded events", async () => {
    const reentrantFake = fakeUpdater();
    vi.mocked(reentrantFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.0"));
    const reentrant = activeController(reentrantFake.updater);
    reentrant.controller.subscribe((next) => {
      if (next.status === "checking") reentrant.controller.close();
    });
    await reentrant.controller.start();
    expect(reentrantFake.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(reentrantFake.listenerCount()).toBe(0);
    expect(reentrant.deadlines.pending()).toBe(0);

    const macFake = fakeUpdater();
    const native = fakeNativeUpdater();
    const download = deferred<string[]>();
    vi.mocked(macFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(macFake.updater.downloadUpdate).mockReturnValue(download.promise);
    const macSubject = activeController(macFake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
    });
    const macStart = macSubject.controller.start();
    await vi.waitFor(() => expect(macFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    macFake.emit("update-downloaded", { version: "0.1.1" });
    const firstPrepTimer = macSubject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
    macFake.emit("update-downloaded", { version: "0.1.1" });
    expect(macSubject.deadlines.latest(DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS)).toBe(
      firstPrepTimer,
    );
    native.emit("update-downloaded");
    download.resolve([]);
    await macStart;
    macSubject.controller.close();

    const prepCloseFake = fakeUpdater();
    const prepCloseNative = fakeNativeUpdater();
    const prepCloseDownload = deferred<string[]>();
    vi.mocked(prepCloseFake.updater.checkForUpdates).mockResolvedValue(updateResult("0.1.1"));
    vi.mocked(prepCloseFake.updater.downloadUpdate).mockReturnValue(prepCloseDownload.promise);
    const prepClose = activeController(prepCloseFake.updater, {
      platform: "darwin",
      nativeUpdater: prepCloseNative.updater,
    });
    prepClose.controller.subscribe((next) => {
      if (next.status === "preparing") prepClose.controller.close();
    });
    const prepStart = prepClose.controller.start();
    await vi.waitFor(() => expect(prepCloseFake.updater.downloadUpdate).toHaveBeenCalledOnce());
    prepCloseFake.emit("update-downloaded", { version: "0.1.1" });
    await prepStart;
    expect(prepCloseNative.listenerCount()).toBe(0);
    expect(prepCloseFake.listenerCount()).toBe(0);
    expect(prepClose.deadlines.pending()).toBe(0);
    prepCloseDownload.resolve([]);
  });

  it("throttles live download progress while publishing the first sample and 100% immediately", async () => {
    const fake = fakeUpdater();
    const download = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.7.0"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    let currentTime = 1_000;
    const subject = activeController(fake.updater, { now: () => currentTime });
    const states: DesktopUpdateState[] = [];
    subject.controller.subscribe((next) => states.push(next));

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    fake.emit("download-progress", {
      transferred: 1_000_000,
      total: 33_000_000,
      percent: 3.03,
      bytesPerSecond: 2_500_000,
    });
    currentTime += DESKTOP_UPDATE_PROGRESS_THROTTLE_MS - 50;
    fake.emit("download-progress", {
      transferred: 5_000_000,
      total: 33_000_000,
      percent: 15.15,
      bytesPerSecond: 2_600_000,
    });
    currentTime += 50;
    fake.emit("download-progress", {
      transferred: 14_000_000,
      total: 33_000_000,
      percent: 42.42,
      bytesPerSecond: 3_100_000,
    });
    currentTime += 20;
    fake.emit("download-progress", {
      transferred: 33_000_000,
      total: 33_000_000,
      percent: 100,
      bytesPerSecond: 3_500_000,
    });

    expect(states).toEqual([
      { status: "idle" },
      { status: "checking" },
      { status: "downloading", version: "0.7.0" },
      {
        status: "downloading",
        version: "0.7.0",
        progress: {
          percent: 3,
          transferredBytes: 1_000_000,
          totalBytes: 33_000_000,
          bytesPerSecond: 2_500_000,
        },
      },
      {
        status: "downloading",
        version: "0.7.0",
        progress: {
          percent: 42,
          transferredBytes: 14_000_000,
          totalBytes: 33_000_000,
          bytesPerSecond: 3_100_000,
        },
      },
      {
        status: "downloading",
        version: "0.7.0",
        progress: {
          percent: 100,
          transferredBytes: 33_000_000,
          totalBytes: 33_000_000,
          bytesPerSecond: 3_500_000,
        },
      },
    ]);

    fake.emit("update-downloaded", { version: "0.7.0" });
    download.resolve([]);
    await startup;
  });

  it("clamps noisy progress payloads, deep-copies state, and ignores late progress during preparing", async () => {
    const fake = fakeUpdater();
    const native = fakeNativeUpdater();
    const download = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.7.0"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    let currentTime = 5_000;
    const subject = activeController(fake.updater, {
      platform: "darwin",
      nativeUpdater: native.updater,
      now: () => currentTime,
    });

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    fake.emit("download-progress", {
      transferred: 32_950_000,
      total: 33_000_000,
      percent: 99.9,
      bytesPerSecond: -50,
    });
    const snapshot = subject.controller.state();
    expect(snapshot).toEqual({
      status: "downloading",
      version: "0.7.0",
      progress: {
        percent: 99,
        transferredBytes: 32_950_000,
        totalBytes: 33_000_000,
        bytesPerSecond: 0,
      },
    });
    if (snapshot.status === "downloading" && snapshot.progress !== undefined) {
      (snapshot.progress as { percent: number }).percent = 0;
    }
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "0.7.0",
      progress: {
        percent: 99,
        transferredBytes: 32_950_000,
        totalBytes: 33_000_000,
        bytesPerSecond: 0,
      },
    });

    const copied = copyDesktopUpdateState(subject.controller.state());
    expect(copied).toEqual(subject.controller.state());
    if (copied.status === "downloading" && copied.progress !== undefined) {
      const current = subject.controller.state();
      if (current.status === "downloading") {
        expect(copied.progress).not.toBe(current.progress);
      }
    }

    fake.emit("update-downloaded", { version: "0.7.0" });
    expect(subject.controller.state()).toEqual({ status: "preparing", version: "0.7.0" });

    currentTime += DESKTOP_UPDATE_PROGRESS_THROTTLE_MS * 2;
    fake.emit("download-progress", {
      transferred: 33_000_000,
      total: 33_000_000,
      percent: 100,
      bytesPerSecond: 1_000_000,
    });
    expect(subject.controller.state()).toEqual({ status: "preparing", version: "0.7.0" });

    const concurrentCheck = subject.controller.check();
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();

    native.emit("update-downloaded");
    await expect(concurrentCheck).resolves.toEqual({ status: "downloaded", version: "0.7.0" });
    download.resolve([]);
    await startup;
  });

  it("publishes indeterminate downloading when fallback emits transferred bytes without a valid total and preserves monotonic progress edge cases", async () => {
    const fake = fakeUpdater();
    const download = deferred<string[]>();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("0.7.0"));
    vi.mocked(fake.updater.downloadUpdate).mockReturnValue(download.promise);
    let currentTime = 10_000;
    const subject = activeController(fake.updater, { now: () => currentTime });
    const states: DesktopUpdateState[] = [];
    subject.controller.subscribe((next) => states.push(next));

    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce());

    fake.emit("download-progress", {
      transferred: 10_000_000,
      total: 20_000_000,
      percent: Number.NaN,
      bytesPerSecond: 2_000_000,
    });
    expect(states.at(-1)).toEqual({
      status: "downloading",
      version: "0.7.0",
      progress: {
        percent: 50,
        transferredBytes: 10_000_000,
        totalBytes: 20_000_000,
        bytesPerSecond: 2_000_000,
      },
    });

    currentTime -= 500;
    fake.emit("download-progress", {
      transferred: 12_000_000,
      total: 20_000_000,
      percent: 45,
      bytesPerSecond: 2_200_000,
    });
    expect(states.at(-1)).toEqual({
      status: "downloading",
      version: "0.7.0",
      progress: {
        percent: 50,
        transferredBytes: 12_000_000,
        totalBytes: 20_000_000,
        bytesPerSecond: 2_200_000,
      },
    });

    currentTime += DESKTOP_UPDATE_PROGRESS_THROTTLE_MS;
    fake.emit("download-progress", {
      transferred: 25_000_000,
      total: 20_000_000,
      percent: 125,
      bytesPerSecond: 3_000_000,
    });
    expect(states.at(-1)).toEqual({
      status: "downloading",
      version: "0.7.0",
      progress: {
        percent: 100,
        transferredBytes: 20_000_000,
        totalBytes: 20_000_000,
        bytesPerSecond: 3_000_000,
      },
    });

    currentTime += 50;
    fake.emit("download-progress", {
      transferred: 65_536,
      total: 0,
      percent: 0,
      bytesPerSecond: 1_000_000,
    });
    expect(subject.controller.state()).toEqual({ status: "downloading", version: "0.7.0" });
    expect(states.at(-1)).toEqual({ status: "downloading", version: "0.7.0" });

    fake.emit("update-downloaded", { version: "0.7.0" });
    download.resolve([]);
    await startup;
    subject.controller.close();
  });
});
