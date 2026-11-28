---
name: verify-update-download
description: Model-check the desktop app's auto-update, download, macOS native preparation, version floor, quit-coordinator install handoff, and renderer update UI state machines with TLC TLA+. Use before and after any change to update-controller.ts, update-state-machine.ts, quit-coordinator.ts, update-version-floor.ts, update-ipc.ts, main/index.ts shutdown wiring, desktop-renderer/src/update/controller.ts, state/adapters/update.ts, UpdateAvailableButton.tsx, or ApplicationSection.tsx.
---

# Verify desktop update and download

Tests check the event orders someone wrote down. This skill runs TLC 1.7.4 across every interleaving of the main update controller, version floor, macOS Squirrel readiness, quit coordinator, update IPC, and renderer update UI inside the bounds below.

Sync commit: `9c2a7a96`. Every model action and fingerprint in `references/coverage.json` was last confirmed at that commit.

## When to run it

Run the check before and after changing any file in the coverage table below. You can also run it directly. It exits 3 (`STALE`) and names every covered function whose fingerprint changed since `9c2a7a96`.

To inspect git history for covered files since the sync commit:

```bash
git log --oneline 9c2a7a96..HEAD -- apps/desktop/src/main/update-controller.ts apps/desktop/src/main/update-state-machine.ts apps/desktop/src/main/quit-coordinator.ts apps/desktop/src/main/update-version-floor.ts apps/desktop/src/main/update-ipc.ts apps/desktop/src/main/index.ts apps/desktop-renderer/src/update/controller.ts apps/desktop-renderer/src/state/adapters/update.ts apps/desktop-renderer/src/state/settings-slice.ts apps/desktop-renderer/src/ui/sidebar/UpdateAvailableButton.tsx apps/desktop-renderer/src/ui/settings/ApplicationSection.tsx
```

## Run

Requires Node 22.18+ (or 24+) and Java 11+. Set `JAVA` to a `java` binary if Java is not on `PATH` or managed by mise. On first run, the script downloads TLC 1.7.4 (`tla2tools.jar`) to `~/.cache/enduragent/` and verifies its SHA-256. Set `TLA2TOOLS` to point at an existing release jar.

```bash
node .agents/skills/verify-update-download/scripts/check.ts
```

Options:

- `--trace <Rule>` runs one rule and prints the variables that changed on each step.
- `--keep <Dir>` preserves generated `.cfg` files and `tlc.out` transcripts.
- `--confirm` re-records `references/coverage.json` fingerprints and sync commit after a verified change.

What the script checks:

1. Reads 15 code facts from TypeScript source via `scripts/facts.ts` (ignoring comments).
2. Runs TLC on `TypeOK` and every rule whose extracted code facts say it holds.
3. Runs TLC on any rule whose code fact regressed and prints its shortest counterexample.
4. Runs every rule's reachability witness (must break) and broken-flag mutant (must break).
5. Checks `model/AthleteUpdateFlow.tla` for deadlock freedom and compares every covered function against `references/coverage.json`.

Exit codes: `0` when model and code match expected baseline, `1` on any regression or model error, `2` if Java or TLC is missing, `3` when covered code changed since the sync commit.

## The rules

Each invariant states one promise to the athlete. Never weaken an invariant to make a check pass. All 15 rules hold as guarded controls.

