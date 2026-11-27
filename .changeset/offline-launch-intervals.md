---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If you open Enduragent without a network connection, it now reconnects to Intervals.icu by itself once the network is back. Until then, Sync tells you Intervals.icu isn't connected instead of saying your training data is synced.

When main re-applies the saved intervals.icu sign-in and the coach refuses it as `ownership-unavailable`, main retries the saved keys after 15 s, 1, 2, 5, 10 and 15 min, waits without spending an attempt while the Mac is offline, restarts the schedule when the Mac wakes, and stops on shutdown. In the window, a sync that the coach skips for a missing key while a sign-in is saved fails as `not-in-use` with its own message. While Sync is in that state the window re-reads the coach's runtime configuration every 30 s and on focus, and syncs once when the coach has the key. The touched sync files no longer swallow errors silently.
