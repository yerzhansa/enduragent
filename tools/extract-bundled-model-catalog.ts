import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ModelCatalogSnapshotSchema,
  type ModelCatalogSnapshot,
} from "@enduragent/coach-contract/model-catalog";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  ASAR_BUNDLED_CATALOG_ENTRY,
  BUNDLED_MODEL_CATALOG_ARTIFACT,
  IMAGE_BUNDLED_CATALOG_ENTRY,
  NPM_BUNDLED_CATALOG_ENTRY,
} from "./bundled-model-catalog-artifact.js";
import {
  CatalogDigestSchema,
  type CatalogDigest,
  type ReleaseBinding,
} from "./model-catalog-release-pin.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
const MACOS_ASAR_ENTRY = "Enduragent.app/Contents/Resources/app.asar";
const WINDOWS_ASAR_SEGMENTS = ["resources", "app.asar"] as const;
const GHCR_NAMESPACE = "ghcr.io/yerzhansa";

export class BundledCatalogExtractError extends Error {
  constructor(
    readonly code: "unreadable" | "mismatch",
    message: string,
  ) {
    super(message);
    this.name = "BundledCatalogExtractError";
  }
}

export type ArtifactLocator =
  | { kind: "npm-tarball"; path: string }
  | {
      kind: "oci-image";
      reference: string;
      image: "cycling-coach" | "enduragent";
      platform: "linux/amd64" | "linux/arm64";
    }
  | { kind: "macos-zip"; path: string }
  | { kind: "windows-unpacked"; path: string };

export type ExtractedCatalog = Readonly<{
  artifact: ArtifactLocator;
  snapshot: ModelCatalogSnapshot;
  digest: CatalogDigest;
  revision: number;
}>;

export type DockerCommandRunner = (args: readonly string[]) => Promise<string>;

export type ExtractBundledCatalogOptions = {
  readonly docker?: DockerCommandRunner;
};

type AsarApi = {
  extractFile: (archivePath: string, filename: string, followLinks?: boolean) => Buffer;
  uncache: (archivePath: string) => boolean;
};

function isAsarModule(value: unknown): value is {
  extractFile: (archivePath: string, filename: string, followLinks?: boolean) => unknown;
  uncache: (archivePath: string) => unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "extractFile" in value &&
    "uncache" in value &&
    typeof value.extractFile === "function" &&
    typeof value.uncache === "function"
  );
}

function loadAsar(): AsarApi {
  const require = createRequire(
    fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url)),
  );
  const loaded: unknown = require("@electron/asar");
  if (!isAsarModule(loaded)) {
    throw new BundledCatalogExtractError("unreadable", "@electron/asar is unavailable");
  }
  return {
    extractFile: (archivePath, filename, followLinks) => {
      const bytes = loaded.extractFile(archivePath, filename, followLinks);
      if (!Buffer.isBuffer(bytes)) {
        throw new BundledCatalogExtractError("unreadable", "asar extract did not return bytes");
      }
      return bytes;
    },
    uncache: (archivePath) => Boolean(loaded.uncache(archivePath)),
  };
}

async function runUtf8(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BundledCatalogExtractError("unreadable", `${command} failed: ${detail}`);
  }
}

async function runBuffer(command: string, args: readonly string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: "buffer",
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BundledCatalogExtractError("unreadable", `${command} failed: ${detail}`);
  }
}

function defaultDocker(args: readonly string[]): Promise<string> {
  return runUtf8("docker", args);
}

async function catalogFromSealedBytes(
  bytes: Uint8Array,
  artifact: ArtifactLocator,
): Promise<ExtractedCatalog> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BundledCatalogExtractError("unreadable", "bundled catalog artifact is not JSON");
  }
  const snapshot = ModelCatalogSnapshotSchema.safeParse(parsed);
  if (!snapshot.success) {
    throw new BundledCatalogExtractError(
      "unreadable",
      "bundled catalog artifact is not a catalog snapshot",
    );
  }
  const digest = CatalogDigestSchema.parse((await sha256(jsonBytes(snapshot.data))).hex);
  return Object.freeze({
    artifact,
    snapshot: snapshot.data,
    digest,
    revision: snapshot.data.revision,
  });
}

