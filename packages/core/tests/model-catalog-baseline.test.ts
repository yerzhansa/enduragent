import { describe, expect, it } from "vitest";
import { priceClaudeCliInclusiveUsage } from "../../engine/src/agent/claude-cli/cost.js";
import {
  resolveAttachmentCapabilities,
  transportForProvider,
} from "../../engine/src/attachment-capabilities.js";
import { priceInclusiveUsage } from "../../engine/src/usage-cost.js";
import {
  COMPACT_MODEL_DEFAULTS,
  LLM_MODEL_CATALOGUE,
  contextWindowForModel,
  isKeylessProvider,
  resolveRuntimeConfig,
} from "../src/runtime-config.js";
import {
  MODEL_CATALOG_BASELINE,
  MODEL_CATALOG_BASELINE_ASTRA_REFUSALS,
  MODEL_CATALOG_BASELINE_BACKGROUND_DEFAULTS,
  MODEL_CATALOG_BASELINE_PROVIDER_IDS,
} from "./fixtures/model-catalog-baseline.js";

const MILLION = 1_000_000;

function currentPricing(provider: string, model: string) {
  const price = (
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ) =>
    provider === "claude-cli"
      ? priceClaudeCliInclusiveUsage(model, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        })
      : priceInclusiveUsage(provider, model, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        });
  const input = price(MILLION, 0, 0, 0);
  const output = price(0, MILLION, 0, 0);
  const cacheRead = price(MILLION, 0, MILLION, 0);
  const cacheWrite = price(MILLION, 0, 0, MILLION);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return { kind: "unknown" as const };
  }
  return {
    kind: "token-rates" as const,
    input: input.input,
    output: output.output,
    cacheRead: cacheRead.cacheRead,
    cacheWrite: cacheWrite.cacheWrite,
  };
}

function currentImageInput(
  provider: (typeof LLM_MODEL_CATALOGUE)[number]["provider"],
  model: string,
) {
  const capabilities = resolveAttachmentCapabilities({
    active: { provider, model, transport: transportForProvider(provider) },
    nowMs: 883_612_800_000,
    metadataMaxAgeMs: 86_400_000,
  });
  if (capabilities.images.enabled) return "supported" as const;
  if (provider === "openrouter") return "provider-metadata" as const;
  if (capabilities.images.reason === "unknown_model") return "unknown" as const;
  return "incompatible" as const;
}

describe("compiled model catalog baseline", () => {
  it("captures the current ordered menus, defaults, context behavior, image behavior, and prices", () => {
    const current = LLM_MODEL_CATALOGUE.map((provider) => ({
      provider: provider.provider,
      label: provider.label,
      ...(provider.hint === undefined ? {} : { hint: provider.hint }),
      defaultModel: provider.defaultModel,
      models: provider.models.map((model) => ({
        value: model.value,
        label: model.label,
        ...(model.hint === undefined ? {} : { hint: model.hint }),
        contextWindowTokens: contextWindowForModel(model.value, provider.provider),
        catalogContext:
          provider.provider === "qwen" && model.value === "qwen3.7-max"
            ? { kind: "unknown" as const }
            : {
                kind: "known" as const,
                tokens: contextWindowForModel(model.value, provider.provider),
              },
        imageInput: currentImageInput(provider.provider, model.value),
        pricing: currentPricing(provider.provider, model.value),
      })),
    }));

    expect(current).toEqual(MODEL_CATALOG_BASELINE);
    expect(current.map((entry) => entry.provider)).toEqual(MODEL_CATALOG_BASELINE_PROVIDER_IDS);
  });

  it("keeps bootstrap and background defaults compiled", () => {
    expect(resolveRuntimeConfig().llm.provider).toBe("anthropic");
    expect(COMPACT_MODEL_DEFAULTS).toEqual(MODEL_CATALOG_BASELINE_BACKGROUND_DEFAULTS);
  });

  it.each(MODEL_CATALOG_BASELINE_PROVIDER_IDS)(
    "accepts a synthetic custom model for %s without changing the menu",
    (provider) => {
      const model = "synthetic-custom-model";
      const config = resolveRuntimeConfig({
        llm: {
          provider,
          model,
          ...(isKeylessProvider(provider) ? {} : { apiKey: "synthetic-key" }),
        },
      });
      expect(config.llm.model).toBe(model);
      expect(config.contextWindowTokens).toBe(200_000);
      expect(
        LLM_MODEL_CATALOGUE.find((entry) => entry.provider === provider)?.models,
      ).not.toContainEqual(expect.objectContaining({ value: model }));
    },
  );

  it.each(MODEL_CATALOG_BASELINE_ASTRA_REFUSALS)(
    "keeps Astra refused for the %s connection",
    (provider) => {
      expect(() => resolveRuntimeConfig({ llm: { provider, model: "gpt-6-astra" } })).toThrow(
        "not enabled for this connection",
      );
    },
  );
});
