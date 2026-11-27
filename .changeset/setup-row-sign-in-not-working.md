---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If your Intervals.icu sign-in is saved but the app can't use it, the Intervals.icu row in Setup now shows an orange warning and "Signed in, but not working yet" instead of a green "Connected", so it matches the "1 of 2 required ready" badge. Retry saved keys and Disconnect stay there to fix it.

The Setup training row now checks that the saved Intervals.icu sign-in is active in the coach, the same way training-data readiness does. A sign-in that is saved but `failed` or `stored-inactive` gets a new `not-working` row state with an attention disc, a new `setup.training.subtitle.notWorking` subtitle (translated for every catalog) and the Disconnect action; the existing retry and error panel are unchanged.
