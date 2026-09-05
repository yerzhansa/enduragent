# running-coach

## 0.0.8

### Patch Changes

- 48f6422: User-facing: Diagnostic logs now hide sensitive error text and credential-bearing URLs. Secret helper failures show an exit code and setup guidance without exposing helper output.
- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [2d09c46]
- Updated dependencies [3627ecd]
- Updated dependencies [48f6422]
- Updated dependencies [eba82b9]
- Updated dependencies [2567965]
- Updated dependencies [a415177]
- Updated dependencies [3627ecd]
- Updated dependencies [4018b25]
  - @enduragent/core@0.1.4
  - @enduragent/sport-running@0.1.4

## 0.0.7

### Patch Changes

- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [8619dc3]
- Updated dependencies [68e2a75]
- Updated dependencies [61a8940]
- Updated dependencies [0115dfe]
- Updated dependencies [b4e5365]
- Updated dependencies [78971cb]
- Updated dependencies [a42fb2c]
- Updated dependencies [2e61329]
- Updated dependencies [1977c1b]
- Updated dependencies [67369bb]
- Updated dependencies [810b29e]
- Updated dependencies [e932ede]
- Updated dependencies [517a34f]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [22364df]
- Updated dependencies [0d1ad65]
- Updated dependencies [118c2a6]
- Updated dependencies [89a6522]
- Updated dependencies [0afbcad]
- Updated dependencies [b25c3c1]
  - @enduragent/core@0.1.3
  - @enduragent/sport-running@0.1.3

## 0.0.6

### Patch Changes

- Updated dependencies [e31ab52]
- Updated dependencies [1e40c2e]
- Updated dependencies [49844fa]
- Updated dependencies [03964f0]
  - @enduragent/core@0.1.2
  - @enduragent/sport-running@0.1.2

## 0.0.5

### Patch Changes

- Updated dependencies [34c4bd4]
- Updated dependencies [bdbb513]
  - @enduragent/core@0.1.1
  - @enduragent/sport-running@0.1.1

## 0.0.4

### Patch Changes

- ffe679a: Auto-resolve the running critical-speed anchor from synced intervals.icu data so `calculate_zones` no longer depends on the LLM supplying it.

  Core gains `resolveRunningCs(latest)` (sharing one row-walk with the step-5 CS-source gate so the two cannot drift) and a per-turn `CoreDeps.resolvedCs` getter; the Telegram channel resolves the anchor from the latest synced profile each turn and passes it into `chat()`. The running `calculate_zones` tool makes `criticalSpeedMps` optional — it falls back to the synced anchor (manual `critical_speed` outranking platform `threshold_pace`), reports real provenance (`csSource` / `anchorOrigin` / `platformConfidence`), and returns a `no_cs_anchor` error rather than guessing when neither is present. The per-turn value is read lazily through a closure, so the prompt-template hash and cache prefix stay stable; non-running sports and the CLI path are unaffected.

- eb4b9a6: Land critical-speed-anchored running pace zones and make them reachable through the running-coach binary.

  `@enduragent/sport-running` now ships the `calculate_zones` tool (six CS-anchored pace zones), the running soul + skills, the athlete-profile schema, and a pace-based reference adapter. `@enduragent/core` gains a hard CS-source sync gate (step 5) that refuses to sync a running zone table from a missing or out-of-band critical-speed anchor, plus the `threshold_pace`/`critical_speed`/`cs_source`/`cs_confidence` fields on the sport-settings schema. The `running-coach` binary, previously a stub, now wraps the running sport via Core's `runBinary` — it runs from the workspace (externalized, still private/unpublished).

- Updated dependencies [a9d75f7]
- Updated dependencies [fabc7f7]
- Updated dependencies [f18878d]
- Updated dependencies [3003f2a]
- Updated dependencies [4eafde4]
- Updated dependencies [b64d7ac]
- Updated dependencies [96053cf]
- Updated dependencies [1e40e7d]
- Updated dependencies [698ad66]
- Updated dependencies [c8b9d74]
- Updated dependencies [82defb5]
- Updated dependencies [e7b8236]
- Updated dependencies [0c34c56]
- Updated dependencies [ffe679a]
- Updated dependencies [41f5b0e]
- Updated dependencies [eb4b9a6]
- Updated dependencies [73b3af4]
- Updated dependencies [383982b]
- Updated dependencies [65c8d82]
- Updated dependencies [0cd853b]
- Updated dependencies [12f522a]
- Updated dependencies [ebb0c3e]
- Updated dependencies [147e7e4]
- Updated dependencies [955990e]
- Updated dependencies [1079871]
- Updated dependencies [e755f86]
- Updated dependencies [1d414e5]
  - @enduragent/core@0.1.0
  - @enduragent/sport-running@0.1.0

## 0.0.3

### Patch Changes

- @enduragent/sport-running@0.0.3

## 0.0.2

### Patch Changes

- @enduragent/sport-running@0.0.2
