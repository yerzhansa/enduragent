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
  MODEL_CATALOG_FUTURE_TOLERANCE_MS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
  MODEL_CATALOG_RECORD_MAX_BYTES,
} from "./model-catalog-constants.js";

const MAX_CONNECTIONS_PER_MODEL = 16;
const MAX_REFERENCE_CHARACTERS = 1_024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RECORD_REFERENCE_PATTERN = /^record:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u;

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
  for (const identity of catalogModels.keys()) {
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
  .object({ catalog: ModelCatalogDraftSchema, evidence: ModelAdmissionEvidenceListSchema })
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
    if (record.revision !== record.previousRevision + 1) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "revision must immediately follow previousRevision",
      });
    }
    if (record.revision !== record.catalog.revision) {
      context.addIssue({
        code: "custom",
        path: ["catalog", "revision"],
        message: "revision mismatch",
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

export const ModelCatalogTargetSchema = z.enum(["staging", "production"]);

export const ModelCatalogDeploymentReceiptSchema = z
  .object({
    formatVersion: z.literal(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION),
    target: ModelCatalogTargetSchema,
    revision: z.number().int().positive().safe(),
    catalogDigest: z.string().regex(DIGEST_PATTERN),
    workerName: z.string().min(1).max(255),
    versionId: z.string().min(1).max(255).nullable(),
    deploymentId: z.string().min(1).max(255).nullable(),
    liveEtag: z.string().min(1).max(1_024),
    verifiedAt: z.string().datetime({ offset: true }),
    tag: z.string().min(1).max(255),
    message: z.string().min(1).max(1_000),
    uncertaintyRecovery: z.enum([
      "none",
      "verified-after-uncertain-response",
      "retried-after-unchanged-predecessor",
      "reconciled-existing-intended-deployment",
    ]),
  })
  .strict();

export type ModelCatalogPublicationFile = z.infer<typeof ModelCatalogPublicationFileSchema>;
export type ModelCatalogPublicationRecord = z.infer<typeof ModelCatalogPublicationRecordSchema>;
export type ModelCatalogPublicationAction = z.infer<typeof PublicationActionSchema>;
export type ModelCatalogTarget = z.infer<typeof ModelCatalogTargetSchema>;
export type ModelCatalogDeploymentReceipt = z.infer<typeof ModelCatalogDeploymentReceiptSchema>;

export interface CatalogDiff {
  readonly additions: readonly string[];
  readonly removals: readonly string[];
  readonly changes: readonly string[];
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

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

export function parseModelCatalogPublicationFile(input: unknown): ModelCatalogPublicationFile {
  const parsed = ModelCatalogPublicationFileSchema.safeParse(input);
  if (!parsed.success)
    throw new CatalogPublicationError("validation", validationMessage(parsed.error));
  return parsed.data;
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

function assertCatalogSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogPublicationError("validation", "catalog exceeds the 512 KiB limit");
  }
}

function assertRecordSize(bytes: Uint8Array): void {
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
  assertRecordSize(jsonBytes(record));
  return record;
}

export async function buildModelCatalogPublicationRecord(input: {
  readonly publicationFile: unknown;
  readonly revision: number;
  readonly previousRevision: number;
  readonly now: number;
}): Promise<ModelCatalogPublicationRecord> {
  return createRecord({
    file: parseModelCatalogPublicationFile(input.publicationFile),
    revision: input.revision,
    previousRevision: input.previousRevision,
    publishedAt: publicationTimestamp(input.now),
    action: { kind: "publish" },
  });
}

export async function buildModelCatalogRollbackRecord(input: {
  readonly source: ModelCatalogPublicationRecord;
  readonly revision: number;
  readonly previousRevision: number;
  readonly now: number;
}): Promise<ModelCatalogPublicationRecord> {
  return createRecord({
    file: {
      catalog: {
        schemaVersion: input.source.catalog.schemaVersion,
        providers: input.source.catalog.providers,
      },
      evidence: input.source.evidence,
    },
    revision: input.revision,
    previousRevision: input.previousRevision,
    publishedAt: publicationTimestamp(input.now),
    action: { kind: "rollback", sourceRevision: input.source.revision },
  });
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

export function modelCatalogBytes(record: ModelCatalogPublicationRecord): Uint8Array {
  return jsonBytes(record.catalog);
}

export function modelCatalogPublicationRecordBytes(
  record: ModelCatalogPublicationRecord,
): Uint8Array {
  return jsonBytes(record);
}

export async function parseModelCatalogPublicationRecordBytes(
  bytes: Uint8Array,
): Promise<ModelCatalogPublicationRecord> {
  assertRecordSize(bytes);
  const parsed = ModelCatalogPublicationRecordSchema.safeParse(
    parseJsonBytes(bytes, "publication record"),
  );
  if (!parsed.success) {
    throw new CatalogPublicationError("integrity", "publication record does not match its schema");
  }
  if (!bytesEqual(bytes, jsonBytes(parsed.data))) {
    throw new CatalogPublicationError("integrity", "publication record bytes are not canonical");
  }
  const catalogBytes = modelCatalogBytes(parsed.data);
  assertCatalogSize(catalogBytes);
  if ((await sha256(catalogBytes)).hex !== parsed.data.catalogDigest) {
    throw new CatalogPublicationError(
      "integrity",
      "publication record digest does not match catalog",
    );
  }
  return parsed.data;
}

export function modelCatalogDeploymentReceiptBytes(
  receipt: ModelCatalogDeploymentReceipt,
): Uint8Array {
  return jsonBytes(ModelCatalogDeploymentReceiptSchema.parse(receipt));
}

export function parseModelCatalogDeploymentReceiptBytes(
  bytes: Uint8Array,
): ModelCatalogDeploymentReceipt {
  const parsed = ModelCatalogDeploymentReceiptSchema.safeParse(
    parseJsonBytes(bytes, "deployment receipt"),
  );
  if (!parsed.success || !bytesEqual(bytes, jsonBytes(parsed.data))) {
    throw new CatalogPublicationError("integrity", "deployment receipt is invalid");
  }
  return parsed.data;
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
