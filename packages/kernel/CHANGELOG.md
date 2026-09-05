# @enduragent/kernel

## 0.1.1

### Patch Changes

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
