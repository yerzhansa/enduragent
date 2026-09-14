import { describe, expect, it } from "vitest";
import { jsonBytes } from "./model-catalog-bytes.js";
import { MODEL_CATALOG_CURRENT_KEY } from "./model-catalog-constants.js";
import {
  CatalogPublicationError,
  diffModelCatalogs,
  publishModelCatalog,
  rollbackModelCatalog,
  validateModelCatalogPublicationFile,
  type CatalogPutCondition,
  type CatalogPutResult,
  type ModelCatalogPublicationFile,
  type ModelCatalogPublicationStore,
  type StoredCatalogObject,
} from "./model-catalog-publication.js";

const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const PUBLISHED_AT = Date.parse("1998-09-14T09:00:00.000Z");

function publicationFile(modelId = "synthetic-text-tool-image"): ModelCatalogPublicationFile {
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

function requirePublicationParts(file = publicationFile()) {
  const provider = file.catalog.providers[0];
  const model = provider?.models[0];
  const evidence = file.evidence[0];
  const connection = evidence?.connections[0];
  if (
    provider === undefined ||
    model === undefined ||
    evidence === undefined ||
    connection === undefined
  ) {
    throw new Error("synthetic publication fixture is incomplete");
  }
  return { file, provider, model, evidence, connection };
}

function publicationWithConnection(connection: unknown): unknown {
  const { file, evidence } = requirePublicationParts();
  return { ...file, evidence: [{ ...evidence, connections: [connection] }] };
}

function publicationWithModelFields(fields: Readonly<Record<string, unknown>>): unknown {
  const { file, provider, model } = requirePublicationParts();
  return {
    ...file,
    catalog: {
      ...file.catalog,
      providers: [{ ...provider, models: [{ ...model, ...fields }] }],
    },
  };
}

function copyObject(object: StoredCatalogObject): StoredCatalogObject {
  return {
    body: object.body.slice(),
    etag: object.etag,
    metadata: { ...object.metadata },
  };
}

class MemoryStore implements ModelCatalogPublicationStore {
  readonly log: string[] = [];
  readonly objects = new Map<string, StoredCatalogObject>();
  currentFailure: "before" | "after" | undefined;
  currentAfterWrite: (() => Promise<void>) | undefined;
  private etag = 0;

  async get(key: string): Promise<StoredCatalogObject | undefined> {
    this.log.push(`get ${key}`);
    const object = this.objects.get(key);
    return object === undefined ? undefined : copyObject(object);
  }

  async put(
    key: string,
    body: Uint8Array,
    input: Readonly<{
      condition: CatalogPutCondition;
      metadata: Readonly<Record<string, string>>;
    }>,
  ): Promise<CatalogPutResult> {
    this.log.push(`put ${key}`);
    const existing = this.objects.get(key);
    const conditionMatches =
      input.condition.kind === "absent"
        ? existing === undefined
        : existing?.etag === input.condition.etag;
    if (!conditionMatches) return { kind: "precondition-failed" };
    const failure = key === MODEL_CATALOG_CURRENT_KEY ? this.currentFailure : undefined;
    if (failure !== undefined) this.currentFailure = undefined;
    if (failure === "before") {
      throw new Error("uncertain before write");
    }
    const etag = `"memory-${(this.etag += 1)}"`;
    this.objects.set(key, { body: body.slice(), etag, metadata: { ...input.metadata } });
    if (key === MODEL_CATALOG_CURRENT_KEY && this.currentAfterWrite !== undefined) {
      const afterWrite = this.currentAfterWrite;
      this.currentAfterWrite = undefined;
      await afterWrite();
    }
    if (failure === "after") {
      throw new Error("uncertain after write");
    }
    return { kind: "written", etag };
  }
}

class BarrierStore extends MemoryStore {
  private blockedReads = 0;
  private enabled = false;
  private release: (() => void) | undefined;
  private readonly barrier = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  enableBarrier(): void {
    this.enabled = true;
  }

  override async get(key: string): Promise<StoredCatalogObject | undefined> {
    if (this.enabled && key === MODEL_CATALOG_CURRENT_KEY && this.blockedReads < 2) {
      this.blockedReads += 1;
      if (this.blockedReads === 2) this.release?.();
      await this.barrier;
    }
    return super.get(key);
  }
}

describe("model catalog publication validation", () => {
  it("requires text, tool, image, limit, and price evidence for advertised metadata", async () => {
    await expect(
      validateModelCatalogPublicationFile(publicationFile(), PUBLISHED_AT),
    ).resolves.toEqual(publicationFile());

    const { connection } = requirePublicationParts();
    const missingTool = publicationWithConnection({
      connectionId: connection.connectionId,
      textCall: connection.textCall,
      imageCall: connection.imageCall,
    });
    await expect(validateModelCatalogPublicationFile(missingTool, PUBLISHED_AT)).rejects.toThrow();

    const missingImage = publicationWithConnection({
      connectionId: connection.connectionId,
      textCall: connection.textCall,
      toolCall: connection.toolCall,
    });
    await expect(validateModelCatalogPublicationFile(missingImage, PUBLISHED_AT)).rejects.toThrow(
      "advertised image input requires evidence",
    );

    const { file, evidence } = requirePublicationParts();
    const missingSources = {
      ...file,
      evidence: [
        {
          providerId: evidence.providerId,
          modelId: evidence.modelId,
          connections: evidence.connections,
        },
      ],
    };
    await expect(validateModelCatalogPublicationFile(missingSources, PUBLISHED_AT)).rejects.toThrow(
      "known context limits require a source",
    );
  });

  it("rejects remote authentication and endpoint behavior", async () => {
    const candidate = publicationWithModelFields({
      endpoint: "https://provider.example/v1",
      auth: "synthetic-token",
    });

    await expect(validateModelCatalogPublicationFile(candidate, PUBLISHED_AT)).rejects.toThrow();
  });

  it("rejects evidence URLs that can carry credentials in query parameters", async () => {
    const { file, evidence } = requirePublicationParts();
    const candidate = {
      ...file,
      evidence: [{ ...evidence, pricingSource: "https://example.com/pricing?token=synthetic" }],
    };

    await expect(validateModelCatalogPublicationFile(candidate, PUBLISHED_AT)).rejects.toThrow(
      "without credentials or query parameters",
    );
  });

  it("rejects future-dated evidence and catalogs over 512 KiB", async () => {
    const { connection } = requirePublicationParts();
    const future = publicationWithConnection({
      ...connection,
      textCall: { ...connection.textCall, verifiedAt: "1998-09-14T09:06:00.000Z" },
    });
    await expect(validateModelCatalogPublicationFile(future, PUBLISHED_AT)).rejects.toThrow(
      "future-dated",
    );

    const providers = Array.from({ length: 3 }, (_, providerIndex) => ({
      providerId: `provider-${providerIndex}`,
      label: `Provider ${providerIndex}`,
      order: providerIndex,
      recommendedModelId: `model-${providerIndex}-${"x".repeat(480)}`,
      models: Array.from({ length: 256 }, (_, modelIndex) => {
        const modelId = `model-${providerIndex}-${modelIndex}-${"x".repeat(470)}`;
        return {
          modelId,
          label: "x".repeat(128),
          order: modelIndex,
          hint: "x".repeat(256),
          compatibilityProfile: "future-profile-v1",
          contextWindow: { kind: "unknown" as const },
          imageInput: "unknown" as const,
          pricing: { kind: "unknown" as const },
        };
      }),
    }));
    for (const provider of providers) provider.recommendedModelId = provider.models[0].modelId;
    const evidence = providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
        connections: [
          {
            connectionId: "synthetic",
            textCall: { verifiedAt: VERIFIED_AT, reference: "record:text" },
            toolCall: { verifiedAt: VERIFIED_AT, reference: "record:tool" },
          },
        ],
      })),
    );
    await expect(
      validateModelCatalogPublicationFile(
        { catalog: { schemaVersion: 1, providers }, evidence },
        PUBLISHED_AT,
      ),
    ).rejects.toThrow("512 KiB");
  });

  it("reports provider and model additions, removals, and metadata changes", () => {
    const previous = publicationFile("old-model").catalog;
    const candidate = publicationFile("new-model").catalog;
    candidate.providers[0].label = "Renamed provider";

    expect(diffModelCatalogs(previous, candidate)).toEqual({
      additions: ["model:openai/new-model"],
      removals: ["model:openai/old-model"],
      changes: ["provider:openai.label", "provider:openai.recommendedModelId"],
    });
  });
});

