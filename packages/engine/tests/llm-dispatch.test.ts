import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CODEX_AGENT_DISABLED_MESSAGE } from "@enduragent/coach-contract";

import type { EngineConfig } from "../src/host-ports.js";
import type { ClaudeWorkingAreaPort } from "../src/agent/claude-cli/working-area.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import { createFakeCodex } from "./codex-agent/helpers/fake-codex.js";

const MINIMAL_RESULT = {
  text: "ok",
  toolCalls: [],
  finishReason: "stop",
  usage: {},
  totalUsage: {},
  steps: [],
};

function codexConfig(): EngineConfig {
  return {
    dataSource: "platform",
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 272_000,
    compactContextWindowTokens: 272_000,
  };
}

function anthropicConfig(): EngineConfig {
  return {
    dataSource: "platform",
    llm: { provider: "anthropic", model: "claude-test", apiKey: "test-key" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 272_000,
    compactContextWindowTokens: 272_000,
  };
}

function claudeCliConfig(enabled = true): EngineConfig {
  return {
    dataSource: "platform",
    llm: {
      provider: "claude-cli",
      model: "sonnet",
      apiKey: "",
      claudeCli: {
        enabled,
        binaryPath: "/configured/claude",
        configDir: "/claude-config",
        billing: "subscription",
        cursorStorePath: "/data/claude-cli-sessions.json",
      },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 200_000,
    compactContextWindowTokens: 200_000,
  };
}

async function loadClaudeCliLlm(readinessError?: Error) {
  const ensureClaudeCliReady = vi.fn(async () => {
    if (readinessError !== undefined) throw readinessError;
    return {
      binaryPath: "/checked/claude",
      version: "2.1.80",
      identityLine: "Claude subscription",
      accountClass: "subscription" as const,
    };
  });
  const claudeCliGenerateText = vi.fn(
    async (_opts: unknown, _ports: { runtime: { binaryPath?: string } }) => MINIMAL_RESULT,
  );
  vi.doMock("../src/agent/claude-cli/probe.js", () => ({ ensureClaudeCliReady }));
  vi.doMock("../src/agent/claude-cli/bridge.js", () => ({ claudeCliGenerateText }));
  const workingArea: ClaudeWorkingAreaPort = {
    cacheKey: "/cache/claude",
    prepareForLaunch: vi.fn(async () => ({
      cwd: "/cache/claude",
      assertCurrent: () => undefined,
    })),
  };
  const { LLM } = await import("../src/llm.js");
  return {
    LLM,
    workingArea,
    ensureClaudeCliReady,
    claudeCliGenerateText,
  };
}

type Captured = {
  stepLimit: number | undefined;
  cacheKey: string | undefined;
  signal: AbortSignal | undefined;
  called: number;
};

async function runCodex(
  opts: Parameters<import("../src/llm.js").LLM["generate"]>[0],
): Promise<Captured> {
  const captured: Captured = {
    stepLimit: undefined,
    cacheKey: undefined,
    signal: undefined,
    called: 0,
  };
  vi.doMock("../src/agent/codex-bridge.js", () => ({
    codexGenerateText: vi.fn(
      async (o: { stepLimit?: number; cacheKey?: string; signal?: AbortSignal }) => {
        captured.stepLimit = o.stepLimit;
        captured.cacheKey = o.cacheKey;
        captured.signal = o.signal;
        captured.called++;
        return MINIMAL_RESULT;
      },
    ),
  }));
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(codexConfig(), llmTestPorts());
  await llm.generate(opts);
  return captured;
}

type AiSdkCaptured = {
  abortSignal: AbortSignal | undefined;
  maxRetries: number | undefined;
  prompt: string | undefined;
  messages: unknown;
  experimentalContext: unknown;
  called: number;
};

async function runAiSdk(
  opts: Parameters<import("../src/llm.js").LLM["generate"]>[0],
): Promise<AiSdkCaptured> {
  const captured: AiSdkCaptured = {
    abortSignal: undefined,
    maxRetries: undefined,
    prompt: undefined,
    messages: undefined,
    experimentalContext: undefined,
    called: 0,
  };
  vi.doMock("ai", () => ({
    generateText: vi.fn(
      async (o: {
        abortSignal?: AbortSignal;
        maxRetries?: number;
        prompt?: string;
        messages?: unknown;
        experimental_context?: unknown;
      }) => {
        captured.abortSignal = o.abortSignal;
        captured.maxRetries = o.maxRetries;
        captured.prompt = o.prompt;
        captured.messages = o.messages;
        captured.experimentalContext = o.experimental_context;
        captured.called++;
        return MINIMAL_RESULT;
      },
    ),
    streamText: vi.fn(
      (o: {
        abortSignal?: AbortSignal;
        maxRetries?: number;
        prompt?: string;
        messages?: unknown;
        experimental_context?: unknown;
      }) => {
        captured.abortSignal = o.abortSignal;
        captured.maxRetries = o.maxRetries;
        captured.prompt = o.prompt;
        captured.messages = o.messages;
        captured.experimentalContext = o.experimental_context;
        captured.called++;
        return streamedResult(
          [
            { type: "text-delta", id: "text-1", text: "ok" },
            { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
          ],
          { text: "ok", steps: [] },
        );
      },
    ),
    stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
  }));
  vi.doMock("@ai-sdk/anthropic", () => ({
    createAnthropic: () => () => ({ provider: "anthropic-stub" }),
  }));
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(anthropicConfig(), llmTestPorts());
  await llm.generate(opts);
  return captured;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("LLM dispatch — codex path forwards maxSteps to bridge", () => {
  it("forwards opts.maxSteps to the bridge as stepLimit", async () => {
    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      maxSteps: 5,
    });
    expect(captured.called).toBe(1);
    expect(captured.stepLimit).toBe(5);
  });

  it("forwards undefined when maxSteps is not provided (bridge applies its own default)", async () => {
    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }] });
    expect(captured.stepLimit).toBeUndefined();
  });

  it("forwards opts.cacheKey to the bridge", async () => {
    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      cacheKey: "deadbeefdeadbeef",
    });
    expect(captured.cacheKey).toBe("deadbeefdeadbeef");
  });

  it("streams chat text through the bridge without re-emitting the assembled reply", async () => {
    const codexGenerateText = vi.fn(
      async (o: { onTextDelta?: (delta: string) => void }) => {
        o.onTextDelta?.("o");
        o.onTextDelta?.("k");
        return MINIMAL_RESULT;
      },
    );
    vi.doMock("../src/agent/codex-bridge.js", () => ({ codexGenerateText }));
    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(codexConfig(), llmTestPorts());

    const chatDeltas: string[] = [];
    const result = await llm.generate({
      messages: [{ role: "user", content: "hi" }],
      caller: "chat",
      onTextDelta: (delta) => chatDeltas.push(delta),
    });
    expect(chatDeltas).toEqual(["o", "k"]);
    expect(result.text).toBe("ok");

    const onTextDelta = vi.fn();
    await llm.generate({ prompt: "background", caller: "flush", onTextDelta });
    expect(codexGenerateText.mock.calls[1][0].onTextDelta).toBeUndefined();
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("creates the default deadline signal and forwards it to the bridge", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }] });
    const { LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_CALL_DEADLINE_MS);
    expect(captured.signal).toBe(timeoutController.signal);
  });

  it("uses the longer chat deadline for chat calls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      caller: "chat",
    });
    const { CHAT_LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(CHAT_LLM_CALL_DEADLINE_MS);
    expect(captured.signal).toBe(timeoutController.signal);
  });
});

