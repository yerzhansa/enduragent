import { trace } from "@opentelemetry/api";

export const TRACING_SWITCH = "ENDURAGENT_OTEL";
export const TRACING_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const TRACING_SERVICE_NAME = "enduragent-coach";

export type TracingShutdown =
  | { readonly kind: "off" }
  | { readonly kind: "flushed" }
  | { readonly kind: "export-failed"; readonly error: unknown };

export interface CoachTracing {
  shutdown(): Promise<TracingShutdown>;
}

const TRACING_OFF: CoachTracing = { shutdown: () => Promise.resolve({ kind: "off" }) };

export function tracesUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env[TRACING_SWITCH] !== "1") return undefined;
  const endpoint = env[TRACING_ENDPOINT]?.trim();
  if (endpoint === undefined || endpoint === "") return undefined;
  return `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}

export async function startCoachTracing(
  env: Readonly<Record<string, string | undefined>>,
): Promise<CoachTracing> {
  const url = tracesUrl(env);
  if (url === undefined) return TRACING_OFF;
  const [sdk, otlp, resources] = await Promise.all([
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const provider = new sdk.BasicTracerProvider({
    resource: resources.resourceFromAttributes({ "service.name": TRACING_SERVICE_NAME }),
    spanProcessors: [new sdk.BatchSpanProcessor(new otlp.OTLPTraceExporter({ url }))],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    await provider.shutdown();
    return TRACING_OFF;
  }
  return {
    shutdown: async () => {
      try {
        await provider.forceFlush();
        await provider.shutdown();
        return { kind: "flushed" };
      } catch (error) {
        return { kind: "export-failed", error };
      } finally {
        trace.disable();
      }
    },
  };
}
