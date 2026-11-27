---
"@enduragent/core": patch
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Setup and Settings now offer each AI provider's current models, with up-to-date prices, and new setups start on a current model. If a provider has retired the model you picked, the app now uses its replacement.

Bundled model catalog seed revision 12, matching the published catalog revision 12. Revision 12 is revision 10 plus the old DeepSeek name `deepseek-v4-flash`, labelled "DeepSeek V4.1 Flash (old name)": released builds still default to it, and DeepSeek serves it with V4.1 Flash at the same price. New defaults: Anthropic `claude-sonnet-5-5`, OpenAI `gpt-6.2-sol`, Google `gemini-4-hydrogen`, DeepSeek `deepseek-flash` (replaces the retired `deepseek-v4-flash` name), Qwen `qwen4-max`, Kimi `kimi-k3.1-pro`, Z.ai `glm-5.3`, OpenRouter `deepseek/deepseek-v4.1-flash-1017`. Summariser defaults: Anthropic `claude-haiku-5-5`, OpenRouter `deepseek/deepseek-v4.1-flash-1017`. Retired or withdrawn ids are removed: MiniMax M2.7 and M2.7 Highspeed, Kimi K2.6 and K2.7 Code, Gemini 3.7 Flash, and `qwen/qwen3.8-max` on OpenRouter. Sign-in lanes (ChatGPT, Codex agent, Claude subscription) are unchanged. Saved configs that name a model its provider retired load with the replacement: `gemini-3.7-flash` to `gemini-3.8-flash`, `deepseek-v4-flash` to `deepseek-flash`, `MiniMax-M2.7` to `MiniMax-M3`, `MiniMax-M2.7-highspeed` to `MiniMax-M3.1-Flash`, and `qwen/qwen3.8-max` to `qwen/qwen4-max` on OpenRouter.
