# Calendar workouts and external delivery

## Sub-features

| Inventory ID | Capability |
|---|---|
| C23 | Schedule a requested structured ride on intervals.icu for today or a future date. Supported steps are warmup, steady, interval, ramp, recovery, rest, cooldown, freeride and repeated interval/recovery sets; durations use seconds/minutes; power targets support FTP percent, watts, zones and ranges; cadence targets are supported. |
| C24 | Schedule a gym/strength session with a name, a duration in minutes, an effort line, and a free-text description. Sets, reps, and weight stay inside that description. |
| C25 | View scheduled workout dates, names, duration, load and coach ownership; filter to coach-created workouts. |
| C26 | Edit a coach-created today/future workout's date, name, description, duration, training load or workout document. Authored cycling edit steps are validated and converted to native description/duration; trusted steps are retained separately for review charts. Cannot move it into the past. |
| C27 | Delete a coach-created today/future workout after listing and confirmation. Past, unowned and non-workout events are protected. |
| C28 | Approve or cancel the pending calendar change set before execution. Batch approval has no elapsed-time expiry. Plan-save approval remains a separate flow. |
| C29 | Receive head-unit-compatible steps through intervals.icu's connected-device integrations. This requires the athlete's Garmin/Wahoo connection in intervals.icu; Enduragent does not independently deliver the workout. |
| T17 | Confirm or cancel a single guarded operation |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/sport-cycling/src/workout-change-set-tool.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/src/workout-change-set-tool.ts).
- [packages/engine/src/agent/coach-agent.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/coach-agent.ts).
- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).
- [packages/core/src/workout-change-sets/review.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/workout-change-sets/review.ts).

## How to get to it (user POV)

Request a ride or strength workout, list the calendar, or request eligible edits/deletions. Supported cycling additions and structured edits use the [production chart cards](../future-review-prototype.md); unsupported charts use readable text. Review the whole requested set before approval. Read the linked approval, restrictions, changed-workout, and recovery pages for detailed scenarios.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/workout-change-sets.test.ts packages/core/tests/workout-change-set-protection.test.ts packages/core/tests/workout-change-set-review.test.ts packages/engine/tests/workout-preparation-host.test.ts packages/engine/tests/intervals-tools-events.test.ts packages/sport-cycling/tests/tools.test.ts packages/sport-cycling/tests/intervals-serializer.test.ts packages/sport-cycling/tests/workout-change-set-tool.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

Require zero writes before approval, then four exact effects. Read `calendar.json` independently. Event 101 becomes 4,500 seconds, 102 is deleted, two additions exist, and event 103 is retained. Preserve transcript and result.

## Gotchas

Current branch replaces four direct calendar mutation tools with prepare_workout_changes and get_pending_workout_changes. C28's baseline ten-minute calendar proposal no longer applies to the batch workflow, which has no elapsed-time expiry. plan_save remains separate. Garmin/Wahoo delivery is an intervals.icu integration prerequisite and is not proved by a synthetic calendar.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.

The [2026-09-21 Telegram run](../maintenance/telegram-extension/README.md) adds bounded live evidence for mixed-batch cancel/confirm and language preference persistence; consult its explicit limits before claiming coverage.
