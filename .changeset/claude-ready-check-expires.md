---
"@enduragent/desktop": patch
---

User-facing: Choosing Claude Code in Setup no longer trusts a Claude Code sign-in check from long ago: when the last check is more than a minute old, it checks again before switching your coach to Claude Code.

Activation reused the last "ready" result of the Claude Code check with no age limit. It now reuses it only within `CLAUDE_CLI_READY_REUSE_MS` (60 s). After that it joins a check already running, or forces a fresh one that clears the 5-minute account probe cache.

A check that is not forced can still use the account probe that Claude Code's own cache kept for up to 5 minutes, and activation reuses a check that finished within the last minute. Both are pinned in `claude-cli-status.test.ts` to avoid a second probe right after the athlete's selection.
