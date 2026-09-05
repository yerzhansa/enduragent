# @enduragent/kernel-node

## 0.1.1

### Patch Changes

- 68bf244: Read selected activity files during processing and traverse XML without recursion.

  User-facing: Importing a batch of activity files uses less memory. Deeply nested GPX and TCX files no longer interrupt the import with a stack error.

- 30ca87f: User-facing: Backups made before the Planning storage update now restore successfully when they contain a replaced Plan. Current backups continue to restore the replacement history safely.
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [30ca87f]
- Updated dependencies [c507634]
- Updated dependencies [e649a25]
- Updated dependencies [b02a1e8]
- Updated dependencies [b87174d]
- Updated dependencies [a52086c]
- Updated dependencies [6546ba5]
- Updated dependencies [2567965]
- Updated dependencies [a415177]
- Updated dependencies [4018b25]
- Updated dependencies [f65201d]
  - @enduragent/kernel@0.1.1

## 0.1.0

### Minor Changes

- 10c6d16: Add read-only local bundle projection for the Reference layer.

### Patch Changes

- a17fdef: Add the per-athlete store-home resolver (the one-athlete `store`/`archive`/`config`
  layout with an ENDURAGENT_HOME override) and an idempotent FTP-history seeder that
  maps legacy per-binary FTP history into cycling anchor rows, insert-if-absent by
  (sport, anchor type, effective date), and no-ops cleanly on the empty-on-real-install
  case.
- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- d36c593: Add the governed Reference layer sync composition root and share the existing Node writer lifecycle. Internal infrastructure; ships nothing to athletes.
- 180df32: Attribute coach store writer failures precisely: recognize write-lock contention across bundle copies by error name, and carry the underlying failure cause through the writer result onto the thrown error.
- e20ada6: Add the internal localhost daemon core, authenticated RPC projection, wall-clock scheduler, and safe newer-store refusal.
- 42c6efa: Decode FIT artifacts into deterministic local-store rows with content-derived
  keys, identity-preserving developer fields, aligned stream blobs,
  archive-first persistence, and byte-identical re-ingest verification.
- a2ac0c4: Reject unmanifested activity fixtures and validate canonical fixture metadata before activity bytes enter the repository.
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
- 0b73876: Add strict TCX/GPX fallback parsing, deterministic quarantine reasons, and
  quality-ranked whole-concern arbitration that preserves higher-quality data.
- 51cd022: Add macOS service installation, status, restart, and fail-closed service-owner arbitration for the internal enduragent executable.
- 00ee9f4: Persist per-source synchronization failures and keep mixed API and FIT activity presentations deterministic.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- ded6067: Add opt-in repair-fixer settings with deterministic derived-state rebuilds. Internal infrastructure; ships nothing to athletes.
- edbc0a1: Release the writer lock cleanly after liveness probes or other peer connections.
- Updated dependencies [8ac6eec]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [5428c22]
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
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [336462d]
- Updated dependencies [fd9cd3a]
  - @enduragent/kernel@0.1.0
