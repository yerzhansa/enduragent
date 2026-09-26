# Review and approval

Source inspected at `3d6ecf78`.

## Sub-features

Inventory mapping for this page follows. Existing acceptance IDs remain authoritative.

| Inventory ID | Capability |
|---|---|
| W01 | Prepare one workout for approval |
| W02 | Prepare a mixed set |
| W03 | Review new workouts |
| W04 | Review edits |
| W05 | Review deletions |
| W06 | Review totals |
| W07 | Preserve existing calendar entries |
| W08 | Approve the saved set once |
| W09 | Cancel pending work |
| W10 | Revise selected pending workouts |
| W11 | Explicitly replace pending work |
| W12 | Keep a pending review during other chat |
| W13 | Keep valid approvals without a timer |
| W14 | Review larger and longer sets |
| W15 | Withhold approval after incomplete delivery |
| W16 | Report incomplete preparation |
| W35 | Localize saved reviews and differences |

The authority is acceptance A01–A18. The following identifies existing verification coverage, not replacement acceptance criteria.

| Acceptance IDs | Existing scenario or test entry |
|---|---|
| A01 | Terminal `single` and `cancel`; service test `cancels and replaces approval without writes` |
| A02–A09 | Terminal `mixed`; `workout-change-set-review.test.ts` test `shows the complete mixed payload, both edit values, load, structure, retained context, and 155 minutes`; service test `reviews the complete mixed set and applies exact commands once` |
| A10–A11 | Terminal `cancel` and `revision`; service test `cancels and replaces approval without writes` |
| A12 | Service test `requires delivery acknowledgement and preserves approval across unrelated turns`; channel test `preserves a terminal approval while ordinary revision text goes to the coach` |
| A13–A14 | Service tests `allows no TTL and has no fixed workout count cap` and `applies eight workouts spanning ten days with one approval` |
| A15–A16 | Terminal `long` covers a large terminal review; Telegram dispatch tests `delivers every workout review chunk before enabling one approval` and `keeps workout approval inactive when a review chunk cannot be delivered` cover adapter delivery. Actual Telegram chunking remains a separate UI run. |
| A17 | Terminal `incomplete`; Engine host tests for interruption, generation failure, schema/conversion failure, and deadline exhaustion |
| A18 | Terminal `long`; sport test `accepts a large set without a workout-count maximum`; service count test above |

Entry points are `packages/cycling-coach/src/index.ts:8`, `packages/core/src/run-binary.ts:674`, `packages/core/src/channels/workout-approval.ts:20`, and `packages/core/src/channels/telegram.ts:580` in the inspected worktree. Only this npm binary opts into `aggregate-v1`. When reply assessment fails after a save, the athlete sees `chat.notice.savedUnverified`. When workout preparation fails after a save, the athlete sees `coach.workoutPreparation.savedInformationFailed`. Those notices are defined in [Error recovery and local diagnostics](errors-and-diagnostics.md).

## How to get to it (user POV)

In terminal chat, request the desired workout changes as ordinary text. Read the complete review, then enter `approve` or `cancel`; `Make Thursday easier` is an ordinary revision message. In Telegram, send the request to the isolated test bot and use the offered **Confirm** or **Cancel** inline control after the complete review. `resend` redisplays the saved review. The prototype's suggested-message button is not a product entry point. The [production chart-card checks](../future-review-prototype.md) supplement these approval criteria. Supported additions and structured edits show charts; saved name/date-only edits and deletions stay compact.

## Driving it with npm-coach verification

From the inspected worktree, run the existing tests:

```bash
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
pnpm exec vitest run packages/core/tests/workout-change-sets.test.ts packages/core/tests/workout-change-set-review.test.ts packages/core/tests/workout-approval-channel.test.ts packages/core/tests/telegram-dispatch.test.ts packages/engine/tests/workout-preparation-host.test.ts packages/sport-cycling/tests/workout-change-set-tool.test.ts packages/sport-cycling/tests/intervals-serializer.test.ts packages/core/tests/workout-effort-plot.test.ts packages/core/tests/workout-chart.test.ts
```

Run the complete mixed example through the real built terminal:

