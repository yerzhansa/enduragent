import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ModelCatalogSnapshotSchema,
  type CatalogPricing,
} from "@enduragent/coach-contract/model-catalog";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  LLM_MODEL_CATALOGUE,
  RETIRED_MODEL_REPLACEMENTS,
} from "../src/runtime-config.js";
import { MODEL_CATALOG_BASELINE } from "./fixtures/model-catalog-baseline.js";

const MILLION = 1_000_000;

function costOfOneMillionTokens(usdPerMillion: number): number {
  return (usdPerMillion / MILLION) * MILLION;
}

function baselinePricing(pricing: CatalogPricing) {
  return pricing.kind === "unknown"
    ? pricing
    : {
        kind: pricing.kind,
        input: costOfOneMillionTokens(pricing.inputUsdPerMillion),
        output: costOfOneMillionTokens(pricing.outputUsdPerMillion),
        cacheRead: costOfOneMillionTokens(pricing.cacheReadUsdPerMillion),
        cacheWrite: costOfOneMillionTokens(pricing.cacheWriteUsdPerMillion),
      };
}

function seedModel(provider: string, model: string) {
  return BUNDLED_MODEL_CATALOG.providers
    .find((candidate) => candidate.providerId === provider)
    ?.models.find((candidate) => candidate.modelId === model);
}

const MEASURED_DEFAULT_PRICES = {
  "anthropic/claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "anthropic/claude-haiku-5-5": [0.5, 2.5, 0.05, 0.625],
  "openai/gpt-6.2-sol": [4, 15, 0.2, 5],
  "google/gemini-4-hydrogen": [1.5, 7.5, 0.075, 0],
  "deepseek/deepseek-flash": [0.3, 1.2, 0.006, 0],
  "qwen/qwen4-max": [1.5, 4.5, 0.3, 1.5],
  "minimax/MiniMax-M3": [0.6, 2.4, 0.12, 0],
  "kimi/kimi-k3.1-pro": [2, 10, 0.2, 2],
  "zai/glm-5.3": [1.4, 4.4, 0.26, 0],
  "openrouter/deepseek/deepseek-v4.1-flash-1017": [0.15, 0.6, 0.003, 0],
} as const;

