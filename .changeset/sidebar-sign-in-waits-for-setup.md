---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: The sidebar's Sign in again link for Intervals.icu now waits while Setup or a Settings change is busy, instead of opening Settings without starting the sign-in.

The link switched to Settings and called `connectTrainingData`, which does nothing while a Setup credential operation runs. It is now disabled by `setupSignInBlocked`, which joins the two checks `connectTrainingData` refuses on: a running Setup credential operation and `credentialChangesBlocked`.
