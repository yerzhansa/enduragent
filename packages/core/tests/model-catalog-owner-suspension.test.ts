import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS } from "../src/model-catalog-owner.js";
import {
  __openModelCatalogForTesting,
  baseTime,
  BUNDLED_REVISION,
  FIRST_REMOTE_REVISION,
  SECOND_REMOTE_REVISION,
  openCatalog,
  own,
  remoteCatalog,
  resetOwnerCatalogFixtures,
  serverFor,
  tempDirectory,
  waitUntil,
} from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog suspension", () => {
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
});
