import {
  CatalogModelIdSchema,
  CatalogProviderIdSchema,
  MODEL_CATALOG_LIMITS,
  ModelCatalogDraftSchema,
  ModelCatalogSnapshotSchema,
  type ModelCatalogDraft,
  type ModelCatalogSnapshot,
} from "@enduragent/coach-contract/model-catalog";
import { z } from "zod";
import { bytesEqual, jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_CURRENT_KEY,
  MODEL_CATALOG_FUTURE_TOLERANCE_MS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
  MODEL_CATALOG_RECORD_MAX_BYTES,
} from "./model-catalog-constants.js";

const MAX_CONNECTIONS_PER_MODEL = 16;
const MAX_REFERENCE_CHARACTERS = 1_024;
const MAX_RECORD_KEY_CHARACTERS = 512;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RECORD_REFERENCE_PATTERN = /^record:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u;
const IMMUTABLE_RECORD_KEY_PATTERN = /^revisions\/[1-9]\d*\/[a-f0-9]{64}\.json$/u;

const EvidenceReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_REFERENCE_CHARACTERS)
  .superRefine((reference, context) => {
    if (RECORD_REFERENCE_PATTERN.test(reference)) return;
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      context.addIssue({ code: "custom", message: "evidence reference must use HTTPS or record:" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "evidence URL must use HTTPS without credentials or query parameters",
      });
    }
  });

const AdmissionCallEvidenceSchema = z
  .object({
    verifiedAt: z.string().datetime({ offset: true }),
    reference: EvidenceReferenceSchema,
  })
  .strict();

const ConnectionEvidenceSchema = z
  .object({
    connectionId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    textCall: AdmissionCallEvidenceSchema,
    toolCall: AdmissionCallEvidenceSchema,
    imageCall: AdmissionCallEvidenceSchema.optional(),
  })
  .strict();

const ModelAdmissionEvidenceSchema = z
  .object({
    providerId: CatalogProviderIdSchema,
    modelId: CatalogModelIdSchema,
    connections: z.array(ConnectionEvidenceSchema).min(1).max(MAX_CONNECTIONS_PER_MODEL),
    limitsSource: EvidenceReferenceSchema.optional(),
    pricingSource: EvidenceReferenceSchema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const connectionIds = new Set<string>();
    for (const [index, connection] of evidence.connections.entries()) {
      if (connectionIds.has(connection.connectionId)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "connectionId"],
          message: "connectionId must be unique for a model",
        });
      }
      connectionIds.add(connection.connectionId);
    }
  });

function evidenceIdentity(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function checkEvidenceCoverage(
  catalog: ModelCatalogDraft,
  evidence: readonly z.infer<typeof ModelAdmissionEvidenceSchema>[],
  context: z.core.$RefinementCtx,
): void {
  const catalogModels = new Map(
    catalog.providers.flatMap((provider) =>
      provider.models.map((model) => [evidenceIdentity(provider.providerId, model.modelId), model]),
    ),
  );
  const evidenceModels = new Set<string>();
  for (const [index, item] of evidence.entries()) {
    const identity = evidenceIdentity(item.providerId, item.modelId);
    if (evidenceModels.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index],
        message: "evidence must be unique for a provider and model",
      });
      continue;
    }
    evidenceModels.add(identity);
    const model = catalogModels.get(identity);
    if (model === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index],
        message: "evidence must reference a catalog model",
      });
      continue;
    }
    if (model.contextWindow.kind === "known" && item.limitsSource === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "limitsSource"],
        message: "known context limits require a source",
      });
    }
    if (model.pricing.kind === "token-rates" && item.pricingSource === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "pricingSource"],
        message: "known prices require a source",
      });
    }
    if (
      model.imageInput === "supported" &&
      item.connections.some((connection) => connection.imageCall === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "connections"],
        message: "advertised image input requires evidence for every connection",
      });
    }
  }
  for (const [identity] of catalogModels) {
    if (!evidenceModels.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "every model needs evidence",
      });
    }
  }
}

