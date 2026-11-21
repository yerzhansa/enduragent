---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

While intervals.icu rejects the signed-in token, the daemon no longer calls intervals.icu on its own. The six-hour store refresh skips its turn and logs `scheduled_store_refresh_skipped`, and the startup owner check refuses the rejected token without a request, so it is not retried. A new sign-in resumes both, and Sync now still sends its requests. A plain API key syncs as before.
