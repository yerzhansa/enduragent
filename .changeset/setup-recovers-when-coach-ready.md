---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: When the coach comes back after a slow start, Setup now loads its status again by itself instead of waiting on "Setup status couldn't be loaded" until you choose Retry.

When the cold-start reads ran out, Setup's unavailable state latched, and the lifecycle `ready` event refreshed only the language. It now also refreshes Setup while Setup's last read failed.
