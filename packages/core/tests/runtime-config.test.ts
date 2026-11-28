import { describe, expect, it } from "vitest";
import { persistedLlmBackgroundModels } from "../src/background-model-persistence.js";
import { currentModelId, resolveRuntimeConfig, type LlmProvider } from "../src/runtime-config.js";

describe("runtime configuration authority", () => {
  it("preserves same-provider custom fields for a credential-only patch", () => {
    const initial = resolveRuntimeConfig({
      llm: {
        provider: "openrouter",
        model: "custom-chat-model",
        apiKey: "obviously-fake-old-key",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "custom-flush-model",
        compactModel: "custom-compact-model",
      },
      intervals: { athleteId: "athlete-custom" },
    });

    const next = resolveRuntimeConfig(
      { llm: { provider: "openrouter", apiKey: "obviously-fake-new-key" } },
      initial,
    );

    expect(next.llm).toEqual({
      provider: "openrouter",
      model: "custom-chat-model",
      apiKey: "obviously-fake-new-key",
      authProfile: undefined,
      baseUrl: "https://invalid.example.test/v1",
      flushModel: "custom-flush-model",
      compactModel: "custom-compact-model",
    });
    expect(next.intervals).toEqual(initial.intervals);
    expect(next.session).toEqual(initial.session);
    expect(next.contextWindowTokens).toBe(initial.contextWindowTokens);
  });

  it("applies canonical defaults and recomputes context after a provider change", () => {
    const initial = resolveRuntimeConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "obviously-fake-anthropic-key",
        baseUrl: "https://invalid.example.test/anthropic",
        flushModel: "custom-flush-model",
        compactModel: "custom-compact-model",
      },
    });
    expect(initial.contextWindowTokens).toBe(200_000);

    const next = resolveRuntimeConfig(
      { llm: { provider: "zai", apiKey: "obviously-fake-zai-key" } },
      initial,
    );

    expect(next.llm).toEqual({
      provider: "zai",
      model: "glm-5.3",
      apiKey: "obviously-fake-zai-key",
      authProfile: undefined,
      flushModel: undefined,
      compactModel: "glm-5.3",
      baseUrl: "https://api.z.ai/api/openai/v1",
    });
    expect(next.contextWindowTokens).toBe(1_000_000);
  });

  it("moves saved models their provider retired to the replacement and keeps the rest", () => {
    const load = (
      provider: LlmProvider,
      model: string,
      extra: { compactModel?: string; flushModel?: string; baseUrl?: string } = {},
    ) =>
      resolveRuntimeConfig({ llm: { provider, model, apiKey: "obviously-fake-key", ...extra } })
        .llm;

    expect(load("deepseek", "deepseek-v4-flash")).toMatchObject({
      model: "deepseek-flash",
      compactModel: "deepseek-flash",
    });
    expect(load("google", "gemini-3.7-flash").model).toBe("gemini-3.8-flash");
    expect(load("minimax", "MiniMax-M2.7").model).toBe("MiniMax-M3");
    expect(load("minimax", "MiniMax-M2.7-highspeed").model).toBe("MiniMax-M3.1-Flash");
    expect(
      load("openrouter", "qwen/qwen3.8-max", {
        compactModel: "qwen/qwen3.8-max",
        flushModel: "qwen/qwen3.8-max",
      }),
    ).toMatchObject({
      model: "qwen/qwen4-max",
      compactModel: "qwen/qwen4-max",
      flushModel: "qwen/qwen4-max",
    });
    expect(
      load("deepseek", "deepseek-v4-flash", { baseUrl: "https://api.deepseek.com/v1" }).model,
    ).toBe("deepseek-flash");
    expect(
      resolveRuntimeConfig({
        llm: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "obviously-fake-key" },
      }).contextWindowTokens,
    ).toBe(1_000_000);

    expect(load("anthropic", "claude-opus-5").model).toBe("claude-opus-5");
    expect(load("kimi", "kimi-k2.6").model).toBe("kimi-k2.6");
    expect(load("openrouter", "deepseek/deepseek-v4-flash").model).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(load("deepseek", "qwen/qwen3.8-max").model).toBe("qwen/qwen3.8-max");
    expect(load("deepseek", "constructor").model).toBe("constructor");
    expect(currentModelId("constructor", "name", undefined)).toBe("name");
  });

  it("keeps a retired model name the athlete sends to their own endpoint", () => {
    const viaGateway = resolveRuntimeConfig({
      llm: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        compactModel: "deepseek-v4-flash",
        baseUrl: "https://gateway.invalid.example.test/v1",
        apiKey: "obviously-fake-key",
      },
    }).llm;
    expect(viaGateway).toMatchObject({
      model: "deepseek-v4-flash",
      compactModel: "deepseek-v4-flash",
      baseUrl: "https://gateway.invalid.example.test/v1",
    });
    expect(
      resolveRuntimeConfig(
        { llm: { model: "deepseek-v4-flash" } },
        resolveRuntimeConfig({
          llm: {
            provider: "deepseek",
            baseUrl: "https://gateway.invalid.example.test/v1",
            apiKey: "obviously-fake-key",
          },
        }),
      ).llm.model,
    ).toBe("deepseek-v4-flash");
  });

  it("keeps ChatGPT compaction aligned at startup and after model changes", () => {
    const initial = resolveRuntimeConfig(
      {
        llm: {
          provider: "openai-codex",
          model: "gpt-5.5",
          compactModel: "ignored-compact-model",
        },
      },
      undefined,
      { authProfile: "test-profile" },
    );
    expect(initial.llm.compactModel).toBe("gpt-5.5");
    expect(initial.llm.authProfile).toBe("test-profile");

    const next = resolveRuntimeConfig({ llm: { model: "gpt-5.4-mini" } }, initial);
    expect(next.llm.compactModel).toBe("gpt-5.4-mini");
    expect(next.llm.authProfile).toBe("test-profile");
    expect(next.contextWindowTokens).toBe(200_000);
  });

  it("treats an explicit ChatGPT provider as a default-profile selection", () => {
    const initial = resolveRuntimeConfig(
      { llm: { provider: "openai-codex", model: "custom-model" } },
      undefined,
      { authProfile: "custom-profile" },
    );

    expect(initial.llm.authProfile).toBe("custom-profile");
    expect(
      resolveRuntimeConfig({ llm: { provider: "openai-codex" } }, initial).llm.authProfile,
    ).toBe("openai-codex");
    expect(resolveRuntimeConfig({ llm: { model: "new-model" } }, initial).llm.authProfile).toBe(
      "custom-profile",
    );
  });

  it("preserves the athlete ID for an intervals-key-only replay", () => {
    const initial = resolveRuntimeConfig({
      intervals: {
        apiKey: "obviously-fake-old-intervals-key",
        athleteId: "athlete-custom",
      },
    });

    const next = resolveRuntimeConfig(
      { intervals: { apiKey: "obviously-fake-new-intervals-key" } },
      initial,
    );

    expect(next.intervals).toEqual({
      apiKey: "obviously-fake-new-intervals-key",
      athleteId: "athlete-custom",
    });
  });

  it("accepts a seeded blank athlete ID at startup but rejects it as a live patch", () => {
    const initial = resolveRuntimeConfig({ intervals: { athleteId: "" } });

    expect(initial.intervals.athleteId).toBe("");
    expect(
      resolveRuntimeConfig({ intervals: { apiKey: "obviously-fake-intervals-key" } }, initial)
        .intervals,
    ).toEqual({ apiKey: "obviously-fake-intervals-key", athleteId: "0" });
    expect(() => resolveRuntimeConfig({ intervals: { athleteId: "" } }, initial)).toThrow(
      "intervals.athleteId",
    );
  });

  it("rejects unknown fields and malformed values", () => {
    expect(() => resolveRuntimeConfig({ unexpected: true } as never)).toThrow(
      "Unknown runtime config field",
    );
    expect(() =>
      resolveRuntimeConfig({ llm: { provider: "anthropic", unexpected: true } } as never),
    ).toThrow("Unknown llm field");
  });

  it("normalizes valid session values and rejects values the runtime snapshot cannot represent", () => {
    expect(
      resolveRuntimeConfig({
        session: {
          historyTokenBudgetRatio: 1,
          idleMinutes: Number.MAX_SAFE_INTEGER,
          dailyResetHour: 23,
          resetArchiveRetentionDays: 0,
          timezone: "  Europe/Berlin  ",
        },
      }).session,
    ).toEqual({
      historyTokenBudgetRatio: 1,
      idleMinutes: Number.MAX_SAFE_INTEGER,
      dailyResetHour: 23,
      resetArchiveRetentionDays: 0,
      timezone: "Europe/Berlin",
    });
    expect(resolveRuntimeConfig({ session: { timezone: "" } }).session.timezone).toBe("");

    for (const session of [
      { historyTokenBudgetRatio: 0 },
      { historyTokenBudgetRatio: 1.01 },
      { idleMinutes: -1 },
      { idleMinutes: Number.MAX_SAFE_INTEGER + 1 },
      { dailyResetHour: -1 },
      { dailyResetHour: 24 },
      { resetArchiveRetentionDays: -1 },
      { resetArchiveRetentionDays: Number.MAX_SAFE_INTEGER + 1 },
      { timezone: "Not/A-Timezone" },
    ]) {
      expect(() => resolveRuntimeConfig({ session })).toThrow();
    }
  });
});

