import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import {
  readAcceptedInstallationCatalog,
  resolveModelCatalogPaths,
} from "../src/model-catalog-owner.js";
import {
  BUNDLED_REVISION,
  FIRST_REMOTE_REVISION,
  mkdirSync,
  openCatalog,
  remoteCatalog,
  resetOwnerCatalogFixtures,
  tempDirectory,
  writeFileSync,
} from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog local snapshot selection", () => {
  it.each([
    {
      title: "synthetic-only higher revision",
      snapshot: syntheticCatalog(FIRST_REMOTE_REVISION),
    },
    {
      title: "single suggested provider at a higher revision",
      snapshot: collapsedCatalog(FIRST_REMOTE_REVISION),
    },
  ])("does not let a $title snapshot displace bundled", ({ snapshot }) => {
    const catalog = catalogWithPersisted({ owner: snapshot });

    expect(catalog.current()).toMatchObject({ origin: "bundled", revision: BUNDLED_REVISION });
    expect(
      catalog.current().effective.providers.find((provider) => provider.provider === "openai-codex"),
    ).toMatchObject({ kind: "suggested" });
  });

  it("still prefers a valid higher-revision installation snapshot", () => {
    const snapshot = remoteCatalog(FIRST_REMOTE_REVISION);
    const catalog = catalogWithPersisted({ owner: snapshot });

    expect(catalog.current()).toMatchObject({
      origin: "installation",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(
      catalog.current().effective.providers.find((provider) => provider.provider === "openai-codex"),
    ).toMatchObject({ kind: "suggested" });
    const openai = catalog.current().effective.providers.find(
      (provider) => provider.provider === "openai",
    );
    expect(openai).toMatchObject({ kind: "suggested" });
    if (openai?.kind !== "suggested") throw new Error("OpenAI is not suggested");
    expect(openai.models.map((model) => model.modelId)).toContain(
      `new-model-${FIRST_REMOTE_REVISION}`,
    );
  });

  it("still prefers installation over private-cache at equal revision", () => {
    const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
    const catalog = catalogWithPersisted({
      owner: snapshot,
      ownerRefreshedAt: "1998-01-01T00:00:00.000Z",
      privateCache: snapshot,
      privateRefreshedAt: "1998-01-02T00:00:00.000Z",
    });

    expect(catalog.current()).toMatchObject({
      origin: "installation",
      revision: BUNDLED_REVISION,
      lastSuccessfulRefreshAt: "1998-01-01T00:00:00.000Z",
    });
  });

  it("still prefers private-cache over bundled at equal revision", () => {
    const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
    const catalog = catalogWithPersisted({
      privateCache: snapshot,
      privateRefreshedAt: "1998-01-01T00:00:00.000Z",
    });

    expect(catalog.current()).toMatchObject({
      origin: "private-cache",
      revision: BUNDLED_REVISION,
    });
  });

  it.each([
    { title: "synthetic-only", snapshot: syntheticCatalog(FIRST_REMOTE_REVISION) },
    { title: "collapsed", snapshot: collapsedCatalog(FIRST_REMOTE_REVISION) },
  ])("does not expose a $title installation snapshot to direct catalog readers", ({ snapshot }) => {
    const installationRoot = tempDirectory("catalog-junk-read-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-junk-read-cache-"),
      installationRoot,
    });
    mkdirSync(paths.installationDirectory, { recursive: true });
    writePersisted(paths.ownerSnapshot, snapshot);

    expect(readAcceptedInstallationCatalog(installationRoot)).toBeUndefined();
  });
});

function catalogWithPersisted(input: {
  readonly owner?: unknown;
  readonly ownerRefreshedAt?: string;
  readonly privateCache?: unknown;
  readonly privateRefreshedAt?: string;
}) {
  const installationRoot = tempDirectory("catalog-selection-");
  const cacheDirectory = tempDirectory("catalog-selection-cache-");
  const paths = resolveModelCatalogPaths({ cacheDirectory, installationRoot });
  mkdirSync(paths.privateDirectory, { recursive: true });
  mkdirSync(paths.installationDirectory, { recursive: true });
  if (input.privateCache !== undefined) {
    writePersisted(paths.privateSnapshot, input.privateCache, input.privateRefreshedAt);
  }
  if (input.owner !== undefined) {
    writePersisted(paths.ownerSnapshot, input.owner, input.ownerRefreshedAt);
  }
  return openCatalog({
    cacheDirectory,
    endpoint: "http://127.0.0.1:1/unreachable",
    installationRoot,
  });
}

function writePersisted(path: string, snapshot: unknown, lastSuccessfulRefreshAt?: string) {
  writeFileSync(
    path,
    `${JSON.stringify({
      formatVersion: 1,
      etag: '"selection-test"',
      ...(lastSuccessfulRefreshAt === undefined ? {} : { lastSuccessfulRefreshAt }),
      snapshot,
    })}\n`,
  );
}

function syntheticCatalog(revision: number) {
  return {
    schemaVersion: 1,
    revision,
    provenance: { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" },
    providers: [
      {
        providerId: "synthetic",
        label: "Synthetic",
        order: 0,
        recommendedModelId: "synthetic-model",
        models: [
          {
            modelId: "synthetic-model",
            label: "Synthetic Model",
            order: 0,
            compatibilityProfile: "synthetic-v1",
            contextWindow: { kind: "unknown" },
            imageInput: "unknown",
            pricing: { kind: "unknown" },
          },
        ],
      },
    ],
  };
}

function collapsedCatalog(revision: number) {
  const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
  snapshot.revision = revision;
  snapshot.provenance = { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" };
  snapshot.providers = snapshot.providers.filter((provider) => provider.providerId === "openai");
  return snapshot;
}
