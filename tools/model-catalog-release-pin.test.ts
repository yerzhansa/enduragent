import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import type { ModelCatalogPublicationFile } from "./model-catalog-publication.js";
import {
  BundledSeedReleaseGroupRecordSchema,
  BundledSeedReleasePinSchema,
  CatalogReleasePinError,
  createMemoryReleasePinStore,
  prepareReleaseGroup,
  readReleaseGroup,
  type BundledSeedReleasePin,
  type PrepareReleaseGroupInput,
  type PreparedRelease,
  type ReadReleaseGroupInput,
  type ReleasePinStore,
} from "./model-catalog-release-pin.js";

const SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACQUIRED_AT = "1998-09-14T10:00:00.000Z";
const LATER_ACQUIRED_AT = "1998-09-14T12:00:00.000Z";
const SEED_ESTABLISHED_AT = "1998-01-01T00:00:00.000Z";
const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
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

async function digestHex(bytes: Uint8Array): Promise<string> {
  return (await sha256(bytes)).hex;
}

function overlayStore(store: ReleasePinStore, overlay: Partial<ReleasePinStore>): ReleasePinStore {
  return {
    createGroup: (input) => store.createGroup(input),
    readGroup: (releaseGroupId) => store.readGroup(releaseGroupId),
    putBytes: (input) => store.putBytes(input),
    getBytes: (digest) => store.getBytes(digest),
    ...overlay,
  };
}

function requireSeed(prepared: PreparedRelease) {
  expect(prepared.record.kind).toBe("bundled-seed");
  if (prepared.record.kind !== "bundled-seed") {
    throw new Error("expected bundled-seed pin");
  }
  return prepared;
}

function prepareInput(input: {
  readonly store: ReleasePinStore;
  readonly sourceCommit?: string;
  readonly acquisitionTime?: string;
  readonly seed?: unknown;
}): PrepareReleaseGroupInput {
  return {
    sourceCommit: input.sourceCommit ?? SOURCE_COMMIT,
    store: input.store,
    acquisitionTime: input.acquisitionTime ?? ACQUIRED_AT,
    seed: input.seed ?? seedSnapshot(),
  };
}

