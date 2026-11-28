import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { TurnEvent } from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createCoachEngine } from "../src/index.js";
import type {
  EngineHostPorts,
  FailureReason,
  ModelTransportRequest,
  UsageLedgerLine,
} from "../src/host-ports.js";
import type { GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const createdDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "engine-streaming-"));
  createdDirs.push(dir);
  return dir;
}

function result(
  text: string,
  finishReason: GenerateResult["finishReason"] = "stop",
): GenerateResult {
  const usage = {
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
    inputTokenDetails: {
      noCacheTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  };
  return {
    text,
    toolCalls: [],
    finishReason,
    usage,
    totalUsage: usage,
    steps: 1,
  };
}

function engineWithTransport(input: {
  generate: (request: ModelTransportRequest) => Promise<GenerateResult>;
  classifyFailure?: (error: unknown) => FailureReason;
  usage?: UsageLedgerLine[];
  chatProvider?: EngineHostPorts["config"]["models"]["chat"]["provider"];
}) {
  const dataDir = makeDir();
  const base = baseAgentConfig(dataDir);
  const chatProvider = input.chatProvider;
  const ports: EngineHostPorts = {
    ...base,
    ...(chatProvider === undefined
      ? {}
      : {
          config: {
            ...base.config,
            models: {
              ...base.config.models,
              chat: { ...base.config.models.chat, provider: chatProvider },
            },
          },
        }),
    randomId: () => "turn-stream-1",
    classifyFailure: input.classifyFailure ?? base.classifyFailure,
    usage: {
      append: (line) => input.usage?.push(line),
    },
    modelTransportDecorator: () => ({ generate: input.generate }),
  };
  return {
    dataDir,
    engine: createCoachEngine({
      sport: cyclingSport as unknown as Sport,
      ports,
    }),
  };
}

describe("coach agent streaming", () => {
  it("emits actionable reauthentication copy for a rejected sign-in refresh", async () => {
    const failure = new Error("rejected");
    const { engine } = engineWithTransport({
      generate: async () => {
        throw failure;
      },
      classifyFailure: () => "reauth",
    });
    const events: TurnEvent[] = [];

    await expect(
      engine.chat({ chatId: "reauth", message: "hello" }, (event) => events.push(event)),
    ).rejects.toBe(failure);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      kind: "subscription-signed-out",
      athleteMessage: "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.",
    });
  });

  function paymentRequired(): APICallError {
    return new APICallError({
      message: "Insufficient credits",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: '{"error":{"code":402,"message":"Insufficient credits"}}',
    });
  }

  it("emits the OpenRouter credits error once for an OpenRouter 402 without retrying", async () => {
    const failure = paymentRequired();
    const generate = vi.fn(async (): Promise<GenerateResult> => {
      throw failure;
    });
    const { engine } = engineWithTransport({ generate, chatProvider: "openrouter" });
    const events: TurnEvent[] = [];

    await expect(
      engine.chat({ chatId: "credits", message: "hello" }, (event) => events.push(event)),
    ).rejects.toBe(failure);

    expect(generate).toHaveBeenCalledTimes(1);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "openrouter-credits",
      error_class: "unknown",
      message: { key: "coach.error.openRouterCredits", vars: { openrouter: "OpenRouter" } },
      athleteMessage:
        "Your OpenRouter account doesn't have enough credits. Add credits on OpenRouter, then send your message again.",
    });
    expect(JSON.stringify(events)).not.toContain("Insufficient credits");
  });

  it("keeps a 402 on a subscription lane on the generic error", async () => {
    const { engine } = engineWithTransport({
      generate: async () => {
        throw paymentRequired();
      },
    });
    const events: TurnEvent[] = [];

    await expect(
      engine.chat({ chatId: "other-402", message: "hello" }, (event) => events.push(event)),
    ).rejects.toBeInstanceOf(APICallError);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      kind: "unknown",
      message: { key: "coach.error.unknown" },
    });
  });

  async function failedTurn(chatProvider: "deepseek" | "anthropic", failure: APICallError) {
    const generate = vi.fn(async (): Promise<GenerateResult> => {
      throw failure;
    });
    const { engine } = engineWithTransport({ generate, chatProvider });
    const events: TurnEvent[] = [];
    await expect(
      engine.chat({ chatId: chatProvider, message: "hello" }, (event) => events.push(event)),
    ).rejects.toBe(failure);
    return {
      attempts: generate.mock.calls.length,
      errors: events.filter((e) => e.type === "error"),
    };
  }

  function providerFailure(
    statusCode: number,
    message: string,
    body: unknown = { error: { message } },
  ): APICallError {
    return new APICallError({
      message,
      url: "https://provider.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseHeaders: { "retry-after-ms": "1" },
      responseBody: JSON.stringify(body),
    });
  }

  it("names a key provider that answers 402 and does not retry", async () => {
    const { attempts, errors } = await failedTurn(
      "deepseek",
      providerFailure(402, "Insufficient Balance"),
    );

    expect(attempts).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "provider-credits",
        message: { key: "coach.error.providerCredits", vars: { provider: "DeepSeek" } },
      }),
    ]);
    expect(JSON.stringify(errors)).not.toContain("Insufficient Balance");
  });

  it("tells the athlete to pick another model when Anthropic does not find it, without retrying", async () => {
    const { attempts, errors } = await failedTurn(
      "anthropic",
      providerFailure(404, "model: claude-retired", {
        type: "error",
        error: { type: "not_found_error", message: "model: claude-retired" },
      }),
    );

    expect(attempts).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "model-unavailable",
        athleteMessage:
          "Anthropic no longer serves this model. Pick another model in Settings, Coach, then send your message again.",
      }),
    ]);
  });

  it("keeps a bare 404, such as a wrong base URL, on the generic error", async () => {
    const { attempts, errors } = await failedTurn("anthropic", providerFailure(404, "Not Found"));

    expect(attempts).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({ kind: "unknown", message: { key: "coach.error.unknown" } }),
    ]);
  });

  it("keeps retrying a DeepSeek 429, which only means requests came too fast", async () => {
    const { attempts, errors } = await failedTurn(
      "deepseek",
      providerFailure(429, "Rate Limit Reached"),
    );

    expect(attempts).toBe(4);
    expect(errors).toEqual([expect.objectContaining({ kind: "rate_limit" })]);
  });

  it("emits ordered text_delta events before final-text", async () => {
    const { dataDir, engine } = engineWithTransport({
      generate: async (request) => {
        request.options.onTextDelta?.("Hello");
        request.options.onStreamActivity?.({ type: "activity" });
        request.options.onTextDelta?.(", ");
        request.options.onTextDelta?.("athlete");
        return result("Hello, athlete");
      },
    });
    const events: TurnEvent[] = [];
    const response = await engine.chat({ chatId: "stream-order", message: "hello" }, (event) =>
      events.push(event),
    );

    expect(response).toEqual({ text: "Hello, athlete" });
    expect(events).toEqual([
      { type: "turn-start", turnId: "turn-stream-1", chatId: "stream-order" },
      { type: "text_delta", turnId: "turn-stream-1", delta: "Hello" },
      { type: "text_delta", turnId: "turn-stream-1", delta: ", " },
      { type: "text_delta", turnId: "turn-stream-1", delta: "athlete" },
      { type: "final-text", turnId: "turn-stream-1", text: "Hello, athlete" },
    ]);
    const session = readFileSync(join(dataDir, "sessions", "stream-order.jsonl"), "utf8");
    expect(session).not.toContain("text_delta");
    expect(session).toContain("Hello, athlete");
  });

  it("keeps consumer failures advisory while observing provider text", async () => {
    const { engine } = engineWithTransport({
      generate: async (request) => {
        request.options.onTextDelta?.("still delivered");
        return result("still delivered");
      },
    });
    await expect(
      engine.chat({ chatId: "advisory", message: "hello" }, () => {
        throw new Error("consumer failed");
      }),
    ).resolves.toEqual({ text: "still delivered" });
  });

  it("streams primary and recovery calls under one turn and records stream usage per model call", async () => {
    const calls: ModelTransportRequest[] = [];
    const usage: UsageLedgerLine[] = [];
    const { engine } = engineWithTransport({
      usage,
      generate: async (request) => {
        calls.push(request);
        if (calls.length === 1) return result("", "tool-calls");
        request.options.onTextDelta?.("recovered reply");
        return result("recovered reply");
      },
    });
    const events: TurnEvent[] = [];
    await expect(
      engine.chat({ chatId: "recovery", message: "hello" }, (event) => events.push(event)),
    ).resolves.toEqual({ text: "recovered reply" });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.options.caller === "chat")).toBe(true);
    expect(events).toEqual([
      { type: "turn-start", turnId: "turn-stream-1", chatId: "recovery" },
      { type: "text_delta", turnId: "turn-stream-1", delta: "recovered reply" },
      { type: "final-text", turnId: "turn-stream-1", text: "recovered reply" },
    ]);
    expect(usage.filter((line) => line.kind === "generate")).toHaveLength(2);
    expect(usage.filter((line) => line.kind === "turn")).toHaveLength(1);
  });

  describe("applies the complete partial-stream retry table", () => {
    it.each([
      "overflow",
      "timeout",
      "rate_limit",
      "server_error",
      "network",
      "auth",
      "reauth",
      "invalid_request",
      "unknown",
    ] as const)("does not retry %s after provider text", async (failure) => {
      const providerError = new Error(failure);
      const generate = vi.fn(async (request: ModelTransportRequest) => {
        request.options.onTextDelta?.("partial");
        throw providerError;
      });
      const { engine } = engineWithTransport({
        generate,
        classifyFailure: () => failure,
      });
      const events: TurnEvent[] = [];

      await expect(
        engine.chat({ chatId: `partial-${failure}`, message: "hello" }, (event) =>
          events.push(event),
        ),
      ).rejects.toBe(providerError);
      expect(generate).toHaveBeenCalledOnce();
      expect(events[0]).toEqual({
        type: "turn-start",
        turnId: "turn-stream-1",
        chatId: `partial-${failure}`,
      });
      expect(events[1]).toEqual({
        type: "text_delta",
        turnId: "turn-stream-1",
        delta: "partial",
      });
      expect(events.at(-1)?.type).toBe("error");
      expect(events.some((event) => event.type === "final-text")).toBe(false);
    });
  });
});
