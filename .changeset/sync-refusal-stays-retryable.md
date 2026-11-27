---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If the coach turns a sync away before it starts, for example while it is getting ready for an update, the sidebar now offers Try again instead of a disabled "Sync unavailable" that asked you to quit and reopen Enduragent.

The sync coordinator accepts an error reply that arrives before any progress notification as an operation failure the athlete can retry. It publishes that failure without refreshing the training context, since the coach ran nothing. A success with no progress is still a protocol fault, and an error after completed progress still is too. The desktop e2e fixture can take the coach's invocation coordinator, so a spec can close and reopen admission.
