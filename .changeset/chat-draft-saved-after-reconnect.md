---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If the app loses its connection to your coach while you are typing a message, the chat box no longer keeps saying "Couldn't reach the coach" after the connection comes back. Your message is saved again by itself and stays in the box, with no restart needed.

The chat controller remembers the text and revision of a draft save that failed and saves it again when the coach connection provider opens a new connection, unless a newer save has started or the message was sent since. If that save fails too, the error stays and the next connection tries again. Clearing the controller's old code-quality findings changes three small things: a Stop request that fails can be sent again by pressing Stop; a failed reload of planning requests after a Plan build or activation is refused for pending commitments now shows the existing "We couldn't check saved Plan requests" line instead of nothing; and a failed Plan library re-read, view render or Plan creation pause write logs a named error. The spend and Training context refreshes report their own failures, so their empty catches are gone.
