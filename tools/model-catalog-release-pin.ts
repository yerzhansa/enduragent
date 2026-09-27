import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { acceptModelCatalogSnapshot } from "../packages/core/src/model-catalog.js";
import { z } from "zod";
import { bytesEqual, jsonBytes, sha256 } from "./model-catalog-bytes.js";
import { MODEL_CATALOG_MAX_BYTES } from "./model-catalog-constants.js";

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

export const BundledSeedProvenanceSchema = z
  .object({
    kind: z.literal("bundled-seed"),
    establishedAt: IsoTimestampField })
  .strict();

export const BundledSeedSnapshotSchema = ModelCatalogSnapshotSchema.extend({
  provenance: BundledSeedProvenanceSchema,
}).strict();

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
export const ReleaseCatalogPinSchema = BundledSeedReleasePinObjectSchema;
export const BundledSeedReleaseGroupRecordSchema = BundledSeedReleasePinObjectSchema.extend({
  releaseGroupId: ReleaseGroupIdSchema,
}).strict();
export const ReleaseGroupRecordSchema = BundledSeedReleaseGroupRecordSchema;

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type CatalogDigest = z.infer<typeof CatalogDigestSchema>;
export type ReleaseGroupId = z.infer<typeof ReleaseGroupIdSchema>;
export type BundledSeedSnapshot = z.infer<typeof BundledSeedSnapshotSchema>;
export type ReleaseCatalogPin = z.infer<typeof ReleaseCatalogPinSchema>;
export type BundledSeedReleasePin = z.infer<typeof BundledSeedReleasePinSchema>;
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

export type PreparedRelease = Readonly<{
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
}

export type PrepareReleaseGroupInput = {
  readonly sourceCommit: string;
  readonly store: ReleasePinStore;
  readonly acquisitionTime: string;
  readonly seed: unknown;
};

export type ReadReleaseGroupInput = {
  readonly sourceCommit: string;
  readonly store: ReleasePinStore;
  readonly seed: unknown;
};

type GroupResolution =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "ready"; prepared: PreparedRelease }>
  | Readonly<{ status: "broken" }>;

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

export function createMemoryReleasePinStore(): ReleasePinStore {
  const groups = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
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
  return parsed.data;
}

function acceptedSeedSnapshot(candidate: unknown): BundledSeedSnapshot | undefined {
  const parsed = BundledSeedSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  if (acceptModelCatalogSnapshot(parsed.data) === undefined) return undefined;
  return parsed.data;
}

function bindingOf(record: ReleaseGroupRecord): ReleaseBinding {
  return Object.freeze({
    releaseGroupId: record.releaseGroupId,
    revision: record.revision,
    digest: record.digest,
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
  const prepared = await hydrateSeed(record, input.seed, input.store);
  if (prepared === undefined) return Object.freeze({ status: "broken" });
  return Object.freeze({ status: "ready", prepared });
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
  const hydrated = await hydrateSeed(winner, input.seed, input.store);
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
  const seed = acceptedSeedSnapshot(input.seed);
  if (seed === undefined) {
    throw new CatalogReleasePinError("validation", "committed seed catalog is not usable");
  }
  const prepared = await sealSeed({ releaseGroupId, acquiredAt, snapshot: seed });
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
      JSON.parse(
        contents.slice(GENERATED_SEED_PREFIX.length, contents.length - GENERATED_SEED_SUFFIX.length),
      ),
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
    throw new CatalogReleasePinError(
      "integrity",
      "materialized seed did not parse as a catalog snapshot",
    );
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
      if (
        digest === input.prepared.record.digest &&
        parsed.revision === input.prepared.record.revision
      ) {
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
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return verifyMaterializedSeed(path, input.prepared);
}
