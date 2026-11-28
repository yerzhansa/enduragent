--------------------------- MODULE UpdateDownload ---------------------------
(***************************************************************************)
(* Formal model of the Enduragent desktop auto-update and download state   *)
(* machines across main (update-controller.ts, quit-coordinator.ts,        *)
(* update-version-floor.ts, update-ipc.ts, index.ts), electron-updater     *)
(* (AppUpdater, MacUpdater, BaseUpdater, DifferentialDownloader), and      *)
(* renderer (update/controller.ts, ApplicationSection, UpdateAvailableBtn).*)
(*                                                                         *)
(* Each boolean CONSTANT reflects a fact read directly from product code   *)
(* by scripts/facts.ts. Never weaken an INVARIANT to make it pass.         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    \* Open-finding facts (FALSE on origin/main 0c559cf8, TRUE when fixed)
    DetachSettledOperation,
    ResetTransferWatermarkOnFallback,
    RelaunchOnInstallFailure,
    ArmNativeListenersOnlyAfterZipReady,
    ClearUpdaterOnConfigFailure,
    SidebarSeparatesRestartFromCheckBusy,
    ScheduleIntervalOnInitFailure,
    FreezeUpdateOnBeforeQuit,
    BlockActionsUntilHydrated,
    RendererHandlesRejectionAfterPush,
    \* Guarded-control facts (TRUE on origin/main 0c559cf8)
    EnforceVersionFloor,
    RequireNativeReadinessOnMac,
    GateInstallOnDrainAndReadiness,
    GuardSingleInstallInvocation,
    FenceRestartRequired,
    \* Model bounds
    MaxChecks,
    Platform          \* "darwin" or "win32"

\* Versions: 0 = none, 1 = older candidate (below "higher" floor; valid when floor = "current"), 2 = newer candidate
Versions == {0, 1, 2}

VARIABLES
    \* Main process: initialization & version floor (update-controller.ts, update-version-floor.ts)
    started,              \* boolean: start() was called
    initPhase,            \* "idle" | "floor" | "loading" | "ready" | "failed"
    floor,                \* "none" | "current" | "higher"
    updaterLoaded,        \* boolean: updater !== undefined
    updaterConfigured,    \* boolean: security & behavior flags + interval configured cleanly
    periodicScheduled,    \* boolean: 6-hour intervalTimer is scheduled
    \* Main process: published state & hidden operation shadow state (update-controller.ts)
    mainState,            \* "idle" | "checking" | "current" | "downloading" | "downloaded" | "installing" | "restart-required" | "failed"
    mainStage,            \* "none" | "check" | "download"
    mainVersion,          \* 0..2
    opPresent,            \* boolean: activeOperation !== undefined
    opCurrent,            \* boolean: activeOperation.generation === generation
    opStage,              \* "none" | "check" | "download"
    opTarget,             \* 0..2
    opPendingCalls,       \* 0..2 (in-flight checkForUpdates / downloadUpdate promises)
    opZipReady,           \* boolean: electron-updater emitted update-downloaded
    opNativeReady,        \* boolean: Squirrel.Mac emitted update-downloaded (or non-darwin)
    opNativeReadyVer,     \* 0..2: which version Squirrel actually emitted update-downloaded for
    squirrelInFlightVer,  \* 0..2: version Squirrel.Mac is currently fetching/verifying (MacUpdater.js:223)
    opTimersArmed,        \* boolean: check/stall/absolute/preparation timers currently armed
    opHighWater,          \* boolean: lastTransferred > 0 from differential download
    opFallbackActive,     \* boolean: differential failed and full download restarted from 0
    opKilledOnFallback,   \* ghost: stall timer killed an actively progressing fallback download
    closed,               \* boolean: updateController.close() ran
    installRequested,     \* boolean: restart() set installRequested = true
    installInvokedCount,  \* 0..2: how many times updater.quitAndInstall() was invoked
    readinessWatch,       \* boolean: nativeUpdater readinessErrorListener attached
    readinessInvalidated, \* boolean: nativeUpdater emitted error after downloaded
    \* Quit coordinator & shutdown (quit-coordinator.ts, main/index.ts)
    quitPhase,            \* "running" | "draining" | "handoff" | "exited-clean" | "exited-error" | "relaunching" | "installed"
    quitReason,           \* "none" | "ordinary" | "update" (ghost: why quit began)
    drainOutcome,         \* "none" | "drained" | "failed" | "timed-out"
    finalQuitAllowed,     \* boolean: quitCoordinator finalQuitAllowed
    handoffTimer,         \* boolean: 30s handoff watchdog armed
    ipcDisposed,          \* boolean: disposeUpdateIpc() ran
    \* Renderer & IPC bridge (update-ipc.ts, preload/index.ts, renderer/update/controller.ts)
    windowOpen,           \* boolean: trusted main window open
    rendHydrated,         \* boolean: start()'s getUpdateState() or a push has hydrated renderer state
    rendHydrationSawPush, \* boolean: revision !== before for start()'s getUpdateState() (controller.ts:84-87)
    rendState,            \* "idle" | "checking" | "current" | "downloading" | "downloaded" | "installing" | "restart-required" | "failed"
    rendVersion,          \* 0..2
    rendActiveKind,       \* "none" | "check" | "restart" (active !== undefined)
    rendActiveSawPush,    \* boolean: revision !== before during active activate() call
    rendInvokePending,    \* "none" | "in-flight" | "settled"
    rendInvokeReplyState, \* state returned by check()/restart() IPC when settled
    rendInvokeReplyVer,   \* version returned by check()/restart() IPC when settled
    rendSwallowedReject,  \* ghost: renderer swallowed IPC rejection while showing checking/downloading
    rendActedPreHydration,\* ghost: athlete clicked Check before hydration resolved
    pendingPush,          \* "none" | "queued" (latest push waiting in IPC to renderer)
    pendingPushState,     \* pushed state
    pendingPushVer,       \* pushed version
    \* Ghost counters & bounds
    checksStarted,        \* 0..MaxChecks
    sawRestartRequired,   \* ghost: controller ever entered restart-required
    installedWithoutDrainOrReadiness \* ghost: quitAndInstall called illegally

initVars == <<started, initPhase, floor, updaterLoaded, updaterConfigured, periodicScheduled>>
mainVars == <<mainState, mainStage, mainVersion, opPresent, opCurrent, opStage, opTarget,
              opPendingCalls, opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
              opTimersArmed, opHighWater, opFallbackActive, opKilledOnFallback, closed,
              installRequested, installInvokedCount, readinessWatch, readinessInvalidated>>
quitVars == <<quitPhase, quitReason, drainOutcome, finalQuitAllowed, handoffTimer, ipcDisposed>>
rendVars == <<windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
              rendActiveKind, rendActiveSawPush, rendInvokePending, rendInvokeReplyState,
              rendInvokeReplyVer, rendSwallowedReject, rendActedPreHydration,
              pendingPush, pendingPushState, pendingPushVer>>
ghostVars == <<checksStarted, sawRestartRequired, installedWithoutDrainOrReadiness>>
vars == <<initVars, mainVars, quitVars, rendVars, ghostVars>>

RequiresNative == Platform = "darwin"

CanCheck ==
    /\ ~closed
    /\ mainState \notin {"downloading", "downloaded", "installing"}
    /\ (FenceRestartRequired => mainState # "restart-required")

IsCurrent == ~closed /\ opPresent /\ opCurrent

\* Helper: queue a push from main publish() to renderer if window is open & IPC live
Publish(nextState, nextStage, nextVer) ==
    /\ mainState' = nextState
    /\ mainStage' = nextStage
    /\ mainVersion' = nextVer
    /\ sawRestartRequired' = (sawRestartRequired \/ nextState = "restart-required")
    /\ IF windowOpen /\ ~ipcDisposed
       THEN /\ pendingPush' = "queued"
            /\ pendingPushState' = nextState
            /\ pendingPushVer' = nextVer
       ELSE UNCHANGED <<pendingPush, pendingPushState, pendingPushVer>>

\* Derived UI observables (UpdateAvailableButton.tsx:14-15, ApplicationSection.tsx:90-93)
SidebarVisible == windowOpen /\ rendState \in {"downloaded", "installing"}
SidebarShowsRestarting ==
    /\ SidebarVisible
    /\ IF SidebarSeparatesRestartFromCheckBusy
       THEN rendState = "installing" \/ rendActiveKind = "restart"
       ELSE rendState = "installing" \/ rendActiveKind # "none"

-----------------------------------------------------------------------------
(* Initial state: app booted, main window opened, boot.ts:102 sent getUpdateState()
   synchronously (FIFO before settingsPorts.update is bound at boot.ts:700 and before
   any user click; update-ipc.ts:31-35 answers synchronously with initial "idle"). *)

Init ==
    /\ started = FALSE
    /\ initPhase = "idle"
    /\ floor = "none"
    /\ updaterLoaded = FALSE
    /\ updaterConfigured = FALSE
    /\ periodicScheduled = FALSE
    /\ mainState = "idle"
    /\ mainStage = "none"
    /\ mainVersion = 0
    /\ opPresent = FALSE
    /\ opCurrent = FALSE
    /\ opStage = "none"
    /\ opTarget = 0
    /\ opPendingCalls = 0
    /\ opZipReady = FALSE
    /\ opNativeReady = ~RequiresNative
    /\ opNativeReadyVer = 0
    /\ squirrelInFlightVer = 0
    /\ opTimersArmed = FALSE
    /\ opHighWater = FALSE
    /\ opFallbackActive = FALSE
    /\ opKilledOnFallback = FALSE
    /\ closed = FALSE
    /\ installRequested = FALSE
    /\ installInvokedCount = 0
    /\ readinessWatch = FALSE
    /\ readinessInvalidated = FALSE
    /\ quitPhase = "running"
    /\ quitReason = "none"
    /\ drainOutcome = "none"
    /\ finalQuitAllowed = FALSE
    /\ handoffTimer = FALSE
    /\ ipcDisposed = FALSE
    /\ windowOpen = TRUE
    /\ rendHydrated = FALSE
    /\ rendHydrationSawPush = FALSE
    /\ rendState = "idle"
    /\ rendVersion = 0
    /\ rendActiveKind = "none"
    /\ rendActiveSawPush = FALSE
    /\ rendInvokePending = "none"
    /\ rendInvokeReplyState = "idle"
    /\ rendInvokeReplyVer = 0
    /\ rendSwallowedReject = FALSE
    /\ rendActedPreHydration = FALSE
    /\ pendingPush = "none"
    /\ pendingPushState = "idle"
    /\ pendingPushVer = 0
    /\ checksStarted = 0
    /\ sawRestartRequired = FALSE
    /\ installedWithoutDrainOrReadiness = FALSE

-----------------------------------------------------------------------------
(* 1. Startup, Hydration & Updater Initialization *)

\* boot.ts:102 desktopUpdateController.start() -> getUpdateState() resolves (controller.ts:82-91).
\* Because getUpdateState() was sent synchronously at boot before settingsPorts.update binding
\* (boot.ts:700) and handled synchronously in update-ipc.ts:31-35, its FIFO reply is the initial
\* "idle" snapshot and only renders if revision === before (~rendHydrationSawPush).
RendererHydrationCompletes ==
    /\ windowOpen
    /\ ~ipcDisposed
    /\ ~rendHydrated
    /\ rendHydrated' = TRUE
    /\ IF ~rendHydrationSawPush
       THEN /\ rendState' = "idle"
            /\ rendVersion' = 0
       ELSE UNCHANGED <<rendState, rendVersion>>
    /\ UNCHANGED <<initVars, mainVars, quitVars, windowOpen, rendHydrationSawPush,
                   rendActiveKind, rendActiveSawPush, rendInvokePending,
                   rendInvokeReplyState, rendInvokeReplyVer,
                   rendSwallowedReject, rendActedPreHydration,
                   pendingPush, pendingPushState, pendingPushVer, ghostVars>>

\* index.ts:1484 void updateController.start()
StartBootInit ==
    /\ ~started
    /\ ~closed
    /\ initPhase = "idle"
    /\ started' = TRUE
    /\ initPhase' = "floor"
    /\ UNCHANGED <<floor, updaterLoaded, updaterConfigured, periodicScheduled,
                   mainVars, quitVars, rendVars, ghostVars>>

\* update-version-floor.ts recordRunningVersion succeeds with floor = current or higher
VersionFloorReady(f) ==
    /\ initPhase = "floor"
    /\ ~closed
    /\ f \in {"current", "higher"}
    /\ floor' = f
    /\ initPhase' = "loading"
    /\ UNCHANGED <<started, updaterLoaded, updaterConfigured, periodicScheduled,
                   mainVars, quitVars, rendVars, ghostVars>>

\* update-version-floor.ts recordRunningVersion returns unavailable / throws
\* update-controller.ts:511-520 returns false BEFORE scheduleInterval (line 539)!
VersionFloorUnavailable ==
    /\ initPhase = "floor"
    /\ ~closed
    /\ initPhase' = "failed"
    /\ periodicScheduled' = (periodicScheduled \/ ScheduleIntervalOnInitFailure)
    /\ Publish("failed", "check", 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "failed"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<started, floor, updaterLoaded, updaterConfigured,
                   opPresent, opCurrent, opStage, opTarget, opPendingCalls, opZipReady,
                   opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opHighWater, opFallbackActive, opKilledOnFallback,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* loadUpdater() rejects -> restart-required(check) (update-controller.ts:524-529)
LoadUpdaterFails ==
    /\ initPhase = "loading"
    /\ ~closed
    /\ initPhase' = "failed"
    /\ Publish("restart-required", "check", 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "restart-required"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<started, floor, updaterLoaded, updaterConfigured, periodicScheduled,
                   opPresent, opCurrent, opStage, opTarget, opPendingCalls, opZipReady,
                   opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opHighWater, opFallbackActive, opKilledOnFallback,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* loadUpdater() succeeds AND configuration + scheduleInterval succeed (update-controller.ts:525-553)
LoadAndConfigureSucceeds ==
    /\ initPhase = "loading"
    /\ ~closed
    /\ initPhase' = "ready"
    /\ updaterLoaded' = TRUE
    /\ updaterConfigured' = TRUE
    /\ periodicScheduled' = TRUE
    /\ UNCHANGED <<started, floor, mainVars, quitVars, rendVars, ghostVars>>

\* loadUpdater() succeeds, assigns `updater`, then config/scheduleInterval throws (update-controller.ts:525, 543-552)
LoadSucceedsConfigFails ==
    /\ initPhase = "loading"
    /\ ~closed
    /\ initPhase' = "failed"
    /\ updaterLoaded' = ~ClearUpdaterOnConfigFailure
    /\ updaterConfigured' = FALSE
    /\ periodicScheduled' = (periodicScheduled \/ ScheduleIntervalOnInitFailure)
    /\ Publish("failed", "check", 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "failed"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<started, floor,
                   opPresent, opCurrent, opStage, opTarget, opPendingCalls, opZipReady,
                   opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opHighWater, opFallbackActive, opKilledOnFallback,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

-----------------------------------------------------------------------------
(* 2. Check Initiation: startup, periodic tick, or renderer manual click *)

StartCheckOp ==
    /\ ~opPresent
    /\ CanCheck
    /\ updaterLoaded
    /\ checksStarted < MaxChecks
    /\ checksStarted' = checksStarted + 1
    /\ opPresent' = TRUE
    /\ opCurrent' = TRUE
    /\ opStage' = "check"
    /\ opTarget' = 0
    /\ opPendingCalls' = 1
    /\ opZipReady' = FALSE
    /\ opNativeReady' = ~RequiresNative
    /\ opNativeReadyVer' = 0
    /\ opTimersArmed' = TRUE
    /\ opHighWater' = FALSE
    /\ opFallbackActive' = FALSE
    /\ Publish("checking", "none", 0)

\* Boot / periodic check runs directly in main (update-controller.ts:578, 540)
MainStartsCheck ==
    /\ started
    /\ initPhase = "ready"
    /\ StartCheckOp
    /\ UNCHANGED <<initVars, squirrelInFlightVer, opKilledOnFallback, closed, installRequested,
                   installInvokedCount, readinessWatch, readinessInvalidated, quitVars,
                   windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendInvokePending, rendInvokeReplyState,
                   rendInvokeReplyVer, rendSwallowedReject, rendActedPreHydration,
                   installedWithoutDrainOrReadiness>>

\* Athlete clicks "Check for updates" or "Retry" in Settings (renderer/update/controller.ts:42-78)
AthleteClicksCheck ==
    /\ windowOpen
    /\ ~ipcDisposed
    /\ rendActiveKind = "none"
    /\ rendState \in {"idle", "current", "failed"}
    /\ (BlockActionsUntilHydrated => rendHydrated)
    /\ rendActiveKind' = "check"
    /\ rendActiveSawPush' = FALSE
    /\ rendActedPreHydration' = (rendActedPreHydration \/ ~rendHydrated)
    /\ IF opPresent
       THEN IF opCurrent
            THEN /\ rendInvokePending' = "in-flight"
                 /\ UNCHANGED <<rendInvokeReplyState, rendInvokeReplyVer, initVars, mainVars,
                                pendingPush, pendingPushState, pendingPushVer, ghostVars>>
            ELSE \* Dead settled activeOperation: returns cached promise immediately!
                 /\ rendInvokePending' = "settled"
                 /\ rendInvokeReplyState' = mainState
                 /\ rendInvokeReplyVer' = mainVersion
                 /\ UNCHANGED <<initVars, mainVars, pendingPush, pendingPushState, pendingPushVer, ghostVars>>
       ELSE IF ~CanCheck
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = mainState
            /\ rendInvokeReplyVer' = mainVersion
            /\ UNCHANGED <<initVars, mainVars, pendingPush, pendingPushState, pendingPushVer, ghostVars>>
       ELSE IF updaterLoaded
       THEN /\ checksStarted < MaxChecks
            /\ StartCheckOp
            /\ rendInvokePending' = "in-flight"
            /\ UNCHANGED <<initVars, squirrelInFlightVer, opKilledOnFallback, closed, installRequested,
                           installInvokedCount, readinessWatch, readinessInvalidated,
                           rendInvokeReplyState, rendInvokeReplyVer, installedWithoutDrainOrReadiness>>
       ELSE \* updater === undefined: retries initializeUpdater()
            /\ initPhase \in {"idle", "failed"}
            /\ initPhase' = IF floor = "none" THEN "floor" ELSE "loading"
            /\ rendInvokePending' = "in-flight"
            /\ UNCHANGED <<started, floor, updaterLoaded, updaterConfigured, periodicScheduled,
                           mainVars, pendingPush, pendingPushState, pendingPushVer,
                           rendInvokeReplyState, rendInvokeReplyVer, ghostVars>>
    /\ UNCHANGED <<quitVars, windowOpen, rendHydrated, rendHydrationSawPush,
                   rendState, rendVersion, rendSwallowedReject>>

\* If renderer initiated check during init and init just reached ready, main proceeds to runCheck()
FinishInitAndRunCheck ==
    /\ initPhase = "ready"
    /\ rendActiveKind = "check"
    /\ rendInvokePending = "in-flight"
    /\ ~opPresent
    /\ StartCheckOp
    /\ UNCHANGED <<initVars, squirrelInFlightVer, opKilledOnFallback, closed, installRequested,
                   installInvokedCount, readinessWatch, readinessInvalidated, quitVars,
                   windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendInvokePending, rendInvokeReplyState,
                   rendInvokeReplyVer, rendSwallowedReject, rendActedPreHydration,
                   installedWithoutDrainOrReadiness>>

-----------------------------------------------------------------------------
(* 3. Check & Download Lifecycle (update-controller.ts:261-496) *)

\* Check resolves: no newer update available -> current (update-controller.ts:463-471)
CheckResolvesCurrent ==
    /\ IsCurrent
    /\ opStage = "check"
    /\ opPendingCalls > 0
    /\ opPendingCalls' = opPendingCalls - 1
    /\ opCurrent' = FALSE
    /\ opTimersArmed' = FALSE
    /\ opPresent' = (opPendingCalls - 1 > 0)
    /\ Publish("current", "none", 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "current"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opZipReady, opNativeReady, opNativeReadyVer,
                   squirrelInFlightVer, opHighWater, opFallbackActive, opKilledOnFallback,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Check resolves: candidate version v \in {1, 2} available (1 < higher floor; 2 >= higher floor)
\* update-controller.ts:472-488
CheckResolvesUpdate(v) ==
    /\ IsCurrent
    /\ opStage = "check"
    /\ opPendingCalls > 0
    /\ v \in {1, 2}
    /\ LET belowFloor == (floor = "none") \/ (floor = "higher" /\ v = 1) IN
       IF EnforceVersionFloor /\ belowFloor
       THEN /\ opPendingCalls' = opPendingCalls - 1
            /\ opCurrent' = FALSE
            /\ opTimersArmed' = FALSE
            /\ opPresent' = (opPendingCalls - 1 > 0)
            /\ Publish("failed", "check", 0)
            /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
               THEN /\ rendInvokePending' = "settled"
                    /\ rendInvokeReplyState' = "failed"
                    /\ rendInvokeReplyVer' = 0
               ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
            /\ UNCHANGED <<opStage, opTarget, opHighWater, opFallbackActive>>
       ELSE /\ opStage' = "download"
            /\ opTarget' = v
            /\ opPendingCalls' = opPendingCalls
            /\ opCurrent' = TRUE
            /\ opPresent' = TRUE
            /\ opTimersArmed' = TRUE
            /\ opHighWater' = FALSE
            /\ opFallbackActive' = FALSE
            /\ Publish("downloading", "none", v)
            /\ UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<initVars, opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opKilledOnFallback, closed, installRequested, installInvokedCount,
                   readinessWatch, readinessInvalidated, quitVars, windowOpen, rendHydrated,
                   rendHydrationSawPush, rendState, rendVersion, rendActiveKind, rendActiveSawPush,
                   rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Differential download advances lastTransferred high-water mark (update-controller.ts:357)
DownloadProgressAdvances ==
    /\ IsCurrent
    /\ opStage = "download"
    /\ ~opZipReady
    /\ ~opFallbackActive
    /\ ~opHighWater
    /\ opHighWater' = TRUE
    /\ UNCHANGED <<initVars, mainState, mainStage, mainVersion, opPresent, opCurrent, opStage, opTarget,
                   opPendingCalls, opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opFallbackActive, opKilledOnFallback, closed, installRequested,
                   installInvokedCount, readinessWatch, readinessInvalidated, quitVars, rendVars, ghostVars>>

\* Differential download fails & falls back to full download (MacUpdater.js:104-106), resetting transferred to 0
DownloadFallsBackToFull ==
    /\ IsCurrent
    /\ opStage = "download"
    /\ ~opZipReady
    /\ opHighWater
    /\ ~opFallbackActive
    /\ opFallbackActive' = TRUE
    /\ opHighWater' = IF ResetTransferWatermarkOnFallback THEN FALSE ELSE opHighWater
    /\ UNCHANGED <<initVars, mainState, mainStage, mainVersion, opPresent, opCurrent, opStage, opTarget,
                   opPendingCalls, opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opKilledOnFallback, closed, installRequested, installInvokedCount,
                   readinessWatch, readinessInvalidated, quitVars, rendVars, ghostVars>>

\* Full fallback download progresses below prior high-water mark; stall timer expires!
FallbackDownloadExpiresAsStall ==
    /\ IsCurrent
    /\ opStage = "download"
    /\ ~opZipReady
    /\ opFallbackActive
    /\ opHighWater
    /\ opTimersArmed
    /\ opCurrent' = FALSE
    /\ opTimersArmed' = FALSE
    /\ opPresent' = FALSE  \* expireOperation passes detachPending = TRUE
    /\ opKilledOnFallback' = TRUE
    /\ Publish("restart-required", "download", 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "restart-required"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opPendingCalls, opZipReady, opNativeReady,
                   opNativeReadyVer, squirrelInFlightVer, opHighWater, opFallbackActive,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* electron-updater emits update-downloaded for matching version (MacUpdater.js:219 -> 223 starts Squirrel!)
ZipUpdateDownloaded ==
    /\ IsCurrent
    /\ opStage = "download"
    /\ ~opZipReady
    /\ opZipReady' = TRUE
    /\ squirrelInFlightVer' = IF RequiresNative THEN opTarget ELSE squirrelInFlightVer
    /\ LET readyNow == (~RequiresNative) \/ opNativeReady \/ (~RequireNativeReadinessOnMac) IN
       IF readyNow
       THEN /\ opCurrent' = FALSE
            /\ opTimersArmed' = FALSE
            /\ opPresent' = IF DetachSettledOperation THEN FALSE ELSE (opPendingCalls > 0)
            /\ readinessInvalidated' = FALSE
            /\ readinessWatch' = RequiresNative
            /\ Publish("downloaded", "none", opTarget)
            /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
               THEN /\ rendInvokePending' = "settled"
                    /\ rendInvokeReplyState' = "downloaded"
                    /\ rendInvokeReplyVer' = opTarget
               ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
       ELSE UNCHANGED <<mainState, mainStage, mainVersion, opPresent, opCurrent, opTimersArmed,
                        readinessWatch, readinessInvalidated,
                        pendingPush, pendingPushState, pendingPushVer,
                        rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer,
                        sawRestartRequired>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opPendingCalls, opNativeReady, opNativeReadyVer,
                   opHighWater, opFallbackActive, opKilledOnFallback, closed, installRequested,
                   installInvokedCount, quitVars, windowOpen, rendHydrated, rendHydrationSawPush,
                   rendState, rendVersion, rendActiveKind, rendActiveSawPush,
                   rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Squirrel.Mac nativeUpdater emits update-downloaded for squirrelInFlightVer (MacUpdater.js:22-25)
\* BUG-4: on origin/main, nativeDownloadedListener is armed in beginDownload BEFORE zipReady,
\* so a stale Squirrel event from Attempt 1 flips opNativeReady = TRUE on Attempt 2!
NativeUpdateDownloaded ==
    /\ RequiresNative
    /\ squirrelInFlightVer # 0
    /\ squirrelInFlightVer' = 0
    /\ IF IsCurrent /\ opStage = "download" /\ ~opNativeReady
          /\ (ArmNativeListenersOnlyAfterZipReady => opZipReady)
       THEN /\ opNativeReady' = TRUE
            /\ opNativeReadyVer' = squirrelInFlightVer
            /\ IF opZipReady
               THEN /\ opCurrent' = FALSE
                    /\ opTimersArmed' = FALSE
                    /\ opPresent' = IF DetachSettledOperation THEN FALSE ELSE (opPendingCalls > 0)
                    /\ readinessInvalidated' = FALSE
                    /\ readinessWatch' = TRUE
                    /\ Publish("downloaded", "none", opTarget)
                    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
                       THEN /\ rendInvokePending' = "settled"
                            /\ rendInvokeReplyState' = "downloaded"
                            /\ rendInvokeReplyVer' = opTarget
                       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
               ELSE UNCHANGED <<mainState, mainStage, mainVersion, opPresent, opCurrent, opTimersArmed,
                                readinessWatch, readinessInvalidated,
                                pendingPush, pendingPushState, pendingPushVer,
                                rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer,
                                sawRestartRequired>>
       ELSE UNCHANGED <<mainState, mainStage, mainVersion, opPresent, opCurrent, opNativeReady,
                        opNativeReadyVer, opTimersArmed, readinessWatch, readinessInvalidated,
                        pendingPush, pendingPushState, pendingPushVer,
                        rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer,
                        sawRestartRequired>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opPendingCalls, opZipReady, opHighWater,
                   opFallbackActive, opKilledOnFallback, closed, installRequested, installInvokedCount,
                   quitVars, windowOpen, rendHydrated, rendHydrationSawPush, rendState, rendVersion,
                   rendActiveKind, rendActiveSawPush, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* updater or nativeUpdater emits "error" event while opPendingCalls > 0 (promise not yet settled!)
\* update-controller.ts:284-288 -> finishOperation(operation, true, detachPending=false)
UpdaterErrorEventBeforePromiseSettles ==
    /\ IsCurrent
    /\ opPendingCalls > 0
    /\ opCurrent' = FALSE
    /\ opTimersArmed' = FALSE
    /\ opPresent' = ~DetachSettledOperation
    /\ Publish("failed", opStage, 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "failed"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opPendingCalls, opZipReady, opNativeReady,
                   opNativeReadyVer, squirrelInFlightVer, opHighWater, opFallbackActive,
                   opKilledOnFallback, closed, installRequested, installInvokedCount,
                   readinessWatch, readinessInvalidated, quitVars, windowOpen, rendHydrated,
                   rendHydrationSawPush, rendState, rendVersion, rendActiveKind, rendActiveSawPush,
                   rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Underlying checkForUpdates() / downloadUpdate() promise settles
UnderlyingCallSettles ==
    /\ opPendingCalls > 0
    /\ opPendingCalls' = opPendingCalls - 1
    /\ IF opPresent /\ ~opCurrent /\ opPendingCalls - 1 = 0
       THEN opPresent' = FALSE
       ELSE UNCHANGED opPresent
    /\ UNCHANGED <<initVars, mainState, mainStage, mainVersion, opCurrent, opStage, opTarget,
                   opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opTimersArmed, opHighWater, opFallbackActive, opKilledOnFallback,
                   closed, installRequested, installInvokedCount, readinessWatch, readinessInvalidated,
                   quitVars, rendVars, ghostVars>>

\* Check / stall / preparation / absolute deadline fires -> expireOperation (update-controller.ts:289-293)
OperationDeadlineExpires ==
    /\ IsCurrent
    /\ opTimersArmed
    /\ opCurrent' = FALSE
    /\ opTimersArmed' = FALSE
    /\ opPresent' = FALSE  \* detachPending = TRUE
    /\ Publish("restart-required", opStage, 0)
    /\ IF rendInvokePending = "in-flight" /\ rendActiveKind = "check"
       THEN /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "restart-required"
            /\ rendInvokeReplyVer' = 0
       ELSE UNCHANGED <<rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer>>
    /\ UNCHANGED <<initVars, opStage, opTarget, opPendingCalls, opZipReady, opNativeReady,
                   opNativeReadyVer, squirrelInFlightVer, opHighWater, opFallbackActive,
                   opKilledOnFallback, closed, installRequested, installInvokedCount,
                   readinessWatch, readinessInvalidated, quitVars, windowOpen, rendHydrated,
                   rendHydrationSawPush, rendState, rendVersion, rendActiveKind, rendActiveSawPush,
                   rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Late native error arrives AFTER downloaded (readinessWatch armed, update-controller.ts:237-244)
NativeReadinessInvalidated ==
    /\ readinessWatch
    /\ ~readinessInvalidated
    /\ readinessInvalidated' = TRUE
    /\ readinessWatch' = FALSE
    /\ IF ~closed /\ ~installRequested /\ mainState = "downloaded"
       THEN Publish("failed", "download", 0)
       ELSE UNCHANGED <<mainState, mainStage, mainVersion, pendingPush, pendingPushState,
                        pendingPushVer, sawRestartRequired>>
    /\ UNCHANGED <<initVars, opPresent, opCurrent, opStage, opTarget, opPendingCalls, opZipReady,
                   opNativeReady, opNativeReadyVer, squirrelInFlightVer, opTimersArmed,
                   opHighWater, opFallbackActive, opKilledOnFallback, closed, installRequested,
                   installInvokedCount, quitVars, windowOpen, rendHydrated, rendHydrationSawPush,
                   rendState, rendVersion, rendActiveKind, rendActiveSawPush, rendInvokePending,
                   rendInvokeReplyState, rendInvokeReplyVer, rendSwallowedReject,
                   rendActedPreHydration, checksStarted, installedWithoutDrainOrReadiness>>

-----------------------------------------------------------------------------
(* 4. Restart to Update, Quit Coordinator, Shutdown & Install Handoff *)

\* Athlete clicks "Restart to update" -> IPC restartToUpdate (update-controller.ts:585-593)
AthleteClicksRestart ==
    /\ windowOpen
    /\ ~ipcDisposed
    /\ rendActiveKind = "none"
    /\ rendState = "downloaded"
    /\ rendActiveKind' = "restart"
    /\ rendActiveSawPush' = FALSE
    /\ IF ~closed /\ mainState = "downloaded" /\ ~installRequested
       THEN /\ installRequested' = TRUE
            /\ Publish("installing", "none", mainVersion)
            /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = "installing"
            /\ rendInvokeReplyVer' = mainVersion
            /\ IF quitPhase = "running"
               THEN /\ quitPhase' = "draining"
                    /\ quitReason' = "update"
               ELSE UNCHANGED <<quitPhase, quitReason>>
       ELSE /\ rendInvokePending' = "settled"
            /\ rendInvokeReplyState' = mainState
            /\ rendInvokeReplyVer' = mainVersion
            /\ UNCHANGED <<installRequested, mainState, mainStage, mainVersion,
                           pendingPush, pendingPushState, pendingPushVer, sawRestartRequired,
                           quitPhase, quitReason>>
    /\ UNCHANGED <<initVars, opPresent, opCurrent, opStage, opTarget, opPendingCalls, opZipReady,
                   opNativeReady, opNativeReadyVer, squirrelInFlightVer, opTimersArmed,
                   opHighWater, opFallbackActive, opKilledOnFallback, closed, installInvokedCount,
                   readinessWatch, readinessInvalidated, drainOutcome, finalQuitAllowed,
                   handoffTimer, ipcDisposed, windowOpen, rendHydrated, rendHydrationSawPush,
                   rendState, rendVersion, rendSwallowedReject, rendActedPreHydration,
                   checksStarted, installedWithoutDrainOrReadiness>>

\* Ordinary quit (Cmd+Q / Tray Quit / SIGTERM) (main/index.ts:497-501)
\* BUG-8: on origin/main, FreezeUpdateOnBeforeQuit = FALSE, so ipcDisposed and closed stay FALSE
\* while shutdown() awaits residencyClose / intervalsIpcClose / telegramIpcClose!
OrdinaryQuitRequested ==
    /\ quitPhase = "running"
    /\ quitPhase' = "draining"
    /\ quitReason' = "ordinary"
    /\ IF FreezeUpdateOnBeforeQuit
       THEN /\ ipcDisposed' = TRUE
            /\ closed' = TRUE
            /\ periodicScheduled' = FALSE
            /\ readinessWatch' = FALSE
            /\ opPresent' = FALSE
            /\ opCurrent' = FALSE
            /\ opTimersArmed' = FALSE
       ELSE UNCHANGED <<ipcDisposed, closed, periodicScheduled, readinessWatch,
                        opPresent, opCurrent, opTimersArmed>>
    /\ UNCHANGED <<started, initPhase, floor, updaterLoaded, updaterConfigured,
                   mainState, mainStage, mainVersion, opStage, opTarget, opPendingCalls,
                   opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opHighWater, opFallbackActive, opKilledOnFallback, installRequested,
                   installInvokedCount, readinessInvalidated,
                   drainOutcome, finalQuitAllowed, handoffTimer, rendVars, ghostVars>>

\* Mid-shutdown: index.ts:467 disposeUpdateIpc() and index.ts:478 updateController.close()
ShutdownClosesUpdateController ==
    /\ quitPhase = "draining"
    /\ ~closed
    /\ ipcDisposed' = TRUE
    /\ closed' = TRUE
    /\ periodicScheduled' = FALSE
    /\ IF installRequested
       THEN \* update-controller.ts:625 returns early, keeping readinessWatch armed!
            UNCHANGED <<readinessWatch, opPresent, opCurrent, opTimersArmed>>
       ELSE /\ readinessWatch' = FALSE
            /\ opPresent' = FALSE
            /\ opCurrent' = FALSE
            /\ opTimersArmed' = FALSE
    /\ UNCHANGED <<started, initPhase, floor, updaterLoaded, updaterConfigured,
                   mainState, mainStage, mainVersion, opStage, opTarget, opPendingCalls,
                   opZipReady, opNativeReady, opNativeReadyVer, squirrelInFlightVer,
                   opHighWater, opFallbackActive, opKilledOnFallback, installRequested,
                   installInvokedCount, readinessInvalidated,
                   quitPhase, quitReason, drainOutcome, finalQuitAllowed, handoffTimer,
                   rendVars, ghostVars>>

\* Drain completes cleanly, fails, or times out (quit-coordinator.ts:91-134)
DrainFinishes(outcome) ==
    /\ quitPhase = "draining"
    /\ closed
    /\ outcome \in {"drained", "failed", "timed-out"}
    /\ drainOutcome' = outcome
    /\ IF outcome # "drained" /\ GateInstallOnDrainAndReadiness
       THEN /\ quitPhase' = IF quitReason = "update" /\ RelaunchOnInstallFailure
                            THEN "relaunching"
                            ELSE "exited-error"
            /\ UNCHANGED <<finalQuitAllowed, handoffTimer, installInvokedCount,
                           installedWithoutDrainOrReadiness>>
       ELSE IF installRequested /\ updaterLoaded
       THEN IF GateInstallOnDrainAndReadiness /\ readinessInvalidated
            THEN \* completeInstallAfterDrain returns "failed" (update-controller.ts:604)
                 \* #391: quit-coordinator.ts:128-131 calls exit(1) without relaunching!
                 /\ quitPhase' = IF RelaunchOnInstallFailure THEN "relaunching" ELSE "exited-error"
                 /\ UNCHANGED <<finalQuitAllowed, handoffTimer, installInvokedCount,
                                installedWithoutDrainOrReadiness>>
            ELSE \* quitAndInstall either starts handoff (macOS / Windows) or throws synchronously
                 \/ ( /\ finalQuitAllowed' = TRUE
                      /\ installInvokedCount' = IF GuardSingleInstallInvocation /\ installInvokedCount > 0
                                                THEN installInvokedCount
                                                ELSE installInvokedCount + 1
                      /\ installedWithoutDrainOrReadiness' =
                            (installedWithoutDrainOrReadiness \/ outcome # "drained" \/ readinessInvalidated)
                      /\ quitPhase' = "handoff"
                      /\ handoffTimer' = TRUE )
                 \/ ( \* quitAndInstall() throws synchronously (update-controller.ts:611-612)
                      /\ finalQuitAllowed' = TRUE
                      /\ installInvokedCount' = IF GuardSingleInstallInvocation /\ installInvokedCount > 0
                                                THEN installInvokedCount
                                                ELSE installInvokedCount + 1
                      /\ installedWithoutDrainOrReadiness' =
                            (installedWithoutDrainOrReadiness \/ outcome # "drained" \/ readinessInvalidated)
                      /\ quitPhase' = IF RelaunchOnInstallFailure THEN "relaunching" ELSE "exited-error"
                      /\ handoffTimer' = FALSE )
       ELSE \* Ordinary quit: completeInstallAfterDrain returns "not-requested" -> exit(0)
            /\ finalQuitAllowed' = TRUE
            /\ quitPhase' = "exited-clean"
            /\ UNCHANGED <<handoffTimer, installInvokedCount, installedWithoutDrainOrReadiness>>
    /\ UNCHANGED <<initVars, mainState, mainStage, mainVersion, opPresent, opCurrent, opStage,
                   opTarget, opPendingCalls, opZipReady, opNativeReady, opNativeReadyVer,
                   squirrelInFlightVer, opTimersArmed, opHighWater, opFallbackActive,
                   opKilledOnFallback, closed, installRequested, readinessWatch, readinessInvalidated,
                   quitReason, ipcDisposed, rendVars, checksStarted, sawRestartRequired>>

\* Repeated completeInstallAfterDrain call (checks GuardSingleInstallInvocation idempotency)
DuplicateInstallHandoffCall ==
    /\ quitPhase = "handoff"
    /\ installRequested
    /\ updaterLoaded
    /\ ~(GateInstallOnDrainAndReadiness /\ readinessInvalidated)
    /\ installInvokedCount < 2
    /\ ~GuardSingleInstallInvocation
    /\ installInvokedCount' = installInvokedCount + 1
    /\ UNCHANGED <<initVars, mainState, mainStage, mainVersion, opPresent, opCurrent, opStage,
                   opTarget, opPendingCalls, opZipReady, opNativeReady, opNativeReadyVer,
                   squirrelInFlightVer, opTimersArmed, opHighWater, opFallbackActive,
                   opKilledOnFallback, closed, installRequested, readinessWatch, readinessInvalidated,
                   quitVars, rendVars, ghostVars>>

\* Squirrel/NSIS emits final before-quit -> allowed -> update installs cleanly
InstallHandoffAccepted ==
    /\ quitPhase = "handoff"
    /\ finalQuitAllowed
    /\ quitPhase' = "installed"
    /\ handoffTimer' = FALSE
    /\ UNCHANGED <<initVars, mainVars, quitReason, drainOutcome, finalQuitAllowed, ipcDisposed,
                   rendVars, ghostVars>>

\* 30s handoff watchdog fires (macOS async error or Windows BaseUpdater silent error)
InstallHandoffTimesOut ==
    /\ quitPhase = "handoff"
    /\ handoffTimer
    /\ handoffTimer' = FALSE
    /\ quitPhase' = IF RelaunchOnInstallFailure THEN "relaunching" ELSE "exited-error"
    /\ UNCHANGED <<initVars, mainVars, quitReason, drainOutcome, finalQuitAllowed, ipcDisposed,
                   rendVars, ghostVars>>

-----------------------------------------------------------------------------
(* 5. Renderer IPC Delivery & Invoke Rejection *)

\* Renderer receives pushed update state via onUpdateState (renderer/update/controller.ts:34-40)
RendererReceivesPush ==
    /\ windowOpen
    /\ pendingPush = "queued"
    /\ pendingPush' = "none"
    /\ rendHydrated' = TRUE
    /\ rendHydrationSawPush' = TRUE
    /\ rendState' = pendingPushState
    /\ rendVersion' = pendingPushVer
    /\ rendActiveSawPush' = IF rendActiveKind # "none" THEN TRUE ELSE rendActiveSawPush
    /\ UNCHANGED <<initVars, mainVars, quitVars, windowOpen, rendActiveKind,
                   rendInvokePending, rendInvokeReplyState, rendInvokeReplyVer,
                   rendSwallowedReject, rendActedPreHydration,
                   pendingPushState, pendingPushVer, ghostVars>>

\* IPC invoke checkForUpdates() / restartToUpdate() resolves in renderer (renderer/update/controller.ts:57-75)
RendererReceivesInvokeReply ==
    /\ windowOpen
    /\ rendActiveKind # "none"
    /\ rendInvokePending = "settled"
    /\ rendInvokePending' = "none"
    /\ rendActiveKind' = "none"
    /\ rendActiveSawPush' = FALSE
    /\ rendHydrated' = TRUE
    /\ rendHydrationSawPush' = TRUE
    /\ IF RendererHandlesRejectionAfterPush \/ ~rendActiveSawPush
       THEN /\ rendState' = rendInvokeReplyState
            /\ rendVersion' = rendInvokeReplyVer
       ELSE UNCHANGED <<rendState, rendVersion>>
    /\ UNCHANGED <<initVars, mainVars, quitVars, windowOpen,
                   rendInvokeReplyState, rendInvokeReplyVer,
                   rendSwallowedReject, rendActedPreHydration,
                   pendingPush, pendingPushState, pendingPushVer, ghostVars>>

\* IPC invoke checkForUpdates() rejects in renderer (renderer/update/controller.ts:61-68)
RendererInvokeRejects ==
    /\ windowOpen
    /\ rendActiveKind = "check"
    /\ rendInvokePending = "in-flight"
    /\ rendInvokePending' = "none"
    /\ rendActiveKind' = "none"
    /\ rendActiveSawPush' = FALSE
    /\ IF RendererHandlesRejectionAfterPush \/ ~rendActiveSawPush
       THEN /\ rendState' = "failed"
            /\ rendVersion' = 0
            /\ rendSwallowedReject' = FALSE
       ELSE /\ rendSwallowedReject' = (rendState \in {"checking", "downloading"})
            /\ UNCHANGED <<rendState, rendVersion>>
    /\ UNCHANGED <<initVars, mainVars, quitVars, windowOpen, rendHydrated, rendHydrationSawPush,
                   rendInvokeReplyState, rendInvokeReplyVer, rendActedPreHydration,
                   pendingPush, pendingPushState, pendingPushVer, ghostVars>>

\* End-state stutter to prevent false deadlock reports in /statechart
Done ==
    /\ quitPhase \in {"exited-clean", "exited-error", "relaunching", "installed"}
    /\ UNCHANGED vars

-----------------------------------------------------------------------------

Next ==
    \/ RendererHydrationCompletes
    \/ StartBootInit
    \/ \E f \in {"current", "higher"} : VersionFloorReady(f)
    \/ VersionFloorUnavailable
    \/ LoadUpdaterFails
    \/ LoadAndConfigureSucceeds
    \/ LoadSucceedsConfigFails
    \/ MainStartsCheck
    \/ AthleteClicksCheck
    \/ FinishInitAndRunCheck
    \/ CheckResolvesCurrent
    \/ \E v \in {1, 2} : CheckResolvesUpdate(v)
    \/ DownloadProgressAdvances
    \/ DownloadFallsBackToFull
    \/ FallbackDownloadExpiresAsStall
    \/ ZipUpdateDownloaded
    \/ NativeUpdateDownloaded
    \/ UpdaterErrorEventBeforePromiseSettles
    \/ UnderlyingCallSettles
    \/ OperationDeadlineExpires
    \/ NativeReadinessInvalidated
    \/ AthleteClicksRestart
    \/ OrdinaryQuitRequested
    \/ ShutdownClosesUpdateController
    \/ \E o \in {"drained", "failed", "timed-out"} : DrainFinishes(o)
    \/ DuplicateInstallHandoffCall
    \/ InstallHandoffAccepted
    \/ InstallHandoffTimesOut
    \/ RendererReceivesPush
    \/ RendererReceivesInvokeReply
    \/ RendererInvokeRejects
    \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Type sanity *)

TypeOK ==
    /\ initPhase \in {"idle", "floor", "loading", "ready", "failed"}
    /\ floor \in {"none", "current", "higher"}
    /\ mainState \in {"idle", "checking", "current", "downloading", "downloaded", "installing", "restart-required", "failed"}
    /\ mainStage \in {"none", "check", "download"}
    /\ mainVersion \in Versions
    /\ opStage \in {"none", "check", "download"}
    /\ opTarget \in Versions
    /\ opPendingCalls \in 0..2
    /\ opNativeReadyVer \in Versions
    /\ squirrelInFlightVer \in Versions
    /\ installInvokedCount \in 0..2
    /\ quitPhase \in {"running", "draining", "handoff", "exited-clean", "exited-error", "relaunching", "installed"}
    /\ quitReason \in {"none", "ordinary", "update"}
    /\ drainOutcome \in {"none", "drained", "failed", "timed-out"}
    /\ rendState \in {"idle", "checking", "current", "downloading", "downloaded", "installing", "restart-required", "failed"}
    /\ rendVersion \in Versions
    /\ rendActiveKind \in {"none", "check", "restart"}
    /\ rendInvokePending \in {"none", "in-flight", "settled"}
    /\ checksStarted \in 0..MaxChecks

-----------------------------------------------------------------------------
(* Safety & User-Promise Invariants — NEVER weakened *)

\* 1 (BUG-1). A failed update state never holds a dead timerless activeOperation
\*    that silently swallows Retry clicks (including after publishIfReady + readiness error).
NoPermanentRetryWedge ==
    (mainState = "failed" /\ opPresent /\ ~opCurrent) => opTimersArmed

\* 2 (BUG-2). Differential-to-full fallback download transferring from 0 is never
\*    misclassified as a stall and locked into restart-required.
FallbackDownloadNotKilledAsStall ==
    ~opKilledOnFallback

\* 3 (BUG-3 / #391). Clicking "Restart to update" never exits with an error
\*    without installing or relaunching the app.
RestartToUpdateNeverStrandsApp ==
    quitReason = "update" => quitPhase # "exited-error"

\* 4 (BUG-4). On macOS, a published downloaded(v) update must have Squirrel.Mac
\*    native readiness for THAT EXACT version v, never a stale version from a failed attempt.
NoStaleMacNativeReadiness ==
    (RequiresNative /\ mainState = "downloaded") => (opNativeReadyVer = mainVersion)

\* 5 (BUG-5). checkForUpdates() never runs on an updater whose configuration failed.
UpdaterAlwaysConfiguredBeforeCheck ==
    opPresent => updaterConfigured

\* 6 (BUG-6). The sidebar UpdateAvailableButton never displays "Restarting..."
\*    while nobody has clicked Restart to update.
SidebarNeverShowsFalseRestarting ==
    SidebarShowsRestarting => (installRequested \/ rendActiveKind = "restart")

\* 7 (BUG-7 / #391 note). A transient startup init failure (version floor or config)
\*    never leaves an eligible app with no 6-hour periodic check scheduled.
StartupInitFailureSchedulesRecovery ==
    (started /\ initPhase = "failed" /\ mainState = "failed" /\ mainStage = "check" /\ ~closed)
        => periodicScheduled

\* 8 (BUG-8). An ordinary quit (Cmd+Q / Tray Quit / SIGTERM) is never hijacked
\*    into an update install during async shutdown.
OrdinaryQuitNeverInstallsUpdate ==
    quitReason = "ordinary" => installInvokedCount = 0

\* 9 (BUG-9). Renderer buttons never fire checkForUpdates() on fake initial "idle"
\*    before initial getUpdateState() hydration completes.
NoPreHydrationCheckRace ==
    ~rendActedPreHydration

\* 10 (BUG-11c / BUG-12). When a renderer checkForUpdates() IPC call rejects after intermediate
\*    checking/downloading pushes, the renderer never swallows the error and stays frozen.
RendererNeverSwallowsInvokeRejection ==
    ~rendSwallowedReject

\* 11 (Guarded Control). Never download a candidate below the recorded version floor.
NoDowngradeBelowFloor ==
    (opPresent /\ opStage = "download") => (floor # "none" /\ ~(floor = "higher" /\ opTarget = 1))

\* 12 (Guarded Control). On macOS, never publish downloaded before zipReady and nativeReady.
MacOsWaitsForNativeReadiness ==
    (RequiresNative /\ mainState = "downloaded") => (opZipReady /\ opNativeReady)

\* 13 (Guarded Control). Never invoke quitAndInstall without explicit restart, clean drain, and valid readiness.
NoInstallWithoutExplicitRestartAndDrain ==
    /\ ~installedWithoutDrainOrReadiness
    /\ (installInvokedCount > 0 => (installRequested /\ drainOutcome = "drained"))

\* 14 (Guarded Control). quitAndInstall is invoked at most once.
InstallInvokedAtMostOnce ==
    installInvokedCount <= 1

\* 15 (Guarded Control). Once restart-required is entered, no new check starts and state stays terminal.
RestartRequiredIsTerminal ==
    sawRestartRequired => (mainState = "restart-required" /\ ~opPresent)

-----------------------------------------------------------------------------
(* Reachability Witnesses — each must be VIOLATED to prove the premise is reachable *)

WitnessFailedWithPendingCall == ~(mainState = "failed" /\ opPendingCalls > 0)
WitnessFallbackReached == ~opFallbackActive
WitnessRestartQuitDraining == ~(quitReason = "update" /\ quitPhase = "draining")
WitnessStaleSquirrelPossible == ~(RequiresNative /\ opStage = "download" /\ ~opZipReady /\ squirrelInFlightVer # 0 /\ squirrelInFlightVer # opTarget)
WitnessConfigFailReached == ~(initPhase = "failed" /\ mainState = "failed" /\ ~updaterConfigured)
WitnessDownloadedWithCheckActive == ~(SidebarVisible /\ rendActiveKind = "check")
WitnessFloorFailReached == ~(started /\ initPhase = "failed" /\ floor = "none")
WitnessOrdinaryQuitDuringDownloaded == ~(quitReason = "ordinary" /\ quitPhase = "draining" /\ mainState = "downloaded")
WitnessUnHydratedWindow == ~(~rendHydrated /\ windowOpen)
WitnessInvokeRejectsAfterPush == ~(rendActiveKind = "check" /\ rendActiveSawPush /\ rendInvokePending = "in-flight" /\ rendState \in {"checking", "downloading"})
WitnessHigherFloorReached == ~(floor = "higher" /\ mainState = "checking")
WitnessMacDownloaded == ~(RequiresNative /\ mainState = "downloaded")
WitnessInstalled == ~(quitPhase = "installed")
WitnessRestartRequired == ~sawRestartRequired

=============================================================================
