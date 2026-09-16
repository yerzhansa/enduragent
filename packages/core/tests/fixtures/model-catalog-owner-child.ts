import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  __openModelCatalogForTesting,
  type ModelCatalogRefreshOutcome,
} from "../../src/model-catalog-owner.js";
import { modelCatalogSelectorConfiguration } from "../../src/model-catalog.js";

const [
  mode,
  installationRoot,
  cacheDirectory,
  endpoint,
  nowValue,
  readyPath,
  releasePath,
  elapsedNowValue,
] = process.argv.slice(2);

if (
  mode === undefined ||
  installationRoot === undefined ||
  cacheDirectory === undefined ||
  endpoint === undefined ||
  nowValue === undefined
) {
  throw new Error("Missing model catalog child arguments");
}

const now = Number(nowValue);
if (!Number.isFinite(now)) throw new Error("Invalid child clock");
const elapsedNow =
  elapsedNowValue === undefined || elapsedNowValue === "" ? undefined : Number(elapsedNowValue);
if (elapsedNow !== undefined && !Number.isFinite(elapsedNow)) {
  throw new Error("Invalid child elapsed clock");
}

let afterAttemptClaim: (() => Promise<void>) | undefined;
if (mode === "pause-after-claim") {
  if (readyPath === undefined || releasePath === undefined)
    throw new Error("Missing child barriers");
  afterAttemptClaim = async () => {
    writeFileSync(readyPath, "ready\n");
    while (!existsSync(releasePath)) await delay(5);
  };
}

const catalog = __openModelCatalogForTesting(
  { cacheDirectory, installationRoot },
  {
    afterAttemptClaim,
    ...(elapsedNow === undefined ? {} : { elapsedNow: () => elapsedNow }),
    endpoint,
    now: () => now,
    requestTimeoutMs: 1_000,
  },
);

if (mode === "read") {
  process.stdout.write(`${catalog.current().revision}\n`);
  await catalog.shutdown();
} else if (mode === "select") {
  const selection = modelCatalogSelectorConfiguration(catalog.current());
  process.stdout.write(
    `${JSON.stringify({
      revision: selection.revision,
      providers: selection.providers.map((provider) => ({
        provider: provider.provider,
        models: provider.models.map((model) => model.value),
      })),
    })}\n`,
  );
  await catalog.shutdown();
} else {
  const lifecycle = await catalog.start();
  let outcome: ModelCatalogRefreshOutcome = {
    kind: "retained",
    reason: "not-owner",
    revision: catalog.current().revision,
  };
  if (lifecycle.kind === "owner") outcome = await catalog.refresh();
  if (mode === "refresh-and-hold") {
    if (readyPath === undefined || releasePath === undefined)
      throw new Error("Missing child barriers");
    writeFileSync(readyPath, "ready\n");
    while (!existsSync(releasePath)) await delay(5);
  }
  process.stdout.write(`${JSON.stringify({ lifecycle, outcome })}\n`);
  await catalog.shutdown();
}
