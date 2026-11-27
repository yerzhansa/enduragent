---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Setup now runs one sign-in at a time. While your coach activates or another sign-in waits for your browser, the Intervals.icu buttons, "Import ride files instead" and Start coaching stay locked, so a second click no longer shows a false "check your connection" error or hides Cancel sign-in.

Every Setup action and row control now reads one shared check for a running Setup operation: a busy step, a ChatGPT sign-in or activation, an OpenRouter browser sign-in, an Intervals.icu sign-in, or a ride import. The OpenRouter panel's own Reopen and Enter a code links stay usable during its sign-in.
