import { trace } from "@opentelemetry/api";

export const TRACING_SWITCH = "ENDURAGENT_OTEL";
export const TRACING_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const TRACING_SERVICE_NAME = "enduragent-coach";
export const TRACING_EXPORT_TIMEOUT_MS = 2_000;

export type TracingShutdown =
  | { readonly kind: "off" }
  | { readonly kind: "flushed" }
  | { readonly kind: "export-failed"; readonly error: unknown };

export interface CoachTracing {
  shutdown(): Promise<TracingShutdown>;
}

export type TracingTarget =
  | { readonly kind: "off" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "on"; readonly url: string };

export interface CoachTracingOptions {
  readonly warn?: (message: string) => void;
}

const TRACING_OFF: CoachTracing = { shutdown: () => Promise.resolve({ kind: "off" }) };

function errorText(error: unknown): string {
  if (Array.isArray(error)) return error.map(errorText).join("; ");
  return error instanceof Error ? error.message : String(error);
}

export function tracingTarget(env: Readonly<Record<string, string | undefined>>): TracingTarget {
  if (env[TRACING_SWITCH] !== "1") return { kind: "off" };
  const endpoint = env[TRACING_ENDPOINT]?.trim();
  if (endpoint === undefined || endpoint === "") {
    return { kind: "invalid", reason: `${TRACING_ENDPOINT} is not set` };
  }
  const parsed = URL.parse(endpoint);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return { kind: "invalid", reason: `${TRACING_ENDPOINT} is not an http:// or https:// URL` };
  }
  return { kind: "on", url: `${endpoint.replace(/\/+$/, "")}/v1/traces` };
}

export async function startCoachTracing(
  env: Readonly<Record<string, string | undefined>>,
  options: CoachTracingOptions = {},
): Promise<CoachTracing> {
  const warn = options.warn ?? console.warn;
  const target = tracingTarget(env);
  if (target.kind === "off") return TRACING_OFF;
  if (target.kind === "invalid") {
    warn(`${TRACING_SWITCH}=1 is set but ${target.reason}; tracing stays off.`);
    return TRACING_OFF;
  }
  try {
    const [sdk, otlp, resources] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
    const exporter = new otlp.OTLPTraceExporter({
      url: target.url,
      timeoutMillis: TRACING_EXPORT_TIMEOUT_MS,
    });
    const provider = new sdk.BasicTracerProvider({
      resource: resources.resourceFromAttributes({ "service.name": TRACING_SERVICE_NAME }),
      spanProcessors: [
        new sdk.BatchSpanProcessor(exporter, { exportTimeoutMillis: TRACING_EXPORT_TIMEOUT_MS }),
      ],
    });
    if (!trace.setGlobalTracerProvider(provider)) {
      await provider.shutdown();
      warn("Another tracer is already registered; tracing stays off.");
      return TRACING_OFF;
    }
    return {
      shutdown: async () => {
        try {
          await provider.forceFlush();
          return { kind: "flushed" };
        } catch (error) {
          warn(`Tracing could not send its last spans to ${target.url}: ${errorText(error)}`);
          return { kind: "export-failed", error };
        } finally {
          await provider.shutdown();
          trace.disable();
        }
      },
    };
  } catch (error) {
    warn(`Tracing could not start: ${errorText(error)}; tracing stays off.`);
    return TRACING_OFF;
  }
}
