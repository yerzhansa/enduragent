import { describe, expect, it } from "vitest";
import {
  ModelCatalogSnapshotSchema,
  type CatalogPricing,
} from "@enduragent/coach-contract/model-catalog";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import { LLM_MODEL_CATALOGUE } from "../src/runtime-config.js";
import { MODEL_CATALOG_BASELINE } from "./fixtures/model-catalog-baseline.js";

function baselinePricing(pricing: CatalogPricing) {
  return pricing.kind === "unknown"
    ? pricing
    : {
        kind: pricing.kind,
        input: pricing.inputUsdPerMillion,
        output: pricing.outputUsdPerMillion,
        cacheRead: pricing.cacheReadUsdPerMillion,
        cacheWrite: pricing.cacheWriteUsdPerMillion,
      };
}

describe("bundled model catalog seed", () => {
  it("is valid and preserves the frozen compiled baseline", () => {
    expect(ModelCatalogSnapshotSchema.safeParse(BUNDLED_MODEL_CATALOG).success).toBe(true);
    expect(
      BUNDLED_MODEL_CATALOG.providers
        .filter((provider) =>
          LLM_MODEL_CATALOGUE.some((candidate) => candidate.provider === provider.providerId),
        )
        .map((provider) => ({
          provider: provider.providerId,
          label: provider.label,
          ...(provider.hint === undefined ? {} : { hint: provider.hint }),
          defaultModel: provider.recommendedModelId,
          models: provider.models.map((model) => ({
            value: model.modelId,
            label: model.label,
            ...(model.hint === undefined ? {} : { hint: model.hint }),
            contextWindowTokens:
              model.contextWindow.kind === "known" ? model.contextWindow.tokens : 200_000,
            catalogContext: model.contextWindow,
            imageInput: model.imageInput,
            pricing: baselinePricing(model.pricing),
          })),
        })),
    ).toEqual(MODEL_CATALOG_BASELINE);
  });

  it("contains metadata only", () => {
    const serialized = JSON.stringify(BUNDLED_MODEL_CATALOG);
    expect(serialized).not.toMatch(
      /baseUrl|endpoint|apiKey|auth|executable|enabled|providerOptions/,
    );
  });

  it("includes the revision-2 model ids without dropping legacy DeepSeek V4 Flash", () => {
    expect(BUNDLED_MODEL_CATALOG.revision).toBe(2);
    const ids = Object.fromEntries(
      BUNDLED_MODEL_CATALOG.providers.map((provider) => [
        provider.providerId,
        provider.models.map((model) => model.modelId),
      ]),
    );
    expect(ids.openai).toContain("gpt-6-astra");
    expect(ids.anthropic).toContain("claude-fable-5-1");
    expect(ids["claude-cli"]).toContain("fable");
    expect(ids.google).toEqual(expect.arrayContaining(["gemini-3.8-flash", "gemini-3.7-flash"]));
    expect(ids.deepseek).toEqual(expect.arrayContaining(["deepseek-flash", "deepseek-v4-flash"]));
    expect(ids.qwen).toEqual(expect.arrayContaining(["qwen3.8-max", "qwen3.8-flash"]));
    expect(ids.zai).toContain("glm-5.3-flash");
    expect(ids.zai).not.toContain("glm-5.3");
    expect(ids.kimi).toContain("kimi-k2.7-code");
    expect(ids.minimax).toContain("MiniMax-M2.7-highspeed");
    expect(ids.openrouter).toEqual(
      expect.arrayContaining([
        "openai/gpt-6-astra",
        "anthropic/claude-fable-5.1",
        "deepseek/deepseek-v4.1-flash",
        "qwen/qwen3.8-max",
        "z-ai/glm-5.3-flash",
        "moonshotai/kimi-k2.7-code",
      ]),
    );
    expect(ids["openai-codex"]).not.toContain("gpt-6-astra");
    expect(ids["codex-agent"]).not.toContain("gpt-6-astra");
    expect(
      BUNDLED_MODEL_CATALOG.providers
        .find((provider) => provider.providerId === "openai")
        ?.models.find((model) => model.modelId === "gpt-6-astra")?.compatibilityProfile,
    ).toBe("openai-astra-v1");
  });
});
