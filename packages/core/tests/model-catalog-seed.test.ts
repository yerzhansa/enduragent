import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ModelCatalogSnapshotSchema,
  type CatalogPricing,
} from "@enduragent/coach-contract/model-catalog";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import { LLM_MODEL_CATALOGUE } from "../src/runtime-config.js";
import { MODEL_CATALOG_BASELINE } from "./fixtures/model-catalog-baseline.js";

const MILLION = 1_000_000;

function perMillion(usdPerMillion: number): number {
  return (usdPerMillion / MILLION) * MILLION;
}

function baselinePricing(pricing: CatalogPricing) {
  return pricing.kind === "unknown"
    ? pricing
    : {
        kind: pricing.kind,
        input: perMillion(pricing.inputUsdPerMillion),
        output: perMillion(pricing.outputUsdPerMillion),
        cacheRead: perMillion(pricing.cacheReadUsdPerMillion),
        cacheWrite: perMillion(pricing.cacheWriteUsdPerMillion),
      };
}

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

  it("contains metadata only", () => {
    const serialized = JSON.stringify(BUNDLED_MODEL_CATALOG);
    expect(serialized).not.toMatch(
      /baseUrl|endpoint|apiKey|auth|executable|enabled|providerOptions/,
    );
  });

  it("includes the revision-10 model ids and drops the retired ones", () => {
    expect(BUNDLED_MODEL_CATALOG.revision).toBe(10);
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
    expect(ids.deepseek).toContain("deepseek-flash");
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
      deepseek: ["deepseek-v4-flash"],
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
