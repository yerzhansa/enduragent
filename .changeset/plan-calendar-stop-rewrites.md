---
"@enduragent/engine": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: Plan workouts that the app puts on your intervals.icu calendar no longer pile up as extra copies each time the app checks the calendar. Workouts with steps now show those steps and their training load in intervals.icu. Copies made by earlier versions stay on your calendar.

intervals.icu replaces a client's `uid` with its own, so the calendar mirror could never find the events it had made: it created them again on every run and never verified. The mirror now marks its events with `external_id`, which intervals.icu keeps, and no longer sends `upsertOnUid`. It sends only the description, because intervals.icu keeps a client `workout_doc` as is and then cannot read it.

The reconciler and the outside-edit check no longer compare `workout_doc`, nor the duration of a described workout, since intervals.icu derives both from the description. Adopting an outside edit no longer copies intervals.icu's `workout_doc` into the Plan. Plan calendar events stay outside the chat workout tools, now that their `external_id` is visible. Events made by earlier versions are not recognised or removed.
