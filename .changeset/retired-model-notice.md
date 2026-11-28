---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/core": patch
"@enduragent/i18n": patch
---

User-facing: When the model your coach uses leaves Enduragent's model list, Settings → Coach and Setup → API key → Advanced now name it as no longer listed instead of showing it as a model you typed, say that your coach keeps using it, and offer a one-press switch to its replacement when there is one. Nothing changes until you press Switch or pick another model.

Main now answers the LLM configuration with the saved model classified as `listed`, `retired` (with `replacedBy`, or null when the model list offers no replacement) or `custom`, carried on `active` as `kind`. The classification reads the new `DROPPED_MODELS` table in `@enduragent/core`, which names the replacement for each model the list dropped but saved configurations keep, and offers a replacement only when the list the window received lists it. The preload checks the new keys exactly. Setup and Coach show the retired model as its own option, keep it selected, and re-send it unchanged when saved; the Switch button saves the replacement through the existing Coach and Setup save paths.
