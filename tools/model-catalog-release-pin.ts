import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { acceptModelCatalogSnapshot } from "../packages/core/src/model-catalog.js";
import { z } from "zod";
import { bytesEqual, jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  modelCatalogDeploymentMessage,
  modelCatalogDeploymentTag,
} from "./model-catalog-cloudflare.js";
import {
  MODEL_CATALOG_FUTURE_TOLERANCE_MS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLIC_URL,
} from "./model-catalog-constants.js";
import {
  ModelCatalogDeploymentReceiptSchema,
  ModelCatalogPublicationRecordSchema,
  type ModelCatalogDeploymentReceipt,
  type ModelCatalogPublicationRecord,
} from "./model-catalog-publication.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_GROUP_ID_PATTERN = /^[a-f0-9]{40}$/u;

export class CatalogReleasePinError extends Error {
  constructor(
    readonly code: "conflict" | "integrity" | "not-found" | "unrecoverable" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "CatalogReleasePinError";
  }
}

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const CatalogDigestSchema = z.string().regex(DIGEST_PATTERN).brand<"CatalogDigest">();
export const ReleaseGroupIdSchema = z
  .string()
  .regex(RELEASE_GROUP_ID_PATTERN)
  .brand<"ReleaseGroupId">();

const IsoTimestampField = IsoTimestampSchema;
const DigestField = CatalogDigestSchema;
const RevisionField = z.number().int().positive().safe();

export const PublishedProvenanceSchema = z
  .object({
    kind: z.literal("published"),
    publishedAt: IsoTimestampField,
  })
  .strict();

export const BundledSeedProvenanceSchema = z
  .object({
    kind: z.literal("bundled-seed"),
    establishedAt: IsoTimestampField,
  })
  .strict();

export const PublishedSnapshotSchema = ModelCatalogSnapshotSchema.extend({
  provenance: PublishedProvenanceSchema,
}).strict();

export const BundledSeedSnapshotSchema = ModelCatalogSnapshotSchema.extend({
  provenance: BundledSeedProvenanceSchema,
}).strict();

function refineCatalogAge(
  pin: { acquiredAt: string; publishedAt: string; catalogAgeMs: number },
  context: z.core.$RefinementCtx,
): void {
  const catalogAgeMs = Date.parse(pin.acquiredAt) - Date.parse(pin.publishedAt);
  if (pin.catalogAgeMs !== catalogAgeMs) {
    context.addIssue({
      code: "custom",
      path: ["catalogAgeMs"],
      message: "catalogAgeMs must equal acquiredAt minus publishedAt",
    });
  }
}

const PublishedReleasePinObjectSchema = z
  .object({
    kind: z.literal("published"),
    acquisition: z.enum(["production-fetch", "retained-production"]),
    revision: RevisionField,
    digest: DigestField,
    acquiredAt: IsoTimestampField,
    publishedAt: IsoTimestampField,
    catalogAgeMs: z.number().int(),
    publicationRecordDigest: DigestField,
    productionReceiptDigest: DigestField,
  })
  .strict();

export const PublishedReleasePinSchema = PublishedReleasePinObjectSchema.superRefine(refineCatalogAge);

const BundledSeedReleasePinObjectSchema = z
  .object({
    kind: z.literal("bundled-seed"),
    acquisition: z.literal("initial-seed"),
    revision: RevisionField,
    digest: DigestField,
    acquiredAt: IsoTimestampField,
    seedEstablishedAt: IsoTimestampField,
  })
  .strict();

export const BundledSeedReleasePinSchema = BundledSeedReleasePinObjectSchema;

export const ReleaseCatalogPinSchema = z.discriminatedUnion("kind", [
  PublishedReleasePinObjectSchema,
  BundledSeedReleasePinObjectSchema,
]);

export const PublishedReleaseGroupRecordSchema = PublishedReleasePinObjectSchema.extend({
  releaseGroupId: ReleaseGroupIdSchema,
}).strict();

export const BundledSeedReleaseGroupRecordSchema = BundledSeedReleasePinObjectSchema.extend({
  releaseGroupId: ReleaseGroupIdSchema,
}).strict();

export const ReleaseGroupRecordSchema = z.discriminatedUnion("kind", [
  PublishedReleaseGroupRecordSchema,
  BundledSeedReleaseGroupRecordSchema,
]);

const ProductionFetchResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("response"),
      etag: z.string().min(1),
      bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type CatalogDigest = z.infer<typeof CatalogDigestSchema>;
