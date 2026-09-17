import type {
  AppUpdater,
  CancellationToken,
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
} from "electron-updater";
import {
  compareDesktopVersions,
  isDesktopUpdateAvailable,
  isStableDesktopVersion,
} from "./desktop-version.js";
import { createSafeLog } from "./safe-log.js";
import type {
  DesktopUpdateVersionFloor,
  DesktopUpdateVersionFloorResult,
} from "./update-version-floor.js";

export type DesktopUpdateState =
  | { readonly status: "disabled" }
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "current" }
  | { readonly status: "downloading"; readonly version: string }
  | { readonly status: "downloaded"; readonly version: string }
  | { readonly status: "installing"; readonly version: string }
  | { readonly status: "restart-required"; readonly stage: "check" | "download" }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

export type DesktopAutoUpdater = Pick<
  AppUpdater,
  | "logger"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "autoRunAppAfterInstall"
  | "allowPrerelease"
  | "allowDowngrade"
  | "disableWebInstaller"
  | "on"
  | "off"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
>;

export interface DesktopUpdateController {
  readonly state: () => DesktopUpdateState;
  readonly start: () => Promise<void>;
  readonly check: () => Promise<DesktopUpdateState>;
  readonly restart: () => DesktopUpdateState;
  readonly subscribe: (listener: (state: DesktopUpdateState) => void) => () => void;
  readonly completeInstallAfterDrain: (
    allowFinalQuit: () => void,
  ) => "started" | "not-requested" | "failed";
  readonly close: () => void;
}

interface TimerHandle {
  unref(): void;
}

interface UpdateOperation {
  readonly generation: number;
  readonly promise: Promise<DesktopUpdateState>;
  readonly resolve: (state: DesktopUpdateState) => void;
  stage: "check" | "download";
  settled: boolean;
  pendingCalls: number;
  targetVersion?: string;
  cancellationToken?: CancellationToken;
  lastTransferred: number;
  checkTimer?: TimerHandle;
  downloadStallTimer?: TimerHandle;
  downloadAbsoluteTimer?: TimerHandle;
  errorListener?: () => void;
  progressListener?: (info: ProgressInfo) => void;
  downloadedListener?: (event: UpdateDownloadedEvent) => void;
}

export const DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DESKTOP_UPDATE_CHECK_TIMEOUT_MS = 2 * 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1_000;

export function copyDesktopUpdateState(state: DesktopUpdateState): DesktopUpdateState {
  if ("version" in state) return { status: state.status, version: state.version };
  if (state.status === "failed" || state.status === "restart-required") {
    return { status: state.status, stage: state.stage };
  }
  return { status: state.status };
}

/**
 * MacUpdater feeds the downloaded zip to native Squirrel.Mac during download
 * only when `autoInstallOnAppQuit` is true. If false, that handoff waits until
 * `quitAndInstall`, which runs after our drain/`before-quit` preventDefault and
 * can hang forever on Restarting. Windows/Linux BaseUpdater would auto-install
 * on an ordinary quit when this is true, so those platforms keep it false.
 */
