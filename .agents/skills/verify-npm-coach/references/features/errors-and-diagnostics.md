# Error recovery and local diagnostics

## Sub-features

| Inventory ID | Capability |
|---|---|
| N27 | Friendly outage and credential recovery messages. |
| N28 | Local operational diagnostics. |
| T28 | Understand generation and delivery errors |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/agent/error-classify.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/agent/error-classify.ts).
- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).
- [packages/core/src/channels/telegram.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram.ts).
- [packages/core/src/logging/logger.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/logging/logger.ts).
- [packages/core/src/usage-ledger.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/usage-ledger.ts).
- [packages/engine/src/agent/coach-agent.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/coach-agent.ts).
- [packages/engine/src/agent/coach-agent-copy.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/coach-agent-copy.ts).

## How to get to it (user POV)

Observe actionable coaching and delivery errors. Operational logs and usage records live in the installation's local data directory. There is no npm spending dashboard. If the coach already saved information and then cannot verify its reply, it says it saved the information and could not verify the response (`chat.notice.savedUnverified`). If it already saved information and then cannot prepare the workout review, it says it saved the information and could not prepare the review (`coach.workoutPreparation.savedInformationFailed`). A prior save is not described as a failed workout review.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/error-classify.test.ts packages/core/tests/run-binary.test.ts packages/core/tests/telegram-dispatch.test.ts packages/core/tests/logging.test.ts packages/core/tests/usage-ledger.test.ts packages/engine/tests/workout-preparation-host.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

With the dedicated Telegram `single` launcher, send one fixture-backed coaching request. Before cleanup, inspect only its owned `logs/log.jsonl` and `usage-ledger.jsonl`. Retain sanitized field names and counts rather than raw identifiers. This is a narrow real logging observation. Existing tests own rotation, redaction, and classified error branches.

## Gotchas

There is no provider-outage or Telegram-delivery-failure scenario in the current runner. Do not invent --scenario=outage or treat incomplete preparation as provider failure. Live fault coverage remains BLOCKED until controlled injection exists. Logger/ledger sizes and retention must not be inferred from one successful entry.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
