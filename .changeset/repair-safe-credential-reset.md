---
"@enduragent/desktop": patch
---

User-facing: Fixed “Remove all credentials” after an uncertain credential deletion.

The explicit full reset remains visible and bypasses the per-credential repair lock while other destructive actions remain blocked.
