---
"@enduragent/engine": minor
"@enduragent/kernel": minor
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/coach-client": patch
"@enduragent/desktop": minor
---

User-facing: Your Plan now keeps this Training Week and next on intervals.icu, sending each new week 7 days before it starts. Changes you make to a Plan workout in intervals.icu are kept instead of being put back by the app.

The desktop calendar mirror sends whole Training Weeks and keeps intervals.icu's own read-back of each workout as its baseline. It writes only after re-reading the event and finding it unchanged, and never sends a write that changes nothing. End and Replace remove the old Plan's own workouts from tomorrow on, and leave today's workout and the ones the athlete changed. A new `plan.calendar` call approves weeks and saves the "Approve each week" setting.
