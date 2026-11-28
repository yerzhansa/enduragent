---
"@enduragent/desktop": patch
---

Add Discard next to Retry message when a Chat reply is stopped or fails. Discard drops the held message through the new `discardQueuedTurn` queue call, so later queued messages send and New chat stays available while a message waits for retry.

User-facing: After you stop a reply or a reply fails, you can now discard that message instead of retrying it. Messages you sent afterwards then go to your coach, and New chat stays available.
