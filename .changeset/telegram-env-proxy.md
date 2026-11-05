---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Telegram now works through the network proxy in your `HTTPS_PROXY` setting, including during bot setup and pairing. `NO_PROXY` exclusions are respected.

User-facing: cycling-coach now needs Node.js 22.21 or newer.

The Telegram client passes `proxyEnv` to Node's built-in HTTPS agent, which reads `HTTPS_PROXY` and `NO_PROXY` in upper or lower case for Telegram's HTTPS endpoint. Node added `proxyEnv` in 22.21.0 and 24.5.0, so the engine floor rises to match.