export type ReleaseGroupId = z.infer<typeof ReleaseGroupIdSchema>;
export type PublishedSnapshot = z.infer<typeof PublishedSnapshotSchema>;
export type BundledSeedSnapshot = z.infer<typeof BundledSeedSnapshotSchema>;
export type ReleaseCatalogPin = z.infer<typeof ReleaseCatalogPinSchema>;
export type PublishedReleasePin = z.infer<typeof PublishedReleasePinSchema>;
export type BundledSeedReleasePin = z.infer<typeof BundledSeedReleasePinSchema>;
export type PublishedReleaseGroupRecord = z.infer<typeof PublishedReleaseGroupRecordSchema>;
export type BundledSeedReleaseGroupRecord = z.infer<typeof BundledSeedReleaseGroupRecordSchema>;
export type ReleaseGroupRecord = z.infer<typeof ReleaseGroupRecordSchema>;

export const ReleaseBindingSchema = z
  .object({
    releaseGroupId: ReleaseGroupIdSchema,
    revision: RevisionField,
    digest: DigestField,
  })
  .strict();

export type ReleaseBinding = Readonly<z.infer<typeof ReleaseBindingSchema>>;

export type PreparedRelease =
  | Readonly<{
      record: PublishedReleaseGroupRecord;
      snapshot: PublishedSnapshot;
      bytes: Uint8Array;
      binding: ReleaseBinding;
    }>
  | Readonly<{
      record: BundledSeedReleaseGroupRecord;
      snapshot: BundledSeedSnapshot;
      bytes: Uint8Array;
      binding: ReleaseBinding;
    }>;

export const MATERIALIZED_MODEL_CATALOG_SEED_PATH =
  "packages/core/src/model-catalog-seed.generated.ts";

const GENERATED_SEED_PREFIX = "export const GENERATED_MODEL_CATALOG_SEED = ";
const GENERATED_SEED_SUFFIX = " as const;\n";

export type MaterializeReleaseCatalogInput = {
  readonly prepared: PreparedRelease;
  readonly workspaceRoot: string;
};

export type MaterializedCatalogSeed = Readonly<{
  path: string;
  digest: CatalogDigest;
  revision: number;
}>;

export type ModelCatalogProductionFetchResult = z.infer<typeof ProductionFetchResultSchema>;
export type ModelCatalogProductionFetch = (
  url: typeof MODEL_CATALOG_PUBLIC_URL,
) => Promise<ModelCatalogProductionFetchResult>;

export type RetainedProductionBundle = Readonly<{
  revision: number;
  catalogDigest: CatalogDigest;
  publicationRecordDigest: CatalogDigest;
  productionReceiptDigest: CatalogDigest;
  catalogBytes: Uint8Array;
  recordBytes: Uint8Array;
  receiptBytes: Uint8Array;
}>;

export type BytesWriteResult = "created" | "exists";

export type CreateGroupResult =
  | Readonly<{ kind: "created" }>
  | Readonly<{ kind: "exists"; bytes: Uint8Array }>;

export interface ReleasePinStore {
  createGroup(input: {
    readonly releaseGroupId: string;
    readonly bytes: Uint8Array;
  }): Promise<CreateGroupResult>;
  readGroup(releaseGroupId: string): Promise<Uint8Array | undefined>;
  putBytes(input: {
    readonly digest: string;
    readonly bytes: Uint8Array;
  }): Promise<BytesWriteResult>;
  getBytes(digest: string): Promise<Uint8Array | undefined>;
  putRetainedRevision(bundle: RetainedProductionBundle): Promise<BytesWriteResult>;
  getRetainedRevision(revision: number): Promise<RetainedProductionBundle | undefined>;
  listRetainedRevisions(): Promise<readonly RetainedProductionBundle[]>;
}

export type PrepareReleaseGroupInput = {
  readonly sourceCommit: string;
  readonly store: ReleasePinStore;
  readonly fetch: ModelCatalogProductionFetch;
  readonly acquisitionTime: string;
  readonly seed: unknown;
};

export type ReadReleaseGroupInput = {
  readonly sourceCommit: string;
  readonly store: ReleasePinStore;
  readonly seed: unknown;
};

export type RetainProductionCatalogInput = {
  readonly store: ReleasePinStore;
  readonly record: unknown;
  readonly receipt: unknown;
};

type GroupResolution =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "ready"; prepared: PreparedRelease }>
  | Readonly<{ status: "broken" }>;

