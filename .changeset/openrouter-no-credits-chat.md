---
"@enduragent/coach-contract": minor
"@enduragent/core": minor
"@enduragent/engine": minor
"@enduragent/desktop-renderer": minor
"@enduragent/i18n": minor
---

User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.
