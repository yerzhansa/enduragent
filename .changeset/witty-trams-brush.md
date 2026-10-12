---
"@enduragent/kernel": patch
"@enduragent/core": patch
"@enduragent/engine": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: In live lookups the coach now tells the fatigue score you log apart from your training-load fatigue. It also says when wellness days could not be read.

`decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue`, renames the load averages, and parses the day. It rejects a row that already carries a coach-only key, a score that is not a whole number, and a load average that is not a number. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read coach words in live mode. A row that cannot be decoded is skipped with a `notice` that names the unreadable keys; when none can be decoded the read fails with `wellness_unreadable`. Capture, projection and the legacy sync still use the rename and parse pair, so synced days change in the next step. Second of six changes for #1130.
