# Restrictions and approval validity

Source inspected at `3d6ecf78`.

## Sub-features

Inventory mapping for this page follows. Existing acceptance IDs remain authoritative.

| Inventory ID | Capability |
|---|---|
| W17 | Restrict edits and deletions to eligible workouts |
| W18 | Protect past dates |
| W19 | Edit each supported field |
| W20 | Recheck the whole set before writing |
| W21 | Reject inactive or foreign controls |
| W22 | Apply duplicate approvals at most once |
| W23 | Avoid unsupported completion assumptions |

Refer to acceptance B01–B13 for required behavior.

| Acceptance IDs | Existing test entry |
|---|---|
| B01–B03 | Service parameterized test `refuses ineligible edit and deletion proposals before offering approval` |
| B04 | `allows editing today's coach workout and deleting a future coach workout` |
| B05 | `refuses invalid dates, past moves, and duplicate targets during preparation` |
| B06 | Sport test `prepares mixed additions, every supported edit field, and deletion in original order`; service test `recovers a lost update response by observing its exact desired state` checks the resulting complete edit |
| B07 | `enforces guards across the full set` |
| B08 | `blocks the first valid addition when the final target becomes past` |
| B09 | `cancels and replaces approval without writes`, `requires delivery acknowledgement and preserves approval across unrelated turns` for an unrelated chat, and `retains the completed outcome on restart without reusing its old approval` |
| B10 | Protection test `rejects duplicate calendar effects for concurrent repeated approval` |
| B11 | `reviews the complete mixed set and applies exact commands once`; inspect frozen preparation and saved record execution as complementary evidence |
| B12–B13 | `does not add an activity-pairing restriction` with absent and present pairing |

Source entry points are `packages/core/src/workout-change-sets/calendar.ts:43` (snapshot), `calendar.ts:62` (eligibility), the approval service `service.ts`, and `packages/sport-cycling/src/workout-change-set-tool.ts`. Terminal controls are parsed by `packages/core/src/channels/workout-approval.ts:75`; Telegram callbacks by that file's `parseWorkoutCallback`.

## How to get to it (user POV)

Request edits or deletions in ordinary terminal or isolated Telegram chat, review any eligible proposal, and approve using the offered terminal command or Telegram **Confirm** control. Use only fictional coach-created and non-coach fixtures. Keep invalid target cases in the existing service executor until the channel fixture can safely seed them; do not try them against real athlete history.

## Driving it with npm-coach verification

```bash
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
pnpm exec vitest run packages/core/tests/workout-change-sets.test.ts packages/core/tests/workout-change-set-protection.test.ts packages/core/tests/workout-approval-channel.test.ts packages/sport-cycling/tests/workout-change-set-tool.test.ts
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

The test files own the invalid provenance/category/date, activity pairing, and concurrent-approval fixtures. Read their outbound mutation assertions and final fictional calendar state; zero writes must include the earlier valid addition when a later target is invalid. The terminal `mixed` scenario complements those tests with actual approval input and read-back of reviewed edits/deletion. It does not exercise all B criteria by itself.

In an isolated Telegram UI run, record the ordinary request and offered or refused control, then check the synthetic calendar in a second read-only view. Exercise stale or duplicate controls only within the test bot's newly created conversation. The managed Telegram launcher supports fixture-backed runtime setup, not browser or concurrency driving; preserve Vitest ownership and mark unsupported channel cases honestly.

Retain the run’s `result.json`, `transcript.txt`, and `calendar.json` under the unique evidence directory described in the [index](README.md). Record this feature’s criterion IDs alongside the results; do not infer a pass for unmapped or undriven cases.

## Gotchas

The mixed terminal scenario proves valid mutations and preservation only. Current live fixtures do not expose invalid-provenance, date, or concurrency controls. Those live variants remain blocked; do not mutate real athlete workouts to reach them.

Whole-set validation must finish before any write, including when the invalid target appears last. Retain separate service assertions for account, provenance, category, date, tokens, concurrency and activity pairing.

The guard uses the controlled athlete-local date, not the browser's calendar. The fixture clock is `1998-09-07`. A linked activity is not a completion rule. Replaced, canceled, consumed, and unrelated-chat tokens need separate assertions; do not infer all from a successful cancellation. Never extract tokens or real athlete identifiers into retained logs. Use fictional fixtures for invalid-target and concurrency cases. The parent skill governs separately authorized real Telegram checks; this page grants no broader access. Telegram on macOS is sufficient once isolation prerequisites are met.

### Approval-copy coverage

For B09, include `does not direct an invalid approval to a current proposal when it is %s` in `packages/core/tests/workout-change-sets.test.ts:1184`. Missing, canceled, and completed proposals say `This approval is no longer active.` A replaced approval with an actionable current proposal says `The previous approval is no longer active. Review the current proposal.` The state distinction is in `packages/core/src/workout-change-sets/service.ts:592`. Preserve both cases; neither control may write.
