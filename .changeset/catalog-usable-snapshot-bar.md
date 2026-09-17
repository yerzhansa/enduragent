---
"@enduragent/core": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Setup and Settings keep the usual model list when a saved catalog update would have left providers empty.

A higher-revision installation snapshot with only a Synthetic provider previously beat the bundled catalog, so a selected provider such as OpenAI Codex became custom-only with no models. Live candidate evaluation and local snapshot selection now skip catalogs that drop bundled suggested providers.
