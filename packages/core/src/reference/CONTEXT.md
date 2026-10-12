# Reference

Reference is a port of the Reference layer's upstream protocol (MIT, v11.43). See [`NOTICE.md`](../../../../NOTICE.md) for full attribution and the list of modifications introduced during the port. NOTICE.md is the canonical attribution surface; the repo does not carry per-file header boilerplate.

Reference is the **data + sport-aware adapter substrate** that grounds coaching in verified athlete numerics. Without Reference, the agent answered training questions from whatever fragments the LLM remembered + whatever live `intervals_fetch_*` call happened to fire that turn — a fragile composition that drifted across sessions and produced different numbers for the same question depending on what slipped through compaction. Reference replaces that with a curated `latest.json` snapshot injected into every system prompt, plus `reference_read_*` tools for the LLM to ask for derived metrics by name.

The Reference layer has a split home. Portable metrics, schemas, `cs-resolution.ts`, `errors.ts`, `freshness.ts`, `preserve-tokens.ts`, `trademark-policy.ts`, three portable validation modules, and concurrency primitives are canonical in `packages/kernel/src/`. Sync, audit, I/O, runtime, paths, sport adapters, services, validation gates, and old-path compatibility shims remain in `packages/core/src/reference/`.

## Submodule layout

```
reference/
├── CONTEXT.md          (you are here)
├── index.ts            (core compatibility/public composition; registry intentionally omitted)
├── services.ts         (core-owned service aggregate)
├── runtime.ts          (core-owned bootstrap and two-phase initialization)
├── paths.ts            (core-owned athlete-home composition)
├── sport-adapter*.ts   (core-owned sport seam, dispatcher, and invariants)
├── sync/               (core-owned synchronization and scheduling)
├── audit/              (core-owned audit parsing and writing)
├── io/                 (core-owned Reference file reading)
├── validation/         (core gates plus shims for portable validation modules)
├── metrics/            (compatibility shims; canonical modules are in kernel)
└── schemas/            (compatibility shims; canonical modules are in kernel)
```

## Tool naming convention

