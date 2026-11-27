---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If the connection drops while a sync is running, Enduragent now checks the sync again by itself once it reconnects, so the sidebar and your training data catch up without pressing Try again. The sidebar now says "Connection interrupted. Enduragent will check the sync again when it reconnects."

The window's connection provider gains `onConnectionOpen`, which fires after a new connection replaces one that was lost or retired, never for the first one. The sync coordinator asks the coach again once when it is left on an interrupted sync with nothing running, and the training context reads the athlete state again when its last refresh failed. Both stop listening when disposed. Old code-quality findings in the touched files are cleared without changing behavior.
