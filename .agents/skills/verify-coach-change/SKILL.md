---
name: verify-coach-change
description: Formally check how a coach change (a model or provider pick, a key delete, a ChatGPT activation) reaches the running coach while it replies, and how the summary and memory-save models are chosen. Use before and after any change to packages/coach/src/runtime-bundle.ts, the runtime-config lane in packages/coach/src/operations.ts, applyRuntimeConfig or buildBundle in packages/coach/src/composition.ts, the summary-model choice in packages/core/src/runtime-config.ts, or the key-delete path in apps/desktop/src/main/credential-vault.ts and credential-runtime.ts.
---

# Verify a coach change

Two checks guard one promise: a coach change never stalls the coach the athlete is talking to, never half applies, and never leaves background work on a model nobody chose.

- `model/CoachChange.tla` is a TLA+ model of the runtime replacement in `packages/coach/src/runtime-bundle.ts`, the serialized runtime-config lane in `packages/coach/src/operations.ts`, `applyRuntimeConfig` and `buildBundle` in `packages/coach/src/composition.ts`, and the desktop's key delete. TLC checks every order of steps.
- `scripts/summary-model-check.ts` runs the real `resolveRuntimeConfig` (`packages/core/src/runtime-config.ts`) on every sequence of model picks, explicit summary choices and restarts, by breadth-first search to a fixed point. It is not a hand model, so it needs no update when that function changes.

## Run

```sh
sh .agents/skills/verify-coach-change/scripts/check.sh
```

About 15 seconds. The first run downloads `tla2tools.jar` 1.7.4 (checksum pinned) and Temurin Java 25 through mise; set `JAVA` to skip mise. Exit 0 means every rule holds or breaks exactly as `expected-results.txt` records. Exit 1 prints the difference and the summary-model paths.

To read a TLA+ result, run the pstack `/statechart` skill on `model/CoachChange.tla` with `model/CoachChange.cfg` and the view `model/view.mjs`, with a fresh output folder outside the repo. It prints each broken rule's shortest path in the athlete's words. The model has about 3,000 states, so its chart draws only the bug paths.

## The rules

| Rule | In plain words | Harm when it breaks |
|---|---|---|
| `StopNeverGivesUpDuringAReply` | A Stop pressed during a reply reaches it before Stop's 10 s client timeout. | Stop does nothing and the paid reply runs to the end. |
| `StopReachesReplyBeforeItEnds` | A Stop pressed during a reply reaches it before the reply ends on its own. | Same, for a reply that ends while Stop waits. |
| `ReadsNotBlockedPastDeadline` | Once a change is past its 25 s deadline, no runtime-config read, transcript read or chat-queue call (`getChatQueue`, `enqueueChatMessage`) waits on it. | Settings shows "Not configured", Chat cannot page its history or queue a message. |
| `FailedChangeLeavesCoachUnchanged` | A change that failed or was refused left the bundle, model list pin, attachment limits, `selected-model-profiles.json` and `config.yaml` as they were. | The new model leaks into attachment checks and the profiles file. |
| `FailedChangeLeavesWindowUnchanged` | After a failed or refused change, the key is still stored and usable and the window is not on the Setup screen. | A false Setup screen while the coach keeps answering with the key. |
| `NoSwapUnderARunningReply` | The coach never swaps bundles under a reply that still runs on the old one. Holds today; pinned on purpose by `packages/coach/tests/composition.test.ts` ("drains active runtime work"). | A reply's later tool calls hit a half-built coach. |
| `SummaryModelIsChosen` | Summaries run on the athlete's explicit choice; else the provider's summary default (`COMPACT_MODEL_DEFAULTS`); else the chat model; while on GPT-6 Astra, on the model used before Astra. | Summaries quietly cost up to 5 times more. |
| `MemoryModelIsChosen` | Memory saves run on the explicit choice; else the chat model; on GPT-6 Astra, on the model used before Astra. | Same, for memory saves. |
| `ProviderSwitchResetsBackgroundModels` | Right after a provider switch in Setup, both of the rules above hold. Holds today. | The old provider's models follow the athlete to the new one. |

`TypeOK` and `NoDeadlock` guard the model itself.

