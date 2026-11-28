---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: After you switch provider in Settings, Coach, the Setup panel shows the provider your coach really uses, and deleting a key you no longer use keeps you in Settings instead of sending you to the Setup screen. While Setup is saving or signing in, the Coach controls wait for it.

Setup kept its own copy of the active coach from its first load and dropped the configuration on every later refresh. Now every successful load adopts the configuration, and Setup's draft is kept only when the athlete edited it. A Coach save refreshes Setup, and the Coach pane is disabled while a Setup credential operation runs, so that refresh cannot drop a running Setup operation.
