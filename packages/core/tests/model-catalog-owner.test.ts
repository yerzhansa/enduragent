import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDesktopAthleteHome } from "../../../apps/desktop/src/main/first-run-config.js";
import { resolveAthleteHome } from "../../kernel-node/src/home/resolve-athlete-home.js";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  MODEL_CATALOG_RESPONSE_LIMIT_BYTES,
  __openModelCatalogForTesting,
  resolveModelCatalogPaths,
  type ModelCatalog,
} from "../src/model-catalog-owner.js";
import {
  startCountedHttpServer,
  type CountedHttpResponse,
  type CountedHttpServer,
} from "./helpers/counted-http-server.js";

const tempDirectories: string[] = [];
const catalogs: ModelCatalog[] = [];
const servers: CountedHttpServer[] = [];
const baseTime = Date.parse("1998-01-01T00:00:00.000Z");
const BUNDLED_REVISION = BUNDLED_MODEL_CATALOG.revision;
const FIRST_REMOTE_REVISION = BUNDLED_REVISION + 1;
const SECOND_REMOTE_REVISION = BUNDLED_REVISION + 2;

interface UnreadBodyCase {
  readonly headers: Readonly<Record<string, string>>;
  readonly reason: "http-error" | "invalid-response" | "response-too-large";
  readonly status: number;
  readonly title: string;
}

const unreadBodyCases: readonly UnreadBodyCase[] = [
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

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function remoteCatalog(revision = FIRST_REMOTE_REVISION) {
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

async function serverFor(
  respond: Parameters<typeof startCountedHttpServer>[0],
): Promise<CountedHttpServer> {
  const server = await startCountedHttpServer(respond);
  servers.push(server);
  return server;
}

function openCatalog(input: {
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
  const catalog = __openModelCatalogForTesting(
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
  catalogs.push(catalog);
  return catalog;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for catalog test condition");
}

async function own(catalog: ModelCatalog): Promise<void> {
  expect(await catalog.start()).toEqual({ kind: "owner" });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.shutdown()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model catalog installation paths", () => {
  it("maps desktop, coach, and CLI home resolution to one installation record", () => {
    const installationRoot = tempDirectory("catalog-home-");
    const env = { ENDURAGENT_HOME: installationRoot };
    const desktopRoot = resolveDesktopAthleteHome(env);
    const hostRoot = resolveAthleteHome(env).root;
    const desktopPaths = resolveModelCatalogPaths({
      cacheDirectory: join(installationRoot, "desktop-cache"),
      installationRoot: desktopRoot,
    });
    const hostPaths = resolveModelCatalogPaths({
      cacheDirectory: join(installationRoot, "coach-cache"),
      installationRoot: hostRoot,
    });

    expect(desktopRoot).toBe(hostRoot);
    expect(desktopPaths.attemptState).toBe(hostPaths.attemptState);
    expect(desktopPaths.ownerSnapshot).toBe(hostPaths.ownerSnapshot);
    expect(desktopPaths.privateSnapshot).not.toBe(hostPaths.privateSnapshot);
  });
});

describe("model catalog local recovery", () => {
  it("returns the bundled snapshot immediately and repeated local reads issue no requests", async () => {
    const server = await serverFor(() => ({ status: 500 }));
    const catalog = openCatalog({ endpoint: server.url });
    const pinned = catalog.current();

    expect(pinned.revision).toBe(BUNDLED_MODEL_CATALOG.revision);
    expect(catalog.current()).toBe(pinned);
    for (let index = 0; index < 50; index += 1) catalog.current();
    expect(server.requests).toHaveLength(0);
  });

  it("publishes before announcement and another process reads the revision without a request", async () => {
    const candidate = remoteCatalog();
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(candidate)],
    }));
    const installationRoot = tempDirectory("catalog-shared-");
    const writer = openCatalog({ endpoint: server.url, installationRoot });
    await own(writer);

    await expect(writer.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-reader-cache-"),
      installationRoot,
    });
    expect(JSON.parse(readFileSync(paths.ownerSnapshot, "utf8"))).toMatchObject({
      etag: '"revision-2"',
      snapshot: { revision: FIRST_REMOTE_REVISION },
    });

    const reader = openCatalog({
      cacheDirectory: paths.privateDirectory,
      endpoint: server.url,
      installationRoot,
    });
    expect(reader.current().revision).toBe(FIRST_REMOTE_REVISION);
    expect(server.requests).toHaveLength(1);
    await writer.shutdown();
    expect(reader.current().revision).toBe(FIRST_REMOTE_REVISION);
    expect(server.requests).toHaveLength(1);
  });

  it("copies an installation snapshot into a reader cache for later offline recovery", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const installationRoot = tempDirectory("catalog-shared-cache-");
    const readerCache = tempDirectory("catalog-reader-cache-");
    const owner = openCatalog({ endpoint: server.url, installationRoot });
    await own(owner);
    await owner.refresh();

    const reader = openCatalog({
      cacheDirectory: readerCache,
      endpoint: server.url,
      installationRoot,
    });
    expect(reader.current().revision).toBe(FIRST_REMOTE_REVISION);
    const paths = resolveModelCatalogPaths({ cacheDirectory: readerCache, installationRoot });
    expect(JSON.parse(readFileSync(paths.privateSnapshot, "utf8"))).toMatchObject({
      snapshot: { revision: FIRST_REMOTE_REVISION },
    });

    writeFileSync(paths.ownerSnapshot, "{broken", "utf8");
    const restartedReader = openCatalog({
      cacheDirectory: readerCache,
      endpoint: "http://127.0.0.1:1/unreachable",
      installationRoot,
    });
    expect(restartedReader.current()).toMatchObject({
      origin: "private-cache",
      revision: FIRST_REMOTE_REVISION,
    });
  });

  it("ignores corrupt saved records and keeps the bundle offline", async () => {
    const installationRoot = tempDirectory("catalog-corrupt-");
    const cacheDirectory = tempDirectory("catalog-corrupt-cache-");
    const paths = resolveModelCatalogPaths({ cacheDirectory, installationRoot });
    mkdirSync(paths.privateDirectory, { recursive: true });
    mkdirSync(paths.installationDirectory, { recursive: true });
    writeFileSync(paths.privateSnapshot, "{broken", "utf8");
    writeFileSync(paths.ownerSnapshot, "{broken", "utf8");
    const catalog = openCatalog({
      endpoint: "http://127.0.0.1:1/unreachable",
      installationRoot,
      cacheDirectory,
    });

    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
    expect(catalog.current().origin).toBe("bundled");
  });

  it("keeps the bundled snapshot after a cold offline startup attempt", async () => {
    const catalog = openCatalog({
      endpoint: "http://127.0.0.1:1/unreachable",
      requestTimeoutMs: 20,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: BUNDLED_REVISION,
    });
    expect(catalog.current()).toMatchObject({ origin: "bundled", revision: BUNDLED_REVISION });
  });
});