type PublishedMaterials = Readonly<{
  snapshot: PublishedSnapshot;
  bytes: Uint8Array;
  recordBytes: Uint8Array;
  receiptBytes: Uint8Array;
}>;

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function freezeBundle(bundle: RetainedProductionBundle): RetainedProductionBundle {
  return Object.freeze({
    revision: bundle.revision,
    catalogDigest: bundle.catalogDigest,
    publicationRecordDigest: bundle.publicationRecordDigest,
    productionReceiptDigest: bundle.productionReceiptDigest,
    catalogBytes: cloneBytes(bundle.catalogBytes),
    recordBytes: cloneBytes(bundle.recordBytes),
    receiptBytes: cloneBytes(bundle.receiptBytes),
  });
}

export function createMemoryReleasePinStore(): ReleasePinStore {
  const groups = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  const retained = new Map<number, RetainedProductionBundle>();
  const store: ReleasePinStore = {
    async createGroup(input) {
      const existing = groups.get(input.releaseGroupId);
      if (existing !== undefined) {
        return Object.freeze({ kind: "exists", bytes: cloneBytes(existing) });
      }
      groups.set(input.releaseGroupId, cloneBytes(input.bytes));
      return Object.freeze({ kind: "created" });
    },
    async readGroup(releaseGroupId) {
      const bytes = groups.get(releaseGroupId);
      return bytes === undefined ? undefined : cloneBytes(bytes);
    },
    async putBytes(input) {
      const digest = parseDigest(input.digest);
      const actual = await digestOf(input.bytes);
      if (actual !== digest) {
        throw new CatalogReleasePinError("integrity", "blob digest does not match bytes");
      }
      const existing = blobs.get(digest);
      if (existing !== undefined) {
        if (bytesEqual(existing, input.bytes)) return "exists";
        throw new CatalogReleasePinError("conflict", "blob already exists with different bytes");
      }
      blobs.set(digest, cloneBytes(input.bytes));
      return "created";
    },
    async getBytes(digest) {
      const bytes = blobs.get(digest);
      return bytes === undefined ? undefined : cloneBytes(bytes);
    },
    async putRetainedRevision(bundle) {
      const catalogDigest = await digestOf(bundle.catalogBytes);
      const publicationRecordDigest = await digestOf(bundle.recordBytes);
      const productionReceiptDigest = await digestOf(bundle.receiptBytes);
      if (
        catalogDigest !== bundle.catalogDigest ||
        publicationRecordDigest !== bundle.publicationRecordDigest ||
        productionReceiptDigest !== bundle.productionReceiptDigest
      ) {
        throw new CatalogReleasePinError("integrity", "retained bundle digest does not match bytes");
      }
      const existing = retained.get(bundle.revision);
      if (existing !== undefined) {
        if (
          existing.catalogDigest === bundle.catalogDigest &&
          existing.publicationRecordDigest === bundle.publicationRecordDigest &&
          existing.productionReceiptDigest === bundle.productionReceiptDigest &&
          bytesEqual(existing.catalogBytes, bundle.catalogBytes) &&
          bytesEqual(existing.recordBytes, bundle.recordBytes) &&
          bytesEqual(existing.receiptBytes, bundle.receiptBytes)
        ) {
          return "exists";
        }
        throw new CatalogReleasePinError(
          "conflict",
          "retained revision already exists with different bytes",
        );
      }
      retained.set(bundle.revision, freezeBundle(bundle));
      return "created";
    },
    async getRetainedRevision(revision) {
      const bundle = retained.get(revision);
      return bundle === undefined ? undefined : freezeBundle(bundle);
    },
    async listRetainedRevisions() {
      return Object.freeze(
        [...retained.values()]
          .sort((left, right) => right.revision - left.revision)
          .map((bundle) => freezeBundle(bundle)),
      );
    },
  };
  return Object.freeze(store);
}

function parseDigest(value: string): CatalogDigest {
  const parsed = CatalogDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogReleasePinError("validation", "catalog digest is invalid");
  }
  return parsed.data;
}

async function digestOf(bytes: Uint8Array): Promise<CatalogDigest> {
  return parseDigest((await sha256(bytes)).hex);
}

