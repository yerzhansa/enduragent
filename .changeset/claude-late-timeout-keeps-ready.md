---
"@enduragent/desktop": patch
---

User-facing: When an earlier Claude Code check finishes long after you checked again, Setup now keeps your newer result, so Continue does not fail after Setup showed Claude Code ready.

A Claude Code check that missed its 72 s deadline and settled later cleared the newest "ready" result, so activation probed again and could time out. The late check still clears the account probe cache, but the ready result is now recorded and cleared only by the newest check that settled.
