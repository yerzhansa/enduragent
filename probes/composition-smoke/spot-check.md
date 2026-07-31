# Operator spot-check record

The operator fills this file at run time. The executor commits only this template;
the executor never writes verdict rows.

## What to record

For at least 10% of the flagged turns (minimum 3; all of them if fewer than 3 are
flagged; if zero are flagged, pick 3 c7 turns as calibration), add one data row each
to the table below, then add the dated sign-off line.

## Cell rules (machine-parsed — deviation breaks the render, by design)

- `scenarioId` — an existing scenario id from the suite.
- `model` — one of the three pinned floor-model slugs.
- `flagSource` — exactly `needle` or `judge`.
- `verdict` — exactly one token, either the confirm token or the overturn token
  (written here hyphenated as CONFIRM-or-OVERTURN so the row count stays exact; use the
  bare token in the table only).
- `reason` — one non-empty line.

Cells are delimited by space-pipe-space (` | `); each row starts with `| ` and ends
with ` |`. The renderer trims cell whitespace but refuses any malformed row (wrong
column count, unknown scenarioId or model slug, a disallowed flagSource or verdict
token, or an empty reason).

An overturn never moves the mechanical verdict — the verdict computes on the raw mixing
rate. The report renders the spot-check-adjusted rate alongside as operator-decision
input only.

| scenarioId | model | flagSource | verdict | reason |
|---|---|---|---|---|

Spot-check performed by the operator, YYYY-MM-DD