| Rule                                      | Plain promise                                                                                           | Harm when broken                                                                                                 | Status          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| `NoPermanentRetryWedge`                   | A failed update state never leaves a dead timerless active operation that swallows Retry.               | Manual Try again and 6-hour checks silently return a stale failure or stale downloaded promise without checking. | Holds (control) |
| `FallbackDownloadNotKilledAsStall`        | A differential-to-full fallback download transferring from byte 0 is never killed as a stall.           | Healthy full fallback downloads time out after 2 minutes into terminal `restart-required`.                       | Holds (control) |
| `RestartToUpdateNeverStrandsApp`          | After clicking Restart to update, the app never exits with an error without installing or relaunching.  | The app disappears with code 1 when readiness invalidates, drain fails, or install handoff fails/times out.      | Holds (control) |
| `NoStaleMacNativeReadiness`               | On macOS, published `downloaded(v)` has Squirrel.Mac readiness for that exact version `v`.              | A stale Squirrel event from a failed attempt poisons a retry for a newer version and installs the wrong build.   | Holds (control) |
| `UpdaterAlwaysConfiguredBeforeCheck`      | `checkForUpdates()` never runs on an updater whose configuration or interval setup threw.               | Retry runs with default `autoDownload = true` (bypassing the version floor) and no 6-hour timer.                 | Holds (control) |
| `SidebarNeverShowsFalseRestarting`        | The sidebar button never shows Restarting while nobody clicked Restart to update.                       | After a manual check downloads an update, the sidebar flashes disabled Restarting and announces restarting.      | Holds (control) |
| `StartupInitFailureSchedulesRecovery`     | A transient startup floor or config failure never disables 6-hour periodic update checks.               | Background update checks stop for the whole session unless the athlete manually clicks Try again.                | Holds (control) |
| `OrdinaryQuitNeverInstallsUpdate`         | An ordinary quit (Cmd+Q, Tray Quit, SIGTERM) is never hijacked into an update install.                  | Quitting the app normally during async shutdown can trigger an unexpected install and relaunch.                  | Holds (control) |
| `NoPreHydrationCheckRace`                 | Renderer update controls do not invoke `checkForUpdates()` before initial `getUpdateState()` hydrates.  | Early clicks race initial hydration on fake `idle` state.                                                        | Holds (control) |
| `RendererNeverSwallowsInvokeRejection`    | A rejected `checkForUpdates()` IPC call after `checking`/`downloading` pushes moves the UI to `failed`. | Settings stays frozen on Checking or Downloading with its button permanently disabled.                           | Holds (control) |
| `NoDowngradeBelowFloor`                   | The controller never downloads a version below the recorded version floor or when the floor is missing. | A rolled-back or tampered feed could downgrade the desktop app.                                                  | Holds (control) |
| `MacOsWaitsForNativeReadiness`            | On macOS, `downloaded` is never published before both `zipReady` and `nativeReady` are true.            | Restart to update fires before Squirrel.Mac finishes verifying the archive.                                      | Holds (control) |
| `NoInstallWithoutExplicitRestartAndDrain` | `quitAndInstall()` runs only after explicit Restart to update, clean daemon drain, and valid readiness. | An ordinary quit, failed drain, or invalidated macOS bundle launches an unsafe install.                          | Holds (control) |
| `InstallInvokedAtMostOnce`                | `updater.quitAndInstall()` runs at most once even under repeated handoff completion calls.              | Duplicate `quitAndInstall()` calls corrupt installer handoff or race shutdown.                                   | Holds (control) |
| `RestartRequiredIsTerminal`               | Once `restart-required` is entered, no new check runs and stale operations cannot leave it.             | The app retries a wedged updater or drops the restart-required state.                                            | Holds (control) |

## Read a result

Read every counterexample, and every passing flow chart you want to review or share, with the pstack `/statechart` skill. Give it `model/UpdateDownload.tla` with `model/UpdateDownload.cfg` and `model/statechart-view.ts` for cross-layer traces, or `model/AthleteUpdateFlow.tla` with `model/AthleteUpdateFlow.cfg` and `model/athlete-view.ts` for the athlete-facing update flow.

How to classify a failure:

1. **A regression (`BREAKS (REGRESSION: ...)` or `UNEXPECTED`).** A code change weakened a guarded control or introduced a new broken interleaving. Replay the printed steps 1-to-1 against the real TypeScript controllers in a Vitest test. If the test fails, fix the product code.
2. **A modeling error.** A printed step cannot happen in real code. Open the covered function named in the table below, verify the real guard, and tighten the TLA+ action guard rather than weakening any invariant.

## Updating the model with code changes

1. Run `node .agents/skills/verify-update-download/scripts/check.ts` before editing to record baseline output.
2. Edit product code and run the check again. Changed functions appear under `STALE`.
3. If your change alters behavior, verify the matching fact extractor in `scripts/facts.ts` still reads the true code property and update the corresponding action in `model/UpdateDownload.tla` (keeping one TLA+ step per synchronous JS turn between `await`s or IPC boundary).
4. Keep `model/UpdateDownload.cfg` synced with the code facts printed by `check.ts`.
5. Commit the covered code first, confirm every changed function matches its TLA+ action, run `node .agents/skills/verify-update-download/scripts/check.ts --confirm`, and update the sync commit line at the top of this file.

## Coverage record

Every model action and the code block fingerprinted in `references/coverage.json`:

