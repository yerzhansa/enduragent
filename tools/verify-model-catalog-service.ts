import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { bytesEqual, sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLIC_PATH,
} from "./model-catalog-constants.js";
import { CatalogPublicationError } from "./model-catalog-publication.js";

export type ModelCatalogFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface VerifiedModelCatalogService {
  readonly revision: number;
  readonly catalogDigest: string;
  readonly etag: string;
  readonly cacheControl: string;
}

export function modelCatalogServiceOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogPublicationError("validation", "model catalog origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CatalogPublicationError(
      "validation",
      "model catalog origin must be HTTPS without a path or credentials",
    );
  }
  return url;
}

export async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared === null || !/^\d+$/u.test(declared)) {
    throw new CatalogPublicationError("integrity", "catalog Content-Length is missing or invalid");
  }
  const declaredSize = Number(declared);
  if (!Number.isSafeInteger(declaredSize) || declaredSize > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogPublicationError("integrity", "catalog response exceeds the size limit");
  }
  if (response.body === null) {
    throw new CatalogPublicationError("integrity", "catalog response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > declaredSize || total > MODEL_CATALOG_MAX_BYTES) {
      await reader.cancel();
      throw new CatalogPublicationError("integrity", "catalog response exceeds its declared size");
    }
    chunks.push(result.value);
  }
  if (total !== declaredSize) {
    throw new CatalogPublicationError(
      "integrity",
      "catalog response size does not match Content-Length",
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function expectStatus(
  fetcher: ModelCatalogFetch,
  url: URL,
  init: RequestInit,
  status: number,
): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    headers: { "Accept-Encoding": "identity", ...init.headers },
  });
  if (response.status !== status) {
    await response.body?.cancel();
    throw new CatalogPublicationError(
      "integrity",
      `${init.method ?? "GET"} ${url.pathname} returned ${response.status}`,
    );
  }
  return response;
}

function assertCacheControl(value: string | null): string {
  const cacheControl = value ?? "";
  const maxAge = /(?:^|,\s*)max-age=(\d+)(?:,|$)/u.exec(cacheControl)?.[1];
  const sharedMaxAge = /(?:^|,\s*)s-maxage=(\d+)(?:,|$)/u.exec(cacheControl)?.[1];
  if (
    maxAge === undefined ||
    sharedMaxAge === undefined ||
    Number(maxAge) !== MODEL_CATALOG_EDGE_MAX_AGE_SECONDS ||
    Number(sharedMaxAge) !== MODEL_CATALOG_EDGE_MAX_AGE_SECONDS ||
    !/(?:^|,\s*)public(?:,|$)/u.test(cacheControl) ||
    !/(?:^|,\s*)no-transform(?:,|$)/u.test(cacheControl)
  ) {
    throw new CatalogPublicationError("integrity", "catalog cache controls do not match policy");
  }
  return cacheControl;
}

