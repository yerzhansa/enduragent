import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelCatalogSnapshotSchema } from "../packages/coach-contract/src/model-catalog.js";
import { INSTALLED_MODEL_CATALOG_PROFILES } from "../packages/core/src/model-catalog-policy.js";
import { LLM_MODEL_CATALOGUE } from "../packages/core/src/runtime-config.js";
import { GENERATED_MODEL_CATALOG_SEED } from "../packages/core/src/model-catalog-seed.generated.js";
const outputFile = fileURLToPath(
  new URL("../packages/core/src/model-catalog-seed.generated.ts", import.meta.url),
);
const visibleProviders = new Set<string>(LLM_MODEL_CATALOGUE.map((provider) => provider.provider));

const snapshot = ModelCatalogSnapshotSchema.parse({
  schemaVersion: 1,
  revision: 1,
  provenance: { kind: "bundled-seed", establishedAt: "2026-09-13T00:00:00.000Z" },
  providers: [
    ...LLM_MODEL_CATALOGUE.map((provider, providerOrder) => ({
      providerId: provider.provider,
      label: provider.label,
      order: providerOrder,
      ...(provider.hint === undefined ? {} : { hint: provider.hint }),
      recommendedModelId: provider.defaultModel,
      models: provider.models.map((model, modelOrder) => {
        const previous = GENERATED_MODEL_CATALOG_SEED.providers
          .find((candidate) => candidate.providerId === provider.provider)
          ?.models.find((candidate) => candidate.modelId === model.value);
        return {
          modelId: model.value,
          label: model.label,
          order: modelOrder,
          ...(model.hint === undefined ? {} : { hint: model.hint }),
          compatibilityProfile: INSTALLED_MODEL_CATALOG_PROFILES[provider.provider][0],
          contextWindow: previous?.contextWindow ?? { kind: "unknown" as const },
          imageInput: previous?.imageInput ?? ("unknown" as const),
          pricing: previous?.pricing ?? { kind: "unknown" as const },
        };
      }),
    })),
    ...GENERATED_MODEL_CATALOG_SEED.providers.filter(
      (provider) => !visibleProviders.has(provider.providerId),
    ),
  ],
});

const output = `export const GENERATED_MODEL_CATALOG_SEED = ${JSON.stringify(snapshot, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputFile, "utf8") !== output) process.exitCode = 1;
} else {
  writeFileSync(outputFile, output, "utf8");
}
