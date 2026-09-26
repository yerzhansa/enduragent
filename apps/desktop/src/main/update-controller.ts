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

export interface DesktopNativeUpdateSource {
  on(event: "update-downloaded", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  off(event: "update-downloaded", listener: () => void): unknown;
  off(event: "error", listener: (error: unknown) => void): unknown;
}

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
  zipReady: boolean;
  nativeReady: boolean;
  checkTimer?: TimerHandle;
  downloadStallTimer?: TimerHandle;
  downloadAbsoluteTimer?: TimerHandle;
  preparationTimer?: TimerHandle;
  errorListener?: () => void;
  progressListener?: (info: ProgressInfo) => void;
  downloadedListener?: (event: UpdateDownloadedEvent) => void;
  nativeDownloadedListener?: () => void;
  nativeErrorListener?: (error: unknown) => void;
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

export function desktopUpdateAutoInstallOnAppQuit(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

export function createDesktopUpdateController(input: {
  readonly releaseEligible: boolean;
  readonly currentVersion: string;
  readonly versionFloor: DesktopUpdateVersionFloor;
  readonly loadUpdater: () => Promise<DesktopAutoUpdater>;
  readonly nativeUpdater?: DesktopNativeUpdateSource;
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
  const nativeUpdater = input.nativeUpdater;
  const requiresNativePreparation = platform === "darwin";
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
  let readinessInvalidated = false;
  let readinessErrorListener: ((error: unknown) => void) | undefined;
  let floorVersion: string | undefined;
  let updaterInitialization: Promise<boolean> | undefined;
  const log = createSafeLog(input.log);

  const publish = (next: DesktopUpdateState): void => {
    if (closed) return;
    state = copyDesktopUpdateState(next);
    for (const listener of listeners) {
      try {
        listener(copyDesktopUpdateState(state));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
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
    key: "checkTimer" | "downloadStallTimer" | "downloadAbsoluteTimer" | "preparationTimer",
  ): void => {
    const handle = operation[key];
    if (handle === undefined) return;
    try {
      unscheduleTimeout(handle);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    operation[key] = undefined;
  };
  const scheduleOperationTimer = (
    operation: UpdateOperation,
    key: "checkTimer" | "downloadStallTimer" | "downloadAbsoluteTimer" | "preparationTimer",
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
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      operation.errorListener = undefined;
    }
    if (operation.progressListener !== undefined) {
      try {
        updater.off("download-progress", operation.progressListener);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      operation.progressListener = undefined;
    }
    if (operation.downloadedListener !== undefined) {
      try {
        updater.off("update-downloaded", operation.downloadedListener);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      operation.downloadedListener = undefined;
    }
    if (nativeUpdater !== undefined && operation.nativeDownloadedListener !== undefined) {
      try {
        nativeUpdater.off("update-downloaded", operation.nativeDownloadedListener);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      operation.nativeDownloadedListener = undefined;
    }
    if (nativeUpdater !== undefined && operation.nativeErrorListener !== undefined) {
      try {
        nativeUpdater.off("error", operation.nativeErrorListener);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      operation.nativeErrorListener = undefined;
    }
  };
  const detachReadinessWatch = (): void => {
    if (nativeUpdater === undefined || readinessErrorListener === undefined) return;
    try {
      nativeUpdater.off("error", readinessErrorListener);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    readinessErrorListener = undefined;
  };
  const armReadinessWatch = (): void => {
    if (!requiresNativePreparation || nativeUpdater === undefined) return;
    detachReadinessWatch();
    readinessErrorListener = (): void => {
      readinessInvalidated = true;
      log("desktop-update-readiness-invalidated");
      if (!closed && !installRequested && state.status === "downloaded") {
        publish({ status: "failed", stage: "download" });
      }
      detachReadinessWatch();
    };
    nativeUpdater.on("error", readinessErrorListener);
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
    clearOperationTimer(operation, "preparationTimer");
    removeOperationListeners(operation);
    if (cancel) {
      try {
        operation.cancellationToken?.cancel();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
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
  const publishIfReady = (operation: UpdateOperation): boolean => {
    if (!isCurrent(operation) || operation.targetVersion === undefined || !operation.zipReady) {
      return false;
    }
    if (requiresNativePreparation && !operation.nativeReady) return false;
    clearOperationTimer(operation, "preparationTimer");
    readinessInvalidated = false;
    publish({ status: "downloaded", version: operation.targetVersion });
    finishOperation(operation, false);
    armReadinessWatch();
    return true;
  };
  const noteZipReady = (operation: UpdateOperation): void => {
    if (!isCurrent(operation)) return;
    operation.zipReady = true;
    clearOperationTimer(operation, "downloadStallTimer");
    if (publishIfReady(operation) || !requiresNativePreparation || operation.nativeReady) return;
    scheduleOperationTimer(
      operation,
      "preparationTimer",
      () => {
        log("desktop-update-preparation-timeout");
        expireOperation(operation, "download");
      },
      DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
    );
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
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
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
        operation.zipReady ||
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
      noteZipReady(operation);
    };
    if (requiresNativePreparation) {
      if (nativeUpdater === undefined) {
        log("desktop-update-native-readiness-unavailable");
        failOperation(operation, "download");
        return;
      }
      operation.nativeDownloadedListener = (): void => {
        if (!isCurrent(operation) || operation.stage !== "download") return;
        operation.nativeReady = true;
        clearOperationTimer(operation, "preparationTimer");
        publishIfReady(operation);
      };
      operation.nativeErrorListener = (): void => {
        if (!isCurrent(operation)) return;
        log("desktop-update-native-rejected");
        failOperation(operation, "download");
      };
      nativeUpdater.on("update-downloaded", operation.nativeDownloadedListener);
      nativeUpdater.on("error", operation.nativeErrorListener);
    }
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
      zipReady: false,
      nativeReady: !requiresNativePreparation,
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
            } catch (error) {
              if (!(error instanceof Error)) throw error;
            }
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
          } catch (error) {
            if (!(error instanceof Error)) throw error;
          }
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
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      return active ? () => listeners.delete(listener) : () => {};
    },
    completeInstallAfterDrain(allowFinalQuit) {
      if (!installRequested || updater === undefined) return "not-requested";
      if (readinessInvalidated) return "failed";
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
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        intervalTimer = undefined;
      }
      listeners.clear();
      if (installRequested) return;
      detachReadinessWatch();
      const operation = activeOperation;
      if (operation !== undefined) {
        generation += 1;
        clearOperationTimer(operation, "checkTimer");
        clearOperationTimer(operation, "downloadStallTimer");
        clearOperationTimer(operation, "downloadAbsoluteTimer");
        clearOperationTimer(operation, "preparationTimer");
        removeOperationListeners(operation);
        try {
          operation.cancellationToken?.cancel();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        settleOperation(operation);
        activeOperation = undefined;
      }
    },
  };
}
