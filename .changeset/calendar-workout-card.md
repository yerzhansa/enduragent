---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
"@enduragent/sport-cycling": minor
---

User-facing: Click a workout on the Calendar to open its card, where you can see whether it is on intervals.icu, move it to another day, ask the coach to change it, or export it. A new Plan now starts on the first day of your week by default, and you can still pick another day.

Workout cards in the grid are buttons that open the card over the grid; a workout changed in intervals.icu still opens its change sheet. Move… opens the existing move dialog, which gains Earlier day and Later day buttons that step over days the workout cannot move to. Ask the coach saves a draft naming the workout and day into an empty composer and opens Change in Chat; nothing is sent. Export reuses the workout archive export for that day.

The start-timing question offers `first-day-of-week` (answered as `earliest` with the next first day of the computer's region week, computed in the renderer) and `earliest` ("Pick another day"). A picked day is now the Plan's start; the draft builder moves it only by whole weeks when a week has no day to train. Stored `as-soon-as-possible` answers keep their old meaning. The cycling creation builder version is now 2.
