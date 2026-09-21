# Chart-review maintenance

Status: **blocked**. Verified skill corrections are complete; the full live feature pass has remaining prerequisites and runner gaps.

The single maintained target is `verify-npm-coach`. Source investigations covered all 17 feature pages at `4c0a13e6cdb9137aa8a5b1fc9c0e529b604037fa`. No product source or product tests changed. No PR was created.

## Corrections

- Updated the terminal revision assertion to `Estimated training load: 35`, then passed the same revision route.
- Corrected C28 to describe batch approval without elapsed-time expiry.
- Corrected the pending-read entry point to `preparation.readPending`.
- Marked the description-only preview discrepancy as fixed in source, with real-provider verification still separate.
- Recorded the existing language persistence proof and current bounded setup/sender proof as partial coverage.
- Corrected the setup cleanup description because its scratch home contains `calendar.json`.
- Added the observed Web A composer and the exact-heading search check for apparently missing messages.
- Recorded [accepted chart-card checks](../../future-review-prototype.md) separately from implemented features.

The chart checks include additions, multiple edits, compact name/date edits, deletions, mixed batches, name/date inside charts, one load estimate, and the complete summary beside approval. Current production sends text reviews; preview photos do not establish implementation.

## Executed evidence

The map check passed 17 pages, 175 inventory entries, 235 source/test references, 12 Telegram commands, 43 metric keys, and all 51 existing approval criteria. The inspected revision now matches HEAD. Doctor passed before driving and after surprising results.

The assigned component run covered 122 test files. It initially recorded 2,775 passes, ten failures, and one pending test. All ten failures belonged to OAuth tests whose local listener was denied by the sandbox. The same OAuth file passed all 47 tests with local-listener permission. Combined coverage is 2,785 passed, one pending Keychain integration test, and zero remaining failures. This is component evidence, not live provider authentication.

All 12 terminal invocations ultimately passed: single, mixed, revision, cancel, long, stale, retry, incomplete, mixed with restart, memory, data, and planning. The initial revision assertion failure remains alongside its successful redrive. Each retained run records its binary hash, revision, fictional calendar, and cleanup. Read [summary.json](summary.json) for the per-run links.

The manual setup route selected DeepSeek, Other, and `fictional-model`, reached the endpoint prompt, then cancelled. No config or authentication was saved. The separate sender route added, listed, removed, and listed fictional sender `12345`. Both used owned scratch homes and cleaned up. Read [setup evidence](setup-result.json) and [sender evidence](senders-result.json).

The coordinator reused the existing authorized real-model Telegram runtime for five bounded browser commands. `/version`, `/language` override disclosure, `/snapshot` help, and empty `/feedback` guidance passed. `/whatsnew` delivered an unable-to-fetch fallback containing the old repository name. Successful release-note retrieval remains unproved; no updater was executed. Read [browser observations](telegram-observations.json). The running process's commit was not independently established, so these observations are not attributed to the tested terminal binary hash.

## Source and live coverage by feature

Paths below are relative to the inspected worktree. Each feature received a separate read-only investigation within three batches. Existing assigned component tests ran for every row. The coordinator alone drove the app.

