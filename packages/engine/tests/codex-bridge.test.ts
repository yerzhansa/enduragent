import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodSchema } from "ai";
import { z } from "zod";
import type { EngineHostPorts } from "../src/host-ports.js";
import { normalizeError } from "../src/agent/codex-bridge.js";
import { usageFieldsFromResult } from "../src/llm-types.js";
import { isProviderAuthFailure } from "../src/provider-auth-failure.js";
import {
  classifyFailure,
  isContextOverflowError,
  isNetworkError,
  isRateLimitError,
  isServerError,
  isTimeoutError,
} from "../../core/src/agent/token-utils.js";

// Test the bridge's error normalization, result mapping, and tool loop. Mocks the
// in-house codex round-trip (codexResponses) and auth profile access.

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-bridge-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function loadBridgeWithMocks(opts: {
  complete: ReturnType<typeof vi.fn>;
  freshToken?: EngineHostPorts["getAccessToken"];
}) {
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: opts.complete,
  }));

  const { codexGenerateText } = await import("../src/agent/codex-bridge.js");
  const freshToken: EngineHostPorts["getAccessToken"] =
    opts.freshToken ?? (async () => "test-access-token");
  return {
    codexGenerateText: (input: Parameters<typeof codexGenerateText>[0]) =>
      codexGenerateText(input, { getAccessToken: freshToken, classifyFailure }),
  };
}

