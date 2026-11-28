---
"@enduragent/coach": minor
"@enduragent/desktop": minor
---

User-facing: You can now send a trace of each coach turn to a tracing tool you run yourself, such as Jaeger, to see how long the model and each tool took and what each turn cost. It is off unless you turn it on with two settings described in the privacy guide, and it never sends your messages, the coach's replies or your training data.

When the coach process starts with `ENDURAGENT_OTEL=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` set, `withLocalCoach` starts an OpenTelemetry trace provider (service `enduragent-coach`) with a batch processor and an OTLP/HTTP exporter to `<endpoint>/v1/traces`, and flushes it after the coach shuts down. The SDK and exporter load by dynamic import only then; with either variable missing nothing loads and nothing is sent. A failed export loses that batch but never fails a turn or an exit. The README and the privacy guide name the exporter as an outbound request.
