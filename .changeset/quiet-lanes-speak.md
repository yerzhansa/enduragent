---
"@enduragent/sync-intervals-icu": patch
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: If a sync cannot keep any of the wellness days it fetched, the coach now says the sync failed instead of saying you have no data.
User-facing: If a sync keeps only some of the wellness days it fetched, the coach now says how many days are missing.

`laneHealth` reads a lane's report as `ok`, `partial` or `lost`, leaving out rows the provider withheld and recordings whose download failed. `runReferenceCapture` returns the report beside the manifest. The store runtime logs `capture_lane_lost` or `capture_lane_partial` with the lane, its counts and up to five drop lines, still publishes the capture, and hands the wellness lane's standing to the store reader. The reader answers a lost lane with `wellness_unreadable` and a partial lane with a `notice`. The capture command prints one line per lane that dropped a row, exits 3 when a lane is lost, and reads the failure category through the store writer's wrapper. A capture named by `--replaces` is loaded and replayed before the first request and the first store write, and a capture that cannot be is refused with nothing written. Sixth of six changes for #1130.