| Model part                                                                                                                                                                                                 | Code                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanCheck`, `IsCurrent`, `FenceRestartRequired`                                                                                                                                                            | `apps/desktop/src/main/update-controller.ts` `canCheck`, `isCurrent`                                                                                                                                                                                              |
| `StartBootInit`, `VersionFloorReady`, `VersionFloorUnavailable`, `LoadUpdaterFails`, `LoadAndConfigureSucceeds`, `LoadSucceedsConfigFails`, `ClearUpdaterOnConfigFailure`, `ScheduleIntervalOnInitFailure` | `apps/desktop/src/main/update-controller.ts` `start`, `initializeUpdater`; `apps/desktop/src/main/update-version-floor.ts` `recordRunningVersion`                                                                                                                 |
| `StartCheckOp`, `MainStartsCheck`, `CheckResolvesCurrent`, `CheckResolvesUpdate`, `EnforceVersionFloor`                                                                                                    | `apps/desktop/src/main/update-controller.ts` `runCheck`, `check`                                                                                                                                                                                                  |
| `DownloadProgressAdvances`, `DownloadFallsBackToFull`, `FallbackDownloadExpiresAsStall`, `ResetTransferWatermarkOnFallback`, `ArmNativeListenersOnlyAfterZipReady`                                         | `apps/desktop/src/main/update-state-machine.ts` `advanceDownloadTransfer`; `apps/desktop/src/main/update-controller.ts` `beginDownload`                                                                                                                           |
| `ZipUpdateDownloaded`, `NativeUpdateDownloaded`, `RequireNativeReadinessOnMac`, `DetachSettledOperation`                                                                                                   | `apps/desktop/src/main/update-controller.ts` `enterPreparing`, `publishReady`, `finishActivePhase`                                                                                                                                                                |
| `UpdaterErrorEventBeforePromiseSettles`, `UnderlyingCallSettles`, `OperationDeadlineExpires`                                                                                                               | `apps/desktop/src/main/update-controller.ts` `failOperation`, `expireOperation`, `finishActivePhase`                                                                                                                                                              |
| `NativeReadinessInvalidated`                                                                                                                                                                               | `apps/desktop/src/main/update-controller.ts` `armReadinessWatch`                                                                                                                                                                                                  |
| `AthleteClicksRestart`, `ShutdownClosesUpdateController`, `GateInstallOnDrainAndReadiness`, `GuardSingleInstallInvocation`                                                                                 | `apps/desktop/src/main/update-controller.ts` `restart`, `failHandoff`, `completeInstallAfterDrain`, `close`                                                                                                                                                       |
| `OrdinaryQuitRequested`, `DrainFinishes`, `InstallHandoffAccepted`, `InstallHandoffTimesOut`, `RelaunchOnInstallFailure`, `FreezeUpdateOnBeforeQuit`                                                       | `apps/desktop/src/main/quit-coordinator.ts` `completeDesktopShutdown`, `beforeQuit`, `exitOnce`, `forceQuit`; `apps/desktop/src/main/index.ts` `shutdown`, `quitCoordinator`, `before-quit`                                                                       |
| `Publish`                                                                                                                                                                                                  | `apps/desktop/src/main/update-ipc.ts` `installDesktopUpdateIpc`                                                                                                                                                                                                   |
| `RendererHydrationCompletes`, `AthleteClicksCheck`, `RendererReceivesPush`, `RendererReceivesInvokeReply`, `RendererInvokeRejects`, `BlockActionsUntilHydrated`, `RendererHandlesRejectionAfterPush`       | `apps/desktop-renderer/src/update/controller.ts` `phase`, `applyPushedState`, `activate`, `start`; `apps/desktop-renderer/src/state/settings-slice.ts` `EMPTY_UPDATE_SURFACE`                                                                                     |
| `SidebarShowsRestarting`, `SidebarSeparatesRestartFromCheckBusy`                                                                                                                                           | `apps/desktop-renderer/src/state/adapters/update.ts` `createUpdateSettingsAdapter`; `apps/desktop-renderer/src/ui/sidebar/UpdateAvailableButton.tsx` `UpdateAvailableButton`; `apps/desktop-renderer/src/ui/settings/ApplicationSection.tsx` `ApplicationSection` |

## Bounds, assumptions, and exclusions

Bounds checked by `scripts/check.ts`:

- `MaxChecks = 2` (covers single-attempt flows plus retry interactions such as stale Squirrel.Mac readiness across attempts) and `Platform = "darwin"` (exercises both generic download/handoff paths and macOS native Squirrel readiness).
- Two candidate versions (`1`, `2`) against `floor \in {"none", "current", "higher"}` so both below-floor downgrades and cross-attempt version changes are explored.

Assumptions:

- Each TLA+ action corresponds to one synchronous JS turn between `await`s or one IPC boundary.
- `boot.ts` sends `getUpdateState()` synchronously before `settingsPorts.update` is bound, and `update-ipc.ts` answers it synchronously, so initial hydration observes the initial `idle` snapshot in FIFO IPC order.
- On `electron-updater@6.8.9`, `MacUpdater` emits `update-downloaded` synchronously before calling `nativeUpdater.checkForUpdates()`, and `DifferentialDownloader` restarts `transferred` at 0 on fallback to full download.

Not covered by this model:

- Real wall-clock timing (2m check/stall/preparation, 60m absolute, 30s drain/handoff, 6h periodic interval across OS sleep/wake).
- Multi-window macOS close/reopen hydration races after background downloads and Settings mutation locking (`navigationLocked`).
- Preload schema parsing, `update-eligibility.ts` release-flag checks, and Windows NSIS installer process elevation details.

A passing check holds only inside these bounds and assumptions.
