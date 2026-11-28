---
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Changing your coach model in Settings no longer leaves chat summaries or memory saves stuck on a costlier model. Summaries stay on your provider's cheaper default when one exists, and follow your chosen model again after trying GPT-6 Astra.

Tracks explicit summary (`compactModel`) and memory-save (`flushModel`) overrides separately from derived defaults (`provider-default`, `follow-chat`, `astra-fallback`) in `resolveRuntimeConfig`, persists explicit overrides, the provider's summary default as before (so an update never moves an existing install's summary model), and `before_astra_model` while on GPT-6 Astra; it no longer persists a summary or memory model that only followed the chat model or the pre-Astra model, which is what made them stick.
