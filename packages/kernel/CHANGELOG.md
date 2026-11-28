# @enduragent/kernel

## 0.2.0

### Minor Changes

- 71a5e7d: User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it with one reply on your own model; if that fails, the ride says so and spends nothing more until you press Write again. You can leave the coach a note on the ride that it reads when you write again, and Ask the coach, here and on a Calendar workout, now adds its question after whatever you have already typed in Chat.

  The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller, asks for low reasoning effort with a 600-token cap only where the provider honours it (OpenAI reasoning models, codex-agent; Anthropic keeps thinking off at 600) and otherwise keeps the provider's default effort with a 2,000-token cap, aborts before its lease runs out, never abandons a write whose job is still running, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`. `createWorkoutCardController` drops `composerEmpty` and prefills through `requestComposerPrefill`, like Activity review's Ask.

- df8343a: User-facing: A new Activity review page, below Calendar, lists your rides by Training Week and shows each ride's facts. When the app asks "Is this the Plan Workout?", answer yes, no, or another day's workout, and the Calendar shows your answer.

  The `plan.calendar` RPC gains `rides`, which runs the match refresher over the active Plan's part of the range and lists cycling rides with a ride-centric Plan Workout match and the Plan's Training Weeks, and `decide-ride`, which confirms a suggestion, turns it down as Extra, or matches the ride to another nearby workout, and refuses with `match-changed` when the match differs from the `expected` one the page showed. The Plan Workout match repository now lets the athlete take back a confirmed heuristic match and confirm a pairing turned down earlier, and never stores a second confirmed match, or a new suggestion, for a workout or ride that already has a confirmed one; `observe` returns null when it stores nothing and leaves an unchanged suggestion as it was. Confirming a match deletes the other suggestions for that workout and that ride, and the new `withdraw` deletes a suggestion or an intervals.icu pairing the system derived, never the athlete's own answers, so both come back when the evidence returns. The match refresher stores no length for a zero-length ride, withdraws an intervals.icu pairing the ride no longer carries, and the Plan page projection prefers a confirmed match over a suggestion. Turning down or moving a ride's match records its current intervals.icu pairing as unpaired, so the pairing does not come back. Matching a ride again to a workout whose intervals.icu pairing the athlete turned down clears that unpaired row (`clearUnpaired`) and stores the athlete's own match.

- 09a5e23: User-facing: A new Plan now waits for your Approve before anything reaches intervals.icu. The Calendar shows this Training Week and next as one set to approve, and Settings can make each later week wait for its own Approve. You can also turn on starting Enduragent at login so later weeks go out on time.

  Activation writes "waiting for Approve" in the same transaction. While the first Approve waits, later weeks show the day they will go out. The renderer gains a Start at login bridge over two trusted IPC channels, reusing the tray's durable login-item path.

