---
"@enduragent/kernel": patch
"@enduragent/core": patch
"@enduragent/engine": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: The coach now tells a fatigue score you log apart from your training-load fatigue when it looks up wellness straight from intervals.icu.
User-facing: The coach's wellness lookup now includes fitness and weekly fitness change for synced days.
User-facing: The coach now says when some wellness days could not be read.

`decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue`, renames the load averages, and parses the day. It rejects a row that already carries a coach-only key, a row that still holds a platform load key after the renames, a score that is not a whole number, and a load average that is not a number. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read coach words in live mode. A row that cannot be decoded is skipped with a `notice` that names the first unreadable wellness field of each skipped day. A day skipped for a platform load key or for not being an object is counted but not named; when none can be decoded the read fails with `wellness_unreadable`. Stored days are unchanged, but the tool's key list now passes `fitness` and `weeklyFitnessChange` for them. Capture, projection and the legacy sync still use the rename and parse pair. Second of six changes for #1130.
