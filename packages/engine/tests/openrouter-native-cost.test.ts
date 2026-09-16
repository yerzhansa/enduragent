import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, UsageLedgerLine } from "../src/host-ports.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

const config: EngineConfig = {
  dataSource: "platform",
  llm: {
    provider: "openrouter",
    model: "synthetic/model",
    ["api" + "Key"]: "",
  } as unknown as EngineConfig["llm"],
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  models: testModelProfiles({ provider: "openrouter", chat: "synthetic/model" }),
  contextWindowTokens: 1_000,
  compactContextWindowTokens: 1_000,
};

function step(cost: unknown, upstreamInferenceCost?: number) {
  return {
    providerMetadata: {
      openrouter: { usage: { cost }, costDetails: { upstreamInferenceCost } },
    },
  };
}

function result(steps: readonly unknown[]) {
  return {
    text: "answer",
    toolCalls: [],
    finishReason: "stop",
    usage: {},
    totalUsage: {},
    steps,
  };
}

function streamed(steps: readonly unknown[]) {
  const value = result(steps);
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", id: "text-1", text: "answer" };
      yield { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} };
    })(),
    text: Promise.resolve(value.text),
    toolCalls: Promise.resolve(value.toolCalls),
    finishReason: Promise.resolve(value.finishReason),
    usage: Promise.resolve(value.usage),
    totalUsage: Promise.resolve(value.totalUsage),
    steps: Promise.resolve(value.steps),
  };
}

async function subject(mode: "generate" | "stream", steps: readonly unknown[]) {
  const chat = vi.fn(() => ({ provider: "openrouter-stub" }));
  vi.doMock("@openrouter/ai-sdk-provider", () => ({
    createOpenRouter: () => ({ chat }),
  }));
  vi.doMock("ai", () => ({
    generateText: vi.fn(async () => result(steps)),
    streamText: vi.fn(() => streamed(steps)),
  }));
  const { LLM } = await import("../src/llm.js");
  const lines: UsageLedgerLine[] = [];
  let now = 100;
  const ports = {
    ...llmTestPorts(),
    usage: { append: (line: UsageLedgerLine) => lines.push(line) },
    now: () => now++,
  };
  const llm = new LLM(config, ports);
  const generated = await llm.generate({
    prompt: "hello",
    caller: mode === "stream" ? "chat" : "flush",
  });
  return { chat, generated, lines };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("OpenRouter native cost", () => {
  it.each(["generate", "stream"] as const)(
    "sums every %s step and writes one provider-reported generation cost",
    async (mode) => {
      const test = await subject(mode, [step(0.01), step(0.02)]);
      expect(test.chat).toHaveBeenCalledWith("synthetic/model", { usage: { include: true } });
      expect(test.generated.providerReportedCostUsd).toBe(0.03);
      expect(test.lines).toHaveLength(1);
      expect(test.lines[0]?.providerReportedCostUsd).toBe(0.03);
    },
  );

  it("accepts exact zero and rejects incomplete or invalid metadata without a partial sum", async () => {
    expect((await subject("generate", [step(0), step(0)])).generated.providerReportedCostUsd).toBe(
      0,
    );
    for (const steps of [
      [step(0.01), {}],
      [step(0.01), step(-1)],
      [step(0.01), step(NaN)],
      [step(0.01), step(Infinity)],
      [],
      [step(undefined, 0.25)],
    ]) {
      vi.resetModules();
      expect((await subject("generate", steps)).generated.providerReportedCostUsd).toBeUndefined();
    }
  });
});
