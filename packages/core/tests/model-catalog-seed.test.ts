import { describe, expect, it } from "vitest";
import {
  ModelCatalogSnapshotSchema,
  type CatalogPricing,
} from "@enduragent/coach-contract/model-catalog";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
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
      BUNDLED_MODEL_CATALOG.providers.map((provider) => ({
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
});
