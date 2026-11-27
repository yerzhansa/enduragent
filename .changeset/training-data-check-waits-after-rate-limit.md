---
"@enduragent/core": patch
"@enduragent/desktop": patch
---

User-facing: When intervals.icu asks the app to slow down during a sync, the app now waits a moment and tries the training-data check once more, so your training data still updates. Before, Sync now could end on "Sync needs attention", and a scheduled sync could leave your training data out of date until the next one.

A 429 on the reference refresh's athlete, activities, wellness or events request now ends that run as `fetch_failed` with the Retry-After it returned, as ADR-0011 asks. The sync window then waits that long, at least one second and only when it is 30 seconds or less, and runs the reference refresh once more inside the same window and request budget. A second 429, or a longer Retry-After, ends the window as before, and the next scheduled sync tries again. A 429 on the athlete, wellness or events request no longer blocks coaching as if the data were invalid.
