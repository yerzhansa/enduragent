import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelCatalogSnapshotSchema } from "../packages/coach-contract/src/model-catalog.js";
import { priceClaudeCliInclusiveUsage } from "../packages/engine/src/agent/claude-cli/cost.js";
import {
  resolveAttachmentCapabilities,
  transportForProvider,
} from "../packages/engine/src/attachment-capabilities.js";
import { priceInclusiveUsage } from "../packages/engine/src/usage-cost.js";
import { INSTALLED_MODEL_CATALOG_PROFILES } from "../packages/core/src/model-catalog-policy.js";
import {
  LLM_MODEL_CATALOGUE,
  knownContextWindowForModel,
} from "../packages/core/src/runtime-config.js";

const MILLION = 1_000_000;
const outputFile = fileURLToPath(
  new URL("../packages/core/src/model-catalog-seed.generated.ts", import.meta.url),
);

function pricing(provider: string, model: string) {
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
    inputUsdPerMillion: input.input,
    outputUsdPerMillion: output.output,
    cacheReadUsdPerMillion: cacheRead.cacheRead,
    cacheWriteUsdPerMillion: cacheWrite.cacheWrite,
  };
}

function imageInput(provider: (typeof LLM_MODEL_CATALOGUE)[number]["provider"], model: string) {
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

const snapshot = ModelCatalogSnapshotSchema.parse({
  schemaVersion: 1,
  revision: 1,
  provenance: { kind: "bundled-seed", establishedAt: "2026-09-13T00:00:00.000Z" },
  providers: LLM_MODEL_CATALOGUE.map((provider, providerOrder) => ({
    providerId: provider.provider,
    label: provider.label,
    order: providerOrder,
    ...(provider.hint === undefined ? {} : { hint: provider.hint }),
    recommendedModelId: provider.defaultModel,
    models: provider.models.map((model, modelOrder) => {
      const contextWindowTokens = knownContextWindowForModel(model.value);
      return {
        modelId: model.value,
        label: model.label,
        order: modelOrder,
        ...(model.hint === undefined ? {} : { hint: model.hint }),
        compatibilityProfile: INSTALLED_MODEL_CATALOG_PROFILES[provider.provider][0],
        contextWindow:
          contextWindowTokens === undefined
            ? { kind: "unknown" as const }
            : { kind: "known" as const, tokens: contextWindowTokens },
        imageInput: imageInput(provider.provider, model.value),
        pricing: pricing(provider.provider, model.value),
      };
    }),
  })),
});

const output = `export const GENERATED_MODEL_CATALOG_SEED = ${JSON.stringify(snapshot, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputFile, "utf8") !== output) process.exitCode = 1;
} else {
  writeFileSync(outputFile, output, "utf8");
}
