---
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: When you retry a stopped reply after reopening the app, your message and the stopped reply now stay in Chat above the new reply.

Saved transcript rows are hidden only when the live Chat already shows them, so a retry that reuses a saved turn id keeps the saved athlete message. The macOS CI job now runs the five chat integration tests.
