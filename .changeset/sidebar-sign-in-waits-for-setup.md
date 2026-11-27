---
"@enduragent/desktop-renderer": patch
---

User-facing: The sidebar's Sign in again link for Intervals.icu now waits while Setup is busy, instead of opening Settings without starting the sign-in.

The link switched to Settings and called `connectTrainingData`, which does nothing while a Setup credential operation runs. It is now disabled while `onboardingCredentialMutationActive` is true.
