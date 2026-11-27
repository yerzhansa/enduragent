---
name: verify-intervals-sync-model
description: Model-check the desktop window's shared coach connection, the intervals.icu sync, the stored intervals.icu sign-in and Disconnect with TLA+. Use before and after any change to the coach client, the window's connection provider, the sync coordinator, the ride analysis controller, the Training refresh, the coach's window lane, configureRuntime, or how main applies and clears the intervals.icu sign-in.
---

# Verify the intervals.icu sync model

A TLA+ model of the desktop window's one shared connection to the coach, the calls that ride on it, the coach's sync windows, and the stored intervals.icu sign-in. TLC checks every order of those steps within the bounds below. Tests check the orders someone wrote down.

Sync commit: `d0d3f0d3`. The model was last confirmed against the code at that commit. `references/coverage.json` holds the same commit and a fingerprint of every function the model describes.

## When to run it

Run the check when a change touches any file in the coverage table below. You can also just run it: it exits 3 (STALE) and lists each covered function that changed since the sync commit.

## Run

From the repository root:

```bash
node .agents/skills/verify-intervals-sync-model/scripts/check.ts
```

- It needs Node 24 or newer and a Java runtime. It finds Java through `JAVA`, then `JAVA_HOME`, then `java` on `PATH`. If none works, install one (`brew install --cask temurin`) or set `JAVA`.
- The first run downloads TLC 1.7.4 (`tla2tools.jar`) from the TLA+ GitHub release, checks its SHA-256, and caches it in `~/.cache/enduragent/`.
- A full run takes about a minute.
- `--trace <Rule>` checks one rule and prints every variable that changes at each step.

What it does:

1. Reads seven facts from the code (the model's CONSTANTS) with the patterns in `scripts/facts.ts`, and prints them. Facts read code only, never comments.
2. Runs TLC once on every rule whose facts say it holds, with `TypeOK`.
3. Runs TLC on each rule that has a known cause, and prints its shortest counterexample.
4. Runs TLC once with every known cause removed. Each open rule must then hold. A break here is a new path or a modeled fix that does not work.
5. Runs each rule's witness, which must fail (the rule's premise is reachable), and each rule with its break flags (`breakWith`), which must fail (the rule can fail).
6. Compares every covered function with its fingerprint.

## The rules

| Rule | Plain rule | Harm when it breaks | Issue |
|---|---|---|---|
| `OneCallsCancelNeverFailsAnother` | One call's cancel or timeout never fails another call on the window's connection. | Clicking another ride while its analysis loads shows a running sync as interrupted, cuts off a coach reply, and can fail the Training refresh. | #411 |
| `WindowCatchesUpAfterReconnect` | Once nothing runs by itself, the sidebar shows the coach's last sync result for the window and Training is not older than it. | The sidebar keeps "Connection interrupted" and Training stays old until Try again. | #413 |
| `NetworkRefusalIsRetried` | A stored sign-in refused for a network reason has a retry scheduled, and once nothing runs by itself with the network up it is no longer refused. | After an offline launch intervals.icu stays off all session. | #410 |
| `EmptySyncNeverShownAsSuccess` | While a sign-in is saved, a sync that fetched nothing from intervals.icu is never shown as a success. | Sync now turns green while nothing was fetched. | #410 |
| `DisconnectRevokesOrRefusesClearly` | Disconnect ends with the sign-in removed (revoked, or a plain message that it could not be revoked offline) or a clear refusal, inside its deadline. | "Could not be reconciled" after 30 s, Settings locked, the token kept. | #412 |

`EmptySyncNeverShownAsSuccess` applies while a sign-in is saved. With no saved sign-in, a keyless sync is local processing and the window says so. That follows issue 410's fix line and `training-sync.test.ts`. It is not a weaker rule. The app shows "Local training-data processing completed." both for a fetch that found nothing new and for a sync with no key; the model keeps the two apart by cause, and `model/statechart-view.ts` labels them that way.

## Read the result

Each rule prints one of these:

