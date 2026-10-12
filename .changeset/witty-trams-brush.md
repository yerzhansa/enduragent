---
"@enduragent/kernel": patch
"@enduragent/core": patch
"@enduragent/engine": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: The coach shows the same fitness and fatigue numbers whether it reads synced days or looks them up live.
User-facing: A fatigue score you log yourself now shows as reported fatigue, apart from your training-load fatigue.
User-facing: If some wellness days cannot be read, the coach says days are missing.

`decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue` before the load averages are renamed, and rejects a row that already carries a coach-only key. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read one vocabulary in both modes. A row that cannot be decoded is skipped with a `notice`; when none can be decoded the read fails with `wellness_unreadable`. Capture, projection and the legacy sync still use the rename and parse pair. Second of six changes for #1130.
