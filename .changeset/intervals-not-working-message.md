---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: When your Intervals.icu sign-in is saved but the coach can't use it, Setup now says so and tells you to choose Retry saved keys, instead of asking you to reload a status that wasn't on screen.

Main now reports a sign-in that was saved but could not be applied as `saved-not-active` instead of `uncertain` / `runtime-uncertain`, since the vault has already marked it `failed`. The renderer shows the new `setup.error.intervalsSavedNotActive` message (translated for every catalog) for a saved sign-in whose runtime state is `failed`, and keyboard focus lands on Retry saved keys after such a sign-in. `setup.error.intervalsRuntimeUncertain` is removed.
