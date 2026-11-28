import type {
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
import {
  DESKTOP_UPDATE_PROGRESS_THROTTLE_MS,
  advanceDownloadTransfer,
  copyDesktopUpdateState,
  desktopUpdateAutoInstallOnAppQuit,
  isActiveOperation,
  normalizeDownloadProgress,
  projectPhaseState,
  shouldPublishProgress,
  type ActiveOperationPhase,
  type CheckingPhase,
  type ControllerPhase,
  type DesktopAutoUpdater,
  type DesktopNativeUpdateSource,
  type DesktopUpdateController,
  type DesktopUpdateDownloadProgress,
  type DesktopUpdateState,
  type DownloadingPhase,
  type InstallHandoff,
  type PreparingPhase,
  type TimerHandle,
} from "./update-state-machine.js";
import type {
  DesktopUpdateVersionFloor,
  DesktopUpdateVersionFloorResult,
} from "./update-version-floor.js";

export {
  DESKTOP_UPDATE_PROGRESS_THROTTLE_MS,
  copyDesktopUpdateState,
  desktopUpdateAutoInstallOnAppQuit,
};
export type {
  DesktopAutoUpdater,
  DesktopNativeUpdateSource,
  DesktopUpdateController,
  DesktopUpdateDownloadProgress,
  DesktopUpdateState,
};

export const DESKTOP_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DESKTOP_UPDATE_CHECK_TIMEOUT_MS = 2 * 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1_000;

export function createDesktopUpdateController(input: {
  readonly releaseEligible: boolean;
  readonly currentVersion: string;
  readonly versionFloor: DesktopUpdateVersionFloor;
  readonly loadUpdater: () => Promise<DesktopAutoUpdater>;
  readonly nativeUpdater?: DesktopNativeUpdateSource;
  readonly requestQuit: () => void;
  readonly platform?: NodeJS.Platform;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, interval: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
  readonly setTimeout?: (callback: () => void, timeout: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}): DesktopUpdateController {
  const active = input.releaseEligible;
  const platform = input.platform ?? process.platform;
  const nativeUpdater = input.nativeUpdater;
  const requiresNativePreparation = platform === "darwin";
  const now = input.now ?? Date.now;
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
  const log = createSafeLog(input.log);

  let phase: ControllerPhase = active ? { kind: "idle", status: "idle" } : { kind: "disabled" };
  let updater: DesktopAutoUpdater | undefined;
  let intervalTimer: TimerHandle | undefined;
  let started = false;
  let generation = 0;
  let floorVersion: string | undefined;
  let updaterInitialization: Promise<boolean> | undefined;

  const runQuietly = (action: () => void, diagnostic: string): void => {
    try {
      action();
    } catch {
      log(diagnostic);
    }
  };

  const currentState = (): DesktopUpdateState => copyDesktopUpdateState(projectPhaseState(phase));

  const publish = (next: DesktopUpdateState): void => {
    if (phase.kind === "closed") return;
    const snapshot = copyDesktopUpdateState(next);
    for (const listener of listeners) {
      runQuietly(
        () => listener(copyDesktopUpdateState(snapshot)),
        "desktop-update-listener-failed",
      );
    }
  };

  const canCheck = (): boolean =>
    active &&
    phase.kind !== "closed" &&
    phase.kind !== "downloading" &&
    phase.kind !== "preparing" &&
    phase.kind !== "ready" &&
    phase.kind !== "installing" &&
    phase.kind !== "restart-required";

  const isCurrent = (expectedGeneration: number): boolean =>
    phase.kind !== "closed" &&
    isActiveOperation(phase) &&
    phase.generation === expectedGeneration &&
    expectedGeneration === generation;

  const clearTimer = (handle: TimerHandle | undefined): undefined => {
    if (handle !== undefined) {
      runQuietly(() => unscheduleTimeout(handle), "desktop-update-timer-cleanup-failed");
    }
    return undefined;
  };

  const startTimer = (callback: () => void, timeout: number): TimerHandle => {
    const handle = scheduleTimeout(callback, timeout);
    handle.unref();
    return handle;
  };

  const isClosed = (): boolean => phase.kind === "closed";

  const detachUpdaterError = (listener: (() => void) | undefined): undefined => {
    if (updater !== undefined && listener !== undefined) {
      runQuietly(() => updater?.off("error", listener), "desktop-update-error-detach-failed");
    }
    return undefined;
  };

  const detachUpdaterProgress = (
    listener: ((info: ProgressInfo) => void) | undefined,
  ): undefined => {
    if (updater !== undefined && listener !== undefined) {
      runQuietly(
        () => updater?.off("download-progress", listener),
        "desktop-update-download-progress-detach-failed",
      );
    }
    return undefined;
  };

  const detachUpdaterDownloaded = (
    listener: ((event: UpdateDownloadedEvent) => void) | undefined,
  ): undefined => {
    if (updater !== undefined && listener !== undefined) {
      runQuietly(
        () => updater?.off("update-downloaded", listener),
        "desktop-update-update-downloaded-detach-failed",
      );
    }
    return undefined;
  };

  const detachNativeDownloaded = (listener: (() => void) | undefined): undefined => {
    if (nativeUpdater !== undefined && listener !== undefined) {
      runQuietly(
        () => nativeUpdater.off("update-downloaded", listener),
        "desktop-update-native-update-downloaded-detach-failed",
      );
    }
    return undefined;
  };

  const detachNativeError = (listener: ((error: unknown) => void) | undefined): undefined => {
    if (nativeUpdater !== undefined && listener !== undefined) {
      runQuietly(
        () => nativeUpdater.off("error", listener),
        "desktop-update-native-error-detach-failed",
      );
    }
    return undefined;
  };

  const clearPeriodicCheck = (): void => {
    if (intervalTimer === undefined) return;
    const handle = intervalTimer;
    intervalTimer = undefined;
    runQuietly(() => unscheduleInterval(handle), "desktop-update-interval-cleanup-failed");
  };

  const ensurePeriodicCheckScheduled = (): void => {
    if (!active || phase.kind === "closed" || intervalTimer !== undefined) return;
    const handle = scheduleInterval(() => {
      void check();
    }, DESKTOP_UPDATE_INTERVAL_MS);
    intervalTimer = handle;
    handle.unref();
  };

  const cleanupOperationResources = (
    operation: ActiveOperationPhase,
    cancel: boolean,
    extraToken?: CancellationToken,
  ): void => {
    operation.errorListener = detachUpdaterError(operation.errorListener);
    if (operation.kind === "checking") {
      operation.checkTimer = clearTimer(operation.checkTimer);
    } else if (operation.kind === "downloading") {
      operation.stallTimer = clearTimer(operation.stallTimer);
      operation.absoluteTimer = clearTimer(operation.absoluteTimer);
      operation.progressListener = detachUpdaterProgress(operation.progressListener);
      operation.downloadedListener = detachUpdaterDownloaded(operation.downloadedListener);
    } else {
      operation.preparationTimer = clearTimer(operation.preparationTimer);
      operation.absoluteTimer = clearTimer(operation.absoluteTimer);
      operation.nativeDownloadedListener = detachNativeDownloaded(
        operation.nativeDownloadedListener,
      );
      operation.nativeErrorListener = detachNativeError(operation.nativeErrorListener);
    }
    if (cancel) {
      const token =
        extraToken ?? (operation.kind !== "checking" ? operation.cancellationToken : undefined);
      if (token !== undefined) runQuietly(() => token.cancel(), "desktop-update-cancel-failed");
    }
  };

  const failHandoff = (handoff: InstallHandoff, invalidateReadiness: boolean): void => {
    if (invalidateReadiness) handoff.readinessInvalidated = true;
    handoff.readinessErrorListener = detachNativeError(handoff.readinessErrorListener);
    handoff.installErrorListener = detachUpdaterError(handoff.installErrorListener);
    const notify = handoff.status === "started" ? handoff.onInstallError : undefined;
    handoff.onInstallError = undefined;
    handoff.status = "failed";
    notify?.();
  };

  const finishActivePhase = (
    expectedGeneration: number,
    nextPhase: ControllerPhase,
    options: {
      readonly cancel: boolean;
      readonly extraToken?: CancellationToken;
      readonly beforePublish?: () => void;
    },
  ): void => {
    if (!isCurrent(expectedGeneration) || !isActiveOperation(phase)) return;
    const operation = phase;
    cleanupOperationResources(operation, options.cancel, options.extraToken);
    generation += 1;
    phase = nextPhase;
    if (nextPhase.kind === "restart-required") clearPeriodicCheck();
    options.beforePublish?.();
    const published = currentState();
    publish(published);
    operation.resolve(published);
  };

  const failOperation = (
    expectedGeneration: number,
    stage: "check" | "download",
    extraToken?: CancellationToken,
  ): void => {
    finishActivePhase(expectedGeneration, { kind: "failed", stage }, { cancel: true, extraToken });
  };

  const expireOperation = (expectedGeneration: number, stage: "check" | "download"): void => {
    finishActivePhase(expectedGeneration, { kind: "restart-required", stage }, { cancel: true });
  };

  const armReadinessWatch = (): void => {
    if (!requiresNativePreparation || nativeUpdater === undefined || phase.kind !== "ready") return;
    const readyPhase = phase;
    readyPhase.readinessErrorListener = detachNativeError(readyPhase.readinessErrorListener);
    const listener = (): void => {
      log("desktop-update-readiness-invalidated");
      detachNativeError(listener);
      if (phase.kind === "ready" && phase.readinessErrorListener === listener) {
        phase.readinessErrorListener = undefined;
        phase = { kind: "failed", stage: "download" };
        publish(currentState());
        return;
      }
      const handoff = activeHandoff();
      if (handoff !== undefined && handoff.readinessErrorListener === listener) {
        failHandoff(handoff, true);
      }
    };
    readyPhase.readinessErrorListener = listener;
    nativeUpdater.on("error", listener);
  };

  const publishReady = (expectedGeneration: number, version: string): void => {
    finishActivePhase(
      expectedGeneration,
      { kind: "ready", version },
      { cancel: false, beforePublish: armReadinessWatch },
    );
  };

  const enterPreparing = (expectedGeneration: number): void => {
    if (!isCurrent(expectedGeneration) || phase.kind !== "downloading") return;
    const downloading = phase;
    if (!requiresNativePreparation) {
      publishReady(expectedGeneration, downloading.version);
      return;
    }
    if (nativeUpdater === undefined) {
      log("desktop-update-native-readiness-unavailable");
      failOperation(expectedGeneration, "download");
      return;
    }
    downloading.stallTimer = clearTimer(downloading.stallTimer);
    downloading.progressListener = detachUpdaterProgress(downloading.progressListener);
    downloading.downloadedListener = detachUpdaterDownloaded(downloading.downloadedListener);
    const preparing: PreparingPhase = {
      kind: "preparing",
      generation: downloading.generation,
      version: downloading.version,
      promise: downloading.promise,
      resolve: downloading.resolve,
      cancellationToken: downloading.cancellationToken,
      absoluteTimer: downloading.absoluteTimer,
      errorListener: downloading.errorListener,
    };
    phase = preparing;
    publish(currentState());
    if (!isCurrent(expectedGeneration) || phase.kind !== "preparing") return;
    preparing.nativeDownloadedListener = (): void => {
      if (!isCurrent(expectedGeneration) || phase.kind !== "preparing") return;
      publishReady(expectedGeneration, phase.version);
    };
    preparing.nativeErrorListener = (): void => {
      if (!isCurrent(expectedGeneration) || phase.kind !== "preparing") return;
      log("desktop-update-native-rejected");
      failOperation(expectedGeneration, "download");
    };
    nativeUpdater.on("update-downloaded", preparing.nativeDownloadedListener);
    nativeUpdater.on("error", preparing.nativeErrorListener);
    preparing.preparationTimer = startTimer(() => {
      if (!isCurrent(expectedGeneration)) return;
      log("desktop-update-preparation-timeout");
      expireOperation(expectedGeneration, "download");
    }, DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
  };

  const resetDownloadStallTimer = (downloading: DownloadingPhase): void => {
    downloading.stallTimer = clearTimer(downloading.stallTimer);
    downloading.stallTimer = startTimer(
      () => expireOperation(downloading.generation, "download"),
      DESKTOP_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS,
    );
  };

  const beginDownload = (
    expectedGeneration: number,
    activeUpdater: DesktopAutoUpdater,
    result: UpdateCheckResult,
  ): void => {
    if (!isCurrent(expectedGeneration) || phase.kind !== "checking") {
      if (result.cancellationToken !== undefined) {
        runQuietly(() => result.cancellationToken?.cancel(), "desktop-update-cancel-failed");
      }
      return;
    }
    if (requiresNativePreparation && nativeUpdater === undefined) {
      log("desktop-update-native-readiness-unavailable");
      failOperation(expectedGeneration, "download", result.cancellationToken);
      return;
    }
    const checking = phase;
    checking.checkTimer = clearTimer(checking.checkTimer);
    checking.errorListener = detachUpdaterError(checking.errorListener);
    const downloading: DownloadingPhase = {
      kind: "downloading",
      generation: checking.generation,
      version: result.updateInfo.version,
      promise: checking.promise,
      resolve: checking.resolve,
      cancellationToken: result.cancellationToken,
      lastTransferred: 0,
    };
    phase = downloading;
    publish(currentState());
    if (!isCurrent(expectedGeneration) || phase.kind !== "downloading") {
      if (!isClosed() && result.cancellationToken !== undefined) {
        runQuietly(() => result.cancellationToken?.cancel(), "desktop-update-cancel-failed");
      }
      return;
    }
    downloading.errorListener = (): void => failOperation(expectedGeneration, "download");
    downloading.progressListener = (info): void => {
      if (!isCurrent(expectedGeneration) || phase.kind !== "downloading") return;
      const hadPublishedProgress = downloading.lastPublishedProgress !== undefined;
      const advanced = advanceDownloadTransfer(downloading, info);
      if (!advanced) {
        if (hadPublishedProgress && downloading.lastPublishedProgress === undefined) {
          publish(currentState());
        }
        return;
      }
      resetDownloadStallTimer(downloading);
      const progress = normalizeDownloadProgress(
        info,
        downloading.lastPublishedProgress?.percent ?? 0,
      );
      if (progress === undefined) {
        if (hadPublishedProgress && downloading.lastPublishedProgress === undefined) {
          publish(currentState());
        }
        return;
      }
      const timestamp = now();
      if (!shouldPublishProgress(downloading, progress, timestamp)) return;
      downloading.lastProgressPublishedAt = timestamp;
      downloading.lastPublishedProgress = progress;
      publish(currentState());
    };
    downloading.downloadedListener = (event): void => {
      if (!isCurrent(expectedGeneration) || phase.kind !== "downloading") return;
      if (event.version !== downloading.version) {
        failOperation(expectedGeneration, "download");
        return;
      }
      enterPreparing(expectedGeneration);
    };
    activeUpdater.on("error", downloading.errorListener);
    activeUpdater.on("download-progress", downloading.progressListener);
    activeUpdater.on("update-downloaded", downloading.downloadedListener);
    resetDownloadStallTimer(downloading);
    downloading.absoluteTimer = startTimer(
      () => expireOperation(expectedGeneration, "download"),
      DESKTOP_UPDATE_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    );
    let download: Promise<readonly string[]>;
    try {
      download = activeUpdater.downloadUpdate(downloading.cancellationToken);
    } catch {
      failOperation(expectedGeneration, "download");
      return;
    }
    void download.then(
      () => undefined,
      () => failOperation(expectedGeneration, "download"),
    );
  };

  const runCheck = (activeUpdater: DesktopAutoUpdater): Promise<DesktopUpdateState> => {
    if (isActiveOperation(phase)) return phase.promise;
    if (!canCheck()) return Promise.resolve(currentState());
    let resolveOperation!: (state: DesktopUpdateState) => void;
    const promise = new Promise<DesktopUpdateState>((resolve) => {
      resolveOperation = resolve;
    });
    const operationGeneration = ++generation;
    const checking: CheckingPhase = {
      kind: "checking",
      generation: operationGeneration,
      promise,
      resolve: (next) => resolveOperation(copyDesktopUpdateState(next)),
    };
    phase = checking;
    publish(currentState());
    if (!isCurrent(operationGeneration) || phase.kind !== "checking") return promise;
    checking.errorListener = (): void => failOperation(operationGeneration, "check");
    activeUpdater.on("error", checking.errorListener);
    checking.checkTimer = startTimer(
      () => expireOperation(operationGeneration, "check"),
      DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
    );
    let pending: Promise<UpdateCheckResult | null>;
    try {
      pending = activeUpdater.checkForUpdates();
    } catch {
      failOperation(operationGeneration, "check");
      return promise;
    }
    void pending.then(
      (result) => {
        if (!isCurrent(operationGeneration) || phase.kind !== "checking") {
          if (result?.cancellationToken !== undefined) {
            runQuietly(() => result.cancellationToken?.cancel(), "desktop-update-cancel-failed");
          }
          return;
        }
        const version = result?.updateInfo.version;
        if (
          result?.isUpdateAvailable !== true ||
          !isStableDesktopVersion(version) ||
          !isDesktopUpdateAvailable(version, input.currentVersion)
        ) {
          finishActivePhase(
            operationGeneration,
            { kind: "idle", status: "current" },
            { cancel: false },
          );
          return;
        }
        if (floorVersion === undefined) {
          log("desktop-update-version-floor-unavailable");
          failOperation(operationGeneration, "check", result.cancellationToken);
          return;
        }
        const floorComparison = compareDesktopVersions(version, floorVersion);
        if (floorComparison === null || floorComparison < 0) {
          log(`desktop-update-downgrade-refused candidate=${version} floor=${floorVersion}`);
          failOperation(operationGeneration, "check", result.cancellationToken);
          return;
        }
        beginDownload(operationGeneration, activeUpdater, result);
      },
      () => failOperation(operationGeneration, "check"),
    );
    return promise;
  };

  const initializeUpdater = (): Promise<boolean> => {
    if (phase.kind === "closed" || phase.kind === "restart-required") return Promise.resolve(false);
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
        if (isClosed()) return false;
        if (recordedFloor.status !== "ready" || !isStableDesktopVersion(recordedFloor.version)) {
          log("desktop-update-version-floor-unavailable");
          if (active) {
            runQuietly(ensurePeriodicCheckScheduled, "desktop-update-interval-schedule-failed");
            phase = { kind: "failed", stage: "check" };
            publish(currentState());
          }
          return false;
        }
        floorVersion = recordedFloor.version;
      }
      if (!active) return false;
      let loaded: DesktopAutoUpdater;
      try {
        loaded = await input.loadUpdater();
      } catch {
        clearPeriodicCheck();
        if (!isClosed()) {
          phase = { kind: "restart-required", stage: "check" };
          publish(currentState());
        }
        return false;
      }
      if (isClosed()) return false;
      try {
        loaded.logger = null;
        loaded.autoDownload = false;
        loaded.autoInstallOnAppQuit = desktopUpdateAutoInstallOnAppQuit(platform);
        loaded.autoRunAppAfterInstall = true;
        loaded.allowPrerelease = false;
        loaded.allowDowngrade = false;
        loaded.disableWebInstaller = true;
        ensurePeriodicCheckScheduled();
      } catch {
        clearPeriodicCheck();
        if (!isClosed()) {
          phase = { kind: "failed", stage: "check" };
          publish(currentState());
          runQuietly(ensurePeriodicCheckScheduled, "desktop-update-interval-schedule-failed");
        }
        return false;
      }
      updater = loaded;
      return true;
    })();
    updaterInitialization = attempt;
    void attempt.finally(() => {
      if (updaterInitialization === attempt) updaterInitialization = undefined;
    });
    return attempt;
  };

  const check = (): Promise<DesktopUpdateState> => {
    if (isActiveOperation(phase)) return phase.promise;
    if (!canCheck()) return Promise.resolve(currentState());
    if (updater !== undefined) return runCheck(updater);
    return initializeUpdater().then((ready) =>
      ready && updater !== undefined ? runCheck(updater) : currentState(),
    );
  };

  const start = async (): Promise<void> => {
    if (started || phase.kind === "closed") return;
    started = true;
    if (!(await initializeUpdater()) || updater === undefined) return;
    await runCheck(updater);
  };

  const activeHandoff = (): InstallHandoff | undefined => {
    if (phase.kind === "installing") return phase;
    if (phase.kind === "closed") return phase.installing;
    return undefined;
  };

  return {
    state: () => currentState(),
    start,
    check,
    isInstallRequested: () => activeHandoff() !== undefined,
    restart() {
      if (phase.kind !== "ready") return currentState();
      const handoff: InstallHandoff = {
        version: phase.version,
        status: "pending",
        readinessInvalidated: false,
        readinessErrorListener: phase.readinessErrorListener,
      };
      phase = { kind: "installing", ...handoff };
      publish(currentState());
      input.requestQuit();
      return currentState();
    },
    subscribe(listener) {
      if (phase.kind !== "closed" && active) listeners.add(listener);
      runQuietly(() => listener(currentState()), "desktop-update-listener-failed");
      return () => {
        listeners.delete(listener);
      };
    },
    completeInstallAfterDrain(allowFinalQuit, onInstallError) {
      const handoff = activeHandoff();
      if (handoff === undefined || updater === undefined) return "not-requested";
      if (handoff.readinessInvalidated || handoff.status === "failed") {
        failHandoff(handoff, false);
        return "failed";
      }
      if (handoff.status === "started" || handoff.status === "invoking") return "started";
      handoff.status = "invoking";
      handoff.onInstallError = onInstallError;
      const installErrorListener = (): void => {
        failHandoff(handoff, false);
      };
      try {
        handoff.installErrorListener = installErrorListener;
        updater.on("error", installErrorListener);
        allowFinalQuit();
        updater.quitAndInstall(false, true);
      } catch {
        failHandoff(handoff, false);
        return "failed";
      }
      if (handoff.status !== "invoking") return "failed";
      handoff.status = "started";
      return "started";
    },
    close() {
      if (phase.kind === "closed") return;
      const lastState = currentState();
      clearPeriodicCheck();
      listeners.clear();
      if (phase.kind === "installing") {
        phase = { kind: "closed", lastState, installing: phase };
        return;
      }
      if (phase.kind === "ready") {
        phase.readinessErrorListener = detachNativeError(phase.readinessErrorListener);
        phase = { kind: "closed", lastState };
        return;
      }
      if (isActiveOperation(phase)) {
        const operation = phase;
        generation += 1;
        cleanupOperationResources(operation, true);
        phase = { kind: "closed", lastState };
        operation.resolve(lastState);
        return;
      }
      phase = { kind: "closed", lastState };
    },
  };
}
