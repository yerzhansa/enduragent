---
name: verify-setup-operations
description: Model-check the desktop app's Setup operations and the shared credential lock with TLA+. Use before and after any change to Setup's controller, the ChatGPT, Intervals.icu or OpenRouter sign-ins, the credential mutation lock, the coach restart's key replay, Settings key deletes and Coach saves, or the window's page lifecycle.
---

# Verify Setup operations

Tests check the orders someone thought of. This model checks every order of a few Setup operations, the credential lock they share and the window's page, inside the bounds below. It found five bugs the tests had missed: #395, #396, #398, #400 and #419.

## The rules

Each rule is one property the operator stated. A rule is split into named parts, one per path, so each path reports on its own. All parts together are the property.

| Property | Parts in `model/SetupOperations.tla` | What breaks for the athlete |
|---|---|---|
| A coach restart always reaches ready. | `NoRestartLostBehindAPerson`, `NoRestartLostToSlowIntervals` | The coach stops until the app is relaunched. |
| Nothing waits behind a wait for a person. | `NothingWaitsBehindAPerson` | A Coach save, a key save or Telegram setup hangs for up to 5 minutes. |
| A busy Setup has exactly one named owner. | `KeySaveHasSetupAlone`, `ChatGptSignInHasSetupAlone`, `ChatGptActivationHasSetupAlone`, `IntervalsSignInHasSetupAlone`, `OpenRouterSignInHasSetupAlone`, `BusySetupNamesItsOwner` | Buttons unlock mid-operation, and a second click shows a false error and hides Cancel. |
| A sign-in never outlives the page that started it. | `ChatGptSignInEndsWithItsPage`, `IntervalsSignInEndsWithItsPage`, `OpenRouterSignInEndsWithItsPage` | A new window cannot sign in for up to 5 minutes and has no Cancel. |
| After any sequence, Setup's view of the active coach equals the coach's. | `SetupShowsTheActiveCoach`, `NeverSentToSetupWithAWorkingCoach` | Setup shows the wrong provider, or the athlete is sent to the Setup screen while the coach works. |

Two readings, fixed before the first run:

- A sign-in "outlives its page" while it still waits for the person in the browser and a newer page has loaded. After the person approves, the final write is a bounded credential write, like a key save, and the new page reads its result.
- Setup's view is the one from its latest read that succeeded. While Setup says its status couldn't be loaded, `SetupShowsTheActiveCoach` does not compare. `NeverSentToSetupWithAWorkingCoach` always applies: a failed read must not send a working athlete to the Setup screen.

## When to use it

Run it when a change touches a file in the coverage record below, or changes which operations take `serializeCredentialMutation`.

Check whether the covered code changed since the sync commit:

```bash
git log --oneline 2cbc4a56..HEAD -- apps/desktop/src/main/credential-envelope-lock.ts apps/desktop/src/main/chatgpt-auth.ts apps/desktop/src/main/daemon-lifecycle.ts apps/desktop/src/main/credential-vault.ts apps/desktop/src/main/credential-runtime.ts apps/desktop/src/main/intervals-ipc.ts apps/desktop/src/main/intervals-sign-in-ports.ts apps/desktop/src/main/onboarding-ipc.ts apps/desktop/src/main/openrouter-ipc.ts apps/desktop/src/main/openrouter-auth.ts apps/desktop/src/main/telegram-control.ts apps/desktop/src/main/index.ts apps/desktop-renderer/src/onboarding/controller.ts apps/desktop-renderer/src/onboarding/machine.ts apps/desktop-renderer/src/onboarding/openrouter-sign-in.ts apps/desktop-renderer/src/ui/onboarding/AiRow.tsx apps/desktop-renderer/src/ui/onboarding/TrainingRow.tsx apps/desktop-renderer/src/ui/onboarding/TelegramRow.tsx apps/desktop-renderer/src/ui/settings/CoachSection.tsx apps/desktop-renderer/src/boot.ts apps/desktop-renderer/src/settings/credential-controller.ts apps/desktop-renderer/src/settings/provider-model-controller.ts apps/desktop-renderer/src/settings/telegram-controller.ts apps/desktop-renderer/src/state/settings-slice.ts apps/desktop-renderer/src/state/onboarding-slice.ts packages/coach/src/account-identity.ts packages/coach/src/composition.ts packages/core/src/agent/codex/oauth.ts
```

