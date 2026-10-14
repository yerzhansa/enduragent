# @enduragent/sync-intervals-icu

## 0.1.3

### Patch Changes

- 1b37d2b: A reference capture now returns a report beside its records. For each of the four lanes (settings, activities, wellness, streams) the report holds the rows fetched, the rows landed, and one drop record for every fetched row that did not land. A drop record names the lane, the row's index, a checked id and date, the step that failed, the reason, and the field. It never holds a value or an error message. A recording whose download failed is listed apart, because no row arrived. The capture loop no longer skips a row without counting it, and an error in wellness landing that is not a row rejection now fails the capture. The batch field `dropped_activity_rows` is replaced by `activityDropEvidence(batch.report.activities)`. Fourth of six changes for #1130.
- 0852155: User-facing: If a sync cannot keep any of the wellness days it fetched, the coach now says the sync failed instead of saying you have no data.
  User-facing: If a sync keeps only some of the wellness days it fetched, the coach now says how many of the days you asked about are missing.

  `laneHealth` reads a lane's report as `ok`, `partial` or `lost`, and `judgedDrops` lists the drops it judges: every drop except rows the provider withheld, with recordings whose download failed left out. `laneStanding` pairs that health with the civil dates of the judged drops. `runReferenceCapture` returns the report beside the manifest. The store runtime logs `capture_lane_lost` or `capture_lane_partial` with the lane, its counts and up to five judged drop lines, still publishes the capture, and hands the wellness lane's standing to the store reader. The reader answers a lost lane with `wellness_unreadable`, and a partial lane with a `notice` that counts only the dropped days inside the requested range. A dropped row without a civil date is logged and adds no notice. The capture command prints one line per lane that dropped a row, with `dropped=` for judged drops, `withheld=` for rows the provider withheld, `first_drop=` taken from the judged drops and `first_unfetched=` for a failed request. It exits 3 when a lane is lost, and reads the failure category through the store writer's wrapper. A capture named by `--replaces` is loaded and replayed before the first request and the first store write, and a capture that cannot be is refused with nothing written. The store runtime logs that refusal as `capture_replacement_refused` with the capture id. Sixth of six changes for #1130.

- 1e3c8f9: User-facing: Wellness days sync again, so the coach can see your resting heart rate, heart-rate variability, and sleep.
  User-facing: A fatigue score you log yourself is kept apart from your training-load fatigue in synced days.

  Every path that turns a platform wellness day into a `WellnessDay` now goes through `decodeWellnessRow`: capture, the paged pull, the stored projection, the legacy sync, capture replay, and the two fixture tools. The raw fetch tool `tools/fetch-real-athlete.ts` still writes days as the platform sends them. `landWellnessRow` in the sync package turns one wire day into its archive identity and its typed store row. The store column `fatigue` holds only the self-reported score, and the field archive keeps the load averages under `load`. `renameTpFieldsOnWellnessRow`, `parseRenamedWellnessRow` and the injected wellness decoder are removed. A day with a value that cannot be stored is rejected whole. The paged pull names the key of a value it cannot store, and the fixture tool names the key of a day it cannot decode. Capture still skips that day without a count until the next change adds the per-lane report. Third of six changes for #1130.

- Updated dependencies [d4be2cf]
- Updated dependencies [1e3c8f9]
- Updated dependencies [aae19b5]
  - @enduragent/kernel@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [b30d963]
  - @enduragent/kernel@0.1.2

## 0.1.1

### Patch Changes

- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.
- f65201d: User-facing: Training History now marks only the dates affected by dropped activities as incomplete. Open weeks and comparison callouts no longer claim totals for days that have not finished.
- Updated dependencies [39902fa]
- Updated dependencies [09c5ca3]
- Updated dependencies [b2ddccb]
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [30ca87f]
- Updated dependencies [9ed12a5]
- Updated dependencies [9a9665f]
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

- 517a34f: Add the Reference layer intervals.icu source with archive-first activity, stream,
  wellness, sport-setting, and FIT hydration plus deterministic activity revisions.
  Private infrastructure; ships nothing to athletes.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- c0714a0: Accept millisecond-precision settings update instants in the local bundle supersession.
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
