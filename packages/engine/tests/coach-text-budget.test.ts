import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineConfig, EngineLlmProvider } from "../src/host-ports.js";
import { coachTextBudget } from "../src/caller-options.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

interface SentBody {
  readonly reasoning?: { readonly effort?: string };
  readonly reasoning_effort?: string;
  readonly thinking?: unknown;
  readonly max_output_tokens?: number;
  readonly max_tokens?: number;
  readonly generationConfig?: { readonly maxOutputTokens?: number };
}

function config(provider: EngineLlmProvider, model: string): EngineConfig {
  return {
    dataSource: "platform",
    llm: { provider, model, apiKey: "synthetic-key" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    models: testModelProfiles({ provider, chat: model }),
    contextWindowTokens: 200_000,
    compactContextWindowTokens: 200_000,
  };
}

async function sentBody(
  provider: EngineLlmProvider,
  model: string,
  caller: "coach-text" | "intent-translation",
): Promise<SentBody> {
  const bodies: SentBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { readonly body?: string }) => {
      bodies.push(JSON.parse(init.body ?? "{}") as SentBody);
      return new Response(JSON.stringify({ error: { message: "synthetic stop" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(config(provider, model), llmTestPorts());
  await llm
    .generate({
      prompt: "synthetic",
      caller,
      ...(caller === "intent-translation" ? { maxOutputTokens: 2_048 } : {}),
    })
    .catch((error: unknown) => error);
  const body = bodies.at(-1);
  if (body === undefined) throw new Error("no request was sent");
  return body;
}

function cap(body: SentBody): number | undefined {
  return body.max_output_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens;
}

function effort(body: SentBody): string | undefined {
  return body.reasoning?.effort ?? body.reasoning_effort;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the coach's verdict request: effort and output cap", () => {
  it.each(["gpt-6-astra", "gpt-5.2"])(
    "asks OpenAI's %s for low reasoning effort with a 600-token cap",
    async (model) => {
      const body = await sentBody("openai", model, "coach-text");
      expect(effort(body)).toBe("low");
      expect(cap(body)).toBe(600);
    },
  );

  it("sends OpenAI's gpt-6.2-sol no reasoning field and a 2,000-token cap", async () => {
    const body = await sentBody("openai", "gpt-6.2-sol", "coach-text");
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(cap(body)).toBe(2_000);
  });

  it("sends OpenRouter no reasoning field and a 2,000-token cap", async () => {
    const body = await sentBody("openrouter", "deepseek/deepseek-v4.1-flash-1017", "coach-text");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(cap(body)).toBe(2_000);
  });

  it("sends Anthropic no thinking and a 600-token cap", async () => {
    const body = await sentBody("anthropic", "claude-synthetic", "coach-text");
    expect(body.thinking).toBeUndefined();
    expect(cap(body)).toBe(600);
  });

  it.each([
    ["google", "gemini-synthetic"],
    ["deepseek", "deepseek-synthetic"],
  ] as const)(
    "sends %s the provider's default effort and a 2,000-token cap",
    async (provider, model) => {
      const body = await sentBody(provider, model, "coach-text");
      expect(effort(body)).toBeUndefined();
      expect(cap(body)).toBe(2_000);
    },
  );

  it("leaves other callers' requests unchanged", async () => {
    const reasoning = await sentBody("openai", "gpt-5.2", "intent-translation");
    expect(reasoning.reasoning).toBeUndefined();
    expect(cap(reasoning)).toBe(2_048);
    const routed = await sentBody(
      "openrouter",
      "deepseek/deepseek-v4.1-flash-1017",
      "intent-translation",
    );
    expect(routed).not.toHaveProperty("reasoning");
    expect(cap(routed)).toBe(2_048);
  });

  it("chooses the effort and the cap together for every provider", () => {
    expect(
      Object.fromEntries(
        (
          [
            ["openai", "gpt-6-astra"],
            ["openai", "gpt-5.2"],
            ["openai", "o3-synthetic"],
            ["openai", "gpt-6.2-sol"],
            ["openai", "gpt-5-chat-latest"],
            ["codex-agent", "gpt-5.6-sol"],
            ["anthropic", "claude-synthetic"],
            ["openai-codex", "gpt-5.4"],
            ["claude-cli", "sonnet"],
            ["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
            ["google", "gemini-synthetic"],
            ["deepseek", "deepseek-synthetic"],
            ["qwen", "qwen-synthetic"],
            ["minimax", "minimax-synthetic"],
            ["kimi", "kimi-synthetic"],
            ["zai", "glm-synthetic"],
          ] as const
        ).map(([provider, model]) => [`${provider} ${model}`, coachTextBudget(provider, model)]),
      ),
    ).toEqual({
      "openai gpt-6-astra": { lowEffort: true, maxOutputTokens: 600 },
      "openai gpt-5.2": { lowEffort: true, maxOutputTokens: 600 },
      "openai o3-synthetic": { lowEffort: true, maxOutputTokens: 600 },
      "openai gpt-6.2-sol": { lowEffort: false, maxOutputTokens: 2_000 },
      "openai gpt-5-chat-latest": { lowEffort: false, maxOutputTokens: 2_000 },
      "codex-agent gpt-5.6-sol": { lowEffort: true, maxOutputTokens: 600 },
      "anthropic claude-synthetic": { lowEffort: false, maxOutputTokens: 600 },
      "openai-codex gpt-5.4": { lowEffort: false, maxOutputTokens: 2_000 },
      "claude-cli sonnet": { lowEffort: false, maxOutputTokens: 2_000 },
      "openrouter deepseek/deepseek-v4.1-flash-1017": { lowEffort: false, maxOutputTokens: 2_000 },
      "google gemini-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
      "deepseek deepseek-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
      "qwen qwen-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
      "minimax minimax-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
      "kimi kimi-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
      "zai glm-synthetic": { lowEffort: false, maxOutputTokens: 2_000 },
    });
  });
});
