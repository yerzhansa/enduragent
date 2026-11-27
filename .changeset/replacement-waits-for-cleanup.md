---
"@enduragent/kernel": patch
"@enduragent/coach-contract": patch
"@enduragent/coach": patch
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.
