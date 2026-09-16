import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  resolveModelCatalogPaths,
} from "../src/model-catalog-owner.js";
import {
  __openModelCatalogForTesting,
  baseTime,
  BUNDLED_REVISION,
  FIRST_REMOTE_REVISION,
  SECOND_REMOTE_REVISION,
  mkdirSync,
  openCatalog,
  own,
  remoteCatalog,
  resetOwnerCatalogFixtures,
  serverFor,
  tempDirectory,
  waitUntil,
  writeFileSync,
} from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog owner lifecycle", () => {
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
