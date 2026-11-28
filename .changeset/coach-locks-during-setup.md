---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: In Settings, Coach's Retry now waits while Setup is saving or signing in, so Setup and the coach can no longer end on different providers. Coach also stays usable when only Setup's status couldn't be loaded, or while ride files are importing.

The Coach pane locked on `onboardingCredentialMutationActive`, which also covered a failed Setup read and ride imports, while its Retry button checked only Settings mutations. Both now use one rule: Setup is loading, or a Setup operation that a refresh would drop is running (`setupOperationRunning` without the ride import).