function tryUtf8Json(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function parseReleaseGroupRecordBytes(bytes: Uint8Array): ReleaseGroupRecord | undefined {
  const json = tryUtf8Json(bytes);
  if (json === undefined) return undefined;
  const parsed = ReleaseGroupRecordSchema.safeParse(json);
  if (!parsed.success || !bytesEqual(bytes, jsonBytes(parsed.data))) return undefined;
  if (parsed.data.kind === "published") {
    const catalogAgeMs = Date.parse(parsed.data.acquiredAt) - Date.parse(parsed.data.publishedAt);
    if (parsed.data.catalogAgeMs !== catalogAgeMs) return undefined;
  }
  return parsed.data;
}

function acceptedPublishedSnapshot(candidate: unknown): PublishedSnapshot | undefined {
  const parsed = PublishedSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  if (acceptModelCatalogSnapshot(parsed.data) === undefined) return undefined;
  return parsed.data;
}

function acceptedSeedSnapshot(candidate: unknown): BundledSeedSnapshot | undefined {
  const parsed = BundledSeedSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  if (acceptModelCatalogSnapshot(parsed.data) === undefined) return undefined;
  return parsed.data;
}

function parsePublicationRecordBytes(
  bytes: Uint8Array,
): ModelCatalogPublicationRecord | undefined {
  const json = tryUtf8Json(bytes);
  if (json === undefined) return undefined;
  const parsed = ModelCatalogPublicationRecordSchema.safeParse(json);
  if (!parsed.success || !bytesEqual(bytes, jsonBytes(parsed.data))) return undefined;
  return parsed.data;
}

function parseProductionReceiptBytes(
  bytes: Uint8Array,
): ModelCatalogDeploymentReceipt | undefined {
  const json = tryUtf8Json(bytes);
  if (json === undefined) return undefined;
  const parsed = ModelCatalogDeploymentReceiptSchema.safeParse(json);
  if (!parsed.success || !bytesEqual(bytes, jsonBytes(parsed.data))) return undefined;
  return parsed.data;
}

function catalogAgeMs(acquiredAt: string, publishedAt: string): number | undefined {
  const acquiredAtMs = Date.parse(acquiredAt);
  const publishedAtMs = Date.parse(publishedAt);
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(publishedAtMs)) return undefined;
  const age = acquiredAtMs - publishedAtMs;
  if (age < -MODEL_CATALOG_FUTURE_TOLERANCE_MS) return undefined;
  return age;
}

function productionReceiptMatches(
  receipt: ModelCatalogDeploymentReceipt,
  snapshot: PublishedSnapshot,
  digest: CatalogDigest,
): boolean {
  return (
    receipt.target === "production" &&
    receipt.revision === snapshot.revision &&
    receipt.catalogDigest === digest &&
    receipt.tag === modelCatalogDeploymentTag(snapshot.revision, digest) &&
    receipt.message === modelCatalogDeploymentMessage(snapshot.revision, digest)
  );
}

function publicationRecordMatches(
  record: ModelCatalogPublicationRecord,
  snapshot: PublishedSnapshot,
  digest: CatalogDigest,
): boolean {
  return (
    record.revision === snapshot.revision &&
    record.catalogDigest === digest &&
    record.publishedAt === snapshot.provenance.publishedAt &&
    record.catalog.revision === snapshot.revision &&
    record.catalog.provenance.kind === "published" &&
    record.catalog.provenance.publishedAt === snapshot.provenance.publishedAt
  );
}

async function publishedMaterialsFromParts(input: {
  readonly snapshot: PublishedSnapshot;
  readonly recordBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly etag?: string;
}): Promise<PublishedMaterials | undefined> {
  const bytes = jsonBytes(input.snapshot);
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) return undefined;
  const digest = await digestOf(bytes);
  const record = parsePublicationRecordBytes(input.recordBytes);
  const receipt = parseProductionReceiptBytes(input.receiptBytes);
  if (record === undefined || receipt === undefined) return undefined;
  if (!publicationRecordMatches(record, input.snapshot, digest)) return undefined;
  if (!productionReceiptMatches(receipt, input.snapshot, digest)) return undefined;
  if (input.etag !== undefined && receipt.liveEtag !== input.etag) return undefined;
  if ((await digestOf(jsonBytes(record.catalog))) !== digest) return undefined;
  return Object.freeze({
    snapshot: input.snapshot,
    bytes,
    recordBytes: cloneBytes(input.recordBytes),
    receiptBytes: cloneBytes(input.receiptBytes),
  });
}

