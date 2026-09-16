import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertArtifactMatchesGroup,
  extractBundledCatalog,
  type DockerCommandRunner,
} from "./extract-bundled-model-catalog.js";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import type { ModelCatalogPublicationFile } from "./model-catalog-publication.js";
import {
  CatalogDigestSchema,
  createMemoryReleasePinStore,
  MATERIALIZED_MODEL_CATALOG_SEED_PATH,
  materializeReleaseCatalog,
  prepareReleaseGroup,
  type PreparedRelease,
} from "./model-catalog-release-pin.js";

const SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACQUIRED_AT = "1998-09-14T10:00:00.000Z";
const SEED_ESTABLISHED_AT = "1998-01-01T00:00:00.000Z";
const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const TRACKED_SEED = fileURLToPath(
  new URL("../packages/core/src/model-catalog-seed.generated.ts", import.meta.url),
);
const OTHER_DIGEST = CatalogDigestSchema.parse("ab".repeat(32));
const IMAGES = ["cycling-coach", "enduragent"] as const;
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const desktopRequire = createRequire(
  fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url)),
);

function publicationFile(modelId: string): ModelCatalogPublicationFile {
  return {
    catalog: {
      schemaVersion: 1,
      providers: [
        {
          providerId: "openai",
          label: "Synthetic provider",
          order: 0,
          recommendedModelId: modelId,
          models: [
            {
              modelId,
              label: "Synthetic model",
              order: 0,
              compatibilityProfile: "openai-ai-sdk-v1",
              contextWindow: { kind: "known", tokens: 100_000 },
              imageInput: "supported",
              pricing: {
                kind: "token-rates",
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                cacheReadUsdPerMillion: 0.5,
                cacheWriteUsdPerMillion: 1.5,
              },
            },
          ],
        },
      ],
    },
    evidence: [
      {
        providerId: "openai",
        modelId,
        connections: [
          {
            connectionId: "api-key",
            textCall: { verifiedAt: VERIFIED_AT, reference: "record:text-call" },
            toolCall: { verifiedAt: VERIFIED_AT, reference: "record:tool-call" },
            imageCall: { verifiedAt: VERIFIED_AT, reference: "record:image-call" },
          },
        ],
        limitsSource: "https://example.com/models/synthetic/limits",
        pricingSource: "https://example.com/models/synthetic/pricing",
      },
    ],
  };
}

function seedSnapshot(modelId = "synthetic-seed") {
  return {
    schemaVersion: 1 as const,
    revision: 1,
    provenance: { kind: "bundled-seed" as const, establishedAt: SEED_ESTABLISHED_AT },
    providers: publicationFile(modelId).catalog.providers,
  };
}

function generatorWrapper(snapshot: unknown): string {
  return `export const GENERATED_MODEL_CATALOG_SEED = ${JSON.stringify(snapshot, null, 2)} as const;\n`;
}

type EsbuildBuildOptions = {
  absWorkingDir: string;
  entryPoints: string[];
  outfile: string;
  bundle: true;
  format: "esm";
  minify: false;
  write: true;
  logLevel: "silent";
};

function isEsbuildModule(
  value: unknown,
): value is { build: (options: EsbuildBuildOptions) => Promise<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "build" in value &&
    typeof value.build === "function"
  );
}

function isAsarCreateModule(
  value: unknown,
): value is { createPackage: (src: string, dest: string) => Promise<unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "createPackage" in value &&
    typeof value.createPackage === "function"
  );
}

function loadEsbuild(): {
  build: (options: EsbuildBuildOptions) => Promise<unknown>;
} {
  const loaded: unknown = desktopRequire("esbuild");
  if (!isEsbuildModule(loaded)) {
    throw new Error("esbuild is unavailable");
  }
  return { build: (options) => loaded.build(options) };
}

function loadAsarCreate(): {
  createPackage: (src: string, dest: string) => Promise<unknown>;
} {
  const loaded: unknown = desktopRequire("@electron/asar");
  if (!isAsarCreateModule(loaded)) {
    throw new Error("@electron/asar is unavailable");
  }
  return { createPackage: (src, dest) => loaded.createPackage(src, dest) };
}

function packTarball(directory: string, filename: string, javascript: string): string {
  const folder = join(directory, filename.replace(/\.tgz$/u, ""));
  mkdirSync(join(folder, "package/dist"), { recursive: true });
  writeFileSync(join(folder, "package/dist/index.js"), javascript);
  const path = join(directory, filename);
  execFileSync("tar", ["-czf", path, "package/dist/index.js"], { cwd: folder });
  return path;
}