Any commit listed means the model may no longer describe the code. Read the changed functions against the coverage record before you trust a result.

## Run

Needs Java 11 or newer. Set `JAVA` to its `java` binary when `java` is not on `PATH`. The script downloads TLC 1.7.4 to `~/.cache/enduragent/` once and checks its sha256. To use a jar you already have, set `TLA2TOOLS` to it.

```bash
node .agents/skills/verify-setup-operations/scripts/check.ts
```

It takes about a minute. Each rule runs once per scenario. Rules expected to hold run together; when one breaks, the rest run again without it, and the script prints one row per check. It exits 0 when every rule matches its expected result. Options:

- `--rule NAME` runs one rule.
- `--trace` prints TLC's trace for each rule that breaks.
- `--keep DIR` keeps each run's config and `tlc.out`.

A scenario turns some events off, so that a rule's shortest path is the bug that rule is about. `everything` has all events. `crash-not-close` has no plain window close. `close-not-crash` has no page crash. `no-slow-coach` lets the coach answer every Setup check in time.

## Read a result

Read every result with the `/statechart` skill. Give it `model/SetupOperations.tla`, a config like the ones `--keep` writes, and `model/view.ts` as the view. The view labels each state as the coach, the lock and the Setup screen, and each step as the athlete sees it. The model has more states than the chart budget, so the chart shows only the paths to broken rules.

A `MISMATCH` row means one of three things:

1. **A new bug.** The change broke a rule that held. Replay the path against the real code, one step per action, as a test. If it fails there, the code is wrong.
2. **A fixed bug.** A rule expected to break now holds, because the code and the model were both fixed. Flip its row in `scripts/check.ts` to `holds` in the same pull request.
3. **A modeling error.** The path does not happen in the code. An action's guard or effect differs from the code it names. Fix the model, not the rule. Never weaken a rule to make it hold.

To tell them apart, open the function that each step's action names and check its guard and its effect.

## Change the model with the code

When a change to covered code is intended:

1. Edit the actions that name the changed functions, so each one matches the new code. One atomic step in the model is one atomic step in the code: a synchronous run between two `await`s, or one IPC handler.
2. Run the check. Update the expected rows the change fixes or breaks, and say why in the pull request.
3. Replay any new broken path against the real code before you call it a bug.
4. Move the sync commit (the `2cbc4a56` in this file) to the new commit only after you have read every covered function at that commit against its action. A pull request that changes covered code and the model together cannot know its own merge commit: it adds itself to the list of described changes under the sync commit, and the next agent who moves the sync commit past it removes it from the list.

## Expected findings at the sync commit

Each path is TLC's shortest. The words are the code's.

| Rule | Scenario | Finding | Path |
|---|---|---|---|
| `NoRestartLostToSlowIntervals` | everything | #396 second trigger. The intervals.icu session owns it. | The coach exits with Intervals.icu connected. `reapplyConfigured` holds the lock while the replay awaits `assertIntervalsOwner`, which allows 20 s. The 5 s readiness limit passes. The same happens when the replay queues behind an Intervals.icu Disconnect, whose revoke allows 10 s inside the lock, or behind the Intervals.icu key check after a sign-in. That last path assumes the check is slow with the coach gone, which is not traced: replay it in the app before calling it a bug. |