const ModelAdmissionEvidenceListSchema = z
  .array(ModelAdmissionEvidenceSchema)
  .max(MODEL_CATALOG_LIMITS.providers * MODEL_CATALOG_LIMITS.modelsPerProvider);

export const ModelCatalogPublicationFileSchema = z
  .object({
    catalog: ModelCatalogDraftSchema,
    evidence: ModelAdmissionEvidenceListSchema,
  })
  .strict()
  .superRefine((value, context) => checkEvidenceCoverage(value.catalog, value.evidence, context));

const PublicationActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publish") }).strict(),
  z
    .object({ kind: z.literal("rollback"), sourceRevision: z.number().int().positive().safe() })
    .strict(),
]);

export const ModelCatalogPublicationRecordSchema = z
  .object({
    formatVersion: z.literal(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION),
    revision: z.number().int().positive().safe(),
    previousRevision: z.number().int().nonnegative().safe(),
    publishedAt: z.string().datetime({ offset: true }),
    catalogDigest: z.string().regex(DIGEST_PATTERN),
    action: PublicationActionSchema,
    catalog: ModelCatalogSnapshotSchema,
    evidence: ModelAdmissionEvidenceListSchema,
  })
  .strict()
  .superRefine((record, context) => {
    checkEvidenceCoverage(record.catalog, record.evidence, context);
    if (record.revision !== record.catalog.revision) {
      context.addIssue({
        code: "custom",
        path: ["catalog", "revision"],
        message: "revision mismatch",
      });
    }
    if (record.previousRevision >= record.revision) {
      context.addIssue({
        code: "custom",
        path: ["previousRevision"],
        message: "previousRevision must be lower than revision",
      });
    }
    if (
      record.catalog.provenance.kind !== "published" ||
      record.catalog.provenance.publishedAt !== record.publishedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["catalog", "provenance"],
        message: "catalog provenance must match publishedAt",
      });
    }
    if (record.action.kind === "rollback" && record.action.sourceRevision >= record.revision) {
      context.addIssue({
        code: "custom",
        path: ["action", "sourceRevision"],
        message: "rollback source must be older than the new revision",
      });
    }
  });

const CommittedRevisionSchema = z
  .object({
    formatVersion: z.literal(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION),
    revision: z.number().int().positive().safe(),
    catalogDigest: z.string().regex(DIGEST_PATTERN),
    recordKey: z.string().min(1).max(MAX_RECORD_KEY_CHARACTERS).regex(IMMUTABLE_RECORD_KEY_PATTERN),
  })
  .strict();

const CurrentMetadataSchema = z
  .object({
    "format-version": z.literal(String(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION)),
    revision: z.string().regex(/^[1-9]\d*$/u),
    "catalog-digest": z.string().regex(DIGEST_PATTERN),
    "published-at": z.string().datetime({ offset: true }),
    "record-key": z
      .string()
      .min(1)
      .max(MAX_RECORD_KEY_CHARACTERS)
      .regex(IMMUTABLE_RECORD_KEY_PATTERN),
  })
  .passthrough();

export type ModelCatalogPublicationFile = z.infer<typeof ModelCatalogPublicationFileSchema>;
export type ModelCatalogPublicationRecord = z.infer<typeof ModelCatalogPublicationRecordSchema>;
export type ModelCatalogPublicationAction = z.infer<typeof PublicationActionSchema>;

export interface StoredCatalogObject {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type CatalogPutCondition =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "etag"; etag: string }>;

export type CatalogPutResult =
  | Readonly<{ kind: "written"; etag: string }>
  | Readonly<{ kind: "precondition-failed" }>;

export interface ModelCatalogPublicationStore {
  get(key: string): Promise<StoredCatalogObject | undefined>;
  put(
    key: string,
    body: Uint8Array,
    input: Readonly<{
      condition: CatalogPutCondition;
      metadata: Readonly<Record<string, string>>;
    }>,
  ): Promise<CatalogPutResult>;
}

export interface CatalogDiff {
  readonly additions: readonly string[];
  readonly removals: readonly string[];
  readonly changes: readonly string[];
}