function dockerShim(javascript: string): {
  docker: DockerCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let next = 0;
  const docker: DockerCommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "create") {
      next += 1;
      return `container-${next}\n`;
    }
    if (args[0] === "cp") {
      const spec = args[1];
      const dest = args[2];
      if (spec === undefined || dest === undefined) {
        throw new Error("docker cp requires a source and destination");
      }
      const file = spec.slice(spec.indexOf(":") + 1);
      if (file !== "/app/dist/index.js") {
        throw new Error(`docker cp must copy ${"/app/dist/index.js"}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, javascript);
      return "";
    }
    if (args[0] === "rm") return "";
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, calls };
}

describe("materialize and bundled catalog extract", () => {
  const trackedBefore = readFileSync(TRACKED_SEED);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "catalog-materialize-"));
  const artifactRoot = mkdtempSync(join(tmpdir(), "catalog-artifacts-"));
  let prepared: PreparedRelease;
  let bundledJavaScript: string;
  let asarPath: string;

  beforeAll(async () => {
    const materializedPath = resolve(join(workspaceRoot, MATERIALIZED_MODEL_CATALOG_SEED_PATH));
    if (materializedPath === resolve(TRACKED_SEED)) {
      throw new Error("test setup would dirty the tracked seed");
    }
    prepared = await prepareReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store: createMemoryReleasePinStore(),
      acquisitionTime: ACQUIRED_AT,
      seed: seedSnapshot(),
    });
    await materializeReleaseCatalog({ prepared, workspaceRoot });
    const sourceRoot = join(workspaceRoot, "packages/core/src");
    writeFileSync(
      join(sourceRoot, "bundle-entry.ts"),
      `export { GENERATED_MODEL_CATALOG_SEED } from "./model-catalog-seed.generated.ts";\n`,
    );
    await loadEsbuild().build({
      absWorkingDir: sourceRoot,
      entryPoints: ["bundle-entry.ts"],
      outfile: "bundled.js",
      bundle: true,
      format: "esm",
      minify: false,
      write: true,
      logLevel: "silent",
    });
    bundledJavaScript = readFileSync(join(sourceRoot, "bundled.js"), "utf8");
    if (!bundledJavaScript.includes("GENERATED_MODEL_CATALOG_SEED")) {
      throw new Error("minify:false bundle dropped GENERATED_MODEL_CATALOG_SEED");
    }
    const asarSource = join(artifactRoot, "asar-src");
    mkdirSync(join(asarSource, "node_modules/@enduragent/core/dist"), { recursive: true });
    writeFileSync(join(asarSource, "node_modules/@enduragent/core/dist/index.js"), bundledJavaScript);
    asarPath = join(artifactRoot, "app.asar");
    await loadAsarCreate().createPackage(asarSource, asarPath);
  });

  afterAll(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
    rmSync(artifactRoot, { force: true, recursive: true });
    expect(readFileSync(TRACKED_SEED).equals(trackedBefore)).toBe(true);
  });

  it("materialize writes the generator wrapper; read-back digest equals pin; second materialize is idempotent", async () => {
    const path = join(workspaceRoot, MATERIALIZED_MODEL_CATALOG_SEED_PATH);
    const first = readFileSync(path, "utf8");
    expect(first).toBe(generatorWrapper(prepared.snapshot));
    const firstDigest = CatalogDigestSchema.parse((await sha256(jsonBytes(prepared.snapshot))).hex);
    expect(firstDigest).toBe(prepared.record.digest);
    const before = statSync(path);
    const second = await materializeReleaseCatalog({ prepared, workspaceRoot });
    expect(second.digest).toBe(prepared.record.digest);
    expect(second.revision).toBe(prepared.record.revision);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });

  it("materialize does not change the git-tracked seed", () => {
    expect(readFileSync(TRACKED_SEED).equals(trackedBefore)).toBe(true);
    expect(resolve(join(workspaceRoot, MATERIALIZED_MODEL_CATALOG_SEED_PATH))).not.toBe(
      resolve(TRACKED_SEED),
    );
  });

  it("npm tarball package/dist/index.js extracts the same revision+digest for both package names", async () => {
    const cycling = packTarball(artifactRoot, "cycling-coach.tgz", bundledJavaScript);
    const alias = packTarball(artifactRoot, "enduragent.tgz", bundledJavaScript);
    expect(readFileSync(join(artifactRoot, "enduragent/package/dist/index.js"))).toEqual(
      readFileSync(join(artifactRoot, "cycling-coach/package/dist/index.js")),
    );
    for (const path of [cycling, alias]) {
      const extracted = await extractBundledCatalog({ kind: "npm-tarball", path });
      expect(extracted.revision).toBe(prepared.record.revision);
      expect(extracted.digest).toBe(prepared.record.digest);
      assertArtifactMatchesGroup(extracted, prepared.binding);
    }
  });

  it("macOS zip with Enduragent.app asar extracts the same digest from core dist", async () => {
    const appRoot = join(artifactRoot, "macos");
    mkdirSync(join(appRoot, "Enduragent.app/Contents/Resources"), { recursive: true });
    writeFileSync(join(appRoot, "Enduragent.app/Contents/Resources/app.asar"), readFileSync(asarPath));
    const zipPath = join(artifactRoot, "Enduragent-mac.zip");
    execFileSync("zip", ["-q", "-r", zipPath, "Enduragent.app"], { cwd: appRoot });
    const extracted = await extractBundledCatalog({ kind: "macos-zip", path: zipPath });
    expect(extracted.digest).toBe(prepared.record.digest);
    expect(extracted.revision).toBe(prepared.record.revision);
    assertArtifactMatchesGroup(extracted, prepared.binding);
  });

  it("windows-unpacked resources/app.asar extracts the same digest", async () => {
    const unpacked = join(artifactRoot, "windows-unpacked");
    mkdirSync(join(unpacked, "resources"), { recursive: true });
    writeFileSync(join(unpacked, "resources/app.asar"), readFileSync(asarPath));
    const extracted = await extractBundledCatalog({ kind: "windows-unpacked", path: unpacked });
    expect(extracted.digest).toBe(prepared.record.digest);
    expect(extracted.revision).toBe(prepared.record.revision);
    assertArtifactMatchesGroup(extracted, prepared.binding);
  });

  it("oci-image extract via docker shim for both GHCR names and both platforms", async () => {
    const { docker, calls } = dockerShim(bundledJavaScript);
    for (const image of IMAGES) {
      for (const platform of PLATFORMS) {
        const reference = `ghcr.io/yerzhansa/${image}:test`;
        const extracted = await extractBundledCatalog(
          { kind: "oci-image", reference, image, platform },
          { docker },
        );
        expect(extracted.digest).toBe(prepared.record.digest);
        expect(extracted.revision).toBe(prepared.record.revision);
        assertArtifactMatchesGroup(extracted, prepared.binding);
        expect(calls).toContainEqual(["create", "--platform", platform, reference]);
        expect(
          calls.some(
            (call) =>
              call[0] === "cp" &&
              typeof call[1] === "string" &&
              call[1].endsWith(":/app/dist/index.js"),
          ),
        ).toBe(true);
      }
    }
    expect(calls.filter((call) => call[0] === "create")).toHaveLength(4);
    expect(calls.filter((call) => call[0] === "rm")).toHaveLength(4);
  });

  it("assertArtifactMatchesGroup throws on revision mismatch and digest mismatch", async () => {
    const path = packTarball(artifactRoot, "assert-match.tgz", bundledJavaScript);
    const extracted = await extractBundledCatalog({ kind: "npm-tarball", path });
    try {
      assertArtifactMatchesGroup(extracted, {
        ...prepared.binding,
        revision: prepared.binding.revision + 1,
      });
      throw new Error("expected revision mismatch");
    } catch (error) {
      expect(error).toMatchObject({
        name: "BundledCatalogExtractError",
        code: "mismatch",
        message: "artifact revision does not match the release group",
      });
    }
    try {
      assertArtifactMatchesGroup(extracted, { ...prepared.binding, digest: OTHER_DIGEST });
      throw new Error("expected digest mismatch");
    } catch (error) {
      expect(error).toMatchObject({
        name: "BundledCatalogExtractError",
        code: "mismatch",
        message: "artifact digest does not match the release group",
      });
    }
  });

  it("unreadable artifact (zero catalogs, two different catalogs) fails", async () => {
    const empty = packTarball(artifactRoot, "empty-catalog.tgz", "export const unrelated = 1;\n");
    await expect(extractBundledCatalog({ kind: "npm-tarball", path: empty })).rejects.toMatchObject({
      name: "BundledCatalogExtractError",
      code: "unreadable",
    });

    const first = JSON.stringify(seedSnapshot("synthetic-a"), null, 2);
    const second = JSON.stringify({ ...seedSnapshot("synthetic-b"), revision: 2 }, null, 2);
    const mixed = packTarball(
      artifactRoot,
      "mixed-catalog.tgz",
      `var GENERATED_MODEL_CATALOG_SEED = ${first};\nvar GENERATED_MODEL_CATALOG_SEED = ${second};\n`,
    );
    await expect(extractBundledCatalog({ kind: "npm-tarball", path: mixed })).rejects.toMatchObject({
      name: "BundledCatalogExtractError",
      code: "unreadable",
    });

    const one = JSON.stringify(prepared.snapshot, null, 2);
    const duplicates = packTarball(
      artifactRoot,
      "duplicate-catalog.tgz",
      `var GENERATED_MODEL_CATALOG_SEED = ${one};\nvar GENERATED_MODEL_CATALOG_SEED = ${one};\n`,
    );
    const extracted = await extractBundledCatalog({ kind: "npm-tarball", path: duplicates });
    expect(extracted.digest).toBe(prepared.record.digest);
  });
});
