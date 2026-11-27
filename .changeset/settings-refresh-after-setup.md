---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Settings now shows your new coach route and the Delete button for a newly connected AI provider right away, without leaving Settings and coming back.

Every successful provider connection in Setup, pasted key, browser sign-in or reactivation, now refreshes the open Settings coach and credential panes in place, even when the Setup status refresh fails. The Coach pane keeps its current values until the new route arrives, keeps an unsaved model draft, and reloads after Review setup closed it.
