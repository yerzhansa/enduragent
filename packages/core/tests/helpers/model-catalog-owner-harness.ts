import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { BUNDLED_MODEL_CATALOG } from "../../src/model-catalog-seed.js";
import {
  MODEL_CATALOG_RESPONSE_LIMIT_BYTES,
  __openModelCatalogForTesting as openModelCatalogForTesting,
  type ModelCatalog,
} from "../../src/model-catalog-owner.js";
import {
  startCountedHttpServer,
  type CountedHttpResponse,
  type CountedHttpServer,
} from "./counted-http-server.js";

const tempDirectories: string[] = [];
const catalogs: ModelCatalog[] = [];
const servers: CountedHttpServer[] = [];

export const baseTime = Date.parse("1998-01-01T00:00:00.000Z");
export const BUNDLED_REVISION = BUNDLED_MODEL_CATALOG.revision;
export const FIRST_REMOTE_REVISION = BUNDLED_REVISION + 1;
export const SECOND_REMOTE_REVISION = BUNDLED_REVISION + 2;

export interface UnreadBodyCase {
  readonly headers: Readonly<Record<string, string>>;
  readonly reason: "http-error" | "invalid-response" | "response-too-large";
  readonly status: number;
  readonly title: string;
}

export const unreadBodyCases: readonly UnreadBodyCase[] = [
  {
    headers: {},
    reason: "http-error",
    status: 500,
    title: "HTTP errors",
  },
  {
    headers: {},
    reason: "invalid-response",
    status: 200,
    title: "invalid response headers",
  },
  {
    headers: {
      "Content-Length": String(MODEL_CATALOG_RESPONSE_LIMIT_BYTES + 1),
      ETag: '"revision-2"',
    },
    reason: "response-too-large",
    status: 200,
    title: "declared oversized responses",
  },
];

export function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

export function remoteCatalog(revision = FIRST_REMOTE_REVISION) {
  const snapshot = structuredClone(BUNDLED_MODEL_CATALOG);
  snapshot.revision = revision;
  snapshot.provenance = { kind: "published", publishedAt: "1998-01-01T00:00:00.000Z" };
  const openai = snapshot.providers.find((provider) => provider.providerId === "openai");
  if (openai === undefined) throw new Error("Missing OpenAI provider");
  openai.models.push({
    modelId: `new-model-${revision}`,
    label: `New Model ${revision}`,
    order: 50,
    compatibilityProfile: "openai-ai-sdk-v1",
    contextWindow: { kind: "unknown" },
    imageInput: "unknown",
    pricing: { kind: "unknown" },
  });
  return snapshot;
}

export async function serverFor(
  respond: Parameters<typeof startCountedHttpServer>[0],
): Promise<CountedHttpServer> {
  const server = await startCountedHttpServer(respond);
  servers.push(server);
  return server;
}

export function __openModelCatalogForTesting(
  ...args: Parameters<typeof openModelCatalogForTesting>
): ModelCatalog {
  const catalog = openModelCatalogForTesting(...args);
  catalogs.push(catalog);
  return catalog;
}

export function openCatalog(input: {
  endpoint: string;
  installationRoot?: string;
  cacheDirectory?: string;
  afterAttemptClaim?: () => Promise<void> | void;
  beforePublish?: () => Promise<void> | void;
  now?: () => number;
  elapsedNow?: () => number;
  elapsedResolutionMs?: number;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}): ModelCatalog {
  const installationRoot = input.installationRoot ?? tempDirectory("catalog-installation-");
  const cacheDirectory = input.cacheDirectory ?? tempDirectory("catalog-cache-");
  const now = input.now ?? (() => baseTime);
  return __openModelCatalogForTesting(
    { cacheDirectory, installationRoot },
    {
      afterAttemptClaim: input.afterAttemptClaim,
      beforePublish: input.beforePublish,
      endpoint: input.endpoint,
      elapsedNow: input.elapsedNow ?? now,
      elapsedResolutionMs: input.elapsedResolutionMs,
      fetch: input.fetch,
      now,
      requestTimeoutMs: input.requestTimeoutMs,
    },
  );
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for catalog test condition");
}

export async function own(catalog: ModelCatalog): Promise<void> {
  expect(await catalog.start()).toEqual({ kind: "owner" });
}

export async function resetOwnerCatalogFixtures(): Promise<void> {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.shutdown()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export type { CountedHttpResponse, ModelCatalog };
export { mkdirSync, readFileSync, writeFileSync };
