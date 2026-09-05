# @enduragent/sport-cycling

## 0.0.7

### Patch Changes

- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- f6cacbb: Add forward-only race-readiness projections, explicit unavailable and changed-assumption states, refresh recovery, and taper safety refusal without mutating the active Plan.
- 3ad0c39: Show every active Plan week with phase, purpose, status, and planned time, plus a complete authoritative race-week schedule with separate training, race, and total accounting.
- 1594b20: Retire prompt instructions written for earlier models: remove the completed memory-section migration clause from the flush prompt, drop two redundant conduct rules and a numeric bullet cap from the cycling soul, soften two shouting registers, and give plan_save a real tool contract. Also drop the retired `.ralph/` gitignore entry.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

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

## 0.0.6

### Patch Changes

- e2ef5f7: User-facing: Cycling Coach now waits for you to ask before proposing a workout, while still creating workouts you explicitly request.

  Add cycling's unauthored-envelope capability metadata and disabled autonomous-prescription posture.

- 037a09a: Upgrade the Intervals.icu client to 0.3.1 and keep canonical managed activities separate from the snake_case Reference persistence boundary.
- 89a6522: Migrate managed calendar writes to the Intervals.icu client's canonical camelCase request contract.
- 0afbcad: User-facing: Local coaching can read historical athlete data from the training store and disclose when it was last synchronized.
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

## 0.0.5

### Patch Changes

- e31ab52: Refactor shared workout-date validation, confirmation outcomes, proposal lookup, event provenance, and sport tool construction without changing behavior.
- Updated dependencies [e31ab52]
- Updated dependencies [1e40c2e]
- Updated dependencies [49844fa]
- Updated dependencies [03964f0]
  - @enduragent/core@0.1.2

## 0.0.4

### Patch Changes

- Updated dependencies [34c4bd4]
- Updated dependencies [bdbb513]
  - @enduragent/core@0.1.1

## 0.0.3

### Patch Changes

- 1d414e5: User-facing: The coach now mirrors your wording — it explains efforts in plain feel-language unless you used the technical term first, names the signal behind every recommendation, and the cycling zone numbers it prescribes now match the mainstream 7-zone scheme your head unit uses.

  Cross-sport voice rules (register-mirroring, name-your-basis, and scoped reply structure — reviews → prose, quick answers → direct, prescriptions → one step per line) move into Core's system-prompt builder, so they apply to every sport; the contradictory SOUL copies and the duplicate trademark substitution table are deleted, leaving exactly one table in Core's review block. The session-cluster gap becomes a sport-persona field Core renders generically instead of a hardcoded per-sport string. Cycling zone vocabulary aligns to the mainstream 7-zone numbering — sweet spot is taught as the named 88-94% sub-range rather than its own integer, threshold moves to Z4, and the zone-intensity midpoints are re-keyed so the calendar Load estimate agrees with the band a serialized zone step actually demands; the heart-rate cross-reference closes its gap and caveats that heart rate is an unreliable target above threshold. Periodization and taper numbers are steered to the deterministic plan tool instead of transcribed in skill prose, with a guard test pinning the dedup. The trademark lint now scans the per-sport skill markdown and SOUL files with a line-level skip directive.

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

## 0.0.2

### Patch Changes

- 2078151: Every destructive memory write (section replace, plan overwrite, section
  rename) now appends a journal line to memory/MEMORY.history.jsonl before
  mutating: {ts, op, section, oldBody, newBody, source}. The journal is
  append-only, 0600, best-effort (a journal failure warns and never blocks
  the write), and makes silent fact loss reconstructible by replay. Write
  paths now declare their source (chat-tool, flush, sport-tool, migration).
- 4393d22: User-facing: Reference now recognizes mountain-bike, gravel, and e-bike rides as cycling activities.

  Widened the `IntervalsActivityType` union and the cycling sport's `intervalsActivityTypes` to include `MountainBikeRide`, `GravelRide`, and `EBikeRide`, so these rides route to the cycling adapter and reconcile with the cycling sport-family counts. The per-metric internal cycling gates are unchanged, so efficiency, durability, and consistency continue to treat e-bike rides as out of scope.

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

## 0.0.1

### Patch Changes

- Updated dependencies [4a4f538]
  - @enduragent/core@0.0.1
