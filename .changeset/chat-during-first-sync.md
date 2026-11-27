---
"@enduragent/coach": patch
"@enduragent/coach-client": patch
"@enduragent/desktop": patch
---

User-facing: You can now chat with your coach while your first training-data sync is still running. Before, typing a message or opening Settings during a long first sync could leave the app on "Connection interrupted" until you quit and reopened it.

A sync no longer holds the store lane while an intervals.icu request is in flight. The backfill, the capture and the curve refresh fetch through the store runtime, which frees the lane until the whole response has arrived and takes it back before the next store step; the wait for the legacy refresh frees it too. Preference reads, setup status, chat drafts and chat turns now run between the sync's store steps. File imports and intervals.icu sign-in changes still wait for the whole sync. A coach call that times out now fails alone instead of closing the shared connection and failing every other call on it; a caller's abort and a protocol fault still close it.
