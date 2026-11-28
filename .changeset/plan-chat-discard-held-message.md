---
"@enduragent/desktop": patch
---

Add Discard before Retry interrupted message in the Plan coach chat, with the queue line "Sends after you retry or discard the earlier message." Discard drops the held message through `discardQueuedTurn`, which the daemon now allows for Plan chats, and then sends the messages queued after it. The Discard and Retry row also shows when nothing waits behind the held message.

User-facing: On the Plan page, after you stop a coach reply or it fails, you can now discard that message instead of retrying it. Messages you sent afterwards then go to your coach.
