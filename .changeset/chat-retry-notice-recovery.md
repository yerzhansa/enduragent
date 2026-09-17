---
"@enduragent/desktop": patch
---

User-facing: After you reopen Chat with a stopped coach reply, the notice again explains that the response stopped and still offers Retry beside that copy.

`queue-snapshot` restores `progress` with `CHAT_RESPONSE_STOPPED_COPY` when it hydrates `retryRequired`. `projectTurnRecovery` uses that copy when Retry is offered and no other notice exists.
