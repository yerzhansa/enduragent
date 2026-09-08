import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, UsageLedgerLine } from "../src/host-ports.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";

const config: EngineConfig = {
  dataSource: "platform",
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    ["api" + "Key"]: "test",
  } as unknown as EngineConfig["llm"],
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1_000,
  compactContextWindowTokens: 1_000,
};

const inclusiveUsage = {
  inputTokens: 10_000,
  outputTokens: 100,
  totalTokens: 10_100,
  inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
};

const expectedTotal =
  (1_000 * 2 + 8_000 * 0.2 + 1_000 * 2.5 + 100 * 10) / 1_000_000;

function streamed() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", id: "text-1", text: "answer" };
      yield {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: inclusiveUsage,
      };
    })(),
    text: Promise.resolve("answer"),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve(inclusiveUsage),
    totalUsage: Promise.resolve(inclusiveUsage),
    steps: Promise.resolve([]),
  };
}

async function subject(caller: "chat" | "flush") {
  vi.doMock("@ai-sdk/anthropic", () => ({
    createAnthropic: () => () => ({ provider: "anthropic-stub" }),
  }));
  vi.doMock("ai", () => ({
    generateText: vi.fn(async () => ({
      text: "answer",
      toolCalls: [],
      finishReason: "stop",
      usage: inclusiveUsage,
      totalUsage: inclusiveUsage,
      steps: [],
    })),
    streamText: vi.fn(() => streamed()),
    stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
  }));
  const { LLM } = await import("../src/llm.js");
  const lines: UsageLedgerLine[] = [];
  let now = 100;
  const llm = new LLM(config, {
    ...llmTestPorts(),
    usage: { append: (line: UsageLedgerLine) => lines.push(line) },
    now: () => now++,
  });
  const generated = await llm.generate({ prompt: "hello", caller });
  return { generated, lines };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI SDK usage pricing charges only the uncached input share", () => {
  it.each(["chat", "flush"] as const)("%s caller", async (caller) => {
    const { generated, lines } = await subject(caller);
    expect(generated.cost?.total).toBeCloseTo(expectedTotal, 9);
    expect(generated.cost?.input).toBeCloseTo((1_000 * 2) / 1_000_000, 9);
    expect(lines.at(-1)?.cost?.total).toBeCloseTo(expectedTotal, 9);
  });
});
