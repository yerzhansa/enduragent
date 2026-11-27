---
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: Queued chat messages now keep sending after failed replies or removed commands, oversized plan edits no longer leave stray bubbles, and startup or file-drop hiccups recover cleanly.

Unifies chat queue drain scheduling across failure, removal, and reset paths, clears draft errors after successful sends, serializes coach decision mutations away from active streams, retries failed startup probes individually, validates plan-change text before updating the transcript, guards async plan epochs and disposal, and adds timeout cleanup and busy-state Dismiss handling for dropped attachments.
