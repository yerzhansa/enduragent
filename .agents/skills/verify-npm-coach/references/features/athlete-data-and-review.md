# Athlete data and recorded-session review

## Sub-features

| Inventory ID | Capability |
|---|---|
| C07 | Read athlete physiology, body profile, cycling settings, power and heart-rate zones, indoor FTP, W-prime and maximum power when returned by intervals.icu. |
| C08 | Review wellness history including Fitness, Fatigue, calculated Form, ramp rate, weight, resting HR, HRV, sleep duration/score/quality, readiness, soreness, stress, mood, motivation, injury and reported fatigue when available. |
| C09 | Have the current athlete profile and latest available wellness in the last seven days supplied automatically to each coaching turn. Missing/failed reads degrade to a fetch-before-prescription prompt. |
| C10 | List recorded activities in a date range. Platform summaries include title, sport, local start, duration, distance, Load, Intensity, average/weighted power, average/max HR, FTP and elevation where present. |
| C11 | Inspect a selected recorded activity, including detail and lap data actually returned by the data source. |
| C12 | Request a deeper recorded-activity review using per-channel sample count, minimum, maximum and mean for power, HR, cadence, time and altitude; custom channel names are accepted. The tool does not return the time series itself. |
| C13 | Review latest or named/date-scoped sessions at brief/summary, default, or explicit deep/in-depth levels. Empty, old, ambiguous and unavailable activity data have dedicated handling. |
| C14 | Review grouped multi-activity/multisport sessions and transitions in sequence; select one leg for detail while disclosing undetailed legs. Group by workout ID when supplied or infer 30-minute proximity when absent. |
| C15 | Ask for numeric review follow-up with available summary, lap and deep-review stream tables. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/engine/src/sport/platform-tools.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/sport/platform-tools.ts).
- [packages/engine/src/sport/list-projection.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/sport/list-projection.ts).
- [packages/engine/src/agent/athlete-snapshot.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/athlete-snapshot.ts).
- [packages/engine/src/agent/system-prompt.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/system-prompt.ts).
- [packages/sport-cycling/skills/review.md](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/skills/review.md).

## How to get to it (user POV)

Ask for profile, wellness, activities, or `/review` with brief/default/deep scope. Ask `show numbers` for numeric follow-up. Grouped activities and transitions have separate evidence boundaries.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/athlete-data-tools.test.ts packages/engine/tests/athlete-snapshot.test.ts packages/engine/tests/athlete-snapshot-wiring.test.ts packages/engine/tests/intervals-tools-fetch-activity.test.ts packages/engine/tests/intervals-tools-fetch-streams.test.ts packages/engine/tests/intervals-tools-list-projection.test.ts packages/engine/tests/intervals-tools-range-cap.test.ts packages/engine/tests/system-prompt-review-rules.test.ts packages/sport-cycling/tests/review-canonical-guidance.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

Run the built-terminal athlete-data fixture:

```sh
caffeinate -i node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=data
```

This asks for profile/wellness, a brief recorded-activity review, a deep review with laps and streams, and a numeric follow-up. The real tools return fictional provider data and compute stream sample count, minimum, maximum, and mean. The runner compares these results against independent constants and checks zero calendar writes. The scripted reply displays actual tool results for synchronization. It does not prove free-form coaching interpretation, activity grouping, Telegram slash-command expansion, or numeric table presentation.

Read [the coaching fixture report](../maintenance/coaching-extension/README.md) for evidence.

## Gotchas

Stream tools return count/minimum/maximum/mean, not the raw time series. Tests cover bounded projections, absent/ambiguous data, timeout and factual fallback. Those tests do not prove the full chat path or live intervals.icu data availability.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
