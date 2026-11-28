---
"@enduragent/engine": patch
"@enduragent/core": patch
"@enduragent/coach": patch
---

The usage ledger's turn row (`kind: "turn"`) is now the sum of every chat-model call the turn made, failed and stopped attempts included, instead of the last successful call only. It is written on every turn exit: a reply, a Coach decision, a failure after a write, a stop and a final failure. Each turn row carries `turnId`, `outcome` and, for a failed turn, `errorClass` (`aborted` for a stop, `budget` when the turn ran out of its budget). It sums known usage: a failed call with no usage figure is a known zero, so it keeps the turn's cost known. A queue retry reuses the turn's ID, so the retry's turn row also adds the chat calls the earlier run left in the ledger; the latest turn row for a `turnId` is that turn's total. Compaction and memory-flush calls keep only their own rows. `pnpm usage:baseline` gains `--outcome ok|error|all`, defaulting to `ok`, and keeps only the latest turn row for each `turnId`. Today's spend and season review read only per-call rows, so no figure an athlete sees changes.
