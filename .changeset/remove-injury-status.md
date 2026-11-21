---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/coach": patch
"@enduragent/coach-contract": patch
"@enduragent/coach-client": patch
"@enduragent/kernel": patch
"@enduragent/i18n": patch
---

User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.
