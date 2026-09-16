import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  resolveModelCatalogPaths,
} from "../src/model-catalog-owner.js";
import {
  baseTime,
  mkdirSync,
  openCatalog,
  own,
  readFileSync,
  remoteCatalog,
  resetOwnerCatalogFixtures,
  serverFor,
  tempDirectory,
  writeFileSync,
} from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog refresh window", () => {
  it("suppresses at 24 hours minus one millisecond and requests at the boundary", async () => {
    let now = baseTime;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
    now += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: 2,
    });
    expect(server.requests).toHaveLength(1);
    now += 1;
    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
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
    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
    expect(server.requests).toHaveLength(1);
  });

  it("does not let a forward wall-clock jump bypass the live elapsed-time window", async () => {
    let wallNow = baseTime;
    let elapsedNow = 0;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const catalog = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      now: () => wallNow,
    });
    await own(catalog);
    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });

    wallNow += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    elapsedNow += 1_000;
    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: 2,
    });
    expect(server.requests).toHaveLength(1);

    elapsedNow += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1_000;
    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
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
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
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

    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
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
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const installationRoot = tempDirectory("catalog-clock-handoff-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
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
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
    expect(server.requests).toHaveLength(2);
  });

  it("repairs suppression when uptime resets before a replacement owner starts", async () => {
    let wallNow = baseTime;
    let elapsedNow = 10_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const installationRoot = tempDirectory("catalog-uptime-reset-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
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
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
    expect(server.requests).toHaveLength(2);
  });

  it("refreshes when both clocks reach the boundary across process replacement", async () => {
    let wallNow = baseTime;
    let elapsedNow = 1_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const installationRoot = tempDirectory("catalog-larger-uptime-session-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
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
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
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
      return new Response(JSON.stringify(remoteCatalog(requestCount + 1)), {
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
    await expect(first.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });

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
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("suppresses an undetected reboot until the uptime delta reaches the boundary", async () => {
    let wallNow = baseTime;
    let elapsedNow = 1_000;
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"revision-${index + 2}"` },
      chunks: [JSON.stringify(remoteCatalog(index + 2))],
    }));
    const installationRoot = tempDirectory("catalog-undetected-reboot-");
    const first = openCatalog({
      elapsedNow: () => elapsedNow,
      endpoint: server.url,
      installationRoot,
      now: () => wallNow,
    });
    await own(first);
    await expect(first.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
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
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 3 });
    expect(server.requests).toHaveLength(2);
  });
});
