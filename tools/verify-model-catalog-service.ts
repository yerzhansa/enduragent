import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLIC_PATH,
} from "./model-catalog-constants.js";

function target(value: string | undefined): URL {
  if (value === undefined) throw new Error("models:verify-service needs an HTTPS origin");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("models:verify-service needs an HTTPS origin without a path or credentials");
  }
  return url;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared === null || !/^\d+$/u.test(declared) || Number(declared) > MODEL_CATALOG_MAX_BYTES) {
    throw new Error("catalog content length is missing or too large");
  }
  if (response.body === null) throw new Error("catalog response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > Number(declared) || total > MODEL_CATALOG_MAX_BYTES) {
      await reader.cancel();
      throw new Error("catalog response exceeds its declared size");
    }
    chunks.push(result.value);
  }
  if (total !== Number(declared)) {
    throw new Error("catalog response size does not match Content-Length");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function expectStatus(url: URL, init: RequestInit, status: number): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "error" });
  if (response.status !== status) {
    await response.body?.cancel();
    throw new Error(`${init.method ?? "GET"} ${url.pathname} returned ${response.status}`);
  }
  return response;
}

const origin = target(process.argv[2]);
const catalogUrl = new URL(MODEL_CATALOG_PUBLIC_PATH, origin);
const response = await expectStatus(catalogUrl, { method: "GET" }, 200);
const bytes = await boundedBytes(response);
const digest = await sha256(bytes);
const parsed = ModelCatalogSnapshotSchema.safeParse(
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
);
if (!parsed.success || parsed.data.provenance.kind !== "published") {
  throw new Error("served catalog does not match the shared published schema");
}
const etag = response.headers.get("etag");
if (etag === null || etag.length === 0) throw new Error("catalog response has no ETag");
if (response.headers.get("content-digest") !== digest.contentDigest) {
  throw new Error("catalog Content-Digest does not match served bytes");
}
const cacheControl = response.headers.get("cache-control") ?? "";
const maxAge = /(?:^|,\s*)max-age=(\d+)(?:,|$)/u.exec(cacheControl)?.[1];
const sharedMaxAge = /(?:^|,\s*)s-maxage=(\d+)(?:,|$)/u.exec(cacheControl)?.[1];
const noTransform = /(?:^|,\s*)no-transform(?:,|$)/u.test(cacheControl);
if (
  maxAge === undefined ||
  sharedMaxAge === undefined ||
  !noTransform ||
  Number(maxAge) <= 0 ||
  Number(maxAge) > MODEL_CATALOG_EDGE_MAX_AGE_SECONDS ||
  Number(sharedMaxAge) <= 0 ||
  Number(sharedMaxAge) > MODEL_CATALOG_EDGE_MAX_AGE_SECONDS
) {
  throw new Error("catalog cache controls are missing or exceed the configured bound");
}

const head = await expectStatus(catalogUrl, { method: "HEAD" }, 200);
if (
  head.headers.get("etag") !== etag ||
  head.headers.get("content-digest") !== digest.contentDigest ||
  (await head.arrayBuffer()).byteLength !== 0
) {
  throw new Error("HEAD metadata does not match GET");
}
const notModified = await expectStatus(
  catalogUrl,
  { method: "GET", headers: { "If-None-Match": etag } },
  304,
);
if ((await notModified.arrayBuffer()).byteLength !== 0) {
  throw new Error("conditional GET returned a body");
}
const rejected = await expectStatus(catalogUrl, { method: "POST" }, 405);
if (rejected.headers.get("allow") !== "GET, HEAD") {
  throw new Error("method rejection has the wrong Allow header");
}
await expectStatus(new URL("/models/v1/not-catalog.json", origin), { method: "GET" }, 404);
await expectStatus(new URL("/not-a-service", origin), { method: "GET" }, 404);

process.stdout.write(
  `${JSON.stringify({
    origin: origin.origin,
    revision: parsed.data.revision,
    publishedAt: parsed.data.provenance.publishedAt,
    catalogDigest: digest.hex,
    etag,
    cacheControl,
  })}\n`,
);
