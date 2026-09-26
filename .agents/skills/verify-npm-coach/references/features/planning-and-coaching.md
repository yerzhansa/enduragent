# Coaching, zones, feasibility, and plan drafts

## Sub-features

| Inventory ID | Capability |
|---|---|
| C01 | Ask cycling training questions and receive personalized conversation based on stored facts, goals, schedule, preferences, profile, and current plan. |
| C16 | Calculate six displayed FTP-based power ranges: Z1, Z2, Z3, Sweet Spot, Z4 and Z5. |
| C17 | Assess a target FTP or W/kg against current FTP, body weight and experience level. |
| C18 | Request a periodized training-plan draft for a race or general goal, with experience, FTP, weight, low/medium/high volume, fixed/flexible schedule, available days, key-session day and session count. Race kinds include century, gran fondo, criterium, time trial and other. |
| C19 | Receive computed model choice, phases, build/recovery cycle structure, phase volume targets, zone tables, testing protocols, taper, total volume and schedule preferences as the plan result. The draft is not saved automatically. |
| C20 | Request a sample training week by volume tier, fixed/flexible schedule, available days, key day and 3-6 sessions. |
| C22 | Design a requested cycling workout in conversation, adapting workout type, structure, progressive overload, cadence and indoor/outdoor context. |
| C30 | Get numbered choices for material coaching decisions and answer conversationally. No Telegram/CLI decision panel is available. |
| K01 | zone-reference.md: teaches Z1 recovery, Z2 endurance, Z3 tempo, sweet spot, Z4 threshold, Z5 VO2max, Z6 anaerobic and Z7 neuromuscular effort; FTP-percent conventions, RPE/feel and secondary LTHR comparisons. |
| K02 | workout-design.md: provides eight workout families, warmup/main/cooldown structure, cadence guidance, duration/set/intensity/recovery progression, and indoor/ERG versus outdoor contexts. |
| K03 | periodization.md: explains linear, block, reverse-linear, polarized and pyramidal models; deterministic model selection, phase emphasis, volume distribution and build/recovery progression. |
| K04 | race-prep.md: covers race-type taper, volume reduction with intensity retention, race-week sequencing, openers, warmup, conservative starting effort, equipment/logistics reminders, pre-race food and during-race fueling/hydration. |
| K05 | recovery.md: covers overload/overtraining warning signs from data and reported feel, recovery/rest substitutions, active recovery, deload weeks, sleep/stress/travel impact and illness/pain handling. The current-message explicit-request prescription restriction still applies. |
| K06 | review.md: defines recorded activity and lap evidence, multisport/transition handling, numeric summary/lap tables and bounded deep-review stream observations. |
| K07 | intervals-icu.md: explains Fitness, Fatigue, Form, Load, Intensity, weighted average power, variability, power-curve duration interpretation and athlete strengths, weight/HRV/resting-HR/sleep trends, calendar serialization and connected-head-unit delivery. Power-curve explanation is knowledge; there is no chat power-curve-fetch tool. |
| K08 | prescription-posture.md: makes autonomous cycling workout proposals unavailable. A workout/plan or change needs an explicit request in the current message. A request for prose does not authorize calendar creation. Profile, fatigue, goals, analysis and status alone do not authorize a prescription. |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/sport-cycling/src/tools.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/src/tools.ts).
- [packages/sport-cycling/src/plan-builder.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/src/plan-builder.ts).
- [packages/sport-cycling/src/sport.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/src/sport.ts).
- [packages/engine/src/agent/coach-decision-tool.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/engine/src/agent/coach-decision-tool.ts).
- [packages/sport-cycling/skills/prescription-posture.md](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/sport-cycling/skills/prescription-posture.md).

## How to get to it (user POV)

Ask for zones, target FTP/W/kg feasibility, a plan draft, sample week, or a cycling workout in the current message. Telegram `/plan` and `/workout` are shortcuts. Numbered choices use conversational fallback.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/sport-cycling/tests/zones.test.ts packages/sport-cycling/tests/feasibility.test.ts packages/sport-cycling/tests/periodization.test.ts packages/sport-cycling/tests/plan-builder.test.ts packages/sport-cycling/tests/templates.test.ts packages/sport-cycling/tests/tools.test.ts packages/sport-cycling/tests/prescription-posture.test.ts packages/sport-cycling/tests/skill-keyspace.test.ts packages/sport-cycling/tests/skill-constant-dedup.test.ts packages/engine/tests/coach-decision-channel-scope.test.ts packages/engine/tests/system-prompt-review-rules.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

Run the built-terminal planning fixture:

```sh
caffeinate -i node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/coaching-terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=planning
```

This requests zones at fictional FTP 280, target feasibility, a sample week, and a plan draft. It verifies six actual zone rows and real plan-builder output. Drafting must not create a saved plan or calendar write. The fixture submits the complete returned plan with an explicitly requested display name. The runner declines its first `y/N` confirmation, verifies no save, then confirms the second with `y`. The saved object must preserve every other draft field. It restarts the process and loads the plan from the same isolated home. This is distinct from workout-set `approve`.

Read [the coaching fixture report](../maintenance/coaching-extension/README.md) for evidence. Knowledge application and real-model planning quality remain outside this fixture's proof.

## Gotchas

Corrected inventory detail: calculate_zones returns six display rows, not seven. The knowledge contains seven-zone numbering and Sweet Spot, but that is not the tool result shape. No individual chat proves all eight knowledge topics or clinical/scientific correctness. No autonomous workout prescription follows merely from a status or profile request.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
