import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoachEngine } from "../../engine/src/index.js";
import type { GenerateResult, Sport } from "../../engine/src/sport.js";
import { baseAgentConfig } from "../../engine/tests/helpers/base-agent-config.js";
import { TRACING_SERVICE_NAME, startCoachTracing, tracesUrl } from "../src/tracing.js";

const loaded = vi.hoisted((): string[] => []);

vi.mock("@opentelemetry/sdk-trace-base", async (importOriginal) => {
  loaded.push("@opentelemetry/sdk-trace-base");
  return importOriginal();
});
vi.mock("@opentelemetry/exporter-trace-otlp-http", async (importOriginal) => {
  loaded.push("@opentelemetry/exporter-trace-otlp-http");
  return importOriginal();
});
vi.mock("@opentelemetry/resources", async (importOriginal) => {
  loaded.push("@opentelemetry/resources");
  return importOriginal();
});

const PROMPT_MARKER = "prompt-marker-3c8e";
const REPLY_MARKER = "reply-marker-a41f";

interface ReceivedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly body: string;
}

const received: ReceivedRequest[] = [];
const roots: string[] = [];
let collector: Server;
let collectorUrl: string;

beforeAll(async () => {
  collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterEach(async () => {
  received.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

const sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: {} as never,
  tools: () => [],
} as Sport;

function reply(): GenerateResult {
  const usage = {
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  };
  return {
    text: `Ride easy today. ${REPLY_MARKER}`,
    toolCalls: [],
    finishReason: "stop",
    usage,
    totalUsage: usage,
    steps: 1,
  };
}

async function runTurn(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "coach-tracing-"));
  roots.push(root);
  const engine = createCoachEngine({
    sport,
    ports: {
      ...baseAgentConfig(root),
      modelTransportDecorator: () => ({ generate: async () => reply() }),
    },
  });
  const response = await engine.chat({
    chatId: "chat-tracing",
    message: `What should I ride? ${PROMPT_MARKER}`,
  });
  expect(response.text).toContain(REPLY_MARKER);
}

interface ExportedSpan {
  readonly name: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

function exported(): { readonly services: string[]; readonly spans: ExportedSpan[] } {
  const services: string[] = [];
  const spans: ExportedSpan[] = [];
  for (const request of received) {
    const payload = JSON.parse(request.body) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: ExportedSpan[] }>;
      }>;
    };
    for (const resourceSpan of payload.resourceSpans) {
      const service = resourceSpan.resource.attributes.find((a) => a.key === "service.name");
      if (service?.value.stringValue !== undefined) services.push(service.value.stringValue);
      for (const scope of resourceSpan.scopeSpans) spans.push(...scope.spans);
    }
  }
  return { services, spans };
}

describe("coach tracing start-up", () => {
  it("builds the traces URL only when the switch and the endpoint are both set", () => {
    expect(tracesUrl({})).toBeUndefined();
    expect(tracesUrl({ ENDURAGENT_OTEL: "1" })).toBeUndefined();
    expect(tracesUrl({ ENDURAGENT_OTEL: "1", OTEL_EXPORTER_OTLP_ENDPOINT: " " })).toBeUndefined();
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" })).toBeUndefined();
    expect(
      tracesUrl({ ENDURAGENT_OTEL: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }),
    ).toBeUndefined();
    expect(
      tracesUrl({ ENDURAGENT_OTEL: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" }),
    ).toBe("http://127.0.0.1:4318/v1/traces");
  });

  it("with the switch off, loads no tracing SDK module and sends nothing", async () => {
    for (const env of [
      {},
      { ENDURAGENT_OTEL: "1" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl },
      { ENDURAGENT_OTEL: "0", OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl },
    ]) {
      const tracing = await startCoachTracing(env);
      await runTurn();
      await tracing.shutdown();
    }

    expect(received).toEqual([]);
    expect(loaded).toEqual([]);
  });

  it("with the switch on, sends a turn's spans to the endpoint when it shuts down", async () => {
    const tracing = await startCoachTracing({
      ENDURAGENT_OTEL: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
    });
    await runTurn();
    expect(received).toEqual([]);

    await expect(tracing.shutdown()).resolves.toEqual({ kind: "flushed" });

    expect(loaded.sort()).toEqual([
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-trace-base",
    ]);
    expect(received.map((request) => [request.method, request.url])).toContainEqual([
      "POST",
      "/v1/traces",
    ]);
    const { services, spans } = exported();
    expect(new Set(services)).toEqual(new Set([TRACING_SERVICE_NAME]));
    const turn = spans.find((span) => span.name === "coach.turn");
    expect(turn).toBeDefined();
    expect(spans.filter((span) => span.name === "llm.generate")).toEqual([
      expect.objectContaining({ parentSpanId: turn?.spanId }),
    ]);
    const bodies = received.map((request) => request.body).join("\n");
    expect(bodies).not.toContain(PROMPT_MARKER);
    expect(bodies).not.toContain(REPLY_MARKER);
    expect(bodies).not.toContain("chat-tracing");
  });

  it("shuts down without failing when the endpoint is unreachable", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const tracing = await startCoachTracing({
      ENDURAGENT_OTEL: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    });
    await runTurn();

    await expect(tracing.shutdown()).resolves.toMatchObject({ kind: "export-failed" });
  }, 30_000);
});
