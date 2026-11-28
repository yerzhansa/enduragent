---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If the language you pick on first launch can't be saved, the language screen now stays open with a message and a Retry button, instead of jumping to Setup in English.

The shell keeps the language screen up after a failed first-launch save, and the screen shows the failure in the chosen language. Settings keeps its existing "Language preference unavailable" message.
