---
"@enduragent/desktop": patch
---

User-facing: Prevented macOS Keychain password and reset dialogs during credential startup and recovery.

Enduragent now preserves old or unavailable credentials for explicit inline recovery and never invokes Electron `safeStorage` on macOS.
