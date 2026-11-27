---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
"@enduragent/sport-cycling": minor
---

User-facing: Click a workout on the Calendar to open its card, where you can see whether it is on intervals.icu, move it to another day, ask the coach to change it, or export that day's workouts. A new Plan now starts on the first day of your week by default, or today when your event comes sooner, and you can still pick another day.

Workout cards in the grid are buttons that open the card over the grid; a workout changed in intervals.icu still opens its change sheet. Only one Calendar sheet is open at a time. Move… opens the existing move dialog, which gains Earlier day and Later day buttons that step over days the workout cannot move to and keep focus at the ends. Ask the coach saves a draft naming the workout and day into an empty composer and opens Change in Chat; nothing is sent. Export reuses the workout archive export for that day.

The start-timing question offers `first-day-of-week` (answered as `earliest` with the next first day of the computer's region week, computed in the renderer) and `earliest` ("Pick another day"), and gains an optional `latestAllowed`, the event date, which the coach enforces. A picked day is now the Plan's start; the draft builder moves it only by whole weeks, past weeks with no day to train or a picked day that has already passed, and the answer summary states that start. Stored `as-soon-as-possible` answers and stored questions keep their old meaning. The cycling creation builder version is now 2.
