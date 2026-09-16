import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EngineConfig,
  EngineHostPorts,
  ModelTransportDecorator,
  ModelTransportRequest,
  UsageLedgerLine,
} from "../src/host-ports.js";
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
  models: testModelProfiles({
    provider: "anthropic",
    chat: "claude-sonnet-4-6",
    chatContextWindowTokens: 1_000_000,
    compactContextWindowTokens: 200_000,
  }),
  contextWindowTokens: 1_000_000,
  compactContextWindowTokens: 200_000,
};

function result(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    },
    totalUsage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

function streamed(text: string) {
  const completed = result(text);
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", id: "text-1", text };
      yield {
        type: "finish",
        finishReason: completed.finishReason,
        rawFinishReason: completed.finishReason,
        totalUsage: completed.totalUsage,
      };
    })(),
    text: Promise.resolve(completed.text),
    toolCalls: Promise.resolve(completed.toolCalls),
    finishReason: Promise.resolve(completed.finishReason),
    usage: Promise.resolve(completed.usage),
    totalUsage: Promise.resolve(completed.totalUsage),
    steps: Promise.resolve([{}]),
  };
}

async function loadLlm(
  decorator: ModelTransportDecorator,
  streamText: ReturnType<typeof vi.fn>,
): Promise<{ llm: import("../src/llm.js").LLM; usage: UsageLedgerLine[] }> {
  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return { ...actual, streamText };
  });
  const { LLM } = await import("../src/llm.js");
  const usage: UsageLedgerLine[] = [];
  let now = 10;
  const ports: Pick<
    EngineHostPorts,
    "usage" | "now" | "getAccessToken" | "classifyFailure" | "modelTransportDecorator"
  > = {
    usage: { append: (line) => usage.push(line) },
    now: () => now++,
    getAccessToken: async () => "token",
    classifyFailure: () => "unknown",
    modelTransportDecorator: decorator,
  };
  return { llm: new LLM(config, ports), usage };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("model transport decorator", () => {
  it("keeps chat, compact, and flush on one captured generation", async () => {
    const requests: ModelTransportRequest[] = [];
    const usage: UsageLedgerLine[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = testModelProfiles({
      provider: "anthropic",
      chat: "chat-old",
      compact: "compact-old",
      flush: "flush-old",
      catalogRevision: 17,
    });
    const decorator: ModelTransportDecorator = () => ({
      generate: async (request) => {
        requests.push(request);
        await gate;
        return result(request.model);
      },
    });
    const ports = {
      usage: { append: (line: UsageLedgerLine) => usage.push(line) },
      now: () => 10,
      getAccessToken: async () => "token",
      classifyFailure: () => "unknown" as const,
      modelTransportDecorator: decorator,
    };
    const { LLM } = await import("../src/llm.js");
    const runtimeConfig = { ...config, models };
    const pending = Promise.all([
      new LLM(runtimeConfig, ports, models.chat).generate({ prompt: "chat", caller: "chat" }),
      new LLM(runtimeConfig, ports, models.compact).generate({
        prompt: "compact",
        caller: "compact",
      }),
      new LLM(runtimeConfig, ports, models.flush).generate({ prompt: "flush", caller: "flush" }),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    release?.();
    await pending;

    expect(requests.map(({ model }) => model).sort()).toEqual([
      "chat-old",
      "compact-old",
      "flush-old",
    ]);
    expect(new Set(usage.map(({ catalogRevision }) => catalogRevision))).toEqual(new Set([17]));
  });

  it("record mode delegates exactly once through the canonical request", async () => {
    const sdkGenerate = vi.fn(() => streamed("recorded"));
    let delegated = 0;
    const decorator: ModelTransportDecorator = (next) => ({
      generate: async (request) => {
        delegated++;
        return next.generate(request);
      },
    });
    const { llm, usage } = await loadLlm(decorator, sdkGenerate);
    await expect(llm.generate({ prompt: "hello", caller: "chat" })).resolves.toMatchObject({
      text: "recorded",
    });
    expect(delegated).toBe(1);
    expect(sdkGenerate).toHaveBeenCalledTimes(1);
    expect(usage).toHaveLength(1);
  });

  it("replay mode delegates zero times while the outer path appends one usage line", async () => {
    const sdkGenerate = vi.fn(() => streamed("unexpected"));
    const replay = result("replayed");
    const decorator: ModelTransportDecorator = () => ({
      generate: async () => replay,
    });
    const { llm, usage } = await loadLlm(decorator, sdkGenerate);
    await expect(llm.generate({ prompt: "hello", caller: "chat" })).resolves.toMatchObject(replay);
    expect(sdkGenerate).not.toHaveBeenCalled();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kind: "generate",
      caller: "chat",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      totalTokens: 5,
    });
  });
});
