---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: You can drag a workout to another day on the Calendar. The app asks first, offers to swap with a workout already on that day, and moves it on intervals.icu too. The card then reads "Moved by you".

The `plan.calendar` RPC gains `move-workout`. It applies one Plan Change with a `move-by-you` intent, which keeps physical workout ids, and marks the intervals.icu copies as moving so the next run updates the same events. Calendar workouts gain `movable` and `movedByYou`.
