import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type {
  CatalogPutResult,
  ModelCatalogPublicationStore,
  StoredCatalogObject,
} from "./model-catalog-publication.js";
import { MODEL_CATALOG_RECORD_MAX_BYTES } from "./model-catalog-constants.js";

export interface ModelCatalogR2StoreConfig {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

function requiredSetting(value: string | undefined, name: string, pattern: RegExp): string {
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

export function modelCatalogR2ConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ModelCatalogR2StoreConfig {
  return Object.freeze({
    accountId: requiredSetting(
      environment.ENDURAGENT_MODEL_CATALOG_ACCOUNT_ID,
      "ENDURAGENT_MODEL_CATALOG_ACCOUNT_ID",
      /^[a-f0-9]{32}$/u,
    ),
    accessKeyId: requiredSetting(
      environment.ENDURAGENT_MODEL_CATALOG_ACCESS_KEY_ID,
      "ENDURAGENT_MODEL_CATALOG_ACCESS_KEY_ID",
      /^[A-Za-z0-9_-]{16,256}$/u,
    ),
    secretAccessKey: requiredSetting(
      environment.ENDURAGENT_MODEL_CATALOG_SECRET_ACCESS_KEY,
      "ENDURAGENT_MODEL_CATALOG_SECRET_ACCESS_KEY",
      /^\S{16,512}$/u,
    ),
    bucket: requiredSetting(
      environment.ENDURAGENT_MODEL_CATALOG_BUCKET,
      "ENDURAGENT_MODEL_CATALOG_BUCKET",
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u,
    ),
  });
}

export function modelCatalogR2ClientConfig(
  config: ModelCatalogR2StoreConfig,
  overrides: Partial<S3ClientConfig> = {},
): S3ClientConfig {
  return {
    ...overrides,
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: 1,
  };
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 412
  );
}

export class ModelCatalogR2Store implements ModelCatalogPublicationStore {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: ModelCatalogR2StoreConfig, clientConfig: Partial<S3ClientConfig> = {}) {
    this.bucket = config.bucket;
    this.client = new S3Client(modelCatalogR2ClientConfig(config, clientConfig));
  }

  async get(key: string): Promise<StoredCatalogObject | undefined> {
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw error;
    }
    if (result.Body === undefined || result.ETag === undefined || result.ETag.length === 0) {
      throw new Error(`R2 object ${key} has no body or ETag`);
    }
    if (
      result.ContentLength !== undefined &&
      result.ContentLength > MODEL_CATALOG_RECORD_MAX_BYTES
    ) {
      throw new Error(`R2 object ${key} exceeds the publication object limit`);
    }
    const body = await result.Body.transformToByteArray();
    if (body.byteLength > MODEL_CATALOG_RECORD_MAX_BYTES) {
      throw new Error(`R2 object ${key} exceeds the publication object limit`);
    }
    return Object.freeze({
      body,
      etag: result.ETag,
      metadata: Object.freeze({ ...result.Metadata }),
    });
  }

  async put(
    key: string,
    body: Uint8Array,
    input: Parameters<ModelCatalogPublicationStore["put"]>[2],
  ): Promise<CatalogPutResult> {
    if (body.byteLength > MODEL_CATALOG_RECORD_MAX_BYTES) {
      throw new Error(`R2 object ${key} exceeds the publication object limit`);
    }
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json; charset=utf-8",
          Metadata: { ...input.metadata },
          ...(input.condition.kind === "absent"
            ? { IfNoneMatch: "*" }
            : { IfMatch: input.condition.etag }),
        }),
      );
      if (result.ETag === undefined || result.ETag.length === 0) {
        throw new Error(`R2 did not return an ETag for ${key}`);
      }
      return Object.freeze({ kind: "written", etag: result.ETag });
    } catch (error) {
      if (isPreconditionFailure(error)) return Object.freeze({ kind: "precondition-failed" });
      throw error;
    }
  }
}
