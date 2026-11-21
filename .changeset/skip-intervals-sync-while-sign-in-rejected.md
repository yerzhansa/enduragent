---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

While intervals.icu rejects the signed-in token, the six-hour store refresh skips its turn and logs `scheduled_store_refresh_skipped`. An owner check that is retried with a token already marked as rejected is refused without a request. That guards a daemon started with a signed-in token in its config or environment; the desktop app does not start its daemon that way. A new sign-in resumes the refresh, and Sync now still sends its requests. A plain API key syncs as before.