export interface CatalogPublicationReceipt {
  readonly action: ModelCatalogPublicationAction;
  readonly revision: number;
  readonly previousRevision: number;
  readonly publishedAt: string;
  readonly catalogDigest: string;
  readonly publishedEtag: string | null;
  readonly advancedBeforeReceipt: boolean;
  readonly recordKey: string;
  readonly recoveredAfterUncertainWrite: boolean;
  readonly diff: CatalogDiff;
}

interface CurrentCatalog {
  readonly snapshot: ModelCatalogSnapshot;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly etag: string;
  readonly publishedAt: string;
  readonly recordKey: string;
}

export class CatalogPublicationError extends Error {
  constructor(
    readonly code: "conflict" | "integrity" | "not-found" | "uncertain" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "CatalogPublicationError";
  }
}

function assertCatalogSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogPublicationError("validation", "catalog exceeds the 512 KiB limit");
  }
}

function assertPublicationRecordSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MODEL_CATALOG_RECORD_MAX_BYTES) {
    throw new CatalogPublicationError("validation", "publication record exceeds the 2 MiB limit");
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogPublicationError("integrity", `${label} is not valid UTF-8 JSON`);
  }
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

export function parseModelCatalogPublicationFile(input: unknown): ModelCatalogPublicationFile {
  const parsed = ModelCatalogPublicationFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new CatalogPublicationError("validation", validationMessage(parsed.error));
  }
  return parsed.data;
}

export async function validateModelCatalogPublicationFile(
  input: unknown,
  now = Date.now(),
): Promise<ModelCatalogPublicationFile> {
  const file = parseModelCatalogPublicationFile(input);
  await createRecord({
    file,
    revision: 1,
    previousRevision: 0,
    publishedAt: publicationTimestamp(now),
    action: { kind: "publish" },
  });
  return file;
}

function modelFields(model: ModelCatalogSnapshot["providers"][number]["models"][number]) {
  return {
    label: model.label,
    order: model.order,
    hint: model.hint,
    compatibilityProfile: model.compatibilityProfile,
    contextWindow: model.contextWindow,
    imageInput: model.imageInput,
    pricing: model.pricing,
  };
}

const MODEL_METADATA_FIELDS = [
  "label",
  "order",
  "hint",
  "compatibilityProfile",
  "contextWindow",
  "imageInput",
  "pricing",
] as const;

export function diffModelCatalogs(
  previous: Pick<ModelCatalogSnapshot, "providers"> | undefined,
  candidate: Pick<ModelCatalogDraft, "providers">,
): CatalogDiff {
  const additions: string[] = [];
  const removals: string[] = [];
  const changes: string[] = [];
  const previousProviders = new Map(
    previous?.providers.map((provider) => [provider.providerId, provider]),
  );
  const candidateProviders = new Map(
    candidate.providers.map((provider) => [provider.providerId, provider]),
  );
  for (const provider of candidate.providers) {
    const before = previousProviders.get(provider.providerId);
    if (before === undefined) additions.push(`provider:${provider.providerId}`);
    else {
      for (const field of ["label", "order", "hint", "recommendedModelId"] as const) {
        if (JSON.stringify(before[field]) !== JSON.stringify(provider[field])) {
          changes.push(`provider:${provider.providerId}.${field}`);
        }
      }
    }
    const beforeModels = new Map(before?.models.map((model) => [model.modelId, model]));
    for (const model of provider.models) {
      const priorModel = beforeModels.get(model.modelId);
      if (priorModel === undefined) additions.push(`model:${provider.providerId}/${model.modelId}`);
      else {
        const beforeFields = modelFields(priorModel);
        const afterFields = modelFields(model);
        for (const field of MODEL_METADATA_FIELDS) {
          if (JSON.stringify(beforeFields[field]) !== JSON.stringify(afterFields[field])) {
            changes.push(`model:${provider.providerId}/${model.modelId}.${field}`);
          }
        }
      }
    }
  }
  for (const provider of previous?.providers ?? []) {
    const after = candidateProviders.get(provider.providerId);
    if (after === undefined) {
      removals.push(`provider:${provider.providerId}`);
      continue;
    }
    const afterModels = new Set(after.models.map((model) => model.modelId));
    for (const model of provider.models) {
      if (!afterModels.has(model.modelId))
        removals.push(`model:${provider.providerId}/${model.modelId}`);
    }
  }
  return Object.freeze({
    additions: Object.freeze(additions.sort()),
    removals: Object.freeze(removals.sort()),
    changes: Object.freeze(changes.sort()),
  });
}

