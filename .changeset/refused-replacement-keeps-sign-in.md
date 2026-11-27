---
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: If a new Intervals.icu sign-in is refused while your current one still works, Intervals.icu now stays connected. Before, the sidebar and Setup asked you to sign in again although sync kept working with your current sign-in.

The coach's rejected-sign-in check in getRuntimeConfig now tests the applied intervals.icu credential when one is applied, and falls back to the offered credential only when none is. Before, it also tested the offered credential, which configureRuntime stores before the apply and keeps after a refusal. A replacement that intervals.icu answered with 401 during the account check, and that the coach then refused as ownership-unavailable, made the healthy credential in use read as rejected. A refused first sign-in, with nothing applied, still reads as rejected until it is replaced or removed.
