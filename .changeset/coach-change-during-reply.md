---
"@enduragent/coach": patch
"@enduragent/coach-contract": patch
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming. Changing the coach or deleting the AI key in use during a reply now fails right away with a "try again" message, instead of hanging or sending you to the Setup screen.

A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.

The coach protocol version goes to 38, because the new `busy-replying` refusal reason is a wire change.
