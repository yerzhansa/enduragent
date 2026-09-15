import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  modelCatalogDeploymentMessage,
  modelCatalogDeploymentTag,
} from "./model-catalog-cloudflare.js";
import {
  MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
  MODEL_CATALOG_PUBLIC_URL,
} from "./model-catalog-constants.js";
import {
  ModelCatalogDeploymentReceiptSchema,
  buildModelCatalogPublicationRecord,
  type ModelCatalogDeploymentReceipt,
  type ModelCatalogPublicationFile,
  type ModelCatalogPublicationRecord,
} from "./model-catalog-publication.js";
import {
  BundledSeedReleaseGroupRecordSchema,
  BundledSeedReleasePinSchema,
  BundledSeedSnapshotSchema,
  CatalogDigestSchema,
  CatalogReleasePinError,
  PublishedReleasePinSchema,
  PublishedSnapshotSchema,
  createMemoryReleasePinStore,
  prepareReleaseGroup,
  readReleaseGroup,
  retainProductionCatalog,
  type BundledSeedReleasePin,
  type ModelCatalogProductionFetch,
  type ModelCatalogProductionFetchResult,
  type PrepareReleaseGroupInput,
  type PreparedRelease,
  type PublishedReleasePin,
  type ReadReleaseGroupInput,
  type ReleasePinStore,
  type RetainedProductionBundle,
} from "./model-catalog-release-pin.js";

const SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACQUIRED_AT = "1998-09-14T10:00:00.000Z";
const LATER_ACQUIRED_AT = "1998-09-14T12:00:00.000Z";
const SEED_ESTABLISHED_AT = "1998-01-01T00:00:00.000Z";
const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const PUBLISHED_AT_MS = Date.parse("1998-09-14T09:00:00.000Z");
const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("./model-catalog-release-pin.ts", import.meta.url)),
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

function inadmissibleProviders(modelId: string) {
  return publicationFile(modelId).catalog.providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      compatibilityProfile: "future-profile-v2",
    })),
  }));
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return (await sha256(bytes)).hex;
}

async function publishedFixture(revision: number, modelId: string) {
  const record = await buildModelCatalogPublicationRecord({
    publicationFile: publicationFile(modelId),
    revision,
    previousRevision: revision - 1,
    now: PUBLISHED_AT_MS + revision * 1_000,
  });
  const bytes = jsonBytes(record.catalog);
  const etag = `"etag-production-${revision}"`;
  const receipt = ModelCatalogDeploymentReceiptSchema.parse({
    formatVersion: MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
    target: "production",
    revision: record.revision,
    catalogDigest: record.catalogDigest,
    workerName: "enduragent-model-catalog",
    versionId: `version-${revision}`,
    deploymentId: `deployment-${revision}`,
    liveEtag: etag,
    verifiedAt: "1998-09-14T08:30:00.000Z",
    tag: modelCatalogDeploymentTag(record.revision, record.catalogDigest),
    message: modelCatalogDeploymentMessage(record.revision, record.catalogDigest),
    uncertaintyRecovery: "none",
  });
  return { record, receipt, snapshot: record.catalog, bytes, etag, digest: record.catalogDigest };
}

function trackingFetch(
  result:
    | ModelCatalogProductionFetchResult
    | (() => ModelCatalogProductionFetchResult | Promise<ModelCatalogProductionFetchResult>),
) {
  const urls: string[] = [];
  const fetch: ModelCatalogProductionFetch = async (url) => {
    urls.push(url);
    return typeof result === "function" ? await result() : result;
  };
  return { fetch, urls };
}

function unavailableFetch() {
  return trackingFetch({ kind: "unavailable" });
}

function overlayStore(store: ReleasePinStore, overlay: Partial<ReleasePinStore>): ReleasePinStore {
  return {
    createGroup: (input) => store.createGroup(input),
    readGroup: (releaseGroupId) => store.readGroup(releaseGroupId),
    putBytes: (input) => store.putBytes(input),
    getBytes: (digest) => store.getBytes(digest),
    putRetainedRevision: (bundle) => store.putRetainedRevision(bundle),
    getRetainedRevision: (revision) => store.getRetainedRevision(revision),
    listRetainedRevisions: () => store.listRetainedRevisions(),
    ...overlay,
  };
}

