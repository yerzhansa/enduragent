import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_CURRENT_KEY,
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
  MODEL_CATALOG_PUBLIC_PATH,
} from "./model-catalog-constants.js";

export interface ModelCatalogR2ObjectBody {
  readonly size: number;
  readonly httpEtag: string;
  readonly customMetadata: Readonly<Record<string, string>>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ModelCatalogR2Bucket {
  get(key: string): Promise<ModelCatalogR2ObjectBody | null>;
}

export interface ModelCatalogWorkerEnvironment {
  readonly MODEL_CATALOG: ModelCatalogR2Bucket;
}

function empty(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function validHttpEtag(value: string): boolean {
  return /^"[\x20-\x7e]+"$/u.test(value) && value.length <= 1_024;
}

function ifNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const target = etag.startsWith("W/") ? etag.slice(2) : etag;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    if (value === "*") return true;
    return (value.startsWith("W/") ? value.slice(2) : value) === target;
  });
}

function currentMetadataMatches(
  metadata: Readonly<Record<string, string>>,
  revision: number,
  publishedAt: string,
  digest: string,
): boolean {
  return (
    metadata["format-version"] === String(MODEL_CATALOG_PUBLICATION_FORMAT_VERSION) &&
    metadata.revision === String(revision) &&
    metadata["published-at"] === publishedAt &&
    metadata["catalog-digest"] === digest &&
    /^revisions\/[1-9]\d*\/[a-f0-9]{64}\.json$/u.test(metadata["record-key"] ?? "")
  );
}

export async function handleModelCatalogRequest(
  request: Request,
  environment: ModelCatalogWorkerEnvironment,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.pathname !== MODEL_CATALOG_PUBLIC_PATH) {
    return empty(404);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return empty(405, { Allow: "GET, HEAD" });
  }
  let object: ModelCatalogR2ObjectBody | null;
  try {
    object = await environment.MODEL_CATALOG.get(MODEL_CATALOG_CURRENT_KEY);
  } catch {
    return empty(503, { "Retry-After": "300" });
  }
  if (object === null) return empty(503, { "Retry-After": "300" });
  if (
    object.size <= 0 ||
    object.size > MODEL_CATALOG_MAX_BYTES ||
    !validHttpEtag(object.httpEtag)
  ) {
    return empty(502);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    return empty(503, { "Retry-After": "300" });
  }
  if (bytes.byteLength !== object.size || bytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    return empty(502);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return empty(502);
  }
  const catalog = ModelCatalogSnapshotSchema.safeParse(candidate);
  if (!catalog.success || catalog.data.provenance.kind !== "published") return empty(502);
  const digest = await sha256(bytes);
  if (
    !currentMetadataMatches(
      object.customMetadata,
      catalog.data.revision,
      catalog.data.provenance.publishedAt,
      digest.hex,
    )
  ) {
    return empty(502);
  }
  const headers = new Headers({
    "Cache-Control": `public, max-age=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, s-maxage=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, no-transform`,
    "Content-Digest": digest.contentDigest,
    "Content-Length": String(bytes.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (ifNoneMatch(request.headers.get("if-none-match"), object.httpEtag)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
}