export async function verifyModelCatalogService(input: {
  readonly origin: string;
  readonly expectedCatalogBytes: Uint8Array;
  readonly expectedRevision: number;
  readonly expectedDigest: string;
  readonly fetcher?: ModelCatalogFetch;
}): Promise<VerifiedModelCatalogService> {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision <= 0 ||
    !/^[a-f0-9]{64}$/u.test(input.expectedDigest)
  ) {
    throw new CatalogPublicationError("validation", "expected revision or digest is invalid");
  }
  if (input.expectedCatalogBytes.byteLength > MODEL_CATALOG_MAX_BYTES) {
    throw new CatalogPublicationError("validation", "expected catalog exceeds the size limit");
  }
  const expectedHash = await sha256(input.expectedCatalogBytes);
  if (expectedHash.hex !== input.expectedDigest) {
    throw new CatalogPublicationError(
      "integrity",
      "expected catalog digest does not match its bytes",
    );
  }
  let expectedJson: unknown;
  try {
    expectedJson = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.expectedCatalogBytes),
    );
  } catch {
    throw new CatalogPublicationError("integrity", "expected catalog is not valid UTF-8 JSON");
  }
  const expectedCatalog = ModelCatalogSnapshotSchema.safeParse(expectedJson);
  if (
    !expectedCatalog.success ||
    expectedCatalog.data.provenance.kind !== "published" ||
    expectedCatalog.data.revision !== input.expectedRevision
  ) {
    throw new CatalogPublicationError("integrity", "expected catalog does not match its revision");
  }
  const fetcher = input.fetcher ?? fetch;
  const origin = modelCatalogServiceOrigin(input.origin);
  const catalogUrl = new URL(MODEL_CATALOG_PUBLIC_PATH, origin);
  const response = await expectStatus(
    fetcher,
    catalogUrl,
    { method: "GET", cache: "no-store" },
    200,
  );
  const bytes = await boundedResponseBytes(response);
  if (!bytesEqual(bytes, input.expectedCatalogBytes)) {
    throw new CatalogPublicationError("conflict", "served catalog bytes differ from the archive");
  }
  if (!["identity", null].includes(response.headers.get("content-encoding"))) {
    throw new CatalogPublicationError("integrity", "catalog response is not identity encoded");
  }
  if (response.headers.get("content-digest") !== expectedHash.contentDigest) {
    throw new CatalogPublicationError("integrity", "catalog Content-Digest does not match");
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new CatalogPublicationError("integrity", "catalog response is missing nosniff");
  }
  const etag = response.headers.get("etag");
  if (etag === null || etag.length === 0 || etag.length > 1_024) {
    throw new CatalogPublicationError("integrity", "catalog response has no valid ETag");
  }
  const cacheControl = assertCacheControl(response.headers.get("cache-control"));
  const head = await expectStatus(fetcher, catalogUrl, { method: "HEAD", cache: "no-store" }, 200);
  for (const header of [
    "etag",
    "content-digest",
    "cache-control",
    "content-type",
    "x-content-type-options",
  ]) {
    if (head.headers.get(header) !== response.headers.get(header)) {
      throw new CatalogPublicationError("integrity", `HEAD ${header} does not match GET`);
    }
  }
  const headContentLength = head.headers.get("content-length");
  if (headContentLength !== null && headContentLength !== response.headers.get("content-length")) {
    throw new CatalogPublicationError("integrity", "HEAD content-length does not match GET");
  }
  if ((await head.arrayBuffer()).byteLength !== 0) {
    throw new CatalogPublicationError("integrity", "HEAD returned a body");
  }
  const notModified = await expectStatus(
    fetcher,
    catalogUrl,
    { method: "GET", cache: "no-store", headers: { "If-None-Match": etag } },
    304,
  );
  if ((await notModified.arrayBuffer()).byteLength !== 0) {
    throw new CatalogPublicationError("integrity", "conditional GET returned a body");
  }
  for (const path of ["/models/v1/not-catalog.json", "/not-a-service"]) {
    const missing = await expectStatus(fetcher, new URL(path, origin), { method: "GET" }, 404);
    await missing.body?.cancel();
  }
  return Object.freeze({
    revision: input.expectedRevision,
    catalogDigest: input.expectedDigest,
    etag,
    cacheControl,
  });
}

async function runCli(): Promise<void> {
  const [origin, catalogPath, revisionText, digest] = process.argv.slice(2);
  if (
    origin === undefined ||
    catalogPath === undefined ||
    revisionText === undefined ||
    digest === undefined
  ) {
    throw new Error(
      "models:verify-service needs origin, archived catalog file, revision, and digest",
    );
  }
  const fileSize = (await stat(catalogPath)).size;
  if (fileSize <= 0 || fileSize > MODEL_CATALOG_MAX_BYTES) {
    throw new Error("archived catalog file has an invalid size");
  }
  const result = await verifyModelCatalogService({
    origin,
    expectedCatalogBytes: await readFile(catalogPath),
    expectedRevision: Number(revisionText),
    expectedDigest: digest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  runCli().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "model catalog verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
