import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelCatalogSnapshotSchema } from "../packages/coach-contract/src/model-catalog.js";
import { LLM_MODEL_CATALOGUE } from "../packages/core/src/runtime-config.js";
import { GENERATED_MODEL_CATALOG_SEED } from "../packages/core/src/model-catalog-seed.generated.js";

const outputFile = fileURLToPath(
  new URL("../packages/core/src/model-catalog-seed.generated.ts", import.meta.url),
);
const visibleProviders = new Set<string>(LLM_MODEL_CATALOGUE.map((provider) => provider.provider));
const seedByProvider = new Map(
  GENERATED_MODEL_CATALOG_SEED.providers.map((provider) => [provider.providerId, provider]),
);

const providers = [
  ...LLM_MODEL_CATALOGUE.map((compiled, order) => {
    const previous = seedByProvider.get(compiled.provider);
    if (previous === undefined) {
      throw new Error(`bundled seed is missing compiled provider ${compiled.provider}`);
    }
    return {
      ...previous,
      label: compiled.label,
      order,
      ...(compiled.hint === undefined ? {} : { hint: compiled.hint }),
      recommendedModelId: compiled.defaultModel,
    };
  }),
  ...GENERATED_MODEL_CATALOG_SEED.providers.filter(
    (provider) => !visibleProviders.has(provider.providerId),
  ),
];

const snapshot = ModelCatalogSnapshotSchema.parse({
  ...GENERATED_MODEL_CATALOG_SEED,
  providers,
});

const formatted = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/oxfmt/bin/oxfmt", import.meta.url)),
    `--stdin-filepath=${outputFile}`,
  ],
  {
    input: `export const GENERATED_MODEL_CATALOG_SEED = ${JSON.stringify(snapshot, null, 2)} as const;\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (formatted.status !== 0) throw new Error(`oxfmt failed: ${formatted.stderr}`);
const output = formatted.stdout;
if (process.argv.includes("--check")) {
  if (readFileSync(outputFile, "utf8") !== output) process.exitCode = 1;
} else {
  writeFileSync(outputFile, output, "utf8");
}
