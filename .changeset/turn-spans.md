---
"@enduragent/engine": patch
---

The engine now records an OpenTelemetry span tree for each coach turn: one `coach.turn` span, one `llm.generate` span per model call and one `tool.call` span per tool call. Spans carry the turn's random ID, provider, model, caller, attempt, outcome, error class, token counts, known-usage cost and durations. They never carry prompts, replies, tool arguments or results, error messages, memory or the chat ID. Nothing registers a tracer provider yet, so the spans are no-ops and nothing is exported.
