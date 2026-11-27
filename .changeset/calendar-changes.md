---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/engine": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: When you edit, move or delete a Plan workout in intervals.icu, the Calendar now marks it and asks what you want. Keep makes the Plan follow your change; Put back restores the Plan's version on intervals.icu. Nothing is changed until you choose.

The `plan.calendar` RPC gains change-detail, keep-change and put-back. Each reads the event back from intervals.icu before it acts, and a newer edit is shown first instead of being overwritten. Keep on an edit or move applies a Plan Change that keeps the physical workout id.
