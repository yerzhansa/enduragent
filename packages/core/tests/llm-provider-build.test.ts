import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import { LLM } from "../src/llm.js";

// A minimal Config; the LLM constructor only reads config.llm.{provider,model,apiKey,baseUrl}.
function cfg(provider: string, model: string, baseUrl?: string): Config {
  return {
    llm: { provider, model, apiKey: "sk-test-key", baseUrl },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 128_000,
    dataDir: "/tmp/llm-provider-build-test",
  } as Config;
}

describe("LLM — API-key provider construction + pricing guard", () => {
  // Construction must not throw for any provider, including the providers
  // (deepseek/qwen/kimi/minimax) deliberately absent from the vendored price
  // catalog — they resolve to an unpriced LLM (cost: undefined on the ledger).
  it.each([
    ["anthropic", "claude-sonnet-4-6", undefined],
    ["openai", "gpt-5.4", undefined],
    ["google", "gemini-3-flash-preview", undefined],
    ["deepseek", "deepseek-v4-flash", "https://api.deepseek.com/v1"],
    ["qwen", "qwen-plus", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["minimax", "MiniMax-M2-Stable", "https://api.minimax.io/v1"],
    ["kimi", "kimi-k2-0905", "https://api.moonshot.ai/v1"],
    ["zai", "glm-4.6", "https://api.z.ai/api/openai/v1"],
    ["openrouter", "deepseek/deepseek-chat", "https://openrouter.ai/api/v1"],
  ])("builds an AI SDK model for %s without throwing", (provider, model, baseUrl) => {
    const llm = new LLM(cfg(provider, model, baseUrl));
    // aiSdkModel is built (not the codex null path).
    expect((llm as unknown as { aiSdkModel: unknown }).aiSdkModel).not.toBeNull();
  });

  // deepseek/qwen/kimi/minimax are absent from the vendored price catalog (their
  // default models aren't listed), so each must resolve to an unpriced LLM
  // (cost: undefined on the ledger).
  it.each([["deepseek"], ["qwen"], ["kimi"], ["minimax"]])(
    "%s resolves to an unpriced LLM",
    (provider) => {
      const llm = new LLM(cfg(provider, "some-model"));
      expect((llm as unknown as { priced: boolean }).priced).toBe(false);
    },
  );
});
