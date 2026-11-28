---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: When the app stays open while the model list is updated, saving a key, picking Claude Code or signing in with ChatGPT in Setup now works instead of failing with "Coach choices are unavailable right now". After a save, Setup shows the updated model list. If the updated list no longer offers the model you chose, Setup saves nothing and shows that message over the updated list, so you can choose again.

Main forgot every model list revision except the two newest it had served, so a Setup draft from an older revision was refused. Main now remembers the models it served for each revision while the window is open, and applies the newest list to every Setup write: key save, selection apply, ChatGPT sign-in and activation, and OpenRouter sign-in. When the newest list no longer offers the draft's provider or the listed model the draft names, main refuses the write. Key saves, selection applies and ChatGPT sign-ins get a stale-draft answer, and OpenRouter sign-in is refused as invalid input. A model the athlete typed is applied as before. Setup sends each write once. It reads the list again after every successful save, after a stale-draft answer and after an OpenRouter sign-in refusal. When the athlete's chosen model is gone, Setup keeps their provider and selects its default model.
