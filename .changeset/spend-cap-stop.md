---
"@enduragent/coach": minor
"@enduragent/coach-contract": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: In Settings › Spending you can now choose what happens when today's spend reaches your daily cap. Warn keeps the coach answering as before; Stop makes the coach skip new messages until tomorrow or until you raise the cap, and a message you send in the app meanwhile waits and goes out then.

The daily cap file moves to version 2 with a `mode` of `warn` or `enforce`; a version 1 file reads as `warn` with its amount unchanged, and a version 2 file round-trips instead of falling back to the $0.50 default. The coach engine adapter checks the cap before each of its six turn-running methods and, when the cap is enforced and reached, returns a `spend-cap-reached` refusal without calling the model. An unknown status never refuses. Protocol version 40 adds `capMode` to the spend summary, an optional `mode` to `setDailySpendCap`, and an optional `refusal` to chat, queue and decision results.
