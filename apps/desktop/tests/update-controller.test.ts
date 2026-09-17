import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateController,
  desktopUpdateAutoInstallOnAppQuit,
  DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
  DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
  DESKTOP_UPDATE_INTERVAL_MS,
  type DesktopAutoUpdater,
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

  it.each([
    "0.1.0",
    "0.0.9",
    "0.1.1-beta.1",
    "0.01.1",
    "0.1.9007199254740992",
    "not-a-version",
  ])(
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
});
