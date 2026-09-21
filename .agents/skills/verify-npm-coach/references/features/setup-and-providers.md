# Setup, providers, and models

## Sub-features

| Inventory ID | Capability |
|---|---|
| N02 | Interactive setup and reconfiguration. |
| N03 | Provider selection. |
| N04 | Model selection and custom model ID. |
| N05 | Updated model catalog with bundled fallback. |
| N06 | API-key model access for Anthropic, OpenAI, Google, DeepSeek, Qwen, MiniMax, Kimi, Z.AI, and OpenRouter. |
| N07 | Custom provider endpoint. |
| N08 | ChatGPT subscription through npm OAuth, `openai-codex`. |
| N09 | OAuth session refresh and sign-in recovery. |
| N10 | Claude subscription through a signed-in Claude Code CLI, `claude-cli`. |
| N11 | Config-only Codex CLI provider, `codex-agent`. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/setup.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/setup.ts).
- [packages/core/src/config.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/config.ts).
- [packages/core/src/runtime-config.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/runtime-config.ts).
- [packages/core/src/claude-cli-setup.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/claude-cli-setup.ts).
- [packages/core/src/codex-agent-startup.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/codex-agent-startup.ts).
- [packages/core/src/auth/openai-codex-login.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/auth/openai-codex-login.ts).
- [packages/core/src/auth/profiles.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/auth/profiles.ts).

## How to get to it (user POV)

Run `cycling-coach setup` in a terminal. Choose a provider, then a model or a custom model. A base URL is asked only when that provider declares a default endpoint. OAuth and subscription choices have their own account prerequisites. Config-only `codex-agent` is not a visible setup choice.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/setup-providers.test.ts packages/core/tests/setup-merge.test.ts packages/core/tests/codex-setup-flow.test.ts packages/core/tests/claude-cli-setup.test.ts packages/core/tests/claude-cli-config.test.ts packages/core/tests/codex-agent-config.test.ts packages/core/tests/codex-agent-startup.test.ts packages/core/tests/runtime-config.test.ts packages/core/tests/config.default-models.test.ts packages/core/tests/model-catalog.test.ts packages/core/tests/model-catalog-refresh.test.ts packages/core/tests/model-catalog-owner-selection.test.ts packages/core/tests/auth-profiles.test.ts packages/core/tests/profile-store.test.ts packages/core/tests/codex/oauth.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

For a bounded real setup proof, create a private `mktemp -d` directory as `verify_setup_root` and run this command in an owned PTY:

```sh
env -i PATH="$PATH" CYCLING_COACH_HOME="$verify_setup_root" WORKOUT_VERIFY_REPO=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval WORKOUT_FIXTURE_CALENDAR="$verify_setup_root/calendar.json" CYCLING_COACH_NO_UPDATE_CHECK=1 ENDURAGENT_LANGUAGE=en node --import /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/npm-fixture.mjs /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/cycling-coach/dist/index.js setup
```

Select DeepSeek, choose Other, enter `fictional-model`, reach the endpoint prompt, then cancel before backend detection or sign-in. Capture visible choices and cancellation. Confirm no `config.yaml` or `auth-profiles.json` was saved. Retain a sanitized PTY transcript and remove the owned scratch home.

## Gotchas

This PTY recipe is not an automated runner mode. Never run Claude models for verification from Codex. Real OAuth, subscription identity, provider inference, catalog refresh, and token refresh need dedicated accounts or a controlled external fixture. Component tests are not live-authentication proof.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
