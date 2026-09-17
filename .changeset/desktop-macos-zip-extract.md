---
"@enduragent/desktop": patch
---

User-facing: macOS release verification and catalog extract no longer fail on large signed zips.

Notes-only follow-on to #1075 (`4fe61753`). Signed macOS zip extract now streams `app.asar` past `unzip` stdout maxBuffer so Version Packages can ship `@enduragent/desktop@0.5.4`. Does not retarget `enduragent-desktop@0.5.3`.
