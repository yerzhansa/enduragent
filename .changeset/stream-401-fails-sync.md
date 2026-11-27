---
"@enduragent/sync-intervals-icu": patch
"@enduragent/core": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: If intervals.icu refuses your API key or sign-in while a sync downloads ride recordings, the sync now says it couldn't finish instead of saying your training data synced.

A 401 on a recording download no longer counts as an unfetched recording. `attempt` in the capture's lane report rethrows a refused sign-in, so the reference capture fails, the store window fails, and Sync shows its retryable failure. The older reference fetch now fails its stream loop on a 401 the same way. A 403 or a 404 on a recording download still counts as an unfetched recording. An OAuth 403 already starts the sign-in check, which marks the sign-in rejected. The change also runs `oxfmt` over `lane-report.ts` and the live-bundle test, which the format gate requires once a file changes.
