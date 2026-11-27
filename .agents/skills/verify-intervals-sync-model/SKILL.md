---
name: verify-intervals-sync-model
description: Model-check the desktop window's shared coach connection, the intervals.icu sync, the stored intervals.icu sign-in and Disconnect with TLA+. Use before and after any change to the coach client, the window's connection provider, the sync coordinator, the ride analysis controller, the coach's window lane, configureRuntime, or how main applies and clears the intervals.icu sign-in.
---

# Verify the intervals.icu sync model

A TLA+ model of the desktop window's one shared connection to the coach, the calls that ride on it, the coach's sync windows, and the stored intervals.icu sign-in. TLC checks every order of those steps within the bounds below. Tests check the orders someone wrote down.

Sync commit: `0fac1bb6`. The model was last confirmed against the code at that commit. `references/coverage.json` holds the same commit and a fingerprint of every function the model describes.

## When to run it

Run the check when a change touches any file in the coverage table below. The check itself also tells you: it exits 3 (STALE) when a covered function changed since the sync commit.

## Run

From the repository root:

```bash
node .agents/skills/verify-intervals-sync-model/scripts/check.ts
```

- It needs Node 24 or newer and a Java runtime. It finds Java through `JAVA`, then `JAVA_HOME`, then `java` on `PATH`. If none works, install one (`brew install --cask temurin`) or set `JAVA`.
- The first run downloads TLC 1.7.4 (`tla2tools.jar`) from the TLA+ GitHub release, checks its SHA-256, and caches it in `~/.cache/enduragent/`.
- A full run takes about 35 seconds.
- `--trace <Rule>` checks one rule and prints every variable that changes at each step.

What it does:

1. Reads seven facts from the code (the model's CONSTANTS) with the patterns in `scripts/facts.ts`, and prints them.
2. Runs TLC once per rule with those facts.
3. Runs each rule's witness. A witness must fail, which proves the rule's premise is reachable.
4. Runs each rule with its break flags (`breakWith`). It must fail, which proves the rule can fail.
5. Compares every covered function with its fingerprint.

## The rules

| Rule | Plain rule | Harm when it breaks | Issue |
|---|---|---|---|
| `OneCallsCancelNeverFailsAnother` | One call's cancel or timeout never fails another call on the window's connection. | Clicking another ride while its analysis loads shows a running sync as interrupted and cuts off a coach reply. | #411 |
| `WindowCatchesUpAfterReconnect` | Once the connection is open again and nothing runs by itself, the sidebar shows the coach's last sync result and Training is not older than it. | The sidebar keeps "Connection interrupted" and old data until Try again. | #413 |
| `NetworkRefusalIsRetried` | A stored sign-in refused for a network reason always has a retry scheduled. | After an offline launch intervals.icu stays off all session. | #410 |
| `EmptySyncNeverShownAsSuccess` | While a sign-in is saved, a sync that fetched nothing from intervals.icu is never shown as a success. | Sync now turns green while nothing was fetched. | #410 |
| `DisconnectRevokesOrRefusesClearly` | Disconnect ends with the sign-in revoked or a clear refusal inside its deadline. | "Could not be reconciled" after 30 s, Settings locked, the token kept. | #412 |

`EmptySyncNeverShownAsSuccess` applies while a sign-in is saved. With no saved sign-in, a keyless sync is local processing and the window says so. That follows issue 410's fix line and `training-sync.test.ts`. It is not a weaker rule.

## Read the result

Each rule prints one of these:

- `holds`: no cause is present and TLC found no break.
- `BREAKS (issue N: ...)`: a known, open finding. The steps under it are TLC's shortest path, in the code's words. Exit stays 0.
- `BREAKS (REGRESSION: ...)`: a cause with no open issue, such as a timeout that closes the connection again. Exit 1.
- `UNEXPECTED`: the rule breaks with no known cause, or holds while a cause is present. Exit 1.

Read every counterexample, and every passing run you want to show someone, with the pstack `/statechart` skill. Give it `model/CoachConnection.tla`, the config `model/CoachConnection.cfg` and the view `model/statechart-view.ts`. It tells each break as numbered steps in the athlete's words. When nothing breaks, it draws how the window moves between states. The model has more than 500 states, so the chart shows the bug paths only.

### A real bug or a modeling error?

- First, replay the path against the code, one step per action, as a test or a live run. The failing tests on branch `test/state-bug-repros` (`repro-intervals-*`) replay the four known paths.
- If the replay does not fail, assume the model is wrong until you show otherwise. Look for an action that is one step in the model but two steps in the code, or the reverse.
- `TLC did not finish cleanly` means the model itself is broken, usually an `UNCHANGED` list that names a variable the action also sets. Fix the model.
- Never weaken a rule or a witness to make the check pass.

## When you change covered code on purpose

1. Run the check before your change. Note the result.
2. Make the change. Run the check again.
3. If your change flips one of the seven facts, `facts.ts` must read the new value from the code. Update the fact's pattern if your code uses other names. The patterns for facts that are not fixed yet name what the fix is expected to add: `onConnectionOpen` (413), `createIntervalsSignInRetry(` (410), `"skipped-no-credential"` in the coordinator (410), `abortActiveWindow` (412).
4. If the model's steps no longer match the code, change the action in `model/CoachConnection.tla` and its comment. Keep one model step per indivisible step in the code.
5. Set the constants in `model/CoachConnection.cfg` to the values the check printed.
6. When the check is green except for STALE, re-read each listed function against its action. Only when the model describes the code at your commit, run `node .agents/skills/verify-intervals-sync-model/scripts/check.ts --confirm`. It records the new fingerprints and your commit as the sync commit. Put that commit on the "Sync commit" line above in the same change.
7. If a fix closes a finding, the rule turns to `holds` by itself, because its cause reads false from the code.

## Coverage

Each model action and the code it describes. `references/coverage.json` fingerprints these functions.

| Model action | Code |
|---|---|
| `LatchTo` | `packages/coach-client/src/client.ts` `latchTerminal`, `call` (`onAbort`), `onSocketClose`; `apps/desktop-renderer/src/coach-client.ts` `onTerminal` |
| `AnalysisTimesOut` | `client.ts` the call's timer and `timeOut`; `call-timeouts.ts` `getActivityAnalysis: 120_000` |
| `ProviderReconnects` | `coach-client.ts` `createDesktopCoachClientProvider`: `getClient`, `connectFresh`, `reconnect` |
| `AthletePressesSync`, `WindowSettlesRejectedSync`, `WindowFinishesSync`, `WindowRereadsSyncState`, `Shown` | `apps/desktop-renderer/src/training-sync.ts` `createTrainingSyncCoordinator`; `boot.ts` `refreshTrainingContext` |
| `AthleteOpensAnalysis`, `AthleteChangesRide`, `CoachAnswersStaleAnalysis` | `apps/desktop-renderer/src/activity-analysis/controller.ts` `createRideAnalysisController` |
| `ChatDetectsProtocolFault` | `apps/desktop-renderer/src/chat/controller.ts` `failProtocol` |
| `LaneGrants`, `CoachDeadlinePasses` | `packages/coach/src/store-runtime.ts` `admit`, `enter`, `leave`, `runWindowAfter`, `runOutsideWindow` |
| `SchedulerStartsWindow` | `store-runtime.ts` `runScheduledWindow` |
| `CoachFinishesWindow` | `packages/coach/src/operations.ts` `sync`; `daemon/rpc-server.ts` `case "sync"` (no detach signal, so the window can go away while the coach keeps syncing) |
| `CoachAppliesClear`, `CoachDeadlinePasses` | `operations.ts` `configureRuntime` |
| `ApplyStoredSignIn` | `apps/desktop/src/main/credential-runtime.ts` `reapplyStoredCredential`; `packages/coach/src/composition.ts` `assertIntervalsOwner` call |
| `LaunchReappliesSignIn` | `apps/desktop/src/main/index.ts` `await vault.reapplyConfigured()`; `credential-vault.ts` `reapplyConfigured` |
| `AthleteRetriesSavedKeys`, `RetryFires` | `credential-vault.ts` `retryFailed` |
| `AthleteDisconnects`, `MainClientTimesOut`, `MainFinishesDisconnect` | `credential-runtime.ts` `clearCredential`; `credential-vault.ts` `deleteCredential` (`if (shouldClearRuntime)`); `call-timeouts.ts` `configureRuntime: 30_000` |

## Scope and bounds

Verified: every order of the actions above, with at most 2 Sync presses, 2 ride analysis loads, 1 chat reply, 1 connection drop (a socket close or a chat protocol fault), 2 network changes, 1 scheduled window and 1 Disconnect. The launch starts online or offline. A full state space is about 600,000 states.

Assumptions, each a claim about timing in the code:

- `latchTerminal` and everything it rejects is one step.
- The sync coordinator's catch runs on a microtask, so it settles before a new connection can open over IPC.
- A clear's apply, a cancel and a lane hand-over take milliseconds. Only a running sync window is long enough for the 25 s and 30 s deadlines to pass.
- A re-apply of the stored sign-in waits for the window lane, so the model runs it only when the lane is free.

Left out:

- Main's own coach calls. Each opens its own connection (`credential-runtime.ts` `call`), so they cannot fail a window call.
- A coach restart. The app reloads the window when it starts a new coach, and the restart path belongs to the onboarding model.
- Sign-in health checks, Setup and Settings rows, Plan and spend refreshes after a reconnect. The rule checks the sidebar and the training context.
- A rejected token (401 or 403), the backfill cursor (issue 414), and the plan calendar (issues 384 and 382).
- A scheduled window refreshes the coach's data without telling the window. The rule counts only windows the window asked for.
- Protocol faults on the sync call itself, which publish "Sync unavailable".
- The 24-hour sync call timeout.
- `getRuntimeConfig` waiting behind a queued clear (part of issue 412).
