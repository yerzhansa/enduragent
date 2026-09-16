import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import { NPM_BUNDLED_CATALOG_ENTRY } from "./bundled-model-catalog-artifact.js";
import {
  publicModelCatalogReleasePinError,
  runModelCatalogReleasePinCommand,
} from "./model-catalog-release-pin-command.js";
import {
  CatalogReleasePinError,
  MATERIALIZED_MODEL_CATALOG_SEED_PATH,
  createMemoryReleasePinStore,
} from "./model-catalog-release-pin.js";
import { BundledCatalogExtractError } from "./extract-bundled-model-catalog.js";
import type { ModelCatalogPublicationFile } from "./model-catalog-publication.js";

const SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW_ISO = "1998-09-14T10:00:00.000Z";
const SEED_ESTABLISHED_AT = "1998-01-01T00:00:00.000Z";
const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const TRACKED_SEED = fileURLToPath(
  new URL("../packages/core/src/model-catalog-seed.generated.ts", import.meta.url),
);
const COMMAND_SOURCE = readFileSync(
  fileURLToPath(new URL("./model-catalog-release-pin-command.ts", import.meta.url)),
  "utf8",
);
const CLI_SOURCE = readFileSync(
  fileURLToPath(new URL("./model-catalog-release-pin-cli.ts", import.meta.url)),
  "utf8",
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

function packTarball(directory: string, filename: string, snapshot: unknown): string {
  const folder = join(directory, filename.replace(/\.tgz$/u, ""));
  const relative = NPM_BUNDLED_CATALOG_ENTRY;
  mkdirSync(join(folder, "package/dist"), { recursive: true });
  writeFileSync(join(folder, relative), jsonBytes(snapshot));
  const path = join(directory, filename);
  execFileSync("tar", ["-czf", path, relative], { cwd: folder });
  return path;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runCaptured(
  args: readonly string[],
  extras: Parameters<typeof runModelCatalogReleasePinCommand>[1] = {},
): Promise<unknown> {
  const lines: string[] = [];
  await runModelCatalogReleasePinCommand(args, {
    ...extras,
    output: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

describe("model catalog release pin command", () => {
  it.each(["prepare", "read", "materialize", "extract"] as const)(
    "%s without --now-iso fails validation",
    async (verb) => {
      const args =
        verb === "extract"
          ? [verb, "--kind", "npm-tarball", "--path", "missing.tgz"]
          : [verb, "--source-commit", SOURCE_COMMIT];
      await expect(
        runModelCatalogReleasePinCommand(args, { output: () => undefined }),
      ).rejects.toMatchObject({
        code: "validation",
        message: "--now-iso is required",
      });
    },
  );

  it("rejects an invalid --now-iso", async () => {
    await expect(
      runModelCatalogReleasePinCommand(
        ["prepare", "--now-iso", "not-a-timestamp", "--source-commit", SOURCE_COMMIT],
        { output: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: "validation",
      message: "--now-iso is not a valid timestamp",
    });
  });

  it("rejects a duplicated --now-iso", async () => {
    await expect(
      runModelCatalogReleasePinCommand(
        ["prepare", "--now-iso", NOW_ISO, "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT],
        { output: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: "validation",
      message: "--now-iso may appear once",
    });
  });

  it("prepare prints the committed seed catalog and joins on retry", async () => {
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const digest = (await sha256(jsonBytes(seed))).hex;
    const extras = {
      store,
      seed,
    };
    const first = await runCaptured(
      ["prepare", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT],
      extras,
    );
    expect(first).toEqual({
      catalog: {
        releaseGroupId: SOURCE_COMMIT,
        revision: 1,
        digest,
      },
      kind: "bundled-seed",
      acquisition: "initial-seed",
    });
    const second = await runCaptured(
      ["prepare", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT],
      extras,
    );
    expect(second).toEqual(first);
  });

  it("read after prepare returns the same catalog and unknown commits are not-found", async () => {
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const extras = {
      store,
      seed,
    };
    const prepared = await runCaptured(
      ["prepare", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT],
      extras,
    );
    await expect(
      runCaptured(["read", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT], {
        store,
        seed,
      }),
    ).resolves.toEqual(prepared);
    await expect(
      runModelCatalogReleasePinCommand(
        ["read", "--now-iso", NOW_ISO, "--source-commit", OTHER_COMMIT],
        { store, seed, output: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: "not-found",
      message: "release group not found",
    });
  });

  it("materialize copies the seed into a temp workspace and leaves the tracked seed unchanged", async () => {
    const trackedBefore = readFileSync(TRACKED_SEED);
    const workspace = mkdtempSync(join(tmpdir(), "catalog-pin-cli-"));
    directories.push(workspace);
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const extras = {
      store,
      seed,
    };
    const prepared = (await runCaptured(
      ["prepare", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT],
      extras,
    )) as {
      catalog: { digest: string; revision: number };
    };
    const printed = await runCaptured(
      [
        "materialize",
        "--now-iso",
        NOW_ISO,
        "--source-commit",
        SOURCE_COMMIT,
        "--workspace",
        workspace,
      ],
      extras,
    );
    expect(printed).toMatchObject({
      catalog: prepared.catalog,
      path: MATERIALIZED_MODEL_CATALOG_SEED_PATH,
    });
    expect(readFileSync(join(workspace, MATERIALIZED_MODEL_CATALOG_SEED_PATH), "utf8")).toContain(
      `"revision": ${prepared.catalog.revision}`,
    );
    expect(readFileSync(TRACKED_SEED).equals(trackedBefore)).toBe(true);
  });

  it("extracts the bundled catalog from an npm tarball fixture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-pin-extract-"));
    directories.push(directory);
    const seed = seedSnapshot();
    const digest = (await sha256(jsonBytes(seed))).hex;
    const path = packTarball(directory, "cycling-coach.tgz", seed);
    const printed = await runCaptured([
      "extract",
      "--now-iso",
      NOW_ISO,
      "--kind",
      "npm-tarball",
      "--path",
      path,
    ]);
    expect(printed).toEqual({
      kind: "npm-tarball",
      digest,
      revision: 1,
    });
    const matched = await runCaptured([
      "extract",
      "--now-iso",
      NOW_ISO,
      "--kind",
      "npm-tarball",
      "--path",
      path,
      "--expected-release-group-id",
      SOURCE_COMMIT,
      "--expected-revision",
      "1",
      "--expected-digest",
      digest,
    ]);
    expect(matched).toEqual({
      catalog: {
        releaseGroupId: SOURCE_COMMIT,
        revision: 1,
        digest,
      },
      kind: "npm-tarball",
      digest,
      revision: 1,
    });
  });

  it("prepare writes catalog GitHub outputs without a wall clock", async () => {
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const digest = (await sha256(jsonBytes(seed))).hex;
    const outputs: Array<{ name: string; value: string }> = [];
    await runCaptured(["prepare", "--now-iso", NOW_ISO, "--source-commit", SOURCE_COMMIT], {
      store,
      seed,
      githubOutput: (name, value) => outputs.push({ name, value }),
    });
    expect(outputs).toEqual([
      { name: "catalog_release_group_id", value: SOURCE_COMMIT },
      { name: "catalog_revision", value: "1" },
      { name: "catalog_digest", value: digest },
      { name: "catalog_kind", value: "bundled-seed" },
      { name: "catalog_acquisition", value: "initial-seed" },
    ]);
  });

  it("maps pin and extract errors without leaking unknown payloads", () => {
    expect(
      publicModelCatalogReleasePinError(
        new CatalogReleasePinError("not-found", "release group not found"),
      ),
    ).toBe("not-found: release group not found");
    expect(
      publicModelCatalogReleasePinError(new BundledCatalogExtractError("unreadable", "missing")),
    ).toBe("unreadable: missing");
    expect(publicModelCatalogReleasePinError(new Error(JSON.stringify({ token: "secret" })))).toBe(
      "model catalog release pin command failed",
    );
  });

  it("command and CLI sources do not use wall-clock or random helpers", () => {
    for (const source of [COMMAND_SOURCE, CLI_SOURCE]) {
      expect(source).not.toMatch(/Date\.now/);
      expect(source).not.toMatch(/new Date\(/);
      expect(source).not.toMatch(/Math\.random/);
    }
  });

  it("loads the default seed from core source", () => {
    expect(COMMAND_SOURCE).toContain(
      'import { BUNDLED_MODEL_CATALOG } from "../packages/core/src/model-catalog-seed.js";',
    );
  });
});
