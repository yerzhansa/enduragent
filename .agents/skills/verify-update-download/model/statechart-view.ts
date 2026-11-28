// Plain-language view for reading UpdateDownload.tla results with /statechart.

interface Vars {
  readonly started: boolean;
  readonly initPhase: string;
  readonly floor: string;
  readonly updaterLoaded: boolean;
  readonly updaterConfigured: boolean;
  readonly periodicScheduled: boolean;
  readonly mainState: string;
  readonly mainStage: string;
  readonly mainVersion: number;
  readonly opPresent: boolean;
  readonly opCurrent: boolean;
  readonly opStage: string;
  readonly opTarget: number;
  readonly opPendingCalls: number;
  readonly opZipReady: boolean;
  readonly opNativeReady: boolean;
  readonly opNativeReadyVer: number;
  readonly squirrelInFlightVer: number;
  readonly opTimersArmed: boolean;
  readonly opHighWater: boolean;
  readonly opFallbackActive: boolean;
  readonly opKilledOnFallback: boolean;
  readonly closed: boolean;
  readonly installRequested: boolean;
  readonly installInvokedCount: number;
  readonly readinessWatch: boolean;
  readonly readinessInvalidated: boolean;
  readonly quitPhase: string;
  readonly quitReason: string;
  readonly drainOutcome: string;
  readonly finalQuitAllowed: boolean;
  readonly handoffTimer: boolean;
  readonly ipcDisposed: boolean;
  readonly windowOpen: boolean;
  readonly rendHydrated: boolean;
  readonly rendHydrationSawPush: boolean;
  readonly rendState: string;
  readonly rendVersion: number;
  readonly rendActiveKind: string;
  readonly rendActiveSawPush: boolean;
  readonly rendInvokePending: string;
  readonly rendSwallowedReject: boolean;
  readonly rendActedPreHydration: boolean;
  readonly pendingPush: string;
  readonly pendingPushState: string;
  readonly checksStarted: number;
  readonly sawRestartRequired: boolean;
}

export const title = "Desktop update cross-layer coordination";

function versionText(v: number): string {
  if (v === 1) return "v1";
  if (v === 2) return "v2";
  return "";
}

function phaseKind(v: Vars): "ready" | "active" | "install" | "done" | "broken" {
  if (
    v.rendSwallowedReject ||
    v.opKilledOnFallback ||
    (v.quitReason === "update" && v.quitPhase === "exited-error") ||
    (v.quitReason === "ordinary" && v.installInvokedCount > 0) ||
    (v.mainState === "downloaded" &&
      v.opNativeReadyVer !== 0 &&
      v.opNativeReadyVer !== v.mainVersion) ||
    (v.mainState === "failed" && v.opPresent && !v.opCurrent && !v.opTimersArmed) ||
    (v.opPresent && !v.updaterConfigured) ||
    (v.rendState === "downloaded" && v.rendActiveKind === "check") ||
    (v.started &&
      v.initPhase === "failed" &&
      v.mainState === "failed" &&
      v.mainStage === "check" &&
      !v.closed &&
      !v.periodicScheduled) ||
    v.rendActedPreHydration
  ) {
    return "broken";
  }
  if (
    v.quitPhase === "installed" ||
    v.quitPhase === "relaunching" ||
    v.quitPhase === "exited-clean"
  ) {
    return "done";
  }
  if (v.quitPhase === "draining" || v.quitPhase === "handoff" || v.mainState === "downloaded") {
    return "install";
  }
  if (v.mainState === "checking" || v.mainState === "downloading") {
    return "active";
  }
  return "ready";
}

export const state = (v: Vars): string => {
  if (v.quitPhase === "exited-error") {
    return v.quitReason === "update"
      ? "App exited without updating or relaunching"
      : "App exited with shutdown error";
  }
  if (v.quitPhase === "relaunching") return "App relaunching current version";
  if (v.quitPhase === "installed") {
    return v.quitReason === "ordinary"
      ? "Ordinary quit hijacked into installer"
      : "Installer launched cleanly";
  }
  if (v.quitPhase === "exited-clean") return "App exited cleanly";
  if (v.quitPhase === "handoff") {
    return v.quitReason === "ordinary"
      ? "Ordinary quit handing off to installer"
      : "Waiting for installer quit handoff";
  }
  if (v.quitPhase === "draining") {
    const why = v.quitReason === "update" ? "for update install" : "for ordinary quit";
    const req = v.quitReason === "ordinary" && v.installRequested ? " (hijacked by Restart)" : "";
    const inv = v.readinessInvalidated ? " (macOS invalidated)" : "";
    return `Draining ${why}${req}${inv}`;
  }
  if (v.rendSwallowedReject) return "Window frozen in Checking after IPC reject";
  if (v.opKilledOnFallback) return "Fallback download killed as stall";
  if (v.mainState === "failed" && v.opPresent && !v.opCurrent) {
    return v.opStage === "download"
      ? "Download failed (Retry wedged on pending call)"
      : "Check failed (Retry wedged on pending call)";
  }
  if (v.started && v.initPhase === "failed" && v.mainState === "failed" && !v.periodicScheduled) {
    return v.updaterLoaded && !v.updaterConfigured
      ? "Config failed (updater left loaded, no 6h timer)"
      : "Startup floor failed (no 6h timer)";
  }
  if (v.opPresent && !v.updaterConfigured) return "Checking on unconfigured updater";
  if (v.mainState === "downloaded") {
    const ver = versionText(v.mainVersion);
    if (v.opNativeReadyVer !== 0 && v.opNativeReadyVer !== v.mainVersion) {
      return `Ready for ${ver} with stale macOS ${versionText(v.opNativeReadyVer)}`;
    }
    if (v.rendState === "downloaded" && v.rendActiveKind === "check") {
      return `Ready for ${ver} (sidebar flashes Restarting)`;
    }
    if (v.rendActedPreHydration) return `Ready to install ${ver} (pre-hydration click)`;
    return `Ready to install ${ver}`;
  }
  if (v.mainState === "downloading") {
    const ver = versionText(v.mainVersion);
    const early = v.rendActedPreHydration ? " (pre-hydration click)" : "";
    if (v.opFallbackActive) return `Downloading ${ver} via full fallback${early}`;
    if (v.opZipReady && !v.opNativeReady) return `Preparing ${ver} on macOS${early}`;
    if (v.opNativeReady && !v.opZipReady) {
      return `Downloading ${ver} (poisoned by stale macOS ${versionText(v.opNativeReadyVer)})${early}`;
    }
    return `Downloading ${ver}${early}`;
  }
  if (v.mainState === "checking") {
    const early = v.rendActedPreHydration ? " (pre-hydration click)" : "";
    return v.rendActiveKind === "check" && v.rendActiveSawPush
      ? `Checking for updates (window received push)${early}`
      : `Checking for updates${early}`;
  }
  if (v.mainState === "restart-required") return "Quit and reopen required";
  if (v.mainState === "current") return "Up to date";
  if (v.mainState === "failed") {
    return v.squirrelInFlightVer !== 0
      ? `Download failed (macOS still verifying ${versionText(v.squirrelInFlightVer)})`
      : `Failed during ${v.mainStage}`;
  }
  if (v.rendActedPreHydration) return "Check clicked before window hydrated";
  if (v.initPhase === "floor") return "Recording version floor";
  if (v.initPhase === "loading") return "Loading updater engine";
  if (v.initPhase === "ready") return "Updater ready";
  return v.rendHydrated ? "App ready (window hydrated)" : "App booted (window hydrating)";
};

