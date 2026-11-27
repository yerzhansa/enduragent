---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: A new Calendar page shows your Plan one Training Week per row, with each workout's result: done as planned, done differently, missed, or waiting for you to confirm a ride. Each week shows whether it is on intervals.icu yet, and rows start on your region's first day of the week. Without a Plan, it lists your Activities by date.

The `plan.calendar` call gains a `read` action that returns a date range of the active Plan's workouts, outcomes, copy states and Training Week status, plus the athlete's Activities. The desktop passes the region's first day of the week to the renderer from `app.getLocaleCountryCode()`.