function publicationTimestamp(now: number): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new CatalogPublicationError("validation", "publication clock is invalid");
  }
  return new Date(now).toISOString();
}

function assertEvidenceTimes(file: ModelCatalogPublicationFile, publishedAt: string): void {
  const latestAllowed = Date.parse(publishedAt) + MODEL_CATALOG_FUTURE_TOLERANCE_MS;
  for (const model of file.evidence) {
    for (const connection of model.connections) {
      for (const call of [connection.textCall, connection.toolCall, connection.imageCall]) {
        if (call !== undefined && Date.parse(call.verifiedAt) > latestAllowed) {
          throw new CatalogPublicationError(
            "validation",
            "admission evidence is implausibly future-dated",
          );
        }
      }
    }
  }
}

function recordKey(revision: number, digest: string): string {
  return `revisions/${revision}/${digest}.json`;
}

function committedKey(revision: number): string {
  return `committed/${revision}.json`;
}

function currentMetadata(
  record: ModelCatalogPublicationRecord,
  key: string,
): Record<string, string> {
  return {
    "format-version": String(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION),
    revision: String(record.revision),
    "catalog-digest": record.catalogDigest,
    "published-at": record.publishedAt,
    "record-key": key,
  };
}

async function parseCurrentObject(object: StoredCatalogObject): Promise<CurrentCatalog> {
  assertCatalogSize(object.body);
  if (object.etag.length === 0 || object.etag.length > 1_024) {
    throw new CatalogPublicationError("integrity", "current catalog ETag is invalid");
  }
  const parsedSnapshot = ModelCatalogSnapshotSchema.safeParse(
    parseJsonBytes(object.body, "current catalog"),
  );
  if (!parsedSnapshot.success || parsedSnapshot.data.provenance.kind !== "published") {
    throw new CatalogPublicationError(
      "integrity",
      "current catalog does not match the shared schema",
    );
  }
  const parsedMetadata = CurrentMetadataSchema.safeParse(object.metadata);
  if (!parsedMetadata.success) {
    throw new CatalogPublicationError("integrity", "current catalog metadata is invalid");
  }
  const digest = (await sha256(object.body)).hex;
  const revision = Number(parsedMetadata.data.revision);
  const expectedRecordKey = recordKey(revision, digest);
  if (
    !Number.isSafeInteger(revision) ||
    revision !== parsedSnapshot.data.revision ||
    digest !== parsedMetadata.data["catalog-digest"] ||
    parsedSnapshot.data.provenance.publishedAt !== parsedMetadata.data["published-at"] ||
    parsedMetadata.data["record-key"] !== expectedRecordKey
  ) {
    throw new CatalogPublicationError(
      "integrity",
      "current catalog metadata does not match its bytes",
    );
  }
  return Object.freeze({
    snapshot: parsedSnapshot.data,
    bytes: object.body,
    digest,
    etag: object.etag,
    publishedAt: parsedMetadata.data["published-at"],
    recordKey: parsedMetadata.data["record-key"],
  });
}

async function readCurrent(
  store: ModelCatalogPublicationStore,
): Promise<CurrentCatalog | undefined> {
  const object = await store.get(MODEL_CATALOG_CURRENT_KEY);
  return object === undefined ? undefined : parseCurrentObject(object);
}

