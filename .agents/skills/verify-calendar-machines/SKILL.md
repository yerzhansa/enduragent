---
name: verify-calendar-machines
description: Model-check the six state machines behind the desktop Calendar and Activity review with TLA+, and find the engine test that guards each rule. Use before and after any change to a Plan Workout's copy on intervals.icu, its result on the calendar, the coach's written text, FTP proposals, Training Week delivery, or End Plan and Replace Plan.
---

# Verify the Calendar's state machines

The Calendar and Activity review hide six state machines. Each one is a small TLA+ model in `model/` and a discriminated union with one pure transition function in `packages/engine/src/planning/`. The models check every order of a few steps. The engine tests walk every event sequence of the real transition functions up to a fixed depth, with the same rules, and replay each path the models found as a named test.

## The six machines

| Machine | Model | Engine module | Engine test |
|---|---|---|---|
| A Plan Workout's copy on intervals.icu | `model/icu/WorkoutOnIcu.tla` | `icu-copy.ts` | `icu-copy.test.ts` |
| Its result on the calendar | `model/outcome/WorkoutOutcome.tla` | `workout-outcome.ts` | `workout-outcome.test.ts` |
| The coach's text (Activity review, missed-workout note) | `model/text/CoachText.tla` | `coach-text.ts` | `coach-text.test.ts` |
| FTP | `model/ftp/Ftp.tla` | `ftp-proposal.ts` | `ftp-proposal.test.ts` |
| Training Weeks on intervals.icu | `model/weeks/WeekDelivery.tla` | `week-delivery.ts`, `training-week.ts` | `week-delivery.test.ts` |
| End Plan and Replace Plan | `model/plan/PlanLifecycle.tla` | `plan-ending.ts` | `plan-ending.test.ts` |

Engine modules are in `packages/engine/src/planning/`; tests are in `packages/engine/tests/planning/`. `state-walk.ts` there is the bounded walk the tests share.

## Rules and the tests that guard them

Each rule is a TLA+ invariant with the same name. The test's walk checks it as a predicate over the real transition function, and the named test replays the path the model found.

