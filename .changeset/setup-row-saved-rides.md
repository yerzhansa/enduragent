---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: When your rides come from imported ride files or are already saved on your computer, the Intervals.icu row in Setup now shows a green check and says your rides are saved, matching the "2 of 2 required ready" badge. Connect stays there if you want to sync new rides from Intervals.icu.

The Setup training row now reads the same training-data readiness that the badge and Start coaching use. Without an Intervals.icu connection but with imported or kept rides, it shows a ready disc, a new `setup.training.subtitle.savedRides` subtitle (translated for every catalog), and keeps the Connect action.
