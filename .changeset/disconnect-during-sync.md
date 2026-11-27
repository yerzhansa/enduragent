---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: Disconnecting Intervals.icu while a sync is running now stops the sync and disconnects right away. Before, Disconnect could wait 30 seconds, fail with "could not be reconciled", lock Settings and leave the sign-in in place.

The coach's configureRuntime aborts the sync window that holds the store lane, and any window that starts while the clear waits, when it receives an intervals.icu clear_credential. The clear then applies inside the 25 s deadline and the vault revokes and removes the token. A sign-in replacement still waits for the sync.
