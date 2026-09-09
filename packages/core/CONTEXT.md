# Core

Sport-agnostic CLI infrastructure for AI coaching agents, including setup, memory, secrets, and channels. Engine defines the `Sport` contract at `@enduragent/engine/sport`; Core re-exports it for existing consumers.

> Status: implemented private workspace package. Core depends on Engine and Kernel through explicitly transitional edges. Consult the [context map](../../CONTEXT-MAP.md) and [dependency checker](../../tools/check-package-deps.ts) for current package boundaries.

## Language

**Sport**:
A pluggable coaching domain (cycling, running, duathlon) that conforms to Engine's `Sport` interface — pure domain knowledge, no deployment concerns.
_Avoid_: Discipline, modality, mode

**Binary**:
A deployed CLI executable wrapping a `Sport` with deployment-shell config (npm name, display name, data subdir, keychain prefix). Multiple binaries can share one Sport.
_Avoid_: Build, distro, app

**Agent**:
The sport-agnostic conversation loop that runs LLM calls with tool dispatch, compaction, and memory flush. Core supplies a compatibility host around Engine’s runtime.

**Memory**:
A file-backed sectioned store of long-lived athlete information at `~/.enduragent/<binary>/memory/MEMORY.md` (or legacy `~/.cycling-coach/memory/MEMORY.md` for grandfathered cycling-coach users).

**Memory Section**:
A named bucket within `Memory`. Each section is owned by exactly one declarer: Core (shared across all sports) or a Sport (sport-specific, prefixed with sport id).

**Core Shared Sections**:
The six sections Core auto-injects for every binary regardless of sport: `person`, `schedule`, `goals`, `preferences`, `notes`, `medical-history`. Universal across endurance athletes; Sport packages do not redeclare them.

**Sport Sections**:
Sport-specific sections declared by a Sport package, with the sport id as prefix (e.g., `cycling-profile`, `running-history`, `duathlon-calendar`). Imported verbatim by Customer contexts — Duathlon's section list includes Cycling's and Running's sections without modification.

**Must-Preserve Tokens**:
Per-Sport list of literal phrases the LLM is forbidden to drop during compaction (e.g., `FTP`, `VDOT`).

**Trim Compaction**:
The persistent compaction path. At session load, when history exceeds the token budget, the oldest messages are summarized and the session JSONL is rewritten as `[summary, ...unsummarized, ...kept]` — after a pre-overwrite memory flush and a `.precompact` archive copy of the original file; the rewrite is skipped entirely when the flush fails. The only compaction that mutates the on-disk record.

**In-Turn Compaction**:
The ephemeral compaction path (`summarizeInStages`). Reshapes only the in-memory message array, from three sites in the chat loop (preemptive over-budget, context-overflow recovery, timeout recovery); the session JSONL keeps the full history and the reshaped array is discarded at end of turn.

**Compaction Summary Durability**:
Every freshly generated compaction summary (all four sites: trim, preemptive, overflow recovery, timeout recovery) is also mirrored into the day's note under the fixed marker `### Compaction summary`, heading-demoted, with an exact-block duplicate-skip. This makes the summary recoverable via `memory_read` after a session reset destroys the live JSONL and its archives.

**CoreDeps**:
An alias for Engine’s `SportRuntimePorts`, the runtime services received by a Sport’s tool factory. The [contract definition](../engine/src/sport.ts) specifies the required services and optional capabilities.

**BinaryConfig**:
Deployment-shell config injected into `runBinary` and `runSetup`. Fields: `binaryName` (npm name + CLI invocation), `displayName` (human-readable for prompts), `dataSubdir` (under `~/.enduragent/`), `keychainPrefix` (Apple Keychain entry prefix), `homeEnvVar` (env override variable name). Each binary package declares one and passes it through.

**runBinary**:
Core's shared entry-point dispatcher. `runBinary(sport, binary, hooks?)` parses CLI args, routes setup/version/unknown commands, loads config, constructs `CoachAgent`, and runs the Telegram or CLI loop. Per-binary entry is a 5-line shim calling this.

