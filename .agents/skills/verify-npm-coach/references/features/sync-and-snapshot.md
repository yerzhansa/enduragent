# Training synchronization and diagnostic snapshots

## Sub-features

| Inventory ID | Capability |
|---|---|
| N21 | Startup training refresh and ongoing refresh lifecycle. |
| C31 | Get qualitative guidance with an explicit stale-data disclosure when the last Reference sync failed a blocking validation gate. |
| T12 | Refresh training data |
| T22 | Get hidden snapshot help |
| T23 | Export a full data snapshot |
| T24 | Export a selected snapshot section |
| T25 | Recover snapshot delivery |
| M01 | Acute-to-chronic workload ratio (`acwr`) |
| M02 | Training monotony (`monotony`) |
| M03 | Primary-sport monotony (`primary_sport_monotony`) |
| M04 | Effective monotony (`effective_monotony`) |
| M05 | Monotony interpretation (`monotony_interpretation`) |
| M06 | Multisport detection (`multi_sport_detected`) |
| M07 | Training strain (`strain`) |
| M08 | Recovery index (`recovery_index`) |
| M09 | Stress tolerance (`stress_tolerance`) |
| M10 | Load-to-recovery ratio (`load_recovery_ratio`) |
| M11 | Seven-day zone distribution (`zone_distribution_7d`) |
| M12 | Moderate-intensity percentage (`grey_zone_percentage`) |
| M13 | Moderate-intensity interpretation (`grey_zone_note`) |
| M14 | Quality-intensity percentage (`quality_intensity_percentage`) |
| M15 | Quality-intensity interpretation (`quality_intensity_note`) |
| M16 | Easy-time ratio (`easy_time_ratio`) |
| M17 | Easy-time interpretation (`easy_time_ratio_note`) |
| M18 | Seven-day training-intensity distribution (`seiler_tid_7d`) |
| M19 | Seven-day primary-sport intensity distribution (`seiler_tid_7d_primary`) |
| M20 | Twenty-eight-day training-intensity distribution (`seiler_tid_28d`) |
| M21 | Twenty-eight-day primary-sport intensity distribution (`seiler_tid_28d_primary`) |
| M22 | Training consistency (`consistency_index`) |
| M23 | Consistency detail (`consistency_details`) |
| M24 | Seasonal context (`seasonal_context`) |
| M25 | Indoor benchmark (`benchmark_indoor`) |
| M26 | Outdoor benchmark (`benchmark_outdoor`) |
| M27 | Interval-session detection (`has_intervals`) |
| M28 | Effort-response signal (`effort_response_signal`) |
| M29 | Weight trend signal (`weight_signal`) |
| M30 | Durability (`capability.durability`) |
| M31 | Efficiency factor (`capability.efficiency_factor`) |
| M32 | Heart-rate recovery (`capability.hrrc`) |
| M33 | Training-intensity-distribution comparison (`capability.tid_comparison`) |
| M34 | Power-curve change (`capability.power_curve_delta`) |
| M35 | Heart-rate-curve change (`capability.hr_curve_delta`) |
| M36 | Sustainability profile (`capability.sustainability_profile`) |
| M37 | DFA alpha-1 profile (`capability.dfa_a1_profile`) |
| M38 | Estimated FTP (`eftp`) |
| M39 | W-prime (`w_prime`) |
| M40 | W-prime in kilojoules (`w_prime_kj`) |
| M41 | Maximum power (`p_max`) |
| M42 | Power-model source (`power_model_source`) |
| M43 | VO2max (`vo2max`) |

Source inspected at `3d6ecf78`. Current entry points are:

- [packages/core/src/reference/runtime.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/reference/runtime.ts).
- [packages/core/src/reference/sync/run-sync.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/reference/sync/run-sync.ts).
- [packages/core/src/reference/sync/format-sync-reply.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/reference/sync/format-sync-reply.ts).
- [packages/core/src/reference/sync/snapshot-debug.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/reference/sync/snapshot-debug.ts).
- [packages/kernel/src/reference/metrics/registry.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/kernel/src/reference/metrics/registry.ts).
- [packages/core/src/reference/sync/fetch-reference-data.ts](/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval/packages/core/src/reference/sync/fetch-reference-data.ts).

## How to get to it (user POV)

Startup and the scheduler refresh data. Telegram `/sync` explicitly refreshes. `/snapshot` gives help; the primary operator can use `/snapshot raw` or one of seven section names.

## Driving it with npm-coach verification

Run the parent skill's prepare and doctor before driving the built application. Existing component and service coverage uses:

```sh
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
caffeinate -i pnpm exec vitest run packages/core/tests/reference-runtime.test.ts packages/core/tests/reference-scheduler.test.ts packages/core/tests/reference-run-sync.test.ts packages/core/tests/reference-sync-gate.test.ts packages/core/tests/reference-format-sync-reply.test.ts packages/core/tests/reference-snapshot-debug.test.ts packages/core/tests/reference-send-snapshot.test.ts packages/core/tests/reference-compute-derived-metrics.test.ts packages/core/tests/reference-parity.test.ts packages/core/tests/reference-fetch-live-bundle.test.ts packages/core/tests/npm-telegram-host.test.ts packages/engine/tests/coach-agent-block-coaching.test.ts
```

These tests retain ownership of their synthetic fixtures and controlled failures. They do not establish a live provider, authenticated external service, or browser result.

With dedicated Telegram prerequisites and doctor, launch:

```sh
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed
```

After `/version`, send `/sync`, `/snapshot`, and `/snapshot raw metadata`. Capture sync outcome, help, and metadata. Compare metadata to the owned home's `data/latest.json` before cleanup. Derive that home from the launcher's printed calendar path; scrub the path from retained UI evidence.

## Gotchas

The fixture proves commands and metadata, not populated metric values or rich document fallback. Metrics M34/M35/M36 lack live curve inputs. Forty-three registry keys do not mean 43 working analyses or prompt injection. Twenty oracle-only fields are not live outputs. current_status and separate history/intervals/routes/FTP-history caches are empty in this producer. The seven named sections exclude derived_metrics_meta and source_provenance, which appear only in the full dump. /sync does not publish workouts.

Retain source revision, executor, action, observed result, and read-only persistence proof separately. After a runner-owned launch, require an empty `cleanup.livePids`, `cleanup.scratchRemoved: true`, no owned listener, and retained evidence. For a manually created fixture, record its exact owned path and processes before launch, stop only those processes, retain sanitized evidence, and remove only that scratch state. Use isolated athlete storage and the parent skill's authorization and ownership rules for any bot or browser.
