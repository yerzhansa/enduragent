---
name: verify-npm-coach
description: Verify cycling-coach npm features through real Telegram, OpenRouter DeepSeek, and Intervals athlete 2 by default. Use for workout approval, coaching, and channel QA; retain isolated executors for component and fault checks.
---

# Verify npm coach

Read repository instructions and [the complete feature index](references/features/README.md). Use [coverage.json](references/features/coverage.json) to select the affected feature pages and their existing executors. Every one of the 175 inventory entries has one owning page. Calendar approval pages retain the existing 51 criteria at `/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/acceptance.md`. Product intent stays with source and existing authorities. Mapping an entry does not establish a runtime pass.

Own this skill's feature map, scripts, their spawned child processes, and their newly created scratch directories. Preserve existing Vitest tests, terminal executor, Telegram browser executor, and desktop executors. Desktop verification belongs to `verify-enduragent` and `verify-desktop-codex`.

## Default live setup

Use real Telegram, OpenRouter `deepseek/deepseek-v4.1-flash`, and the real Intervals athlete 2 account by default. Read `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `INTERVALS_API_KEY_2`, and `INTERVALS_ATHLETE_ID_2` from the project `.env`. Keep the matching `_2` pair together. Use the existing authorized development bot and Chrome login described in [Telegram access](references/telegram-access.md).

Check the recorded access locations before asking for credentials. If a required token, account permission, browser login, or bot access is missing or invalid, ask the human for that specific prerequisite. Ask them to configure secrets locally; never request secret values in chat. Keep the dependent live check blocked until access is restored. Do not silently switch to simulated data, a different provider, model, or athlete.

Keep the operator's existing $2 OpenRouter budget for this verification campaign. Count prior spend toward that limit. Ask before increasing the budget; a new invocation does not reset it.

Use the [live workout scenarios](references/telegram-access.md#live-workout-scenarios) for batch approval verification. Use marked, disposable test workouts for mutations. Preserve unrelated real-calendar entries. Existing fixture and component tests supplement live proof and remain available when explicitly selected.

## Prepare

Run from the checkout containing the feature. The current checkout is `/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval`.

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm --filter 'cycling-coach...' build
```

If the build fails because `tsx` cannot create its IPC pipe, rerun the exact build with local IPC permission. Do not drive after another build failure.

The optional fixture mode does not load the repository `.env` or use normal athlete homes, credentials, or shared bot processes. Honor explicit session authorization for a named bot, browser, model, and calendar; do not infer authorization from this skill. Previously started development bots and live-calendar harnesses remain outside this runner’s ownership.

The runner reuses the existing `npm-terminal-smoke.mjs` and `npm-fixture.mjs` scenario behavior from the initiative's verification directory. Its package root and evidence output are now configurable and isolated. Existing historical evidence remains in that directory. Use this skill's runner for new evidence.

When explicitly selected, the fixture replaces provider and intervals.icu fetch responses with fictional state. It freezes the athlete date at `1998-09-07`. The real production binary still prepares, reviews, approves, persists, and executes changes. This proves production channel behavior with controlled boundaries. It does not prove a real model's planning or remote intervals.icu service behavior.

## Doctor

