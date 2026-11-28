// What the model says about the desktop update and download code, in one place.
// FLAGS: each model CONSTANT and how to read its value from product code.
// RULES: each invariant, its plain promise, harm, open cause(s), mutant, and witness.
// COVERED: the code blocks each model action describes; check.ts fingerprints them.

export type FlagName =
  | "DetachSettledOperation"
  | "ResetTransferWatermarkOnFallback"
  | "RelaunchOnInstallFailure"
  | "ArmNativeListenersOnlyAfterZipReady"
  | "ClearUpdaterOnConfigFailure"
  | "SidebarSeparatesRestartFromCheckBusy"
  | "ScheduleIntervalOnInitFailure"
  | "FreezeUpdateOnBeforeQuit"
  | "BlockActionsUntilHydrated"
  | "RendererHandlesRejectionAfterPush"
  | "EnforceVersionFloor"
  | "RequireNativeReadinessOnMac"
  | "GateInstallOnDrainAndReadiness"
  | "GuardSingleInstallInvocation"
  | "FenceRestartRequired";

export type Flags = Record<FlagName, boolean>;

export interface Source {
  read(file: string): string;
  block(file: string, needle: string, nth?: number): string;
  call(file: string, needle: string): string;
  statement(file: string, needle: string): string;
  code(text: string): string;
}

export interface FlagFact {
  readonly name: FlagName;
  readonly says: string;
  readonly read: (source: Source) => boolean;
}

const UPDATE_CONTROLLER = "apps/desktop/src/main/update-controller.ts";
const QUIT_COORDINATOR = "apps/desktop/src/main/quit-coordinator.ts";
const VERSION_FLOOR = "apps/desktop/src/main/update-version-floor.ts";
const UPDATE_IPC = "apps/desktop/src/main/update-ipc.ts";
const MAIN_INDEX = "apps/desktop/src/main/index.ts";
const RENDERER_UPDATE = "apps/desktop-renderer/src/update/controller.ts";
const UPDATE_ADAPTER = "apps/desktop-renderer/src/state/adapters/update.ts";
const SETTINGS_SLICE = "apps/desktop-renderer/src/state/settings-slice.ts";
const UPDATE_BUTTON = "apps/desktop-renderer/src/ui/sidebar/UpdateAvailableButton.tsx";
const APPLICATION_SECTION = "apps/desktop-renderer/src/ui/settings/ApplicationSection.tsx";

