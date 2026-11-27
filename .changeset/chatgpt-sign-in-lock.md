---
"@enduragent/desktop": patch
---

User-facing: While a ChatGPT sign-in is open in the browser, the coach can now restart without stopping, and Telegram setup and Coach changes in Settings no longer wait for the sign-in to finish.

The ChatGPT login used to hold the main process's credential mutation lock for the whole browser wait, up to 5 minutes. A coach restart's key replay queued behind it, ran out the 5 s readiness limit, and left the coach unavailable until relaunch. The login now takes the lock only to store the sign-in, with the abort check inside the lock.
