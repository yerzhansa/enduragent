---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
"@enduragent/kernel": minor
---

User-facing: The Calendar has a Plan details panel with your Plan's dates, progress and history, and with Replace Plan and End Plan. Ending a Plan keeps today's workout and any workout you changed in intervals.icu, unless you choose to remove those too.

The `plan.calendar` RPC gains `plan-details` (history from applied Plan Changes, plus what End would remove, keep for today, and leave as the athlete's own) and `save-end-choice`, which stores the athlete's ticks for the cleanup run before the existing `plan.close`.
