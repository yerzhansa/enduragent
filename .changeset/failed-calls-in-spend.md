---
"@enduragent/engine": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: Today's spend in Settings now includes AI requests that failed, timed out or were stopped, with the usage your provider reported before they ended. A request that ended before reporting any usage adds $0.00, so today's total can be a little lower than your provider's bill.

Every model-call row in the usage ledger now carries the turn that made it (`turnId`), whether the call succeeded (`outcome: "ok" | "error"`) and, for a failed call, why (`errorClass`: a failure reason or `aborted`). A failed, timed-out or aborted call now writes its row with the known usage of the steps that finished before it ended. The spend meter counts a failed call with no usage figure as a known zero, so one failed call does not mark the day incomplete. Known usage is a lower bound: an HTTP error carries no usage figure, and the provider may still bill the step that was in flight.
