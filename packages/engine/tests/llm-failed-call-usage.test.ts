import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, UsageLedgerLine } from "../src/host-ports.js";
import type { GenerateOpts } from "../src/llm-types.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";

const profile = {
  kind: "catalog" as const,
  catalogRevision: 31,
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  compatibilityProfile: "anthropic-ai-sdk-v1" as const,
  contextWindowTokens: 1_000,
  imageInput: "supported" as const,
  pricing: {
    kind: "token-rates" as const,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.2,
    cacheWriteUsdPerMillion: 2.5,
  },
};

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
  models: { catalogRevision: 31, chat: profile, compact: profile, flush: profile },
  contextWindowTokens: 1_000,
  compactContextWindowTokens: 1_000,
};

const finishedStepUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  totalTokens: 1_100,
  inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
};

const finishedStepCostUsd = (1_000 * 2 + 100 * 10) / 1_000_000;

interface SdkCall {
  readonly abortSignal: AbortSignal;
  readonly onStepFinish: (step: { usage: typeof finishedStepUsage }) => void;
}

function serverError(): Error {
  const error = new Error("Service unavailable");
  error.name = "ServerError";
  return error;
}

function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function subject(input: {
  readonly generateText?: (call: SdkCall) => Promise<unknown>;
  readonly streamText?: (call: SdkCall) => unknown;
  readonly append?: (line: UsageLedgerLine) => void;
  readonly classifyFailure?: () => never;
  readonly chatStreamTimeouts?: { readonly ttftMs: number; readonly interChunkMs: number };
}) {
  vi.doMock("@ai-sdk/anthropic", () => ({
    createAnthropic: () => () => ({ provider: "anthropic-stub" }),
  }));
  vi.doMock("ai", () => ({
    generateText: vi.fn(async (call: SdkCall) => input.generateText?.(call)),
    streamText: vi.fn((call: SdkCall) => input.streamText?.(call)),
    stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
  }));
  const { LLM } = await import("../src/llm.js");
  const lines: UsageLedgerLine[] = [];
  const llm = new LLM(config, {
    ...llmTestPorts(),
    usage: { append: input.append ?? ((line: UsageLedgerLine) => lines.push(line)) },
    now: () => 1_000,
    ...(input.classifyFailure === undefined ? {} : { classifyFailure: input.classifyFailure }),
    ...(input.chatStreamTimeouts === undefined
      ? {}
      : { chatStreamTimeouts: input.chatStreamTimeouts }),
  });
  const generate = (opts: GenerateOpts) => llm.generate(opts);
  return { generate, lines };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failed model call still leaves a ledger row", () => {
  it("records an HTTP failure with no usage figure as an error row for its turn", async () => {
    const { generate, lines } = await subject({
      generateText: async () => {
        throw serverError();
      },
    });

    await expect(
      generate({ prompt: "hello", caller: "flush", turnId: "turn-http" }),
    ).rejects.toThrow("Service unavailable");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "generate",
      caller: "flush",
      provider: "anthropic",
      model: "claude-sonnet-5",
      turnId: "turn-http",
      outcome: "error",
      errorClass: "server_error",
      steps: 0,
      catalogRevision: 31,
    });
    expect(lines[0]?.inputTokens).toBeUndefined();
    expect(lines[0]?.outputTokens).toBeUndefined();
    expect(lines[0]?.cost).toBeUndefined();
    expect(lines[0]).not.toHaveProperty("stopReason");
  });

  it("prices the known usage of the steps that finished before the failure", async () => {
    const { generate, lines } = await subject({
      generateText: async (call) => {
        call.onStepFinish({ usage: finishedStepUsage });
        throw serverError();
      },
    });

    await expect(
      generate({ prompt: "hello", caller: "compact", turnId: "turn-partial" }),
    ).rejects.toThrow("Service unavailable");

    expect(lines[0]).toMatchObject({
      turnId: "turn-partial",
      outcome: "error",
      errorClass: "server_error",
      steps: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
    });
    expect(lines[0]?.cost?.total).toBeCloseTo(finishedStepCostUsd, 9);
  });

  it("records a chat call the athlete stopped as an aborted error row", async () => {
    const controller = new AbortController();
    const { generate, lines } = await subject({
      streamText: (call) => ({
        fullStream: (async function* () {
          yield { type: "text-delta", id: "text-1", text: "Easy" };
          call.onStepFinish({ usage: finishedStepUsage });
          controller.abort();
          yield { type: "abort", reason: "stopped" };
        })(),
      }),
    });

    await expect(
      generate({
        prompt: "hello",
        caller: "chat",
        turnId: "turn-stopped",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      caller: "chat",
      turnId: "turn-stopped",
      outcome: "error",
      errorClass: "aborted",
      steps: 1,
      inputTokens: 1_000,
    });
  });

  it("records a call that ran past its deadline as a timeout error row", async () => {
    const { generate, lines } = await subject({
      generateText: (call) => abortedBy(call.abortSignal),
    });

    await expect(
      generate({ prompt: "hello", caller: "flush", turnId: "turn-late", deadlineMs: 5 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(lines[0]).toMatchObject({
      turnId: "turn-late",
      outcome: "error",
      errorClass: "timeout",
    });
  });

  it("records a chat stream that went silent as a timeout error row and rethrows the stall", async () => {
    const { generate, lines } = await subject({
      chatStreamTimeouts: { ttftMs: 5, interChunkMs: 5 },
      streamText: (call) => ({
        fullStream: (async function* () {
          yield* [];
          await abortedBy(call.abortSignal);
        })(),
      }),
    });

    await expect(
      generate({ prompt: "hello", caller: "chat", turnId: "turn-stalled" }),
    ).rejects.toMatchObject({ name: "TimeoutError", code: "CHAT_TTFT_TIMEOUT" });

    expect(lines[0]).toMatchObject({
      turnId: "turn-stalled",
      outcome: "error",
      errorClass: "timeout",
    });
  });

  it("rethrows the provider error and records it as unknown when the failure classifier throws", async () => {
    const { generate, lines } = await subject({
      generateText: async () => {
        throw serverError();
      },
      classifyFailure: () => {
        throw new Error("classifier unavailable");
      },
    });

    await expect(
      generate({ prompt: "hello", caller: "flush", turnId: "turn-unclassified" }),
    ).rejects.toThrow("Service unavailable");

    expect(lines[0]).toMatchObject({
      turnId: "turn-unclassified",
      outcome: "error",
      errorClass: "unknown",
    });
  });

  it("rethrows the provider error when the ledger write itself fails", async () => {
    const { generate } = await subject({
      generateText: async () => {
        throw serverError();
      },
      append: () => {
        throw new Error("ledger unavailable");
      },
    });

    await expect(generate({ prompt: "hello", caller: "flush" })).rejects.toThrow(
      "Service unavailable",
    );
  });
});

describe("a successful model call row", () => {
  it("carries outcome ok and its turn ID, and omits an empty turn ID", async () => {
    const { generate, lines } = await subject({
      generateText: async () => ({
        text: "answer",
        toolCalls: [],
        finishReason: "stop",
        usage: finishedStepUsage,
        totalUsage: finishedStepUsage,
        steps: [],
      }),
    });

    await generate({ prompt: "hello", caller: "flush", turnId: "turn-ok" });
    await generate({ prompt: "hello", caller: "flush", turnId: "" });

    expect(lines[0]).toMatchObject({ turnId: "turn-ok", outcome: "ok", stopReason: "stop" });
    expect(lines[0]).not.toHaveProperty("errorClass");
    expect(lines[1]).toMatchObject({ outcome: "ok" });
    expect(lines[1]).not.toHaveProperty("turnId");
  });
});
