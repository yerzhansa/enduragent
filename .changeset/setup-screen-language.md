---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Screen readers now read the Setup screen in your app language instead of as English.

`SetupGate` hard-coded `lang="en"` on its `main` element. It now uses the active phrasebook's language tag, as the checking screen in `Shell` already does.