Check the complete feature map before choosing a runtime route. Run `node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/check-feature-map.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval`. Require map consistency PASS. If the selected revision differs from the inspected revision, investigate source drift before reusing evidence. This check establishes inventory coverage, not live behavior.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/doctor.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
```

Use Node 24 for the build, doctor, and runners. Require `DOCTOR: ready to drive built npm fixture` and exit code zero. Doctor checks Node 24, fixture dependencies, the batch capability, and output freshness against the binary's workspace dependency sources and lockfile. It performs no writes. Rebuild missing or stale outputs. Re-run doctor after unexpected behavior before driving again. A localization extraction can touch an unchanged catalog after a build; rebuild when doctor reports it as newer instead of bypassing freshness checks.

## Launch

### Default real Telegram route

Read [Telegram access](references/telegram-access.md) and establish the existing real poller's owner before driving. Verify its active OpenRouter model and matching Intervals `_2` account without printing secrets or athlete identifiers. Reuse the authorized real runtime when it matches. If it needs restarting, inspect its recorded launcher and guard configuration first. Never start a duplicate poller.

Open the authorized bot in Telegram Web A on macOS and require a visible `/version` response. Use ordinary chat messages and delivered approval buttons. Read Intervals independently before and after each approval. Follow the live scenarios and retain the model, binary revision, cost, redacted calendar comparisons, and UI results.

The real runtime is separately owned; this skill has no built-in real-model launcher. Its temporary launcher location is a discovery lead in the access note. If that launcher is missing, recover the setup from its owning task. Ask the human when missing access prevents recovery. The fixture launcher below is not a replacement for this route.

### Optional fixture routes

Run the terminal proof with no real credentials when fixture verification is selected.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

The runner calls doctor, creates a private home, starts the built npm binary, and waits for its terminal prompt. It sends ordinary stdin messages and checks the displayed review before approval. It opens no listening port. It exits after checking the calendar and cleaning up. `Ctrl+C` stops the owned child and follows the same cleanup path.

Before requesting Telegram credentials or a browser profile, read [the local access and handoff note](references/telegram-access.md). It identifies the project `.env` token source, derived runner configuration, test bot, browser session, and owning task.

For explicitly selected fictional Telegram verification, provision a dedicated disposable bot, test Telegram account, and isolated authenticated browser profile. Use an existing development bot or browser only under explicit session authorization. The bot must have no webhook, pending updates, or other polling process before a new launcher starts.

Store credentials in a mode-600 JSON file owned by the current user. Set `NPM_VERIFY_TELEGRAM_CONFIG` to its path. Required fields are `botToken`, `botUsername`, `operatorId`, and `disposable: true`. Obtain the first three from the dedicated test setup. Do not put values in chat, code, evidence, or commands. This external prerequisite is not supplied by the repository.

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --doctor-only
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

The existing `--authorized-existing-dev-bot` mode requires `operatorAuthorized: true` in the private configuration and accepts only the development bot hardcoded by `scripts/telegram.mjs`. Use that flag only when the session already authorizes that named bot. It does not select a real model or calendar; the launched child still uses fictional boundaries. Do not start a second poller for an already connected bot.

The Telegram doctor validates credential-file permissions, bot identity, webhook absence, and `getWebhookInfo.pending_update_count` without consuming updates. It does not prove browser authentication or exclusive polling ownership. Establish poller ownership from the recorded launcher before launch; preserve processes outside this run’s ownership. Launch waits for `READY` after the production Telegram startup banner. The transport uses the real Telegram service; provider and calendar responses remain fictional. Open `https://web.telegram.org/a/` in the dedicated profile and select the verified bot username. Keep the launcher alive during the drive. Send `Ctrl+C` to that launcher for teardown. The launcher removes its child and scratch home while preserving evidence. It never stops the shared bot.

A startup banner does not prove message delivery or approval. Require a visible response to `/version` before a live Telegram feature drive. Ask the human to restore missing required credentials or authentication after checking the access note. Keep the affected check `BLOCKED` while access or bot ownership is unresolved. Do not weaken isolation to get a pass. macOS satisfies the required Telegram platform coverage. Debian is not required.

## Drive

Start with the real Telegram scenarios for affected workout flows. The terminal commands below are supplemental fixture coverage.

Use the selected feature page's exact commands and existing test identifiers. Read only affected pages. The broader pages add source and test coverage. Three coaching groups also have bounded built-terminal fixtures; wider live gaps and external prerequisites remain explicit. Never derive a scenario name from a page slug. Terminal scenarios are `single`, `mixed`, `revision`, `cancel`, `long`, `stale`, `retry`, and `incomplete`. Add `--restart` to the mixed scenario for pending-review recovery. These names come from the existing runner, not a second scenario inventory.

Run the new coaching fixtures individually:

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=memory
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=data
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=planning
```

These scenarios use a sibling fixture that imports the original network boundary. Existing terminal and Telegram workout executors remain unchanged. The Telegram launcher does not yet support these coaching scenarios. Read [the coaching fixture report](references/maintenance/coaching-extension/README.md) for current proof and remaining prerequisites.

Run service tests with `pnpm exec vitest run`. They own controlled concurrency, ownership, date, crash, and uncertain-result coverage. Mocked Telegram dispatch tests prove dispatch behavior only. They do not replace live Telegram evidence.

For Telegram UI driving, use available browser tooling in the dedicated or explicitly authorized profile. Ground every locator in a fresh accessibility or DOM observation. Telegram Web variants expose different controls. The observed `/a/` composer is `#editable-message-text`, which sends with Enter. The observed `/k/` composer is `div.input-message-input[contenteditable="true"]:not(.input-field-input-fake)` and sends with Enter; its visible mirror must be excluded. Do not assume a `textbox` named `Message` or a `Send Message` button exists. Verify the bot header before sending. Match approval labels from the delivered message, as localized production copy can change. Do not inject callbacks or call service methods as user proof.

