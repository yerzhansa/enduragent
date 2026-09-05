# @enduragent/sport-running

## 0.1.4

### Patch Changes

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
  - @enduragent/engine@0.0.3
  - @enduragent/kernel@0.1.1

## 0.1.3

### Patch Changes

- 037a09a: Upgrade the Intervals.icu client to 0.3.1 and keep canonical managed activities separate from the snake_case Reference persistence boundary.
- 89a6522: Migrate managed calendar writes to the Intervals.icu client's canonical camelCase request contract.
- Updated dependencies [8ac6eec]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [5428c22]
- Updated dependencies [61a8940]
- Updated dependencies [1977c1b]
- Updated dependencies [67369bb]
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
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [336462d]
- Updated dependencies [89a6522]
- Updated dependencies [fd9cd3a]
  - @enduragent/kernel@0.1.0
  - @enduragent/engine@0.0.2

## 0.1.2

### Patch Changes

- e31ab52: Refactor shared workout-date validation, confirmation outcomes, proposal lookup, event provenance, and sport tool construction without changing behavior.
- Updated dependencies [e31ab52]
- Updated dependencies [1e40c2e]
- Updated dependencies [49844fa]
- Updated dependencies [03964f0]
  - @enduragent/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [34c4bd4]
- Updated dependencies [bdbb513]
  - @enduragent/core@0.1.1

## 0.1.0

### Minor Changes

- ffe679a: Auto-resolve the running critical-speed anchor from synced intervals.icu data so `calculate_zones` no longer depends on the LLM supplying it.

  Core gains `resolveRunningCs(latest)` (sharing one row-walk with the step-5 CS-source gate so the two cannot drift) and a per-turn `CoreDeps.resolvedCs` getter; the Telegram channel resolves the anchor from the latest synced profile each turn and passes it into `chat()`. The running `calculate_zones` tool makes `criticalSpeedMps` optional — it falls back to the synced anchor (manual `critical_speed` outranking platform `threshold_pace`), reports real provenance (`csSource` / `anchorOrigin` / `platformConfidence`), and returns a `no_cs_anchor` error rather than guessing when neither is present. The per-turn value is read lazily through a closure, so the prompt-template hash and cache prefix stay stable; non-running sports and the CLI path are unaffected.

- eb4b9a6: Land critical-speed-anchored running pace zones and make them reachable through the running-coach binary.

  `@enduragent/sport-running` now ships the `calculate_zones` tool (six CS-anchored pace zones), the running soul + skills, the athlete-profile schema, and a pace-based reference adapter. `@enduragent/core` gains a hard CS-source sync gate (step 5) that refuses to sync a running zone table from a missing or out-of-band critical-speed anchor, plus the `threshold_pace`/`critical_speed`/`cs_source`/`cs_confidence` fields on the sport-settings schema. The `running-coach` binary, previously a stub, now wraps the running sport via Core's `runBinary` — it runs from the workspace (externalized, still private/unpublished).

- 73b3af4: Serialize structured running workouts and add the calendar-create running tool.

  `@enduragent/sport-running` now ships `serializeRunningWorkout` (pace-based steps → intervals.icu native step syntax) plus a gated `intervals_create_workout` tool that writes the workout to the intervals.icu calendar. Steps carry zone, critical-speed-fraction, or absolute-pace targets over time or distance, rendered so the server parses them into a structured workout (distances emit as km/mi so they are never misread as minutes); running Pace Load stays server-authoritative, so no client load is sent. `@enduragent/core` re-exports the critical-speed sanity band (`CS_MIN_MPS` / `CS_MAX_MPS`) as a single constant the running package now derives its band from.

### Patch Changes

- 41f5b0e: Add the running training-monitoring skill that governs how the coach discusses a runner's load trend, pace:HR decoupling, and DFA-α1 / aerobic-threshold material.

  `@enduragent/sport-running` now ships a `monitoring` skill (loaded as `running-monitoring`) plus a SOUL guardrail encoding the labeling discipline recorded in ADR-0026: running load is surfaced as a qualitative trend rather than an acute:chronic ratio value or sweet-spot/danger bands; no running DFA-α1 number of any kind is surfaced (conceptual discussion only, `dfaValidated=false`); an α1 reading near 1.0 is never presented as the aerobic threshold (the literature surrogate is ≈0.75); pace:HR decoupling is framed as a flat-terrain, pace-only read; and each evidence half carries its own grade banner alongside eight enumerated caveats. Copy and labeling only — no metric math changes.

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

## 0.0.3

### Patch Changes

- Updated dependencies [374b206]
- Updated dependencies [a7b7fe2]
- Updated dependencies [5e302b6]
- Updated dependencies [9c650bb]
- Updated dependencies [47969d6]
- Updated dependencies [4fdfcec]
- Updated dependencies [38773bf]
- Updated dependencies [4defe74]
- Updated dependencies [e2370e6]
- Updated dependencies [3ff70ac]
- Updated dependencies [4e76fe9]
- Updated dependencies [6ff60a6]
- Updated dependencies [c397a32]
- Updated dependencies [b95107a]
- Updated dependencies [66fd011]
- Updated dependencies [2078151]
- Updated dependencies [e4b1b7e]
- Updated dependencies [e0ba166]
- Updated dependencies [1b22189]
- Updated dependencies [48ded71]
- Updated dependencies [5c44291]
- Updated dependencies [2443476]
- Updated dependencies [54e242a]
- Updated dependencies [83c77a4]
- Updated dependencies [12c13b6]
- Updated dependencies [4393d22]
- Updated dependencies [acd483a]
- Updated dependencies [0b9381f]
- Updated dependencies [3418139]
- Updated dependencies [e72da79]
- Updated dependencies [83c77a4]
- Updated dependencies [83c77a4]
- Updated dependencies [42c937b]
- Updated dependencies [04b4b50]
- Updated dependencies [d56b4c4]
- Updated dependencies [a5a1b44]
- Updated dependencies [3418139]
- Updated dependencies [00ada91]
- Updated dependencies [496b068]
- Updated dependencies [3418139]
- Updated dependencies [ad3b710]
- Updated dependencies [63a1184]
- Updated dependencies [dae2ea0]
- Updated dependencies [dc40cb2]
- Updated dependencies [edc9db6]
- Updated dependencies [75a9943]
- Updated dependencies [d829e74]
- Updated dependencies [e2a6017]
- Updated dependencies [315639a]
- Updated dependencies [3e61ba6]
- Updated dependencies [4c9d762]
  - @enduragent/core@0.0.2

## 0.0.2

### Patch Changes

- Updated dependencies [4a4f538]
  - @enduragent/core@0.0.1
