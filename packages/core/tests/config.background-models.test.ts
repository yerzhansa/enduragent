import { describe, expect, it } from "vitest";
import { assignPersistedLlmBackgroundModels } from "../src/background-model-persistence.js";
import { loadConfigFromYaml } from "../src/config.js";
import { resolveRuntimeConfig, type EffectiveRuntimeConfig } from "../src/runtime-config.js";
import { setupConfigEnvSandbox } from "./helpers/config-env-sandbox.js";

setupConfigEnvSandbox("cc-background-models-");

function pickAfterRestart(llm: Record<string, unknown>, model: string): EffectiveRuntimeConfig {
  return resolveRuntimeConfig({ llm: { model } }, loadConfigFromYaml({ llm }));
}

function savedLlm(config: EffectiveRuntimeConfig): Record<string, unknown> {
  const llm: Record<string, unknown> = {
    provider: config.llm.provider,
    model: config.llm.model,
    api_key: "fake-key",
  };
  if (config.llm.baseUrl !== undefined) llm.base_url = config.llm.baseUrl;
  assignPersistedLlmBackgroundModels(llm, config);
  return llm;
}

describe("summary and memory models saved by an older version", () => {
  it.each([
    ["openai", "gpt-6.2-sol", "gpt-6-luna"],
    ["google", "gemini-4-hydrogen", "gemini-4-neon"],
    ["deepseek", "deepseek-flash", "deepseek-v4-pro"],
    ["deepseek", "deepseek-v4-flash", "deepseek-v4-pro"],
  ])("moves %s summaries from %s to the picked %s", (provider, saved, picked) => {
    const llm = { provider, model: saved, api_key: "fake-key", compact_model: saved };
    const next = pickAfterRestart(llm, picked);
    expect(next.llm.compactModel).toBe(picked);
    expect(next.llm.flushModel).toBeUndefined();
  });

  it("keeps Anthropic summaries on the provider default", () => {
    const llm = {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      api_key: "fake-key",
      compact_model: "claude-haiku-5-5",
    };
    expect(loadConfigFromYaml({ llm }).llm.compactModel).toBe("claude-haiku-5-5");
    const next = pickAfterRestart(llm, "claude-opus-5-5");
    expect(next.llm.compactModel).toBe("claude-haiku-5-5");
    expect(next.llm.flushModel).toBeUndefined();
  });

  it.each(["gpt-6.2-sol", "gpt-6-luna"])(
    "reads a GPT-6 Astra file saved after %s as the model used before Astra",
    (beforeAstra) => {
      const llm = {
        provider: "openai",
        model: "gpt-6-astra",
        api_key: "fake-key",
        compact_model: beforeAstra,
        flush_model: beforeAstra,
      };
      const loaded = loadConfigFromYaml({ llm });
      expect(loaded.llm.compactModel).toBe(beforeAstra);
      expect(loaded.llm.flushModel).toBe(beforeAstra);
      const next = pickAfterRestart(llm, "gpt-6.1-terra");
      expect(next.llm.compactModel).toBe("gpt-6.1-terra");
      expect(next.llm.flushModel).toBeUndefined();
    },
  );

  it("moves a memory model left equal to the chat model after GPT-6 Astra", () => {
    const llm = {
      provider: "openai",
      model: "gpt-6.2-sol",
      api_key: "fake-key",
      compact_model: "gpt-6.2-sol",
      flush_model: "gpt-6.2-sol",
    };
    const next = pickAfterRestart(llm, "gpt-6-luna");
    expect(next.llm.compactModel).toBe("gpt-6-luna");
    expect(next.llm.flushModel).toBeUndefined();
  });

  it("keeps a saved model that matches no derived choice", () => {
    const llm = {
      provider: "openai",
      model: "gpt-6-luna",
      api_key: "fake-key",
      compact_model: "gpt-6.2-sol",
      flush_model: "gpt-6.2-sol",
    };
    const next = pickAfterRestart(llm, "gpt-6.1-terra");
    expect(next.llm.compactModel).toBe("gpt-6.2-sol");
    expect(next.llm.flushModel).toBe("gpt-6.2-sol");
  });

  it("keeps LLM_COMPACT_MODEL explicit when it equals the chat model", () => {
    process.env.LLM_COMPACT_MODEL = "gpt-6.2-sol";
    const llm = { provider: "openai", model: "gpt-6.2-sol", api_key: "fake-key" };
    expect(pickAfterRestart(llm, "gpt-6-luna").llm.compactModel).toBe("gpt-6.2-sol");
  });
});

describe("summary and memory models saved by this version", () => {
  it("keeps explicit choices equal to the chat model across restarts and model picks", () => {
    const chosen = resolveRuntimeConfig({
      llm: {
        provider: "openai",
        model: "gpt-6-luna",
        apiKey: "fake-key",
        compactModel: "gpt-6-luna",
        flushModel: "gpt-6-luna",
      },
    });
    const llm = savedLlm(chosen);
    expect(llm.explicit_background_models).toEqual(["compact", "flush"]);
    const sol = pickAfterRestart(llm, "gpt-6.2-sol");
    expect(sol.llm.compactModel).toBe("gpt-6-luna");
    expect(sol.llm.flushModel).toBe("gpt-6-luna");
    const terra = pickAfterRestart(savedLlm(sol), "gpt-6.1-terra");
    expect(terra.llm.compactModel).toBe("gpt-6-luna");
    expect(terra.llm.flushModel).toBe("gpt-6-luna");
  });

  it("re-derives the background model the athlete did not choose", () => {
    const chosen = resolveRuntimeConfig({
      llm: {
        provider: "openai",
        model: "gpt-6-luna",
        apiKey: "fake-key",
        flushModel: "gpt-6-luna",
      },
    });
    const llm = savedLlm(chosen);
    expect(llm.explicit_background_models).toEqual(["flush"]);
    expect(llm.compact_model).toBeUndefined();
    const next = pickAfterRestart(llm, "gpt-6.2-sol");
    expect(next.llm.compactModel).toBe("gpt-6.2-sol");
    expect(next.llm.flushModel).toBe("gpt-6-luna");
  });

  it("writes no explicit list when nothing is explicit", () => {
    const anthropic = resolveRuntimeConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "fake-key" },
    });
    expect(savedLlm(anthropic)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      api_key: "fake-key",
      compact_model: "claude-haiku-5-5",
    });
  });
});