- **`intervals_fetch_*`** — direct-from-API tools the LLM previously called per turn. Five of these (`_athlete`, `_wellness`, `_activity`, `_activities`, `_list_events`) will be **deleted once the curator takes over the data path**. `intervals_fetch_streams` is **retained** as an escape hatch for raw stream inspection (debug, edge cases the curator's projection misses).
- **`reference_read_*`** — Reference-owned tools the LLM calls to load derived metrics by name (`reference_read_history`, `reference_read_intervals`, `reference_read_routes`, etc.). All read from the cache files documented in `schemas/`.

The two prefixes are how the LLM (and a code reviewer) tells "live API call, may go stale within seconds" from "snapshot read, deterministic between syncs."

## Schema versioning + drift gate

Schema versioning is informational; **Zod-strict-as-gate is the load-bearing mechanism.** Each cache file declares its own `<FILE>_SCHEMA_VERSION` constant in `schemas/`. When a schema's shape changes:

1. Bump the `<FILE>_SCHEMA_VERSION` for that file only — never bump in lockstep with siblings (see `CONTRIBUTING.md` "Reference schema-version policy").
2. Update the schema definition.
3. The next `runSync()` writes data conforming to the new shape.
4. `safeReadJson` rejects any pre-existing cache file via the Zod `.strict()` parse — caller treats it as a cache miss and triggers a fresh sync.

There is no `migrate-v1-to-v2.ts`. The gate handles drift via discard-and-resync.

## Anti-corruption layer (per ADR-0012)

intervals.icu emits seven fields named in TP-trademarked vocabulary. Reference reads them at the I/O boundary and re-emits plain-English equivalents; the source field names never appear on the typed surface. The rename layer at `sync/rename-tp-fields.ts` is the single anti-corruption boundary for this vocabulary — downstream consumers (metric computers, curator projection, channel-side display) consume the renamed fields only.

| API field (raw, intervals.icu) | Plain-English emitted |
|---|---|
| `wellness.ctl` | `fitness` |
| `wellness.atl` | `fatigue` |
| `wellness.ctlLoad` | `fitnessContribution` |
| `wellness.atlLoad` | `fatigueContribution` |
| `wellness.rampRate` | `weeklyFitnessChange` |
| `activity.icu_ctl` | `fitnessAtEnd` |
| `activity.icu_atl` | `fatigueAtEnd` |

A wellness decoder, two rename functions, a defensive walker, and two type-gated parsers live in `sync/rename-tp-fields.ts`:

- `decodeWellnessRow(wire) → WellnessDay` — turns a platform wellness row into a `WellnessDay` for the live reader. It applies the five wellness renames, moves the athlete's self-reported fatigue score from the wire key `fatigue` to `subjectiveFatigue`, and parses the result. It rejects a row that already carries a coach word for a load average or a `subjectiveFatigue` key, a score that is not a whole number, and a load average that is not a number. Every failure is a `RowRejection` built from a reason and a key name, never a value.
- `renameTpFieldsOnWellnessRow(raw, summary?) → RenamedWellnessRow` — five wellness renames.
- `renameTpFieldsOnActivity(raw, summary?) → RenamedActivityRow` — two activity renames.
- `assertNoTpKeysRemain(value)` — recursive walker that throws if any TP-denylist key survives anywhere in the input (defense-in-depth for the "intervals.icu adds nested TP aggregates" failure mode). The error path uses `[<index>]` array form only — never includes row-id values — so operator log forwarding stays safe.
- `parseRenamedActivity(row: RenamedActivityRow) → Activity` and `parseRenamedWellnessRow(row: RenamedWellnessRow) → WellnessDay` — type-gated parse helpers. The branded input type is the type-level half of the anti-corruption boundary: a sync-path author who calls `ActivitySchema.parse(apiResponse)` directly bypasses the rename layer; using the parse helper makes that bypass a type error. Defense-in-depth only — the schemas remain publicly exported, so the brand catches forgetfulness, not malice.

**Metric-fetcher wiring obligation.** When the live `sync/fetch-reference-data.ts` body lands, fetch-reference-data MUST go through `parseRenamedActivity` / `parseRenamedWellnessRow` (which forces the rename call by virtue of their input type) instead of calling `ActivitySchema.parse` / `WellnessDaySchema.parse` directly. The rename layer is also wired into the operator fixture CLI (`tools/sanitize-fixture.ts`); both call sites stay in lockstep so the typed surface is consistent across sync paths.

**Two meanings of fatigue.** An intervals.icu wellness day carries a `fatigue` field: the athlete's self-reported score on a whole-number scale. The load average the coach calls `fatigue` arrives under another wire key. `decodeWellnessRow` keeps them apart: on a day it decodes, `fatigue` is always the load average and `subjectiveFatigue` is always the self-reported score, `null` when the athlete logged none. `renameTpFieldsOnWellnessRow` does not separate them, so a day it renames can carry either meaning under `fatigue`. No feature may read both under one name.

**Trademark policy.** The single source of truth for the typed-surface field-name policy lives at `trademark-policy.ts` (`TP_API_FIELDS`, `TP_DENYLIST_FIELDS`). The PR-time lint at `tools/check-trademarks.ts` is independent (uppercase string-literal scope). Background, USPTO records, and the prior enforcement precedent against an open-source analytics project: `docs/knowledge/research/trademark-tp-terms.md`.

## Sport seam (per ADR-0010)

Sports plug into Reference via the optional `Sport.referenceAdapters?(): readonly ReferenceSportAdapter[]` method (sport implementations register adapters as they come online). Each adapter declares activity types it handles, plus declarative metadata (zone basis, decoupling basis, sustainability anchors, DFA-validated flag) and optional algorithm hooks (`computeDfa`, `computePowerCurve`).

The dispatch + invariant kernel lives in `sport-adapter-dispatcher.ts` and `sport-adapter-invariants.ts`:

- **Routing.** `findAdapterForActivity` resolves one activity to its covering adapter; `runAdaptersForActivities` pairs a batch of activities with their adapters (selections only — it invokes no hooks; the live `Activity → MetricInput` bridge that feeds the hooks is deferred). Routing is family-aware: an adapter listing only `Ride`/`VirtualRide` also covers gravel/mountain-bike/e-bike rides because the registry counts those under the same family. Out-of-sport activities are skipped silently; an in-sport activity with no covering adapter warns once per distinct type per call.
- **Invariants.** `assertDisjointCoverage` (no two adapters claim the same activity type) and `assertSubsetCoverage` (every declared type ⊆ `sport.intervalsActivityTypes`) run at boot, throwing `ReferenceConfigError` and naming offenders by stable identity. Only `ReferenceConfigError` is re-exported from the Reference barrel; the dispatcher and invariant functions are imported from their own module paths.

## Channel seam (`services.ts`)

Reference exposes a `ReferenceServices` aggregate to downstream channels (Telegram today; CLI / web later) via `services.ts`. The channel imports the type; Reference does not import from channels. Per ADR-0010, layers own their contracts — and this aggregate IS Reference's. Future channels extend `ReferenceServices` in place rather than per-channel; expected upcoming additions:

- `maybeRefreshIfStale()` — populated when the curator lands, for the lazy-sync trigger.
- Operator scheduler controls (`/sync now`, `/scheduler stop`, etc.) — added when operator tooling lands.

## Relationships

- **Reference → `getCoachHome`** — every persisted file routes through `referenceDataDir(binaryName)` which composes `getCoachHome`. No Reference module hardcodes `~/.cycling-coach` or `~/.enduragent/cycling`.
- **Reference → `Sport.referenceAdapters?()`** — type-only seam. Sports without per-sport affordances simply omit the method.
- **Reference → freshness constants** — every Reference window number lives in `freshness.ts`. Imported, never re-declared.
- **Reference → I/O helpers** — every persisted-state read uses `safeReadJson` (now in `core/io/safe-read-json.ts`); every write uses `atomicWriteJson` (now in `core/io/atomic-write-json.ts`). Reference NEVER calls `JSON.parse(readFileSync(...))` or `writeFileSync(path, JSON.stringify(...))` directly.
- **Reference → concurrency primitives** — `AsyncMutex`, `chainedSignal`, and `Cooldown` are canonical in `packages/kernel/src/concurrency/`; core consumers resolve them through the compatibility shims in `packages/core/src/concurrency/`.

## Out of scope (current revision)

The kernel-owned `curator/`, `units/`, and `numerics/` directories remain empty placeholders in this revision; core has no tracked placeholder in those directories after relocation.
