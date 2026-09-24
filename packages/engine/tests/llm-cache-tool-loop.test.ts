import { afterEach, describe, expect, it, vi } from "vitest";
import { stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { LLM } from "../src/llm.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../src/agent/system-prompt.js";
import { withTestModelProfiles } from "./helpers/model-profiles.js";

const blockSchema = z
  .object({
    type: z.string(),
    cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
  })
  .passthrough();
const requestSchema = z.object({
  system: z.array(blockSchema),
  messages: z.array(z.object({ role: z.string(), content: z.array(blockSchema) })),
});

function response(step: number, streaming: boolean): Response {
  const content =
    step < 4
      ? { type: "tool_use", id: `call-${step}`, name: "read_context", input: {} }
      : { type: "text", text: "Ready." };
  const stopReason = step < 4 ? "tool_use" : "end_turn";
  const message = {
    id: `message-${step}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: step < 4 ? [content, { ...content, id: `second-call-${step}` }] : [content],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  if (!streaming) return Response.json(message);
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    ...message.content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("explicit cache breakpoints in real SDK tool loops", () => {
  it.each([
    { caller: "chat", enabled: true },
    { caller: "flush", enabled: true },
    { caller: "chat", enabled: false },
    { caller: "flush", enabled: false },
  ] as const)(
    "uses the requested cache experiment for $caller with enabled=$enabled",
    async ({ caller, enabled }) => {
      const requests: z.infer<typeof requestSchema>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
          requests.push(requestSchema.parse(JSON.parse(init.body)));
          return response(requests.length, caller === "chat");
        }),
      );
      const llm = new LLM(
        withTestModelProfiles({
          dataSource: "platform",
          llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "synthetic-test-key" },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
          },
          contextWindowTokens: 200_000,
          compactContextWindowTokens: 200_000,
        }),
        {
          usage: { append: () => undefined },
          now: () => 0,
          getAccessToken: async () => "synthetic-token",
          classifyFailure: () => "unknown",
        },
      );
      const messages: ModelMessage[] = [{ role: "user", content: "Read the context." }];
      const original = structuredClone(messages);
      const execute = vi.fn(async () => ({ summary: "Synthetic training context." }));
      await llm.generate({
        system: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Changing context`,
        messages,
        caller,
        ...(enabled ? { cacheToolResults: true } : {}),
        tools: { read_context: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(4),
      });

      expect(requests).toHaveLength(4);
      expect(execute).toHaveBeenCalledTimes(6);
      expect(messages).toEqual(original);
      for (const [index, request] of requests.entries()) {
        const blocks = [
          ...request.system,
          ...request.messages.flatMap((message) => message.content),
        ];
        expect(
          blocks.filter((block) => block.cache_control !== undefined).length,
        ).toBeLessThanOrEqual(4);
        if (enabled || index === 0) {
          expect(request.messages.at(-1)?.content.at(-1)).toMatchObject({
            type: index === 0 ? "text" : "tool_result",
            cache_control: { type: "ephemeral" },
          });
        } else {
          expect(request.messages.at(-1)?.content.at(-1)?.cache_control).toBeUndefined();
        }
        expect(request.system).toEqual(requests[0]?.system);
      }
    },
  );

  it.each(["qwen/qwen3.5-plus", "deepseek/deepseek-v4-flash"])(
    "respects cache eligibility and parallel tool batches on OpenRouter %s",
    async (model) => {
      const schema = z.object({
        messages: z.array(
          z.object({
            role: z.string(),
            content: z.union([z.string(), z.array(blockSchema)]).nullable(),
            cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
          }),
        ),
      });
      const requests: z.infer<typeof schema>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
          requests.push(schema.parse(JSON.parse(init.body)));
          const step = requests.length;
          return Response.json({
            id: `completion-${step}`,
            model,
            choices: [
              {
                index: 0,
                finish_reason: step < 4 ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: step < 4 ? null : "Ready.",
                  ...(step < 4
                    ? {
                        tool_calls: [0, 1, 2].map((index) => ({
                          id: `call-${step}-${index}`,
                          type: "function",
                          function: { name: "read_context", arguments: "{}" },
                        })),
                      }
                    : {}),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          });
        }),
      );
      const llm = new LLM(
        withTestModelProfiles({
          dataSource: "platform",
          llm: { provider: "openrouter", model, apiKey: "synthetic-test-key" },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
          },
          contextWindowTokens: 200_000,
          compactContextWindowTokens: 200_000,
        }),
        {
          usage: { append: () => undefined },
          now: () => 0,
          getAccessToken: async () => "synthetic-token",
          classifyFailure: () => "unknown",
        },
      );
      const messages: ModelMessage[] = [{ role: "user", content: "Read the context." }];
      const original = structuredClone(messages);
      const execute = vi.fn(async () => ({ summary: "Synthetic training context." }));
      const result = await llm.generate({
        system: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Changing context`,
        messages,
        caller: "flush",
        cacheToolResults: true,
        tools: { read_context: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(4),
      });
      expect(result.text).toBe("Ready.");
      expect(requests).toHaveLength(4);
      expect(execute).toHaveBeenCalledTimes(9);
      expect(messages).toEqual(original);
      for (const [index, request] of requests.entries()) {
        const markers = request.messages
          .flatMap((message) => [
            message,
            ...(Array.isArray(message.content) ? message.content : []),
          ])
          .filter((block) => block.cache_control !== undefined);
        if (model.startsWith("qwen/")) {
          expect(markers.length).toBeLessThanOrEqual(4);
          if (index > 0) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "tool",
              cache_control: { type: "ephemeral" },
            });
            expect(
              request.messages.filter(
                (message) => message.role === "tool" && message.cache_control !== undefined,
              ),
            ).toHaveLength(1);
          }
        } else {
          expect(markers).toHaveLength(0);
        }
      }
    },
  );
});
