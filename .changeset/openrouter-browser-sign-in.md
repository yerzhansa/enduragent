---
"@enduragent/core": minor
"@enduragent/desktop": minor
"@enduragent/desktop-renderer": minor
"@enduragent/i18n": minor
---

User-facing: You can now connect OpenRouter by signing in through your browser instead of pasting a key. Pasting an OpenRouter key still works, and Setup tells you when your OpenRouter account still needs credits.

Setup and Settings gain an OpenRouter lane next to ChatGPT subscription. Sign-in uses OpenRouter's PKCE flow with a loopback callback on 127.0.0.1, or a code copied by hand when the browser cannot hand back. The key goes into the existing `openrouter` vault slot through the same write as a pasted key, and only an operation id, a phase, a closed refusal or the credit status reaches the renderer. The credit status comes from `is_free_tier` on `GET /api/v1/key` and is never stored. Intervals.icu now shares the loopback sign-in module in core.
