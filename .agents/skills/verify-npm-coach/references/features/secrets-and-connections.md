# Credentials, connections, and sender administration

## Sub-features

| Inventory ID | Capability |
|---|---|
| N12 | Secret storage choice. |
| N13 | Credential replacement, retention, and backend migration. |
| N14 | Environment and executable secret references. |
| N15 | intervals.icu connection setup. |
| N16 | Telegram setup, pairing, and sender administration. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/setup.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/setup.ts).
- [packages/core/src/config.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/config.ts).
- [packages/core/src/secrets/resolve.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/secrets/resolve.ts).
- [packages/core/src/channels/allowed-senders.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/allowed-senders.ts).
- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).

## How to get to it (user POV)

Use setup to connect model, intervals.icu, and Telegram credentials. Use `add-sender`, `list-senders`, and `remove-sender` to administer Telegram access.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/setup.secret-ref.test.ts packages/core/tests/config.secret-ref.test.ts packages/core/tests/secrets/types.test.ts packages/core/tests/secrets/resolve.test.ts packages/core/tests/secrets/backends/detect.test.ts packages/core/tests/secrets/backends/keychain.test.ts packages/core/tests/secrets/backends/op.test.ts packages/core/tests/secrets/backends/spawn-timeout.test.ts packages/core/tests/setup-allowlist.test.ts packages/core/tests/run-binary-allowlist.test.ts packages/core/tests/allowed-senders.test.ts packages/core/tests/operator-capture.test.ts packages/core/tests/telegram-setup.test.ts packages/core/tests/telegram-access.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

After doctor, create one private temporary home. Give each command the same `CYCLING_COACH_HOME` and an otherwise minimal environment containing PATH and `ENDURAGENT_LANGUAGE=en`. Run the built binary with `add-sender 12345`, `list-senders`, `remove-sender 12345`, then `list-senders`. `12345` is fictional. Capture command results and read that home's `allowed-senders.json` after add and remove. Require addition, removal, process exits, and scratch removal after sanitized evidence is retained.

## Gotchas

The managed Telegram launcher preauthorizes its operator, so it cannot prove first pairing. No live vault or real intervals.icu connection is proved by mocked credential tests. Do not use operator Keychain items or normal accounts. A config-only open Telegram policy does not create independent athlete profiles.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