| Feature | Source grounding | Bounded live result and remaining gap |
|---|---|---|
| install-and-hosting | `packages/core/src/run-binary.ts:416`; `coach-home.ts:34`; `process-guard.ts:65` | Terminal cancel passed. Node 22, global installation, containers, deployment persistence, and crash lifecycle remain unproved. |
| setup-and-providers | `packages/core/src/setup.ts:296`; `runtime-config.ts:453` | PTY cancellation passed. OAuth identity, token refresh, and all provider choices need authenticated routes. |
| secrets-and-connections | `packages/core/src/secrets/resolve.ts:7`; `channels/allowed-senders.ts:398` | Fictional sender administration passed. Vault and first-pairing routes need dedicated credentials/state. |
| language | `packages/core/src/language-preference.ts:9`; `channels/telegram-language-menu.ts:11` | Current override disclosure passed. Historical preference persistence is retained; effective language switching remains unproved. |
| terminal-and-session | `packages/core/src/run-binary.ts:681`; `packages/engine/src/agent/coach-agent.ts:969` | Incomplete terminal preparation passed. Wider conversation lifecycle and Telegram restart remain unproved. |
| memory-and-recall | `packages/engine/src/sport/memory-tools.ts:66` | Memory terminal fixture passed. Real-model recall and Telegram route remain unproved. |
| athlete-data-and-review | `packages/engine/src/sport/platform-tools.ts:73` | Recorded-data terminal fixture passed. Wider grouping, missing-data interpretation, and Telegram route remain unproved. |
| planning-and-coaching | `packages/sport-cycling/src/tools.ts:77` | Planning fixture passed. Coaching judgment and eight knowledge topics need real-model cases. |
| calendar-workouts | `packages/sport-cycling/src/workout-change-set-tool.ts:190` | Mixed terminal effects passed. Device delivery requires an Intervals-linked device. |
| telegram-access-and-chat | `packages/core/src/channels/telegram.ts:632` | Current version delivery passed. Earlier mixed cancel/confirm proof remains bounded; first access, shortcuts, and resend variants need further routes. |
| sync-and-snapshot | `packages/core/src/channels/telegram.ts:829`; `packages/kernel/src/reference/metrics/registry.ts:70` | Snapshot help passed. Full sync and populated 43-metric snapshot were not driven this pass. |
| release-and-feedback | `packages/core/src/updater.ts:266`; `channels/telegram.ts:920` | Usage and fallback delivery observed. Successful update/feedback requires the assigned controlled endpoints or external setup. |
| errors-and-diagnostics | `packages/core/src/agent/error-classify.ts:79` | Component coverage only. The Telegram fixture has no live controlled-outage scenario. |
| review-and-approval | `packages/core/src/workout-change-sets/review.ts:52`; `service.ts:305` | Revision and other terminal routes passed. Chart cards are accepted prototype checks only. |
| restrictions | `packages/core/src/workout-change-sets/calendar.ts:62`; `service.ts:557` | Eligible mixed route passed. Invalid/concurrent conditions have service coverage, not a fresh Telegram drive. |
| changed-workouts | `packages/core/src/workout-change-sets/calendar.ts:31`; `service.ts:624` | Terminal stale route passed. Telegram runner cannot inject the external change. |
| recovery | `packages/core/src/workout-change-sets/service.ts:163`; `store.ts:40` | Terminal retry and restart passed. Telegram runner cannot preserve its scratch home across restart. |

## Blockers

The existing Telegram fixture forces English, preauthorizes the sender, and deletes its home on exit. It cannot prove effective locale changes, first pairing, or persistent restart. Controlled delivery failures and populated coaching/sync scenarios are missing from that executor. The operator requires real OpenRouter replies in the current shared bot; this pass did not replace its poller with scripted replies. No required external credentials were requested again.

Hosting, vault, authentication lifecycle, and connected-device checks need their own accounts, platform, or device state. These are recorded as blocked or not run, never as verified-unreachable without an attempted route. Existing component tests do not substitute for those live checks.

## Cleanup and privacy

All 13 terminal runs, including the failed assertion and redrive, retained evidence and reported no live owned child, scratch removal, and zero listeners. Manual setup and sender processes exited and their exact owned scratch homes were removed. The coordinator created no Telegram poller, browser profile, or listener. The pre-existing real bot, its data, and prototype server remain with their original owner.

The repository privacy checker passed 4,080 source files and 21 golden fixtures after local IPC permission was granted. Retained fictional evidence was scanned separately. Sender audit timestamps are replaced with `<runtime-timestamp>`. A static example date copied into coaching prompts was shifted from 2026 to 1998 in retained copies only; raw temporary evidence remains unchanged. Verification dates and source revision metadata retain their factual values. No evidence was uploaded.
