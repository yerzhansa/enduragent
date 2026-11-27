---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: After your Mac wakes from sleep, your training data now starts refreshing within a minute if a scheduled sync was missed while it slept. Before, with the app window closed, it could stay out of date for up to six more hours.

The six-hour store refresh now waits in steps of at most one minute and runs once the wall clock reaches the six-hour mark. Before, it waited on one timer for the whole gap. macOS does not count sleep time toward that timer, so a Mac that slept past the mark synced up to six hours late unless something else woke the coach. A wall clock set back a little no longer runs the refresh just before the mark and then again at it.
