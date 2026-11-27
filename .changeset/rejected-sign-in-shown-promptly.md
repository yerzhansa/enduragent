---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If Intervals.icu stops accepting your sign-in while Enduragent is open, the sidebar now asks you to sign in again within a minute. Before, it waited until you came back to the window or synced.

The coach learns of a rejected sign-in from its own syncs and chat tool calls, and the window reads that only through `getRuntimeConfig`. The window now re-reads it every 60 s while no sync is running, every 30 s while Sync reports the saved sign-in is not in use, and not at all during a sync, which ends with a read of its own. Focus and the read after each sync stay as they were.