async function publishedMaterialsFromBundle(
  bundle: RetainedProductionBundle,
): Promise<PublishedMaterials | undefined> {
  if (bundle.catalogBytes.byteLength > MODEL_CATALOG_MAX_BYTES) return undefined;
  const snapshot = acceptedPublishedSnapshot(tryUtf8Json(bundle.catalogBytes));
  if (snapshot === undefined) return undefined;
  if ((await digestOf(jsonBytes(snapshot))) !== bundle.catalogDigest) return undefined;
  return publishedMaterialsFromParts({
    snapshot,
    recordBytes: bundle.recordBytes,
    receiptBytes: bundle.receiptBytes,
  });
}

function bindingOf(record: ReleaseGroupRecord): ReleaseBinding {
  return Object.freeze({
    releaseGroupId: record.releaseGroupId,
    revision: record.revision,
    digest: record.digest,
  });
}

function preparedPublished(
  record: PublishedReleaseGroupRecord,
  snapshot: PublishedSnapshot,
  bytes: Uint8Array,
): PreparedRelease {
  return Object.freeze({
    record: Object.freeze(record),
    snapshot,
    bytes: cloneBytes(bytes),
    binding: bindingOf(record),
  });
}

function preparedSeed(
  record: BundledSeedReleaseGroupRecord,
  snapshot: BundledSeedSnapshot,
  bytes: Uint8Array,
): PreparedRelease {
  return Object.freeze({
    record: Object.freeze(record),
    snapshot,
    bytes: cloneBytes(bytes),
    binding: bindingOf(record),
  });
}

async function sealPublished(input: {
  readonly releaseGroupId: ReleaseGroupId;
  readonly acquisition: "production-fetch" | "retained-production";
  readonly acquiredAt: IsoTimestamp;
  readonly materials: PublishedMaterials;
}): Promise<PreparedRelease> {
  const digest = await digestOf(input.materials.bytes);
  const publishedAt = input.materials.snapshot.provenance.publishedAt;
  const age = catalogAgeMs(input.acquiredAt, publishedAt);
  if (age === undefined) {
    throw new CatalogReleasePinError("validation", "catalog age is outside the allowed window");
  }
  const record = PublishedReleaseGroupRecordSchema.parse({
    kind: "published",
    acquisition: input.acquisition,
    revision: input.materials.snapshot.revision,
    digest,
    acquiredAt: input.acquiredAt,
    publishedAt,
    catalogAgeMs: age,
    publicationRecordDigest: await digestOf(input.materials.recordBytes),
    productionReceiptDigest: await digestOf(input.materials.receiptBytes),
    releaseGroupId: input.releaseGroupId,
  });
  return preparedPublished(record, input.materials.snapshot, input.materials.bytes);
}

async function sealSeed(input: {
  readonly releaseGroupId: ReleaseGroupId;
  readonly acquiredAt: IsoTimestamp;
  readonly snapshot: BundledSeedSnapshot;
}): Promise<PreparedRelease> {
  const bytes = jsonBytes(input.snapshot);
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogReleasePinError("validation", "seed catalog exceeds the size limit");
  }
  const record = BundledSeedReleaseGroupRecordSchema.parse({
    kind: "bundled-seed",
    acquisition: "initial-seed",
    revision: input.snapshot.revision,
    digest: await digestOf(bytes),
    acquiredAt: input.acquiredAt,
    seedEstablishedAt: input.snapshot.provenance.establishedAt,
    releaseGroupId: input.releaseGroupId,
  });
  return preparedSeed(record, input.snapshot, bytes);
}

async function hydratePublished(
  record: PublishedReleaseGroupRecord,
  store: ReleasePinStore,
): Promise<PreparedRelease | undefined> {
  const stored = await store.getBytes(record.digest);
  if (stored !== undefined && (await digestOf(stored)) === record.digest) {
    const snapshot = acceptedPublishedSnapshot(tryUtf8Json(stored));
    if (
      snapshot !== undefined &&
      snapshot.revision === record.revision &&
      snapshot.provenance.publishedAt === record.publishedAt &&
      (await digestOf(jsonBytes(snapshot))) === record.digest
    ) {
      return preparedPublished(record, snapshot, jsonBytes(snapshot));
    }
  }
  const retained = await store.getRetainedRevision(record.revision);
  if (retained === undefined) return undefined;
  if (
    retained.catalogDigest !== record.digest ||
    retained.publicationRecordDigest !== record.publicationRecordDigest ||
    retained.productionReceiptDigest !== record.productionReceiptDigest
  ) {
    return undefined;
  }
  const materials = await publishedMaterialsFromBundle(retained);
  if (materials === undefined) return undefined;
  if ((await digestOf(materials.bytes)) !== record.digest) return undefined;
  if (materials.snapshot.provenance.publishedAt !== record.publishedAt) return undefined;
  return preparedPublished(record, materials.snapshot, materials.bytes);
}

