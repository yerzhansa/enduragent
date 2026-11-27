---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: When intervals.icu stops accepting your sign-in, your Plan no longer says "Updating calendar" while nothing is being sent; it asks you to connect instead. After you sign in again, your planned workouts go to your intervals.icu calendar right away, without waiting for you to open Plan or for the next sync.

The Plan calendar status and the plan-creation calendar line now treat a rejected intervals.icu sign-in as not connected, using the same check as the plan calendar drain. The 24-hour stale-sync pause on Plan Changes and the Supporting Event candidates still count any saved sign-in, so a rejected one neither lifts the pause nor hides synced races. Every store window, including the refresh after a new sign-in, now kicks the calendar drain when it finishes.
