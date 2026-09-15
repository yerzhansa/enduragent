import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  LLM_MODEL_CATALOGUE,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  resolveRuntimeConfig,
} from "../src/runtime-config.js";
import { GENERATED_MODEL_CATALOG_SEED } from "../src/model-catalog-seed.generated.js";

describe("LLM model catalogue", () => {
  it("covers providers in setup order and keeps defaults in the bundled seed", () => {
    expect(LLM_MODEL_CATALOGUE.map((entry) => entry.provider)).toEqual(
      LLM_PROVIDERS.filter((provider) => provider !== "codex-agent"),
    );
    for (const entry of LLM_MODEL_CATALOGUE) {
      expect(entry.defaultModel).toBe(DEFAULT_MODELS[entry.provider]);
      expect(entry).not.toHaveProperty("models");
      const seed = GENERATED_MODEL_CATALOG_SEED.providers.find(
        (provider) => provider.providerId === entry.provider,
      );
      expect(seed?.models.map((model) => model.modelId)).toContain(entry.defaultModel);
      expect(new Set(seed?.models.map((model) => model.modelId)).size).toBe(seed?.models.length);
    }
  });

  it("projects only the resolver's declared provider defaults", () => {
    for (const entry of LLM_MODEL_CATALOGUE) {
      expect(entry.defaultBaseUrl).toBe(
        PROVIDER_BASE_URLS[entry.provider as keyof typeof PROVIDER_BASE_URLS],
      );
    }
  });

  it("keeps the catalogue advisory by accepting a custom model", () => {
    expect(
      resolveRuntimeConfig({
        llm: {
          provider: "anthropic",
          model: "athlete-custom-model",
          apiKey: "obviously-fake-key",
        },
      }).llm.model,
    ).toBe("athlete-custom-model");
  });
});