function referenceMatchesImage(reference: string, image: "cycling-coach" | "enduragent"): boolean {
  const name = `${GHCR_NAMESPACE}/${image}`;
  return reference === name || reference.startsWith(`${name}:`) || reference.startsWith(`${name}@`);
}

async function extractNpmTarball(
  locator: Extract<ArtifactLocator, { kind: "npm-tarball" }>,
): Promise<ExtractedCatalog> {
  const source = await runBuffer("tar", ["-xOf", locator.path, NPM_BUNDLED_CATALOG_ENTRY]);
  return catalogFromSealedBytes(source, locator);
}

async function extractOciImage(
  locator: Extract<ArtifactLocator, { kind: "oci-image" }>,
  docker: DockerCommandRunner,
): Promise<ExtractedCatalog> {
  if (!referenceMatchesImage(locator.reference, locator.image)) {
    throw new BundledCatalogExtractError(
      "unreadable",
      "oci image reference does not match the declared image name",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "bundled-catalog-oci-"));
  const dest = join(directory, BUNDLED_MODEL_CATALOG_ARTIFACT);
  let containerId: string | undefined;
  try {
    containerId = (
      await docker(["create", "--platform", locator.platform, locator.reference])
    ).trim();
    if (containerId.length === 0) {
      throw new BundledCatalogExtractError(
        "unreadable",
        "docker create did not return a container id",
      );
    }
    await docker(["cp", `${containerId}:${IMAGE_BUNDLED_CATALOG_ENTRY}`, dest]);
    const source = await readFile(dest);
    return await catalogFromSealedBytes(source, locator);
  } finally {
    if (containerId !== undefined && containerId.length > 0) {
      await docker(["rm", containerId]).catch(() => undefined);
    }
    await rm(directory, { force: true, recursive: true });
  }
}

async function extractAsarCatalog(archivePath: string): Promise<Uint8Array> {
  const asar = loadAsar();
  try {
    return asar.extractFile(archivePath, ASAR_BUNDLED_CATALOG_ENTRY);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BundledCatalogExtractError("unreadable", `asar catalog entry is missing: ${detail}`);
  } finally {
    asar.uncache(archivePath);
  }
}

async function extractMacosZip(
  locator: Extract<ArtifactLocator, { kind: "macos-zip" }>,
): Promise<ExtractedCatalog> {
  const directory = await mkdtemp(join(tmpdir(), "bundled-catalog-macos-"));
  const asarPath = join(directory, "app.asar");
  try {
    const bytes = await runBuffer("unzip", ["-p", locator.path, MACOS_ASAR_ENTRY]);
    await writeFile(asarPath, bytes);
    return await catalogFromSealedBytes(await extractAsarCatalog(asarPath), locator);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function extractWindowsUnpacked(
  locator: Extract<ArtifactLocator, { kind: "windows-unpacked" }>,
): Promise<ExtractedCatalog> {
  const asarPath = join(locator.path, ...WINDOWS_ASAR_SEGMENTS);
  return catalogFromSealedBytes(await extractAsarCatalog(asarPath), locator);
}

export async function extractBundledCatalog(
  locator: ArtifactLocator,
  options: ExtractBundledCatalogOptions = {},
): Promise<ExtractedCatalog> {
  switch (locator.kind) {
    case "npm-tarball":
      return extractNpmTarball(locator);
    case "oci-image":
      return extractOciImage(locator, options.docker ?? defaultDocker);
    case "macos-zip":
      return extractMacosZip(locator);
    case "windows-unpacked":
      return extractWindowsUnpacked(locator);
    default: {
      const exhaustive: never = locator;
      throw exhaustive;
    }
  }
}

export function assertArtifactMatchesGroup(
  extracted: ExtractedCatalog,
  binding: ReleaseBinding,
): void {
  if (extracted.revision !== binding.revision) {
    throw new BundledCatalogExtractError(
      "mismatch",
      "artifact revision does not match the release group",
    );
  }
  if (extracted.digest !== binding.digest) {
    throw new BundledCatalogExtractError(
      "mismatch",
      "artifact digest does not match the release group",
    );
  }
}
