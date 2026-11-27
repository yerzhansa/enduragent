---
"@enduragent/desktop-renderer": patch
---

User-facing: Pressing Review setup in Settings, Coach now only takes you to Setup. The Coach section keeps showing your coach and its controls instead of "Not configured" and "Loading coach settings…".

The Coach settings controller no longer closes its pane before handing off to the inline Setup panel. Settings stays mounted, so nothing reopened the pane; it now stays in its current state and still reloads once Setup connects a provider.
