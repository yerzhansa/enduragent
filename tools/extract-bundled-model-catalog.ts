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
  CatalogDigestSchema,
  type CatalogDigest,
  type ReleaseBinding,
} from "./model-catalog-release-pin.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
const NPM_ENTRY = "package/dist/index.js";
const IMAGE_ENTRY = "/app/dist/index.js";
const MACOS_ASAR_ENTRY = "Enduragent.app/Contents/Resources/app.asar";
const WINDOWS_ASAR_SEGMENTS = ["resources", "app.asar"] as const;
const CORE_DIST_ENTRY = "node_modules/@enduragent/core/dist/index.js";
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

function isAsarModule(
  value: unknown,
): value is {
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
  const require = createRequire(fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url)));
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

function sliceJsonObject(source: string, openBrace: number): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  throw new BundledCatalogExtractError("unreadable", "catalog object literal is truncated");
}

function assignedCatalogLiterals(source: string): string[] {
  const assignment = /\bGENERATED_MODEL_CATALOG_SEED\s*=\s*\{/gu;
  const literals: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(source)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const literal = sliceJsonObject(source, openBrace);
    literals.push(literal);
    assignment.lastIndex = openBrace + literal.length;
  }
  return literals;
}

async function catalogFromJavaScript(
  source: string,
  artifact: ArtifactLocator,
): Promise<ExtractedCatalog> {
  const literals = assignedCatalogLiterals(source);
  if (literals.length === 0) {
    throw new BundledCatalogExtractError("unreadable", "bundled catalog identifier was not found");
  }
  const unique = new Map<CatalogDigest, ModelCatalogSnapshot>();
  for (const literal of literals) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(literal);
    } catch {
      throw new BundledCatalogExtractError("unreadable", "bundled catalog object is not JSON");
    }
    const snapshot = ModelCatalogSnapshotSchema.safeParse(parsed);
    if (!snapshot.success) {
      throw new BundledCatalogExtractError("unreadable", "bundled catalog object is not a catalog snapshot");
    }
    const digest = CatalogDigestSchema.parse((await sha256(jsonBytes(snapshot.data))).hex);
    if (!unique.has(digest)) unique.set(digest, snapshot.data);
  }
  if (unique.size !== 1) {
    throw new BundledCatalogExtractError(
      "unreadable",
      "bundled JavaScript contains more than one catalog snapshot",
    );
  }
  for (const [digest, snapshot] of unique) {
    return Object.freeze({
      artifact,
      snapshot,
      digest,
      revision: snapshot.revision,
    });
  }
  throw new BundledCatalogExtractError("unreadable", "bundled catalog identifier was not found");
}

function referenceMatchesImage(
  reference: string,
  image: "cycling-coach" | "enduragent",
): boolean {
  const name = `${GHCR_NAMESPACE}/${image}`;
  return reference === name || reference.startsWith(`${name}:`) || reference.startsWith(`${name}@`);
}

async function extractNpmTarball(
  locator: Extract<ArtifactLocator, { kind: "npm-tarball" }>,
): Promise<ExtractedCatalog> {
  const source = await runUtf8("tar", ["-xOf", locator.path, NPM_ENTRY]);
  return catalogFromJavaScript(source, locator);
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
  const dest = join(directory, "index.js");
  let containerId: string | undefined;
  try {
    containerId = (await docker(["create", "--platform", locator.platform, locator.reference])).trim();
    if (containerId.length === 0) {
      throw new BundledCatalogExtractError("unreadable", "docker create did not return a container id");
    }
    await docker(["cp", `${containerId}:${IMAGE_ENTRY}`, dest]);
    const source = await readFile(dest, "utf8");
    return await catalogFromJavaScript(source, locator);
  } finally {
    if (containerId !== undefined && containerId.length > 0) {
      await docker(["rm", containerId]).catch(() => undefined);
    }
    await rm(directory, { force: true, recursive: true });
  }
}

async function extractAsarJavaScript(archivePath: string): Promise<string> {
  const asar = loadAsar();
  try {
    return asar.extractFile(archivePath, CORE_DIST_ENTRY).toString("utf8");
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
    const source = await extractAsarJavaScript(asarPath);
    return await catalogFromJavaScript(source, locator);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function extractWindowsUnpacked(
  locator: Extract<ArtifactLocator, { kind: "windows-unpacked" }>,
): Promise<ExtractedCatalog> {
  const asarPath = join(locator.path, ...WINDOWS_ASAR_SEGMENTS);
  const source = await extractAsarJavaScript(asarPath);
  return catalogFromJavaScript(source, locator);
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

export function assertArtifactMatchesGroup(extracted: ExtractedCatalog, binding: ReleaseBinding): void {
  if (extracted.revision !== binding.revision) {
    throw new BundledCatalogExtractError("mismatch", "artifact revision does not match the release group");
  }
  if (extracted.digest !== binding.digest) {
    throw new BundledCatalogExtractError("mismatch", "artifact digest does not match the release group");
  }
}