async function parsePublicationRecordObject(
  object: StoredCatalogObject,
): Promise<ModelCatalogPublicationRecord> {
  const parsed = ModelCatalogPublicationRecordSchema.safeParse(
    parseJsonBytes(object.body, "publication record"),
  );
  if (!parsed.success) {
    throw new CatalogPublicationError("integrity", "publication record does not match its schema");
  }
  const digest = (await sha256(jsonBytes(parsed.data.catalog))).hex;
  if (digest !== parsed.data.catalogDigest) {
    throw new CatalogPublicationError(
      "integrity",
      "publication record digest does not match catalog",
    );
  }
  return parsed.data;
}

async function putImmutable(
  store: ModelCatalogPublicationStore,
  key: string,
  body: Uint8Array,
  metadata: Readonly<Record<string, string>>,
): Promise<void> {
  const matches = (object: StoredCatalogObject | undefined) =>
    object !== undefined && bytesEqual(object.body, body);
  const existing = await store.get(key);
  if (existing !== undefined) {
    if (matches(existing)) return;
    throw new CatalogPublicationError("conflict", `${key} already contains different bytes`);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await store.put(key, body, { condition: { kind: "absent" }, metadata });
      if (result.kind === "written") return;
    } catch {
      const afterError = await store.get(key);
      if (matches(afterError)) return;
      if (afterError !== undefined) {
        throw new CatalogPublicationError("conflict", `${key} changed during publication`);
      }
      if (attempt === 0) continue;
      throw new CatalogPublicationError(
        "uncertain",
        `${key} write remains uncertain after read-back`,
      );
    }
    const afterConflict = await store.get(key);
    if (matches(afterConflict)) return;
    throw new CatalogPublicationError("conflict", `${key} changed during publication`);
  }
}

function committedMarker(record: ModelCatalogPublicationRecord, key: string) {
  return CommittedRevisionSchema.parse({
    formatVersion: MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
    revision: record.revision,
    catalogDigest: record.catalogDigest,
    recordKey: key,
  });
}

async function ensureCommittedCurrent(
  store: ModelCatalogPublicationStore,
  current: CurrentCatalog | undefined,
): Promise<void> {
  if (current === undefined) return;
  const recordObject = await store.get(current.recordKey);
  if (recordObject === undefined) {
    throw new CatalogPublicationError("integrity", "current catalog publication record is missing");
  }
  const record = await parsePublicationRecordObject(recordObject);
  if (record.revision !== current.snapshot.revision || record.catalogDigest !== current.digest) {
    throw new CatalogPublicationError(
      "integrity",
      "current catalog publication record does not match",
    );
  }
  await putImmutable(
    store,
    committedKey(record.revision),
    jsonBytes(committedMarker(record, current.recordKey)),
    {
      "object-type": "committed-revision",
    },
  );
}

async function readCommittedRecord(
  store: ModelCatalogPublicationStore,
  revision: number,
): Promise<ModelCatalogPublicationRecord> {
  const markerObject = await store.get(committedKey(revision));
  if (markerObject === undefined) {
    throw new CatalogPublicationError("not-found", `committed revision ${revision} was not found`);
  }
  const marker = CommittedRevisionSchema.safeParse(
    parseJsonBytes(markerObject.body, "committed revision"),
  );
  if (!marker.success || marker.data.revision !== revision) {
    throw new CatalogPublicationError("integrity", `committed revision ${revision} is invalid`);
  }
  const recordObject = await store.get(marker.data.recordKey);
  if (recordObject === undefined) {
    throw new CatalogPublicationError(
      "integrity",
      `revision ${revision} publication record is missing`,
    );
  }
  const record = await parsePublicationRecordObject(recordObject);
  if (
    record.revision !== revision ||
    record.catalogDigest !== marker.data.catalogDigest ||
    marker.data.recordKey !== recordKey(revision, record.catalogDigest)
  ) {
    throw new CatalogPublicationError(
      "integrity",
      `revision ${revision} publication record does not match`,
    );
  }
  return record;
}

function sameCurrent(
  current: CurrentCatalog | undefined,
  expected: CurrentCatalog | undefined,
): boolean {
  if (current === undefined || expected === undefined) return current === expected;
  return current.etag === expected.etag && current.snapshot.revision === expected.snapshot.revision;
}

