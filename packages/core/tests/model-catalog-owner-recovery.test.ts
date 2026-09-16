import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import { resolveModelCatalogPaths } from "../src/model-catalog-owner.js";
import {
  BUNDLED_REVISION,
  FIRST_REMOTE_REVISION,
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
