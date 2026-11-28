---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/sport-cycling": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: Every training workout in a new Chat Plan now has real steps, a zone, an estimated load and a line on why it is there, and its Calendar card shows them, with watts from your FTP in intervals.icu or as % of FTP until one is set.

The creation builder moves to version 3 and stores typed `content` (steps as % of FTP, zone, load, why) on each non-event Draft workout. Plan Changes recompute it. Keeping an intervals.icu edit that changes a workout's length removes it, because the athlete's version is the truth. Undo restores it as it was, and Plans built before it keep no content until a change touches a workout. The `plan.calendar` read gains each workout's `content` and the current outdoor `ftp`, and the Draft card model gains `ftpWatts`. intervals.icu receives exactly what it did before; nothing new is sent.
