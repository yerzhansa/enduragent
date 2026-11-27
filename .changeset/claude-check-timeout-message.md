---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: When the Claude Code check in Setup does not finish, Setup now says so under the AI row instead of unlocking with no message. Choose Check again to try once more.

The check's rejection (main's 72 s deadline, or a failed IPC call) used to clear `busy` and nothing else. It now sets the new `claude-cli-check-failed` error, which the AI row shows. The new string is translated into every supported language.