function isTarget(
  current: CurrentCatalog | undefined,
  record: ModelCatalogPublicationRecord,
): boolean {
  return (
    current !== undefined &&
    current.snapshot.revision === record.revision &&
    current.digest === record.catalogDigest
  );
}

async function isCommittedTarget(
  store: ModelCatalogPublicationStore,
  record: ModelCatalogPublicationRecord,
  key: string,
): Promise<boolean> {
  const markerObject = await store.get(committedKey(record.revision));
  if (markerObject === undefined) return false;
  const marker = CommittedRevisionSchema.safeParse(
    parseJsonBytes(markerObject.body, "committed revision"),
  );
  if (!marker.success) {
    throw new CatalogPublicationError(
      "integrity",
      `committed revision ${record.revision} is invalid`,
    );
  }
  return (
    marker.data.revision === record.revision &&
    marker.data.catalogDigest === record.catalogDigest &&
    marker.data.recordKey === key
  );
}

async function reconcileReplacement(
  store: ModelCatalogPublicationStore,
  observed: CurrentCatalog | undefined,
  record: ModelCatalogPublicationRecord,
  key: string,
  publishedEtag: string | null,
  recovered: boolean,
): Promise<
  | {
      readonly publishedEtag: string | null;
      readonly recovered: boolean;
      readonly advancedBeforeReceipt: boolean;
    }
  | undefined
> {
  if (observed !== undefined && isTarget(observed, record)) {
    return { publishedEtag: observed.etag, recovered, advancedBeforeReceipt: false };
  }
  if (
    observed !== undefined &&
    observed.snapshot.revision > record.revision &&
    (await isCommittedTarget(store, record, key))
  ) {
    return { publishedEtag, recovered, advancedBeforeReceipt: true };
  }
  return undefined;
}

async function replaceCurrent(
  store: ModelCatalogPublicationStore,
  expected: CurrentCatalog | undefined,
  record: ModelCatalogPublicationRecord,
  key: string,
): Promise<{
  readonly publishedEtag: string | null;
  readonly recovered: boolean;
  readonly advancedBeforeReceipt: boolean;
}> {
  const body = jsonBytes(record.catalog);
  const metadata = currentMetadata(record, key);
  const condition: CatalogPutCondition =
    expected === undefined ? { kind: "absent" } : { kind: "etag", etag: expected.etag };
  let recovered = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await store.put(MODEL_CATALOG_CURRENT_KEY, body, { condition, metadata });
      if (result.kind === "precondition-failed") {
        const afterConflict = await readCurrent(store);
        const replacement = await reconcileReplacement(
          store,
          afterConflict,
          record,
          key,
          null,
          recovered,
        );
        if (replacement !== undefined) return replacement;
        throw new CatalogPublicationError("conflict", "current catalog changed during publication");
      }
      const written = await readCurrent(store);
      const replacement = await reconcileReplacement(
        store,
        written,
        record,
        key,
        result.etag,
        recovered,
      );
      if (replacement !== undefined) return replacement;
      throw new CatalogPublicationError("integrity", "published current catalog failed read-back");
    } catch (error) {
      if (error instanceof CatalogPublicationError) throw error;
      recovered = true;
      const afterError = await readCurrent(store);
      const replacement = await reconcileReplacement(
        store,
        afterError,
        record,
        key,
        null,
        recovered,
      );
      if (replacement !== undefined) return replacement;
      if (!sameCurrent(afterError, expected)) {
        throw new CatalogPublicationError(
          "conflict",
          "current catalog changed after an uncertain write",
        );
      }
      if (attempt === 0) continue;
      throw new CatalogPublicationError(
        "uncertain",
        "current catalog write remains uncertain after read-back",
      );
    }
  }
  throw new CatalogPublicationError("uncertain", "current catalog write did not complete");
}

