---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If the coach is slow to answer right after you delete a key in Settings, you now stay in Settings with a Retry for the setup status, instead of being sent to the full Setup screen while your coach still works.

The delete path's catch marked the deleted credential as needing repair when Setup's follow-up read timed out, and a repair credential makes Setup required. A failed read is not a reason to repair: the catch now keeps the repair state it had.