**Version PR**:
Changesets-generated PR aggregating pending `.changeset/*.md` entries across packages into version bumps + CHANGELOG entries. Merging the Version PR triggers the publish job (which runs `pnpm exec changeset version`, `tools/bump-binaries-to-calver.ts` to override binary CalVer, then `pnpm publish -r`).

**Session**:
One user's chat state with one Binary, persisted to disk and locked in-process per chat. The process model is one process per dataDir; there is no cross-process lock.

**Channel**:
A delivery surface (currently only Telegram); sport-agnostic.

**Language**:
The athlete's chosen interface and coach-reply language: one of the supported catalogs, or Automatic when none is saved. One value per install, shared by every Channel and the desktop. Avoid: Locale, region, country.

**Locale**:
The BCP-47 tag that drives date, number, and plural formatting. Comes from the OS or the Channel's region hint, never from Language. Avoid: Language, i18n.

**Static Prefix**:
The turn-invariant head of the system prompt — SOUL, the joined skill prompts, the rule blocks (untrusted-data, recall, workout-review, data-grounding) — that forms one frozen cache prefix; only the Athlete Context block is volatile and renders last. **Boundary policy:** SOUL and always-needed rules stay preloaded in this prefix. Future skill growth that is not needed every turn (e.g., nutrition depth, race-prep depth) ships tool-retrievable rather than preloaded — but never via per-turn conditional injection, which would reshape the prefix and defeat the cache. A guardrail test fails if the prefix's estimated token count exceeds its ceiling, forcing a conscious preload-vs-retrieve decision instead of silent bloat.

**Plan**:
The locally authoritative prescribed training for one goal. Its lifecycle is `active` or `closed`; a closed Plan has reason `completed` or `stopped`.
_Avoid_: Draft, Plan Creation, replacement Plan, ended Plan, calendar plan

**Plan Creation**:
The persisted workflow that gathers confirmed inputs and produces a reviewable Draft before activation. Its lifecycle is `in-progress`, `review`, `activated`, or `discarded`; at most one may be unfinished.
_Avoid_: Plan Intake, replacement, setup wizard, Plan conversation

**Draft**:
The current generated, reviewable snapshot inside a Plan Creation. A Draft is not a Plan and has no Plan lifecycle state.
_Avoid_: Draft Plan, pending Plan, replacement Draft

**Plan Creation Answer**:
An athlete-confirmed value scoped to one Plan Creation. It outranks saved or observed context for that creation but becomes lasting only when the athlete chooses that scope.
_Avoid_: Inference, Athlete Preference

**Plan Change**:
A version-bound proposed revision to the active Plan's uncompleted future intent. It changes the same Plan only after explicit confirmation.
_Avoid_: Replacement, Proposal, Plan patch

**Athlete Preference**:
An athlete-saved choice intended for future Plans until removed. It is distinct from a Plan Creation Answer and a temporary Training Restriction.
_Avoid_: Athlete Rule, permanent restriction

**Training Restriction**:
A dated operational limit of no training, no hard training, or a maximum duration. It records training effects, not diagnosis, treatment, or medical clearance.
_Avoid_: Medical profile, diagnosis, health constraint

**Plan Workout**:
A Workout that belongs to one Plan and carries its planning identity, origin, and sport-owned prescription. A flexible Plan Workout may remain undated until chosen.
_Avoid_: Session, `planned_workout`, `planned_workouts`

**Reconciliation**:
The recoverable process that makes the external calendar mirror agree with an already-committed local Plan. It never determines Plan lifecycle.
_Avoid_: Plan activation, Plan rollback, calendar ownership

**Training Week**:
A seven-day span counted from a Plan's athlete-selected start date; week 1 begins on that date.
_Avoid_: Calendar week, partial week

## Relationships

