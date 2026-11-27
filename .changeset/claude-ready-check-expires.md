---
"@enduragent/desktop": patch
---

User-facing: Choosing Claude Code in Setup now checks your Claude Code sign-in again when the last check is more than a minute old, so a sign-out in a terminal no longer leaves Setup activating a coach that cannot answer.

Activation reused the last "ready" result of the Claude Code check with no age limit. It now reuses it only within `CLAUDE_CLI_READY_REUSE_MS` (60 s). After that it joins a check already running, or forces a fresh one that clears the 5-minute account probe cache.
