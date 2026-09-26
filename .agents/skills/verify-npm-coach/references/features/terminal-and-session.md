# Conversation and session continuity

## Sub-features

| Inventory ID | Capability |
|---|---|
| N18 | Terminal free-form coaching conversation. |
| N19 | Session and context configuration. |
| C06 | Preserve coaching facts and events across session compaction/reset/shutdown through memory flush, then use them in later conversation. |
| T04 | Start or reset conversation |
| T29 | Resume polling after downtime |
| T30 | Drain work during shutdown |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).
- [packages/core/src/config.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/config.ts).
- [packages/engine/src/agent/coach-agent.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/coach-agent.ts).
- [packages/core/src/channels/telegram.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram.ts).

## How to get to it (user POV)

Type ordinary terminal messages; `/quit`, `/exit`, and EOF close terminal chat. Telegram `/start` resets conversation. Daily/idle rollover, compaction, and restart affect conversation state.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/run-binary.test.ts packages/core/tests/run-binary-shutdown.test.ts packages/core/tests/run-binary-language.test.ts packages/core/tests/config.session-defaults.test.ts packages/core/tests/config.session-retention.test.ts packages/core/tests/conversation-store.test.ts packages/core/tests/telegram-start-reset-failure.test.ts packages/core/tests/telegram-update-offsets.test.ts packages/core/tests/telegram-work-ledger.test.ts packages/core/tests/telegram-generation-lifecycle.test.ts packages/core/tests/telegram-coalescing.test.ts packages/engine/tests/memory-flush-outcome.test.ts packages/engine/tests/reset-session-lock.test.ts packages/engine/tests/reset-flush-guard.test.ts packages/engine/tests/session-freshness.test.ts packages/engine/tests/session-corrupt-recovery.test.ts packages/engine/tests/session-ordering.test.ts packages/engine/tests/compaction.test.ts packages/engine/tests/compaction-substrate.test.ts packages/engine/tests/trim-compaction-guard.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=incomplete
```

The runner asks `How did I sleep?` after an incomplete proposal. Require the distinct unrelated answer without replaying the old notice, zero calendar writes, and clean `/quit`. Retain transcript, calendar, and result.

## Gotchas

This fixture cannot interpret arbitrary saved facts or prove semantic memory flush. Terminal `--restart` proves a saved workout review, not conversation persistence. The Telegram launcher creates a fresh home and deletes it on stop; it has no restart-preserving mode and refuses pending updates during doctor.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
