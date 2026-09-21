# Installation, hosting, and local data

## Sub-features

| Inventory ID | Capability |
|---|---|
| N01 | Global npm installation and terminal launch. |
| N20 | Local data location and existing-install continuity. |
| N25 | Self-hosted always-on deployment. |
| N26 | Graceful shutdown and restart diagnostics. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).
- [packages/core/src/coach-home.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/coach-home.ts).
- [packages/core/src/process-guard.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/process-guard.ts).
- [packages/cycling-coach/Dockerfile](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/cycling-coach/Dockerfile).
- [packages/cycling-coach/docker-entrypoint.sh](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/cycling-coach/docker-entrypoint.sh).

## How to get to it (user POV)

Install `cycling-coach`, run `setup`, then launch the binary. A configured Telegram token selects polling; otherwise it starts terminal chat. Shell help, version, and sender commands are separate entry points.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/run-binary.test.ts packages/core/tests/coach-home.test.ts packages/core/tests/config.data-dir.test.ts packages/core/tests/run-binary-shutdown.test.ts packages/core/tests/process-guard.test.ts packages/core/tests/run-binary-allowlist.test.ts packages/core/tests/npm-telegram-polling.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=cancel
```

Require the built prompt, cancellation, zero calendar mutations, `/quit`, process exit, and the retained result with clean teardown. This exercises built launch and isolated storage.

## Gotchas

Global npm installation, Node 22 compatibility, container startup, Railway persistence, legacy-home migration, and crash recovery are not proved by the cancel recipe. Use their tests and record missing platform proofs separately. The fixture doctor requires Node 24 even though the package minimum is Node 22.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
