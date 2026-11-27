---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: If you quit the app while your first sync is still downloading your intervals.icu history, the app now finishes that download by itself the next time you open it. Before, your older rides stayed missing until you pressed Sync now.

The coach's startup refresh now reads the saved history-download state: not started, in progress at a saved cursor, or complete. When a download is in progress, the refresh resumes it before the usual 84-day capture, inside the same store window, and the store lane stays free during each intervals.icu request. A complete download is left alone. A download that never started is left to the first sync that runs when Setup finishes. Nothing resumes while intervals.icu rejects the sign-in. If the resumed download fails, the startup refresh fails with it and is not retried at once. The scheduled refresh still runs at the six-hour mark, and the next launch or Sync now picks the download up again from its cursor.