async function createRecord(input: {
  readonly file: ModelCatalogPublicationFile;
  readonly revision: number;
  readonly previousRevision: number;
  readonly publishedAt: string;
  readonly action: ModelCatalogPublicationAction;
}): Promise<ModelCatalogPublicationRecord> {
  assertEvidenceTimes(input.file, input.publishedAt);
  const catalog = ModelCatalogSnapshotSchema.parse({
    schemaVersion: input.file.catalog.schemaVersion,
    revision: input.revision,
    provenance: { kind: "published", publishedAt: input.publishedAt },
    providers: input.file.catalog.providers,
  });
  const catalogBytes = jsonBytes(catalog);
  assertCatalogSize(catalogBytes);
  const catalogDigest = (await sha256(catalogBytes)).hex;
  const record = ModelCatalogPublicationRecordSchema.parse({
    formatVersion: MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
    revision: input.revision,
    previousRevision: input.previousRevision,
    publishedAt: input.publishedAt,
    catalogDigest,
    action: input.action,
    catalog,
    evidence: input.file.evidence,
  });
  assertPublicationRecordSize(jsonBytes(record));
  return record;
}

async function publishRecord(input: {
  readonly store: ModelCatalogPublicationStore;
  readonly expectedRevision: number;
  readonly file: ModelCatalogPublicationFile;
  readonly action: ModelCatalogPublicationAction;
  readonly now: number;
}): Promise<CatalogPublicationReceipt> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CatalogPublicationError(
      "validation",
      "expected revision must be a non-negative integer",
    );
  }
  const current = await readCurrent(input.store);
  const actualRevision = current?.snapshot.revision ?? 0;
  if (actualRevision !== input.expectedRevision) {
    throw new CatalogPublicationError(
      "conflict",
      `expected revision ${input.expectedRevision}, found ${actualRevision}`,
    );
  }
  await ensureCommittedCurrent(input.store, current);
  const revision = actualRevision + 1;
  const record = await createRecord({
    file: input.file,
    revision,
    previousRevision: actualRevision,
    publishedAt: publicationTimestamp(input.now),
    action: input.action,
  });
  const key = recordKey(record.revision, record.catalogDigest);
  await putImmutable(input.store, key, jsonBytes(record), { "object-type": "publication-record" });
  const replacement = await replaceCurrent(input.store, current, record, key);
  await putImmutable(
    input.store,
    committedKey(record.revision),
    jsonBytes(committedMarker(record, key)),
    { "object-type": "committed-revision" },
  );
  return Object.freeze({
    action: record.action,
    revision: record.revision,
    previousRevision: record.previousRevision,
    publishedAt: record.publishedAt,
    catalogDigest: record.catalogDigest,
    publishedEtag: replacement.publishedEtag,
    advancedBeforeReceipt: replacement.advancedBeforeReceipt,
    recordKey: key,
    recoveredAfterUncertainWrite: replacement.recovered,
    diff: diffModelCatalogs(current?.snapshot, record.catalog),
  });
}

export async function publishModelCatalog(input: {
  readonly store: ModelCatalogPublicationStore;
  readonly expectedRevision: number;
  readonly publicationFile: unknown;
  readonly now?: number;
}): Promise<CatalogPublicationReceipt> {
  return publishRecord({
    store: input.store,
    expectedRevision: input.expectedRevision,
    file: parseModelCatalogPublicationFile(input.publicationFile),
    action: { kind: "publish" },
    now: input.now ?? Date.now(),
  });
}

export async function rollbackModelCatalog(input: {
  readonly store: ModelCatalogPublicationStore;
  readonly sourceRevision: number;
  readonly expectedRevision: number;
  readonly now?: number;
}): Promise<CatalogPublicationReceipt> {
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0) {
    throw new CatalogPublicationError("validation", "source revision must be a positive integer");
  }
  const source = await readCommittedRecord(input.store, input.sourceRevision);
  return publishRecord({
    store: input.store,
    expectedRevision: input.expectedRevision,
    file: {
      catalog: { schemaVersion: source.catalog.schemaVersion, providers: source.catalog.providers },
      evidence: source.evidence,
    },
    action: { kind: "rollback", sourceRevision: source.revision },
    now: input.now ?? Date.now(),
  });
}