export const group = (v: Vars): string => phaseKind(v);

export const colors: Record<string, string> = {
  ready: "tan",
  active: "blue",
  install: "yellow",
  done: "teal",
  broken: "pink",
};

export const step = (action: string, from: Vars, to: Vars): string => {
  switch (action) {
    case "RendererHydrationCompletes":
      return "window finishes initial state hydration";
    case "StartBootInit":
      return "app begins update startup";
    case "VersionFloorReady":
      return to.floor === "higher"
        ? "version floor loads (higher floor recorded)"
        : "version floor records current version";
    case "VersionFloorUnavailable":
      return "version floor fails at startup";
    case "LoadUpdaterFails":
      return "packaged updater fails to load";
    case "LoadAndConfigureSucceeds":
      return "updater loads and configures 6h timer";
    case "LoadSucceedsConfigFails":
      return "updater loads, then configuration throws";
    case "MainStartsCheck":
      return "background check starts";
    case "AthleteClicksCheck":
      return from.rendState === "failed" ? "you click Try again" : "you click Check for updates";
    case "FinishInitAndRunCheck":
      return "initialized updater starts your check";
    case "CheckResolvesCurrent":
      return "no newer version found";
    case "CheckResolvesUpdate":
      return to.mainState === "failed"
        ? "candidate below version floor refused"
        : `newer version ${versionText(to.opTarget)} found`;
    case "DownloadProgressAdvances":
      return "differential download transfers initial bytes";
    case "DownloadFallsBackToFull":
      return "differential download fails and falls back to full download";
    case "FallbackDownloadExpiresAsStall":
      return "2m stall watchdog fires during full fallback";
    case "ZipUpdateDownloaded":
      return to.mainState === "downloaded"
        ? `archive ${versionText(to.mainVersion)} finishes and publishes ready`
        : `archive ${versionText(from.opTarget)} downloaded; macOS starts verifying`;
    case "NativeUpdateDownloaded":
      return to.mainState === "downloaded"
        ? `macOS finishes verifying ${versionText(to.opNativeReadyVer)}`
        : `stale macOS verification for ${versionText(from.squirrelInFlightVer)} arrives`;
    case "UpdaterErrorEventBeforePromiseSettles":
      return "updater emits error before call settles";
    case "UnderlyingCallSettles":
      return "pending updater call settles";
    case "OperationDeadlineExpires":
      return "operation deadline expires";
    case "NativeReadinessInvalidated":
      return "macOS invalidates prepared update";
    case "AthleteClicksRestart":
      return "you click Restart to update";
    case "OrdinaryQuitRequested":
      return "you press Quit (ordinary exit)";
    case "ShutdownClosesUpdateController":
      return "shutdown closes update controller";
    case "DrainFinishes":
      if (to.quitPhase === "exited-error")
        return "drain or install handoff fails and exits with error";
      if (to.quitPhase === "relaunching") return "install handoff fails; app relaunches";
      if (to.quitPhase === "handoff") return "drain finishes; installer handoff starts";
      return "drain finishes cleanly";
    case "DuplicateInstallHandoffCall":
      return "duplicate install handoff invoked";
    case "InstallHandoffAccepted":
      return "installer accepts quit handoff";
    case "InstallHandoffTimesOut":
      return "30s install handoff watchdog expires";
    case "RendererReceivesPush":
      return `window receives ${to.rendState} update push`;
    case "RendererReceivesInvokeReply":
      return "window receives check/restart reply";
    case "RendererInvokeRejects":
      return "check IPC call rejects in window";
    case "Done":
      return "done";
    default:
      return action;
  }
};
