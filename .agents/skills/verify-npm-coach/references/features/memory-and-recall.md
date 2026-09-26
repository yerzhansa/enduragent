# Athlete memory, recall, and saved plans

## Sub-features

| Inventory ID | Capability |
|---|---|
| C02 | Remember and correct current identity/body data, weekly availability/time windows/blackout days, goals/race dates/milestones, coaching and communication preferences, miscellaneous notes, medical history, cycling physiology, equipment, and cycling-specific history. |
| C03 | Save daily coaching notes separately from current long-term facts. |
| C04 | Record dated decisions, overrides, illness, experiments, and outcomes in an append-only event history. |
| C05 | Recall prior notes, decisions, illness, experiments, outcomes, and changed facts for an inclusive date range; optional case-insensitive text search. Includes section-change and saved-plan history. Maximum range is 366 days; oversized results ask for narrower searches. |
| C21 | Save or replace an approved complete training-plan object after explicit confirmation, and load it in later conversations. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/engine/src/sport/memory-tools.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/sport/memory-tools.ts).
- [packages/engine/src/sport/shared-sections.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/sport/shared-sections.ts).
- [packages/sport-cycling/src/sport.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/src/sport.ts).
- [packages/core/src/agent/confirmation-gate.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/agent/confirmation-gate.ts).

## How to get to it (user POV)

Ask the coach to remember or correct a fact, save a daily note, record an event, recall a date range, or save/load a complete plan. Plan saving uses its own confirmation.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/memory-tools-schema.test.ts packages/core/tests/memory-query.test.ts packages/core/tests/memory-event-ledger.test.ts packages/core/tests/memory-journal.test.ts packages/core/tests/memory-daily-note-dedup.test.ts packages/core/tests/memory-plan-load.test.ts packages/core/tests/memory-plan-read-gate.test.ts packages/core/tests/memory-plan-write-gate.test.ts packages/core/tests/confirmation-gate.test.ts packages/engine/tests/athlete-snapshot-wiring.test.ts packages/engine/tests/workout-preparation-host.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

Run the built-terminal memory fixture:

```sh
caffeinate -i node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=memory
```

This saves and corrects a fictional preference, saves a daily note and a separate general note, appends a dated event, queries history, reads non-injected memory, and repeats recall after a process restart. The runner compares real tool results with the retained memory, journal, ledger, and daily-note files. Current preference context must survive restart. Calendar writes must remain empty. Run the `planning` scenario to prove complete-plan confirmation and reload.

Read [the coaching fixture report](../maintenance/coaching-extension/README.md) for bounded live evidence.

## Gotchas

Use `coaching-terminal.mjs` for these exact scripted requests. The original workout fixture still emits workout proposals for arbitrary chat. The coaching fixture refuses unrecognized requests. A memory save followed by a failed reply check uses the saved-unverified notice on [Error recovery and local diagnostics](errors-and-diagnostics.md), not a workout-review failure. `memory_read` is exposed only when a stored section is not already injected into context; the scenario creates such a general note before reading it. Recall is capped at 366 days. The six shared and three cycling sections are one athlete memory, not separate sender profiles.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