describe("bundled model catalog seed", () => {
  it("imports the snapshot schema from the built coach-contract export", () => {
    const seed = readFileSync(
      fileURLToPath(new URL("../src/model-catalog-seed.ts", import.meta.url)),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../coach-contract/package.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      exports?: { "./model-catalog"?: { types?: string; import?: string } };
    };
    expect(seed).toContain('from "@enduragent/coach-contract/model-catalog"');
    expect(manifest.exports?.["./model-catalog"]).toEqual({
      types: "./dist/model-catalog.d.ts",
      import: "./dist/model-catalog.js",
    });
  });

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

  it("prices every direct-key default and summariser at the measured provider rate", () => {
    const keyed = Object.entries({ ...DEFAULT_MODELS }).filter(
      ([provider]) => !["openai-codex", "claude-cli", "codex-agent"].includes(provider),
    );
    const defaults = [...keyed, ["anthropic", COMPACT_MODEL_DEFAULTS.anthropic] as const];
    const priced = Object.fromEntries(
      defaults.map(([provider, model]) => {
        const pricing = seedModel(provider, model)?.pricing;
        return [
          `${provider}/${model}`,
          pricing?.kind === "token-rates"
            ? [
                pricing.inputUsdPerMillion,
                pricing.outputUsdPerMillion,
                pricing.cacheReadUsdPerMillion,
                pricing.cacheWriteUsdPerMillion,
              ]
            : pricing,
        ];
      }),
    );
    expect(priced).toEqual(MEASURED_DEFAULT_PRICES);
  });

  it("replaces each retired model with one the bundled list offers", () => {
    for (const [provider, replacements] of Object.entries(RETIRED_MODEL_REPLACEMENTS)) {
      for (const [retired, replacement] of Object.entries(replacements)) {
        expect(seedModel(provider, replacement), `${provider} ${replacement}`).toBeDefined();
        if (provider === "deepseek" && retired === "deepseek-v4-flash") continue;
        expect(seedModel(provider, retired), `${provider} ${retired}`).toBeUndefined();
      }
    }
  });

  it("keeps the old DeepSeek name released builds default to, priced like its replacement", () => {
    const replacement = seedModel("deepseek", "deepseek-flash");
    expect(replacement?.hint).toBe("recommended");
    expect(seedModel("deepseek", "deepseek-v4-flash")).toEqual({
      ...replacement,
      modelId: "deepseek-v4-flash",
      label: "DeepSeek V4.1 Flash (old name)",
      order: 2,
      hint: undefined,
    });
  });

  it("contains metadata only", () => {
    const serialized = JSON.stringify(BUNDLED_MODEL_CATALOG);
    expect(serialized).not.toMatch(
      /baseUrl|endpoint|apiKey|auth|executable|enabled|providerOptions/,
    );
  });

  it("includes the revision-12 model ids and drops the retired ones", () => {
    expect(BUNDLED_MODEL_CATALOG.revision).toBe(12);
    const ids = Object.fromEntries(
      BUNDLED_MODEL_CATALOG.providers.map((provider) => [
        provider.providerId,
        provider.models.map((model) => model.modelId),
      ]),
    );
    expect(
      Object.fromEntries(
        BUNDLED_MODEL_CATALOG.providers.map((provider) => [
          provider.providerId,
          provider.recommendedModelId,
        ]),
      ),
    ).toEqual({
      anthropic: "claude-sonnet-5-5",
      openai: "gpt-6.2-sol",
      google: "gemini-4-hydrogen",
      "openai-codex": "gpt-5.6-sol",
      "claude-cli": "sonnet",
      "codex-agent": "gpt-5.6-sol",
      deepseek: "deepseek-flash",
      qwen: "qwen4-max",
      minimax: "MiniMax-M3",
      kimi: "kimi-k3.1-pro",
      zai: "glm-5.3",
      openrouter: "deepseek/deepseek-v4.1-flash-1017",
    });
    expect(ids.anthropic).toEqual(
      expect.arrayContaining([
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-opus-5-5",
        "claude-fable-5-2",
      ]),
    );
    expect(ids.openai).toEqual(
      expect.arrayContaining(["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"]),
    );
    expect(ids.google).toEqual(
      expect.arrayContaining(["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"]),
    );
    expect(ids.deepseek).toEqual(["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(ids.qwen).toEqual(expect.arrayContaining(["qwen4-max", "qwen3.8-flash"]));
    expect(ids.minimax).toContain("MiniMax-M3.1-Flash");
    expect(ids.kimi).toContain("kimi-k3.1-pro");
    expect(ids.zai).toEqual(expect.arrayContaining(["glm-5.3", "glm-5.3-flash"]));
    expect(ids["claude-cli"]).toContain("fable");
    expect(ids.openrouter).toEqual(
      expect.arrayContaining([
        "deepseek/deepseek-v4.1-flash-1017",
        "anthropic/claude-sonnet-5.5",
        "anthropic/claude-haiku-5.5",
        "anthropic/claude-opus-5.5",
        "openai/gpt-6.2-sol",
        "google/gemini-4-hydrogen",
        "qwen/qwen4-max",
        "z-ai/glm-5.3",
        "moonshotai/kimi-k3.1-pro",
        "minimax/minimax-m3.1-flash",
        "deepseek/deepseek-v4-flash",
      ]),
    );

    const retired = {
      anthropic: ["claude-opus-5", "claude-fable-5-1"],
      google: ["gemini-3.7-flash", "gemini-3.1-pro-preview"],
      qwen: ["qwen3.7-max", "qwen3.8-max"],
      minimax: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
      kimi: ["kimi-k2.6", "kimi-k2.7-code"],
      zai: ["glm-5.2", "glm-4.7-flashx"],
      openrouter: [
        "qwen/qwen3.8-max",
        "openai/gpt-6-astra",
        "anthropic/claude-fable-5.1",
        "deepseek/deepseek-v4.1-flash",
        "moonshotai/kimi-k2.7-code",
        "z-ai/glm-5.2",
      ],
    } as const;
    for (const [lane, models] of Object.entries(retired)) {
      for (const model of models) expect(ids[lane], `${lane} ${model}`).not.toContain(model);
    }
    expect(ids.openai?.filter((model) => model.startsWith("gpt-5.6-"))).toEqual(["gpt-5.6-sol"]);
    expect(ids.anthropic).toContain("claude-haiku-4-5-20251001");

    expect(ids["openai-codex"]).not.toContain("gpt-6-astra");
    expect(ids["codex-agent"]).not.toContain("gpt-6-astra");
    expect(
      BUNDLED_MODEL_CATALOG.providers
        .find((provider) => provider.providerId === "openai")
        ?.models.find((model) => model.modelId === "gpt-6-astra")?.compatibilityProfile,
    ).toBe("openai-astra-v1");
  });
});