export const FLAGS: readonly FlagFact[] = [
  {
    name: "DetachSettledOperation",
    says: "failOperation and publishIfReady detach activeOperation instead of pinning it behind pendingCalls",
    read: (s) => {
      const fail = s.code(s.block(UPDATE_CONTROLLER, "const failOperation ="));
      const pub = s.code(s.block(UPDATE_CONTROLLER, "const publishIfReady ="));
      const finish = s.code(s.block(UPDATE_CONTROLLER, "const finishOperation ="));
      const detachAlways = /detachPending\s*=\s*true/.test(finish);
      const failDetaches = /finishOperation\(\s*operation\s*,\s*true\s*,\s*true\s*\)/.test(fail);
      const pubDetaches = /finishOperation\(\s*operation\s*,\s*false\s*,\s*true\s*\)/.test(pub);
      return detachAlways || (failDetaches && pubDetaches);
    },
  },
  {
    name: "ResetTransferWatermarkOnFallback",
    says: "download progress handles a differential-to-full fallback reset instead of ignoring transferred <= lastTransferred",
    read: (s) => {
      const listener = s.code(s.block(UPDATE_CONTROLLER, "operation.progressListener = (info)"));
      return !/info\.transferred\s*<=\s*operation\.lastTransferred/.test(listener);
    },
  },
  {
    name: "RelaunchOnInstallFailure",
    says: "quit-coordinator relaunches the current app when an update install handoff or drain fails",
    read: (s) =>
      /\brelaunch\b/.test(
        s.code(s.block(QUIT_COORDINATOR, "export async function completeDesktopShutdown(")),
      ),
  },
  {
    name: "ArmNativeListenersOnlyAfterZipReady",
    says: "macOS nativeUpdater readiness listeners only accept events after zipReady is true",
    read: (s) => {
      const begin = s.code(s.block(UPDATE_CONTROLLER, "const beginDownload ="));
      const attachedInBegin = /nativeUpdater\.on\(\s*"update-downloaded"/.test(begin);
      if (!attachedInBegin) return true;
      const listener = s.code(
        s.block(UPDATE_CONTROLLER, "operation.nativeDownloadedListener = ()"),
      );
      return /!operation\.zipReady/.test(listener);
    },
  },
  {
    name: "ClearUpdaterOnConfigFailure",
    says: "initializeUpdater commits updater only after configuration succeeds (or clears updater on catch)",
    read: (s) => {
      const init = s.code(s.block(UPDATE_CONTROLLER, "const initializeUpdater ="));
      const assignsBeforeConfig = /updater\s*=\s*await\s+input\.loadUpdater\(\)/.test(init);
      const clearsOnCatch = /updater\s*=\s*undefined/.test(init);
      return !assignsBeforeConfig || clearsOnCatch;
    },
  },
  {
    name: "SidebarSeparatesRestartFromCheckBusy",
    says: "UpdateAvailableButton does not derive restarting from the shared actionDisabled check flag",
    read: (s) => {
      const stmt = s.code(s.statement(UPDATE_BUTTON, "const restarting ="));
      return !/update\.actionDisabled/.test(stmt);
    },
  },
  {
    name: "ScheduleIntervalOnInitFailure",
    says: "startup schedules the 6-hour periodic check even when version floor initialization fails transiently",
    read: (s) => {
      const startFn = s.code(s.block(UPDATE_CONTROLLER, "const start ="));
      const initFn = s.code(s.block(UPDATE_CONTROLLER, "const initializeUpdater ="));
      const floorIdx = initFn.indexOf("recordRunningVersion");
      const intervalIdx = initFn.indexOf("scheduleInterval(");
      return /scheduleInterval\(/.test(startFn) || (intervalIdx !== -1 && intervalIdx < floorIdx);
    },
  },
  {
    name: "FreezeUpdateOnBeforeQuit",
    says: "before-quit freezes update IPC and controller synchronously before async shutdown awaits",
    read: (s) => {
      const beforeQuit = s.code(s.call(MAIN_INDEX, '"before-quit"'));
      const shutdownFn = s.code(s.block(MAIN_INDEX, "const shutdown ="));
      const firstAwait = shutdownFn.indexOf("await ");
      const closeIdx = shutdownFn.indexOf("updateController.close()");
      return (
        /updateController\.close\(|disposeUpdateIpc/.test(beforeQuit) ||
        (closeIdx !== -1 && (firstAwait === -1 || closeIdx < firstAwait))
      );
    },
  },
  {
    name: "BlockActionsUntilHydrated",
    says: "renderer update controller blocks check/restart clicks until initial getUpdateState() hydrates",
    read: (s) => {
      const activate = s.code(s.block(RENDERER_UPDATE, "const activate ="));
      return /\bhydrated\b|\bhydrating\b|"loading"/.test(activate);
    },
  },
  {
    name: "RendererHandlesRejectionAfterPush",
    says: "renderer activate() handles checkForUpdates() rejection even after intermediate checking/downloading pushes bumped revision",
    read: (s) => {
      const activate = s.code(s.block(RENDERER_UPDATE, "const activate ="));
      return !/revision\s*===\s*before\s*&&\s*!restarting/.test(activate);
    },
  },
  {
    name: "EnforceVersionFloor",
    says: "runCheck refuses candidates when floorVersion is missing or candidate is below floorVersion",
    read: (s) => {
      const runCheck = s.code(s.block(UPDATE_CONTROLLER, "const runCheck ="));
      return (
        /floorVersion\s*===\s*undefined/.test(runCheck) &&
        /compareDesktopVersions\(\s*version\s*,\s*floorVersion\s*\)/.test(runCheck) &&
        /floorComparison\s*<\s*0/.test(runCheck)
      );
    },
  },
  {
    name: "RequireNativeReadinessOnMac",
    says: "publishIfReady waits for operation.nativeReady on darwin before publishing downloaded",
    read: (s) => {
      const pub = s.code(s.block(UPDATE_CONTROLLER, "const publishIfReady ="));
      return /requiresNativePreparation\s*&&\s*!operation\.nativeReady/.test(pub);
    },
  },
  {
    name: "GateInstallOnDrainAndReadiness",
    says: "shutdown blocks install unless drain succeeded, restart was requested, and native readiness stayed valid",
    read: (s) => {
      const shutdown = s.code(
        s.block(QUIT_COORDINATOR, "export async function completeDesktopShutdown("),
      );
      const complete = s.code(
        s.block(UPDATE_CONTROLLER, "completeInstallAfterDrain(allowFinalQuit)"),
      );
      return (
        /drainOutcome\s*!==\s*"drained"/.test(shutdown) &&
        /!installRequested/.test(complete) &&
        /if\s*\(\s*readinessInvalidated\s*\)\s*return\s*"failed"/.test(complete)
      );
    },
  },
  {
    name: "GuardSingleInstallInvocation",
    says: "completeInstallAfterDrain guards quitAndInstall with installInvoked so it runs at most once",
    read: (s) => {
      const complete = s.code(
        s.block(UPDATE_CONTROLLER, "completeInstallAfterDrain(allowFinalQuit)"),
      );
      return (
        /if\s*\(\s*installInvoked\s*\)\s*return\s*"started"/.test(complete) &&
        /installInvoked\s*=\s*true/.test(complete)
      );
    },
  },
  {
    name: "FenceRestartRequired",
    says: "canCheck excludes restart-required and isCurrent fences stale generations",
    read: (s) => {
      const canCheck = s.code(s.statement(UPDATE_CONTROLLER, "const canCheck ="));
      const isCurrent = s.code(s.statement(UPDATE_CONTROLLER, "const isCurrent ="));
      return (
        /"restart-required"/.test(canCheck) &&
        /operation\.generation\s*===\s*generation/.test(isCurrent)
      );
    },
  },
];

export interface BreakCause {
  readonly when: (flags: Flags) => boolean;
  readonly fixedWith: Partial<Flags>;
  readonly finding?: string;
  readonly because: string;
}

export interface RuleFact {
  readonly name: string;
  readonly says: string;
  readonly harm: string;
  readonly breaksWhen: readonly BreakCause[];
  readonly breakWith: Partial<Flags>;
  readonly witness: string;
}

export const RULES: readonly RuleFact[] = [
  {
    name: "NoPermanentRetryWedge",
    says: "A failed update check or download never leaves a dead timerless activeOperation that swallows Retry.",
    harm: "Clicking Try again and 6-hour checks silently return the cached failure (or stale downloaded state) without checking.",
    breaksWhen: [
      {
        when: (f) => !f.DetachSettledOperation,
        fixedWith: { DetachSettledOperation: true },
        finding: "BUG-1 (new; #269 class)",
        because:
          "failOperation and publishIfReady clear all timers while keeping activeOperation until pendingCalls hits 0",
      },
    ],
    breakWith: { DetachSettledOperation: false },
    witness: "WitnessFailedWithPendingCall",
  },
  {
    name: "FallbackDownloadNotKilledAsStall",
    says: "A differential-to-full fallback download transferring from 0 is never misclassified as a stall.",
    harm: "Healthy full fallback downloads are killed after 2 minutes into terminal restart-required.",
    breaksWhen: [
      {
        when: (f) => !f.ResetTransferWatermarkOnFallback,
        fixedWith: { ResetTransferWatermarkOnFallback: true },
        finding: "BUG-2 (new)",
        because:
          "progressListener ignores transferred <= lastTransferred after differential download falls back to full download",
      },
    ],
    breakWith: { ResetTransferWatermarkOnFallback: false },
    witness: "WitnessFallbackReached",
  },
  {
    name: "RestartToUpdateNeverStrandsApp",
    says: "After clicking Restart to update, the app never exits with an error without installing or relaunching.",
    harm: "The app disappears without updating or reopening when readiness invalidates, drain fails, or install handoff fails/times out.",
    breaksWhen: [
      {
        when: (f) => !f.RelaunchOnInstallFailure,
        fixedWith: { RelaunchOnInstallFailure: true },
        finding: "BUG-3 (#391 + Windows/drain triggers)",
        because:
          "completeDesktopShutdown calls exit(1) without relaunching on failed install, drain failure, or 30s handoff timeout",
      },
    ],
    breakWith: { RelaunchOnInstallFailure: false },
    witness: "WitnessRestartQuitDraining",
  },
  {
    name: "NoStaleMacNativeReadiness",
    says: "On macOS, published downloaded(v) always has Squirrel.Mac readiness for that exact version v.",
    harm: "A stale Squirrel event from a failed attempt poisons a retry for a newer version and installs the wrong build.",
    breaksWhen: [
      {
        when: (f) => !f.ArmNativeListenersOnlyAfterZipReady,
        fixedWith: { ArmNativeListenersOnlyAfterZipReady: true },
        finding: "BUG-4 (new)",
        because:
          "beginDownload arms nativeDownloadedListener before zipReady and never checks operation.zipReady",
      },
    ],
    breakWith: { ArmNativeListenersOnlyAfterZipReady: false },
    witness: "WitnessStaleSquirrelPossible",
  },
  {
    name: "UpdaterAlwaysConfiguredBeforeCheck",
    says: "checkForUpdates() never runs on an updater whose configuration or interval setup threw.",
    harm: "Retry runs on an unconfigured updater (default autoDownload=true bypasses version floor, no 6-hour timer).",
    breaksWhen: [
      {
        when: (f) => !f.ClearUpdaterOnConfigFailure,
        fixedWith: { ClearUpdaterOnConfigFailure: true },
        finding: "BUG-5 (new)",
        because:
          "initializeUpdater assigns updater before configuring properties and does not clear it on catch",
      },
    ],
    breakWith: { ClearUpdaterOnConfigFailure: false },
    witness: "WitnessConfigFailReached",
  },
  {
    name: "SidebarNeverShowsFalseRestarting",
    says: "The sidebar UpdateAvailableButton never displays Restarting while nobody clicked Restart to update.",
    harm: "The sidebar button flashes disabled Restarting and announces restarting after a manual check downloads an update.",
    breaksWhen: [
      {
        when: (f) => !f.SidebarSeparatesRestartFromCheckBusy,
        fixedWith: { SidebarSeparatesRestartFromCheckBusy: true },
        finding: "BUG-6 (new)",
        because:
          "UpdateAvailableButton derives restarting from shared actionDisabled while checkForUpdates() is still settling",
      },
    ],
    breakWith: { SidebarSeparatesRestartFromCheckBusy: false },
    witness: "WitnessDownloadedWithCheckActive",
  },
  {
    name: "StartupInitFailureSchedulesRecovery",
    says: "A transient startup floor or config failure never leaves an eligible app with no 6-hour periodic check.",
    harm: "Background auto-updates stop for the rest of the session unless the athlete manually retries in Settings.",
    breaksWhen: [
      {
        when: (f) => !f.ScheduleIntervalOnInitFailure,
        fixedWith: { ScheduleIntervalOnInitFailure: true },
        finding: "BUG-7 (#391 note)",
        because:
          "initializeUpdater returns false on floor/config failure before scheduling the 6-hour interval",
      },
    ],
    breakWith: { ScheduleIntervalOnInitFailure: false },
    witness: "WitnessFloorFailReached",
  },
  {
    name: "OrdinaryQuitNeverInstallsUpdate",
    says: "An ordinary quit (Cmd+Q, Tray Quit, SIGTERM) is never hijacked into an update install during async shutdown.",
    harm: "Quitting the app normally can unexpectedly trigger update installation and relaunch.",
    breaksWhen: [
      {
        when: (f) => !f.FreezeUpdateOnBeforeQuit,
        fixedWith: { FreezeUpdateOnBeforeQuit: true },
        finding: "BUG-8 (new)",
        because:
          "before-quit awaits residency/IPC close before disposing update IPC and closing updateController",
      },
    ],
    breakWith: { FreezeUpdateOnBeforeQuit: false },
    witness: "WitnessOrdinaryQuitDuringDownloaded",
  },
  {
    name: "NoPreHydrationCheckRace",
    says: "Renderer update buttons do not fire checkForUpdates() on fake initial idle before getUpdateState() hydrates.",
    harm: "Early clicks race initial hydration and can flash Restarting if an update was already downloaded.",
    breaksWhen: [
      {
        when: (f) => !f.BlockActionsUntilHydrated,
        fixedWith: { BlockActionsUntilHydrated: true },
        finding: "BUG-9a (new)",
        because:
          "renderer update controller initializes to idle with actionDisabled=false and does not gate activate() on hydration",
      },
    ],
    breakWith: { BlockActionsUntilHydrated: false },
    witness: "WitnessUnHydratedWindow",
  },
  {
    name: "RendererNeverSwallowsInvokeRejection",
    says: "A rejected checkForUpdates() IPC call after checking/downloading pushes moves the UI to failed instead of freezing.",
    harm: "Settings stays frozen in Checking or Downloading with its button permanently disabled.",
    breaksWhen: [
      {
        when: (f) => !f.RendererHandlesRejectionAfterPush,
        fixedWith: { RendererHandlesRejectionAfterPush: true },
        finding: "BUG-11c/12 (new)",
        because:
          "renderer activate() catch checks revision === before, which is always false after checking/downloading pushes",
      },
    ],
    breakWith: { RendererHandlesRejectionAfterPush: false },
    witness: "WitnessInvokeRejectsAfterPush",
  },
  {
    name: "NoDowngradeBelowFloor",
    says: "The controller never downloads a candidate lower than the recorded version floor or when the floor is missing.",
    harm: "A compromised or rolled-back feed could downgrade the athlete's desktop app.",
    breaksWhen: [
      {
        when: (f) => !f.EnforceVersionFloor,
        fixedWith: { EnforceVersionFloor: true },
        because: "runCheck no longer refuses missing floorVersion or candidate < floorVersion",
      },
    ],
    breakWith: { EnforceVersionFloor: false },
    witness: "WitnessHigherFloorReached",
  },
  {
    name: "MacOsWaitsForNativeReadiness",
    says: "On macOS, downloaded is never published until both zipReady and Squirrel.Mac nativeReady are true.",
    harm: "Restart to update fires before Squirrel.Mac has verified and staged the bundle.",
    breaksWhen: [
      {
        when: (f) => !f.RequireNativeReadinessOnMac,
        fixedWith: { RequireNativeReadinessOnMac: true },
        because: "publishIfReady no longer waits for operation.nativeReady on darwin",
      },
    ],
    breakWith: { RequireNativeReadinessOnMac: false },
    witness: "WitnessMacDownloaded",
  },
  {
    name: "NoInstallWithoutExplicitRestartAndDrain",
    says: "quitAndInstall() runs only after explicit Restart to update, clean daemon drain, and valid readiness.",
    harm: "An ordinary quit, failed drain, or invalidated macOS bundle could launch an unsafe update install.",
    breaksWhen: [
      {
        when: (f) => !f.GateInstallOnDrainAndReadiness,
        fixedWith: { GateInstallOnDrainAndReadiness: true },
        because:
          "quit-coordinator or completeInstallAfterDrain no longer enforces drainOutcome, installRequested, and readinessInvalidated",
      },
    ],
    breakWith: { GateInstallOnDrainAndReadiness: false },
    witness: "WitnessInstalled",
  },
  {
    name: "InstallInvokedAtMostOnce",
    says: "updater.quitAndInstall() is invoked at most once even if handoff completion runs repeatedly.",
    harm: "Duplicate quitAndInstall calls can corrupt installer handoff or race termination.",
    breaksWhen: [
      {
        when: (f) => !f.GuardSingleInstallInvocation,
        fixedWith: { GuardSingleInstallInvocation: true },
        because: "completeInstallAfterDrain no longer guards quitAndInstall with installInvoked",
      },
    ],
    breakWith: { GuardSingleInstallInvocation: false },
    witness: "WitnessInstalled",
  },
  {
    name: "RestartRequiredIsTerminal",
    says: "Once restart-required is entered, no new check starts and stale operations cannot leave restart-required.",
    harm: "The app retries a wedged updater or overwrites the restart-required recovery state.",
    breaksWhen: [
      {
        when: (f) => !f.FenceRestartRequired,
        fixedWith: { FenceRestartRequired: true },
        because:
          "canCheck no longer excludes restart-required or isCurrent no longer checks generation",
      },
    ],
    breakWith: { FenceRestartRequired: false },
    witness: "WitnessRestartRequired",
  },
];

export const STEPS: Record<string, string> = {
  Initial: "app boots with main window open and renderer starting getUpdateState() hydration",
  RendererHydrationCompletes:
    "renderer getUpdateState() resolves and hydrates initial update state",
  StartBootInit: "main calls updateController.start() (index.ts)",
  VersionFloorReady: "version floor records running version (update-version-floor.ts)",
  VersionFloorUnavailable: "version floor fails closed as unavailable before interval scheduling",
  LoadUpdaterFails: "packaged electron-updater load fails -> restart-required(check)",
  LoadAndConfigureSucceeds: "electron-updater loads, configures flags, and schedules 6h interval",
  LoadSucceedsConfigFails:
    "updater loads and assigns updater, then config/interval throws -> failed(check)",
  MainStartsCheck: "startup or 6h periodic check calls runCheck()",
  AthleteClicksCheck: "athlete clicks Check for updates / Try again in Settings",
  FinishInitAndRunCheck: "manual check finishes initializeUpdater() and enters runCheck()",
  CheckResolvesCurrent: "checkForUpdates() resolves with no newer version -> current",
  CheckResolvesUpdate:
    "checkForUpdates() finds a candidate version (floor check -> beginDownload or refused)",
  DownloadProgressAdvances: "differential download advances lastTransferred high-water mark",
  DownloadFallsBackToFull:
    "differential download fails and falls back to full download from byte 0",
  FallbackDownloadExpiresAsStall:
    "2m stall timer expires during full fallback because transferred <= lastTransferred",
  ZipUpdateDownloaded:
    "electron-updater emits update-downloaded (and on macOS triggers Squirrel checkForUpdates)",
  NativeUpdateDownloaded: "Squirrel.Mac nativeUpdater emits update-downloaded",
  UpdaterErrorEventBeforePromiseSettles:
    "updater/nativeUpdater emits error event while check/download promise is still pending",
  UnderlyingCallSettles:
    "pending checkForUpdates()/downloadUpdate() promise settles and decrements pendingCalls",
  OperationDeadlineExpires: "check/stall/preparation/absolute deadline fires -> restart-required",
  NativeReadinessInvalidated:
    "late Squirrel.Mac native error invalidates downloaded update readiness",
  AthleteClicksRestart: "athlete clicks Restart to update -> installRequested=true and app.quit()",
  OrdinaryQuitRequested: "ordinary quit (Cmd+Q / Tray Quit / SIGTERM) enters before-quit drain",
  ShutdownClosesUpdateController:
    "async shutdown reaches disposeUpdateIpc() and updateController.close()",
  DrainFinishes:
    "shutdown drain finishes and quit-coordinator runs completeInstallAfterDrain / exit",
  DuplicateInstallHandoffCall: "repeated completeInstallAfterDrain() invocation during handoff",
  InstallHandoffAccepted: "updater emits final before-quit and launches installer",
  InstallHandoffTimesOut: "30s handoff watchdog expires without updater quit",
  RendererReceivesPush: "renderer onUpdateState receives pushed DesktopUpdateState",
  RendererReceivesInvokeReply: "renderer receives checkForUpdates()/restartToUpdate() invoke reply",
  RendererInvokeRejects: "renderer checkForUpdates() IPC invoke rejects",
  Done: "terminal quit state reached",
};

export interface Covered {
  readonly file: string;
  readonly needle: string;
  readonly kind: "block" | "statement" | "call";
  readonly nth?: number;
  readonly models: string;
}

export const COVERED: readonly Covered[] = [
  {
    file: UPDATE_CONTROLLER,
    needle: "const canCheck =",
    kind: "statement",
    models: "CanCheck; FenceRestartRequired",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const isCurrent =",
    kind: "statement",
    models: "IsCurrent; FenceRestartRequired",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const armReadinessWatch =",
    kind: "block",
    models: "NativeReadinessInvalidated",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const releaseOperationIfIdle =",
    kind: "block",
    models: "UnderlyingCallSettles",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const finishOperation =",
    kind: "block",
    models: "DetachSettledOperation",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const failOperation =",
    kind: "block",
    models: "UpdaterErrorEventBeforePromiseSettles; DetachSettledOperation",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const expireOperation =",
    kind: "block",
    models: "OperationDeadlineExpires; FallbackDownloadExpiresAsStall",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const publishIfReady =",
    kind: "block",
    models:
      "ZipUpdateDownloaded; NativeUpdateDownloaded; RequireNativeReadinessOnMac; DetachSettledOperation",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const noteZipReady =",
    kind: "block",
    models: "ZipUpdateDownloaded",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const beginDownload =",
    kind: "block",
    models:
      "CheckResolvesUpdate; DownloadProgressAdvances; ArmNativeListenersOnlyAfterZipReady; ResetTransferWatermarkOnFallback",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const runCheck =",
    kind: "block",
    models: "StartCheckOp; CheckResolvesCurrent; CheckResolvesUpdate; EnforceVersionFloor",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "const initializeUpdater =",
    kind: "block",
    models:
      "VersionFloorReady; VersionFloorUnavailable; LoadUpdaterFails; LoadAndConfigureSucceeds; LoadSucceedsConfigFails; ClearUpdaterOnConfigFailure; ScheduleIntervalOnInitFailure",
  },
  { file: UPDATE_CONTROLLER, needle: "const check =", kind: "block", models: "AthleteClicksCheck" },
  {
    file: UPDATE_CONTROLLER,
    needle: "const start =",
    kind: "block",
    models: "StartBootInit; ScheduleIntervalOnInitFailure",
  },
  { file: UPDATE_CONTROLLER, needle: "restart() {", kind: "block", models: "AthleteClicksRestart" },
  {
    file: UPDATE_CONTROLLER,
    needle: "completeInstallAfterDrain(allowFinalQuit)",
    kind: "block",
    models: "DrainFinishes; GateInstallOnDrainAndReadiness; GuardSingleInstallInvocation",
  },
  {
    file: UPDATE_CONTROLLER,
    needle: "close() {",
    kind: "block",
    models: "ShutdownClosesUpdateController",
  },
  {
    file: QUIT_COORDINATOR,
    needle: "export async function completeDesktopShutdown(",
    kind: "block",
    models:
      "DrainFinishes; InstallHandoffTimesOut; RelaunchOnInstallFailure; GateInstallOnDrainAndReadiness",
  },
  {
    file: QUIT_COORDINATOR,
    needle: "export function createDesktopQuitCoordinator(",
    kind: "block",
    models: "OrdinaryQuitRequested; InstallHandoffAccepted",
  },
  {
    file: VERSION_FLOOR,
    needle: "recordRunningVersion(version)",
    kind: "block",
    models: "VersionFloorReady; VersionFloorUnavailable",
  },
  {
    file: UPDATE_IPC,
    needle: "export function installDesktopUpdateIpc(",
    kind: "block",
    models: "Publish; ShutdownClosesUpdateController",
  },
  {
    file: MAIN_INDEX,
    needle: "const shutdown =",
    kind: "block",
    models: "ShutdownClosesUpdateController; FreezeUpdateOnBeforeQuit",
  },
  {
    file: MAIN_INDEX,
    needle: '"before-quit"',
    kind: "call",
    models: "OrdinaryQuitRequested; FreezeUpdateOnBeforeQuit",
  },
  {
    file: RENDERER_UPDATE,
    needle: "export function createDesktopUpdateController(",
    kind: "block",
    models:
      "RendererHydrationCompletes; AthleteClicksCheck; AthleteClicksRestart; RendererReceivesPush; RendererReceivesInvokeReply; RendererInvokeRejects; BlockActionsUntilHydrated; RendererHandlesRejectionAfterPush",
  },
  {
    file: UPDATE_ADAPTER,
    needle: "export function createUpdateSettingsAdapter(",
    kind: "block",
    models: "SidebarShowsRestarting actionDisabled projection",
  },
  {
    file: SETTINGS_SLICE,
    needle: "const EMPTY_UPDATE_SURFACE:",
    kind: "statement",
    models: "Initial unhydrated idle store state; BlockActionsUntilHydrated",
  },
  {
    file: UPDATE_BUTTON,
    needle: "export function UpdateAvailableButton(",
    kind: "block",
    models: "SidebarShowsRestarting; SidebarSeparatesRestartFromCheckBusy",
  },
  {
    file: APPLICATION_SECTION,
    needle: "export function ApplicationSection(",
    kind: "block",
    models: "Settings update button busy and copy projection",
  },
];
