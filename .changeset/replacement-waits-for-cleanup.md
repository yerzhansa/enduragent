---
"@enduragent/kernel": patch
"@enduragent/coach-contract": patch
"@enduragent/coach": patch
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: When you replace a Plan, the new Plan's workouts now reach your intervals.icu calendar only after the old Plan's workouts are removed, so the two Plans never share a day.
User-facing: If removing the old Plan's workouts fails, the active Plan shows "Calendar sync failed. Retry available." and Retry calendar keeps working even after repeated failures.

The calendar drain runs cleanup jobs before mirror jobs and holds the active Plan's mirror while the latest cleanup of another Plan is not verified. Once it is verified, the mirror starts from that cleanup's first day, so today's old Workout stays and the new Plan starts tomorrow. The Plan library shows a failed cleanup on the active card. A cleanup failure now always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanup jobs so the drain runs them once past the five-failure budget; automatic retries still stop at five. An athlete whose older cleanup already used its budget will see the active Plan's calendar wait with Retry after updating.
