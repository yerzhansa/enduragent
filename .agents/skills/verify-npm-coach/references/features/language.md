# Language and locale

## Sub-features

| Inventory ID | Capability |
|---|---|
| N17 | Localized setup, CLI output, and coaching replies. |
| T14 | Choose a fixed language |
| T15 | Restore automatic language |
| T16 | Localized interface and coaching |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/language-preference.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/language-preference.ts).
- [packages/core/src/channels/telegram-language-menu.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram-language-menu.ts).
- [packages/core/src/channels/telegram-command-menu.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/channels/telegram-command-menu.ts).
- [packages/i18n/src/registry.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/i18n/src/registry.ts).
- [packages/i18n/src/coach-language.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/i18n/src/coach-language.ts).
- [packages/i18n/src/node.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/i18n/src/node.ts).

## How to get to it (user POV)

Setup offers a fixed language. Telegram `/language` offers a fixed language or Automatic. The environment override takes precedence over saved preference.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/setup-language.test.ts packages/core/tests/run-binary-language.test.ts packages/core/tests/telegram-language.test.ts packages/core/tests/telegram-language-menu.test.ts packages/core/tests/telegram-command-menu.test.ts packages/i18n/tests/coach-language.test.ts packages/i18n/tests/node.test.ts packages/i18n/tests/registry-resolve.test.ts packages/i18n/tests/detect-message-language.test.ts packages/i18n/tests/messages-fallback.test.ts packages/i18n/tests/catalog-coverage.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

With the dedicated Telegram prerequisites and successful doctor, run:

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

Require `/version`, then send `/language`. Select Español, read the owned `language.json` beside the printed calendar path, and verify saved `es`. Effective output remains English because this launcher overrides it. Select Automatic and verify the saved language property is removed. Capture UI and sanitized persistence evidence before Ctrl+C cleanup.

## Gotchas

Both current runners force `ENDURAGENT_LANGUAGE=en`. This recipe proves override disclosure and persistence only. Effective fixed-language switching and Automatic detection need a runner option without that override. Missing dedicated bot or isolated browser authentication blocks UI proof.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.

The [2026-09-21 Telegram run](../maintenance/telegram-extension/README.md) adds bounded live evidence for mixed-batch cancel/confirm and language preference persistence; consult its explicit limits before claiming coverage.
