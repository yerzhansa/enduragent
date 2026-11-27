---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: When your Intervals.icu sign-in is saved but the app can't use it, Setup now says so and tells you to choose Retry saved keys or Disconnect, instead of pointing to a "Reload credential status" control that doesn't exist. Keyboard focus now lands on Retry saved keys instead of Disconnect.

The renderer now picks the Intervals.icu sign-in error from the saved status main returns with the result. A saved sign-in whose runtime state is `failed` maps to the new `intervals-runtime-not-working` error (`setup.error.intervalsRuntimeNotWorking`, translated for every catalog), whether main reported it as `applied` or as `uncertain`/`runtime-uncertain`. The old `intervals-runtime-uncertain` error and its `setup.error.intervalsRuntimeUncertain` message are removed. When the row still says intervals.icu stopped accepting the sign-in, it offers Sign in again rather than Retry saved keys, so the message there stays "couldn’t be activated. Sign in again." The row, its error line and the screen-reader announcement pick the message in one place (`useIntervalsRecovery`). After such a sign-in, the Setup training row focuses Retry saved keys when it is shown.
