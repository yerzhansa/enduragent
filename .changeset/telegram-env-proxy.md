---
"@enduragent/core": patch
"cycling-coach": patch
---

Telegram connections now follow HTTP_PROXY and HTTPS_PROXY settings, including NO_PROXY exclusions, during setup, pairing, and normal bot use.

User-facing: Telegram works through your configured network proxy, including when you set up or pair your bot.
