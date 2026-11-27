---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/kernel": minor
"@enduragent/engine": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it from the ride and your Plan, once, as one reply on your own model, and you can ask it to write again. Add a note for the coach under the ride: saving it never rewrites the verdict, and the coach reads it when you press Write again; Ask the coach about this ride opens Chat with the ride named in your message.

The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` now also starts the verdict when the athlete answers the match. The verdict moves only through the engine's `coachTextStep`, runs in the background on the athlete's chat model under the new `coach-text` caller, and is stored with the note in the new `activity_review` table (migration 037). A write that outlives its lease becomes failed. The engine exports `coachTextPrompt` and `createCoachTextWriter`.