async function hydrateSeed(
  record: BundledSeedReleaseGroupRecord,
  seed: unknown,
  store: ReleasePinStore,
): Promise<PreparedRelease | undefined> {
  const fromInput = acceptedSeedSnapshot(seed);
  if (fromInput !== undefined) {
    const bytes = jsonBytes(fromInput);
    if (
      (await digestOf(bytes)) === record.digest &&
      fromInput.revision === record.revision &&
      fromInput.provenance.establishedAt === record.seedEstablishedAt
    ) {
      return preparedSeed(record, fromInput, bytes);
    }
  }
  const stored = await store.getBytes(record.digest);
  if (stored === undefined || (await digestOf(stored)) !== record.digest) return undefined;
  const snapshot = acceptedSeedSnapshot(tryUtf8Json(stored));
  if (
    snapshot === undefined ||
    snapshot.revision !== record.revision ||
    snapshot.provenance.establishedAt !== record.seedEstablishedAt ||
    (await digestOf(jsonBytes(snapshot))) !== record.digest
  ) {
    return undefined;
  }
  return preparedSeed(record, snapshot, jsonBytes(snapshot));
}

async function resolveGroup(input: {
  readonly releaseGroupId: ReleaseGroupId;
  readonly store: ReleasePinStore;
  readonly seed: unknown;
}): Promise<GroupResolution> {
  const bytes = await input.store.readGroup(input.releaseGroupId);
  if (bytes === undefined) return Object.freeze({ status: "absent" });
  const record = parseReleaseGroupRecordBytes(bytes);
  if (record === undefined) return Object.freeze({ status: "broken" });
  const prepared =
    record.kind === "published"
      ? await hydratePublished(record, input.store)
      : await hydrateSeed(record, input.seed, input.store);
  if (prepared === undefined) return Object.freeze({ status: "broken" });
  return Object.freeze({ status: "ready", prepared });
}

async function assessFetchedCatalog(input: {
  readonly store: ReleasePinStore;
  readonly fetch: ModelCatalogProductionFetch;
}): Promise<PublishedMaterials | undefined> {
  const fetched = ProductionFetchResultSchema.safeParse(await input.fetch(MODEL_CATALOG_PUBLIC_URL));
  if (!fetched.success) {
    throw new CatalogReleasePinError("validation", "fetch client returned an invalid result");
  }
  if (fetched.data.kind === "unavailable") return undefined;
  if (fetched.data.bytes.byteLength > MODEL_CATALOG_MAX_BYTES) return undefined;
  const snapshot = acceptedPublishedSnapshot(tryUtf8Json(fetched.data.bytes));
  if (snapshot === undefined) return undefined;
  const retained = await input.store.getRetainedRevision(snapshot.revision);
  if (retained === undefined) return undefined;
  return publishedMaterialsFromParts({
    snapshot,
    recordBytes: retained.recordBytes,
    receiptBytes: retained.receiptBytes,
    etag: fetched.data.etag,
  });
}

async function highestValidRetained(
  store: ReleasePinStore,
  acquiredAt: string,
): Promise<PublishedMaterials | undefined> {
  for (const bundle of await store.listRetainedRevisions()) {
    const materials = await publishedMaterialsFromBundle(bundle);
    if (materials === undefined) continue;
    if (catalogAgeMs(acquiredAt, materials.snapshot.provenance.publishedAt) === undefined) continue;
    return materials;
  }
  return undefined;
}

