---
"@enduragent/core": patch
"@enduragent/engine": patch
"@enduragent/i18n": patch
"@enduragent/coach-contract": patch
"@enduragent/coach": patch
"cycling-coach": patch
---

Route fixed Telegram, terminal, and coach messages through the shared English catalog and preserve message descriptors alongside existing wire text.

User-facing: The Telegram bot, the terminal setup, and the coach's fixed replies now use your language, and the terminal setup asks for your language when your computer's language is not one it speaks.
