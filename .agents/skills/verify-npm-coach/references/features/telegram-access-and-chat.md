# Telegram access and conversation

## Sub-features

| Inventory ID | Capability |
|---|---|
| T01 | Private bot access and pairing |
| T02 | First operator claim |
| T03 | First-message welcome |
| T05 | Request a training plan |
| T06 | Request today's workout |
| T07 | Request training status |
| T08 | Request a training review |
| T09 | Free-text coaching |
| T10 | Combine rapid message fragments |
| T11 | Show ongoing work |
| T26 | Resend the last response |
| T27 | Read formatted and long replies |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/channels/telegram-access.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram-access.ts).
- [packages/core/src/channels/telegram.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram.ts).
- [packages/core/src/run-binary.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/run-binary.ts).

## How to get to it (user POV)

Message the private test bot. Use coaching shortcuts, ordinary text, rapid fragments, or bare resend. Unknown slash text falls through to ordinary chat.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/telegram-access.test.ts packages/core/tests/setup-allowlist.test.ts packages/core/tests/telegram-dispatch.test.ts packages/core/tests/telegram-coalescing.test.ts packages/core/tests/telegram-nonblocking.test.ts packages/core/tests/telegram-md.test.ts packages/core/tests/telegram-start-reset-failure.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --doctor-only
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=single
```

Use the dedicated test account and isolated authenticated browser. After READY and a visible `/version` reply, send `Prepare one easy ride.` without `/start`. Capture first welcome, review, control, and bare `resend` output. Cancel and read the fictional calendar for zero writes before launcher cleanup.

## Gotchas

Bare `resend` has two independent sources: cached coach prose and the durable pending review or outcome (`packages/core/src/channels/telegram.ts:1175–1182`). Require missing-content guidance only when neither source delivered anything. Keep cold-cache checks in the existing recovery executor.

The launcher preauthorizes the operator and uses noninteractive stdin, so it cannot prove unauthorized pairing or interactive operator capture. Fast scripted output cannot prove timing of a long typing heartbeat. The model fixture ignores most request semantics, so `/status` does not establish status reasoning. Text input only; no inbound media or group coaching.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.

The [2026-09-21 Telegram run](../maintenance/telegram-extension/README.md) adds bounded live evidence for mixed-batch cancel/confirm and language preference persistence; consult its explicit limits before claiming coverage.
