---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: When your Intervals.icu sign-in is saved but the coach can't use it, Setup now says so and points you at the button on screen (Retry saved keys, or Sign in again), instead of asking you to reload a status that wasn't there.

Main now reports a sign-in that was saved but could not be applied as `saved-not-active` instead of `uncertain` / `runtime-uncertain`, since the vault has already marked it `failed`. The renderer shows the new `setup.error.intervalsSavedNotActive` message (translated for every catalog) for a saved sign-in whose runtime state is `failed`, and keyboard focus lands on Retry saved keys after such a sign-in when that link is shown. While the row shows the "stopped accepting the sign-in" state, where Retry saved keys is hidden, the message keeps pointing at Sign in again instead. `setup.error.intervalsRuntimeUncertain` is removed.
