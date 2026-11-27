---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If the app can't use your saved Intervals.icu sign-in, the Intervals.icu row in Setup now shows a warning and "Signed in, but not working yet" instead of a green "Connected".

The Setup training row now checks that the saved Intervals.icu sign-in is active in the coach, the same way training-data readiness does. A sign-in that is saved but `failed` or `stored-inactive` gets a new `not-working` row state with an attention disc, a new `setup.training.subtitle.notWorking` subtitle (translated for every catalog) and the Disconnect action; the existing retry and error panel are unchanged.
