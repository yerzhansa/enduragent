import { describe, it, expect } from "vitest";
import type { EngineConfig, EngineLlmProvider } from "../src/host-ports.js";
import { LLM } from "../src/llm.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

// A minimal Config; the LLM constructor only reads config.llm.{provider,model,apiKey,baseUrl}.
function cfg(provider: EngineLlmProvider, model: string, baseUrl?: string): EngineConfig {
  return {
    llm: { provider, model, apiKey: "sk-test-key", baseUrl },
    dataSource: "platform",
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    models: testModelProfiles({
      provider,
      chat: model,
      chatContextWindowTokens: 128_000,
    }),
    contextWindowTokens: 128_000,
    compactContextWindowTokens: 128_000,
  } as EngineConfig;
}

describe("LLM — new provider construction + pricing guard", () => {
  // Construction must not throw for any new provider, including the providers
  // (deepseek/qwen/kimi/minimax) deliberately absent from the vendored price
  // catalog — they resolve to an unpriced LLM (cost: undefined on the ledger).
  it.each<[EngineLlmProvider, string, string]>([
    ["deepseek", "deepseek-v4-flash", "https://api.deepseek.com/v1"],
    ["qwen", "qwen-plus", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["minimax", "MiniMax-M2-Stable", "https://api.minimax.io/v1"],
    ["kimi", "kimi-k2-0905", "https://api.moonshot.ai/v1"],
    ["zai", "glm-4.6", "https://api.z.ai/api/openai/v1"],
    ["openrouter", "deepseek/deepseek-chat", "https://openrouter.ai/api/v1"],
  ])("builds an AI SDK model for %s without throwing", (provider, model, baseUrl) => {
    const llm = new LLM(cfg(provider, model, baseUrl), llmTestPorts());
    // aiSdkModel is built (not the codex null path).
    expect((llm as unknown as { aiSdkModel: unknown }).aiSdkModel).not.toBeNull();
  });

  // deepseek/qwen/kimi/minimax are absent from the vendored price catalog (their
  // default models aren't listed), so each must resolve to an unpriced LLM
  // (cost: undefined on the ledger).
  it.each<[EngineLlmProvider]>([["deepseek"], ["qwen"], ["kimi"], ["minimax"]])(
    "%s resolves to an unpriced LLM",
    (provider) => {
      const llm = new LLM(cfg(provider, "some-model"), llmTestPorts());
      expect((llm as unknown as { profile: { pricing: unknown } }).profile.pricing).toEqual({
        kind: "unknown",
      });
    },
  );
});