describe("model catalog request boundary", () => {
  it("fails closed at request time when Node TLS verification is disabled and keeps the attempt claimed", async () => {
    let now = baseTime;
    const installationRoot = tempDirectory("catalog-disabled-tls-");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify(remoteCatalog()), {
        status: 200,
        headers: { ETag: '"revision-2"' },
      }),
    );
    const first = openCatalog({
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => now,
    });
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await own(first);

    await expect(first.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: BUNDLED_REVISION,
    });
    expect(fetch).not.toHaveBeenCalled();
    await first.shutdown();
    vi.unstubAllEnvs();

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    const replacement = openCatalog({
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => now,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: BUNDLED_REVISION,
    });
    expect(fetch).not.toHaveBeenCalled();

    now += 1;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
      delayBetweenChunksMs: 20,
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    const outcomes = await Promise.all(Array.from({ length: 40 }, () => catalog.refresh()));
    expect(server.requests).toHaveLength(1);
    expect(outcomes).toEqual(
      Array.from({ length: 40 }, () => ({ kind: "updated", revision: FIRST_REMOTE_REVISION })),
    );
  });

  it("suppresses at 24 hours minus one millisecond and requests at the boundary", async () => {
    let now = baseTime;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    now += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(1);
    now += 1;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it.each([421, 429, 500])(
    "makes an HTTP %s failure consume the full window across restart",
    async (status) => {
      let now = baseTime;
      const server = await serverFor(() => ({ status }));
      const installationRoot = tempDirectory("catalog-failure-");
      const first = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
      await own(first);
      await expect(first.refresh()).resolves.toMatchObject({
        kind: "retained",
        reason: "http-error",
      });
      await first.shutdown();

      now += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
      const restarted = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
      await own(restarted);
      await expect(restarted.refresh()).resolves.toMatchObject({
        kind: "retained",
        reason: "not-due",
      });
      expect(server.requests).toHaveLength(1);
    },
  );

  it("bounds the streamed response at the transport before JSON parsing", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const chunks = Array.from(
      { length: MODEL_CATALOG_RESPONSE_LIMIT_BYTES / chunk.byteLength + 1 },
      () => chunk,
    );
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"oversized"' },
      chunks,
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "response-too-large",
      revision: BUNDLED_REVISION,
    });
    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
  });

  it("times out a slow request and retains local data", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"slow"' },
      chunks: ["{", JSON.stringify(remoteCatalog()).slice(1)],
      delayBetweenChunksMs: 100,
    }));
    const catalog = openCatalog({ endpoint: server.url, requestTimeoutMs: 20 });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: BUNDLED_REVISION,
    });
    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
  });

  it("uses a matching ETag and rejects a 304 without one", async () => {
    let now = baseTime;
    const candidate = remoteCatalog();
    const server = await serverFor((_request, index) =>
      index === 0
        ? {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate)],
          }
        : { status: 304, headers: { ETag: '"revision-2"' } },
    );
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "unchanged",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(server.requests[1]?.headers["if-none-match"]).toBe('"revision-2"');

    const other = openCatalog({
      endpoint: server.url,
      installationRoot: tempDirectory("catalog-304-"),
    });
    await own(other);
    await expect(other.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "invalid-not-modified",
      revision: BUNDLED_REVISION,
    });
  });

  it("rejects a successful response without an ETag", async () => {
    const server = await serverFor(() => ({
      status: 200,
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "invalid-response",
      revision: BUNDLED_REVISION,
    });
    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
  });

  it("rejects stale, malformed, forbidden, and unusable responses without advancing state", async () => {
    let now = baseTime;
    const stale = remoteCatalog(1);
    const forbidden = { ...remoteCatalog(3), endpoint: "https://invalid.example" };
    const unusable = remoteCatalog(4);
    unusable.providers = unusable.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        compatibilityProfile: "future-profile-v2",
      })),
    }));
    const unknownSchema: unknown = { ...remoteCatalog(5), schemaVersion: 2 };
    const bodies = [
      JSON.stringify(stale),
      "{broken",
      JSON.stringify(forbidden),
      JSON.stringify(unusable),
      JSON.stringify(unknownSchema),
    ];
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"candidate-${index}"` },
      chunks: [bodies[index] ?? "{}"],
    }));
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);

    const retainedReasons: readonly (
      | "invalid-response"
      | "no-usable-choices"
      | "stale-revision"
    )[] = [
      "stale-revision",
      "invalid-response",
      "invalid-response",
      "no-usable-choices",
      "invalid-response",
    ];
    for (const reason of retainedReasons) {
      await expect(catalog.refresh()).resolves.toMatchObject({
        kind: "retained",
        reason,
        revision: BUNDLED_REVISION,
      });
      now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    }
    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
  });

  it("treats future attempts conservatively and permits a request only after their due boundary", async () => {
    let now = baseTime;
    const installationRoot = tempDirectory("catalog-clock-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-clock-cache-"),
      installationRoot,
    });
    mkdirSync(paths.installationDirectory, { recursive: true });
    writeFileSync(
      paths.attemptState,
      `${JSON.stringify({
        schemaVersion: 1,
        attemptStatus: "completed",
        lastAttemptAt: new Date(baseTime + 1_000).toISOString(),
        systemUptimeMs: baseTime + 1_000,
      })}\n`,
    );
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const catalog = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({ kind: "retained", reason: "not-due" });
    now = baseTime - 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({ kind: "retained", reason: "not-due" });
    now = baseTime + 1_000 + MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("does not let a forward wall-clock jump bypass the live elapsed-time window", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const catalog = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      now: () => wallNow,
    });
    await own(catalog);
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(1);

    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1_000;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("fails closed when the elapsed clock throws before an attempt claim", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const catalog = openCatalog({
      elapsedNow: () => {
        throw new Error("elapsed clock unavailable");
      },
      endpoint: "https://catalog.invalid/test",
      fetch,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "claim-failed",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the elapsed clock throws during attempt completion", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    let elapsedReadable = true;
    const installationRoot = tempDirectory("catalog-completion-clock-failure-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-completion-clock-failure-cache-"),
      installationRoot,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(remoteCatalog()), {
          status: 200,
          headers: { ETag: '"revision-2"' },
        }),
    );
    const catalog = openCatalog({
      beforePublish: () => {
        elapsedReadable = false;
      },
      elapsedNow: () => {
        if (!elapsedReadable) throw new Error("elapsed clock unavailable");
        return elapsedNow;
      },
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => wallNow,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(JSON.parse(readFileSync(paths.attemptState, "utf8"))).toMatchObject({
      attemptStatus: "in-flight",
    });

    elapsedReadable = true;
    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(JSON.parse(readFileSync(paths.attemptState, "utf8"))).toMatchObject({
      attemptStatus: "completed",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed without requesting when the elapsed clock throws during reanchoring", async () => {
    let elapsedReadable = true;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const catalog = openCatalog({
      afterAttemptClaim: () => {
        elapsedReadable = false;
      },
      elapsedNow: () => {
        if (!elapsedReadable) throw new Error("elapsed clock unavailable");
        return 0;
      },
      endpoint: "https://catalog.invalid/test",
      fetch,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "claim-failed",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves elapsed suppression when the wall clock jumps before owner handoff", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const installationRoot = tempDirectory("catalog-clock-handoff-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    await first.shutdown();

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += 1_000;
    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(server.requests).toHaveLength(1);

    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1_000;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("repairs suppression when uptime resets before a replacement owner starts", async () => {
    let wallNow = baseTime;
    let elapsedNow = 10_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const installationRoot = tempDirectory("catalog-uptime-reset-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    await first.shutdown();

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow = 1_000;
    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(server.requests).toHaveLength(1);

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("refreshes when both clocks reach the boundary across process replacement", async () => {
    let wallNow = baseTime;
    let elapsedNow = 1_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const installationRoot = tempDirectory("catalog-larger-uptime-session-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    await first.shutdown();

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("waits through uptime quantization uncertainty after a wall-clock jump", async () => {
    const elapsedResolutionMs = 1_000;
    const completionActualUptimeMs = 1_000_900;
    const replacementActualUptimeMs =
      completionActualUptimeMs + MODEL_CATALOG_REFRESH_INTERVAL_MS - 800;
    let wallNow = baseTime;
    let elapsedNow =
      Math.floor(completionActualUptimeMs / elapsedResolutionMs) * elapsedResolutionMs;
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      requestCount += 1;
      return new Response(JSON.stringify(remoteCatalog(requestCount + BUNDLED_REVISION)), {
        status: 200,
        headers: { ETag: `"revision-${requestCount + 1}"` },
      });
    });
    const installationRoot = tempDirectory("catalog-quantized-uptime-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      elapsedResolutionMs,
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow = Math.floor(replacementActualUptimeMs / elapsedResolutionMs) * elapsedResolutionMs;
    await expect(first.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await first.shutdown();

    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      elapsedResolutionMs,
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    wallNow += 900;
    elapsedNow =
      Math.floor((replacementActualUptimeMs + 900) / elapsedResolutionMs) * elapsedResolutionMs;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("suppresses an undetected reboot until the uptime delta reaches the boundary", async () => {
    let wallNow = baseTime;
    let elapsedNow = 1_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const installationRoot = tempDirectory("catalog-undetected-reboot-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    await first.shutdown();

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(server.requests).toHaveLength(1);

    wallNow += 1;
    elapsedNow += 1;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("reanchors the durable attempt after suspension before HTTP starts", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    let markClaimed = (): void => {
      throw new Error("Attempt claim was not observed");
    };
    const claimed = new Promise<void>((resolve) => {
      markClaimed = resolve;
    });
    let releaseClaim = (): void => {
      throw new Error("Attempt claim release was not initialized");
    };
    const claimRelease = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const installationRoot = tempDirectory("catalog-suspended-claim-");
    const first = __openModelCatalogForTesting(
      {
        cacheDirectory: tempDirectory("catalog-suspended-claim-cache-"),
        installationRoot,
      },
      {
        afterAttemptClaim: async () => {
          markClaimed();
          await claimRelease;
        },
        elapsedNow: () => elapsedNow,
        endpoint: server.url,
        now: () => wallNow,
      },
    );
    catalogs.push(first);
    await own(first);
    const firstRefresh = first.refresh();
    await claimed;

    wallNow += 23 * 60 * 60 * 1_000;
    elapsedNow += 23 * 60 * 60 * 1_000;
    releaseClaim();
    await expect(firstRefresh).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(first.diagnostics().lastAttemptAt).toBe("1998-01-01T23:00:00.000Z");
    await first.shutdown();

    wallNow += 60 * 60 * 1_000;
    elapsedNow += 60 * 60 * 1_000;
    const replacement = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(server.requests).toHaveLength(1);

    wallNow += 23 * 60 * 60 * 1_000;
    elapsedNow += 23 * 60 * 60 * 1_000;
    await expect(replacement.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(2);
  });

  it("starts suppression when a fetch that began after suspension completes", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      wallNow += 23 * 60 * 60 * 1_000;
      elapsedNow += 23 * 60 * 60 * 1_000;
      requestCount += 1;
      return new Response(JSON.stringify(remoteCatalog(requestCount + BUNDLED_REVISION)), {
        status: 200,
        headers: { ETag: `"revision-${requestCount + 1}"` },
      });
    });
    const catalog = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: "https://catalog.invalid/test",
      fetch,
      now: () => wallNow,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(catalog.diagnostics().lastAttemptAt).toBe("1998-01-01T23:00:00.000Z");

    wallNow += 60 * 60 * 1_000;
    elapsedNow += 60 * 60 * 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    wallNow += 23 * 60 * 60 * 1_000;
    elapsedNow += 23 * 60 * 60 * 1_000;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: SECOND_REMOTE_REVISION,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("starts suppression when a failed fetch completes after suspension", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      wallNow += 23 * 60 * 60 * 1_000;
      elapsedNow += 23 * 60 * 60 * 1_000;
      throw new Error("request failed");
    });
    const catalog = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: "https://catalog.invalid/test",
      fetch,
      now: () => wallNow,
    });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
    });
    expect(catalog.diagnostics().lastAttemptAt).toBe("1998-01-01T23:00:00.000Z");

    wallNow += 60 * 60 * 1_000;
    elapsedNow += 60 * 60 * 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    wallNow += 23 * 60 * 60 * 1_000;
    elapsedNow += 23 * 60 * 60 * 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(unreadBodyCases)(
    "cancels unread bodies for $title",
    async ({ headers, reason, status }) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode("still streaming"));
        },
      });
      let requestSignal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        requestSignal = init?.signal;
        return new Response(body, { headers, status });
      });
      const catalog = openCatalog({
        endpoint: "https://catalog.invalid/test",
        fetch,
      });
      await own(catalog);

      await expect(catalog.refresh()).resolves.toMatchObject({ kind: "retained", reason });
      expect(cancel).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(true);
    },
  );

  it("counts suspended time when a resume check reaches the daily boundary", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + FIRST_REMOTE_REVISION))],
    }));
    const catalog = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      now: () => wallNow,
    });
    await own(catalog);
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    catalog.notifyResumed();
    await waitUntil(() => catalog.current().revision === SECOND_REMOTE_REVISION);

    expect(catalog.current().revision).toBe(SECOND_REMOTE_REVISION);
    expect(server.requests).toHaveLength(2);
  });

  it("does not follow redirects beyond the claimed request", async () => {
    const server = await serverFor((_request, index): CountedHttpResponse => {
      if (index === 0) return { status: 302, headers: { Location: "/redirected" } };
      return {
        status: 200,
        headers: { ETag: '"revision-2"' },
        chunks: [JSON.stringify(remoteCatalog())],
      };
    });
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: BUNDLED_REVISION,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("repairs invalid attempt state without requesting and waits a full window", async () => {
    let now = baseTime;
    const installationRoot = tempDirectory("catalog-invalid-attempt-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-invalid-attempt-cache-"),
      installationRoot,
    });
    mkdirSync(paths.installationDirectory, { recursive: true });
    writeFileSync(paths.attemptState, "{broken", "utf8");
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const catalog = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({ kind: "retained", reason: "not-due" });
    expect(server.requests).toHaveLength(0);
    expect(catalog.diagnostics().lastAttemptAt).toBe("1998-01-01T00:00:00.000Z");
    now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(catalog.refresh()).resolves.toEqual({
      kind: "updated",
      revision: FIRST_REMOTE_REVISION,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("suppresses requests when the attempt claim cannot be persisted", async () => {
    const installationRoot = tempDirectory("catalog-attempt-failure-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-attempt-failure-cache-"),
      installationRoot,
    });
    mkdirSync(paths.attemptState, { recursive: true });
    const server = await serverFor(() => ({ status: 500 }));
    const catalog = openCatalog({ endpoint: server.url, installationRoot });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "claim-failed",
      revision: BUNDLED_REVISION,
    });
    expect(server.requests).toHaveLength(0);
  });

  it("does not announce an accepted response when owner persistence fails", async () => {
    const installationRoot = tempDirectory("catalog-owner-write-failure-");
    const paths = resolveModelCatalogPaths({
      cacheDirectory: tempDirectory("catalog-owner-write-failure-cache-"),
      installationRoot,
    });
    mkdirSync(paths.ownerSnapshot, { recursive: true });
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const catalog = openCatalog({ endpoint: server.url, installationRoot });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "persistence-failed",
      revision: BUNDLED_REVISION,
    });
    expect(catalog.current().revision).toBe(BUNDLED_REVISION);
    expect(server.requests).toHaveLength(1);
  });

  it("keeps installations independent", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const first = openCatalog({ endpoint: server.url });
    const second = openCatalog({ endpoint: server.url });
    await own(first);
    await own(second);

    await Promise.all([first.refresh(), second.refresh()]);
    expect(server.requests).toHaveLength(2);
  });

  it("separates the last attempt from the last successful refresh", async () => {
    let now = baseTime;
    const server = await serverFor((_request, index) =>
      index === 0
        ? {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(remoteCatalog())],
          }
        : { status: 500 },
    );
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);
    await catalog.refresh();
    const success = catalog.diagnostics();

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await catalog.refresh();
    const failed = catalog.diagnostics();
    expect(failed.lastAttemptAt).not.toBe(success.lastAttemptAt);
    expect(failed.lastSuccessfulRefreshAt).toBe(success.lastSuccessfulRefreshAt);
  });

  it("adopts a newer successful refresh time when the durable revision is unchanged", async () => {
    let now = baseTime;
    const server = await serverFor((_request, index) =>
      index === 0
        ? {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(remoteCatalog())],
          }
        : { status: 304, headers: { ETag: '"revision-2"' } },
    );
    const installationRoot = tempDirectory("catalog-diagnostics-reader-");
    const owner = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
    await own(owner);
    await owner.refresh();
    const reader = openCatalog({ endpoint: server.url, installationRoot, now: () => now });
    const firstSuccessfulRefresh = reader.diagnostics().lastSuccessfulRefreshAt;

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(owner.refresh()).resolves.toEqual({
      kind: "unchanged",
      revision: FIRST_REMOTE_REVISION,
    });

    expect(reader.diagnostics().lastSuccessfulRefreshAt).not.toBe(firstSuccessfulRefresh);
    expect(reader.diagnostics().lastSuccessfulRefreshAt).toBe("1998-01-02T00:00:00.000Z");
  });

  it("coalesces resume checks and aborts pending body work on shutdown", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: ["{", JSON.stringify(remoteCatalog()).slice(1)],
      delayBetweenChunksMs: 1_000,
    }));
    const catalog = openCatalog({ endpoint: server.url, requestTimeoutMs: 5_000 });
    await own(catalog);
    const refresh = catalog.refresh();
    await waitUntil(() => server.requests.length === 1);
    for (let index = 0; index < 50; index += 1) catalog.notifyResumed();
    expect(server.requests).toHaveLength(1);

    await expect(catalog.shutdown()).resolves.toBeUndefined();
    await expect(refresh).resolves.toMatchObject({ kind: "retained", reason: "shutdown" });
    expect(catalog.diagnostics().ownsLifecycle).toBe(false);
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "shutdown",
    });
  });

  it("retains lifecycle ownership until completed response work observes shutdown", async () => {
    let markPublicationStarted = (): void => {
      throw new Error("Publication start was not observed");
    };
    const publicationStarted = new Promise<void>((resolve) => {
      markPublicationStarted = resolve;
    });
    let releasePublication = (): void => {
      throw new Error("Publication release was not initialized");
    };
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const installationRoot = tempDirectory("catalog-shutdown-owner-");
    const owner = __openModelCatalogForTesting(
      {
        cacheDirectory: tempDirectory("catalog-shutdown-owner-cache-"),
        installationRoot,
      },
      {
        beforePublish: async () => {
          markPublicationStarted();
          await publicationRelease;
        },
        elapsedNow: () => baseTime,
        endpoint: server.url,
        now: () => baseTime,
      },
    );
    catalogs.push(owner);
    await own(owner);
    const refresh = owner.refresh();
    await publicationStarted;

    const shutdown = owner.shutdown();
    const replacement = openCatalog({ endpoint: server.url, installationRoot });
    await expect(replacement.start()).resolves.toEqual({
      kind: "reader",
      reason: "owned-elsewhere",
    });

    releasePublication();
    await expect(refresh).resolves.toMatchObject({ kind: "retained", reason: "shutdown" });
    await expect(shutdown).resolves.toBeUndefined();
    await expect(replacement.start()).resolves.toEqual({ kind: "owner" });
    expect(owner.current().revision).toBe(BUNDLED_REVISION);
  });

  it("releases scheduler ownership and permits a replacement without bypassing the daily claim", async () => {
    const server = await serverFor(() => ({ status: 500 }));
    const installationRoot = tempDirectory("catalog-owner-replacement-");
    const first = openCatalog({ endpoint: server.url, installationRoot });
    const replacement = openCatalog({ endpoint: server.url, installationRoot });
    await own(first);
    await expect(replacement.start()).resolves.toEqual({
      kind: "reader",
      reason: "owned-elsewhere",
    });
    await first.refresh();
    await first.shutdown();

    await expect(replacement.start()).resolves.toEqual({ kind: "owner" });
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
    });
    expect(server.requests).toHaveLength(1);
  });

  it("keeps automatic scheduling alive across an elapsed-clock failure", async () => {
    vi.useFakeTimers();
    let wallNow = baseTime;
    let elapsedNow = 0;
    let readsBeforeFailure = Number.POSITIVE_INFINITY;
    let clockFailures = 0;
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      requestCount += 1;
      const revision = requestCount + BUNDLED_REVISION;
      return new Response(JSON.stringify(remoteCatalog(revision)), {
        status: 200,
        headers: { ETag: `"revision-${revision}"` },
      });
    });
    const catalog = __openModelCatalogForTesting(
      {
        cacheDirectory: tempDirectory("catalog-timer-cache-"),
        installationRoot: tempDirectory("catalog-timer-"),
      },
      {
        elapsedNow: () => {
          if (readsBeforeFailure === 0) {
            readsBeforeFailure = Number.POSITIVE_INFINITY;
            clockFailures += 1;
            throw new Error("elapsed clock unavailable");
          }
          readsBeforeFailure -= 1;
          return elapsedNow;
        },
        endpoint: "https://catalog.invalid/test",
        fetch,
        now: () => wallNow,
      },
    );
    catalogs.push(catalog);
    await own(catalog);
    await catalog.refresh();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    readsBeforeFailure = 1;
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_INTERVAL_MS);

    expect(clockFailures).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    wallNow += 1;
    elapsedNow += 1;
    await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_INTERVAL_MS);

    expect(catalog.current().revision).toBe(SECOND_REMOTE_REVISION);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await catalog.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