export function desktopUpdateAutoInstallOnAppQuit(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

export function createDesktopUpdateController(input: {
  readonly releaseEligible: boolean;
  readonly currentVersion: string;
  readonly versionFloor: DesktopUpdateVersionFloor;
  readonly loadUpdater: () => Promise<DesktopAutoUpdater>;
  readonly requestQuit: () => void;
  readonly platform?: NodeJS.Platform;
  readonly log?: (message: string) => void;
  readonly setInterval?: (callback: () => void, interval: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
  readonly setTimeout?: (callback: () => void, timeout: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}): DesktopUpdateController {
  const active = input.releaseEligible;
  const platform = input.platform ?? process.platform;
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const scheduleInterval =
    input.setInterval ??
    ((callback, interval) => globalThis.setInterval(callback, interval) as TimerHandle);
  const unscheduleInterval =
    input.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  const scheduleTimeout =
    input.setTimeout ??
    ((callback, timeout) => globalThis.setTimeout(callback, timeout) as TimerHandle);
  const unscheduleTimeout =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  let state: DesktopUpdateState = active ? { status: "idle" } : { status: "disabled" };
  let updater: DesktopAutoUpdater | undefined;
  let intervalTimer: TimerHandle | undefined;
  let started = false;
  let closed = false;
  let generation = 0;
  let activeOperation: UpdateOperation | undefined;
  let installRequested = false;
  let installInvoked = false;
  let floorVersion: string | undefined;
  let updaterInitialization: Promise<boolean> | undefined;
  const log = createSafeLog(input.log);

  const publish = (next: DesktopUpdateState): void => {
    if (closed) return;
    state = copyDesktopUpdateState(next);
    for (const listener of listeners) {
      try {
        listener(copyDesktopUpdateState(state));
      } catch {}
    }
  };

  const canCheck = (): boolean =>
    !closed &&
    active &&
    !["downloading", "downloaded", "installing", "restart-required"].includes(state.status);
  const isCurrent = (operation: UpdateOperation): boolean =>
    !closed && activeOperation === operation && operation.generation === generation;
  const currentState = (): DesktopUpdateState => copyDesktopUpdateState(state);
  const clearOperationTimer = (
    operation: UpdateOperation,
    key: "checkTimer" | "downloadStallTimer" | "downloadAbsoluteTimer",
  ): void => {
    const handle = operation[key];
    if (handle === undefined) return;
    try {
      unscheduleTimeout(handle);
    } catch {}
    operation[key] = undefined;
  };
  const scheduleOperationTimer = (
    operation: UpdateOperation,
    key: "checkTimer" | "downloadStallTimer" | "downloadAbsoluteTimer",
    callback: () => void,
    timeout: number,
  ): void => {
    clearOperationTimer(operation, key);
    const handle = scheduleTimeout(callback, timeout);
    operation[key] = handle;
    handle.unref();
  };
  const removeOperationListeners = (operation: UpdateOperation): void => {
    if (updater === undefined) return;
    if (operation.errorListener !== undefined) {
      try {
        updater.off("error", operation.errorListener);
      } catch {}
      operation.errorListener = undefined;
    }
    if (operation.progressListener !== undefined) {
      try {
        updater.off("download-progress", operation.progressListener);
      } catch {}
      operation.progressListener = undefined;
    }
    if (operation.downloadedListener !== undefined) {
      try {
        updater.off("update-downloaded", operation.downloadedListener);
      } catch {}
      operation.downloadedListener = undefined;
    }
  };
  const releaseOperationIfIdle = (operation: UpdateOperation): void => {
    if (
      operation.pendingCalls === 0 &&
      operation.generation !== generation &&
      activeOperation === operation
    ) {
      activeOperation = undefined;
    }
  };
  const settleOperation = (operation: UpdateOperation): void => {
    if (operation.settled) return;
    operation.settled = true;
    operation.resolve(currentState());
  };
  const finishOperation = (
    operation: UpdateOperation,
    cancel: boolean,
    detachPending = false,
  ): void => {
    clearOperationTimer(operation, "checkTimer");
    clearOperationTimer(operation, "downloadStallTimer");
    clearOperationTimer(operation, "downloadAbsoluteTimer");
    removeOperationListeners(operation);
    if (cancel) {
      try {
        operation.cancellationToken?.cancel();
      } catch {}
    }
    settleOperation(operation);
    if (isCurrent(operation)) generation += 1;
    if (detachPending && activeOperation === operation) {
      activeOperation = undefined;
      return;
    }
    releaseOperationIfIdle(operation);
  };
  const failOperation = (operation: UpdateOperation, stage: "check" | "download"): void => {
    if (!isCurrent(operation)) return;
    publish({ status: "failed", stage });
    finishOperation(operation, true);
  };
  const expireOperation = (operation: UpdateOperation, stage: "check" | "download"): void => {
    if (!isCurrent(operation)) return;
    publish({ status: "restart-required", stage });
    finishOperation(operation, true, true);
  };
  const operationCallSettled = (operation: UpdateOperation): void => {
    operation.pendingCalls -= 1;
    releaseOperationIfIdle(operation);
  };
  const completeDownload = (operation: UpdateOperation): void => {
    if (!isCurrent(operation) || operation.targetVersion === undefined) return;
    publish({ status: "downloaded", version: operation.targetVersion });
    finishOperation(operation, false);
  };
  const resetDownloadStallTimer = (operation: UpdateOperation): void => {
    scheduleOperationTimer(
      operation,
      "downloadStallTimer",
      () => expireOperation(operation, "download"),
      DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
    );
  };
  const beginDownload = (operation: UpdateOperation, result: UpdateCheckResult): void => {
    if (!isCurrent(operation)) {
      try {
        result.cancellationToken?.cancel();
      } catch {}
      return;
    }
    const version = result.updateInfo.version;
    operation.stage = "download";
    operation.targetVersion = version;
    operation.cancellationToken = result.cancellationToken;
    operation.lastTransferred = 0;
    clearOperationTimer(operation, "checkTimer");
    publish({ status: "downloading", version });
    operation.progressListener = (info): void => {
      if (
        !isCurrent(operation) ||
        operation.stage !== "download" ||
        !Number.isFinite(info.transferred) ||
        info.transferred <= operation.lastTransferred
      ) {
        return;
      }
      operation.lastTransferred = info.transferred;
      resetDownloadStallTimer(operation);
    };
    operation.downloadedListener = (event): void => {
      if (!isCurrent(operation) || operation.stage !== "download") return;
      if (event.version !== operation.targetVersion) {
        failOperation(operation, "download");
        return;
      }
      completeDownload(operation);
    };
    updater!.on("download-progress", operation.progressListener);
    updater!.on("update-downloaded", operation.downloadedListener);
    resetDownloadStallTimer(operation);
    scheduleOperationTimer(
      operation,
      "downloadAbsoluteTimer",
      () => expireOperation(operation, "download"),
      DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    );
    operation.pendingCalls += 1;
    let download: Promise<readonly string[]>;
    try {
      download = updater!.downloadUpdate(operation.cancellationToken);
    } catch {
      operationCallSettled(operation);
      failOperation(operation, "download");
      return;
    }
    void download
      .then(
        () => operationCallSettled(operation),
        () => {
          operationCallSettled(operation);
          failOperation(operation, "download");
        },
      )
      .catch(() => failOperation(operation, "download"));
  };

  const runCheck = (): Promise<DesktopUpdateState> => {
    if (activeOperation !== undefined) return activeOperation.promise;
    if (!canCheck() || updater === undefined) return Promise.resolve(currentState());
    let resolveOperation!: (state: DesktopUpdateState) => void;
    const operation: UpdateOperation = {
      generation: ++generation,
      promise: new Promise((resolve) => {
        resolveOperation = resolve;
      }),
      resolve: (next) => resolveOperation(copyDesktopUpdateState(next)),
      stage: "check",
      settled: false,
      pendingCalls: 1,
      lastTransferred: 0,
    };
    activeOperation = operation;
    publish({ status: "checking" });
    operation.errorListener = (): void => failOperation(operation, operation.stage);
    updater.on("error", operation.errorListener);
    scheduleOperationTimer(
      operation,
      "checkTimer",
      () => expireOperation(operation, "check"),
      DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
    );
    let pending: Promise<UpdateCheckResult | null>;
    try {
      pending = updater.checkForUpdates();
    } catch {
      operationCallSettled(operation);
      failOperation(operation, "check");
      return operation.promise;
    }
    void pending
      .then(
        (result) => {
          operationCallSettled(operation);
          if (!isCurrent(operation)) {
            try {
              result?.cancellationToken?.cancel();
            } catch {}
            return;
          }
          const version = result?.updateInfo.version;
          if (
            result?.isUpdateAvailable !== true ||
            !isStableDesktopVersion(version) ||
            !isDesktopUpdateAvailable(version, input.currentVersion)
          ) {
            publish({ status: "current" });
            finishOperation(operation, false);
            return;
          }
          if (floorVersion === undefined) {
            operation.cancellationToken = result.cancellationToken;
            log("desktop-update-version-floor-unavailable");
            publish({ status: "failed", stage: "check" });
            finishOperation(operation, true);
            return;
          }
          const floorComparison = compareDesktopVersions(version, floorVersion);
          if (floorComparison === null || floorComparison < 0) {
            operation.cancellationToken = result.cancellationToken;
            log(`desktop-update-downgrade-refused candidate=${version} floor=${floorVersion}`);
            publish({ status: "failed", stage: "check" });
            finishOperation(operation, true);
            return;
          }
          beginDownload(operation, result);
        },
        () => {
          operationCallSettled(operation);
          failOperation(operation, "check");
        },
      )
      .catch(() => failOperation(operation, "check"));
    return operation.promise;
  };

  const initializeUpdater = (): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    if (updater !== undefined) return Promise.resolve(true);
    if (updaterInitialization !== undefined) return updaterInitialization;
    const attempt = (async (): Promise<boolean> => {
      if (floorVersion === undefined) {
        let recordedFloor: DesktopUpdateVersionFloorResult;
        try {
          recordedFloor = await input.versionFloor.recordRunningVersion(input.currentVersion);
        } catch {
          recordedFloor = { status: "unavailable" };
        }
        if (closed) return false;
        if (recordedFloor.status !== "ready") {
          log("desktop-update-version-floor-unavailable");
          if (active) publish({ status: "failed", stage: "check" });
          return false;
        }
        if (!isStableDesktopVersion(recordedFloor.version)) {
          log("desktop-update-version-floor-unavailable");
          if (active) publish({ status: "failed", stage: "check" });
          return false;
        }
        floorVersion = recordedFloor.version;
      }
      if (!active) return false;
      try {
        updater = await input.loadUpdater();
      } catch {
        if (!closed) publish({ status: "restart-required", stage: "check" });
        return false;
      }
      if (closed) return false;
      try {
        updater.logger = null;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = desktopUpdateAutoInstallOnAppQuit(platform);
        updater.autoRunAppAfterInstall = true;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableWebInstaller = true;
        intervalTimer = scheduleInterval(() => {
          void check();
        }, DESKTOP_UPDATE_INTERVAL_MS);
        intervalTimer.unref();
      } catch {
        if (intervalTimer !== undefined) {
          try {
            unscheduleInterval(intervalTimer);
          } catch {}
          intervalTimer = undefined;
        }
        if (!closed) publish({ status: "failed", stage: "check" });
        return false;
      }
      return true;
    })();
    updaterInitialization = attempt;
    void attempt.then(
      () => {
        if (updaterInitialization === attempt) updaterInitialization = undefined;
      },
      () => {
        if (updaterInitialization === attempt) updaterInitialization = undefined;
      },
    );
    return attempt;
  };

  const check = (): Promise<DesktopUpdateState> => {
    if (activeOperation !== undefined) return activeOperation.promise;
    if (!canCheck()) return Promise.resolve(currentState());
    if (updater !== undefined) return runCheck();
    return initializeUpdater().then((ready) => (ready ? runCheck() : currentState()));
  };

  const start = async (): Promise<void> => {
    if (started || closed) return;
    started = true;
    if (!(await initializeUpdater())) return;
    await runCheck();
  };

  return {
    state: () => currentState(),
    start,
    check,
    restart() {
      if (closed || state.status !== "downloaded" || installRequested) {
        return currentState();
      }
      installRequested = true;
      publish({ status: "installing", version: state.version });
      input.requestQuit();
      return currentState();
    },
    subscribe(listener) {
      if (closed) return () => {};
      if (active) listeners.add(listener);
      try {
        listener(currentState());
      } catch {}
      return active ? () => listeners.delete(listener) : () => {};
    },
    completeInstallAfterDrain(allowFinalQuit) {
      if (!installRequested || updater === undefined) return "not-requested";
      if (installInvoked) return "started";
      installInvoked = true;
      try {
        allowFinalQuit();
        updater.quitAndInstall(false, true);
        return "started";
      } catch {
        return "failed";
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (intervalTimer !== undefined) {
        try {
          unscheduleInterval(intervalTimer);
        } catch {}
        intervalTimer = undefined;
      }
      const operation = activeOperation;
      if (operation !== undefined) {
        generation += 1;
        clearOperationTimer(operation, "checkTimer");
        clearOperationTimer(operation, "downloadStallTimer");
        clearOperationTimer(operation, "downloadAbsoluteTimer");
        removeOperationListeners(operation);
        try {
          operation.cancellationToken?.cancel();
        } catch {}
        settleOperation(operation);
        activeOperation = undefined;
      }
      listeners.clear();
    },
  };
}
