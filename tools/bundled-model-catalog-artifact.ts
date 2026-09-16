import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonBytes } from "./model-catalog-bytes.js";

export const BUNDLED_MODEL_CATALOG_ARTIFACT = "bundled-model-catalog.json";
export const NPM_BUNDLED_CATALOG_ENTRY = `package/dist/${BUNDLED_MODEL_CATALOG_ARTIFACT}`;
export const IMAGE_BUNDLED_CATALOG_ENTRY = `/app/dist/${BUNDLED_MODEL_CATALOG_ARTIFACT}`;
export const ASAR_BUNDLED_CATALOG_ENTRY =
  `node_modules/@enduragent/core/dist/${BUNDLED_MODEL_CATALOG_ARTIFACT}`;

export function writeBundledCatalogArtifact(directory: string, snapshot: unknown): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, BUNDLED_MODEL_CATALOG_ARTIFACT);
  writeFileSync(path, jsonBytes(snapshot));
  return path;
}
