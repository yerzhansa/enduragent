---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: When the app stays open while the model list is updated, saving a key, picking Claude Code or signing in with ChatGPT in Setup now works instead of failing with "Coach choices are unavailable right now". Setup also shows the updated model list.

Main forgot every model list revision except the two newest it had served, so a Setup draft from an older revision was refused. Main now accepts any revision it served to the window and applies the newest list, as long as that list still offers the provider. If main still answers that the draft is stale, Setup reads the list again, moves the athlete's choice onto it and retries once with the same key. If the choice is no longer offered, Setup shows the updated list with the error.
