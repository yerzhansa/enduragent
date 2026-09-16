import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bytesEqual } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLIC_PATH,
} from "./model-catalog-constants.js";
import { CatalogPublicationError } from "./model-catalog-publication.js";

export const MODEL_CATALOG_ASSET_FILES = Object.freeze(["_headers", "models/v1/catalog.json"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function modelCatalogHeadersBytes(contentDigest: string): Uint8Array {
  if (!/^sha-256=:[A-Za-z0-9+/]{43}=?:$/u.test(contentDigest)) {
    throw new CatalogPublicationError("validation", "catalog Content-Digest is invalid");
  }
  const cacheControl = `public, max-age=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, s-maxage=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, no-transform`;
  return new TextEncoder().encode(
    `${MODEL_CATALOG_PUBLIC_PATH}\n  Cache-Control: ${cacheControl}\n  Content-Digest: ${contentDigest}\n  X-Content-Type-Options: nosniff\n`,
  );
}

export async function modelCatalogAssetInventory(directory: string): Promise<readonly string[]> {
  const visit = async (current: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await visit(join(current, entry.name), relative)));
      else if (entry.isFile()) files.push(relative);
      else
        throw new CatalogPublicationError("integrity", `asset ${relative} is not a regular file`);
    }
    return files.sort();
  };
  return visit(directory, "");
}

export async function assertExactModelCatalogAssetInventory(directory: string): Promise<void> {
  const inventory = await modelCatalogAssetInventory(directory);
  if (
    inventory.length !== MODEL_CATALOG_ASSET_FILES.length ||
    inventory.some((path, index) => path !== MODEL_CATALOG_ASSET_FILES[index])
  ) {
    throw new CatalogPublicationError("integrity", "model catalog asset inventory is not exact");
  }
}

export async function materializeModelCatalogAssets(input: {
  readonly directory: string;
  readonly catalogBytes: Uint8Array;
  readonly contentDigest: string;
}): Promise<void> {
  if (
    input.catalogBytes.byteLength <= 0 ||
    input.catalogBytes.byteLength > MODEL_CATALOG_MAX_BYTES
  ) {
    throw new CatalogPublicationError("validation", "catalog asset has an invalid size");
  }
  const before = await modelCatalogAssetInventory(input.directory);
  if (before.length !== 0) {
    throw new CatalogPublicationError("conflict", "catalog asset directory must be empty");
  }
  const catalogPath = join(input.directory, "models/v1/catalog.json");
  const headersPath = join(input.directory, "_headers");
  await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 });
  await writeFile(catalogPath, input.catalogBytes, { flag: "wx", mode: 0o600 });
  const headersBytes = modelCatalogHeadersBytes(input.contentDigest);
  await writeFile(headersPath, headersBytes, { flag: "wx", mode: 0o600 });
  await assertExactModelCatalogAssetInventory(input.directory);
  const [catalogReadBack, headersReadBack] = await Promise.all([
    readFile(catalogPath),
    readFile(headersPath),
  ]);
  if (
    !bytesEqual(catalogReadBack, input.catalogBytes) ||
    !bytesEqual(headersReadBack, headersBytes)
  ) {
    throw new CatalogPublicationError("integrity", "model catalog assets failed read-back");
  }
}
