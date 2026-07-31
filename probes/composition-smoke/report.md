# Composition smoke probe — report A (TEMPLATE)

This is the committed template. Every metric value is the literal `PENDING`. The
operator regenerates it with `pnpm probe:composition --phase=report` after the real
run phases complete. A template-only file must never merge; the pull request stays
a draft until the run outputs replace these placeholders.

- Run date: PENDING
- Git SHA: PENDING
- Judge model (pinned): PENDING
- Frozen-now: PENDING
- Floor models: PENDING
- Suite composition: PENDING

## Scope limits

This is a smoke test with abort-only power: it can abort the one-agent composition
premise but never confirm it. The load-bearing gate re-runs the same suite at a far
larger sample on the real composition later.

Partial-coverage caveat: the mock covers the critical-speed / critical-swim-pace
confusion traps and the integrated multisport turns only partially by construction —
the swim core is fully synthetic and the multisport orchestration content is minimal —
which is exactly why this run is a smoke test with abort-only power.

Domain-review exemption: the mock coaching content is probe-only scaffolding, never
shipped and never athlete-facing, so it is exempt from the athlete-facing
domain-review gate.

## Method

Scoring order: deterministic needles first, the pinned judge second (offline, one turn
at a time), the operator spot-check third. The mechanical verdict computes on the raw
mixing rate only; the spot-check-adjusted rate is operator-decision input and never
moves the verdict line.

## M1 — voice / physiology mixing rate (abort class, threshold 5%)

- Per floor model: RAW rate PENDING, spot-check-adjusted rate PENDING, single-sport-bleed
  vs integrated breakdown PENDING, PASS/FAIL PENDING.

## M2 — tool-choice accuracy (advisory class, threshold 80%)

- Per floor model: accuracy PENDING, per-scenario chosen-vs-expected PENDING, PASS/FAIL PENDING.

## M3 — deep-protocol recall (advisory class, threshold 5/6)

- Per floor model: hits/6 PENDING, per-scenario call log PENDING, PASS/FAIL PENDING.

## M4 — token counts

- Stable prefix (tools + block 1): PENDING (design budget / rework class, budget 15000).
- Whole prompt: PENDING (abort class, max 50000).
- Informational per-model first-turn input tokens: PENDING.

## Combined-load caveats

- Per floor model: caveat-thresholds and caveat-cost presence PENDING.

## Verdict

The verdict is mechanical and computes on the raw mixing rate; the operator, not the
executor, acts on it.

PENDING

## Redaction totals

- Total model-emitted trademark tokens redacted across all transcripts: PENDING.

## Spot-check

- Spot-check rows recorded: PENDING. See spot-check.md for the full record.

## How to run (operator, Phase O)

Requires `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` in the environment.

1. `pnpm probe:composition --phase=tokens`
2. `pnpm probe:composition --phase=run --model=claude-haiku-4-5-20251001` then `--phase=judge --model=claude-haiku-4-5-20251001`
3. Repeat step 2 for `qwen/qwen3.5-plus` and `deepseek/deepseek-v4-flash`
4. Fill `spot-check.md`
5. `pnpm probe:composition --phase=scan`
6. `pnpm probe:composition --phase=report`