The fixture's provider returns scenario-specific proposals. It does not interpret arbitrary new coaching requests. For memory, recorded-activity reads, and planning, run the separate coaching executor below. Its model selects production tools from exact scripted requests and displays their actual results. It does not prove real-model coaching judgment. Both launchers force English. The Telegram launcher preauthorizes the operator and deletes its new home on exit, so it cannot prove effective language switching, first pairing, or persistent Telegram restart. For stale, retry, and restart steps, use the selected page and existing service tests. Record any unsupported live fault injection as `BLOCKED`; do not claim terminal or service evidence as a Telegram pass.

For chart cards, read [the chart review checks and current evidence](references/future-review-prototype.md). The working tree implements automatic cards. Real Telegram verification covers structured edits and chart preservation when a pending edit is renamed; check the retained evidence for its exact scope. Prototype messages do not establish a product pass. If Web A omits a heading from its current history view, search for the exact heading before declaring delivery lost or resending it.

## Evidence

Retain each run under the printed `Evidence` directory inside the operating system temporary directory's `enduragent-verify-npm/` folder. Each launch creates a unique subdirectory.

Terminal evidence contains `transcript.txt`, `calendar.json`, and `result.json`. The result records scenario, restart, Git revision, binary hash, runtime, platform, status, and cleanup. The calendar file is a separate read-only view of persisted effects. The transcript records the request, review, approval, and result.

Coaching evidence additionally retains the fictional athlete inputs, actual model-visible tool results and context in `coaching-trace.json`, plus saved memory and plan files. Require zero calendar writes. Scripted reply text alone is not the result assertion.

Fixture Telegram evidence contains sanitized `runtime.txt`, fictional `calendar.json`, and `result.json`. Startup alone leaves its feature status `NOT RUN`. Add a sanitized browser action/result transcript and cropped proof of the relevant review and result. Use the printed fictional calendar path as the second read-only view before cleanup. Exclude unrelated chats, bot tokens, test-account identifiers, and local private paths from retained browser proof.

Record each applicable acceptance ID, executor, revision, result, and evidence. Use `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`. Keep coverage gaps explicit. Never upload evidence automatically.

## Cleanup

For live runs, remove only the marked workouts created by this verification under the existing test authorization. Verify unrelated calendar entries remain unchanged. Retain redacted results and preserve the real runtime unless this run owns its lifecycle.

Terminal cleanup runs after success, failure, or interruption. Telegram cleanup runs after child exit or launcher `Ctrl+C`. Each runner signals only its own child PID, waits for exit, and removes only its newly created scratch home. Neither runner opens a listening server. Require `cleanup.livePids` to be empty and `cleanup.scratchRemoved` to be true. Retain the evidence directory. Close only verification-owned browser tabs and dispose of the dedicated temporary browser profile through its owning driver.

If the host kills the launcher without allowing cleanup, inspect that run before acting. Never kill by process name or delete directories by a wildcard. Do not delete a credential file supplied by the operator. Never count cleanup as complete without observing the owned process exit and scratch removal.

Run the repository privacy check after verification.

```sh
pnpm check:fixture-privacy
```

That check does not scan ignored skill files or temporary evidence. Inspect those separately for secrets, real identifiers, current-era fixture dates, and private paths. Preserve evidence when a check fails. Report the exact verification scope; one proved terminal feature does not certify all 51 criteria or live Telegram.

## Verified runner coverage

Read [the full-inventory maintenance report](references/maintenance/latest.md) for this expansion. Keep source coverage, component tests, built terminal, actual Telegram, and real provider/calendar evidence separate. A complete maintenance pass remains blocked while required live coverage is missing, even when every source feature has a map entry.

The generated instructions passed mixed approval, revision, stale review, retry, and pending-review restart through the built terminal. An intentional interruption preserved evidence and cleaned up its child and scratch state. See `/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/verification/skill-proof/README.md`.

The fixture Telegram doctor passed the explicitly authorized development-bot route. This read-only check did not start a child or drive the browser. Separately, operator-authorized real Telegram/model/calendar runs verified bounded revision, resend, approval-copy, stale-target, and repeat-duration behavior; see the linked evidence in the feature index. Those runs used a separately owned guarded harness, not this fixture launcher. The fixture launcher has bounded mixed-batch cancel/confirm and language-persistence browser evidence in [the Telegram extension](references/maintenance/telegram-extension/README.md). Its complete browser acceptance suite remains unverified. Do not describe doctor, startup, terminal, or prior partial evidence as a complete Telegram acceptance pass.

See [the maintenance record](references/maintenance.md) for current source coverage, executed recipes, corrections, and cleanup evidence.
