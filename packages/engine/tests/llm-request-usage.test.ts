import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReport } from "../../../tools/usage-baseline.js";
import type { EngineConfig, UsageLedgerLine } from "../src/host-ports.js";
import { requestUsageFromSteps, usageFieldsFromResult } from "../src/llm-types.js";
import type { GenerateResult } from "../src/sport.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

const config: EngineConfig = {
  dataSource: "platform",
  llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "test" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  models: testModelProfiles({ provider: "anthropic", chat: "claude-sonnet-4-6" }),
  contextWindowTokens: 200_000,
  compactContextWindowTokens: 200_000,
};

const firstUsage: LanguageModelV3Usage = {
  inputTokens: { total: 100, noCache: 10, cacheRead: 80, cacheWrite: 10 },
  outputTokens: { total: 20, text: 10, reasoning: 10 },
  raw: { hidden: "synthetic-private-provider-data" },
};

const secondUsage: LanguageModelV3Usage = {
  inputTokens: { total: 150, noCache: 20, cacheRead: 120, cacheWrite: 10 },
  outputTokens: { total: 30, text: 20, reasoning: 10 },
};

const unknownUsage: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function generation(
  step: number,
  usages: readonly LanguageModelV3Usage[],
): LanguageModelV3GenerateResult {
  const last = step === usages.length - 1;
  return {
    content: last
      ? [{ type: "text", text: "answer" }]
      : [{ type: "tool-call", toolCallId: `read-${step}`, toolName: "read", input: "{}" }],
    finishReason: { unified: last ? "stop" : "tool-calls", raw: last ? "end_turn" : "tool_use" },
    usage: usages[step],
    warnings: [],
    providerMetadata: { synthetic: { hidden: "synthetic-private-provider-data" } },
  };
}

async function run(caller: "chat" | "flush", usages = [firstUsage, secondUsage]) {
  let step = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => generation(step++, usages),
    doStream: async () => {
      const result = generation(step++, usages);
      const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const content of result.content) {
        if (content.type === "tool-call") parts.push(content);
        if (content.type === "text") {
          parts.push(
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: content.text },
            { type: "text-end", id: "answer" },
          );
        }
      }
      parts.push({
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
        providerMetadata: result.providerMetadata,
      });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => model }));
  const { LLM } = await import("../src/llm.js");
  const lines: UsageLedgerLine[] = [];
  const llm = new LLM(config, {
    usage: { append: (line) => lines.push(line) },
    now: () => 1,
    getAccessToken: async () => "unused",
    classifyFailure: () => "unknown",
  });
  const generated = await llm.generate({
    caller,
    prompt: "synthetic-private-prompt",
    tools: {
      read: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ value: "synthetic-private-tool-output" }),
      }),
    },
    stopWhen: stepCountIs(usages.length),
  });
  return { generated, lines, model };
}

async function ledgerForResult(result: GenerateResult): Promise<readonly UsageLedgerLine[]> {
  const { LLM } = await import("../src/llm.js");
  const lines: UsageLedgerLine[] = [];
  const llm = new LLM(config, {
    usage: { append: (line) => lines.push(line) },
    now: () => 1,
    getAccessToken: async () => "unused",
    classifyFailure: () => "unknown",
    modelTransportDecorator: () => ({ generate: async () => result }),
  });
  await llm.generate({ prompt: "synthetic-private-prompt", caller: "chat" });
  return lines;
}

afterEach(() => {
  vi.doUnmock("@ai-sdk/anthropic");
  vi.resetModules();
});

describe("AI SDK request usage", () => {
  it.each(["chat", "flush"] as const)(
    "records each %s request without changing generation totals",
    async (caller) => {
      const { generated, lines, model } = await run(caller);
      expect(model.doGenerateCalls.length + model.doStreamCalls.length).toBe(2);
      const expected = [
        { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10 },
        { inputTokens: 150, outputTokens: 30, cacheReadTokens: 120, cacheWriteTokens: 10 },
      ];
      expect(generated.requestUsage).toEqual(expected);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        kind: "generate",
        steps: 2,
        inputTokens: 250,
        outputTokens: 50,
        totalTokens: 300,
        cacheReadTokens: 200,
        cacheWriteTokens: 20,
        requestUsage: expected,
      });
      expect(JSON.stringify(lines)).not.toContain("synthetic-private");
      expect(Object.keys(expected[0]).sort()).toEqual(
        Object.keys(generated.requestUsage?.[0] ?? {}).sort(),
      );
    },
  );

  it.each(["chat", "flush"] as const)("keeps absent %s usage unknown", async (caller) => {
    const { generated, lines } = await run(caller, [firstUsage, unknownUsage]);
    expect(generated.requestUsage).toHaveLength(2);
    expect(JSON.stringify(generated.requestUsage?.[1])).toBe("{}");
    expect(JSON.stringify(lines[0].requestUsage?.[1])).toBe("{}");
  });

  it("preserves existing usage report rollups", async () => {
    const { lines } = await run("chat");
    const report = (values: readonly UsageLedgerLine[]) =>
      buildReport({
        ledgerPath: "/synthetic-ledger",
        dataDirSource: "test",
        raw: values.map((line) => JSON.stringify(line)).join("\n"),
        kind: "generate",
        caller: "all",
      });
    const withoutRequests = lines.map(({ requestUsage: _requestUsage, ...line }) => line);
    expect(report(lines)).toEqual(report(withoutRequests));
  });

  it("omits unsupported request usage and empty SDK step lists", async () => {
    const result: GenerateResult = {
      text: "answer",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
    };
    expect(usageFieldsFromResult(result)).not.toHaveProperty("requestUsage");
    expect(requestUsageFromSteps([])).toBeUndefined();
    expect((await ledgerForResult(result))[0]).not.toHaveProperty("requestUsage");
  });

  it("whitelists and validates nested ledger counts from a decorated transport", async () => {
    const requestUsage = [
      {
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: -1,
        cacheReadTokens: 0.5,
        cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1,
        prompt: "synthetic-private-prompt",
        providerMetadata: { hidden: "synthetic-private-data" },
      },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ];
    const result: GenerateResult = {
      text: "answer",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      requestUsage,
    };
    expect(usageFieldsFromResult(result)).not.toHaveProperty("requestUsage");
    const serialized = JSON.stringify((await ledgerForResult(result))[0]);
    expect(JSON.parse(serialized).requestUsage).toEqual([
      {},
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(serialized).not.toContain("synthetic-private");
  });
});
