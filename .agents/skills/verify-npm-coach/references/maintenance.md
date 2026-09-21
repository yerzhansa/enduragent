# npm coach verification maintenance

Historical report for the revision below. Read [the latest maintenance report](maintenance/latest.md) for current scope and status.

Status: changed.

Audited the single `verify-npm-coach` skill against product commit `24e46acaccb13d60b4b6f434452470c6b8e49f1b` on macOS with Node 24. Product source and tests were not changed. No PR was created because this maintenance invocation did not request PR delivery.

## Source coverage

Four separate read-only investigations covered the four indexed features. The index has no missing, duplicate, extra, or dead feature pages. Acceptance ranges remain A01–A18, B01–B13, C01–C08, and D01–D12.

| Feature | Grounding in the inspected checkout | Executed coverage |
| --- | --- | --- |
| Review and approval | `packages/core/src/workout-change-sets/service.ts:305`; `packages/core/tests/workout-change-sets.test.ts:169`; `packages/core/tests/workout-change-set-review.test.ts:114`; `packages/sport-cycling/src/intervals-serializer.ts:219` | Focused tests; single, mixed, revision, cancel, long, incomplete terminal runs |
| Restrictions | `packages/core/src/workout-change-sets/calendar.ts:64`; `packages/core/src/workout-change-sets/service.ts:559`; `packages/core/tests/workout-change-sets.test.ts:844` | Service/protection/channel tests; mixed terminal run |
| Changed workouts | `packages/core/src/workout-change-sets/service.ts:130`; `packages/core/tests/workout-change-sets.test.ts:886` and `:905` | Service/protection/review tests; stale terminal run |
| Recovery | `packages/core/src/run-binary.ts:688`; `packages/core/src/channels/telegram.ts:1156`; `packages/core/tests/telegram-dispatch.test.ts:847` | Service/channel tests; retry and mixed-restart terminal runs |

## Verified corrections

- Added the existing targeted-revision, readable-step, repeat-boundary, state-specific approval-copy, and cold-cache resend coverage to the feature pages.
- Corrected stale source references and the C08 mapping. The protection test verifies no writes and refreshed data, but does not retry the old token.
- Strengthened the owned terminal runner to require `duration: 60 min → 90 min.` and `No changes were applied.` in the stale response. The updated stale run passed.
- Removed the scripted fixture’s hardcoded four-workout count. Before correction, the single scenario said four changes while its actual review contained one addition. After correction, every terminal scenario passed.
- Documented the existing `--authorized-existing-dev-bot` mode and its explicit-session-authorization requirement. Its read-only doctor passed using the previously authorized configuration.
- Corrected the Telegram composer guidance. A fresh `/k/` DOM inspection found a contenteditable div and a separate fake mirror, without the assumed textbox role/name. Sending `/version` through the documented non-fake composer returned `Cycling Coach v2026.5.9`.
- Clarified that doctor verifies credential ownership, identity, and webhook state, but cannot prove exclusive polling or browser authentication.
- Added a real-provider repeat-boundary recipe without treating fixture durations as parser evidence.

## Execution evidence

The initial doctor refused an output older than the English catalog touched by localization extraction. The prescribed npm rebuild completed, then doctor passed before driving.

The focused command passed 324 tests in nine files covering service, protection, review, channel, Telegram dispatch, Engine preparation, cycling preparation, and both sport serializers. The final repository privacy check passed for 4078 source files and 21 golden fixtures after granting tsx its required local IPC access.

Final terminal evidence is under `/var/folders/96/qtgfv71s5s9433nr3kzn66wr0000gn/T/enduragent-verify-npm/`. Each directory contains `result.json`, `transcript.txt`, and `calendar.json`:

| Scenario | Evidence directory | Result |
| --- | --- | --- |
| single | `terminal-hf7KLk` | PASS |
| mixed | `terminal-TzRnXm` | PASS |
| revision | `terminal-TOhFJB` | PASS |
| cancel | `terminal-AtM1Kk` | PASS |
| long | `terminal-hxlDLW` | PASS |
| stale | `terminal-waOsAK` | PASS |
| retry | `terminal-yIXmJA` | PASS |
| incomplete | `terminal-YqKx0a` | PASS |
| mixed with restart | `terminal-njdiq1` | PASS |

The strengthened stale assertion also passed in `terminal-vEDRaf` before the fixture prose correction. The preceding single-scenario failure in fixture wording remains visible in `terminal-adsAld/transcript.txt`; its scenario assertions passed but its prose incorrectly said four changes.

An intentional SIGINT produced an expected `FAIL` result while retaining evidence at `/tmp/enduragent-verify-npm/terminal-AGdU6Z`. Its cleanup showed no live owned PIDs, removed scratch state, and zero opened listeners. This is a cleanup proof, not a product failure.

## Cleanup and limits

Every retained terminal result confirms empty `cleanup.livePids`, `scratchRemoved: true`, and `listenersOpened: 0`. The maintenance-owned Telegram tab was closed. No browser profile was created. The pre-existing guarded real bot and operator-supplied credentials were preserved because they are outside this maintenance runner’s ownership.

This pass exercised each mapped feature through its assigned terminal/service executor. Telegram doctor and composer/message delivery were checked live; no new Telegram approval, fault injection, or real-calendar write was performed in this maintenance pass. Earlier real-provider evidence remains linked from the feature index. The full fixture-launcher Telegram UI path and the complete 51-criterion live acceptance matrix remain unverified.

The product’s separately recorded description-only edit preview mismatch remains open. Maintenance did not change or hide it. The prior product correction-cycle count remains ten.
