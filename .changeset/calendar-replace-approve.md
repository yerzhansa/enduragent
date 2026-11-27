---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
"@enduragent/kernel": minor
---

User-facing: Replacing your Plan no longer changes intervals.icu until you approve, so Not now leaves your old Plan there. The Approve sheet lists the old Plan's workouts that come off from tomorrow on, and the new Plan's first two Training Weeks go on only after those are gone.

Replace activation records a cleanup hold (migration 036, `plan_cleanup_hold`) instead of a cleanup job. The new Plan's first `approve-weeks` releases it in the same transaction through the engine's `athlete-approves-replacement` step, and can carry the athlete's ticked changes as the old Plan's close choice. Ending or completing the waiting Plan releases its holds, and the drain releases any hold whose replacement no longer waits. The `plan.calendar` read gains `replacing`.