describe("model catalog publication", () => {
  it("writes an immutable record before replacing current and commits the revision after", async () => {
    const store = new MemoryStore();
    const receipt = await publishModelCatalog({
      store,
      expectedRevision: 0,
      publicationFile: publicationFile(),
      now: PUBLISHED_AT,
    });

    expect(receipt.revision).toBe(1);
    expect(receipt.previousRevision).toBe(0);
    expect(receipt.recoveredAfterUncertainWrite).toBe(false);
    expect(store.log.filter((entry) => entry.startsWith("put "))).toEqual([
      `put ${receipt.recordKey}`,
      `put ${MODEL_CATALOG_CURRENT_KEY}`,
      "put committed/1.json",
    ]);
    const current = store.objects.get(MODEL_CATALOG_CURRENT_KEY);
    expect(JSON.parse(new TextDecoder().decode(current?.body))).toMatchObject({
      revision: 1,
      provenance: { kind: "published", publishedAt: "1998-09-14T09:00:00.000Z" },
    });
    expect(current?.metadata["catalog-digest"]).toBe(receipt.catalogDigest);
    expect(
      JSON.parse(new TextDecoder().decode(store.objects.get(receipt.recordKey)?.body)),
    ).toMatchObject({
      catalogDigest: receipt.catalogDigest,
      evidence: publicationFile().evidence,
    });
  });

  it("allows only one of two publishers to replace the same current revision", async () => {
    const store = new BarrierStore();
    await publishModelCatalog({
      store,
      expectedRevision: 0,
      publicationFile: publicationFile("base-model"),
      now: PUBLISHED_AT,
    });
    store.enableBarrier();

    const results = await Promise.allSettled([
      publishModelCatalog({
        store,
        expectedRevision: 1,
        publicationFile: publicationFile("candidate-a"),
        now: PUBLISHED_AT + 1_000,
      }),
      publishModelCatalog({
        store,
        expectedRevision: 1,
        publicationFile: publicationFile("candidate-b"),
        now: PUBLISHED_AT + 2_000,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status !== "rejected") throw new Error("expected one publisher to lose the race");
    expect(failure.reason).toBeInstanceOf(CatalogPublicationError);
    expect(failure.reason.code).toBe("conflict");
    const current = JSON.parse(
      new TextDecoder().decode(store.objects.get(MODEL_CATALOG_CURRENT_KEY)?.body),
    );
    expect(current.revision).toBe(2);
    expect(["candidate-a", "candidate-b"]).toContain(current.providers[0].models[0].modelId);
  });

  it.each(["before", "after"] as const)(
    "reads current before retrying an uncertain %s-write response",
    async (failure) => {
      const store = new MemoryStore();
      await publishModelCatalog({
        store,
        expectedRevision: 0,
        publicationFile: publicationFile("base-model"),
        now: PUBLISHED_AT,
      });
      store.currentFailure = failure;
      const before = store.log.length;
      const receipt = await publishModelCatalog({
        store,
        expectedRevision: 1,
        publicationFile: publicationFile("next-model"),
        now: PUBLISHED_AT + 1_000,
      });
      const currentOperations = store.log
        .slice(before)
        .filter((entry) => entry.endsWith(MODEL_CATALOG_CURRENT_KEY));

      expect(receipt.recoveredAfterUncertainWrite).toBe(true);
      expect(receipt.revision).toBe(2);
      expect(currentOperations).toEqual(
        failure === "before"
          ? [
              `get ${MODEL_CATALOG_CURRENT_KEY}`,
              `put ${MODEL_CATALOG_CURRENT_KEY}`,
              `get ${MODEL_CATALOG_CURRENT_KEY}`,
              `put ${MODEL_CATALOG_CURRENT_KEY}`,
              `get ${MODEL_CATALOG_CURRENT_KEY}`,
            ]
          : [
              `get ${MODEL_CATALOG_CURRENT_KEY}`,
              `put ${MODEL_CATALOG_CURRENT_KEY}`,
              `get ${MODEL_CATALOG_CURRENT_KEY}`,
            ],
      );
    },
  );

  it.each([
    { uncertain: false, expectedEtag: "available" },
    { uncertain: true, expectedEtag: null },
  ])(
    "returns a receipt when a successful publication is superseded before read-back",
    async ({ uncertain, expectedEtag }) => {
      const store = new MemoryStore();
      await publishModelCatalog({
        store,
        expectedRevision: 0,
        publicationFile: publicationFile("base-model"),
        now: PUBLISHED_AT,
      });
      store.currentAfterWrite = async () => {
        await publishModelCatalog({
          store,
          expectedRevision: 2,
          publicationFile: publicationFile("successor-model"),
          now: PUBLISHED_AT + 2_000,
        });
      };
      if (uncertain) store.currentFailure = "after";

      const receipt = await publishModelCatalog({
        store,
        expectedRevision: 1,
        publicationFile: publicationFile("superseded-model"),
        now: PUBLISHED_AT + 1_000,
      });
      const current = JSON.parse(
        new TextDecoder().decode(store.objects.get(MODEL_CATALOG_CURRENT_KEY)?.body),
      );

      expect(receipt.revision).toBe(2);
      expect(receipt.advancedBeforeReceipt).toBe(true);
      expect(receipt.recoveredAfterUncertainWrite).toBe(uncertain);
      if (expectedEtag === null) expect(receipt.publishedEtag).toBeNull();
      else expect(receipt.publishedEtag).toMatch(/^"memory-\d+"$/u);
      expect(current.revision).toBe(3);
      expect(current.providers[0].models[0].modelId).toBe("successor-model");
      expect(store.objects.has("committed/2.json")).toBe(true);
    },
  );

  it("republishes an old committed catalog under a higher rollback revision", async () => {
    const store = new MemoryStore();
    await publishModelCatalog({
      store,
      expectedRevision: 0,
      publicationFile: publicationFile("first-model"),
      now: PUBLISHED_AT,
    });
    await publishModelCatalog({
      store,
      expectedRevision: 1,
      publicationFile: publicationFile("second-model"),
      now: PUBLISHED_AT + 1_000,
    });
    const receipt = await rollbackModelCatalog({
      store,
      sourceRevision: 1,
      expectedRevision: 2,
      now: PUBLISHED_AT + 2_000,
    });
    const current = JSON.parse(
      new TextDecoder().decode(store.objects.get(MODEL_CATALOG_CURRENT_KEY)?.body),
    );

    expect(receipt).toMatchObject({
      action: { kind: "rollback", sourceRevision: 1 },
      previousRevision: 2,
      revision: 3,
    });
    expect(current.revision).toBe(3);
    expect(current.providers[0].models[0].modelId).toBe("first-model");
    expect(current.provenance.publishedAt).toBe("1998-09-14T09:00:02.000Z");
    expect(store.objects.has("committed/3.json")).toBe(true);
  });

  it("does not include credentials in publication records or receipts", async () => {
    const store = new MemoryStore();
    const receipt = await publishModelCatalog({
      store,
      expectedRevision: 0,
      publicationFile: publicationFile(),
      now: PUBLISHED_AT,
    });
    const serialized = JSON.stringify({ receipt, objects: Array.from(store.objects.values()) });

    expect(serialized).not.toContain("SECRET_ACCESS_KEY");
    expect(jsonBytes(receipt).byteLength).toBeLessThan(4_096);
  });
});
