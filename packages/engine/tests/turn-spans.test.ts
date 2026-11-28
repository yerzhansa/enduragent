import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { tool, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CoachDecisionReadModel } from "@enduragent/coach-contract";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { createCoachEngine } from "../src/index.js";
import type { EngineConfig, EngineHostPorts, UsagePort } from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const MARKERS = {
  chatId: "chat-marker-5be1",
  prompt: "prompt-marker-91c2",
  reply: "reply-marker-4d1e",
  toolArgs: "args-marker-b7aa",
  toolResult: "result-marker-e3f0",
  toolError: "tool-error-marker-55d9",
  modelError: "model-error-marker-0a6c",
  memory: "memory-marker-77de",
} as const;

const exporter = new InMemorySpanExporter();
const roots: string[] = [];

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

afterEach(() => {
  exporter.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  trace.disable();
});

const lookupSchema = z.object({ query: z.string() });
const noteSchema = z.object({ note: z.string() });

const sport: Sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: ["Ride"],
  athleteProfileSchema: z.object({}),
  tools: () => [
    {
      name: "lookup_training",
      description: "lookup_training",
      inputSchema: lookupSchema,
      tool: tool({
        inputSchema: lookupSchema,
        execute: async () => ({ found: MARKERS.toolResult }),
      }),
    },
    {
      name: "save_note",
      description: "save_note",
      inputSchema: noteSchema,
      tool: tool({
        inputSchema: noteSchema,
        execute: async (): Promise<{ saved: boolean }> => {
          throw new Error(MARKERS.toolError);
        },
      }),
    },
  ],
};

function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
  };
}

function reply(text: string): GenerateResult {
  const tokens = usage(30, 12);
  return { text, toolCalls: [], finishReason: "stop", usage: tokens, totalUsage: tokens, steps: 2 };
}

function pricedModels(): EngineConfig["models"] {
  const profile = {
    kind: "catalog" as const,
    catalogRevision: 1,
    provider: "openai-codex" as const,
    model: "gpt-5.4",
    compatibilityProfile: "openai-codex-v1" as const,
    contextWindowTokens: 272_000,
    imageInput: "incompatible" as const,
    pricing: {
      kind: "token-rates" as const,
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 0,
    },
  };
  return { catalogRevision: 1, chat: profile, compact: profile, flush: profile };
}

function agentWith(
  respond: (options: GenerateOptions) => Promise<GenerateResult>,
  usagePort: UsagePort = { append: () => undefined },
): CoachAgent {
  const root = mkdtempSync(join(tmpdir(), "turn-spans-"));
  roots.push(root);
  mkdirSync(join(root, "memory"));
  const base = baseAgentConfig(root);
  base.memory.writeSection("person", `Name: ${MARKERS.memory}`);
  const ports: EngineHostPorts = {
    ...base,
    config: { ...base.config, models: pricedModels() },
    usage: usagePort,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    modelTransportDecorator: () => ({ generate: async (request) => respond(request.options) }),
  };
  return new CoachAgent(sport, ports);
}

async function runTool(options: GenerateOptions, name: string, input: unknown): Promise<unknown> {
  const execute = options.tools?.[name]?.execute;
  if (execute === undefined) throw new Error(`Missing tool ${name}`);
  return execute(input, {
    toolCallId: `call-${name}`,
    messages: [],
    experimental_context: options.context,
  });
}

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function onlyTurnSpan(): ReadableSpan {
  const turns = spansNamed("coach.turn");
  expect(turns).toHaveLength(1);
  const [turn] = turns;
  if (turn === undefined) throw new Error("no coach.turn span");
  return turn;
}

function parentOf(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

function keysOf(span: ReadableSpan): string[] {
  return Object.keys(span.attributes).sort();
}

function everythingOnSpans(): string {
  return JSON.stringify(
    exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
      links: span.links,
    })),
  );
}

