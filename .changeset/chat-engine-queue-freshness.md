---
"@enduragent/core": patch
"@enduragent/engine": patch
"@enduragent/desktop": patch
---

User-facing: Starting a fresh session automatically no longer drops queued follow-up messages or prints two fresh-session notices.

Preserves the durable chat queue across automatic stale-session resets, replays live queue events for overlapping `resumeChatQueue` callers, and removes the duplicate archive disclosure instruction from the model prompt.