describe("LLM dispatch — claude-cli readiness gate", () => {
  it("checks the enabled guard before readiness or generation", async () => {
    const harness = await loadClaudeCliLlm();
    const llm = new harness.LLM(claudeCliConfig(false), {
      ...llmTestPorts(),
      claudeWorkingArea: harness.workingArea,
    });

    await expect(
      llm.generate({ messages: [{ role: "user", content: "hi" }], caller: "chat" }),
    ).rejects.toMatchObject({ name: "ClaudeCliDisabledError" });
    expect(harness.ensureClaudeCliReady).not.toHaveBeenCalled();
    expect(harness.claudeCliGenerateText).not.toHaveBeenCalled();
  });

  it("checks the kill switch before readiness or generation", async () => {
    vi.stubEnv("ENDURAGENT_CLAUDE_CLI_DISABLED", "true");
    const harness = await loadClaudeCliLlm();
    const llm = new harness.LLM(claudeCliConfig(), {
      ...llmTestPorts(),
      claudeWorkingArea: harness.workingArea,
    });

    await expect(
      llm.generate({ messages: [{ role: "user", content: "hi" }], caller: "chat" }),
    ).rejects.toMatchObject({ name: "ClaudeCliDisabledError" });
    expect(harness.ensureClaudeCliReady).not.toHaveBeenCalled();
    expect(harness.claudeCliGenerateText).not.toHaveBeenCalled();
  });

  it("does not generate when readiness refuses the account", async () => {
    const refusal = new Error("account refused");
    const harness = await loadClaudeCliLlm(refusal);
    const llm = new harness.LLM(claudeCliConfig(), {
      ...llmTestPorts(),
      claudeWorkingArea: harness.workingArea,
    });

    await expect(
      llm.generate({ messages: [{ role: "user", content: "hi" }], caller: "chat" }),
    ).rejects.toBe(refusal);
    expect(harness.ensureClaudeCliReady).toHaveBeenCalledOnce();
    expect(harness.claudeCliGenerateText).not.toHaveBeenCalled();
  });

  it.each(["chat", "flush", "compact"] as const)(
    "checks readiness for the %s caller and launches the checked binary",
    async (caller) => {
      const harness = await loadClaudeCliLlm();
      const llm = new harness.LLM(claudeCliConfig(), {
        ...llmTestPorts(),
        claudeWorkingArea: harness.workingArea,
      });

      await llm.generate({ messages: [{ role: "user", content: "hi" }], caller });

      expect(harness.ensureClaudeCliReady).toHaveBeenCalledWith({
        workingArea: harness.workingArea,
        binaryPath: "/configured/claude",
        configDir: "/claude-config",
        billing: "subscription",
        model: "sonnet",
      });
      expect(harness.claudeCliGenerateText).toHaveBeenCalledOnce();
      expect(harness.claudeCliGenerateText.mock.calls[0]?.[1].runtime.binaryPath).toBe(
        "/checked/claude",
      );
    },
  );
});

