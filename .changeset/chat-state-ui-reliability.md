---
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: Chat decision shortcuts now respond only while Chat is open, drafts stay intact across view switches and slash commands, and messages no longer duplicate or blank when views refresh.

Resets `queueRevision` on New Conversation, filters live turns out of reloaded history pages, flushes Composer drafts on unmount and slash acceptance, scopes Chat decision shortcuts to the Chat view, and preserves buffered streaming text when views remount.