async function persistPrepared(input: {
  readonly store: ReleasePinStore;
  readonly prepared: PreparedRelease;
  readonly seed: unknown;
}): Promise<PreparedRelease> {
  await input.store.putBytes({
    digest: input.prepared.record.digest,
    bytes: input.prepared.bytes,
  });
  if (input.prepared.record.kind === "published") {
    const retained = await input.store.getRetainedRevision(input.prepared.record.revision);
    if (retained === undefined) {
      throw new CatalogReleasePinError("integrity", "published pin is missing its retained bundle");
    }
    await input.store.putBytes({
      digest: input.prepared.record.publicationRecordDigest,
      bytes: retained.recordBytes,
    });
    await input.store.putBytes({
      digest: input.prepared.record.productionReceiptDigest,
      bytes: retained.receiptBytes,
    });
  }
  const sealed = jsonBytes(input.prepared.record);
  const created = await input.store.createGroup({
    releaseGroupId: input.prepared.record.releaseGroupId,
    bytes: sealed,
  });
  if (created.kind === "created") return input.prepared;
  const winner = parseReleaseGroupRecordBytes(created.bytes);
  if (winner === undefined) {
    throw new CatalogReleasePinError("unrecoverable", "existing release group is unrecoverable");
  }
  const hydrated =
    winner.kind === "published"
      ? await hydratePublished(winner, input.store)
      : await hydrateSeed(winner, input.seed, input.store);
  if (hydrated === undefined) {
    throw new CatalogReleasePinError("unrecoverable", "existing release group is unrecoverable");
  }
  return hydrated;
}

function requireGroupId(sourceCommit: string): ReleaseGroupId {
  const parsed = ReleaseGroupIdSchema.safeParse(sourceCommit);
  if (!parsed.success) {
    throw new CatalogReleasePinError(
      "validation",
      "sourceCommit must be a 40-character lowercase hex digest",
    );
  }
  return parsed.data;
}

function requireAcquisitionTime(acquisitionTime: string): IsoTimestamp {
  const parsed = IsoTimestampSchema.safeParse(acquisitionTime);
  if (!parsed.success) {
    throw new CatalogReleasePinError("validation", "acquisitionTime is not a valid timestamp");
  }
  return parsed.data;
}

export async function prepareReleaseGroup(
  input: PrepareReleaseGroupInput,
): Promise<PreparedRelease> {
  const releaseGroupId = requireGroupId(input.sourceCommit);
  const existing = await resolveGroup({
    releaseGroupId,
    store: input.store,
    seed: input.seed,
  });
  if (existing.status === "ready") return existing.prepared;
  if (existing.status === "broken") {
    throw new CatalogReleasePinError("unrecoverable", "existing release group is unrecoverable");
  }
  const acquiredAt = requireAcquisitionTime(input.acquisitionTime);
  const fetched = await assessFetchedCatalog({ store: input.store, fetch: input.fetch });
  let prepared: PreparedRelease;
  if (
    fetched !== undefined &&
    catalogAgeMs(acquiredAt, fetched.snapshot.provenance.publishedAt) !== undefined
  ) {
    prepared = await sealPublished({
      releaseGroupId,
      acquisition: "production-fetch",
      acquiredAt,
      materials: fetched,
    });
  } else {
    const retained = await highestValidRetained(input.store, acquiredAt);
    if (retained !== undefined) {
      prepared = await sealPublished({
        releaseGroupId,
        acquisition: "retained-production",
        acquiredAt,
        materials: retained,
      });
    } else {
      const seed = acceptedSeedSnapshot(input.seed);
      if (seed === undefined) {
        throw new CatalogReleasePinError("validation", "committed seed catalog is not usable");
      }
      prepared = await sealSeed({ releaseGroupId, acquiredAt, snapshot: seed });
    }
  }
  return persistPrepared({ store: input.store, prepared, seed: input.seed });
}

export async function readReleaseGroup(input: ReadReleaseGroupInput): Promise<PreparedRelease> {
  const releaseGroupId = requireGroupId(input.sourceCommit);
  const resolved = await resolveGroup({
    releaseGroupId,
    store: input.store,
    seed: input.seed,
  });
  if (resolved.status === "absent") {
    throw new CatalogReleasePinError("not-found", "release group not found");
  }
  if (resolved.status === "broken") {
    throw new CatalogReleasePinError("unrecoverable", "existing release group is unrecoverable");
  }
  return resolved.prepared;
}

