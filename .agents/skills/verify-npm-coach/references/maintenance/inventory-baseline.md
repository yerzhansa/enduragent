# Full npm and Telegram feature-map maintenance

Status: **blocked**. The map expansion is complete; a full live maintenance pass is not.

The [coaching fixture extension](coaching-extension/README.md) adds passing live terminal routes for memory, recorded-data reads, and planning at a newer revision. The results and missing-fixture statements below describe the earlier inventory pass.

The [Telegram extension](telegram-extension/README.md) proves authenticated message delivery, mixed-batch cancel and confirm, and language preference persistence using the existing authorized bot. Token discovery and browser access are resolved; complete live coverage remains blocked by the remaining fixture and scenario gaps. Read [the access guide](../telegram-access.md) before asking for credentials again.

The selected target is `verify-npm-coach`. The generic maintenance skill and product source/tests were not changed. No PR was created. Source investigations inspected 17 feature groups at `24e46acaccb13d60b4b6f434452470c6b8e49f1b`. The source inventory remains the migration baseline; desktop and iOS parity have not been verified.

## Included scope

All 175 inventory IDs have exactly one owning page: 124 feature/behavior entries, eight coaching knowledge topics, and 43 diagnostic metrics. Existing 51 workout-approval criteria and executors remain intact. Each page contains capabilities, source entry points, user route, existing component-test commands, a bounded live recipe, and limits. The manifest and read-only checker make omissions and duplicate mappings fail.

Source corrections distinguish six calculate_zones output rows from knowledge-zone numbering, the current no-expiry batch workflow from the older ten-minute proposal, and the fixed repeat-duration issue from the separate description-only preview discrepancy. Earlier reports retain their original scopes.

## Verification performed

The map check passed 17 pages, 175 IDs, 235 source/test references, 12 Telegram commands, 43 metric keys, and 51 approval criteria. Deliberately missing and duplicate IDs were rejected. See [map-check.json](map-check.json).

The 122-file component/service run initially recorded 2,772 passed, ten failed, and one pending out of 2,783 tests. All failures belonged to OAuth tests whose localhost listener was denied by the sandbox. Rerunning that file with local listener permission passed all 47 cases. Combined coverage after this rerun is 2,782 passed, one pending Keychain integration case, zero remaining failures. This is component/service evidence, not live external authentication.

All nine existing built-terminal invocations passed: single, mixed, revision, cancel, long, stale, retry, incomplete, and mixed with restart. The retained per-run transcript, fictional calendar, binary hash, revision, and cleanup results are linked through [summary.json](summary.json). Each result records no live owned child, scratch removal, and zero listeners opened. Existing runners were preserved.

The repository privacy scan passed 4,078 source files and 21 golden fixtures. The package command was blocked by the sandbox's tsx IPC restriction; its same TypeScript checker passed through `node --import tsx tools/check-fixture-privacy.ts`. A separate scan of ignored map files and retained fictional evidence found no athlete-ID or credential patterns; all local links resolved. Skill-format validation passed.

## Live coverage by feature group

All rows received read-only source investigation and existing component/service-test coverage. Partial means that a real built terminal route passed, while the page's wider capabilities remain unproved.

| Feature page | Live result |
|---|---|
| [install-and-hosting](../features/install-and-hosting.md) | Partial built-terminal coverage; cancel |
| [setup-and-providers](../features/setup-and-providers.md) | Blocked live coverage; recipe and prerequisites recorded |
| [secrets-and-connections](../features/secrets-and-connections.md) | Blocked live coverage; recipe and prerequisites recorded |
| [language](../features/language.md) | Blocked live coverage; recipe and prerequisites recorded |
| [terminal-and-session](../features/terminal-and-session.md) | Partial built-terminal coverage; incomplete |
| [memory-and-recall](../features/memory-and-recall.md) | Blocked live coverage; recipe and prerequisites recorded |
| [athlete-data-and-review](../features/athlete-data-and-review.md) | Blocked live coverage; recipe and prerequisites recorded |
| [planning-and-coaching](../features/planning-and-coaching.md) | Blocked live coverage; recipe and prerequisites recorded |
| [calendar-workouts](../features/calendar-workouts.md) | Partial built-terminal coverage; mixed |
| [telegram-access-and-chat](../features/telegram-access-and-chat.md) | Blocked live coverage; recipe and prerequisites recorded |
| [sync-and-snapshot](../features/sync-and-snapshot.md) | Blocked live coverage; recipe and prerequisites recorded |
| [release-and-feedback](../features/release-and-feedback.md) | Blocked live coverage; recipe and prerequisites recorded |
| [errors-and-diagnostics](../features/errors-and-diagnostics.md) | Blocked live coverage; recipe and prerequisites recorded |
| [review-and-approval](../features/review-and-approval.md) | Partial built-terminal coverage; revision |
| [restrictions](../features/restrictions.md) | Partial built-terminal coverage; mixed |
| [changed-workouts](../features/changed-workouts.md) | Partial built-terminal coverage; stale |
| [recovery](../features/recovery.md) | Partial built-terminal coverage; retry |

## Remaining prerequisites and runner gaps

The Telegram doctor was attempted and stopped because `NPM_VERIFY_TELEGRAM_CONFIG` was unset. No Telegram child, browser, or profile was created. A dedicated bot configuration, authenticated isolated browser, and exclusive poller ownership are required for that route. Existing development resources require explicit session authorization under the parent skill; earlier report evidence does not grant it.

The provider fixture recognizes workout scenarios only. Memory/recall, recorded-activity review, planning, knowledge application, and populated metric snapshots need additional fictional provider/data scenarios. Locale switching needs removal of the forced English override; first pairing needs a non-preauthorized route; Telegram recovery needs restart-preserving storage and controlled failures. Successful release update/feedback, real providers/vaults, deployment persistence, and device delivery require their own prerequisites and executors. Do not treat mocked dispatch tests or startup as live proof.

The bounded setup/cancel route was documented but not driven. An optional sender-administration drive was rejected before execution by the local destructive-command hook because its cleanup used recursive deletion. No temporary sender fixture was created. That route remains not run; no bypass was attempted.

## Next pass

Use the feature index to choose an affected group. Run the map checker and doctor, execute its existing tests and supported live route, and retain evidence separately. To finish full coverage, add the missing isolated fixture routes within this skill's ownership, then run each remaining group. Desktop and iOS migration can use these same stable inventory IDs for later parity tracking; this pass makes no native-app parity claim.
