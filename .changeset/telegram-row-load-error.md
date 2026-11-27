---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: When Enduragent can't read your Telegram settings, the Telegram row in Setup now says so and offers Retry, instead of offering Create as if no bot were set up.

The Setup Telegram row now follows the Telegram settings state `{ status: "error", kind: "load" }`: the row shows the attention mark and the Settings pane's existing copy ("Telegram settings aren’t available. Keep the app open and try again."), and Retry (the existing `settings.telegram.retry` label) calls the Telegram settings port's `retry()`, which re-reads the status. Create is not offered, and an open bot setup panel cannot use a token or confirm a deletion, until a status read succeeds. No new copy.