| Rule | What breaks for the athlete | Named test |
|---|---|---|
| `NeverUndoneByItself` | An edit, move or delete made in intervals.icu is replaced without the athlete pressing Put back on that version, or a drag in the app never reaches intervals.icu. | `refreshes the card instead of putting back over a newer edit`, `does not send the Plan's version over an edit made in intervals.icu`, `sees a move made in intervals.icu and keeps it through a later coach change`, `closes the card when the athlete deleted a workout the coach then removed`, `deletes an edited workout on Put back once the coach removed it from the Plan`, `sends a drag of a kept edit to intervals.icu and keeps it the athlete's`, `sends a drag though the Plan's text for the workout changed before the run`, `shows the card when intervals.icu changed after a drag` |
| `APlanWorkoutIsNeverAbandoned` (engine only) | A Plan Workout's event becomes the athlete's own while the Plan still has the workout, so it is never sent again. | `takes a dragged workout off intervals.icu until its new week is due`, `keeps a moving kept edit as the athlete's when the Plan drops the workout` |
| `KeptEditReplacedOnlyWhenFlagged` | A kept edit is replaced by a coach change not marked "Replaces your intervals.icu edit", including after the athlete drags it, puts it back, or drags it out of the window and back. | `marks a coach change shown before a Keep as replacing the athlete's edit`, `never rewrites a kept edit for an unmarked Plan change`, `keeps a kept edit the athlete's after a drag out, a new edit and Put back`, `keeps a kept edit the athlete's after a drag out, a delete in intervals.icu and Put back` |
| `CardOnlyForRealChanges` | "Changed in intervals.icu" appears though nobody changed anything. | `does not open the card when intervals.icu only stored our write in its own format` |
| `NoRewriteOfSameWorkout` | The app rewrites a workout that already matches. | `keeps every rule on every path of up to nine steps` (icu-copy), `sends one update for an event found without a receipt, and leaves an unknown one alone` |
| `MissedIsTrue` | Missed shows before a sync covered the day. | `says Not synced yet, not Missed, the morning after when no sync has run`, `corrects a Missed by itself when a late sync brings the ride` |
| `RemovedIsNeverMissed` | A workout removed by the athlete shows Missed. | `never counts Removed by you as Missed or as planned time` |
| `OnlyConfirmedCounts` | An unconfirmed ride counts as done. | `does not count an unconfirmed ride` |
| `RideOnTheDayIsSuggested` | A ride on the day a kept move set gets no "Is this it?". | `suggests a ride on the day a kept intervals.icu move set` |
| `NoReplyWithoutAsking` | The coach spends a reply nobody asked for. | `never rewrites a kept text by itself`, `tries a text the model failed again only when the athlete asks` |
| `OpenAfterModelFailureSpendsNothing` | Opening a text the model failed to write spends another reply, instead of showing the failure and Write again. | `tries a text the model failed again only when the athlete asks`, `records whether the model failed or the write was interrupted` |
| `NeverStuckWriting` (engine only) | A text left half-written when the app quit can never be written. | `recovers a text left writing when the app quit, on the next open` |
| `NoTextBeforeTheMatch` | The coach writes before the athlete confirms the match. | `waits for Confirm or Not this one before writing` |
| `KeptTextIsHonest` | A kept review describes a match that changed, and nothing says so. | `says which match a kept review was written for after the match changes` |
| `OneFtp` | The coach and the head unit use different FTPs. | `uses only intervals.icu's FTP, the indoor one for indoor rides` |
| `NeverOverwriteAnUnseenFtp` | The app writes over an FTP the confirm did not show. | `shows a number set in intervals.icu while the confirm is open before writing` |
| `NoProposalFromOneRide` | One ride makes the coach propose a new FTP. | `keeps every rule on every path of up to nine steps` (ftp-proposal), `finds drift only after 14 days at least 3% away since the FTP was set`, `does not raise drift on the first check after the FTP changed`, `never raises drift on the first check, before it has seen an FTP` |
| `PlannedTestIsAnswered` | A planned FTP test gets no answer inside the 4 weeks after Keep. | `answers a planned test within four weeks of Keep` |
| `ShownProposalFollowsIcu` | A proposal card stays open after the athlete set a new FTP in intervals.icu, so it argues against a number intervals.icu no longer holds. | `retires a shown drift card when the athlete sets a new FTP in intervals.icu`, `asks again about an unanswered planned test against the FTP intervals.icu now holds` |
| `AnsweredTestIsNotAskedAgain` (engine only) | The coach asks again about a planned test the athlete already answered, or an older one. | `does not ask again about a planned test the athlete already answered`, `ignores an older planned test once a later one was answered` |
| `NothingWithoutConsent` | A week reaches intervals.icu without the athlete's Approve. | `sends nothing before the first Approve`, `waits for each later week's Approve when the setting asks` |
| `ThisWeekAndNextAreThere` | This Training Week or next is missing from intervals.icu after a run. | `sends this week and next when the first Change Set is approved late`, `sends every due week after the app was closed for more than seven days` |
| `TodayIsKept` | End or Replace deletes today's workout, or keeps the next day's when the cleanup retries a day later. | `keeps today's workout when the Plan ends`, `removes from the day after the Plan closed, even when the cleanup retries a day later` |
| `NeverTwoPlansOnIntervals` | The new Plan's weeks go out while the old ones are still there. | `sends the new Plan's weeks only after the old ones are removed and checked` |
| `LocalFirst` | A failed cleanup reopens the old Plan. | `closes the Plan locally before any cleanup runs` |
| `YourChangesAreNotDeletedByItself` | End or Replace deletes a workout the athlete changed in intervals.icu, or one changed again after the confirm. | `lists the workouts the athlete changed apart and removes only the ticked version`, `keeps a ticked change the athlete then moved to another day` |

Each machine's walk test (`keeps every rule on every path…`) checks all of that machine's rules at once. The two rules marked "engine only" have no TLA+ invariant: the models clear their evidence and text state in ways the engine cannot, so only the walks see these cases.

The walks are wider than the models in four places:

- The icu walk has two days in the window and one in a later week. The athlete can move a workout in intervals.icu or drag it in the app, the coach can remove one, and intervals.icu can stop answering.
- The End walk lets a day pass before the cleanup and lets the athlete edit again after the confirm.
- The FTP walk keeps a planned test as evidence after Keep, as intervals.icu does.
- The coach text walk lets the app quit mid-write while the page stays open, and checks `NeverStuckWriting` on top of the model's rules.

## Run the models

Needs Java 11 or newer. Set `JAVA` to its `java` binary when `java` is not on `PATH`. The script downloads TLC 1.7.4 to `~/.cache/enduragent/` once and checks its sha256. To use a jar you already have, set `TLA2TOOLS` to it.

```bash
node .agents/skills/verify-calendar-machines/scripts/check.ts
```

It runs each rule once per variant, in about a minute, and exits 0 when every result matches. `--model icu` runs one model; `--trace` prints the path of each broken rule.

Each model has two variants:

- `built`: the design as the engine implements it. Every rule holds.
- `before`: the design as approved before the statechart pass. The rules in the table below break.

The icu model also has one variant per fix, with only that fix off, to show that each fix is needed on its own.

| Variant | Breaks |
|---|---|
| `icu/before` | `NeverUndoneByItself`, `KeptEditReplacedOnlyWhenFlagged`, `CardOnlyForRealChanges` |
| `icu/without-readback` | `CardOnlyForRealChanges`, and `KeptEditReplacedOnlyWhenFlagged`: the false card lets Keep adopt the app's own copy as the athlete's edit |
| `icu/without-recheck` | `NeverUndoneByItself` |
| `icu/without-staleSet` | `KeptEditReplacedOnlyWhenFlagged` |
| `outcome/before` | `MissedIsTrue`, `RideOnTheDayIsSuggested` |
| `text/before` | `KeptTextIsHonest`, `OpenAfterModelFailureSpendsNothing` |
| `ftp/before` | `NeverOverwriteAnUnseenFtp`, `PlannedTestIsAnswered`, `ShownProposalFollowsIcu` |
| `weeks/before` | `ThisWeekAndNextAreThere` |
| `plan/before` | `TodayIsKept`, `NeverTwoPlansOnIntervals`, `YourChangesAreNotDeletedByItself` |

## What is not built

No one ran the desktop before this design, so the upgrade paths are left out:

- The icu model starts every Plan in the new mode. Its "old" mode and `checkNow` fix never run.
- The FTP model runs with `AppStart = {"none"}`. The app keeps no FTP of its own, so the two-FTPs question never opens.

## Change a machine

1. Change the engine module and its test first. The walk test fails when a rule breaks.
2. If the change alters a step the model has, edit the model's action to match, and run the check.
3. A rule never gets weaker to make a run pass. A new rule gets a walk predicate and a named test, and a TLA+ invariant when the model can express it. A rule the model cannot express is marked "engine only" in the table above.

The icu walk's executor skips a write when intervals.icu already holds what the app would send, as the calendar mirror's conditional write does. Without that, `NoRewriteOfSameWorkout` breaks when the athlete moves a workout in intervals.icu to the day they then drag it to in the app.

Read a model's results with the `/statechart` skill: give it the `.tla`, a config like the one `check.ts` writes, and the `view.ts` beside it.

## Bounds

The models use one workout, three Training Weeks and one ride. The icu model has no drag action, so drags in the app are covered only by the TypeScript walk in `packages/engine/tests/planning/icu-copy.test.ts`. The engine walks stop at 8 to 12 steps. Neither covers real timing (the 6-hour timer, head-unit downloads), partial write failures and the drain's retries, indoor FTP in the models, or a drag across the sent and not-sent boundary.

The plan model has one old Plan, so it cannot see a chain of Replaces. The calendar drain holds the new Plan while any closed Plan's cleanup is not verified, not only the newest. `packages/coach/tests/plan-calendar-cleanup-barrier.test.ts` guards that: `holds the new Plan behind an older failed cleanup after a later replacement's cleanup verifies`.