describe("model catalog release pin", () => {
  it("prepare seals bundled-seed; digest equals sha256(jsonBytes(snapshot))", async () => {
    const store = createMemoryReleasePinStore();
    const seed = seedSnapshot();
    const prepared = requireSeed(await prepareReleaseGroup(prepareInput({ store, seed })));
    const expectedDigest = await digestHex(jsonBytes(seed));
    const sealed = JSON.parse(new TextDecoder().decode(jsonBytes(prepared.record)));
    if (typeof sealed !== "object" || sealed === null) {
      throw new Error("expected sealed pin object");
    }

    expect(prepared.record.acquisition).toBe("initial-seed");
    expect(prepared.record.revision).toBe(1);
    expect(prepared.record.digest).toBe(expectedDigest);
    expect(prepared.record.acquiredAt).toBe(ACQUIRED_AT);
    expect(prepared.record.seedEstablishedAt).toBe(SEED_ESTABLISHED_AT);
    expect(prepared.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(prepared.snapshot.provenance).toEqual({
      kind: "bundled-seed",
      establishedAt: SEED_ESTABLISHED_AT,
    });
    expect(prepared.binding).toEqual({
      releaseGroupId: SOURCE_COMMIT,
      revision: 1,
      digest: expectedDigest,
    });
    expect(Object.hasOwn(sealed, "catalogAgeMs")).toBe(false);
    expect(Object.hasOwn(sealed, "publishedAt")).toBe(false);
    expect(Object.hasOwn(sealed, "publicationRecordDigest")).toBe(false);
    expect(Object.hasOwn(sealed, "productionReceiptDigest")).toBe(false);
    expect(BundledSeedReleaseGroupRecordSchema.safeParse(sealed).success).toBe(true);
  });

  it("existing group: second prepare returns same record and ignores a later acquisitionTime", async () => {
    const store = createMemoryReleasePinStore();
    const first = await prepareReleaseGroup(prepareInput({ store }));
    const second = await prepareReleaseGroup(
      prepareInput({ store, acquisitionTime: LATER_ACQUIRED_AT }),
    );

    expect(second.record).toEqual(first.record);
    expect(second.record.acquiredAt).toBe(ACQUIRED_AT);
    expect(second.binding.digest).toBe(first.binding.digest);
  });

  it("main-commit then tag-trigger (same SHA) joins; tag-trigger then main-commit joins", async () => {
    async function join(firstTrigger: string, secondTrigger: string) {
      const store = createMemoryReleasePinStore();
      const base = prepareInput({ store });
      const firstInput = { ...base, trigger: firstTrigger };
      const secondInput = { ...base, trigger: secondTrigger };
      const first = await prepareReleaseGroup(firstInput);
      const second = await prepareReleaseGroup(secondInput);
      expect(second.record.releaseGroupId).toBe(first.record.releaseGroupId);
      expect(second.record.digest).toBe(first.record.digest);
      expect(second.record).toEqual(first.record);
    }

    await join("main-commit", "tag-trigger");
    await join("tag-trigger", "main-commit");
  });

  it("unusable seed throws validation on first prepare", async () => {
    const store = createMemoryReleasePinStore();
    await expect(
      prepareReleaseGroup(prepareInput({ store, seed: { not: "a catalog" } })),
    ).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "validation",
      message: "committed seed catalog is not usable",
    });
  });

  it("two concurrent prepares: one group; loser adopts winner; both return winner digest", async () => {
    const inner = createMemoryReleasePinStore();
    let started = 0;
    let releaseBoth: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const store = overlayStore(inner, {
      createGroup: async (input) => {
        started += 1;
        if (started === 2) releaseBoth();
        await bothStarted;
        return inner.createGroup(input);
      },
    });
    const [left, right] = await Promise.all([
      prepareReleaseGroup(prepareInput({ store, acquisitionTime: ACQUIRED_AT })),
      prepareReleaseGroup(prepareInput({ store, acquisitionTime: LATER_ACQUIRED_AT })),
    ]);

    expect(left.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(right.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(right.record.digest).toBe(left.record.digest);
    expect(left.record).toEqual(right.record);
    expect(await store.readGroup(SOURCE_COMMIT)).toBeDefined();
    expect(left.record.acquiredAt === ACQUIRED_AT || left.record.acquiredAt === LATER_ACQUIRED_AT).toBe(
      true,
    );
  });

  it("readReleaseGroup has no fetch or acquisitionTime and returns the prepared pin", async () => {
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("fetch");
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("acquisitionTime");
    expectTypeOf<ReadReleaseGroupInput>().not.toHaveProperty("authority");
    expectTypeOf<keyof ReadReleaseGroupInput>().toEqualTypeOf<"sourceCommit" | "store" | "seed">();
    expectTypeOf<keyof PrepareReleaseGroupInput>().toEqualTypeOf<
      "sourceCommit" | "store" | "acquisitionTime" | "seed"
    >();
    expectTypeOf(readReleaseGroup).parameter(0).not.toHaveProperty("fetch");

    const store = createMemoryReleasePinStore();
    const prepared = await prepareReleaseGroup(prepareInput({ store }));
    const read = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store,
      seed: seedSnapshot(),
    });

    expect(read.record).toEqual(prepared.record);
    expect(read.binding.digest).toBe(prepared.binding.digest);
  });

  it("missing blob hydrates from the committed seed; mismatched seed is unrecoverable and prepare does not replace it", async () => {
    const store = createMemoryReleasePinStore();
    const prepared = await prepareReleaseGroup(prepareInput({ store }));
    const missingCatalog = overlayStore(store, {
      getBytes: async () => undefined,
    });
    const recovered = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store: missingCatalog,
      seed: seedSnapshot(),
    });
    expect(recovered.record.digest).toBe(prepared.record.digest);
    expect(recovered.record.kind).toBe("bundled-seed");

    const mismatched = overlayStore(store, {
      getBytes: async () => undefined,
    });
    await expect(
      readReleaseGroup({
        sourceCommit: SOURCE_COMMIT,
        store: mismatched,
        seed: seedSnapshot("synthetic-other"),
      }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });
    await expect(
      prepareReleaseGroup(prepareInput({ store: mismatched, seed: seedSnapshot("synthetic-other") })),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });
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

  it("corrupt group bytes are unrecoverable for read and prepare", async () => {
    const store = createMemoryReleasePinStore();
    await store.createGroup({
      releaseGroupId: SOURCE_COMMIT,
      bytes: new TextEncoder().encode("{not-json"),
    });
    await expect(
      readReleaseGroup({ sourceCommit: SOURCE_COMMIT, store, seed: seedSnapshot() }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });
    await expect(prepareReleaseGroup(prepareInput({ store }))).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "unrecoverable",
    });
  });

  it("athlete cache files planted in a temp dir are ignored", async () => {
    expect(MODULE_SOURCE).not.toMatch(/installationRoot/);
    expect(MODULE_SOURCE).not.toMatch(/cacheDirectory/);

    const directory = mkdtempSync(join(tmpdir(), "athlete-cache-"));
    try {
      writeFileSync(join(directory, "catalog.json"), jsonBytes({ athlete: "cache" }));
      writeFileSync(join(directory, "snapshot.json"), "not-used");
      const store = createMemoryReleasePinStore();
      const seed = seedSnapshot();
      const prepared = await prepareReleaseGroup(prepareInput({ store, seed }));
      expect(prepared.record.kind).toBe("bundled-seed");
      expect(prepared.record.digest).toBe(await digestHex(jsonBytes(seed)));
      expect(prepared.record.digest).not.toBe(await digestHex(jsonBytes({ athlete: "cache" })));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("seed pin schema rejects catalogAgeMs and published fields", () => {
    expectTypeOf<BundledSeedReleasePin>().not.toHaveProperty("catalogAgeMs");
    expectTypeOf<BundledSeedReleasePin>().not.toHaveProperty("publishedAt");
    expectTypeOf<BundledSeedReleasePin>().not.toHaveProperty("publicationRecordDigest");
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
  });

  it("putBytes same digest identical bytes exists; different bytes conflict", async () => {
    const store = createMemoryReleasePinStore();
    const bytes = jsonBytes({ n: 1 });
    const digest = (await sha256(bytes)).hex;
    expect(await store.putBytes({ digest, bytes })).toBe("created");
    expect(await store.putBytes({ digest, bytes })).toBe("exists");
    expect(new Uint8Array((await store.getBytes(digest)) ?? [])).toEqual(bytes);
    await expect(store.putBytes({ digest, bytes: jsonBytes({ n: 2 }) })).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "integrity",
    });
  });

  it("group key ignores run/attempt provenance; two prepares with different fake run ids and same SHA join", async () => {
    const store = createMemoryReleasePinStore();
    const base = prepareInput({ store });
    const firstInput = { ...base, runId: "run-111", attempt: "1" };
    const secondInput = { ...base, runId: "run-999", attempt: "8" };
    const first = await prepareReleaseGroup(firstInput);
    const second = await prepareReleaseGroup(secondInput);
    expect(first.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(second.record.releaseGroupId).toBe(SOURCE_COMMIT);
    expect(second.record).toEqual(first.record);
  });

  it("domain source has no production fetch, retain, or wall-clock helpers", () => {
    expect(MODULE_SOURCE).not.toMatch(/retainProductionCatalog/);
    expect(MODULE_SOURCE).not.toMatch(/PublishedReleasePin/);
    expect(MODULE_SOURCE).not.toMatch(/MODEL_CATALOG_PUBLIC_URL/);
    expect(MODULE_SOURCE).not.toMatch(/putRetainedRevision/);
    expect(MODULE_SOURCE).not.toMatch(/\bDate\.now\b/);
    expect(MODULE_SOURCE).not.toMatch(/\bnew Date\(/);
    expect(MODULE_SOURCE).not.toMatch(/\bMath\.random\b/);
  });
});
