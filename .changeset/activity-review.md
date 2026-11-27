---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/kernel": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: A new Activity review page, below Calendar, lists your rides by Training Week and shows each ride's facts. When the app asks "Is this the Plan Workout?", answer yes, no, or another day's workout, and the Calendar shows your answer.

The `plan.calendar` RPC gains `rides`, which lists cycling rides with a ride-centric Plan Workout match and the Plan's Training Weeks, and `decide-ride`, which confirms a suggestion, turns it down as Extra, or matches the ride to another nearby workout. The Plan Workout match repository now lets the athlete take back a confirmed heuristic match and confirm a pairing turned down earlier.
