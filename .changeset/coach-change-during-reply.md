---
"@enduragent/coach": patch
"@enduragent/coach-contract": patch
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming, and Settings keeps showing your coach. A coach change or an AI key delete made while the coach is replying now fails at once with the usual "try again" or "It was not deleted" message instead of hanging for about 30 seconds, and deleting the key in use during a reply no longer sends you to the Setup screen. Try again once the reply is done.

A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.
