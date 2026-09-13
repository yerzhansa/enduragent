import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  __openModelCatalogForTesting,
  type ModelCatalog,
} from "../src/model-catalog-owner.js";

const uptimeStub = vi.hoisted(() => vi.fn<() => number>());

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  uptime: uptimeStub,
}));

const catalogs: ModelCatalog[] = [];
const directories: string[] = [];
let wallNow = Date.parse("1998-01-01T00:00:00.000Z");

function openCatalog(installationRoot: string, fetch: typeof globalThis.fetch): ModelCatalog {
  const cacheDirectory = mkdtempSync(join(tmpdir(), "catalog-system-clock-cache-"));
  directories.push(cacheDirectory);
  const catalog = __openModelCatalogForTesting(
    { cacheDirectory, installationRoot },
    { endpoint: "https://catalog.invalid/test", fetch, now: () => wallNow },
  );
  catalogs.push(catalog);
  return catalog;
}

afterEach(async () => {
  vi.restoreAllMocks();
  uptimeStub.mockReset();
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.shutdown()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("uses a continuous elapsed clock across owner handoff", async () => {
  wallNow = Date.parse("1998-01-01T00:00:00.000Z");
  const installationRoot = mkdtempSync(join(tmpdir(), "catalog-system-clock-installation-"));
  directories.push(installationRoot);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 500 }));
  const hrtime = vi.spyOn(process.hrtime, "bigint").mockReturnValue(1_000_000_000n);
  if (process.platform === "darwin") {
    uptimeStub.mockImplementation(() => {
      throw new Error("wall-derived uptime is unsafe on macOS");
    });
  } else {
    uptimeStub.mockReturnValue(1_000);
  }

  const first = openCatalog(installationRoot, fetch);
  await expect(first.start()).resolves.toEqual({ kind: "owner" });
  await first.refresh();
  expect(fetch).toHaveBeenCalledOnce();
  await first.shutdown();

  wallNow += 2 * MODEL_CATALOG_REFRESH_INTERVAL_MS;
  const replacement = openCatalog(installationRoot, fetch);
  await expect(replacement.start()).resolves.toEqual({ kind: "owner" });
  await expect(replacement.refresh()).resolves.toMatchObject({ kind: "retained", reason: "not-due" });
  expect(fetch).toHaveBeenCalledOnce();
  if (process.platform === "darwin") {
    expect(hrtime).toHaveBeenCalled();
    expect(uptimeStub).not.toHaveBeenCalled();
  } else {
    expect(uptimeStub).toHaveBeenCalled();
    expect(hrtime).not.toHaveBeenCalled();
  }
});