- A **Binary** wraps exactly one **Sport** plus deployment config.
- An **Agent** is constructed with one **Sport**; never switches mid-session.
- A **Sport** declares its **Memory Sections** and **Must-Preserve Tokens**; Core consumes both.
- A **Sport**'s `tools` factory receives **CoreDeps** and returns tool registrations the **Agent** dispatches.
- One **Binary** owns one **Memory** file.

## Example dialogue

> **Dev:** "When the duathlete asks about FTP, does the duathlon **Sport** answer or delegate to cycling?"
> **Domain expert:** "There's only one active **Sport** per **Agent**. Duathlon's `soul` and `tools` are _composed_ from cycling and running at construction time. From Core's view, one **Sport** answers."

## Path resolution

`getCoachHome(binaryName)` (exported from `@enduragent/core`) is the single helper that resolves a binary's data directory using the three-tier fallback codified in ADR-0006: env-var override (`<BINARY>_HOME`, with `~`/`~/...` expansion) → legacy `~/.cycling-coach/` (only for the `cycling-coach` binary, only when that directory exists on disk) → fresh-install canonical `~/.enduragent/<dataSubdir>/` (subdir derived by stripping `-coach` from the binary name). All persisted state — Core config, Memory, Reference cache files (per the Reference layer's upstream protocol) — routes through this helper. Pure function; callers create the directory when they need it.

## Fail-mode policy

Each subsystem's behavior under failure is a recorded fail-open / fail-closed decision (full table + rationale in the project's fail-mode policy ADR; only this one-line-per-row mirror ships):

- **Coaching from stale/corrupt cache** → **CLOSED** (degrade-and-disclose). A HARD sync-gate rejection stamps `mitigation: "block_coaching"`; the chat turn reads it and declines to quote numbers from unvalidated data, telling the athlete the data is stale instead. The one row wired in code.
- **Audit-write** (append throws) → **OPEN**. Audit is observability, not the reply path; never break coaching to record a log line.
- **Completed-turn transcript capture** (append throws) → **OPEN**. Every serialized transcript JSONL record is capped at an inclusive 262,144 bytes. A delivered coaching reply is not withdrawn when its transcript append fails; the failure is recorded with fixed metadata only.
- **Conversation reset / transcript-boundary consistency** → **CLOSED**. A reset is journaled before either durable store changes, recovers idempotently before later access, and blocks model-context or transcript access while recovery remains unresolved.
- **`error_state.json` unreadable** (missing / unparseable / schema-invalid) → **OPEN** on the read. A broken error-state file must not brick chat — absent/unreadable yields no block, coach normally.
- **Sender-allowlist lock contention** → **CLOSED**. Access control is a security boundary; deny on uncertainty rather than admit an unverified sender.
- **Secrets backend unavailable** → **CLOSED**. No credential ⇒ no upstream call; fail loudly rather than proceed with an empty/guessed secret.

Per-source synchronization failures are authoritative in SQLite and project to the Reference layer's `data/error_state.json` compatibility signal after each committed source-state change and before the next source run. A blocking failure uses `block_coaching`; a warning uses `warn_only`; recovery clears only the successful source. Failure details come from a closed project-owned vocabulary and never include exception text, URLs, paths, credentials, or athlete payloads. `force_resync` remains schema-declared and unwired.

## Reference test substrate (property-based + golden fixtures)

Property-based generators wrapping the Reference input schemas live at
`tests/helpers/reference-arbitraries.ts` (fast-check arbitraries; opt-in
`MATH_CRITICAL_RUNS = 10_000` paired with `MATH_CRITICAL_TIMEOUT_MS = 30_000`
for stddev-sensitive metrics — both constants MUST be passed together).
Golden fixtures (sanitized real intervals.icu responses) live at
`tests/fixtures/golden/`, synthetic regression fixtures at
`tests/fixtures/synthetic/`. Add a fixture by running
`pnpm exec tsx tools/sanitize-fixture.ts <real.json> <name>`; see
`tests/fixtures/README.md` for the workflow.

## Flagged ambiguities

- Distinguish **Sport** for coaching domain, **Binary** for deployment shell, and `@enduragent/coach` for the Node composition package.