- `holds`: no cause is present and TLC found no break.
- `BREAKS (issue N: ...)`: a known, open finding. The steps under it are TLC's shortest path, in the code's words. Exit stays 0 while the fixed configuration (step 4) holds.
- `BREAKS (REGRESSION: ...)`: a cause with no open issue, such as a timeout that closes the connection again. Exit 1.
- `UNEXPECTED`: the rule breaks with no known cause, or holds while a cause is present. Exit 1.

Read every counterexample, and every passing run you want to show someone, with the pstack `/statechart` skill. Give it `model/CoachConnection.tla`, the config `model/CoachConnection.cfg` and the view `model/statechart-view.ts`. It tells each break as numbered steps in the athlete's words. The model has millions of states, so the chart shows the bug paths only.

### A real bug or a modeling error?

- First, replay the path against the code, one step per action, as a test or a live run. Each fix pull request adds its replay as a regression test (for 411: `apps/desktop-renderer/tests/activity-analysis-shared-connection.test.ts` and `apps/desktop/tests/e2e/ride-analysis-cancel.spec.ts`). The audit's first failing replays are on the operator's local branch `test/state-bug-repros`, which is not on GitHub.
- If the replay does not fail, assume the model is wrong until you show otherwise. Look for an action that is one step in the model but several awaits in the code, or the reverse.
- `TLC did not finish cleanly` means the model itself is broken, usually an `UNCHANGED` list that names a variable the action also sets. Fix the model.
- Never weaken a rule or a witness to make the check pass.

## When you change covered code on purpose

1. Run the check before your change. Note the result.
2. Make the change. Run the check again. It will say STALE for the functions you touched.
3. If your change flips one of the seven facts, `facts.ts` must read the new value from the code. The patterns for facts that are not fixed yet name what each fix was expected to add: `onConnectionOpen` in the sync coordinator (413), `signInRetry.observe(` in main's `reapplyCredential` (410), `"skipped-no-credential"` in the coordinator (410), `abortActiveWindow` in `store-runtime.ts` (412). If your code uses other names, change the pattern in the same pull request.
4. If the model's steps no longer match the code, change the action in `model/CoachConnection.tla` and its comment. Keep one model step per indivisible step in the code.
5. Set the constants in `model/CoachConnection.cfg` to the values the check printed.
6. Commit the code. Re-read each STALE function against its action. Only when the model describes the code, run `node .agents/skills/verify-intervals-sync-model/scripts/check.ts --confirm`. It refuses while covered files have uncommitted changes or any problem remains. It records the fingerprints and the sync commit (the `main` commit when the covered files match it, else your head). Put that commit on the "Sync commit" line above and commit both.
7. When a fix closes a finding, its rule turns to `holds` because its cause now reads false from the code, and step 2 of the run checks it.

The Training page is being replaced by Calendar and Activity review (approved design, not built on 2026-11-27). When that lands, the ride analysis and Training refresh anchors move. Re-point their needles in `facts.ts`, and keep the rules.

## Coverage

Each model action and the code it describes. `references/coverage.json` fingerprints these functions.

