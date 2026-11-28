---
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Changing your coach model in Settings no longer leaves chat summaries or memory saves stuck on a costlier model. Summaries stay on your provider's cheaper default when one exists, and follow your chosen model again after trying GPT-6 Astra.

Tracks explicit summary (`compactModel`) and memory-save (`flushModel`) overrides separately from derived defaults (`provider-default`, `follow-chat`, `astra-fallback`) in `resolveRuntimeConfig`, persists explicit overrides, the provider's summary default as before (so an update never moves an existing install's summary model), and `before_astra_model` while on GPT-6 Astra; it no longer persists a summary or memory model that only followed the chat model or the pre-Astra model, which is what made them stick. `config.yaml` names the explicit ones in `explicit_background_models`, written only when there is one, so other files keep their bytes. `loadConfigFromYaml` reads a file without that list, as older versions wrote it, by value: a `compact_model` equal to the provider's summary default is that default; a `flush_model` equal to the chat model, or a `compact_model` equal to it on a provider without a summary default, follows the chat model; on GPT-6 Astra both are the model used before Astra; any other saved value stays explicit. `LLM_COMPACT_MODEL` and `LLM_FLUSH_MODEL` stay explicit.
