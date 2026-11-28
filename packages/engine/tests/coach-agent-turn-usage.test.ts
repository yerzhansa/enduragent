import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelUsage } from "ai";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { COACH_DECISION_TOOL_NAME } from "../src/agent/coach-decision-tool.js";
import type {
  EngineConfig,
  EngineHostPorts,
  LoggerFields,
  UsageLedgerLine,
} from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const memoryWriteSchema = z.object({ note: z.string() });

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
      name: "memory_write",
      description: "memory_write",
      inputSchema: memoryWriteSchema,
      tool: tool({ inputSchema: memoryWriteSchema, execute: async () => ({ saved: true }) }),
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

function reply(text: string, tokens = usage(30, 12), steps = 1): GenerateResult {
  return { text, toolCalls: [], finishReason: "stop", usage: tokens, totalUsage: tokens, steps };
}

interface TurnOutcomeRecord {
  readonly turnId: string;
  readonly ok: boolean;
  readonly error_class?: string;
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

function harness(
  respond: ((options: GenerateOptions) => Promise<GenerateResult>) | undefined,
  Agent: typeof CoachAgent = CoachAgent,
) {
  const root = mkdtempSync(join(tmpdir(), "turn-usage-"));
  roots.push(root);
  mkdirSync(join(root, "memory"));
  const rows: UsageLedgerLine[] = [];
  const outcomes: TurnOutcomeRecord[] = [];
  const base = baseAgentConfig(root);
  const ports: EngineHostPorts = {
    ...base,
    config: { ...base.config, models: pricedModels() },
    usage: { append: (line) => rows.push(line) },
    logger: {
      debug: () => undefined,
      info: (event: string, fields?: LoggerFields) => {
        if (event === "turn_outcome") outcomes.push(fields as unknown as TurnOutcomeRecord);
      },
      warn: () => undefined,
      error: () => undefined,
    },
    ...(respond === undefined
      ? {}
      : {
          modelTransportDecorator: () => ({
            generate: async (request) => respond(request.options),
          }),
        }),
  };
  const agent = new Agent(sport, ports);
  const chat = (chatId: string, text: string, turnId: string) =>
    agent.chat(chatId, text, undefined, undefined, undefined, turnId);
  const turnRows = () => rows.filter((row) => row.kind === "turn");
  const chatCalls = (turnId: string) =>
    rows.filter((row) => row.kind === "generate" && row.caller === "chat" && row.turnId === turnId);
  return { agent, chat, rows, outcomes, turnRows, chatCalls };
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

function sumOf(
  rows: readonly UsageLedgerLine[],
  pick: (row: UsageLedgerLine) => number | undefined,
) {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
}

describe("a turn's cost row sums every attempt", () => {
  it("adds a failed attempt with known usage and one without to the winning reply", async () => {
    let attempt = 0;
    const turn = harness(async (options) => {
      if (options.caller === "compact")
        return reply("## Athlete Profile\n- Rides on weekends", usage(500, 50));
      if (options.caller === "flush") return reply("Nothing new to save.", usage(400, 40));
      attempt += 1;
      if (attempt === 1) {
        options.onStepUsage?.({ usage: usage(20, 8) });
        throw new Error("Request timeout while waiting for the model");
      }
      if (attempt === 2) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return reply("Ride easy for an hour today.", usage(30, 12), 2);
    });

    await expect(turn.chat("chat-sum", "What should I ride today?", "turn-sum")).resolves.toContain(
      "Ride easy for an hour today.",
    );

    const calls = turn.chatCalls("turn-sum");
    expect(calls.map((row) => [row.outcome, row.errorClass, row.inputTokens])).toEqual([
      ["error", "timeout", 20],
      ["error", "overflow", undefined],
      ["ok", undefined, 30],
    ]);
    const [row] = turn.turnRows();
    expect(turn.turnRows()).toHaveLength(1);
    expect(row).toMatchObject({
      kind: "turn",
      caller: "chat",
      turnId: "turn-sum",
      outcome: "ok",
      steps: 3,
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
    });
    expect(row?.errorClass).toBeUndefined();
    expect(row?.inputTokens).toBe(sumOf(calls, (call) => call.inputTokens));
    expect(row?.outputTokens).toBe(sumOf(calls, (call) => call.outputTokens));
    expect(row?.steps).toBe(sumOf(calls, (call) => call.steps));
    expect(row?.cost?.total).toBeCloseTo(
      sumOf(calls, (call) => call.cost?.total),
      12,
    );
    expect(row?.cost?.total).toBeGreaterThan(calls[2]?.cost?.total ?? 0);
    const otherCallers = turn.rows.filter(
      (other) => other.kind === "generate" && other.caller !== "chat",
    );
    expect(otherCallers.map((other) => [other.caller, other.turnId])).toContainEqual([
      "flush",
      "turn-sum",
    ]);
  });
});

describe("every exit of a turn writes one cost row", () => {
  it("writes an ok row when the turn ends by asking the athlete a decision", async () => {
    vi.resetModules();
    vi.doMock("../src/agent/codex/responses.js", () => ({
      codexResponses: vi.fn(async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-decision",
            name: COACH_DECISION_TOOL_NAME,
            arguments: {
              question: "Which session should lead tomorrow?",
              options: [
                {
                  label: "Recovery",
                  description: "Ride easy.",
                  recommended: true,
                  consequence: "Tomorrow becomes a recovery day.",
                },
                {
                  label: "Tempo",
                  description: "Keep the planned work.",
                  recommended: false,
                  consequence: "Tomorrow keeps the tempo session.",
                },
              ],
            },
          },
        ],
        usage: { input: 25, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
        stopReason: "toolUse",
      })),
    }));
    const { CoachAgent: CodexCoachAgent } = await import("../src/agent/coach-agent.js");
    const turn = harness(undefined, CodexCoachAgent);

    await expect(turn.chat("desktop", "Plan tomorrow.", "turn-decision")).resolves.toBe("");

    const calls = turn.chatCalls("turn-decision");
    expect(calls).toHaveLength(1);
    expect(turn.turnRows()).toEqual([
      expect.objectContaining({
        turnId: "turn-decision",
        outcome: "ok",
        inputTokens: calls[0]?.inputTokens,
        outputTokens: calls[0]?.outputTokens,
      }),
    ]);
    expect(calls[0]?.inputTokens).toBeGreaterThan(0);
    expect(turn.turnRows()[0]?.errorClass).toBeUndefined();
    expect(turn.outcomes).toEqual([expect.objectContaining({ turnId: "turn-decision", ok: true })]);
  });