Rules that hold at the sync commit: every page rule (since #1217, closing the window ends the ChatGPT login its registration started and the Intervals.icu sign-in its page started, so the close-order lead is closed too), `SetupShowsTheActiveCoach` and `NeverSentToSetupWithAWorkingCoach` (since #1213, a Coach save refreshes Setup and every successful read adopts main's configuration, and since #1214 a failed read after a delete marks no repair credential), the five `…HasSetupAlone` rules and `IntervalsSignInEndsWithItsPage` in close-not-crash (since the #398 fix, every Setup action and both rows wait while any Setup operation runs: `setupOperationRunning` in `setup-operation.ts`), `NoRestartLostBehindAPerson` and `NothingWaitsBehindAPerson` (since #1205, the ChatGPT login takes the lock only to store the sign-in, so neither a restart's replay nor a Coach save, key save or Telegram setup waits behind the browser), `TypeOK`, `BusySetupNamesItsOwner`, `ChatGptSignInHasSetupAlone` (the AI row runs one operation at a time) and `OpenRouterSignInEndsWithItsPage` (the `closed` event disposes the window's OpenRouter auth). Each control was seen to fail on a broken variant: without `disposeOpenRouter()` in the onboarding IPC dispose, `OpenRouterSignInEndsWithItsPage` breaks in 4 steps; without `connectTrainingData`'s `busy` check, `ChatGptSignInHasSetupAlone` breaks in 2; with `busy` left set after a key save, `BusySetupNamesItsOwner` breaks in 3.

## Coverage record

Sync commit: `2cbc4a56` (`origin/main`, 2026-11-27, after #1195). At that commit, every action below was read against the code it names.

Later changes the model already describes: #1205 (`chatgpt-auth.ts` `login` and `performLogin`: the browser wait runs outside the lock, and only `throwIfAborted` and `storeProfile` take it); the #398 fix (`setup-operation.ts` `setupOperationRunning`, used by every Setup action guard and by `AiRow`, `TrainingRow` and `OnboardingWizard`); #1217 (`onboarding-ipc.ts` dispose cancels the window's ChatGPT logins, `intervals-ipc.ts` ends a not-yet-approved sign-in when its webContents is destroyed); #1214 (`credential-controller.ts` keeps `content.repairCredential` when Setup's read after a delete fails); #1213 (`boot.ts` `onSaved` calls `onboarding.refresh(false)`, `load` adopts the configuration, `CoachSection.tsx` disables the Coach controls while `onboardingCredentialMutationActive`). The drift command lists their commits; they need no new reading.

| Model part | Code |
|---|---|
| `lockHolder`, `lockQueue`, `LockGoesToNext` | `credential-envelope-lock.ts` `createCredentialMutationLock`, created once in `index.ts` and passed to ChatGPT, the vault, Telegram, reset and the successor vault |
| `AthleteStartsChatGptSignIn`, `AthleteCancelsQueuedChatGptSignIn`, `ChatGptBrowserWaitEnds`, `PersonFinishesChatGptInBrowser`, `ChatGptSignInIsStored` | `chatgpt-auth.ts` `login`, `performLogin` (its store step under `serializeCredentialMutation`), `cancelLogin`. Renderer: `controller.ts` `startChatGptLogin` and its result handler, `machine.ts` `withChatGptPending`, `withChatGptLoginResult` |
| `ChatGptActivationFinishes` | `controller.ts` `beginChatGptActivation`, `scheduleChatGptActivation`, `recordActiveSelection`. `machine.ts` `withChatGptActivationPending`, `withChatGptActivationResult`. Main: `chatgpt-auth.ts` `activate` |
| `AthleteSavesKeyInSetup`, `SetupKeyWriteFinishes` | `controller.ts` `saveModelKey`, `saveModelCredential`. Main: `credential-vault.ts` `writeCredential` |
| Intervals.icu actions | `controller.ts` `connectTrainingData`, `cancelActiveIntervalsSignIn`. Main: `intervals-ipc.ts` `signIn`, `runCapturedCredential` (through `vault.runExclusiveMutation`), the cancel handler |
| OpenRouter actions | `openrouter-sign-in.ts` `canMutate`. Main: `openrouter-ipc.ts` `installDesktopOpenRouterIpc` and its dispose |
| `AiRowIdle` | `AiRow.tsx` `controlsDisabled`, the Change menu's `disabled`, the lane change that dismisses OpenRouter |
| `SetupMayMutate` | `controller.ts` `setupStatusBlocksMutations`, `setupLocked`, `credentialMutationsBlocked`. `setup-operation.ts` `setupOperationRunning`. `boot.ts` `onboardingCredentialMutationsBlocked`. `TrainingRow.tsx` and `AiRow.tsx` `controlsDisabled` |
| `OnboardingCredentialMutationActive` | `controller.ts` `onboardingCredentialMutationActive` |
| `AthleteSavesCoachInSettings`, `CoachSaveFinishes` | `provider-model-controller.ts` `commit`, `boot.ts` `onSaved` (`onboarding.refresh(false)`), `CoachSection.tsx` `controlsDisabled` (includes `onboardingCredentialMutationActive`). Main: `credential-vault.ts` `applyLlmSelection` |
| `AthleteDeletesKeyInSettings`, `KeyIsDeleted`, `SetupReadAnswers`, `SetupReadTimesOut` | `credential-controller.ts` the delete operation and its `onDeleted` catch. `boot.ts` `refreshOnboardingCredentials`. `controller.ts` `refresh`, `load`, `finishUnavailableLoad`, `activeProviderIsReady`. `settings-slice.ts` `patchSettings`. Main: `credential-vault.ts` `deleteCredential` |
| `GateShown` | `onboarding-slice.ts` `setupDisposition` |
| Telegram actions | `TelegramRow.tsx`, `telegram-control.ts` `configure` under `serializeCredentialMutation`, `settings-slice.ts` `beginSettingsMutation` |
| Coach restart actions | `daemon-lifecycle.ts` `recover`, `recoverCurrent`, `publishSuccessor`, `READINESS_TIMEOUT_MS`, `enterTerminal`. `index.ts` `reapplyCredentials`: `successorVault.reapplyConfigured()`, then `successorTelegramCoordinator.reconcile()`, each under the lock |
| `WaitsForIntervals` | `account-identity.ts` owner check (20 s), `intervals-sign-in-ports.ts` revoke (10 s) through `onboarding-ipc.ts`'s delete `beforeRemove`, `credential-vault.ts` `deleteCredential` |
| `PageCrashes`, `AthleteClosesWindow`, `MainHandles*Cancel`, `WindowIsClosed`, `AthleteOpensWindow` | `index.ts` the window's `closed` and `render-process-gone` handlers. `boot.ts` `pagehide`, then `controller.ts` `dispose`. `onboarding-ipc.ts` `registerOnboardingIpc` and its dispose |

Ghost variables, which the code does not keep: the page that started each sign-in or lock entry (`page` in `login`, `signIn`, `openRouter` and each entry), `coach.lost` and `steps`. `setup.loadedActive` stands for the configuration a running Setup load read: the read happens when the load starts, so a Coach save that finishes during the load is not in it (`refresh()` returns early while a load runs).

## Bounds and assumptions

What a pass covers:

- At most 5 clicks, two pages (one crash or close, then one reopen), and one coach exit per run.
- Three providers: Anthropic and OpenRouter with keys, and ChatGPT by sign-in. The athlete starts set up on Anthropic, with Intervals.icu connected or not.

Timing assumptions:

- Only a wait for the person in the browser, or for intervals.icu, lasts longer than the 5 s readiness limit. Every other step finishes inside it.
- Such bounded work, and a cancel that `pagehide` sent, finishes before the athlete can open the window again.

Simplifications:

- Main's reply and the renderer's handling of it are one step.
- The Intervals.icu token exchange is part of the approval step.
- A page crash and main's `render-process-gone` handler are one step.
- The OpenRouter copied-code path is left out.
- A Setup key save frees `busy` in the same step its key is written. In the code, `saveModelKey` then refreshes statuses and may take the lock once more for `applyLlmSelection`.

Not covered: Setup's first-launch load and its retries (what is left of issue 290), the language screen (#399), the Claude Code check (#401), an expired ChatGPT sign-in (#402), model list revisions (#397), Setup's draft (the model-revert half of #395), the 12 s activation transport timeout, ride imports, credential reset, the page reload after an app-supervised restart, Windows, where close only hides the window, the two frames between a stored ChatGPT sign-in and its activation, and a Setup screen that appears during a restart and stays after the coach recovers (`NeverSentToSetupWithAWorkingCoach` checks only the step that shows the screen).

A pass says nothing outside these bounds.
