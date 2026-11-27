---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: If you quit the app while your first sync is still downloading your intervals.icu history, the app now finishes that download by itself the next time you open it. Your recent rides still show up right away, and the older ones fill in after. Before, your older rides stayed missing until you pressed Sync now.

The coach's startup refresh publishes the usual 84-day snapshot first, as before. Then the coach reads the saved history-download state: not started, in progress at a saved cursor, or complete. Only a download in progress resumes, in a store window of its own that captures again when the download finishes. The store lane stays free during each intervals.icu request. A complete download is left alone. A download that never started is left to the first sync that runs when Setup finishes. Nothing resumes while intervals.icu rejects the sign-in. A failed resume is logged as `history_download_resume_failed` and changes neither the startup refresh nor the six-hour schedule. The next launch or Sync now picks the download up again from its cursor. Quitting the app stops the resumed download.