  it("writes an error row when the turn fails after a write", async () => {
    const turn = harness(async (options) => {
      await runTool(options, "memory_write", { note: "Prefers weekend rides" });
      options.onStepUsage?.({ usage: usage(15, 6) });
      throw new Error("Provider returned an unexpected payload");
    });

    await turn.chat("chat-write", "Remember that I ride on weekends.", "turn-write");

    expect(turn.turnRows()).toEqual([
      expect.objectContaining({
        turnId: "turn-write",
        outcome: "error",
        errorClass: "unknown",
        inputTokens: 15,
        outputTokens: 6,
      }),
    ]);
    expect(turn.outcomes).toEqual([
      expect.objectContaining({ turnId: "turn-write", ok: false, error_class: "unknown" }),
    ]);
  });

  it("writes an aborted row when the athlete presses Stop", async () => {
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const turn = harness(async (options) => {
      options.onStepUsage?.({ usage: usage(12, 4) });
      started?.();
      return new Promise<GenerateResult>((_, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("The athlete stopped the reply", "AbortError")),
        );
      });
    });

    const reply = turn.chat("chat-stop", "Plan my week.", "turn-stop");
    await running;
    expect(turn.agent.stopChat("chat-stop", "turn-stop")).toBe(true);
    await reply;

    expect(turn.turnRows()).toEqual([
      expect.objectContaining({
        turnId: "turn-stop",
        outcome: "error",
        errorClass: "aborted",
        inputTokens: 12,
        outputTokens: 4,
      }),
    ]);
    expect(turn.outcomes).toEqual([
      expect.objectContaining({ turnId: "turn-stop", ok: false, error_class: "interrupted" }),
    ]);
  });

  it("writes an error row with no usage when the turn finally fails", async () => {
    const turn = harness(async () => {
      throw new Error("Provider returned an unexpected payload");
    });

    await expect(turn.chat("chat-fail", "Plan my week.", "turn-fail")).rejects.toThrow(
      "Provider returned an unexpected payload",
    );

    const [row] = turn.turnRows();
    expect(turn.turnRows()).toHaveLength(1);
    expect(row).toMatchObject({
      turnId: "turn-fail",
      outcome: "error",
      errorClass: "unknown",
      steps: 0,
    });
    expect(row?.inputTokens).toBeUndefined();
    expect(row?.cost).toBeUndefined();
    expect(turn.outcomes).toEqual([
      expect.objectContaining({ turnId: "turn-fail", ok: false, error_class: "unknown" }),
    ]);
  });
});
