---
"@enduragent/desktop": patch
---

User-facing: When starting a new conversation fails partway, Chat now finds out whether it started and says so, and New chat works again without restarting the app. If Chat still can't tell, a Check again button lets you look again.

After a failed reset, Chat reads the session, the newest transcript page and the queue once, and compares them with what was showing before. Turns that are gone mean the reset landed, so Chat finishes it; turns that are still there mean it never started, so Chat returns to normal. The reset itself is never sent twice.
