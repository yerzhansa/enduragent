---
"@enduragent/desktop": patch
---

User-facing: Hardened the macOS credential key against access-control changes by other local applications.

The native Keychain backend now preserves and validates the protected owner ACL while retaining prompt-free Team-ID access.
