---
"@enduragent/desktop": patch
---

User-facing: Hardened macOS credential protection by removing unauthenticated helper access and requiring the signed Enduragent host for native binding calls.

Replaced the separately invokable Keychain helper boundary with a main-process native binding and hardened Electron runtime entry points.
