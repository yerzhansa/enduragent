import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_SOURCES, resolveDataSource } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.CYCLING_COACH_HOME;
  delete process.env.DATA_SOURCE;
  delete process.env.CYCLING_COACH_DATA_SOURCE;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

describe("data_source config", () => {
  it("exports the exact closed values and platform default", () => {
    expect(DATA_SOURCES).toEqual(["platform", "store"]);
    expect(resolveDataSource(undefined)).toBe("platform");
    expect(resolveDataSource("platform")).toBe("platform");
    expect(resolveDataSource("store")).toBe("store");
  });

  it.each([null, "", "Platform", "local", 1, [], {}])(
    "rejects %j with the exact error",
    (value) => {
      expect(() => resolveDataSource(value)).toThrowError(
        new TypeError('Config field data_source must be "platform" or "store".'),
      );
    },
  );

  it("loads the YAML value without an environment override", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cc-data-source-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "config.yaml"), "data_source: store\n", { mode: 0o600 });
    process.env.DATA_SOURCE = "platform";
    process.env.CYCLING_COACH_DATA_SOURCE = "platform";
    process.env.CYCLING_COACH_HOME = root;
    vi.resetModules();
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().dataSource).toBe("store");
  });

  it("rejects a preserved future-source YAML value with the exact error", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cc-data-source-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "config.yaml"), "data_source: future-source\n", { mode: 0o600 });
    process.env.CYCLING_COACH_HOME = root;
    vi.resetModules();
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrowError(
      new TypeError('Config field data_source must be "platform" or "store".'),
    );
  });
});