async function plantRetained(
  store: ReleasePinStore,
  input: {
    readonly record: ModelCatalogPublicationRecord;
    readonly receipt: ModelCatalogDeploymentReceipt;
    readonly catalogBytes: Uint8Array;
  },
): Promise<RetainedProductionBundle> {
  const recordBytes = jsonBytes(input.record);
  const receiptBytes = jsonBytes(input.receipt);
  const bundle: RetainedProductionBundle = {
    revision: input.record.revision,
    catalogDigest: CatalogDigestSchema.parse(await digestHex(input.catalogBytes)),
    publicationRecordDigest: CatalogDigestSchema.parse(await digestHex(recordBytes)),
    productionReceiptDigest: CatalogDigestSchema.parse(await digestHex(receiptBytes)),
    catalogBytes: input.catalogBytes,
    recordBytes,
    receiptBytes,
  };
  await store.putBytes({ digest: bundle.catalogDigest, bytes: bundle.catalogBytes });
  await store.putBytes({ digest: bundle.publicationRecordDigest, bytes: bundle.recordBytes });
  await store.putBytes({ digest: bundle.productionReceiptDigest, bytes: bundle.receiptBytes });
  await store.putRetainedRevision(bundle);
  return bundle;
}

async function retainFixture(
  store: ReleasePinStore,
  revision: number,
  modelId: string,
) {
  const fixture = await publishedFixture(revision, modelId);
  await retainProductionCatalog({ store, record: fixture.record, receipt: fixture.receipt });
  return fixture;
}

function requirePublished(prepared: PreparedRelease) {
  expect(prepared.record.kind).toBe("published");
  if (prepared.record.kind !== "published") {
    throw new Error("expected published pin");
  }
  return {
    record: prepared.record,
    snapshot: PublishedSnapshotSchema.parse(prepared.snapshot),
    bytes: prepared.bytes,
    binding: prepared.binding,
  };
}

function requireSeed(prepared: PreparedRelease) {
  expect(prepared.record.kind).toBe("bundled-seed");
  if (prepared.record.kind !== "bundled-seed") {
    throw new Error("expected bundled-seed pin");
  }
  return {
    record: prepared.record,
    snapshot: BundledSeedSnapshotSchema.parse(prepared.snapshot),
    bytes: prepared.bytes,
    binding: prepared.binding,
  };
}

function prepareInput(input: {
  readonly store: ReleasePinStore;
  readonly fetch: ModelCatalogProductionFetch;
  readonly sourceCommit?: string;
  readonly acquisitionTime?: string;
  readonly seed?: unknown;
}): PrepareReleaseGroupInput {
  return {
    sourceCommit: input.sourceCommit ?? SOURCE_COMMIT,
    store: input.store,
    fetch: input.fetch,
    acquisitionTime: input.acquisitionTime ?? ACQUIRED_AT,
    seed: input.seed ?? seedSnapshot(),
  };
}

