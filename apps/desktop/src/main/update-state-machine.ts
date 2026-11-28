import type {
  AppUpdater,
  CancellationToken,
  ProgressInfo,
  UpdateDownloadedEvent,
} from "electron-updater";

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
  readonly isInstallRequested?: () => boolean;
  readonly completeInstallAfterDrain: (
    allowFinalQuit: () => void,
    onInstallError?: () => void,
  ) => "started" | "not-requested" | "failed";
  readonly close: () => void;
}

export interface TimerHandle {
  unref(): void;
}

export interface CheckingPhase {
  readonly kind: "checking";
  readonly generation: number;
  readonly promise: Promise<DesktopUpdateState>;
  readonly resolve: (state: DesktopUpdateState) => void;
  checkTimer?: TimerHandle;
  errorListener?: () => void;
}

export interface DownloadingPhase {
  readonly kind: "downloading";
  readonly generation: number;
  readonly version: string;
  readonly promise: Promise<DesktopUpdateState>;
  readonly resolve: (state: DesktopUpdateState) => void;
  readonly cancellationToken?: CancellationToken;
  lastTransferred: number;
  lastTotal?: number;
  stallTimer?: TimerHandle;
  absoluteTimer?: TimerHandle;
  errorListener?: () => void;
  progressListener?: (info: ProgressInfo) => void;
  downloadedListener?: (event: UpdateDownloadedEvent) => void;
}

export interface PreparingPhase {
  readonly kind: "preparing";
  readonly generation: number;
  readonly version: string;
  readonly promise: Promise<DesktopUpdateState>;
  readonly resolve: (state: DesktopUpdateState) => void;
  readonly cancellationToken?: CancellationToken;
  preparationTimer?: TimerHandle;
  absoluteTimer?: TimerHandle;
  errorListener?: () => void;
  nativeDownloadedListener?: () => void;
  nativeErrorListener?: (error: unknown) => void;
}

export type InstallHandoffStatus = "pending" | "invoking" | "started" | "failed";

export interface InstallHandoff {
  readonly version: string;
  status: InstallHandoffStatus;
  readinessInvalidated: boolean;
  readinessErrorListener?: (error: unknown) => void;
  installErrorListener?: () => void;
  onInstallError?: () => void;
}

export type ActiveOperationPhase = CheckingPhase | DownloadingPhase | PreparingPhase;

export type ControllerPhase =
  | { readonly kind: "disabled" }
  | { readonly kind: "idle"; readonly status: "idle" | "current" }
  | { readonly kind: "failed"; readonly stage: "check" | "download" }
  | ActiveOperationPhase
  | {
      readonly kind: "ready";
      readonly version: string;
      readinessErrorListener?: (error: unknown) => void;
    }
  | ({ readonly kind: "installing" } & InstallHandoff)
  | { readonly kind: "restart-required"; readonly stage: "check" | "download" }
  | {
      readonly kind: "closed";
      readonly lastState: DesktopUpdateState;
      readonly installing?: InstallHandoff;
    };

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

export function projectPhaseState(phase: ControllerPhase): DesktopUpdateState {
  switch (phase.kind) {
    case "disabled":
      return { status: "disabled" };
    case "idle":
      return { status: phase.status };
    case "failed":
      return { status: "failed", stage: phase.stage };
    case "checking":
      return { status: "checking" };
    case "downloading":
    case "preparing":
      return { status: "downloading", version: phase.version };
    case "ready":
      return { status: "downloaded", version: phase.version };
    case "installing":
      return { status: "installing", version: phase.version };
    case "restart-required":
      return { status: "restart-required", stage: phase.stage };
    case "closed":
      return copyDesktopUpdateState(phase.lastState);
  }
}

export function isActiveOperation(phase: ControllerPhase): phase is ActiveOperationPhase {
  return phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "preparing";
}

export function advanceDownloadTransfer(
  downloading: Pick<DownloadingPhase, "lastTransferred" | "lastTotal">,
  info: Pick<ProgressInfo, "transferred"> & { readonly total?: number },
): boolean {
  if (!Number.isFinite(info.transferred) || info.transferred < 0) return false;
  const nextTotal =
    typeof info.total === "number" && Number.isFinite(info.total) && info.total > 0
      ? info.total
      : undefined;
  const totalChanged =
    nextTotal !== undefined &&
    downloading.lastTotal !== undefined &&
    nextTotal !== downloading.lastTotal;
  if (totalChanged || info.transferred < downloading.lastTransferred) {
    downloading.lastTransferred = info.transferred;
    downloading.lastTotal = nextTotal;
    return info.transferred > 0;
  }
  if (info.transferred <= downloading.lastTransferred) return false;
  downloading.lastTransferred = info.transferred;
  if (nextTotal !== undefined) downloading.lastTotal = nextTotal;
  return true;
}
