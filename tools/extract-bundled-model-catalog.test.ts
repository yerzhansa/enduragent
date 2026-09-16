import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMAGE_BUNDLED_CATALOG_ENTRY,
  NPM_BUNDLED_CATALOG_ENTRY,
  writeBundledCatalogArtifact,
} from "./bundled-model-catalog-artifact.js";
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

function loadAsarCreate(): {
  createPackage: (src: string, dest: string) => Promise<unknown>;
} {
  const loaded: unknown = desktopRequire("@electron/asar");
  if (!isAsarCreateModule(loaded)) {
    throw new Error("@electron/asar is unavailable");
  }
  return { createPackage: (src, dest) => loaded.createPackage(src, dest) };
}

function packTarball(
  directory: string,
  filename: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): string {
  const folder = join(directory, filename.replace(/\.tgz$/u, ""));
  const listed: string[] = [];
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(folder, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    listed.push(relative);
  }
  const path = join(directory, filename);
  execFileSync("tar", ["-czf", path, ...listed], { cwd: folder });
  return path;
}

function dockerShim(bytes: Uint8Array): {
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
      if (file !== IMAGE_BUNDLED_CATALOG_ENTRY) {
        throw new Error(`docker cp must copy ${IMAGE_BUNDLED_CATALOG_ENTRY}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
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
  let sealedBytes: Uint8Array;
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
    sealedBytes = jsonBytes(prepared.snapshot);
    const asarSource = join(artifactRoot, "asar-src");
    writeBundledCatalogArtifact(join(asarSource, "node_modules/@enduragent/core/dist"), prepared.snapshot);
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

  it("npm tarball sealed catalog extracts the same revision+digest for both package names", async () => {
    const files = {
      [NPM_BUNDLED_CATALOG_ENTRY]: sealedBytes,
      "package/dist/index.js": "export const GENERATED_MODEL_CATALOG_SEED = { revision: 99 };\n",
    };
    const cycling = packTarball(artifactRoot, "cycling-coach.tgz", files);
    const alias = packTarball(artifactRoot, "enduragent.tgz", files);
    expect(
      readFileSync(join(artifactRoot, "enduragent", NPM_BUNDLED_CATALOG_ENTRY)),
    ).toEqual(readFileSync(join(artifactRoot, "cycling-coach", NPM_BUNDLED_CATALOG_ENTRY)));
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
    const { docker, calls } = dockerShim(sealedBytes);
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
              call[1].endsWith(`:${IMAGE_BUNDLED_CATALOG_ENTRY}`),
          ),
        ).toBe(true);
      }
    }
    expect(calls.filter((call) => call[0] === "create")).toHaveLength(4);
    expect(calls.filter((call) => call[0] === "rm")).toHaveLength(4);
  });

  it("assertArtifactMatchesGroup throws on revision mismatch and digest mismatch", async () => {
    const path = packTarball(artifactRoot, "assert-match.tgz", {
      [NPM_BUNDLED_CATALOG_ENTRY]: sealedBytes,
    });
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

  it("unreadable artifact (missing, invalid JSON, non-catalog JSON) fails; JavaScript is ignored", async () => {
    const empty = packTarball(artifactRoot, "empty-catalog.tgz", {
      "package/dist/index.js": "export const GENERATED_MODEL_CATALOG_SEED = { revision: 1 };\n",
    });
    await expect(extractBundledCatalog({ kind: "npm-tarball", path: empty })).rejects.toMatchObject({
      name: "BundledCatalogExtractError",
      code: "unreadable",
    });

    const invalid = packTarball(artifactRoot, "invalid-catalog.tgz", {
      [NPM_BUNDLED_CATALOG_ENTRY]: "not-json",
    });
    await expect(extractBundledCatalog({ kind: "npm-tarball", path: invalid })).rejects.toMatchObject({
      name: "BundledCatalogExtractError",
      code: "unreadable",
    });

    const other = packTarball(artifactRoot, "other-json.tgz", {
      [NPM_BUNDLED_CATALOG_ENTRY]: `${JSON.stringify({ revision: 2 }, null, 2)}\n`,
    });
    await expect(extractBundledCatalog({ kind: "npm-tarball", path: other })).rejects.toMatchObject({
      name: "BundledCatalogExtractError",
      code: "unreadable",
    });

    const extracted = await extractBundledCatalog({
      kind: "npm-tarball",
      path: packTarball(artifactRoot, "js-mismatch.tgz", {
        [NPM_BUNDLED_CATALOG_ENTRY]: sealedBytes,
        "package/dist/index.js": `var GENERATED_MODEL_CATALOG_SEED = ${JSON.stringify(seedSnapshot("synthetic-b"))};\n`,
      }),
    });
    expect(extracted.digest).toBe(prepared.record.digest);
    expect(extracted.revision).toBe(prepared.record.revision);
  });
});