| Model action | Code |
|---|---|
| `LatchTo` | `packages/coach-client/src/client.ts` `latchTerminal`, `call` (`onAbort`), `onSocketClose`; `apps/desktop-renderer/src/coach-client.ts` `onTerminal` |
| `AnalysisTimesOut` | `client.ts` the call's timer and `timeOut`; `call-timeouts.ts` `getActivityAnalysis: 120_000` |
| `CoachAnswersStaleAnalysis` | `client.ts` `handleTerminal` (an unknown id latches a protocol fault); `activity-analysis/controller.ts` generation check |
| `ProviderReconnects` | `coach-client.ts` `createDesktopCoachClientProvider`; `apps/desktop-renderer/src/intervals-sign-in-health.ts` `follow` and `refresh` |
| `AthletePressesSync`, `WindowSettlesRejectedSync`, `WindowRereadsSyncState`, `WindowPublishesSyncResult`, `Shown` | `apps/desktop-renderer/src/training-sync.ts` `createTrainingSyncCoordinator`; `training-context/manual-sync.ts` `toManualSyncViewState` |
| `WindowStartsRefresh`, `TrainingRefreshLands` | `apps/desktop-renderer/src/boot.ts` `refreshTrainingContext`; `activity-analysis/controller.ts` `invalidate`; `training-context/controller.ts` `fetchState` |
| `AthleteOpensAnalysis`, `AthleteChangesRide`, `CoachAnswersAnalysis` | `apps/desktop-renderer/src/activity-analysis/controller.ts` `createRideAnalysisController` |
| `ChatDetectsProtocolFault` | `apps/desktop-renderer/src/chat/controller.ts` both `failProtocol`s |
| `LaneGrants`, `CoachDeadlinePasses` | `packages/coach/src/store-runtime.ts` `admit`, `enter`, `leave`, `runWindowAfter`, `runOutsideWindow` |
| `SchedulerStartsWindow` | `store-runtime.ts` `runScheduledWindow` |
| `CoachFinishesWindow` | `packages/coach/src/operations.ts` `sync`; `daemon/rpc-server.ts` `case "sync"` (no detach signal, so the coach keeps syncing after the window goes away) |
| `CoachAppliesClear`, `CoachDeadlinePasses`, `MainClientTimesOut` | `operations.ts` `configureRuntime` and `RUNTIME_CONFIGURATION_DEADLINE_MS` (30 s less 5 s); `call-timeouts.ts` `configureRuntime: 30_000` |
| `ApplyStoredSignIn`, `RetryFires` | `apps/desktop/src/main/credential-runtime.ts` `reapplyStoredCredential`; `index.ts` `reapplyCredential`; `packages/coach/src/composition.ts` `assertIntervalsOwner` call |
| `LaunchReappliesSignIn` | `apps/desktop/src/main/index.ts` `await vault.reapplyConfigured()`; `credential-vault.ts` `reapplyConfigured` |
| `AthleteRetriesSavedKeys` | `credential-vault.ts` `retryFailed` |
| `AthleteDisconnects`, `MainFinishesDisconnect` | `credential-runtime.ts` `clearCredential`; `credential-vault.ts` `deleteCredential` (`if (shouldClearRuntime)`) |

## Scope and bounds

Verified: every order of the actions above, with at most 2 Sync presses, 1 ride analysis open, 1 chat reply, 2 connection drops (socket closes or chat protocol faults), 2 network changes, 1 scheduled window and 1 Disconnect. The launch starts online or offline. With every fix on, the model has about 3.8 million states.

Assumptions, each a claim about timing in the code:

- `latchTerminal` and everything it rejects is one step.
- The sync coordinator's catch runs on a microtask, so it settles before a new connection can open over IPC.
- A clear's apply, a cancel and a lane hand-over take milliseconds. Only a running sync window is long enough for the 25 s and 30 s deadlines to pass. A fix that cancels the sync for a clear must make that true.
- A re-apply of the stored sign-in waits for the window lane, so the model runs it only when the lane is free.
- A scheduled retry that fires while offline reschedules itself. The model leaves that step out; the rule's second half fails if a fix gives up instead.

Left out:

- Main's own coach calls. Each opens its own connection (`credential-runtime.ts` `call`), so they cannot fail a window call.
- A coach restart. The app reloads the window when it starts a new coach; the restart path belongs to the onboarding work.
- Sign-in health, Setup and Settings rows, Plan and spend contents after a reconnect. The rule checks the sidebar and the training context.
- A rejected token (401 or 403), the backfill cursor (issue 414) and the plan calendar (issues 384 and 382).
- A scheduled window refreshes the coach's data without telling the window. The rule counts only windows the window asked for.
- Protocol faults on the sync call itself, which publish "Sync unavailable".
- The 24-hour sync call timeout, and `runWindow` joining a running window (the model queues it, which only adds orders).
- `getRuntimeConfig` waiting behind a queued clear (part of issue 412).