- 2efcf2b: User-facing: The Calendar has a Plan details panel with your Plan's dates, progress and history, and with Replace Plan and End Plan. Ending a Plan keeps today's workout and any workout you changed in intervals.icu, unless you choose to remove those too.

  The `plan.calendar` RPC gains `plan-details` (history from applied Plan Changes, plus what End would remove, keep for today, and leave as the athlete's own) and `save-end-choice`, which stores the athlete's ticks for the cleanup run before the existing `plan.close`.

- 7cba733: User-facing: Replacing your Plan no longer changes intervals.icu until you approve, so Not now leaves your old Plan there. The Approve sheet lists the old Plan's workouts that come off from tomorrow on, and the new Plan's first two Training Weeks go on only after those are gone.

  Replace activation records a cleanup hold (migration 036, `plan_cleanup_hold`) instead of a cleanup job. The new Plan's first `approve-weeks` releases it in the same transaction through the engine's `athlete-approves-replacement` step, and can carry the athlete's ticked changes as the old Plan's close choice. Ending or completing the waiting Plan releases its holds, and the drain releases any hold whose replacement no longer waits. The `plan.calendar` read gains `replacing`.

- 3436f66: User-facing: Your Plan now keeps this Training Week and next on intervals.icu, sending each new week 7 days before it starts. Changes you make to a Plan workout in intervals.icu are kept instead of being put back by the app.

  The desktop calendar mirror sends whole Training Weeks and keeps intervals.icu's own read-back of each workout as its baseline. It writes only after re-reading the event and finding it unchanged, and never sends a write that changes nothing. End and Replace remove the old Plan's own workouts from tomorrow on, and leave today's workout and the ones the athlete changed. A new `plan.calendar` call approves weeks and saves the "Approve each week" setting.

- 1949824: User-facing: Enduragent now uses one FTP, the one in intervals.icu, shows each ride's FTP and FTP history on Activity review, and writes a coach's proposed FTP to intervals.icu only after you confirm. Chat's Change one thing no longer offers Correct FTP, past FTP changes stay in Plan history, and Plan details no longer shows old FTP guidance.

### Patch Changes

- 5de1cb7: User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
  User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

  The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.

## 0.1.4

### Patch Changes

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

## 0.1.3

### Patch Changes

- d4be2cf: User-facing: A wellness day that leaves out weight, resting heart rate, heart-rate variability, or sleep is no longer skipped.

  `WellnessDaySchema` required `weight`, `restingHR`, `hrv`, `sleepSecs` and `sleepQuality` to be present, so a day that omitted one failed to parse and was dropped. The five keys now default to `null`. First of six changes for #1130.

- 1e3c8f9: User-facing: Wellness days sync again, so the coach can see your resting heart rate, heart-rate variability, and sleep.
  User-facing: A fatigue score you log yourself is kept apart from your training-load fatigue in synced days.

  Every path that turns a platform wellness day into a `WellnessDay` now goes through `decodeWellnessRow`: capture, the paged pull, the stored projection, the legacy sync, capture replay, and the two fixture tools. The raw fetch tool `tools/fetch-real-athlete.ts` still writes days as the platform sends them. `landWellnessRow` in the sync package turns one wire day into its archive identity and its typed store row. The store column `fatigue` holds only the self-reported score, and the field archive keeps the load averages under `load`. `renameTpFieldsOnWellnessRow`, `parseRenamedWellnessRow` and the injected wellness decoder are removed. A day with a value that cannot be stored is rejected whole. The paged pull names the key of a value it cannot store, and the fixture tool names the key of a day it cannot decode. Capture still skips that day without a count until the next change adds the per-lane report. Third of six changes for #1130.

- aae19b5: User-facing: The coach now tells a fatigue score you log apart from your training-load fatigue when it looks up wellness straight from intervals.icu.
  User-facing: The coach's wellness lookup now includes fitness and weekly fitness change for synced days.
  User-facing: The coach now says when some wellness days could not be read.

  `decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue`, renames the load averages, and parses the day. It rejects a row that already carries a coach-only key, a row that still holds a platform load key after the renames, a score that is not a whole number, and a load average that is not a number. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read coach words in live mode. A row that cannot be decoded is skipped with a `notice` that names the first unreadable wellness field of each skipped day. A day skipped for a platform load key or for not being an object is counted but not named; when none can be decoded the read fails with `wellness_unreadable`. Stored days are unchanged, but the tool's key list now passes `fitness` and `weeklyFitnessChange` for them. Capture, projection and the legacy sync still use the rename and parse pair. Second of six changes for #1130.

## 0.1.2

### Patch Changes

- b30d963: User-facing: Long conversations recover from slow replies more reliably, and the app no longer pauses to tidy its log on every line it writes.

## 0.1.1

### Patch Changes

- 39902fa: User-facing: A reviewed Draft can now become your active Plan. Activating closes any Plan that was running and keeps your answers with the new Plan.
- 09c5ca3: Refresh runtime dependencies, including XML parser security fixes and desktop updater compatibility updates.

  User-facing: This update improves the safety of imported files and refreshes the libraries used for coaching and app updates.

- b2ddccb: User-facing: Plan creation in Chat can now build a Draft from your answers, with every week and Workout laid out under your confirmed limits. The Draft keeps the answers it was built from when you edit them.
- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 66579e6: User-facing: Chat safely resumes unfinished Plan handoffs after relaunch. Deleting Chat attachment data keeps delivered Plan work and its compact origin record intact.
- 8c20aef: User-facing: Workout handoffs from Chat now open the same reviewable Plan Proposal after retries or relaunch, while Draft and Plan-creation requests continue in their exact Plan conversation.

  Planning stores the destination artifact and request relation together, preserves date conflicts for review, and keeps delivery retryable when destination intake is temporarily unavailable.

- d6d960f: Chat can securely rebuild a selected Workout handoff and restore its current Plan status after relaunch.

  The daemon resolves local Workout details instead of trusting renderer-provided snapshots, and durable handoffs can be listed by their source conversation.

- dc24ae3: User-facing: Applying or rejecting a Chat-originated Plan Proposal now records the matching Chat result atomically, so relaunch cannot show a stale or contradictory handoff.

  Planning keeps revised Proposals attached to their originating request, rolls back the complete Plan change when terminal-result storage fails, and leaves calendar mirroring separate from local success.

- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 68bf244: Read selected activity files during processing and traverse XML without recursion.

  User-facing: Importing a batch of activity files uses less memory. Deeply nested GPX and TCX files no longer interrupt the import with a stack error.

- 30ca87f: User-facing: Backups made before the Planning storage update now restore successfully when they contain a replaced Plan. Current backups continue to restore the replacement history safely.
- 9ed12a5: User-facing: The Plan page can now read your unfinished Plan creation, your active Plan, and your closed Plans together.
- 9a9665f: Add a confirmation before discarding unfinished Plan Creation work in Chat.

  User-facing: Discard an unfinished Plan you started in chat without affecting your current Plan or your chat history.

- c507634: End an active Plan locally before removing tomorrow-onward Plan-owned Intervals workouts, with durable retry and verify-only recovery that preserves today and athlete-created events.
- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- b87174d: Replace an active Plan atomically while preserving today, verify tomorrow-onward cleanup of the old Plan before writing the replacement’s next seven days, and keep failures recoverable after relaunch.
- a52086c: Add Plan-scoped settings with immediate persistence and safely auto-apply eligible future workout duration reductions.
- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.
- 4018b25: Keep Training History freshness and calendar windows anchored to the current successful sync and the athlete's active timezone.

  User-facing: Training History now stays current after a successful sync that finds no new data, and its week boundaries follow your active timezone without requiring a restart.

- f65201d: User-facing: Training History now marks only the dates affected by dropped activities as incomplete. Open weeks and comparison callouts no longer claim totals for days that have not finished.

## 0.1.0

### Minor Changes

- 10c6d16: Add read-only local bundle projection for the Reference layer.

### Patch Changes

- 8ac6eec: Record one store-level owner fingerprint from the resolved intervals.icu athlete identifier at sync time, compare it read-only before credential saves, allow saves when the comparison is unavailable, and keep credential rotation independent from account ownership.
- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- ec24061: User-facing: Prevent ambiguous duplicate activity streams from producing misleading training analysis.
- 5428c22: Keep Reference layer projections cycling-only while retaining athlete-wide wellness and cycling FTP history. Internal infrastructure; ships nothing to athletes.
- 0ab935f: Add a trusted canonical-activity resolver and revision key for bounded ride analysis.
- 42c6efa: Decode FIT artifacts into deterministic local-store rows with content-derived
  keys, identity-preserving developer fields, aligned stream blobs,
  archive-first persistence, and byte-identical re-ingest verification.
- 517a34f: Add the Reference layer intervals.icu source with archive-first activity, stream,
  wellness, sport-setting, and FIT hydration plus deterministic activity revisions.
  Private infrastructure; ships nothing to athletes.
- c122f29: Invalidate cached session and date metrics for both replaced and incoming
  activity scopes.
- 111261c: Add deterministic dedup planning, authored confirmations, and stable import reporting.
- 4e996bc: Add the content-addressed raw-archive manager to the pure kernel and its Node
  host adapter: content-addressed artifact writes, gzipped canonical-JSON payload
  snapshots, quarantine routing for unparseable inputs, and a structurally
  never-delete, archive-first write surface behind the injected Crypto and
  FileSystem ports.
- 66fc866: Add the node:sqlite Storage-port driver, the pure repository-port layer
  (anchor-history insert-if-absent / read-current, raw_file and source_record
  upserts), and the INV-2 canonical ordered-logical-dump harness with an
  engine-stable float serializer.
- b8a8ef0: Add the local-first athlete store's schema v1 as a single numbered migration
  (Domains A–H) shipped bundled-as-string behind an ordered migration list on a
  new store/migrations subpath, with a migration-executes-and-is-FK-consistent
  test gate. Private-package infrastructure; ships nothing to users.
- 0b73876: Add strict TCX/GPX fallback parsing, deterministic quarantine reasons, and
  quality-ranked whole-concern arbitration that preserves higher-quality data.
- 00ee9f4: Persist per-source synchronization failures and keep mixed API and FIT activity presentations deterministic.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- 9a7961c: Relocate portable Reference layer and concurrency sources into the kernel,
  preserving core consumers through compatibility shims and explicit subpaths.
- ded6067: Add opt-in repair-fixer settings with deterministic derived-state rebuilds. Internal infrastructure; ships nothing to athletes.
- 336462d: Add atomic request reservations for bounded analytics refreshes.
- fd9cd3a: Add the sync-source contract, deterministic source revision state, and opt-in Retry-After lower-bound handling while preserving existing capped retries. Internal infrastructure; ships nothing to athletes.
