---
"@enduragent/desktop": patch
---

User-facing: After a storage warning at startup, "Remove all credentials" now leaves Setup ready to save new keys. Before, every save kept failing until you restarted the app.

A successful credential reset now returns the vault's storage state to pending: it clears the store-wide "uncertain" latch, the per-slot uncertain marks, the pending reconciliation and the verified parent folder, inside the vault's own lock while the reset still holds the credential mutation lock. The latch itself still lasts until restart when nothing resets the storage.