```bash
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

Repeat that command with `--scenario=single`, `--scenario=cancel`, `--scenario=revision`, `--scenario=long`, and `--scenario=incomplete` for the existing sibling scenarios. The runner supplies ordinary stdin and a scripted provider/calendar fixture at controlled date `1998-09-07`; retain its transcript and independent final calendar file. For `mixed`, require the complete review before input, one approval, four writes in the expected order, exact saved workout values, and the unchanged unrelated workout. Inspect the saved calendar independently of the transcript.

For Telegram UI on macOS, follow the parent skill’s default real OpenRouter/Intervals athlete 2 route after doctor and ownership checks. Use marked disposable workouts and independently read the real calendar. Keep the optional fictional launcher as a separate executor. Ground composers and controls in fresh DOM/accessibility observations. Capture every chart, caption continuation, final control and result. A mocked dispatch test or prototype photo is not live rendering proof.

Retain the run’s `result.json`, `transcript.txt`, and `calendar.json` under the unique evidence directory described in the [index](README.md). Record this feature’s criterion IDs alongside the results; do not infer a pass for unmapped or undriven cases.

## Gotchas

The historical 15-to-19-minute repeat bug was corrected in 24e46aca. Cycling and running serializer regressions cover the boundary; later live report evidence records 900 seconds. The description-only edit preview discrepancy was corrected in source at 5cd3a43f and has component regression coverage; a fresh real-provider check remains separate. Do not claim all locales passed from the English runner.

Current source adds authoritative pending IDs/revision through get_pending_workout_changes. Targeted revision preserves untouched items and omitted edit fields; whole-set replacement must be explicit. The `revision` scenario proves a 45-minute revised edit while retaining its name/load and unrelated work. W35 also requires readable ramps, repetitions, cadence, unknown-structure handling, locale quantities, and no raw JSON in normal review.

The terminal runner uses a scripted model and intercepts calendar traffic; it proves production channel orchestration, not live model quality or intervals.icu connectivity. Long terminal output does not prove Telegram delivery. The existing development bot and browser remain outside this runner’s ownership unless explicitly assigned by the operator. Honor the parent skill’s authorized route without starting a duplicate poller. Missing safe bot ownership, browser authentication, or calendar routing blocks the corresponding Telegram run. A test name mapped to a criterion is a starting point; inspect its assertions before assigning that criterion `PASS`. Plan approval and desktop are separate surfaces.

### Production chart coverage

- W03 requires supported addition charts with workout name and date inside the image.
- W04 requires validated structured-edit charts; saved name/date-only edits remain compact. W05 requires explicit deletion identity.
- W06 requires complete action counts beside approval. W35 requires localized `1 of 2`, `2 of 2`, and `N of NN` positions across all pending action types, readable effort and one estimate.
- W10 requires a pending structured edit to keep its chart when renamed, even if the model repeats identical duration and native description fields. Compare authoritative pending snapshots; only the selected name may change.
- W14/W15 require photo, caption continuation and context delivery before approval activation. Test failed media and text delivery through the existing dispatch tests.
- Production entry points are `review.ts:197`, `preparation.ts:104`, `channels/workout-chart.ts`, and `channels/telegram.ts:1625`. Regression owners include `workout-change-sets.test.ts` test `preserves authored review metadata when a rename repeats unchanged workout content`, `workout-change-set-review.test.ts`, and `telegram-dispatch.test.ts`.

### Additional current coverage

- Map readable provider ramps, nested repeat groups, and unchanged canonical snapshots to A02–A09 in `packages/core/tests/workout-change-set-review.test.ts:114`.
- Map targeted revisions under A10–A12 to `revises Thursday while preserving the other seven complete pending workouts` in `packages/core/tests/workout-change-sets.test.ts:169`. Include canonical restoration at line 491 and rejected targeted revisions at line 544.
- Use `preparation.readPending` in `packages/core/src/workout-change-sets/service.ts:305` as the authoritative pending-read entrypoint.
- In terminal `revision`, require the new 45-minute duration, retained `Planned tempo` name and training load 35, readable steps, exactly four ordered writes, and the unchanged unrelated workout.
- Map repeat boundaries to `isolates a repeat block from the following main-set step` and `separates a plain step and consecutive repeat blocks` in `packages/sport-cycling/tests/intervals-serializer.test.ts:89`. The production boundary logic is `packages/sport-cycling/src/intervals-serializer.ts:219`. Running has sibling coverage in `packages/sport-running/tests/intervals-serializer.test.ts`.

### Repeat-boundary real-provider recipe

Use the existing explicitly authorized, guarded live harness when a real-calendar run is requested. The fixture runner cannot establish parser correctness. If that harness is unavailable, record the real-provider check as blocked rather than changing fixture results into provider evidence.

1. Request a disposable cycling workout through Telegram with a five-minute warmup, two rounds of a two-minute effort and one-minute recovery, and a separate four-minute steady finish.
2. Inspect the complete 15-minute review and the blank separator after the repeat before approving.
3. Approve once in Telegram.
4. Read the owned workout independently from Intervals. Require 900 seconds, repeat count two, children of 120 and 60 seconds, and a separate 240-second final step.
5. Repeat with 240 seconds steady, two rounds of 120 plus 60 seconds, three rounds of 60 plus 30 seconds, and a separate 30-second finish. Require 900 seconds and two distinct groups.
6. Remove only the disposable test workouts through their owning harness and verify the original calendar is unchanged.

Check actual parsed steps as well as total duration. Keep power and cadence comparisons tied to the approved review. The previous live proof used a description-only edit before implementation, then generated additions after rebuilding; it did not bypass approval or inject a provider structure.

The [2026-09-21 Telegram run](../maintenance/telegram-extension/README.md) adds bounded live evidence for mixed-batch cancel/confirm and language preference persistence; consult its explicit limits before claiming coverage.
