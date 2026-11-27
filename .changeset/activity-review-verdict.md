---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/kernel": minor
"@enduragent/engine": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it from the ride and your Plan, as one reply on your own model, and Write again writes a new one; if the coach could not write it, the ride says so and spends nothing more until you press Write again. Add a note for the coach under the ride: saving it never rewrites the verdict, the coach reads it when you press Write again, and Ask the coach about this ride opens Chat with the ride named in your message.

The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller at the least reasoning effort, aborts before its lease runs out, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`.
