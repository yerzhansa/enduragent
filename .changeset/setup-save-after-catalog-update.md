---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: When the app stays open while the model list is updated, saving a key, picking Claude Code or signing in with ChatGPT in Setup now works instead of failing with "Coach choices are unavailable right now". After a save, Setup shows the updated model list. If the updated list no longer offers the model you chose, Setup saves nothing and shows that message over the updated list, so you can choose again.

Main forgot every model list revision except the two newest it had served, so a Setup draft from an older revision was refused. Main now remembers the models it served for each revision while the window is open, and applies the newest list to every Setup write: key save, selection apply, ChatGPT sign-in and activation, and OpenRouter sign-in. It answers that the draft is stale when the newest list no longer offers the draft's provider or the listed model the draft names. A model the athlete typed is applied as before. Setup sends each write once, and reads the list again after every successful save and after a stale answer. When the athlete's chosen model is gone, Setup keeps their provider and selects its default model.
