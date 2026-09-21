# Version, releases, updates, and feedback

## Sub-features

| Inventory ID | Capability |
|---|---|
| N22 | Current version and upgrade notification. |
| N23 | npm self-update and managed deployment guidance. |
| N24 | Update-check privacy and resilience. |
| T13 | Submit product feedback |
| T18 | Show installed version |
| T19 | Read release notes |
| T20 | Update npm or get redeploy guidance |
| T21 | Receive release notifications |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/updater.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/updater.ts).
- [packages/core/src/channels/npm-telegram-host.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/npm-telegram-host.ts).
- [packages/core/src/channels/telegram.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram.ts).
- [packages/coach-contract/src/athlete-feedback.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/coach-contract/src/athlete-feedback.ts).

## How to get to it (user POV)

Use shell `version` or Telegram `/version`, `/whatsnew`, `/update`, and `/feedback <note>`. Eligible bots also receive release notifications.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/updater.test.ts packages/core/tests/release-notes.test.ts packages/core/tests/npm-telegram-host.test.ts packages/core/tests/telegram-dispatch.test.ts packages/core/tests/telegram-bot.test.ts packages/core/tests/telegram-update-offsets.test.ts packages/core/tests/run-binary-allowlist.test.ts packages/coach-contract/tests/athlete-feedback.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

With dedicated Telegram prerequisites and doctor, run the existing `mixed` launcher. Send `/version`, empty `/feedback`, `/whatsnew`, `/update`, then `/version` again. Compare the displayed version with `packages/cycling-coach/package.json` in the selected built checkout; a version string alone proves delivery, not correctness. Require feedback usage without submission, unavailable release/update results, continued responsiveness, and an unchanged fictional calendar. Capture before Ctrl+C cleanup.

## Gotchas

At `0e9f8aff`, the workspace-launched real bot reported `2026.5.9` while the built npm package declares `2026.9.17`. `packages/core/src/updater.ts:87–111` resolves an installed package before its cwd fallback; direct resolution from the bundle found version `2026.5.9`. Record this product mismatch as FAIL; maintenance must not change product code or accept the wrong value.

Run `/update` only in this controlled fictional route, never against the real shared bot. The preload returns 503 outside intervals.icu and the scripted provider. It cannot prove successful feedback, registry lookup, installation, or telemetry. Automatic update checks are disabled. Never run self-update against the operator's global installation or send feedback to others as a verification side effect.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
