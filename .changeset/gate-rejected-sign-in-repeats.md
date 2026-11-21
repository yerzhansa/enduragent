---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: After you sign in to intervals.icu again, today's plan now reaches your intervals.icu calendar the next time your plan refreshes. Before, the calendar could show "Calendar sync failed." until the next day.

While intervals.icu rejects the signed-in token, two calls that nobody asked for now wait for a working sign-in. Re-applying the same sign-in to a running coach no longer starts a store refresh, and the plan-calendar push leaves today's job untouched instead of using up its five attempts. Sync now still sends its requests, the first request after a coach start still detects the rejection, and a plain API key works as before.
