---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Moving to another ride while its analysis is still loading no longer interrupts a sync that is running or cuts off the coach's reply.

The ride analysis passed an abort signal to `getActivityAnalysis`, and the coach client closes the window's whole shared connection on any caller's abort, so every other call on it failed. The analysis no longer passes a signal; a superseded load is dropped by its generation when its answer arrives. The client's abort behavior is unchanged.
