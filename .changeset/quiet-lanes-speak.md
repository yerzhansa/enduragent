---
"@enduragent/sync-intervals-icu": patch
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: If a sync cannot keep any of the wellness days it fetched, the coach now says the sync failed instead of saying you have no data.
User-facing: If a sync keeps only some of the wellness days it fetched, the coach now says how many of the days you asked about are missing.

`laneHealth` reads a lane's report as `ok`, `partial` or `lost`, and `judgedDrops` lists the drops it judges: every drop except rows the provider withheld, with recordings whose download failed left out. `laneStanding` pairs that health with the civil dates of the judged drops. `runReferenceCapture` returns the report beside the manifest. The store runtime logs `capture_lane_lost` or `capture_lane_partial` with the lane, its counts and up to five judged drop lines, still publishes the capture, and hands the wellness lane's standing to the store reader. The reader answers a lost lane with `wellness_unreadable`, and a partial lane with a `notice` that counts only the dropped days inside the requested range. A dropped row without a civil date is logged and adds no notice. The capture command prints one line per lane that dropped a row, with `dropped=` for judged drops, `withheld=` for rows the provider withheld, `first_drop=` taken from the judged drops and `first_unfetched=` for a failed request. It exits 3 when a lane is lost, and reads the failure category through the store writer's wrapper. A capture named by `--replaces` is loaded and replayed before the first request and the first store write, and a capture that cannot be is refused with nothing written. The store runtime logs that refusal as `capture_replacement_refused` with the capture id. Sixth of six changes for #1130.