## Findings at the sync commit

All expected in `expected-results.txt`.

- [#403](../../../docs/issues/403-coach-change-during-a-reply-blocks-stop.md) is fixed by yerzhansa/enduragent#1230: a coach change that arrives while a reply runs (counted from the call, before admission) is refused with `busy-replying`, the catalog pin moved into `replace()`'s prepare, and the desktop passes the refusal through (`credential-runtime.ts`, `credential-vault.ts`, `chatgpt-auth.ts`). The design constants `RefuseWhileReplying`, `ClearBusyRefusal = "refusal"` and `PinMovedIntoPrepare` say so, and every coach-change rule holds. A change that changes nothing (the desktop re-sending stored keys) still waits (`packages/coach/src/runtime-config-unchanged.ts`); the model has no actor for it.
- [#404](../../../docs/issues/404-summary-model-sticks-to-a-costlier-model.md), OpenAI: GPT-6 Astra, then Luna from Settings → Coach; summaries and memory saves stay on Sol. OpenRouter: set up on the default, pick another model in Coach; summaries follow the chat model instead of the OpenRouter summary default. Anthropic: pick the Haiku id as the chat model, then another; summaries follow. Replay: `packages/coach/tests/repro-llm-picker-coach-runtime.test.ts`.

## When a change touches this code

Coverage. Each row was confirmed against the code at the sync commit.

| Code | In the model |
|---|---|
| `runtime-bundle.ts` `run` (admission captured at call start, `activeCalls`) | `Capture`, `Open`, `ActiveCalls`, `ReplyArrives`, `ReplyAdmitted`, `PageReadArrives` |
| `runtime-bundle.ts` `stopChat`, `getTranscriptPage`, `getChatQueue`, `enqueueChatMessage` | `StopArrives`, `StopAdmitted`, `PageReadAdmitted`, `QueueCallArrives`, `QueueCallAdmitted`; constants `StopBypassesAdmission`, `ReadsBypassAdmission`, `QueueCallsBypassAdmission` |
| `runtime-bundle.ts` `replace` (barrier, drain wait, `finally` release) | `ChangeStarts`, `BuildIoDone`, `ChangeFinishes`; constants `ReplaceHonoursDeadline`, `DeadlineRefusesBusy`, `RefuseWhileReplying` |
| `apps/desktop-renderer/src/chat/controller.ts` `requestStop` (Stop is sent once the turn is bound) | `StopArrives` requires a streaming reply |
| `operations.ts` `createSerializedLane`, `configureRuntime`, `getRuntimeConfig`, `RUNTIME_CONFIGURATION_DEADLINE_MS` | `LaneHeldByChange`, `ChangeArrives`, `DeadlineFires`, `CfgReadArrives`, `CfgReadRuns`; constant `RuntimeConfigReadOffLane` |
| `composition.ts` `applyRuntimeConfig` (catalog pin before `replace`, `replace`, commit's `throwIfAborted`, `persistConfig`) | `PinnedBeforeReplace`, `ChangeStarts`, `ChangeFinishes`; constant `PinMovedIntoPrepare` |
| `composition.ts` `buildBundle` (`catalogSession`, `persistResolvedModelProfiles`, `currentEngineConfig` for every kind) | `ChangeStarts`, `BuildIoDone`; constant `PrepareIsPure` |
| `credential-vault.ts` delete (`clearCredential` catch, `setRuntimeState`, `removeStoredCredential`) and `credential-runtime.ts` `clearCredential` | `DesktopSeesError`, `DesktopSeesRefusal`, `DesktopSeesSuccess`; constant `ClearBusyRefusal` (`"throws"`, `"refusal"`, or the wrong `"not-active"`) |
| `packages/coach-client/src/call-timeouts.ts` (`stopChat`, `configureRuntime`, `getRuntimeConfig`, `getTranscriptPage`), `chatgpt-auth.ts` `CHATGPT_ACTIVATION_TIMEOUT_MS` | `StopTimesOut`, `ClientGivesUp`, `CfgReadTimesOut`, `PageReadTimesOut` and their order |
| `runtime-config.ts` `resolveRuntimeConfig` | Run directly by `summary-model-check.ts` |
| `composition.ts` `runtimePatch`, `persistConfig` summary fields; `config.ts` `loadConfig` llm patch | Mirrored in `summary-model-check.ts` `runtimePatch` and the restart step |
| `engine-host-adapter.ts` `compactModel ?? model`, `flushModel ?? model` | `usedCompact`, `usedFlush` in `summary-model-check.ts` |

Sync commit: `878cf624` (2026-11-28, the issue 403 fix rebased on `b4c2cc23`). List what changed since then:

```sh
git diff --stat 878cf624 -- packages/coach/src/runtime-bundle.ts packages/coach/src/operations.ts packages/coach/src/composition.ts packages/core/src/runtime-config.ts packages/core/src/config.ts packages/core/src/agent/engine-host-adapter.ts packages/coach-client/src/call-timeouts.ts apps/desktop/src/main/credential-vault.ts apps/desktop/src/main/credential-runtime.ts apps/desktop/src/main/chatgpt-auth.ts
```

If a covered function changed:

1. Read the change against its row above. For the TLA+ model, edit the action that stands for the changed code, or flip the design constant that names the change. Keep one step per run of code between two awaits.
2. Run `check.sh`. Update `expected-results.txt` only for a result the change meant to move, such as a fix turning a rule from `breaks` to `holds`.
3. Move the sync commit forward only after you confirmed that every row above still describes the code at the new commit.

A fix for a finding flips its design constants in `model/CoachChange.cfg`, turns the rule's line in `expected-results.txt` to `holds`, and updates the findings list, all in the fix's pull request.

To compare fix designs before writing one, copy the model and the config to a scratch folder, set the constants each design would set, and run TLC on each rule. At the sync commit, refusing a change while a reply runs (`RefuseWhileReplying`, `ClearBusyRefusal = "refusal"`, `PinMovedIntoPrepare`) makes every rule hold. Issue 403's own suggestion needs every other constant to get there. Leaving out any one of the three refusal pieces breaks a rule.

## A real bug or a modelling error

A new `breaks` is a real bug until shown otherwise. Before you report it, replay its path against the real code, one action per step: extend the matching repro test above, or write one beside it that drives the same steps through `createCoachComposition` and `createReconfigurableRuntimeBundle`. If the replay does not fail, look for the step the model gets wrong: two awaits merged into one action, a timer firing during a wait that is only milliseconds long, or a missed write. Fix the model, never the rule.

The summary-model check runs the real function, so its `breaks` is a real result for the code. If the expectation looks wrong, say so to the operator: the rule is the product decision of #404, so do not edit it to make the check pass.

One known edge: the rule keeps "the model used before Astra" across a restart. A fix that saves only explicit choices, as #404's state shape suggests, would put an Astra athlete's background work on Sol after a restart and break the rule. The fix must keep the before-Astra model, or the operator decides the rule changes.

## Bounds and what is left out

- One reply, one Stop, one coach change, one runtime-config read, one transcript read and one chat-queue call on one coach process. Two queued changes, Telegram replies, scheduled turns and a second window are not modelled. `activeCalls` counts only the reply.
- Other calls that wait on admission are not actors: archive reads, `withChatStore` (archive delete), `confirmations.confirm`. The ChatGPT activation's own 10 s `getRuntimeConfig` read (`onboarding-ipc.ts`) is not modelled.
- Time is an order, not a clock. A 10 s or longer timer fires only while its owner is in the drain wait. File I/O inside `buildBundle` is shorter than any timer. Stop and the reads are one step each. A desktop timeout and the coach's detach are one step: the close frame's network delay is not modelled.
- Not modelled: the intervals.icu parts of `applyRuntimeConfig` (owner claims, `runOutsideWindow`), the Setup and Settings controllers in the window, and what the window shows after a successful change.
- The summary-model check covers OpenAI, OpenRouter and Anthropic with every model the shipped list has for them, plus each provider's summary default. Every reachable config from a fresh install is visited. `openai-codex`, `codex-agent`, `claude-cli` and the key providers without a summary default are not in the alphabet.

To bring the checks back in line after changes that did not recheck them, use the pstack `/maintain-formal-verification-skill` skill.
