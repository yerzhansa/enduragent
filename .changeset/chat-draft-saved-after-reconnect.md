---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If the app loses its connection to your coach while you are typing a message, the chat box no longer keeps saying "Couldn't reach the coach" after the connection comes back. Your message is saved again by itself and stays in the box, with no restart needed.

The chat controller remembers the text of a draft save that failed and saves it again when the coach connection provider opens a new connection, unless a newer save started since. If that save fails too, the error stays and the next connection tries again. Clearing the controller's old code-quality findings: the spend, Training context and Plan library refreshes are no longer wrapped in empty catches (the first two report their own failures; a failed Plan library re-read is now a typed result the Change flow still ignores), the session probe, queue re-read and stop request use typed results, and a failed reload of planning requests after a refused Plan build now shows the existing "We couldn't check saved Plan requests" line instead of nothing.
