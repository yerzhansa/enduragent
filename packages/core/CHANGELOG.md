# @enduragent/core

## 0.1.4

### Patch Changes

- 2d0128c: Add the privileged Chat attachment-admission contract and durable queued-Message attachment identities.
- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 3627ecd: Distinguish confirmation guard refusals and returned failures from completed changes.

  User-facing: When a workout can no longer be changed, the coach explains why instead of saying it is done.

- 48f6422: User-facing: Diagnostic logs now hide sensitive error text and credential-bearing URLs. Secret helper failures show an exit code and setup guidance without exposing helper output.
- eba82b9: User-facing: Chat recovery now survives repeated connection losses without duplicating your message after relaunch, while preserving every partial and completed Coach response.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.
- 3627ecd: Prepare explicit Astra selection on the public OpenAI API while retaining existing default models and restricting unverified subscription transports.

  User-facing: You can explicitly choose Astra with an OpenAI API key. Existing model choices stay unchanged, and unavailable cost estimates are not shown as known prices.

- 4018b25: Keep Training History freshness and calendar windows anchored to the current successful sync and the athlete's active timezone.

  User-facing: Training History now stays current after a successful sync that finds no new data, and its week boundaries follow your active timezone without requiring a restart.

- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [1e07590]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [30ca87f]
- Updated dependencies [3627ecd]
- Updated dependencies [c507634]
- Updated dependencies [e649a25]
- Updated dependencies [f6cacbb]
- Updated dependencies [b02a1e8]
- Updated dependencies [b87174d]
- Updated dependencies [3ad0c39]
- Updated dependencies [a52086c]
- Updated dependencies [6546ba5]
- Updated dependencies [1594b20]
- Updated dependencies [a5a366f]
- Updated dependencies [eba82b9]
- Updated dependencies [2567965]
- Updated dependencies [a415177]
- Updated dependencies [3627ecd]
- Updated dependencies [4018b25]
- Updated dependencies [f65201d]
  - @enduragent/coach-contract@0.1.2
  - @enduragent/engine@0.0.3
  - @enduragent/kernel@0.1.1

## 0.1.3

### Patch Changes

- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- ec24061: User-facing: Prevent ambiguous duplicate activity streams from producing misleading training analysis.
- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- 8619dc3: Reuse the daemon lifecycle's authoritative store writer during refresh windows instead of attempting a nested writer acquisition, so a fresh athlete home starts normally and Reference sync errors render usefully.
- 68e2a75: Parameterize per-binary environment variable names (setup/update/managed-deploy
  knobs derive from the binary name instead of hardcoding one binary's prefix),
  ship the MIT NOTICE file inside the published npm tarball, and arm the
  package-dependency lint family with empty kernel package scaffolds.
- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 0115dfe: Preserve closed configuration-readiness failures through app-supervised utility termination without retrying terminal configuration errors.
- b4e5365: Let Desktop start from an existing configuration that omits `data_dir`.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- a42fb2c: Fetch bounded release metadata only after an explicit Desktop action, validate it across the preload boundary, and render remote note text without HTML or Markdown interpretation.
- 2e61329: Add curated and custom model selection, write-only endpoint overrides, explicit provider activation, and retry-safe non-secret Setup drafts.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 67369bb: Add an internal append-only transcript writer with a 262,144-byte serialized-record bound and conversation reset boundaries for durable Desktop capture. Renderer history and hydration are not exposed in this slice.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- e932ede: Route the CLI REPL and the Telegram channel through an in-process engine seam
  (createCoachEngine) that delegates verbatim to the coaching agent. Pure
  wiring refactor: no behavior change, proven by the replay gate's zero-diff
  baseline and the untouched channel test suites.
- 517a34f: Add the Reference layer intervals.icu source with archive-first activity, stream,
  wellness, sport-setting, and FIT hydration plus deterministic activity revisions.
  Private infrastructure; ships nothing to athletes.
- 037a09a: Upgrade the Intervals.icu client to 0.3.1 and keep canonical managed activities separate from the snake_case Reference persistence boundary.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- 10c6d16: Add read-only local bundle projection for the Reference layer.
- 9a7961c: Relocate portable Reference layer and concurrency sources into the kernel,
  preserving core consumers through compatibility shims and explicit subpaths.
- 22364df: Adds per-role model routing for the background compaction caller (provider-dependent default lane, LLM_COMPACT_MODEL / llm.compact_model override), restructures compaction calls into a cache-capable system+messages shape with an enlarged pinned instruction block, reserves the sync-triage and dream caller roles, and lands the operator-run compaction quality gate tooling.
- 0d1ad65: Deterministic replay gate for agent-turn behavior: `pnpm s8a` replays committed
  mocked-LLM scenarios and asserts prompt hashes, tool-call sequences and arguments,
  message-array shape, memory and ledger writes, and budget charges against recorded
  baselines; `pnpm s8a --self-test` proves the gate can fail via a seeded-drift fixture
  and a determinism probe. Runs offline in CI on every push and PR.

  Pure-infra changeset.

- 118c2a6: Widen the sport identity unions: `SportId` gains `swimming` and `triathlon`; `IntervalsActivityType` gains `Swim`, `OpenWaterSwim`, and `VirtualRun`. Type-level only — no sport declares the new activity types yet and no runtime behavior changes.
- 89a6522: Migrate managed calendar writes to the Intervals.icu client's canonical camelCase request contract.
- 0afbcad: User-facing: Local coaching can read historical athlete data from the training store and disclose when it was last synchronized.
- b25c3c1: Split the cached system prompt into a stable prefix block and a volatile athlete-context block with per-block cache breakpoints on breakpoint-capable routes (direct Anthropic; OpenRouter qwen), add a message-level cache breakpoint on the last message, and stamp a schema version on persisted prompt-lineage session lines with back-compat for unversioned lines.
- Updated dependencies [8ac6eec]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [fc9ed36]
- Updated dependencies [5428c22]
- Updated dependencies [61a8940]
- Updated dependencies [78971cb]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [67369bb]
- Updated dependencies [810b29e]
- Updated dependencies [0ab935f]
- Updated dependencies [42c6efa]
- Updated dependencies [517a34f]
- Updated dependencies [c122f29]
- Updated dependencies [111261c]
- Updated dependencies [4e996bc]
- Updated dependencies [66fc866]
- Updated dependencies [b8a8ef0]
- Updated dependencies [0b73876]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [67174e9]
- Updated dependencies [aebc383]
- Updated dependencies [336462d]
- Updated dependencies [89a6522]
- Updated dependencies [fd9cd3a]
  - @enduragent/kernel@0.1.0
  - @enduragent/coach-contract@0.1.1
  - @enduragent/engine@0.0.2

## 0.1.2

### Patch Changes

- e31ab52: Refactor shared workout-date validation, confirmation outcomes, proposal lookup, event provenance, and sport tool construction without changing behavior.
- 1e40c2e: User-facing: Saved memory no longer gets corrupted when a note contains markdown section headings.

  Demote line-start `## ` headings to `### ` inside the single section-write
  choke point so heading-bearing content can no longer fragment the section map,
  shadow a real section, or leave orphan fragments across reads and replaces.
  Export a 4000-char per-section soft cap that emits one structured warn (never
  truncates) when a stamped body exceeds it.

- 49844fa: Remove the unimplemented `schema` field from `MemorySectionSpec`. No code ever
  read it; section-name validation at the memory_write seams (Zod enum of
  declared section names) is the actual enforcement surface.
- 03964f0: User-facing: Fixed a rare bug where an emoji sitting exactly at a length limit could be sliced in half, producing garbled text in long Telegram code blocks, compaction summaries, and memory query results.

  All fixed-length string cuts now route through a shared `truncateUtf16Safe` helper that backs the cut off by one UTF-16 unit when it would bisect a surrogate pair. Fixed sites: `splitPreBlock`'s oversized-row fallback and `hardSplit`'s pathological fallback in the Telegram chunker, `capSummary` in compaction, and the `memory_query` result cap. (docs/issues #171)

## 0.1.1

### Patch Changes

- 34c4bd4: User-facing: Container and Railway deploys can now set `LLM_PROVIDER` plus a generic `LLM_API_KEY` for any API-key LLM provider. Provider-specific env vars such as `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY` still work and take precedence.
- bdbb513: User-facing: Want the bot running 24/7 without keeping your computer on? Deploy the Railway template: https://railway.com/deploy/cycling-coach

## 0.1.0

### Minor Changes

- 1e40e7d: User-facing: Added six new LLM providers to setup — DeepSeek, Qwen, MiniMax, Kimi, Z.AI (GLM), and OpenRouter — each selectable in `setup` with its own model list and an optional base-URL override.

  Wires DeepSeek (`@ai-sdk/deepseek`), Qwen (`@ai-sdk/alibaba`), and OpenRouter (`@openrouter/ai-sdk-provider`) through dedicated AI SDK factories, and MiniMax/Kimi/Z.AI through `@ai-sdk/openai-compatible` with provider-default base URLs. Adds an `LLM_BASE_URL` override and `llm.base_url` config field, plus a pi-ai KnownProvider typing guard so the widened provider union compiles (providers absent from the priced catalog report `cost: undefined` on the usage ledger).

- ffe679a: Auto-resolve the running critical-speed anchor from synced intervals.icu data so `calculate_zones` no longer depends on the LLM supplying it.

  Core gains `resolveRunningCs(latest)` (sharing one row-walk with the step-5 CS-source gate so the two cannot drift) and a per-turn `CoreDeps.resolvedCs` getter; the Telegram channel resolves the anchor from the latest synced profile each turn and passes it into `chat()`. The running `calculate_zones` tool makes `criticalSpeedMps` optional — it falls back to the synced anchor (manual `critical_speed` outranking platform `threshold_pace`), reports real provenance (`csSource` / `anchorOrigin` / `platformConfidence`), and returns a `no_cs_anchor` error rather than guessing when neither is present. The per-turn value is read lazily through a closure, so the prompt-template hash and cache prefix stay stable; non-running sports and the CLI path are unaffected.

### Patch Changes

- a9d75f7: User-facing: /quit, /exit, and Ctrl-D now exit cleanly, and startup shows a "syncing training data" line (with an explanation if the first sync fails).

  The CLI readline loop registers a single close handler that stops the periodic Reference sync scheduler and exits with code 0, so /quit, /exit, Ctrl-D, and a single Ctrl-C at the prompt all return the athlete to their shell instead of leaving a zombie process syncing under their API key. A verbatim banner prints before the awaited boot sync (in both CLI and Telegram modes) so the previously blank up-to-120s cold start is visible. A first sync that resolves failed (rather than throwing) is now surfaced with a one-line explanation from the Reference bootstrap. As defense-in-depth, the periodic scheduler timer is unref'd behind a guard so it cannot keep the process alive on its own.

- fabc7f7: User-facing: A backward or frozen system clock no longer makes stale training data appear fresh.

  The freshness band now treats a cache timestamp more than five minutes in the future as stale (raising a freshness warning) instead of fresh, and the `/sync` reply words a future timestamp honestly instead of clamping it to "0s ago".

- f18878d: User-facing: The coach now declines to quote numbers from stale data and tells you so, instead of fabricating from a stale cache.

  When the latest sync fails validation, the gate records a block-coaching mitigation and the chat turn degrades to general, qualitative guidance with a one-line disclosure of how long since the data last synced. The validation-failure signal flows through an already-present on-disk mitigation channel (no schema change): a HARD sync-gate rejection stamps the error state, and the turn reads it once at start, failing open if that state file is itself unreadable. The degrade block renders in the volatile prompt tail so prompt caching is preserved.

- 3003f2a: Add a sport-agnostic pace formatter that renders an SI speed (metres per second) to an athlete-facing M:SS pace, keyed on the `pace_units` display preference (per-mile for `MINS_MILE`, per-kilometre otherwise). Distance is parameterised so a per-100 pace can reuse it. Additive presentation helper with no caller yet.
- 4eafde4: User-facing: Fixed a bug where a full disk could discard a reply you'd already received — the coach now always shows the reply and tells you once if it couldn't save it to your history.

  The chat turn now delivers the generated reply even when the session append throws, so a full disk or permission error never discards a reply you already paid for. Both session lines are written as a single atomic append, so a partial half-turn can never land, and a disk-full condition is surfaced to you once per process. The fix lives in Core, so both the CLI and the Telegram channel are fixed without a channel edit — mirroring the audit writer's never-break-the-reply-path discipline.

- b64d7ac: Make the `derived_metrics_meta` provenance honest. Rename `basis` to `prescriptionBasis` (the adapter's declared prescription anchor — `power`/`pace`) and add a separate `analysisBasis` carrying the substrate the distribution numbers were actually computed off (`power`/`hr`/`mixed`/`null`, read from the already-computed `zone_distribution_7d.zone_basis`). For a power-less run these diverge: prescription `pace`, analysis `hr`. `latest.json` schema bumps v2 -> v3 (discard-and-resync). No ported metric math changes.
- 96053cf: User-facing: A coaching turn that runs out of steps now tells you what it gathered and to ask it to continue, instead of failing with a generic apology.

  When a tool-heavy turn spends its whole step budget without producing a final reply, the agent now reads the model's finish reason and runs one final no-tools completion to summarize what it did and what's left; if that still yields nothing (or fails), it falls back to a static "I ran out of steps" line so the athlete always gets actionable text and is never invited to blindly retry — which would re-run already-committed paid side effects. Two defense-in-depth guards back this up: the session store refuses to persist an empty or whitespace-only assistant message, and the long-message sender skips empty chunks so an empty reply can never reach the chat. The finish-reason reader is a single named predicate that the future overflow-classification work will extend.

- 698ad66: Enable prompt caching for Qwen models routed through OpenRouter.

  OpenRouter auto-caches its OpenAI/DeepSeek/Grok/Moonshot routes but requires an explicit cache_control breakpoint for Anthropic-, Qwen/Alibaba-, and Gemini-backed routes; the five direct providers all cache the stable system prefix automatically. The dispatch path now emits the breakpoint under the `openrouter` providerOptions key for `qwen/`-namespaced models only — `anthropic/` and `google/` routes via OpenRouter remain uncached by design and can be added later. Every other provider and OpenRouter-routed model is unchanged. The Anthropic branch is generalized into a small `cacheBreakpointKey` resolver (same breakpoint shape, only the key differs).

- c8b9d74: User-facing: Added a per-turn safety cap so a flaky provider connection can never run up a large surprise bill on your API key in a single message.
  User-facing: Fixed a bug where retrying after a hiccup could create a duplicate workout on your calendar; the coach now tells you honestly if a change was saved but the reply didn't finish.

  A single per-turn budget now caps total model calls and total generate attempts across every error class and the flush and compaction ladders, with a five-minute wall-clock checked only between attempts that never aborts an in-flight call, so a brownout turn stops with a classified budget error instead of spending the athlete's pay-as-you-go budget. The agent also records each committed calendar write within a turn and refuses to silently retry once a write has committed, returning an honest message that a change was saved but the reply failed rather than replaying a non-idempotent create into a duplicate workout.

- 82defb5: User-facing: A single server hiccup or network blip from the AI provider no longer ends your turn — the coach now retries briefly and keeps going.

  Both the AI-SDK and codex provider paths now route transient 5xx/network failures through one closed error taxonomy and a single jittered-retry layer; a connection-refused error buried on `error.cause` is detected via a cause-chain walk. The codex provider path stops mis-classing a transient gateway 5xx as a rate limit (it took 5-35s of rate-limit-grade backoff it did not deserve) and now honors Retry-After from the response headers; a runtime-fetch wrapper stops the provider library's internal network-retry loop so network errors are retried at exactly one layer, and a static-dist smoke test trips loudly if a provider-library upgrade renames the no-retry marker.

- e7b8236: User-facing: Refreshed the model picker to the current generation — added Claude Opus 4.8, GPT-5.5, Gemini 3.5/3.1, GLM-5.2, MiniMax M3/M2.7, Kimi K2.6 and Qwen 3.5, and retired stale options.

  Refreshed the setup-wizard model picklist, the per-provider default models (`setup.ts` + `config.ts`), the context-window table, and the cost price catalog (`cost.ts`) to the current-generation models across every provider. Model IDs, per-million pricing, and context windows were verified against each provider's official pricing/docs pages.

- 0c34c56: Vendored the ChatGPT-subscription ("openai-codex") provider in-house and removed the `@mariozechner/pi-ai` dependency. OAuth login + token refresh, the Responses-API round-trip, the JWT account-id helper, and the per-million pricing catalog now live under `packages/core/src/agent/codex/`, re-expressed in the codebase's own AI-SDK type vocabulary (`ModelMessage[]` / `LanguageModelUsage`). Behavior is preserved — SSE transport, one request attempt with structured errors propagated to the shared retry layer, and native token-endpoint redaction (status + boolean field-presence only, never token bodies). No user-visible change.
- eb4b9a6: Land critical-speed-anchored running pace zones and make them reachable through the running-coach binary.

  `@enduragent/sport-running` now ships the `calculate_zones` tool (six CS-anchored pace zones), the running soul + skills, the athlete-profile schema, and a pace-based reference adapter. `@enduragent/core` gains a hard CS-source sync gate (step 5) that refuses to sync a running zone table from a missing or out-of-band critical-speed anchor, plus the `threshold_pace`/`critical_speed`/`cs_source`/`cs_confidence` fields on the sport-settings schema. The `running-coach` binary, previously a stub, now wraps the running sport via Core's `runBinary` — it runs from the workspace (externalized, still private/unpublished).

- 73b3af4: Serialize structured running workouts and add the calendar-create running tool.

  `@enduragent/sport-running` now ships `serializeRunningWorkout` (pace-based steps → intervals.icu native step syntax) plus a gated `intervals_create_workout` tool that writes the workout to the intervals.icu calendar. Steps carry zone, critical-speed-fraction, or absolute-pace targets over time or distance, rendered so the server parses them into a structured workout (distances emit as km/mi so they are never misread as minutes); running Pace Load stays server-authoritative, so no client load is sent. `@enduragent/core` re-exports the critical-speed sanity band (`CS_MIN_MPS` / `CS_MAX_MPS`) as a single constant the running package now derives its band from.

- 383982b: User-facing: The coach no longer silently half-schedules a multi-workout week — it confirms the plan and writes workouts across follow-up turns instead of running out of room mid-write.
  User-facing: Repeated identical data lookups within a single message are reused instead of re-fetched, so the coach answers faster and uses less of your API budget.

  Adds a per-turn read memoizer that wraps read-only tools and reuses an identical same-turn read (keyed on a stable hash of the tool name and its arguments) instead of re-invoking the tool's execute, so a duplicate lookup no longer burns an agentic step or re-pays the athlete's API spend. The memoizer applies ONLY to an explicit, hand-audited read-only allowlist that deliberately excludes the plan-skeleton tool and the calendar/memory writers (a memoized hit would skip their side effects). The cache is per-turn: it is cleared at the top of each chat turn, so an identical read on a later turn re-fetches. A new static rule block discloses the per-turn tool-call budget and prescribes the multi-workout follow-up protocol, riding the cached prompt prefix.

- 65c8d82: Change the in-process scheduled sync cadence from every 30 minutes to every 6 hours (`SCHEDULED_SYNC_INTERVAL_MS`). The boot sync is unchanged; this only lengthens the recurring in-process refresh timer, reducing intervals.icu API load. Data stays within the 24h "fresh" band between refreshes.
- 0cd853b: User-facing: /sync now replies instantly when a sync is already running, instead of appearing to hang.

  The interactive /sync path consults the sync mutex and returns the "already running" reply immediately rather than blocking the full acquire timeout; the background scheduler's queue-and-wait behavior is unchanged. The /sync reply also no longer renders a dangling "Refreshed:" line on a no-op cycle — it now says the data was already up to date.

- 12f522a: User-facing: A sync hiccup no longer silently blanks your data behind a "fresh" stamp — if a data source errors, the coach keeps the last good snapshot and records the failure instead of overwriting it with empties.

  Per-endpoint fetch failures (athlete-profile, wellness) now ride a Result-shaped error channel into the Reference layer's data-fetch gate; the gate's data-fetch precondition hard-fails naming the endpoint, so the failed sync routes through the existing gate-rejection path — the prior cache file is preserved, the freshness stamp is not advanced, and the error state records the failure. The same pass adds a content-hash short-circuit to the sync write loop: a no-op cycle (re-fetched data identical modulo metadata) now skips the cache writes entirely, leaving the files byte-identical instead of re-stamping a fresh timestamp every cycle; the sidecar commit marker still advances each cycle.

- ebb0c3e: User-facing: The bot now answers quick commands like /version while a long /plan is still being generated, and Telegram's "/" menu lists every command.

  Telegram turn handlers (/plan, /workout, /status, /review, and free-form messages) now spawn the LLM turn on a tracked task and return immediately, so grammY's sequential update loop is never blocked by a long turn. Per-chat reply ordering is preserved by the existing per-chat session lock inside the agent's chat path. The session reset now runs under that same lock so a reset can no longer interleave with an in-flight turn for the same chat. The command surface is registered with Telegram via setMyCommands at startup (fire-and-forget, conditional on Reference services for /sync, excluding /snapshot), so the client's "/" auto-complete menu populates.

- 147e7e4: User-facing: Workout prescriptions and code blocks now render exactly as written, links are clickable, and formatting errors fall back to clean readable text.

  The Telegram markdown→HTML converter now extracts fenced code blocks from the raw source before escaping (mirroring the table path), so a fenced workout like `- 4x8min @ 105%` survives byte-for-byte instead of having its bullets, headers, and italics mangled inside the `<pre>`. The italic regex is tightened so spaced asterisks in interval math (`do 3 * 8 reps`) keep their literal `*`. An http/https-only `[text](url)` rule renders clickable links with attribute-escaped hrefs and no double-escaped `&` in multi-param query strings. The long-message hard split no longer bisects an HTML tag, entity, or surrogate pair. When Telegram rejects a chunk, the fallback now delivers human-readable source text rather than resending raw tag soup. Finally, the `/snapshot` debug dump rides the same HTML path, dropping the lone legacy Markdown parse mode.

- 955990e: User-facing: Deep race-review turns with very large data fetches now degrade gracefully instead of failing.

  A generic per-result token-share cap is applied at the tool-registration boundary: any tool whose serialized result exceeds half the context window is replaced with a count-preserving notice the model can act on (rerun with narrower arguments), while small results pass through byte-identical. On top of that backstop, the intervals.icu stream fetch now downsamples raw time-series to 10-second bins with a per-channel min/max/mean stats header that preserves true peaks, so a 3-hour ride fits the smallest supported context window instead of overflowing the mid-turn step loop and exhausting the overflow-recovery retries. Every intervals.icu fetch tool's error path now returns a typed object carrying the error kind plus optional HTTP status or message, additively, without changing the kind key the prompt's error-translation table reads.

- 1079871: User-facing: The "update available" notification now invites you to tag or DM @yerzhansa on X.com with feedback, feature requests, or bugs.

  Appends a one-line feedback call-to-action to the startup update-available broadcast in the Telegram channel. Plain-text only (the broadcast sends without a parse mode), so no markdown/HTML escaping concerns. Broadcast filtering and once-per-version dedupe are unchanged.

- e755f86: Tag the local usage-ledger turn line with the prompt template hash. The turn line now carries an optional `templateHash` so a recorded latency/timing sample is attributable to the exact prompt revision that produced it, without a timestamp join against the chat-store. The value is already computed at the append site; only the turn line carries it (the per-generation line stays as-is). Additive and optional — existing ledger lines and readers are unaffected.
- 1d414e5: User-facing: The coach now mirrors your wording — it explains efforts in plain feel-language unless you used the technical term first, names the signal behind every recommendation, and the cycling zone numbers it prescribes now match the mainstream 7-zone scheme your head unit uses.

  Cross-sport voice rules (register-mirroring, name-your-basis, and scoped reply structure — reviews → prose, quick answers → direct, prescriptions → one step per line) move into Core's system-prompt builder, so they apply to every sport; the contradictory SOUL copies and the duplicate trademark substitution table are deleted, leaving exactly one table in Core's review block. The session-cluster gap becomes a sport-persona field Core renders generically instead of a hardcoded per-sport string. Cycling zone vocabulary aligns to the mainstream 7-zone numbering — sweet spot is taught as the named 88-94% sub-range rather than its own integer, threshold moves to Z4, and the zone-intensity midpoints are re-keyed so the calendar Load estimate agrees with the band a serialized zone step actually demands; the heart-rate cross-reference closes its gap and caveats that heart rate is an unreliable target above threshold. Periodization and taper numbers are steered to the deterministic plan tool instead of transcribed in skill prose, with a guard test pinning the dedup. The trademark lint now scans the per-sport skill markdown and SOUL files with a line-level skip directive.

## 0.0.2

### Patch Changes

- 374b206: Add a committed builder for the `capability-qualifying` Reference test fixture
  and rebuild it from the refreshed realistic-athlete golden. `tools/build-capability-fixture.ts`
  reads the sanitized realistic-athlete base (already id-redacted and shifted to
  the synthetic epoch) and appends the five steady-state qualifying Rides at the
  tail, mirroring the sibling builders: deterministic plain `JSON.stringify`
  output, a committed `.sha256` sidecar, and a non-vacuity guard that recomputes
  the durability reliability gate (>= 3 qualifying Rides in the 7d window, >= 5 in
  the 28d window) so a vacuous capture fails the build. The rebuild brings the
  fixture's 38 base activities onto the current sanitizer field surface (adds the
  `icu_hrr` / `icu_variability_index` fields the refresh introduced) while keeping
  the appended Rides byte-identical. Folds the fixture into the checksum integrity
  test and the PII allowlist scan alongside the other builder-produced goldens.

  Internal test-fixture + dev-tooling change; no runtime behavior change.

- a7b7fe2: User-facing: Fixed a bug where a flaky intervals.icu connection while saving a workout could create duplicate workouts on your calendar.

  The chat-path client now constructs through the intervals client factory with lib-side retry disabled (`maxAttempts: 1`), mirroring the sync path, so non-idempotent calendar writes are never replayed by the HTTP layer.

- 5e302b6: User-facing: The coach now carries its current training recommendation (and any pushback you've raised) across long conversations instead of sometimes losing it when older messages are condensed.

  User-facing: Session resets no longer get stuck when saving memory fails — the coach archives the conversation and starts fresh anyway.

  Compaction summaries gain a required Coach Stance section (enforced by the
  headings audit) and the MUST-PRESERVE block gains stance, dispute, illness,
  and agreed-action bullets, so the summarizer can no longer file the coach's
  own recommendation under omittable generic advice. Both reset-path memory
  flushes are now wrapped in warn-and-proceed guards so a flush failure cannot
  block the session archive.

- 9c650bb: User-facing: Long conversations are now condensed safely — the coach saves durable facts to memory and keeps a local archive of the full transcript before condensing older messages, leaves your history untouched if anything fails along the way, and completeness-checks every condensed summary.

  The trim-path compaction now flushes memory before rewriting the session
  file and skips the rewrite when the flush fails; every successful trim
  archives the pre-rewrite transcript to a .precompact sidecar governed by
  the existing opt-in retention knob. Summarization of dropped messages
  returns failed chunks to the caller instead of discarding them and throws
  on total failure so history is never replaced by an empty summary. The
  summary-quality audit is extracted into a shared post-step applied by
  both compaction pipelines, with output bounded at generation time and the
  audit running after any final truncation.

- 47969d6: Add a literature-grounded aerobic-threshold field to the DFA-α1 capability
  profile, alongside the faithfully-ported crossings. Each session now carries an
  `aet_crossing` band centered at α1 = 0.75 ± 0.05 — the value the literature
  operationalizes as the aerobic threshold (AeT / LT1) — aggregated per sport into
  `trailing_by_sport.<family>.aet_estimate` (same indoor/outdoor-split / pooled
  shape as `lt1_estimate`) plus `aet_crossing_sessions`. The existing 1.0-centered
  `lt1_crossing` (the well-correlated baseline) and 0.5 `lt2_crossing` are
  unchanged; `aet` is purely additive.

  This is an additive, cite-backed deviation from the upstream oracle (which emits
  no 0.75 crossing), registered in `tools/intentional-deviations.yaml` as
  `approved-cite`. The parity gate gains an `added_paths` mechanism: for an
  approved-cite entry it strips exactly the declared additive paths from the
  implementation output before the bit-identity assertion, so every ported value
  still asserts bit-identical against the oracle while the additive field rides
  alongside (verified by unit tests instead). Cite-content enforcement now runs
  locally (where the research tree is checked out) and skips gracefully when it is
  not, rather than failing.

  Internal plumbing change: `aet_estimate` now appears in `derived_metrics`, but
  nothing surfaces it to athletes yet (the everyday-ride reveal and the
  1.0-crossing labeling fix remain follow-ups). No athlete-facing output change.

- 4fdfcec: Land the Reference layer's dfa stream fixture: the snapshot harness and its native/fuzz/coverage twins gain the dfa-assembly path in lockstep — when a fixture carries the optional `streams` key, each per-second stream record (keyed by `String(activity.id)`) is joined back to the activities array and run through the upstream's own `_compute_dfa_block` to prime `_intervals_data`, deriving the dfa entries ONLY when `streams` is present (the 12 existing fixtures carry none, so their snapshots stay byte-identical). Adds `tools/build-dfa-fixture.ts` and the fully-synthetic `dfa-equipped` golden fixture (7 Ride sessions with generated per-second dfa_a1/artifacts/heartrate/watts streams, no sanitizer, no real data), which populates `capability.dfa_a1_profile` in the oracle snapshots at confidence=high with non-null lt1/lt2 estimates. The builder ends with a non-vacuity guard recomputing the sufficiency + crossing-band thresholds; PII allowlist scan + `.sha256` checksum extended to the new fixture.

  Pure dev-time + oracle infra — athletes don't notice.

- 38773bf: De-identify the three real-data Reference test fixtures (realistic-athlete,
  capability-qualifying, curve-equipped): every embedded calendar date is shifted
  back one full Gregorian cycle (28 years) to a synthetic epoch, and the few real
  account identifiers used as test literals are replaced with synthetic
  placeholders. The 28-year shift preserves weekday, month-day, time-of-day, and
  all relative spacing, so every windowed metric value is bit-identical — only
  date labels change (verified: zero non-date value diffs vs the prior snapshots,
  all parity gates green). Adds `pnpm check:fixture-privacy`, a shape-based CI lint
  that blocks real-shaped account ids and current-era dates from re-entering
  committed fixtures, and shifts the sanitizer/builders so future regenerations
  de-identify automatically.

  Internal test-fixture + dev-tooling change; no runtime behavior change.

- 4defe74: User-facing: If the coach can't fully reset your previous session, it now says so ("some earlier context may still apply") instead of failing silently.

  Memory flushes now return a structured outcome ({writes, ledgerAppends,
  finishReason, usage, shrunkSections}) instead of discarding the model
  result. A flush that writes nothing on a non-trivial conversation, or
  that shrinks a memory section by more than 30%, emits a structured warn
  event (char counts only — never section content). The flush trigger
  paths gain bounded retry and a degradation policy that defers the
  session archive when extraction visibly failed.

- e2370e6: Mirror the snapshot harness's event/benchmark kwarg surface into the fuzz-parity
  oracle twin. The twin hardcoded `past_events=[]` and `benchmark_indoor` /
  `benchmark_outdoor` to the `(None, None, None)` insufficient-history stub, which
  is false for the populated-benchmark-and-consistency fixture: that fixture
  carries indoor/outdoor FTP history, so the twin's stub fed the null branch while
  the real TS path computed the populated branch, producing a guaranteed false
  MISMATCH on `benchmark_indoor`, `benchmark_outdoor`, `consistency_index`, and
  `consistency_details`. The twin now reads the five optional fixture keys
  (`past_events`, `current_ftp_indoor`/`outdoor`, `ftp_history_indoor`/`outdoor`)
  through the contract tracker — all allowlisted in `optionalFixturePaths` — and
  hands the FTP data to the upstream's own `_calculate_benchmark_index`, matching
  the snapshot harness line-for-line. Absent keys reproduce the prior stub so the
  fixtures carrying none stay byte-identical; the populated branch now actually
  runs. The three harness twins stay independent reimplementations of the same
  logic shape.

  Pure dev-time oracle infra — athletes don't notice.

- 3ff70ac: Mirror the snapshot harness's hoist surface into the fuzz-parity oracle twin so
  its differential covers the metrics whose values flow through the hoist blocks
  rather than the flat `_calculate_derived_metrics` dump. The fuzz oracle now
  carries the full hoist surface the pyodide snapshot harness and native CPython
  twin already emit: three value-emitting hoists — the per-activity
  `has_intervals` and `effort_response_signal` classifier maps and the
  `weight_signal` block — plus the explosion of the nested `capability` dict into
  `capability.<sub>` sibling keys. Without them the fuzz oracle emitted nothing
  for those keys and the `?? null` mask silently compared the real TS value
  against null, so the hoisted metrics (`has_intervals`, `effort_response_signal`,
  `weight_signal`, and the `capability.*` sub-key metrics) reported a spurious
  mismatch on every run. The hoist blocks reparse the raw fixture JSON to bypass
  the contract tracker (matching the snapshot harness) and run on the success path
  before the final serialize, with the capability explosion after the
  contract-violation guard so a violation still short-circuits. The three harness
  twins stay independent reimplementations of the same logic shape.

  Pure dev-time oracle infra — athletes don't notice.

- 4e76fe9: User-facing: Fixed the default Google model: setups that never chose a model now use gemini-2.5-flash, replacing the retired gemini-2.0-flash that made the coach fail to respond.

  The google provider's hardcoded default pointed at gemini-2.0-flash, retired
  by Google on 2026-06-01, so env-only deployments hard-errored on every call.
  CONTEXT_WINDOWS gains a gemini-2.5-flash entry (1,000,000) so the model
  resolves its real window instead of the 200,000-token fallback.

- 6ff60a6: Extract the snapshot harness's four-way lockstep surface into one
  language-neutral contract file (`tools/harness-contract.json`). The
  optional-path allowlist (previously duplicated across the pyodide harness,
  the fuzz-parity differential, and the README — three copies that had already
  diverged), the fixture-key → derived-kwarg conditions, and the power/HR
  delta-window day-offsets now live in a single source of truth that the two
  TypeScript files read through `tools/harness-contract.ts` and the two Python
  twins `json.load` relative to their own path. Each file keeps its own logic —
  only the literal data moves — so the twins stay independent reimplementations
  and the cross-interpreter diff remains a real check. The README's allowlist
  block is now test-asserted against the contract rather than hand-synced, and
  `packages/core/tests/harness-contract.test.ts` adds source-level drift
  tripwires that fail if any harness file re-grows an inline copy of the
  extracted literals. Pure refactor: snapshot regeneration is byte-identical,
  the native diff is 0 divergences on the realistic / curve / dfa fixtures, and
  the fuzz-parity failure set is unchanged.

  Pure dev-time + oracle infra — athletes don't notice.

- c397a32: Adds an append-only event ledger (memory/events.jsonl) recording dated
  athlete events — decisions, overrides, illness, experiments, outcomes —
  with a closed kind enum and host-stamped timestamps. The memory flush
  gains a ledger_append tool and an event-extraction prompt clause so these
  events are captured durably instead of being lost at extraction time.
- b95107a: User-facing: The coach now records when each remembered fact was last confirmed and flags facts older than six months for re-confirmation.

  Every memory section write stamps an "\_updated: YYYY-MM-DD" first body line
  (athlete-timezone date, idempotent restamp), and the memory-extraction prompt
  now requires a source and as-of date on durable facts, keeps existing dates
  on unchanged facts, and appends "(re-confirm)" to facts older than six months.

- 66fd011: User-facing: The coach can now look back through past daily notes and logged events by date — ask "what did we note in March?" and it retrieves the actual record instead of forgetting everything older than today.

  Adds a memory_query tool ({from, to, query?}) doing an index-free, case-insensitive
  substring scan over dated daily-note files plus the append-only event ledger, and a
  static recall-before-answering system-prompt rule. Tool definition and prompt rule
  are cache-stable (no per-turn variance).

- 2078151: Every destructive memory write (section replace, plan overwrite, section
  rename) now appends a journal line to memory/MEMORY.history.jsonl before
  mutating: {ts, op, section, oldBody, newBody, source}. The journal is
  append-only, 0600, best-effort (a journal failure warns and never blocks
  the write), and makes silent fact loss reconstructible by replay. Write
  paths now declare their source (chat-tool, flush, sport-tool, migration).
- e4b1b7e: User-facing: cycling-coach now requires Node.js 22 or newer.

  The advertised runtime floor was raised from Node 20 (end-of-life
  2026-04-30) to Node 22 across the workspace package manifests and the
  install docs, matching the only Node versions any first-party runtime
  (CI, the published Docker image, the release pipeline) actually uses.

- e0ba166: Extend the Reference layer's parity gate (`pnpm check-parity`) with an
  `--oracle=section-11|external|both` mode (default `section-11`,
  byte-for-byte unchanged). The external mode cross-checks the
  `curve-equipped` fixture's integer-floored mean-max curve anchors (power
  win1/win2, HR win1/win2, sustainability power + HR) against an independent
  external oracle that recomputes the same mean-max quantities from the same
  underlying rides — grounding the fixture curves the ported capability
  metrics consume in a second computation. The oracle emits floats and the
  fixture floors them (intervals.icu convention), so the gate enforces the
  documented `fixture == floor(oracle)` relation; the per-quantity tolerance
  and coverage live ONLY in `tools/intentional-deviations.yaml`'s new
  `external_coverage` section (the gate refuses any tolerance kind not
  declared there, and never accepts an inline or CLI-tunable epsilon).
  `--oracle=both` runs the section-11 bit-identity matrix and the external
  cross-check and fails if either leg fails (a declared external quantity
  with no snapshot is a both-mode failure, not a skip); a run that finds zero
  covered quantities exits non-zero rather than passing empty. The seven
  immutable external-oracle snapshot wrappers ship under
  `external-oracle-snapshots/curve-equipped/`; the per-ride CP-model file is
  retained but recorded as uncovered (the athlete-level eFTP/W'/PMax in our
  fixtures are config inputs, so the cross-check anchors on the mean-max
  curves).

  Pure dev-time + oracle tooling — athletes don't notice.

- 1b22189: Port the Reference layer's `capability.dfa_a1_profile` metric — DFA-alpha1 LT1/LT2 threshold estimation from per-second AlphaHRV streams. The full pipeline is transliterated line-by-line: the streams-assembly path joins each fixture `streams` record (keyed by `String(activity.id)`) back to the activities array, runs each record carrying a `dfa_a1` channel through the per-session DFA block builder (sentinel-zero + artifact filtering, validity gate, percentile/TIZ-band rollups, first-vs-last-third drift, LT1/LT2 crossing-band HR/watts estimates), and feeds the qualifying sessions into the profile aggregator (latest sufficient session + per-sport-family trailing window with confidence tiers and indoor/outdoor watts split for cycling). The 12 stream-free fixtures reproduce the null profile byte-for-byte; the stream-equipped fixture populates the full cycling block bit-identically against the oracle snapshot (confidence high, lt1 {hr 141, watts_outdoor 181}, lt2 {hr 169, watts_outdoor 261}). Numerically faithful: every `round()` site uses banker's rounding on the exact double (including Python's no-arg `round(x)` integer form), and float `sum()` sites use compensated summation to match CPython 3.12+.

  Pure Reference-layer + oracle parity work — athletes don't notice yet.

- 48ded71: Port the Reference layer's `capability.sustainability_profile` metric — the per-sport race-estimation lookup table. For each active sport family carried in the `sustainability_curves` input, it extracts observed mean-maximal power and max sustained HR at sport-specific anchor durations from a single 42-day window, and (cycling only) layers two predicted-power models: Coggan duration factors (FTP × factor) and the CP/W' model (P = CP + W'/t, CP approximated by athlete-set FTP). The single 42d window is gated on the harness having fetched the curve bundle, so the 12 curve-free fixtures reproduce the bare null block byte-for-byte; the curve-equipped fixture populates the full cycling block (observed watts/HR, W/kg, %LTHR, Coggan + CP/W' predicted watts, model divergence) bit-identically against the oracle snapshot. Transliterates the upstream's `_build_sport_thresholds` (athlete `sportSettings` array → per-family threshold map) and `_is_indoor_cycling` helpers; reads `power_model.w_prime` from the same live power-model extraction the scalar passthroughs use, and walks the weight fallback chain (wellness_7d → wellness_extended → athlete weight).

  Pure Reference-layer + oracle parity work — athletes don't notice yet.

- 5c44291: User-facing: When the model provider asks the coach to back off, waits are now capped at 2 minutes — a huge provider-requested delay can no longer freeze the chat for hours.

  Clamps the header-derived retry wait in the chat retry loop to a named 120 s ceiling at the existing backoff site (the 30 s cap previously bound only the locally computed fallback). The existing rate-limit warn line now reports the provider-requested value when clamping occurs.

- 2443476: User-facing: ACWR (load freshness ratio) now computed in the reference layer — the first load-management metric with bit-identical parity against the upstream protocol.

  - Added `packages/core/src/reference/metrics/load-management.ts` with `computeAcwr`. Line-by-line port of `sync.py:3023-3028` + `sync.py:3629-3644` (`_get_daily_tss`). Cites Gabbett 2016 (Br J Sports Med 50:273-280, DOI 10.1136/bjsports-2015-095788) for the underlying acute/chronic load model.
  - Registered ACWR in `tools/check-metric-parity.ts`'s `METRIC_REGISTRY`. The gate signature now passes `{ fixture, frozenNow }` to compute functions so date-relative math can match the snapshot anchor.
  - Extended `tools/snapshot-section-11.ts` to iterate over an explicit `HARNESS_FIXTURES` allowlist (realistic-athlete + new-athlete-empty + data-gap-mid-history), with per-fixture `frozenNow`. Fixtures owned by other test suites (the reference test substrate's `post-break-resume`, `zero-activities`) live alongside but are intentionally excluded from the snapshot harness.
  - New golden fixtures:
    - `new-athlete-empty.json` — zero activities, zero wellness, zero ftp_history; forces every "no data" branch (ACWR returns `null` from `chronic_load <= 0`).
    - `data-gap-mid-history.json` — 21 activities split by a 28-day gap; the resumed week populates the acute window while chronic is mostly depleted, so ACWR resolves to 3.51 (above-1.5 spike territory).
  - Bit-identical parity holds across all 3 fixtures: `pnpm check-parity --metric=acwr --fixture=all` exits 0 with `0.81 / null / 3.51`.

  No deviation registered in `tools/intentional-deviations.yaml` — ACWR is a faithful transliteration. Discipline: ADR-0016 (metric porting, local design record).

- 54e242a: Rename the Reference layer's thin per-sport projection type `PowerCurveDelta` to `PowerCurveDeltaSummary` on the `ReferenceSportAdapter` seam. This is a type-only rename with zero behavior change; it disambiguates the thin public projection shape returned by `computePowerCurve` from the rich internal compute type of the same name, so a single projection module can import both without a name collision.
- 83c77a4: Add the Reference layer's recommendation-metadata + audit-log substrate. Two
  new `.strict()` Zod schemas — `RecommendationMetadata` (the citations /
  confidence / frameworks / phase-tag contract every coaching reply carries) and
  `AuditLogEntry` (the on-disk `.audit.jsonl` line shape) — plus an
  `AUDIT_SCHEMA_VERSION` constant. The writer (`writeAuditEntry`) atomic-appends
  one compact JSONL line per reply via `open(path, "a")` (O_APPEND), creating the
  data dir on first write; it is best-effort and never throws, warning per
  failure and escalating once via `console.error` after 10 cumulative failures in
  a session. The parser (`parseAuditLog`) streams the log, dispatches on
  `schema_version` before the schema parse, and is robust to manual corruption —
  malformed JSON and unknown-version lines are skipped with a warn, a missing
  file yields an empty iterable. `computeResponseHash` derives the 16-char reply
  fingerprint stored on each entry.

  Trust-substrate only — this ships the schema + writer/parser but does not yet
  wire them into the live reply path. Athletes notice nothing until a later wave
  plumbs the writer into the coaching turn.

- 12c13b6: Land the Reference layer's curve pipeline: the input schemas gain optional `power_curves`, `hr_curves`, `sustainability_curves`, `streams`, and `athlete` keys (exact upstream kwarg shapes); the snapshot harness and its native/fuzz/coverage twins destub the curve / power-model inputs in lockstep, deriving the date windows and sport thresholds ONLY when the matching fixture key is present (existing fixtures stay byte-identical). Adds `tools/build-curve-fixture.ts` and the `curve-equipped` golden fixture (sanitized real rows + synthetic curve blocks attached after the sanitizer), which populates `capability.power_curve_delta`, `capability.hr_curve_delta`, `capability.sustainability_profile`, and the six power-model scalars in the oracle snapshots. PII allowlist scan + `.sha256` checksum extended to the new fixture.

  Pure dev-time + oracle infra — athletes don't notice.

- 4393d22: User-facing: Reference now recognizes mountain-bike, gravel, and e-bike rides as cycling activities.

  Widened the `IntervalsActivityType` union and the cycling sport's `intervalsActivityTypes` to include `MountainBikeRide`, `GravelRide`, and `EBikeRide`, so these rides route to the cycling adapter and reconcile with the cycling sport-family counts. The per-metric internal cycling gates are unchanged, so efficiency, durability, and consistency continue to treat e-bike rides as out of scope.

- acd483a: User-facing: Training-intensity distribution is now computed in the reference layer — the 7-day zone breakdown, the grey-zone / quality-intensity / easy-time shares, and the Seiler 3-zone time-in-distribution (7-day and 28-day, all-sport and primary-sport) with the Treff polarization index and a polarized / pyramidal / threshold classification.

  - Added the distribution metrics to `packages/core/src/reference/metrics/distribution.ts` — line-by-line ports of `_get_activity_zones`, `_aggregate_zones`, `_aggregate_seiler_zones`, `_build_seiler_tid`, `_calculate_polarization_index`, and `_classify_tid` (`sync.py:3683-3993`). Seiler 3-zone intensity model per Seiler 2010 (Int J Sports Physiol Perform 5(3):276-291); polarization index per Treff et al.
  - All registered in `tools/check-metric-parity.ts`'s `METRIC_REGISTRY`; bit-identical against the oracle across the realistic-athlete + boundary fixtures (`pnpm check-parity --all` exits 0).
  - Bit-identity hardening on the load + distribution metrics:
    - `roundHalfEven` rewritten as an exact dyadic-rational round (matches CPython `round()` on every boundary) and hoisted into one shared `metrics/rounding.ts` imported by both metric modules.
    - `total_time` and `selectPrimarySport` now reproduce the oracle's grouped, Neumaier-compensated summation order instead of a flat accumulator, so a fractional `secs` can't drift a rounding boundary.
    - `icu_zone_times` is constrained to object-form only; the HR-zone reader guards a non-numeric bin so a malformed array can't poison the zone sums.
  - Added a differential fuzz-parity harness (`tools/fuzz-parity.ts`) that runs randomized fixtures through both the oracle and the TS registry and fails on any divergence, vacuous run, oracle error, or contract violation.

  No deviations registered in `tools/intentional-deviations.yaml` — all faithful transliterations under the metric-porting discipline (literature-or-revert; no architect intuition).

- 0b9381f: Reference substrate — architect-review follow-ups on top of the test-substrate landing.

  - **Tightened the `metrics/` re-export gate.** Added a second describe block to `tests/reference-strict-schemas.test.ts` that scans `metrics/*.ts` for `export const *Schema` declarations and asserts each appears in the `metrics/index.ts` barrel. Previously the README's Rule 1 ("every metric schema must be re-exported") was reviewer-enforced — the existing `length > 0` check still passed because the cache barrel supplied the count, so a missed future re-export would slip through. Skipped today because no metric schemas declared yet; activates when the first metric schema lands.
  - **Branded the rename layer's return types** so the anti-corruption boundary (ADR-0012) is enforced at the type level. `renameTpFieldsOnActivity` / `renameTpFieldsOnWellnessRow` now return `RenamedActivityRow` / `RenamedWellnessRow` (phantom-branded with a `unique symbol`). Two new helpers `parseRenamedActivity(row)` and `parseRenamedWellnessRow(row)` accept only branded input — a sync-path author who calls `ActivitySchema.parse(apiResponse)` directly bypasses the rename layer; the parse helpers turn that bypass into a type error. Defense-in-depth only — the schemas remain publicly exported, so the brand catches forgetfulness, not malice. Pair with `assertNoTpKeysRemain` for nested-aggregate drift.
  - **Stripped the section-11 attribution comment from `metrics/index.ts`.** The barrel is a project-original contract scaffold (it adapts no upstream code); per the just-merged commit `dc5bca4` discipline, attribution belongs only on files that genuinely originate from section-11.
  - **Documentation.** `metrics/README.md` Rule 1 now points at the mechanical gate; Rule 3 gains the rule-of-three corollary ("and when the third metric does need it, extract it"). `reference/CONTEXT.md`'s metric-wiring obligation now tells future authors to go through `parseRenamedActivity` / `parseRenamedWellnessRow` instead of calling the schemas directly.

  Pure-infra changeset — athletes don't notice; this tightens drift gates that protect future metric authors.

- 3418139: Reference test substrate — privacy hardening + review-feedback polish

  - Inverted the fixture sanitizer from denylist to allowlist (`tests/helpers/sanitize-fixture.ts`). Default-deny: every key outside the schema-derived allowlist is dropped. The prior denylist missed several operator-identifying fields (`power_meter_serial`, `power_meter`, `source` on activity rows, `skyline_chart_bytes`, `athlete_max_hr`, `lthr`, hardware vendor names) — now removed structurally. `realistic-athlete.json` regenerated and shrunk from 347KB to 70KB.
  - Replaced the PII regression scanner with a single allowlist assertion that walks the committed fixture and asserts every key appears in `ALLOWED_FIXTURE_KEYS`. Adds a defense-in-depth check that every `*_id` value is the redacted sentinel.
  - Hardened the rename layer (`reference/sync/rename-tp-fields.ts`) to throw on collisions where the input has both a TP source key and a non-null rename target. Null targets ride through (the real `atl`/`fatigue: null` pattern intervals.icu ships).
  - CLI (`tools/sanitize-fixture.ts`) now rejects unrecognized `--<flag>` arguments with a non-zero exit + stderr listing known flags. Prior CLI silently swallowed typos like `--force-overrride`.
  - Property-test arbitraries: `icu_efficiency_factor` is null when `average_heartrate` is null (same physical constraint as `decoupling`/`pa_hr`). `icu_training_load` and `icu_intensity` wrapped in `fc.option` to exercise the `undefined` branch (WeightTraining shape).

  Pure-infra changeset — athletes don't notice; the change tightens the privacy boundary on a test fixture.

- e72da79: Port the Reference layer's `capability.hr_curve_delta` — the shift in max sustained heart rate at four anchor durations (60s, 300s, 1200s, 3600s) across two adjacent 28-day windows, with a `rotation_index` summarising whether the shift is intensity-biased (positive) or endurance-biased (negative).

  - Added `computeHrCurveDelta` to `packages/core/src/reference/metrics/capability.ts` — a line-by-line transliteration of `_calculate_hr_curve_delta` (sync.py:4441-4586). There is no 5s anchor (peak HR at 5s is just max HR, not an energy-system signal) and no sport filter (HR is cross-sport physiological). HR curve entries carry the `values` key (bpm) where power curves carry `watts`. Curves are matched by the `r.{start}.{end}` id string; a missing id is a silent-null branch. Per-anchor `pct_change` rounds via the exact `roundHalfEven` half-to-even helper; the rotation mean uses the compensated `pythonSum` for parity with the oracle's CPython 3.12+ `sum()`.
  - The delta reuses `power_curve_dates` (the call site at sync.py:3210 passes the power tuple), so the window dates are gated on the harness having fetched `power_curves` — HR curves without power dates reproduce the dateless null block byte-for-byte. The 12 fixtures without curves keep the null shape while the curve-equipped fixture populates `rotation_index` -3.3 with non-null per-anchor entries.
  - Registered `capability.hr_curve_delta` in `METRIC_REGISTRY`; the parity matrix asserts bit-identical match across all 13 fixtures. No deviation registered — faithful port. Discipline: ADR-0016 (metric porting, local design record).

  Pure derived-metric compute — surfaces as coaching context, no athlete-facing command change.

- 83c77a4: Add the Reference layer's Layer-1 sync gate. The previously-stubbed
  `gateLatestJson` now runs seven mechanical checks before a snapshot is written —
  data-fetch presence, FTP source resolvability, weekly-hours consistency,
  value-tolerance bands, 24h freshness, clock-offset drift, and multi-metric
  conflict. Checks use resolve-or-skip semantics (an absent signal passes, so the
  empty-data path is never bricked; only present-and-invalid values fail). Hard
  failures block the write and record error state; soft warnings still write, and
  a fully clean sync clears stale error state after the commit marker. Downstream
  of the metrics layer — it only reads and checks already-computed values, it does
  not recompute any metric.
- 83c77a4: Add the Reference layer's Layer-2 response validator and Layer-3 grounding
  prompt rules. `validateRecommendation` parses the `---meta---` block a reply
  carries, walks dot-paths into the latest snapshot, and asserts every cited value
  exists and matches (±0.01 tolerance for numbers, strict equality for everything
  else). `validateAndRetry` orchestrates an optional single regeneration (a hard
  one-retry cap) across three modes (off / observe / enforce, default observe).
  The Layer-3 data-grounding rules are appended to the system prompt so numeric
  claims trace back to the snapshot read this turn. The validator is not yet wired
  into the live reply path; that lands with the cutover wave.
- 42c937b: Wire live intervals.icu data into the Reference sync. The production fetcher now
  pulls the athlete profile, a trailing window of activities and wellness, and a
  bounded, best-effort set of per-activity HRV/power streams, runs them through the
  ADR-0012 rename anti-corruption layer, bridges the result to the metric-compute
  input shape (`FetchedReference` → `MetricInput`), and runs the full metric
  registry — so `latest.json` carries real `recent_activities` and a computed
  `derived_metrics` block instead of empty stubs.

  New modules: `fixture-bridge.ts` (pure bundle → `FixtureShape`/`MetricInput`
  assembly), `compute-derived-metrics.ts` (registry runner with per-metric failure
  isolation), and `fetch-live-bundle.ts` (the abort-aware, bounded live fetch +
  rename boundary). The stream loop is capped, cycling-only, and bounded by a
  wall-clock sub-budget so a slow account cannot exhaust the sync timeout; a
  malformed row or failed stream is skipped with a warning rather than failing the
  whole sync. Stream responses are normalized from the API's array-of-channels
  (and camelCased keys) into the channel-keyed shape the DFA-α1 block consumes, and
  the metric date-window anchor uses naive local time so it lines up with
  intervals.icu's local-time activity dates. A hard fetch/assembly failure (or a
  surviving trademark-named key) is converted into a failed sync that writes
  `error_state.json` for the curator, rather than escaping the sync uncaught.

  `derived_metrics` keeps its `z.unknown()` typing and the per-window
  power/HR/sustainability curve fetch is not yet wired (those capability metrics
  reproduce their null blocks until it lands); both are tracked as follow-ups. The
  `history`/`intervals`/`routes`/`ftp_history` retention cache files keep their
  stubs. Metric math is untouched — parity stays green (559/559).

  Internal sync-plumbing change; no athlete-facing output change yet.

- 04b4b50: Port the Reference layer's `capability.power_curve_delta` — the shift in mean-maximal power at five anchor durations (5s, 60s, 300s, 1200s, 3600s) across two adjacent 28-day windows, with a `rotation_index` summarising whether gains are sprint-biased (positive) or endurance-biased (negative).

  - Added `computePowerCurveDelta` to `packages/core/src/reference/metrics/capability.ts` — a line-by-line transliteration of `_calculate_power_curve_delta` (sync.py:4297-4439). Curves are matched by the `r.{start}.{end}` id string (never by list index); a missing id is a silent-null branch. Per-anchor `pct_change` rounds via the exact `roundHalfEven` half-to-even helper; the rotation mean uses the compensated `pythonSum` for parity with the oracle's CPython 3.12+ `sum()`.
  - The window dates are derived from the snapshot's frozen clock ONLY when the fixture carries `power_curves` (mirroring the upstream's fetch gate), so the 12 fixtures without curves reproduce the dateless null block byte-for-byte while the curve-equipped fixture populates `rotation_index` 5.3 with non-null per-anchor entries.
  - Registered `capability.power_curve_delta` in `METRIC_REGISTRY`; the parity matrix asserts bit-identical match across all 13 fixtures. No deviation registered — faithful port. Discipline: ADR-0016 (metric porting, local design record).

  Pure derived-metric compute — surfaces as coaching context, no athlete-facing command change.

- d56b4c4: Port the Reference layer's six power-model scalar passthroughs — `eftp`, `w_prime`, `w_prime_kj`, `p_max`, `power_model_source`, and `vo2max`. These are a single passthrough family: the upstream extracts the live cycling estimates from today's wellness row (the latest row in the 28-day window) via `_extract_power_model_from_wellness`, finding the first `type == "Ride"` sportInfo dict and reading camelCase `eftp`/`wPrime`/`pMax` with Python-`round` semantics (1-decimal eFTP and W'-kJ, integer W' and P-max, all guarded by Python truthiness), plus `vo2max` straight off the row. No computation. New `packages/core/src/reference/metrics/power-model.ts` mirrors the extraction line-by-line and the harness's `athlete`-key gate (absent athlete → the empty-power-model state, every key null); the six compute functions register in the metrics registry. Bit-identical against the committed oracle across all 13 fixtures (curve-equipped populated, the other twelve null). Unit tests cover the populated paths the oracles can't reach — the Ride-selection loop, the truthiness gates, the round boundaries, and the latest-in-window row selection.

  Internal Reference-layer + oracle work — athletes don't notice.

- a5a1b44: Add `tools/fetch-streams.ts` — a dev-time fetcher for the per-activity raw streams and per-athlete power/HR/sustainability curve sets used to author the Reference layer's curve- and stream-driven fixtures. Reads the secondary intervals.icu account, caches each raw response under `referenceDataDir("cycling-coach")/streams/`, is idempotent (skip-if-cached), and throttles requests serially. The snapshot harness never reads this cache — it is operator scratch only.

  Pure dev-time infra — athletes don't notice.

- 3418139: Reference test substrate + anti-corruption layer.
  Lands the privacy-denylist sanitizer (`tools/sanitize-fixture.ts`), the
  schema-checked fixture loader (`tests/helpers/load-fixture.ts`), the
  property-test arbitraries (`tests/helpers/reference-arbitraries.ts`), the
  `tests/fixtures/` directory with its first golden + synthetic fixtures,
  and the trademark-wall mechanical assertion
  (`tests/reference-input-schemas-no-tp.test.ts`).

  Repairs `ActivitySchema` in `src/reference/schemas/inputs.ts` to match
  intervals.icu API reality (design decision: real shape
  rides through `z.looseObject` unmodified). Surfaces revealed by piping a
  real 12-week pull through the substrate:

  - `Activity.id` accepts `string | number` (the API uses both forms).
  - `Activity.average_watts`, `average_heartrate`, `icu_training_load`,
    `icu_intensity` are now `.optional()` — real activities can lack a power
    meter (no Ride power data), an HR strap, or a load score (WeightTraining).
  - `icu_zone_times` / `pace_zone_times` / `hr_zone_times` accept the union
    `Array<number | { id?, secs }>` via the new shared `ZoneTimeEntrySchema`,
    and are `.nullable()` because the API writes `null` (not just absent)
    for activities lacking the series.

  Adds the anti-corruption layer (ADR-0012) between intervals.icu's
  TP-trademarked API fields and the project's typed surface:

  - `src/reference/trademark-policy.ts` — single source of truth for
    `TP_API_FIELDS` (7) and `TP_DENYLIST_FIELDS` (10). Migrates the
    sanitize helper and the no-TP regression test to import from it.
  - `src/reference/sync/rename-tp-fields.ts` — `renameTpFieldsOnWellnessRow`,
    `renameTpFieldsOnActivity`, and a defensive `assertNoTpKeysRemain`
    recursive walker (uses `[<index>]` paths only — no row-id leakage).
  - `schemas/inputs.ts` — 5 new wellness fields (`fitness`, `fatigue`,
    `fitnessContribution`, `fatigueContribution`, `weeklyFitnessChange`)
    and 2 new activity fields (`fitnessAtEnd`, `fatigueAtEnd`).
  - `tools/sanitize-fixture.ts` — pipeline now reads raw bundle → rename →
    `assertNoTpKeysRemain` → sanitize → atomic write. Non-number TP values
    surface as a stderr aggregate-warn so operator drift fails loudly.
  - `tools/fetch-real-athlete.ts` — operator fetch CLI promoted from the
    gitignored `scripts/` directory; the two tools now form one operator
    pipeline.
  - Regenerated `tests/fixtures/golden/realistic-athlete.json` with plain-
    English keys throughout; future metric tests consume `fitness` /
    `fatigue` / `fitnessAtEnd` directly without reaching into the
    index-signature underlay.

  Pure-infra; no athlete-visible changes.

- 00ada91: Refresh the realistic-athlete golden test fixture so it carries the current
  sanitizer pass-through field surface. The committed golden predated the
  `icu_variability_index` and per-activity heart-rate-recovery pass-through fields
  the sanitizer now emits (0 occurrences in the stale golden vs 38 each after a
  fresh regen), which kept the fixture-stability test red. Regenerating the golden
  from the same source dump through the current sanitizer restores those fields;
  the calendar-shift, account-id, and trademark-rename invariants all still hold,
  and the refresh was re-verified bit-identical through both snapshot runtimes
  (WASM + native twin) and the full parity gate. With the variability-index field
  now present, the variability-filtered capability sub-metrics qualify sessions as
  expected — efficiency-factor and durability snapshots move to their correct
  non-empty values — and every other fixture's snapshots stay byte-identical. No
  Reference-layer metric code changed.

  Internal test-fixture refresh; no runtime behavior change.

- 496b068: User-facing: Archived chat sessions are now kept indefinitely by default — previously only the 20 most recent were kept; a new retention setting lets you opt into age-based cleanup.

  Session reset archives were pruned to the newest 20 per chat, silently
  deleting the only copy of older conversations before any extraction
  substrate exists. The count-based prune is removed; a new
  session.resetArchiveRetentionDays config knob (env:
  SESSION_RESET_ARCHIVE_RETENTION_DAYS, default 0 = keep forever) provides
  opt-in age-based pruning instead. Archive file permissions are unchanged.

- 3418139: Reference test substrate — sanitizer home + fixture checksum (follow-up to #100)

  - Moved the fixture sanitizer from `packages/core/tests/helpers/sanitize-fixture.ts` to `tools/sanitize-fixture-transform.ts`. The sanitizer is operator tooling (one CLI consumer, run on the operator's laptop) — `tools/` is the right home alongside `check-trademarks.ts` and `fetch-real-athlete.ts`. Tests now import the transform via `tools/sanitize-fixture-transform.js` (dependency direction matches lifecycle: tests verify operator-produced artifacts).
  - Added `realistic-athlete.json.sha256` next to the committed fixture. CI verifies the two match on every run via `realistic-athlete-fixture-checksum.test.ts` — catches accidental in-place mutation (bad merge, editor save, formatter pass) that the operator-only byte-stability test doesn't see. The sanitize CLI now emits the checksum alongside the JSON, so operator regens stay in sync.
  - CONTRIBUTING.md gained a "Fixture stewardship" subsection naming the regen flow, the checksum guard, and the reviewer obligation when schema additions widen the allowlist.

  Pure-infra changeset.

- ad3b710: User-facing: Operator pairing now requires sending a one-time code shown in your terminal, so a stranger racing you to the bot during setup can no longer claim ownership.
  User-facing: /update now installs the exact version it verified against the registry, with dependency install scripts disabled.
  User-facing: Health data, session transcripts, and memory files are now written owner-only (0600 files in 0700 directories) on every deployment path, and old session archives are pruned automatically.
  User-facing: The automatic startup update check can be disabled with CYCLING_COACH_NO_UPDATE_CHECK=1; it is now disclosed in the README's privacy section.
  User-facing: Running with CYCLING_COACH_DM_POLICY=open now prints a loud startup warning and logs each non-allowlisted sender it serves.

  Security-hardening pass across the bot's trust boundaries:

  - File permissions: all JSON/JSONL/markdown writers create files 0600 and data
    directories 0700; the data-dir tightening that previously ran only on
    allowlist writes is now an unconditional startup invariant; pre-existing
    world-readable files are tightened on rewrite. Session reset archives are
    capped at the newest 20 per chat.
  - Telegram output: raw reply text is HTML-escaped before markdown conversion
    (only converter-emitted tags survive), and a reply that Telegram rejects for
    entity-parse errors is retried as plain text instead of being dropped.
  - Prompt-injection containment: athlete memory is fenced in the system prompt
    as data-not-instructions, an untrusted-data handling rule covers tool
    results, and the codex-bridge tool loop now validates tool arguments against
    their schema before execution (parity with the AI SDK providers).
  - OAuth: refresh failures retry once before being classified as token reuse,
    refreshes are serialized per profile, profile writes are atomic, and the
    pinned pi-ai dependency is patched to stop logging token-endpoint response
    bodies on malformed responses.
  - Operator capture: pairing-code gated, queued pre-start updates dropped,
    capture confirmations default to decline on bare Enter.
  - Setup wizard: secret storage defaults to a detected keychain/1Password
    backend instead of plaintext; config dir/file permissions tightened on
    re-run.
  - Supply chain: GitHub Actions pinned to commit SHAs with Dependabot coverage,
    Docker base images pinned by digest, the container runs as the non-root
    node user, corepack's pnpm download is integrity-pinned, and the privacy
    lint now scans .changeset and root markdown surfaces.

- 63a1184: User-facing: A damaged conversation file no longer blocks the chat — unreadable lines are set aside and the rest of your conversation loads normally.

  User-facing: /start now tells you when a session reset fails instead of replying with the usual welcome as if it had succeeded.

  The session JSONL loader tolerates torn or malformed lines: invalid lines
  are quarantined verbatim to a timestamped .corrupt sidecar next to the
  session file, the session file is rewritten with only the valid lines, and
  loading never throws on corruption. The pre-reset session read is now
  best-effort (warn and archive anyway), so the reset path can no longer be
  gated behind a successful read of the state it exists to discard.

- dae2ea0: Consolidate the pure-UTC `YYYY-MM-DD` date-key arithmetic into one shared
  `io/` leaf util. The midnight-UTC parse, the milliseconds-per-day constant,
  the epoch-ms-to-key format, the calendar-validity round-trip, and the
  inclusive-range convention were hand-inlined across the dated-recall tool and
  the daily-notes range reader; they now live in a single internal module so the
  two call sites can no longer drift on the inclusivity convention or the
  midnight-UTC suffix. Behavior-neutral: every pre-existing test stays green with
  no assertion changes.
- dc40cb2: Stop the single-fixture debug snapshot regen from clobbering the manifest. The
  `SNAPSHOT_FIXTURE_PATH` debug path processes one fixture but used to rewrite
  `manifest.json` from that single slug — silently dropping every other fixture
  from the index (their snapshot files on disk untouched, only the manifest lied)
  and collapsing the metric union down to the one fixture's metrics. The debug
  path now MERGE-patches instead: it unions the processed slug into the existing
  fixtures + metrics lists and preserves the rest, leaving a manifest byte-identical
  to a full regen. It refuses loudly (non-zero exit) when no manifest exists yet
  (a debug regen presumes an initialized snapshot tree) or when the existing
  manifest's oracle coordinates — upstream sha / protocol version / commit date /
  pyodide version — diverge from the current toolchain, so a stale-coordinate
  partial manifest can't land. The manifest builders are extracted into their own
  module and unit-tested, including a hermetic byte-identity gate that reconstructs
  the committed manifest from the on-disk snapshot tree without booting the WASM
  oracle; the full-regen path's manifest output is preserved byte-identical. The
  snapshot-index smoke test now asserts the full fixture allowlist rather than a
  single slug, closing the asymmetric hole where a debug regen of that one named
  slug would corrupt the index unasserted.

  Pure dev-time + oracle infra — athletes don't notice.

- edc9db6: Section-11 snapshot harness — pyodide-driven oracle generator for the Reference metric port.

  - Added `tools/snapshot-section-11.ts` (root script: `pnpm snapshot:section-11`). Runs the section-11 Python `_calculate_derived_metrics` against a checked-in golden fixture via pyodide and writes every per-metric output to `packages/core/tests/fixtures/snapshots/<athlete>/<metric>.json` plus a top-level `manifest.json` pinning the upstream SHA, protocol version, pyodide version, and frozen-clock anchor.
  - Offline-safe via Option A (stub `requests` module + invoke `_calculate_derived_metrics` directly with fixture-constructed args). No network calls; pyodide's stdlib delivers bit-identical IEEE-754 math to upstream.
  - Captured 52 metrics from the `realistic-athlete` fixture against section-11 SHA `224c369d` (protocol v3.112). Per-metric files are the oracle that future TS metric ports will assert against — this PR ships the harness only, no parity assertions.
  - One Vitest smoke test (`reference-metrics-snapshot-loop.test.ts`) proves the snapshot is loadable and the manifest pins what it claims to pin.
  - pyodide v0.29.4 added as a root devDependency (~5MB; never ships to athletes).

  Pure-infra changeset.

- 75a9943: Gate the snapshot-harness regen on a green native runtime-parity diff. The oracle snapshot regen now, after writing the pyodide snapshots, runs the host-CPython twin against every just-regenerated fixture and asserts bit-identity before the command succeeds. A divergence throws — the regen exits non-zero with a per-fixture diff and a `git checkout` revert pointer — so a CPython-vs-WASM drift (`math.fsum`/`statistics`/float-repr) can no longer silently land in committed snapshots. The new gate sources each fixture's frozen-now from the snapshot it just wrote rather than a hardcoded default, so the de-identified real-data fixtures (anchored a full Gregorian cycle back after the calendar shift) don't go false-red. A loud `--skip-native-check` / `SKIP_NATIVE_CHECK=1` escape hatch prints a banner naming exactly what was not cross-checked; a missing `uv` is a hard, instructive failure rather than a silent pass. The pure snapshot comparators are extracted into their own exported functions (CLI behavior preserved) and unit-tested, and the native twin gains the `past_events` + benchmark pass-through it was missing so the two harness paths are back in lock-step. The gate lives only on the local regen path; CI never regenerates and never needs `uv`. The single-fixture debug regen path (`SNAPSHOT_FIXTURE_PATH`) now resolves the allowlisted per-fixture anchor instead of unconditionally using the default — a wrong-anchor regen of an allowlisted fixture is structurally invisible to the gate (it mirrors whatever anchor was written), so the anchor must be right at write time.

  Pure dev-time + oracle infra — athletes don't notice.

- d829e74: User-facing: The coach now saves important details to long-term memory proactively as a long conversation approaches its condensing point, instead of waiting until older messages are about to be dropped.

  When the loaded history exceeds 80% of its token budget and at least five
  messages have arrived since the last proactive save, the agent runs a
  memory flush before building the turn, so facts reach durable memory while
  the full raw history still exists. A per-chat in-memory cooldown prevents
  repeated flushes; trim-time flushes count toward it and session resets
  clear it. A flush failure warns and never blocks the turn.

- e2a6017: Reword shipped prose and code comments that pointed at local-only design artifacts (internal initiative/ticket identifiers, paths under the gitignored design-docs tree, and one third-party project name that project policy keeps out of shipped surfaces). Pending changeset bodies were reworded the same way so the next release's CHANGELOG inherits clean text. No behavior change — comments, docs, and one test title only.
- 315639a: User-facing: Condensing a long conversation can no longer hang or fail your message — summarization now times out after two minutes and the coach continues with the best summary it has.

  Every staged-summarization LLM call now runs under a 120 s race-only
  deadline (classified as a timeout by the existing error classifier).
  summarizeInStages degrades instead of throwing: a failed chunk falls back
  to the carried summary, and with no summary at all it head-drops the
  oldest messages so the turn can proceed. The overflow/timeout rescue
  paths rethrow the ORIGINAL turn error with any rescue failure attached
  as its cause, so summarization failures can no longer mask the error
  that actually ended the turn.

- 3e61ba6: Wired a workspace-wide typecheck gate into `pnpm check`: the aggregator now runs the per-package `tsc --noEmit` checks plus a new root `check:types` leg (`tsconfig.check.json`) covering `tools/` and `packages/*/tests/`, and all pre-existing type errors were paid down behavior-preservingly (test-side casts/annotations, restored exhaustiveness guards in the Reference layer's sync reply formatter, an explicit type argument on the scheduler's persisted-state read, and a real bigint mtime assertion in the sanitize CLI test). Pure dev-time infra — athletes don't notice.
- 4c9d762: Scope the root test runner's collection to the project tree so stale agent
  worktrees under `.claude/` are no longer crawled. The root vitest config now
  extends vitest's default `exclude` with `**/.claude/**`, so the throwaway copies
  of the suite that live in agent scratch worktrees stop being collected — they had
  been amplifying a known load-dependent flake and adding spurious failures (one
  worktree also carried a missing build artifact). The real suite is unchanged.

  Pure dev-tooling change — athletes don't notice.

## 0.0.1

### Patch Changes

- 4a4f538: User-facing: Tightened access — the bot now only responds to authorized Telegram senders. Existing operators: send `/start` once after upgrading, the bot prompts to claim ownership.

  Adds a per-user-ID allowlist to the Telegram channel. New behavior:

  - **Auth middleware** registered before any handler (factory-wrap pattern) filters every inbound message on `from.id`. Strangers in pairing mode get a one-time challenge with their own user-ID and instructions; allowlist mode silently drops.
  - **Migration:** no auto-claim. Default policy is `pairing` whenever `~/.cycling-coach/allowed-senders.json` is missing. On interactive startup (TTY), the bot prompts to claim. Headless paths fall back to pairing-mode + CLI claim.
  - **CLI:** `cycling-coach add-sender <id>`, `remove-sender <id>`, `list-senders`. PID lockfile serializes mutations.
  - **Persistence:** atomic `.tmp` + rename, mode `0o600`, dir mode tightened to `0o700`. Schema-validated on load with explicit fallback to `pairing` on malformed input. Transformer-pattern `saveAllowedSenders` ensures the read-modify-write cycle is atomic per process (closes a TOCTOU class).
  - **`notifyUpdate`** now filters its broadcast list against `allowFrom`, so pre-allowlist strangers' chat-ids stop receiving update pings.
  - **No proactive Telegram broadcast** under any branch (operator constraint). Migration diagnostics go to stderr only.

  Env vars: `CYCLING_COACH_OPERATOR_ID` (single ID, file precedence beats env), `CYCLING_COACH_DM_POLICY=open` (debug escape), `CYCLING_COACH_SETUP_CAPTURE_TIMEOUT_MS` (default 60s), `CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS` (default 5min).