function asstMsg(
  overrides: {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
    stopReason?: "stop" | "length" | "toolUse" | "error";
  } = {},
) {
  return {
    text: overrides.text ?? "hello",
    toolCalls: overrides.toolCalls ?? [],
    usage: overrides.usage ?? {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
    stopReason: overrides.stopReason ?? "stop",
  };
}

describe("codex-bridge", () => {
  it("returns {text, finishReason, usage} for a simple completion", async () => {
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.usage.inputTokenDetails).toEqual({
      noCacheTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("maps cached input inclusively while preserving uncached input, cache details, totals, and cost", async () => {
    const complete = vi.fn(async () =>
      asstMsg({
        usage: {
          input: 2_000,
          output: 0,
          cacheRead: 28_000,
          cacheWrite: 0,
          totalTokens: 30_000,
        },
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.usage).toMatchObject({
      inputTokens: 30_000,
      outputTokens: 0,
      totalTokens: 30_000,
      cachedInputTokens: 28_000,
      inputTokenDetails: {
        noCacheTokens: 2_000,
        cacheReadTokens: 28_000,
        cacheWriteTokens: 0,
      },
    });
    expect(result.totalUsage).toEqual(result.usage);
    expect(result.cost?.total).toBe(0.0084);
  });

  it("keeps an inclusive input sum exactly at Number.MAX_SAFE_INTEGER", async () => {
    const complete = vi.fn(async () =>
      asstMsg({
        usage: {
          input: Number.MAX_SAFE_INTEGER - 2,
          output: 0,
          cacheRead: 1,
          cacheWrite: 1,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.usage.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.usage.inputTokenDetails).toEqual({
      noCacheTokens: Number.MAX_SAFE_INTEGER - 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    });
    expect(result.totalUsage?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.cost).toBeDefined();
  });

  it("omits an inclusive input sum that exceeds Number.MAX_SAFE_INTEGER", async () => {
    const complete = vi.fn(async () =>
      asstMsg({
        usage: {
          input: Number.MAX_SAFE_INTEGER - 1,
          output: 0,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.inputTokenDetails).toEqual({
      noCacheTokens: Number.MAX_SAFE_INTEGER - 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
    expect(result.totalUsage).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });

  it("does not expose or persist negative uncached input when cached input exceeds provider input", async () => {
    const complete = vi.fn(async () =>
      asstMsg({
        usage: {
          input: -1,
          output: 0,
          cacheRead: 11,
          cacheWrite: 0,
          totalTokens: 10,
        },
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.text).toBe("hello");
    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.inputTokenDetails).toEqual({
      noCacheTokens: undefined,
      cacheReadTokens: 11,
      cacheWriteTokens: 0,
    });
    expect(result.totalUsage).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(usageFieldsFromResult(result)).toMatchObject({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      cost: undefined,
    });
  });

  it("maps cached input for the final step and accumulated multi-step usage", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 50,
            cacheWrite: 10,
            totalTokens: 180,
          },
        }),
      )
      .mockResolvedValueOnce(
        asstMsg({
          usage: {
            input: 200,
            output: 30,
            cacheRead: 100,
            cacheWrite: 20,
            totalTokens: 350,
          },
        }),
      );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: {} as never,
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.steps).toBe(2);
    expect(result.usage).toMatchObject({
      inputTokens: 320,
      outputTokens: 30,
      totalTokens: 350,
      cachedInputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      },
    });
    expect(result.totalUsage).toMatchObject({
      inputTokens: 480,
      outputTokens: 50,
      totalTokens: 530,
      cachedInputTokens: 150,
      inputTokenDetails: {
        noCacheTokens: 300,
        cacheReadTokens: 150,
        cacheWriteTokens: 30,
      },
    });
  });

  it("keeps the successful final step when whole-turn accumulation overflows", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        asstMsg({
          text: "working",
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
          usage: {
            input: Number.MAX_SAFE_INTEGER - 10,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: Number.MAX_SAFE_INTEGER - 10,
          },
        }),
      )
      .mockResolvedValueOnce(
        asstMsg({
          text: "done",
          usage: {
            input: 11,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
          },
        }),
      );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: {} as never,
      modelId: "gpt-5.2",
      profileName: "openai-codex",
    });

    expect(result.text).toBe("done");
    expect(result.steps).toBe(2);
    expect(result.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 0,
      totalTokens: 11,
      inputTokenDetails: {
        noCacheTokens: 11,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    expect(result.totalUsage).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });

  it("maps codex rate-limit errors so isRateLimitError() recognizes them", async () => {
    const complete = vi.fn(async () => {
      throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isRateLimitError(err)).toBe(true);
    }
  });

  it("maps 'Request was aborted' to a timeout-shaped error", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Request was aborted");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isTimeoutError(err)).toBe(true);
    }
  });

  it("maps context-length errors so isContextOverflowError() recognizes them", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Request exceeds the maximum context length of 272000 tokens");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isContextOverflowError(err)).toBe(true);
    }
  });

  it("calls getFreshToken before each request and forwards the token as accessToken", async () => {
    const complete = vi.fn(async () => asstMsg());
    const freshToken = vi.fn(async () => "fresh-token-abc");
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(freshToken).toHaveBeenCalledWith("openai-codex", undefined);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fresh-token-abc", modelId: "gpt-5.4" }),
    );
  });

  it("threads the per-call abort signal into getFreshToken so the token refresh shares the deadline", async () => {
    const complete = vi.fn(async () => asstMsg());
    const freshToken = vi.fn(async () => "fresh-token-abc");
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });
    const controller = new AbortController();

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal: controller.signal,
    });

    expect(freshToken).toHaveBeenCalledWith("openai-codex", controller.signal);
  });

  it("forwards opts.cacheKey as the request sessionId; omits it when absent", async () => {
    const completeWithKey = vi.fn(async () => asstMsg());
    const { codexGenerateText: genWithKey } = await loadBridgeWithMocks({
      complete: completeWithKey,
    });

    await genWithKey({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      cacheKey: "abc123def456",
    });

    expect(completeWithKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "abc123def456" }),
    );

    vi.resetModules();
    const completeNoKey = vi.fn(async () => asstMsg());
    const { codexGenerateText: genNoKey } = await loadBridgeWithMocks({ complete: completeNoKey });

    await genNoKey({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(completeNoKey).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
  });

  it("forwards opts.signal to the codex response request", async () => {
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const signal = new AbortController().signal;

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal,
    });

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it("refreshes a server-rejected token once without poisoning the next turn", async () => {
    let storedAccess = "stale-access";
    const complete = vi.fn(async ({ accessToken }: { accessToken: string }) => {
      if (accessToken === "stale-access") {
        throw Object.assign(new Error("unauthorized"), { httpStatus: 401 });
      }
      return asstMsg({ text: "accepted" });
    });
    const readStoredValue = vi.fn(
      async (_profileName: string, _signal?: AbortSignal, rejectedAccessToken?: string) => {
        if (rejectedAccessToken === "stale-access") storedAccess = "fresh-access";
        return storedAccess;
      },
    );
    const freshToken = readStoredValue;
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });
    const input = {
      messages: [{ role: "user" as const, content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    };

    await expect(codexGenerateText(input)).resolves.toMatchObject({ text: "accepted" });
    await expect(codexGenerateText(input)).resolves.toMatchObject({ text: "accepted" });

    expect(readStoredValue.mock.calls).toEqual([
      ["openai-codex", undefined],
      ["openai-codex", undefined, "stale-access"],
      ["openai-codex", undefined],
    ]);
    expect(complete.mock.calls.map(([call]) => call.accessToken)).toEqual([
      "stale-access",
      "fresh-access",
      "fresh-access",
    ]);
  });

  it("surfaces finishReason=length so isContextOverflowError can catch it upstream via retry", async () => {
    const complete = vi.fn(async () => asstMsg({ stopReason: "length", text: "truncated" }));
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const res = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });
    expect(res.finishReason).toBe("length");
  });

  it("stops the tool-calling loop at stepLimit", async () => {
    // Always return a toolCall — the bridge would loop forever if stepLimit
    // weren't honored. Empty tools set → executeToolCall returns an error result
    // but the loop still cycles until stepLimit.
    const complete = vi.fn(async () =>
      asstMsg({
        stopReason: "toolUse",
        toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: {} as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      stepLimit: 3,
    });

    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("rejects schema-violating tool arguments without executing the tool", async () => {
    const execute = vi.fn(async () => "should not run");
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };

    const conversations: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      conversations.push({ messages: [...params.messages] });
      if (conversations.length === 1) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: "sixty" } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const toolMsg = conversations[1].messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toContain("error-text");
    expect(JSON.stringify(toolMsg!.content)).toContain("Invalid arguments");
  });

  it("executes the tool with validated arguments when the schema matches", async () => {
    const execute = vi.fn(async (input: { minutes: number }) => `logged ${input.minutes}`);
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };

    const conversations: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      conversations.push({ messages: [...params.messages] });
      if (conversations.length === 1) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: 60 } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ minutes: 60 });
    const toolMsg = conversations[1].messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toContain("logged 60");
  });

  it("forwards opts.onTextDelta to every step's request", async () => {
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute: vi.fn(async () => "logged"),
      },
    };
    let step = 0;
    const complete = vi.fn(async (params: { onTextDelta?: (delta: string) => void }) => {
      step++;
      if (step === 1) {
        params.onTextDelta?.("Checking");
        return asstMsg({
          text: "Checking",
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: 60 } }],
        });
      }
      params.onTextDelta?.("Logged ");
      params.onTextDelta?.("60 min.");
      return asstMsg({ text: "Logged 60 min." });
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const deltas: string[] = [];

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Checking", "Logged ", "60 min."]);
    expect(result.text).toBe("Logged 60 min.");
  });

  it("executes zero tools when a decision call has a sibling", async () => {
    const decide = vi.fn(async () => ({ status: "presented", decisionId: "d1" }));
    const mutate = vi.fn(async () => ({ saved: true }));
    const tools = {
      request_user_decision: {
        description: "decide",
        inputSchema: zodSchema(z.object({ question: z.string() })),
        execute: decide,
      },
      plan_save: {
        description: "save",
        inputSchema: zodSchema(z.object({ name: z.string() })),
        execute: mutate,
      },
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        asstMsg({
          stopReason: "toolUse",
          toolCalls: [
            { id: "d1", name: "request_user_decision", arguments: { question: "Choose" } },
            { id: "w1", name: "plan_save", arguments: { name: "Changed" } },
          ],
        }),
      )
      .mockResolvedValueOnce(asstMsg({ text: "Choose 1 or 2." }));
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(decide).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("stops after executing a decision-only batch", async () => {
    const decide = vi.fn(async () => ({ status: "presented", decisionId: "d1" }));
    const complete = vi.fn(async () =>
      asstMsg({
        text: "",
        stopReason: "toolUse",
        toolCalls: [{ id: "d1", name: "request_user_decision", arguments: { question: "Choose" } }],
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: {
        request_user_decision: {
          description: "decide",
          inputSchema: zodSchema(z.object({ question: z.string() })),
          execute: decide,
        },
      } as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("forwards opts.signal to codex tool execution", async () => {
    let toolOptions: { abortSignal?: AbortSignal } | undefined;
    const execute = vi.fn(
      async (_input: { minutes: number }, options: { abortSignal?: AbortSignal }) => {
        toolOptions = options;
        return "logged";
      },
    );
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: 60 } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const signal = new AbortController().signal;

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolOptions?.abortSignal).toBe(signal);
  });

  it("does not leak fake tokens via console.warn/error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const secretToken = "fresh-token-abc-secret";
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({
      complete,
      freshToken: vi.fn(async () => secretToken),
    });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    const allLogs = [...warnSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    expect(allLogs).not.toContain(secretToken);
    expect(allLogs).not.toContain("test-access-token");
  });
});

// normalizeError is the single classifier-feeding entry point. The codex
// round-trip throws structured errors (httpStatus / retryAfterMs carrier, or a
// raw fetch throw with an errno cause); these assert each maps to the class the
// outer retry loop expects, independent of transport.
describe("codex-bridge normalizeError", () => {
  function httpError(status: number, message = "boom", retryAfterMs?: number): Error {
    const e = new Error(message) as Error & { httpStatus?: number; retryAfterMs?: number };
    e.httpStatus = status;
    if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
    return e;
  }

  it("classifies a 5xx as server error, not rate limit", () => {
    for (const status of [500, 502, 503, 504]) {
      const normalized = normalizeError(httpError(status), classifyFailure);
      expect(isServerError(normalized)).toBe(true);
      expect(isRateLimitError(normalized)).toBe(false);
    }
  });

  it.each([401, 403])("classifies a %i as provider auth", (status) => {
    const normalized = normalizeError(httpError(status, "unauthorized"), classifyFailure);
    expect(isProviderAuthFailure(normalized)).toBe(true);
    expect(classifyFailure(normalized)).toBe("auth");
  });

  it("keeps a 429 as rate limit, not server error", () => {
    const normalized = normalizeError(
      httpError(429, "quota exhausted (status=429)"),
      classifyFailure,
    );
    expect(isRateLimitError(normalized)).toBe(true);
    expect(isServerError(normalized)).toBe(false);
  });

  it("preserves a carried retryAfterMs on the normalized error", () => {
    const normalized = normalizeError(httpError(503, "boom", 7000), classifyFailure) as Error & {
      retryAfterMs?: number;
    };
    expect(normalized.retryAfterMs).toBe(7000);
  });

  it("classifies a raw thrown fetch (errno cause) as network, not rate limit", () => {
    const original = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const normalized = normalizeError(original, classifyFailure);
    expect(isNetworkError(normalized)).toBe(true);
    expect(isRateLimitError(normalized)).toBe(false);
  });
});
