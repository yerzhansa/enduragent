# Changed workouts

Source inspected at `3d6ecf78`.

## Sub-features

Inventory mapping for this page follows. Existing acceptance IDs remain authoritative.

| Inventory ID | Capability |
|---|---|
| W24 | Detect external edits and refresh the review |
| W25 | Ignore irrelevant representation changes |
| W26 | Block missing or unverifiable targets |

Refer to acceptance C01–C08.

| Acceptance IDs | Existing scenario or test entry |
|---|---|
| C01–C04 | Terminal `stale`; service parameterized test `checks every reviewed field before even the first addition`; review test for persisted difference evidence |
| C05 | The same service test varies duration, name, description, date, training load, and structure |
| C06 | `normalizes object key order and line endings, ignores unrelated metadata` |
| C07 | `protects workouts that become past and targets that disappear` and `blocks all writes and fresh approval when a reviewed target cannot be read` |
| C08 | The stale-field service test retries the old token at `workout-change-sets.test.ts:1232`. The protection test `rejects all writes when the final reviewed target changed` supports C01/C03, not old-token replay. |

Source is `packages/core/src/workout-change-sets/calendar.ts:31` for normalization and `calendar.ts:43` for reviewed snapshots, with fresh validation in `service.ts` and differences rendered by `review.ts`. The npm terminal and Telegram both call the shared approval service through `packages/core/src/channels/workout-approval.ts`.

## How to get to it (user POV)

Request an edit or deletion and leave its approval pending. Change that same fictional target through the isolated calendar fixture, then use terminal `approve` or Telegram **Confirm**. Read the explanation and refreshed review. Approve that new review only after checking it; attempt the previous control separately within the isolated test conversation.

## Driving it with npm-coach verification

```bash
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
pnpm exec vitest run packages/core/tests/workout-change-sets.test.ts packages/core/tests/workout-change-set-protection.test.ts packages/core/tests/workout-change-set-review.test.ts
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=stale
```

The existing `stale` runner changes fictional target `101` to 90 minutes after review, approves, checks zero writes, the exact `duration: 60 min → 90 min` explanation, and a fresh review, then approves again. Preserve both phases in the transcript. Confirm independently in the retained calendar that only the refreshed approval produced the expected changes. The runner asserts the visible duration difference and no-write message for C02; inspect the retained transcript as supporting evidence.

For actual Telegram, the same controlled change requires a dedicated test bot/profile plus an independently writable synthetic-calendar fixture. After doctor, capture the original review, external fixture mutation, clicked control, no-write read-back, refreshed review, and final read-back. Use only fault controls explicitly provided by the managed Telegram fixture; if its supported scenario cannot perform this route, record that channel case as `BLOCKED`. This paragraph describes the optional fictional executor. The parent skill also permits its separately authorized real route: externally change only a campaign-owned disposable target, then require no writes and a refreshed review. Missing fixture routing is never permission to edit unrelated real workouts.

Retain the run’s `result.json`, `transcript.txt`, and `calendar.json` under the unique evidence directory described in the [index](README.md). Record this feature’s criterion IDs alongside the results; do not infer a pass for unmapped or undriven cases.

## Gotchas

Telegram --scenario=stale does not itself mutate the target. Only the terminal runner performs that fixture setup. Any manual Telegram stale setup must edit only the printed, owned fictional calendar and retain evidence. No --inject-stale option exists.

The `stale` terminal runner changes fictional event 101 from 60 to 90 minutes after review, submits the old approval, requires zero writes, then approves the refreshed review. Capture the visible before/after values as well as the result.

Only mutation targets participate in the reviewed-snapshot comparison; unrelated calendar entries are retained context. An unreadable or disappeared target must not be replaced with fabricated fresh data. Normalization cases remain owned by service tests. This verification does not establish an atomic remote transaction or prevent an external write between fresh validation and dispatch. Telegram on macOS satisfies the platform requirement; no Debian run is required.