describe("Astra explicit public API selection", () => {
  it("preserves defaults and background choices when opting in and back out", () => {
    const initial = resolveRuntimeConfig({
      llm: {
        provider: "openai",
        apiKey: "fake-key",
        compactModel: "gpt-6-luna",
        flushModel: "gpt-6-luna",
      },
    });
    expect(initial.llm.model).toBe("gpt-6.2-sol");
    const selected = resolveRuntimeConfig({ llm: { model: "gpt-6-astra" } }, initial);
    expect(selected.llm).toEqual({ ...initial.llm, model: "gpt-6-astra" });
    expect(selected.contextWindowTokens).toBe(1_050_000);
    const restored = resolveRuntimeConfig({ llm: { model: "gpt-6.2-sol" } }, selected);
    expect(restored.llm).toEqual(initial.llm);
    expect(restored.contextWindowTokens).toBe(initial.contextWindowTokens);
  });

  it.each(["openai-codex", "codex-agent"] as const)("refuses unverified %s support", (provider) => {
    expect(() => resolveRuntimeConfig({ llm: { provider, model: "gpt-6-astra" } })).toThrow(
      "not enabled for this connection",
    );
  });
});

it("keeps implicit OpenAI background work on its previous model when opting into Astra", () => {
  const initial = resolveRuntimeConfig({ llm: { provider: "openai", apiKey: "fake-key" } });
  const selected = resolveRuntimeConfig({ llm: { model: "gpt-6-astra" } }, initial);
  expect(selected.llm.flushModel).toBe(initial.llm.flushModel ?? initial.llm.model);
  expect(selected.llm.compactModel).toBe(initial.llm.compactModel ?? initial.llm.model);
  const fresh = resolveRuntimeConfig({
    llm: { provider: "openai", model: "gpt-6-astra", apiKey: "fake-key" },
  });
  expect(fresh.llm.flushModel).toBe("gpt-6.2-sol");
  expect(fresh.llm.compactModel).toBe("gpt-6.2-sol");
});