export async function retainProductionCatalog(input: RetainProductionCatalogInput): Promise<void> {
  const recordParsed = ModelCatalogPublicationRecordSchema.safeParse(input.record);
  const receiptParsed = ModelCatalogDeploymentReceiptSchema.safeParse(input.receipt);
  if (!recordParsed.success || !receiptParsed.success) {
    throw new CatalogReleasePinError("validation", "retained production artifacts are invalid");
  }
  const record = recordParsed.data;
  const receipt = receiptParsed.data;
  if (record.catalog.provenance.kind !== "published") {
    throw new CatalogReleasePinError("validation", "retained catalog must be published");
  }
  const snapshot = acceptedPublishedSnapshot(record.catalog);
  if (snapshot === undefined) {
    throw new CatalogReleasePinError("validation", "retained catalog is not admissible");
  }
  const catalogBytes = jsonBytes(snapshot);
  if (catalogBytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogReleasePinError("validation", "retained catalog exceeds the size limit");
  }
  const catalogDigest = await digestOf(catalogBytes);
  if (catalogDigest !== record.catalogDigest) {
    throw new CatalogReleasePinError("integrity", "publication record digest does not match catalog");
  }
  if (!publicationRecordMatches(record, snapshot, catalogDigest)) {
    throw new CatalogReleasePinError("validation", "publication record does not match catalog");
  }
  if (!productionReceiptMatches(receipt, snapshot, catalogDigest)) {
    throw new CatalogReleasePinError("validation", "production receipt does not match catalog");
  }
  const recordBytes = jsonBytes(record);
  const receiptBytes = jsonBytes(receipt);
  const bundle: RetainedProductionBundle = {
    revision: snapshot.revision,
    catalogDigest,
    publicationRecordDigest: await digestOf(recordBytes),
    productionReceiptDigest: await digestOf(receiptBytes),
    catalogBytes,
    recordBytes,
    receiptBytes,
  };
  await input.store.putBytes({ digest: bundle.catalogDigest, bytes: bundle.catalogBytes });
  await input.store.putBytes({
    digest: bundle.publicationRecordDigest,
    bytes: bundle.recordBytes,
  });
  await input.store.putBytes({
    digest: bundle.productionReceiptDigest,
    bytes: bundle.receiptBytes,
  });
  await input.store.putRetainedRevision(bundle);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function renderGeneratedModelCatalogSeed(snapshot: unknown): string {
  return `${GENERATED_SEED_PREFIX}${JSON.stringify(snapshot, null, 2)}${GENERATED_SEED_SUFFIX}`;
}

function parseGeneratedSeedSource(contents: string) {
  if (!contents.startsWith(GENERATED_SEED_PREFIX) || !contents.endsWith(GENERATED_SEED_SUFFIX)) {
    return undefined;
  }
  try {
    return ModelCatalogSnapshotSchema.parse(
      JSON.parse(contents.slice(GENERATED_SEED_PREFIX.length, contents.length - GENERATED_SEED_SUFFIX.length)),
    );
  } catch {
    return undefined;
  }
}

async function verifyMaterializedSeed(
  path: string,
  prepared: PreparedRelease,
): Promise<MaterializedCatalogSeed> {
  const contents = await readFile(path, "utf8");
  const snapshot = parseGeneratedSeedSource(contents);
  if (snapshot === undefined) {
    throw new CatalogReleasePinError("integrity", "materialized seed did not parse as a catalog snapshot");
  }
  const digest = await digestOf(jsonBytes(snapshot));
  if (digest !== prepared.record.digest || snapshot.revision !== prepared.record.revision) {
    throw new CatalogReleasePinError(
      "integrity",
      "materialized seed digest or revision does not match the release pin",
    );
  }
  return Object.freeze({ path, digest, revision: snapshot.revision });
}

export async function materializeReleaseCatalog(
  input: MaterializeReleaseCatalogInput,
): Promise<MaterializedCatalogSeed> {
  if (!isAbsolute(input.workspaceRoot)) {
    throw new CatalogReleasePinError("validation", "workspaceRoot must be an absolute path");
  }
  const snapshotDigest = await digestOf(jsonBytes(input.prepared.snapshot));
  if (
    snapshotDigest !== input.prepared.record.digest ||
    input.prepared.snapshot.revision !== input.prepared.record.revision
  ) {
    throw new CatalogReleasePinError(
      "integrity",
      "prepared snapshot does not match the release pin",
    );
  }
  const path = join(input.workspaceRoot, MATERIALIZED_MODEL_CATALOG_SEED_PATH);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (existing !== undefined) {
    const parsed = parseGeneratedSeedSource(existing);
    if (parsed !== undefined) {
      const digest = await digestOf(jsonBytes(parsed));
      if (digest === input.prepared.record.digest && parsed.revision === input.prepared.record.revision) {
        return verifyMaterializedSeed(path, input.prepared);
      }
    }
  }
  const contents = renderGeneratedModelCatalogSeed(input.prepared.snapshot);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return verifyMaterializedSeed(path, input.prepared);
}
