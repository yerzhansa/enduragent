import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { LLM } from "../src/llm.js";
import type { EngineConfig } from "../src/host-ports.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";
import { codexGenerateText } from "../src/agent/codex-bridge.js";
import { codexAgentGenerateText } from "../src/agent/codex-agent/bridge.js";
import {
  codexAgentCacheReadSavingsUsd,
  priceCodexAgentInclusiveUsage,
} from "../src/agent/codex-agent/cost.js";

const config: EngineConfig = {
  llm: { provider: "openai", model: "gpt-6-astra", apiKey: "fake-key" },
  dataSource: "platform",
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "",
  },
  models: testModelProfiles({ provider: "openai", chat: "gpt-6-astra" }),
  contextWindowTokens: 200_000,
  compactContextWindowTokens: 200_000,
};

function response(
  output: unknown[] = [
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      content: [{ type: "output_text", text: "Ready", annotations: [] }],
    },
  ],
) {
  return {
    id: "resp_test",
    created_at: 0,
    model: "gpt-6-astra",
    status: "completed",
    output,
    usage: {
      input_tokens: 120,
      output_tokens: 8,
      input_tokens_details: { cached_tokens: 40, cache_creation_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  };
}

function jsonResponse(output?: unknown[]) {
  return new Response(JSON.stringify(response(output)), {
    headers: { "content-type": "application/json" },
  });
}

function streamResponse() {
  const events = [
    { type: "response.created", response: response([]) },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_test", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      delta: "Ready",
    },
    { type: "response.output_item.done", output_index: 0, item: response().output[0] },
    { type: "response.completed", response: response() },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Astra public Responses compatibility", () => {
  it("serializes developer instructions, bounds output and keeps unmeasured cache cost unavailable", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    const result = await new LLM(config, llmTestPorts()).generate({
      caller: "compact",
      system: "Preserve goals",
      prompt: "Summarize",
      maxOutputTokens: 200_000,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-6-astra");
    expect(body.input[0].role).toBe("developer");
    expect(body.max_output_tokens).toBe(128_000);
    for (const field of ["temperature", "top_p", "store", "prompt_cache_retention", "reasoning"])
      expect(body).not.toHaveProperty(field);
    expect(result.text).toBe("Ready");
    expect(result.totalUsage?.inputTokenDetails.cacheReadTokens).toBe(40);
    expect(result.totalUsage?.inputTokenDetails.cacheWriteTokens).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(result.providerReportedCostUsd).toBeUndefined();
  });

  it("streams athlete text and measured token usage through LLM", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse());
    const onTextDelta = vi.fn();
    const result = await new LLM(config, llmTestPorts()).generate({
      caller: "chat",
      prompt: "Hi",
      onTextDelta,
    });
    expect(onTextDelta).toHaveBeenCalledWith("Ready");
    expect(result.text).toBe("Ready");
    expect(result.totalUsage?.inputTokens).toBe(120);
    expect(result.cost).toBeUndefined();
  });

  it("surfaces a terminal stream failure without a success result or retry", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "blocked", message: "Stopped for review" } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const append = vi.fn();
    await expect(
      new LLM(config, { ...llmTestPorts(), usage: { append } }).generate({
        caller: "chat",
        prompt: "Hi",
      }),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("correlates a tool result with its original call across real SDK requests", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "read_goal",
            arguments: "{}",
            status: "completed",
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse());
    const execute = vi.fn(async () => "Finish the training plan");
    await new LLM(config, llmTestPorts()).generate({
      caller: "compact",
      prompt: "Recall my goal",
      tools: { read_goal: tool({ inputSchema: z.object({}), execute }) },
      stopWhen: stepCountIs(2),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "item_reference", id: "fc_test" }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_test",
          output: "Finish the training plan",
        }),
      ]),
    );
  });

  it("does not replay a completed tool after a subsequent provider failure", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "save_goal",
            arguments: "{}",
            status: "completed",
          },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Stopped for review", code: "blocked" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
    const execute = vi.fn(async () => "Saved");
    await expect(
      new LLM(config, llmTestPorts()).generate({
        caller: "compact",
        prompt: "Save goal",
        tools: { save_goal: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(2),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["low", "medium", "high", "xhigh", "max"])(
    "installed SDK serializes documented %s effort and structured output",
    async (effort) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse([
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            content: [{ type: "output_text", text: '{"ready":true}', annotations: [] }],
          },
        ]),
      );
      const result = await generateText({
        model: createOpenAI({ apiKey: "fake-key" }).responses("gpt-6-astra"),
        prompt: "Return readiness",
        providerOptions: { openai: { forceReasoning: true, reasoningEffort: effort } },
        output: Output.object({ schema: z.object({ ready: z.boolean() }) }),
        maxRetries: 0,
      });
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body.reasoning).toEqual({ effort });
      expect(body.text.format.type).toBe("json_schema");
      expect(result.output).toEqual({ ready: true });
    },
  );

  it.each([429, 503, 403])(
    "preserves terminal HTTP %s without an internal retry",
    async (status) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Provider refused",
              code: status === 429 ? "slow_down" : "blocked",
            },
          }),
          { status, headers: { "content-type": "application/json", "retry-after": "3" } },
        ),
      );
      await expect(
        new LLM(config, llmTestPorts()).generate({ caller: "compact", prompt: "Hi" }),
      ).rejects.toMatchObject({
        statusCode: status,
        responseHeaders: expect.objectContaining({ "retry-after": "3" }),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels a request without retrying", async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort();
      throw init?.signal?.reason;
    });
    await expect(
      new LLM(config, llmTestPorts()).generate({
        caller: "compact",
        prompt: "Hi",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("unverified Astra subscription transports", () => {
  it("refuses before accessing credentials or starting app-server", async () => {
    const getAccessToken = vi.fn();
    await expect(
      codexGenerateText(
        { caller: "chat", modelId: "gpt-6-astra", profileName: "test", prompt: "Hi" },
        { ...llmTestPorts(), getAccessToken },
      ),
    ).rejects.toThrow("not enabled for this connection");
    expect(getAccessToken).not.toHaveBeenCalled();
    const ensureReady = vi.fn();
    await expect(
      codexAgentGenerateText(
        { caller: "chat", modelId: "gpt-6-astra", prompt: "Hi" },
        { runtime: { enabled: true }, ensureReady },
      ),
    ).rejects.toThrow("not enabled for this connection");
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("does not infer Sol dollars or cache savings for Astra", () => {
    expect(
      priceCodexAgentInclusiveUsage("gpt-6-astra", {
        inputTokens: 120,
        outputTokens: 8,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
      }),
    ).toBeUndefined();
    expect(codexAgentCacheReadSavingsUsd("gpt-6-astra", 40)).toBeNull();
  });
});
