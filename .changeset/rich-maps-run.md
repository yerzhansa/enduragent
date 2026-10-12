---
"@enduragent/kernel": patch
"@enduragent/core": patch
"@enduragent/sync-intervals-icu": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Wellness days sync again, so the coach can see your resting heart rate, heart-rate variability, and sleep. A fatigue score you log yourself is kept apart from your training-load fatigue.

Every path that reads a platform wellness day now goes through `decodeWellnessRow`: capture, the paged pull, the stored projection, the legacy sync, capture replay, and the two fixture tools. `landWellnessRow` in the sync package turns one wire day into its archive identity and its typed store row. The store column `fatigue` holds only the self-reported score, and the field archive keeps the load averages under `load`. `renameTpFieldsOnWellnessRow`, `parseRenamedWellnessRow` and the injected wellness decoder are removed. A day with a value that cannot be stored is rejected whole. The paged pull names the key of a value it cannot store, and the fixture tool names the key of a day it cannot decode. Capture still skips that day without a count until the next change adds the per-lane report. Third of six changes for #1130.
