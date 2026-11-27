---
"@enduragent/coach-contract": minor
"@enduragent/core": minor
"@enduragent/desktop": minor
"@enduragent/engine": minor
"@enduragent/desktop-renderer": minor
"@enduragent/i18n": minor
---

User-facing: When the coach can't answer because your Claude Code, Codex or ChatGPT sign-in has ended, your AI provider account is out of credits, or your provider no longer offers the model you picked, Chat now says so under your message and tells you what to do next. Before, it showed only a red icon and Retry, or blamed an API key you don't have.

Core classifies an HTTP 404, or a 400 whose provider error code is `model_not_found`, as the new `model_unavailable` failure, and an OpenAI 429 whose error type or code is a billing limit (`insufficient_quota`, `credit_balance_exhausted`, spend or usage limits) as `payment_required`, so it is no longer retried as a rate limit. The route comes from the chat model's provider; a 429 from any other provider stays a rate limit. The engine chooses the athlete copy from the failure and the provider: a sign-in failure on Claude Code, Codex or ChatGPT gets the new `subscription-signed-out` kind with the existing "sign in again" message, a 402 from a key provider other than OpenRouter gets the new `provider-credits` kind, and a missing model gets the new `model-unavailable` kind. Chat shows these three, and OpenRouter's credits notice, as a red notice under the kept message. A rejected API key, rate limits and other failures keep the icon and Retry. Telegram and the terminal keep their existing replies.