describe("LLM dispatch — AI SDK path forwards abort signals", () => {
  it("passes a default deadline signal and keeps SDK retries disabled on messages calls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runAiSdk({ messages: [{ role: "user", content: "hi" }] });
    const { LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_CALL_DEADLINE_MS);
    expect(captured.abortSignal).toBe(timeoutController.signal);
    expect(captured.maxRetries).toBe(0);
    expect(captured.messages).toEqual([
      {
        role: "user",
        content: "hi",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("passes the deadline signal on prompt-only calls too", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runAiSdk({ prompt: "summarize this" });

    expect(captured.abortSignal).toBe(timeoutController.signal);
    expect(captured.prompt).toBe("summarize this");
    expect(captured.maxRetries).toBe(0);
  });

  it("forwards opts.context to generateText by identity as the experimental context", async () => {
    const turnContext = { marker: "turn-context" };

    const captured = await runAiSdk({
      messages: [{ role: "user", content: "hi" }],
      context: turnContext,
    });

    expect(captured.experimentalContext).toBe(turnContext);
  });
});

describe("LLM generate — per-call deadline bounded by opts.deadlineMs", () => {
  it("uses the smaller of the caller deadline and opts.deadlineMs", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await runAiSdk({
      messages: [{ role: "user", content: "hi" }],
      caller: "chat",
      deadlineMs: 120_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  });

  it("ignores opts.deadlineMs when it exceeds the caller deadline", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await runAiSdk({
      messages: [{ role: "user", content: "hi" }],
      caller: "chat",
      deadlineMs: 999_999,
    });
    const { CHAT_LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(CHAT_LLM_CALL_DEADLINE_MS);
  });
});

describe("LLM generate — timeout reclassification gated on our timer + abort shape", () => {
  function abortedTimeoutSignal(): AbortSignal {
    const ac = new AbortController();
    ac.abort(new DOMException("The operation timed out.", "TimeoutError"));
    return ac.signal;
  }

  async function generateThrowing(thrown: unknown): Promise<unknown> {
    vi.doMock("ai", () => ({
      generateText: vi.fn(async () => {
        throw thrown;
      }),
      stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));
    // The per-call timer has already fired by the time dispatch throws.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(abortedTimeoutSignal());

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig(), llmTestPorts());
    let rejected = false;
    let caught: unknown;
    try {
      await llm.generate({ messages: [{ role: "user", content: "hi" }] });
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    return caught;
  }

  it("does NOT relabel a 5xx thrown while the deadline signal is aborted", async () => {
    const serverErr = Object.assign(new Error("upstream 500"), { httpStatus: 500 });
    const caught = await generateThrowing(serverErr);
    expect(caught).toBe(serverErr);
    expect((caught as Error).name).not.toBe("TimeoutError");
    expect((caught as { httpStatus?: number }).httpStatus).toBe(500);
  });

  it("surfaces a genuine per-call abort as a TimeoutError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const caught = await generateThrowing(abortErr);
    expect((caught as Error).name).toBe("TimeoutError");
  });

  // Sibling of generateThrowing: our timer never fires (AbortSignal.timeout
  // returns a non-aborted signal), and opts.signal is threaded through so an
  // OUTER caller cancellation can be exercised.
  async function generateThrowingWithSignal(
    thrown: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    vi.doMock("ai", () => ({
      generateText: vi.fn(async () => {
        throw thrown;
      }),
      stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));
    // Our per-call timer never fires: deadline.aborted stays false.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig(), llmTestPorts());
    let rejected = false;
    let caught: unknown;
    try {
      await llm.generate({ messages: [{ role: "user", content: "hi" }], signal });
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    return caught;
  }

  it("does NOT relabel an outer-signal abort when our timer never fired", async () => {
    const outer = new AbortController();
    outer.abort(new DOMException("The operation was aborted.", "AbortError"));
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const caught = await generateThrowingWithSignal(abortErr, outer.signal);
    expect((caught as Error).name).toBe("AbortError");
    expect((caught as Error).name).not.toBe("TimeoutError");
  });

  it("relabels a genuine deadline abort wrapped under a non-standard name", async () => {
    const wrapped = Object.assign(new Error("api call failed"), {
      name: "AI_APICallError",
      cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
    });
    const caught = await generateThrowing(wrapped);
    expect((caught as Error).name).toBe("TimeoutError");
  });
});

function streamedResult(
  parts: unknown[],
  overrides: Partial<{
    text: string;
    toolCalls: unknown[];
    finishReason: "stop";
    usage: Record<string, number>;
    totalUsage: Record<string, number>;
    steps: unknown[];
  }> = {},
) {
  const usage = overrides.usage ?? { inputTokens: 2, outputTokens: 1, totalTokens: 3 };
  const totalUsage = overrides.totalUsage ?? {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
  };
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    text: Promise.resolve(overrides.text ?? "complete"),
    toolCalls: Promise.resolve(overrides.toolCalls ?? []),
    finishReason: Promise.resolve(overrides.finishReason ?? "stop"),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(totalUsage),
    steps: Promise.resolve(overrides.steps ?? [{}, {}]),
  };
}

async function loadStreamingLlm(parts: unknown[]) {
  const generateText = vi.fn(async (_request: { maxRetries?: number }) => MINIMAL_RESULT);
  const streamText = vi.fn((_request: { maxRetries?: number }) => streamedResult(parts));
  vi.doMock("ai", () => ({
    generateText,
    streamText,
    stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
  }));
  vi.doMock("@ai-sdk/anthropic", () => ({
    createAnthropic: () => () => ({ provider: "anthropic-stub" }),
  }));
  const { LLM } = await import("../src/llm.js");
  return { llm: new LLM(anthropicConfig(), llmTestPorts()), generateText, streamText };
}

describe("LLM dispatch — streaming roles and part mapping", () => {
  it("routes chat to streamText and background roles to generateText", async () => {
    const { llm, generateText, streamText } = await loadStreamingLlm([
      { type: "text-delta", id: "text-1", text: "complete" },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
    ]);
    const chatDeltas: string[] = [];
    await llm.generate({
      messages: [{ role: "user", content: "chat" }],
      caller: "chat",
      onTextDelta: (delta) => chatDeltas.push(delta),
    });
    expect(chatDeltas).toEqual(["complete"]);
    expect(streamText).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText.mock.calls[0][0].maxRetries).toBe(0);

    for (const caller of ["flush", "compact", "sync-triage", "dream"] as const) {
      const onTextDelta = vi.fn();
      const onStreamActivity = vi.fn();
      await llm.generate({
        prompt: "background",
        caller,
        onTextDelta,
        onStreamActivity,
      });
      expect(onTextDelta).not.toHaveBeenCalled();
      expect(onStreamActivity).not.toHaveBeenCalled();
    }
    expect(generateText).toHaveBeenCalledTimes(4);
    expect(streamText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls.every(([request]) => request.maxRetries === 0)).toBe(true);
  });

  it("maps every AI SDK stream part", async () => {
    const providerError = new Error("provider stream error");
    const activities: unknown[] = [];
    const deltas: string[] = [];
    const { llm } = await loadStreamingLlm([
      { type: "start" },
      { type: "text-delta", id: "text-1", text: "one" },
      { type: "text-delta", id: "text-1", text: "" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "probe", input: {} },
      { type: "tool-call", toolCallId: "tool-1", toolName: "probe", input: {} },
      { type: "tool-result", toolCallId: "tool-1", toolName: "probe", input: {}, output: {} },
      {
        type: "tool-error",
        toolCallId: "tool-2",
        toolName: "probe",
        input: {},
        error: providerError,
      },
      { type: "tool-output-denied", toolCallId: "tool-3", toolName: "probe" },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
    ]);
    const result = await llm.generate({
      messages: [{ role: "user", content: "chat" }],
      caller: "chat",
      onTextDelta: (delta) => deltas.push(delta),
      onStreamActivity: (activity) => activities.push(activity),
    });
    expect(deltas).toEqual(["one"]);
    expect(activities).toEqual([
      { type: "activity" },
      { type: "activity" },
      { type: "tool_start", toolCallId: "tool-1" },
      { type: "tool_start", toolCallId: "tool-1" },
      { type: "tool_end", toolCallId: "tool-1" },
      { type: "tool_end", toolCallId: "tool-2" },
      { type: "tool_end", toolCallId: "tool-3" },
    ]);
    expect(result).toMatchObject({ text: "complete", steps: 2, totalUsage: { totalTokens: 30 } });
  });

  it("normalizes yielded aborts and preserves yielded provider errors", async () => {
    const providerError = new Error("provider stream error");
    const first = await loadStreamingLlm([{ type: "error", error: providerError }]);
    await expect(first.llm.generate({ messages: [], caller: "chat" })).rejects.toBe(providerError);

    vi.resetModules();
    const second = await loadStreamingLlm([{ type: "abort", reason: "provider stopped" }]);
    await expect(second.llm.generate({ messages: [], caller: "chat" })).rejects.toMatchObject({
      name: "AbortError",
      message: "provider stopped",
    });
  });
});

describe("LLM dispatch — chat stream watchdog", () => {
  it.each(["ttftMs", "interChunkMs"] as const)(
    "validates chatStreamTimeouts.%s synchronously",
    async (field) => {
      const { LLM } = await import("../src/llm.js");
      for (const invalid of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        expect(
          () =>
            new LLM(anthropicConfig(), {
              ...llmTestPorts(),
              chatStreamTimeouts: { ttftMs: 1, interChunkMs: 1, [field]: invalid },
            }),
        ).toThrow(`chatStreamTimeouts.${field}`);
      }
      expect(
        () =>
          new LLM(anthropicConfig(), {
            ...llmTestPorts(),
            chatStreamTimeouts: { ttftMs: 1, interChunkMs: 1 },
          }),
      ).not.toThrow();
    },
  );

  it.each([
    { expectedCode: "CHAT_TTFT_TIMEOUT", emitText: false },
    { expectedCode: "CHAT_INTER_CHUNK_TIMEOUT", emitText: true },
  ] as const)("surfaces $expectedCode", async ({ expectedCode, emitText }) => {
    vi.useFakeTimers();
    const streamText = vi.fn((request: { abortSignal?: AbortSignal }) => ({
      ...streamedResult([]),
      fullStream: (async function* () {
        if (emitText) yield { type: "text-delta", id: "text-1", text: "partial" };
        await new Promise<void>((_resolve, reject) => {
          request.abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      })(),
    }));
    vi.doMock("ai", () => ({
      generateText: vi.fn(),
      streamText,
      stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));
    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig(), {
      ...llmTestPorts(),
      chatStreamTimeouts: { ttftMs: 10, interChunkMs: 20 },
    });
    const pending = llm.generate({ messages: [], caller: "chat" });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      code: expectedCode,
    });
    await vi.advanceTimersByTimeAsync(emitText ? 20 : 10);
    await rejection;
    vi.useRealTimers();
  });
});

function codexAgentConfig(): EngineConfig {
  return {
    dataSource: "platform",
    llm: {
      provider: "codex-agent",
      model: "gpt-5.6-sol",
      apiKey: "",
      codexAgent: { enabled: true, binaryPath: "/never/spawned/codex", reasoningEffort: "medium" },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 1_050_000,
    compactContextWindowTokens: 1_050_000,
  };
}

describe("LLM dispatch — codex-agent provider gating (AC-3)", () => {
  it("builds no AI SDK model and dispatches to the codex-agent bridge", async () => {
    const captured: { modelId?: string; runtime?: unknown; called: number } = { called: 0 };
    vi.doMock("../src/agent/codex-agent/bridge.js", () => ({
      codexAgentGenerateText: vi.fn(async (o: { modelId: string }, p: { runtime: unknown }) => {
        captured.modelId = o.modelId;
        captured.runtime = p.runtime;
        captured.called++;
        return MINIMAL_RESULT;
      }),
    }));

    const { LLM, usesKeylessTransport } = await import("../src/llm.js");
    expect(usesKeylessTransport("codex-agent")).toBe(true);

    const llm = new LLM(codexAgentConfig(), llmTestPorts());
    await llm.generate({ messages: [{ role: "user", content: "hi" }], caller: "chat" });

    expect(captured.called).toBe(1);
    expect(captured.modelId).toBe("gpt-5.6-sol");
    expect(captured.runtime).toEqual({
      enabled: true,
      binaryPath: "/never/spawned/codex",
      reasoningEffort: "medium",
    });
  });

  it("refuses the turn and spawns no child when the lane is not enabled", async () => {
    vi.doUnmock("../src/agent/codex-agent/bridge.js");
    vi.resetModules();
    const staged = await createFakeCodex({ script: "turn-happy" });
    try {
      const base = codexAgentConfig();
      const disabled: EngineConfig = {
        ...base,
        llm: {
          ...base.llm,
          codexAgent: { enabled: false, binaryPath: staged.binaryPath },
        },
      };

      const { LLM } = await import("../src/llm.js");
      const llm = new LLM(disabled, llmTestPorts());

      await expect(
        llm.generate({ messages: [{ role: "user", content: "hi" }], caller: "chat" }),
      ).rejects.toMatchObject({
        name: "CodexAgentConfigError",
        kind: "disabled",
        message: CODEX_AGENT_DISABLED_MESSAGE,
      });
      expect(await staged.spawnCount()).toBe(0);
    } finally {
      await staged.cleanup();
    }
  });

  it("is excluded from the chat-stream watchdog so a silent thinking turn survives", async () => {
    vi.useFakeTimers();
    vi.doMock("../src/agent/codex-agent/bridge.js", () => ({
      codexAgentGenerateText: vi.fn(
        (o: { signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            o.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            setTimeout(() => resolve(MINIMAL_RESULT), 60_000);
          }),
      ),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(codexAgentConfig(), {
      ...llmTestPorts(),
      chatStreamTimeouts: { ttftMs: 10, interChunkMs: 20 },
    });
    const pending = llm.generate({ messages: [], caller: "chat" });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({ text: "ok" });
    vi.useRealTimers();
  });
});