describe("model catalog release pin", () => {
  it("prepare fetches once, seals published+production-fetch, digest equals sha256(jsonBytes(snapshot))", async () => {
    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const prepared = requirePublished(await prepareReleaseGroup(prepareInput({ store, fetch })));
    const expectedDigest = await digestHex(jsonBytes(prepared.snapshot));

    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(prepared.record.acquisition).toBe("production-fetch");
    expect(prepared.record.revision).toBe(2);
    expect(prepared.record.digest).toBe(fixture.digest);
    expect(prepared.record.digest).toBe(expectedDigest);
    expect(prepared.record.acquiredAt).toBe(ACQUIRED_AT);
    expect(prepared.record.publishedAt).toBe(fixture.record.publishedAt);
    expect(prepared.record.catalogAgeMs).toBe(
      Date.parse(ACQUIRED_AT) - Date.parse(fixture.record.publishedAt),
    );
    expect(prepared.record.publicationRecordDigest).toBe(await digestHex(jsonBytes(fixture.record)));
    expect(prepared.record.productionReceiptDigest).toBe(await digestHex(jsonBytes(fixture.receipt)));
    expect(prepared.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(prepared.snapshot.provenance).toEqual({
      kind: "published",
      publishedAt: fixture.record.publishedAt,
    });
    expect(prepared.binding).toEqual({
      releaseGroupId: SOURCE_COMMIT,
      revision: 2,
      digest: fixture.digest,
    });
    expect("seedEstablishedAt" in prepared.record).toBe(false);
  });

  it("existing group: second prepare returns same record, fetch count stays 1 (retry)", async () => {
    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const first = await prepareReleaseGroup(prepareInput({ store, fetch }));
    const second = await prepareReleaseGroup(
      prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT }),
    );

    expect(urls).toHaveLength(1);
    expect(second.record).toEqual(first.record);
    expect(second.record.acquiredAt).toBe(ACQUIRED_AT);
    expect(second.binding.digest).toBe(first.binding.digest);
  });

  it("main-commit then tag-trigger (same SHA) joins; tag-trigger then main-commit joins; one fetch total (trigger reordering)", async () => {
    async function join(firstTrigger: string, secondTrigger: string) {
      const store = createMemoryReleasePinStore();
      const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
      const { fetch, urls } = trackingFetch({
        kind: "response",
        etag: fixture.etag,
        bytes: fixture.bytes,
      });
      const base = prepareInput({ store, fetch });
      const first = await prepareReleaseGroup({ ...base, ...{ trigger: firstTrigger } });
      const second = await prepareReleaseGroup({ ...base, ...{ trigger: secondTrigger } });
      expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
      expect(second.record.releaseGroupId).toBe(first.record.releaseGroupId);
      expect(second.record.digest).toBe(first.record.digest);
      expect(second.record).toEqual(first.record);
    }

    await join("main-commit", "tag-trigger");
    await join("tag-trigger", "main-commit");
  });

  it("fetch unavailable → highest retained production revision; catalogAgeMs equals injected acquiredAt minus retained publishedAt", async () => {
    const store = createMemoryReleasePinStore();
    const older = await retainFixture(store, 2, "synthetic-text-tool-image");
    const newest = await retainFixture(store, 4, "synthetic-text-tool-image-v4");
    const { fetch, urls } = unavailableFetch();
    const prepared = await prepareReleaseGroup(
      prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT }),
    );

    const published = requirePublished(prepared);
    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(published.record.acquisition).toBe("retained-production");
    expect(published.record.revision).toBe(4);
    expect(published.record.digest).toBe(newest.digest);
    expect(published.record.publishedAt).toBe(newest.record.publishedAt);
    expect(published.record.acquiredAt).toBe(LATER_ACQUIRED_AT);
    expect(published.record.catalogAgeMs).toBe(
      Date.parse(LATER_ACQUIRED_AT) - Date.parse(newest.record.publishedAt),
    );
    expect(published.record.digest).not.toBe(older.digest);
  });

  it("fetch unavailable and no retained → bundled-seed; seedEstablishedAt present; JSON/schema of seed pin has no catalogAgeMs key", async () => {
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const { fetch, urls } = unavailableFetch();
    const prepared = requireSeed(await prepareReleaseGroup(prepareInput({ store, fetch, seed })));
    const sealed = JSON.parse(new TextDecoder().decode(jsonBytes(prepared.record)));
    if (typeof sealed !== "object" || sealed === null) {
      throw new Error("expected sealed pin object");
    }

    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(prepared.record.acquisition).toBe("initial-seed");
    expect(prepared.record.revision).toBe(1);
    expect(prepared.record.digest).toBe(await digestHex(jsonBytes(seed)));
    expect(prepared.record.acquiredAt).toBe(ACQUIRED_AT);
    expect(prepared.record.seedEstablishedAt).toBe(SEED_ESTABLISHED_AT);
    expect(prepared.snapshot.provenance).toEqual({
      kind: "bundled-seed",
      establishedAt: SEED_ESTABLISHED_AT,
    });
    expect(Object.hasOwn(sealed, "catalogAgeMs")).toBe(false);
    expect(Object.hasOwn(sealed, "publishedAt")).toBe(false);
    expect(Object.hasOwn(sealed, "publicationRecordDigest")).toBe(false);
    expect(Object.hasOwn(sealed, "productionReceiptDigest")).toBe(false);
    expect(Object.hasOwn(sealed, "seedEstablishedAt")).toBe(true);
    expect(BundledSeedReleaseGroupRecordSchema.safeParse(sealed).success).toBe(true);
  });

  it("invalid remote (schema-invalid, bundled-seed provenance, admission failure, staging receipt, mismatched etag/tag/message/digest/publishedAt) each falls back; none sealed as production-fetch", async () => {
    const seed = seedSnapshot();
    const valid = await publishedFixture(2, "synthetic-text-tool-image");
    const other = await publishedFixture(2, "synthetic-mismatch");
    const cases: Array<{
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly etag: string;
      readonly receipt?: ModelCatalogDeploymentReceipt;
      readonly record?: ModelCatalogPublicationRecord;
      readonly catalogBytes?: Uint8Array;
    }> = [
      {
        name: "schema-invalid",
        bytes: jsonBytes({ not: "a catalog" }),
        etag: valid.etag,
      },
      {
        name: "bundled-seed provenance",
        bytes: jsonBytes(seed),
        etag: valid.etag,
      },
      {
        name: "admission failure",
        bytes: jsonBytes({
          schemaVersion: 1,
          revision: 2,
          provenance: { kind: "published", publishedAt: valid.record.publishedAt },
          providers: inadmissibleProviders("synthetic-text-tool-image"),
        }),
        etag: valid.etag,
        record: valid.record,
        receipt: valid.receipt,
        catalogBytes: valid.bytes,
      },
      {
        name: "staging receipt",
        bytes: valid.bytes,
        etag: valid.etag,
        record: valid.record,
        receipt: ModelCatalogDeploymentReceiptSchema.parse({ ...valid.receipt, target: "staging" }),
        catalogBytes: valid.bytes,
      },
      {
        name: "mismatched etag",
        bytes: valid.bytes,
        etag: `"etag-other"`,
        record: valid.record,
        receipt: valid.receipt,
        catalogBytes: valid.bytes,
      },
      {
        name: "mismatched tag",
        bytes: valid.bytes,
        etag: valid.etag,
        record: valid.record,
        receipt: ModelCatalogDeploymentReceiptSchema.parse({
          ...valid.receipt,
          tag: "model-catalog-wrong-tag",
        }),
        catalogBytes: valid.bytes,
      },
      {
        name: "mismatched message",
        bytes: valid.bytes,
        etag: valid.etag,
        record: valid.record,
        receipt: ModelCatalogDeploymentReceiptSchema.parse({
          ...valid.receipt,
          message: "wrong deployment message",
        }),
        catalogBytes: valid.bytes,
      },
      {
        name: "mismatched digest",
        bytes: other.bytes,
        etag: valid.etag,
        record: valid.record,
        receipt: valid.receipt,
        catalogBytes: valid.bytes,
      },
      {
        name: "mismatched publishedAt",
        bytes: jsonBytes({
          ...valid.snapshot,
          provenance: { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" },
        }),
        etag: valid.etag,
        record: valid.record,
        receipt: valid.receipt,
        catalogBytes: valid.bytes,
      },
    ];

    for (const testCase of cases) {
      const store = createMemoryReleasePinStore();
      if (
        testCase.record !== undefined &&
        testCase.receipt !== undefined &&
        testCase.catalogBytes !== undefined
      ) {
        await plantRetained(store, {
          record: testCase.record,
          receipt: testCase.receipt,
          catalogBytes: testCase.catalogBytes,
        });
      }
      const { fetch } = trackingFetch({
        kind: "response",
        etag: testCase.etag,
        bytes: testCase.bytes,
      });
      const prepared = await prepareReleaseGroup(prepareInput({ store, fetch, seed }));
      expect(prepared.record.acquisition, testCase.name).not.toBe("production-fetch");
    }
  });

  it("corrupt highest retained skipped; next revision or seed used", async () => {
    const garbage = new TextEncoder().encode("{not-json");
    const garbageDigest = CatalogDigestSchema.parse(await digestHex(garbage));
    const corruptBundle = {
      revision: 9,
      catalogDigest: garbageDigest,
      publicationRecordDigest: garbageDigest,
      productionReceiptDigest: garbageDigest,
      catalogBytes: garbage,
      recordBytes: garbage,
      receiptBytes: garbage,
    };

    const withNext = createMemoryReleasePinStore();
    const valid = await retainFixture(withNext, 2, "synthetic-text-tool-image");
    await withNext.putRetainedRevision(corruptBundle);
    const nextFetch = unavailableFetch();
    const nextPrepared = requirePublished(
      await prepareReleaseGroup(prepareInput({ store: withNext, fetch: nextFetch.fetch })),
    );
    expect(nextPrepared.record.acquisition).toBe("retained-production");
    expect(nextPrepared.record.revision).toBe(2);
    expect(nextPrepared.record.digest).toBe(valid.digest);

    const seedOnly = createMemoryReleasePinStore();
    await seedOnly.putRetainedRevision(corruptBundle);
    const seed = seedSnapshot("synthetic-seed-fallback");
    const seedFetch = unavailableFetch();
    const seedPrepared = requireSeed(
      await prepareReleaseGroup(
        prepareInput({ store: seedOnly, fetch: seedFetch.fetch, seed }),
      ),
    );
    expect(seedPrepared.record.acquisition).toBe("initial-seed");
    expect(seedPrepared.record.digest).toBe(await digestHex(jsonBytes(seed)));
  });

  it("two concurrent prepares: one group; loser adopts winner; both return winner digest", async () => {
    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const urls: string[] = [];
    let started = 0;
    let releaseBoth: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const fetch: ModelCatalogProductionFetch = async (url) => {
      urls.push(url);
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      return { kind: "response", etag: fixture.etag, bytes: fixture.bytes };
    };
    const [left, right] = await Promise.all([
      prepareReleaseGroup(prepareInput({ store, fetch, acquisitionTime: ACQUIRED_AT })),
      prepareReleaseGroup(prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT })),
    ]);

    expect(left.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(right.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(left.record.digest).toBe(fixture.digest);
    expect(right.record.digest).toBe(left.record.digest);
    expect(left.record).toEqual(right.record);
    expect(await store.readGroup(SOURCE_COMMIT)).toBeDefined();
    expect(urls).toHaveLength(2);
  });

  it("readReleaseGroup never invokes fetch (type-level and runtime: pass a fetch spy only to prepare)", async () => {
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("fetch");
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("acquisitionTime");
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("authority");
    expectTypeOf<keyof ReadReleaseGroupInput>().toEqualTypeOf<"sourceCommit" | "store" | "seed">();
    expectTypeOf<PrepareReleaseGroupInput>().toHaveProperty("fetch");
    expectTypeOf(readReleaseGroup).parameter(0).not.toHaveProperty("fetch");

    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const prepared = await prepareReleaseGroup(prepareInput({ store, fetch }));
    const read = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store,
      seed: seedSnapshot(),
    });

    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(read.record).toEqual(prepared.record);
    expect(read.binding.digest).toBe(prepared.binding.digest);
  });

  it("published group with missing/corrupt bytes: recover same digest from retained production bundle; if that also fails, throw unrecoverable; a subsequent prepare does not fetch a replacement (broken, not absent)", async () => {
    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const prepared = await prepareReleaseGroup(prepareInput({ store, fetch }));
    expect(urls).toHaveLength(1);

    const missingCatalog = overlayStore(store, {
      getBytes: async (digest) =>
        digest === prepared.record.digest ? undefined : store.getBytes(digest),
    });
    const recovered = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store: missingCatalog,
      seed: seedSnapshot(),
    });
    expect(recovered.record.digest).toBe(prepared.record.digest);
    expect(recovered.record.kind).toBe("published");

    const corruptCatalog = overlayStore(store, {
      getBytes: async (digest) =>
        digest === prepared.record.digest
          ? new TextEncoder().encode("{corrupt")
          : store.getBytes(digest),
    });
    const recoveredFromCorrupt = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store: corruptCatalog,
      seed: seedSnapshot(),
    });
    expect(recoveredFromCorrupt.record.digest).toBe(prepared.record.digest);

    const broken = overlayStore(store, {
      getBytes: async (digest) =>
        digest === prepared.record.digest ? undefined : store.getBytes(digest),
      getRetainedRevision: async () => undefined,
    });
    await expect(
      readReleaseGroup({ sourceCommit: SOURCE_COMMIT, store: broken, seed: seedSnapshot() }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });

    const replacementFetch = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    await expect(
      prepareReleaseGroup(prepareInput({ store: broken, fetch: replacementFetch.fetch })),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });
    expect(replacementFetch.urls).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it("missing group on read throws not-found", async () => {
    const store = createMemoryReleasePinStore();
    await expect(
      readReleaseGroup({ sourceCommit: SOURCE_COMMIT, store, seed: seedSnapshot() }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "not-found" });
    await expect(
      readReleaseGroup({ sourceCommit: OTHER_COMMIT, store, seed: seedSnapshot() }),
    ).rejects.toBeInstanceOf(CatalogReleasePinError);
  });

  it("athlete cache files planted in a temp dir are ignored (prepare still uses fetch/retained/seed)", async () => {
    expect(MODULE_SOURCE).not.toMatch(/installationRoot/);
    expect(MODULE_SOURCE).not.toMatch(/cacheDirectory/);

    const directory = mkdtempSync(join(tmpdir(), "athlete-cache-"));
    try {
      writeFileSync(join(directory, "catalog.json"), jsonBytes({ athlete: "cache" }));
      writeFileSync(join(directory, "snapshot.json"), "not-used");
      const store = createMemoryReleasePinStore();
      const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
      const { fetch, urls } = trackingFetch({
        kind: "response",
        etag: fixture.etag,
        bytes: fixture.bytes,
      });
      const prepared = await prepareReleaseGroup(prepareInput({ store, fetch }));
      expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
      expect(prepared.record.acquisition).toBe("production-fetch");
      expect(prepared.record.digest).toBe(fixture.digest);

      const seedStore = createMemoryReleasePinStore();
      const seedPrepared = await prepareReleaseGroup(
        prepareInput({ store: seedStore, fetch: unavailableFetch().fetch }),
      );
      expect(seedPrepared.record.kind).toBe("bundled-seed");
      expect(seedPrepared.record.digest).not.toBe(await digestHex(jsonBytes({ athlete: "cache" })));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("seed pin schema rejects catalogAgeMs; published pin schema rejects seedEstablishedAt", () => {
    expectTypeOf<BundledSeedReleasePin>().not.toHaveProperty("catalogAgeMs");
    expectTypeOf<BundledSeedReleasePin>().not.toHaveProperty("publishedAt");
    expectTypeOf<PublishedReleasePin>().not.toHaveProperty("seedEstablishedAt");
    const seedPin = {
      kind: "bundled-seed" as const,
      acquisition: "initial-seed" as const,
      revision: 1,
      digest: "aa".repeat(32),
      acquiredAt: ACQUIRED_AT,
      seedEstablishedAt: SEED_ESTABLISHED_AT,
    };
    expect(BundledSeedReleasePinSchema.safeParse(seedPin).success).toBe(true);
    expect(BundledSeedReleasePinSchema.safeParse({ ...seedPin, catalogAgeMs: 0 }).success).toBe(
      false,
    );
    expect(
      BundledSeedReleasePinSchema.safeParse({ ...seedPin, publishedAt: ACQUIRED_AT }).success,
    ).toBe(false);

    const publishedAt = "1998-09-14T09:00:00.000Z";
    const publishedPin = {
      kind: "published" as const,
      acquisition: "production-fetch" as const,
      revision: 2,
      digest: "bb".repeat(32),
      acquiredAt: ACQUIRED_AT,
      publishedAt,
      catalogAgeMs: Date.parse(ACQUIRED_AT) - Date.parse(publishedAt),
      publicationRecordDigest: "cc".repeat(32),
      productionReceiptDigest: "dd".repeat(32),
    };
    expect(PublishedReleasePinSchema.safeParse(publishedPin).success).toBe(true);
    expect(
      PublishedReleasePinSchema.safeParse({
        ...publishedPin,
        seedEstablishedAt: SEED_ESTABLISHED_AT,
      }).success,
    ).toBe(false);
  });

  it("retainProductionCatalog equal bytes idempotent; different bytes conflict", async () => {
    const store = createMemoryReleasePinStore();
    const first = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: first.record, receipt: first.receipt });
    await retainProductionCatalog({ store, record: first.record, receipt: first.receipt });
    const retained = await store.getRetainedRevision(2);
    expect(retained?.catalogDigest).toBe(first.digest);

    const second = await publishedFixture(2, "synthetic-conflict");
    await expect(
      retainProductionCatalog({ store, record: second.record, receipt: second.receipt }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "conflict" });
    expect((await store.getRetainedRevision(2))?.catalogDigest).toBe(first.digest);
  });

  it("group key ignores any run/attempt provenance you might record; two prepares with different fake run ids and same SHA join", async () => {
    const store = createMemoryReleasePinStore();
    const fixture = await retainFixture(store, 2, "synthetic-text-tool-image");
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const base = prepareInput({ store, fetch });
    const first = await prepareReleaseGroup({ ...base, ...{ runId: "run-111", attempt: "1" } });
    const second = await prepareReleaseGroup({ ...base, ...{ runId: "run-999", attempt: "8" } });
    expect(urls).toHaveLength(1);
    expect(first.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(second.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(second.record).toEqual(first.record);
  });
});
