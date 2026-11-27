---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/kernel": minor
"@enduragent/engine": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it from the ride and your Plan, as one reply on your own model, and Write again writes a new one; if the coach could not write it, the ride says so and spends nothing more until you press Write again. You can leave the coach a note on the ride, which it reads when you press Write again, and Ask the coach, here and on a Calendar workout, now opens Chat with its question added after whatever you have already typed.

The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller, asks for low reasoning effort with a 600-token cap only where the provider honours it (OpenAI reasoning models, codex-agent; Anthropic keeps thinking off at 600) and otherwise keeps the provider's default effort with a 2,000-token cap, aborts before its lease runs out, never abandons a write whose job is still running, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`. `createWorkoutCardController` drops `composerEmpty` and prefills through `requestComposerPrefill`, like Activity review's Ask.