describe("background summary and memory model choices", () => {
  it("moves OpenAI background models to the new chat model after leaving Astra", () => {
    const sol = resolveRuntimeConfig({
      llm: { provider: "openai", model: "gpt-6.2-sol", apiKey: "fake-key" },
    });
    const astra = resolveRuntimeConfig({ llm: { model: "gpt-6-astra" } }, sol);
    expect(persistedLlmBackgroundModels(astra)).toEqual({
      flushModel: undefined,
      compactModel: undefined,
      beforeAstraModel: "gpt-6.2-sol",
    });
    const luna = resolveRuntimeConfig({ llm: { model: "gpt-6-luna" } }, astra);
    expect(luna.llm.compactModel).toBe("gpt-6-luna");
    expect(luna.llm.flushModel).toBeUndefined();
    expect(persistedLlmBackgroundModels(luna)).toEqual({
      flushModel: undefined,
      compactModel: undefined,
      beforeAstraModel: undefined,
    });
  });

  it("preserves beforeAstra across restart and drops it when leaving Astra", () => {
    const luna = resolveRuntimeConfig({
      llm: { provider: "openai", model: "gpt-6-luna", apiKey: "fake-key" },
    });
    const astra = resolveRuntimeConfig({ llm: { model: "gpt-6-astra" } }, luna);
    const persisted = persistedLlmBackgroundModels(astra);
    const reloaded = resolveRuntimeConfig(
      {
        llm: {
          provider: "openai",
          model: "gpt-6-astra",
          apiKey: "fake-key",
          flushModel: persisted.flushModel,
          compactModel: persisted.compactModel,
        },
      },
      undefined,
      { beforeAstraModel: persisted.beforeAstraModel },
    );
    expect(reloaded.llm.compactModel).toBe("gpt-6-luna");
    expect(reloaded.llm.flushModel).toBe("gpt-6-luna");

    const sol = resolveRuntimeConfig({ llm: { model: "gpt-6.2-sol" } }, reloaded);
    expect(sol.llm.compactModel).toBe("gpt-6.2-sol");
    expect(sol.llm.flushModel).toBeUndefined();
  });

  it("keeps OpenRouter and Anthropic compaction on the provider default across model changes", () => {
    const orDefault = resolveRuntimeConfig({
      llm: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash-1017",
        apiKey: "fake-key",
      },
    });
    const orPremium = resolveRuntimeConfig({ llm: { model: "moonshotai/kimi-k3" } }, orDefault);
    expect(orPremium.llm.compactModel).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(orPremium.llm.flushModel).toBeUndefined();

    const haiku = resolveRuntimeConfig({
      llm: { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "fake-key" },
    });
    const sonnet = resolveRuntimeConfig({ llm: { model: "claude-sonnet-5-5" } }, haiku);
    expect(sonnet.llm.compactModel).toBe("claude-haiku-5-5");
    expect(sonnet.llm.flushModel).toBeUndefined();
  });

  it("keeps explicit background models equal to the chat model across model changes", () => {
    const initial = resolveRuntimeConfig({
      llm: {
        provider: "openai",
        model: "gpt-6-luna",
        apiKey: "fake-key",
        compactModel: "gpt-6-luna",
        flushModel: "gpt-6-luna",
      },
    });
    expect(persistedLlmBackgroundModels(initial)).toEqual({
      flushModel: "gpt-6-luna",
      compactModel: "gpt-6-luna",
      beforeAstraModel: undefined,
    });
    const next = resolveRuntimeConfig({ llm: { model: "gpt-6.2-sol" } }, initial);
    expect(next.llm.compactModel).toBe("gpt-6-luna");
    expect(next.llm.flushModel).toBe("gpt-6-luna");
  });
});