describe("a coach turn's spans", () => {
  it("record one turn, its model call and each tool call, with no private text", async () => {
    const agent = agentWith(async (options) => {
      expect(options.system).toContain(MARKERS.memory);
      expect(JSON.stringify(options.messages)).toContain(MARKERS.prompt);
      await runTool(options, "lookup_training", { query: MARKERS.toolArgs });
      await expect(runTool(options, "save_note", { note: MARKERS.toolArgs })).rejects.toThrow(
        MARKERS.toolError,
      );
      return reply(`Ride easy today. ${MARKERS.reply}`);
    });

    await expect(
      agent.chat(
        MARKERS.chatId,
        `What should I ride? ${MARKERS.prompt}`,
        undefined,
        undefined,
        undefined,
        "turn-spans-1",
      ),
    ).resolves.toContain(MARKERS.reply);

    const turn = onlyTurnSpan();
    const turnId = turn.spanContext().spanId;
    expect(parentOf(turn)).toBeUndefined();
    expect(turn.attributes).toEqual({
      "enduragent.turn.id": "turn-spans-1",
      "enduragent.outcome": "ok",
    });

    const calls = spansNamed("llm.generate");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call && parentOf(call)).toBe(turnId);
    expect(call && keysOf(call)).toEqual([
      "enduragent.cost_usd",
      "enduragent.duration_ms",
      "enduragent.llm.attempt",
      "enduragent.llm.caller",
      "enduragent.outcome",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ]);
    expect(call?.attributes).toMatchObject({
      "gen_ai.provider.name": "openai-codex",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.usage.input_tokens": 30,
      "gen_ai.usage.output_tokens": 12,
      "enduragent.llm.caller": "chat",
      "enduragent.llm.attempt": 1,
      "enduragent.outcome": "ok",
    });
    expect(call?.attributes["enduragent.cost_usd"]).toBeCloseTo(
      (30 * 2.5 + 12 * 15) / 1_000_000,
      12,
    );

    const tools = spansNamed("tool.call");
    expect(tools.map((span) => [span.attributes["gen_ai.tool.name"], parentOf(span)])).toEqual([
      ["lookup_training", turnId],
      ["save_note", turnId],
    ]);
    expect(tools.map(keysOf)).toEqual([
      ["enduragent.duration_ms", "enduragent.outcome", "gen_ai.tool.name"],
      ["enduragent.duration_ms", "enduragent.outcome", "gen_ai.tool.name"],
    ]);
    expect(tools.map((span) => [span.attributes["enduragent.outcome"], span.status])).toEqual([
      ["ok", { code: 0 }],
      ["error", { code: 2 }],
    ]);
    expect(exporter.getFinishedSpans()).toHaveLength(4);

    const recorded = everythingOnSpans();
    for (const marker of Object.values(MARKERS)) expect(recorded).not.toContain(marker);
    expect(exporter.getFinishedSpans().flatMap((span) => span.events)).toEqual([]);
  });

  it("records a failed and retried model call as two attempts under one turn", async () => {
    let attempt = 0;
    const agent = agentWith(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error(`Request timeout while waiting for the model ${MARKERS.modelError}`);
      }
      return reply(`Ride easy today. ${MARKERS.reply}`);
    });

    await expect(
      agent.chat(MARKERS.chatId, MARKERS.prompt, undefined, undefined, undefined, "turn-spans-2"),
    ).resolves.toContain(MARKERS.reply);

    const turn = onlyTurnSpan();
    const calls = spansNamed("llm.generate");
    expect(
      calls.map((span) => [
        parentOf(span),
        span.attributes["enduragent.llm.attempt"],
        span.attributes["enduragent.outcome"],
        span.attributes["error.type"],
        span.status.code,
      ]),
    ).toEqual([
      [turn.spanContext().spanId, 1, "error", "timeout", 2],
      [turn.spanContext().spanId, 2, "ok", undefined, 0],
    ]);
    expect(turn.attributes["enduragent.outcome"]).toBe("ok");
    expect(everythingOnSpans()).not.toContain(MARKERS.modelError);
  });

  it("marks the turn failed with its error class when every attempt fails", async () => {
    const agent = agentWith(async () => {
      throw new Error(`Unauthorized: ${MARKERS.modelError}`);
    });

    await expect(
      agent.chat(MARKERS.chatId, MARKERS.prompt, undefined, undefined, undefined, "turn-spans-3"),
    ).rejects.toThrow();

    const turn = onlyTurnSpan();
    expect(turn.attributes["enduragent.outcome"]).toBe("error");
    expect(turn.attributes["error.type"]).toEqual(expect.any(String));
    expect(turn.status).toEqual({ code: 2 });
    expect(
      spansNamed("llm.generate").every((span) => parentOf(span) === turn.spanContext().spanId),
    ).toBe(true);
    expect(everythingOnSpans()).not.toContain(MARKERS.modelError);
  });

  it("keeps counting attempts when a queue retry resumes the turn", async () => {
    let attempt = 0;
    const agent = agentWith(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Request timeout while waiting for the model");
        return reply("Ride easy today.");
      },
      {
        append: () => undefined,
        callsForTurn: (turnId) => [
          {
            ts: 0,
            kind: "generate",
            caller: "chat",
            provider: "openai-codex",
            model: "gpt-5.4",
            durationMs: 0,
            turnId,
            outcome: "error",
            errorClass: "server_error",
          },
        ],
      },
    );

    await agent.chat(
      MARKERS.chatId,
      MARKERS.prompt,
      { resumesTurn: true },
      undefined,
      undefined,
      "turn-spans-4",
    );

    expect(
      spansNamed("llm.generate").map((span) => span.attributes["enduragent.llm.attempt"]),
    ).toEqual([2, 3]);
  });

  it("gives a Coach decision continuation its own turn span", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-spans-decision-"));
    roots.push(root);
    const base = baseAgentConfig(root);
    const ids = ["continuation-1", "turn-decision-resume"];
    const engine = createCoachEngine({
      sport: { ...sport, tools: () => [] },
      ports: {
        ...base,
        randomId: () => ids.shift() ?? "unused",
        modelTransportDecorator: () => ({
          generate: async () => reply(`Keep tomorrow easy. ${MARKERS.reply}`),
        }),
      },
    });
    const decision: CoachDecisionReadModel = {
      status: "unanswered",
      decisionId: "decision-1",
      chatId: MARKERS.chatId,
      messageId: "message-1",
      question: "Choose tomorrow's priority.",
      options: [
        {
          id: "recovery",
          label: "Recovery",
          description: "Ride easy.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Tempo",
          description: "Keep the planned work.",
          recommended: false,
          consequence: "Tomorrow keeps the tempo session.",
        },
      ],
    };
    const store = base.coachDecisions;
    if (store === undefined) throw new Error("no decision store");
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision,
      toolCallId: "tool-1",
      athleteText: MARKERS.prompt,
      requestedAt: "1998-08-24T00:00:00.000Z",
    });

    await engine.answerCoachDecision({
      chatId: MARKERS.chatId,
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
    });

    const turn = onlyTurnSpan();
    expect(turn.attributes).toEqual({
      "enduragent.turn.id": "turn-decision-resume",
      "enduragent.outcome": "ok",
    });
    const calls = spansNamed("llm.generate");
    expect(
      calls.map((span) => [parentOf(span), span.attributes["enduragent.llm.attempt"]]),
    ).toEqual([[turn.spanContext().spanId, 1]]);
    const recorded = everythingOnSpans();
    for (const marker of Object.values(MARKERS)) expect(recorded).not.toContain(marker);
  });
});
