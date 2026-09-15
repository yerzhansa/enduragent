import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledAcceptedCatalog,
  engineConfigFromConfig,
  loadConfigFromYaml,
} from "@enduragent/core";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import {
  checkHomeReadiness,
  type ReadinessDependencies,
  type ReadinessFailureStatus,
} from "../src/readiness.js";

const roots: string[] = [];

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-readiness-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(home.configDir, { recursive: true });
  return home;
}

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("synthetic-private-io-detail"), { code });
}

function validSource(home: AthleteHome): string {
  return `data_source: store\ndata_dir: ${JSON.stringify(home.root)}\nllm:\n  provider: openai-codex\n  auth_profile: selected-profile\n`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("home readiness", () => {
  it("classifies only ENOENT from the initial read as not configured", async () => {
    const home = await freshHome();
    const configPath = join(home.configDir, "config.yaml");
    const readConfigFile = vi.fn().mockRejectedValue(ioError("ENOENT"));

    await expect(
      checkHomeReadiness(home, {
        readConfigFile,
        loadConfig: vi.fn(),
        projectConfig: vi.fn(),
      }),
    ).resolves.toEqual({ status: "not-configured", configPath });
    expect(readConfigFile).toHaveBeenCalledExactlyOnceWith(configPath, "utf8");
  });

  it.each(["EACCES", "EPERM", "EIO"])(
    "classifies synthetic initial %s without leaking the failure",
    async (code) => {
      const home = await freshHome();
      const result = await checkHomeReadiness(home, {
        readConfigFile: vi.fn().mockRejectedValue(ioError(code)),
        loadConfig: vi.fn(),
        projectConfig: vi.fn(),
      });

      expect(result).toEqual({ status: "unreadable" });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-io-detail");
    },
  );

  it.each(["ENOENT", "EACCES", "EPERM", "EIO"])(
    "classifies synthetic later %s as unreadable",
    async (code) => {
      const home = await freshHome();
      const readConfigFile = vi
        .fn()
        .mockResolvedValueOnce(validSource(home))
        .mockRejectedValueOnce(ioError(code));

      await expect(
        checkHomeReadiness(home, {
          readConfigFile,
          loadConfig: vi.fn(),
          projectConfig: vi.fn(),
        }),
      ).resolves.toEqual({ status: "unreadable" });
      expect(readConfigFile).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["YAML parse failure", "["],
    ["non-map root", "- first\n- second\n"],
    ["Core semantic validation failure", "data_source: unsupported\n"],
  ])("classifies %s as malformed", async (_name, source) => {
    const home = await freshHome();
    const readConfigFile = vi.fn().mockResolvedValue(source);

    await expect(
      checkHomeReadiness(home, {
        readConfigFile,
        loadConfig: loadConfigFromYaml,
        projectConfig: (config) =>
          engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }),
      }),
    ).resolves.toEqual({ status: "malformed" });
  });

  it("classifies an explicit data directory outside the selected home as malformed", async () => {
    const home = await freshHome();
    const source = "data_source: store\ndata_dir: /synthetic/other-athlete\n";

    await expect(
      checkHomeReadiness(home, {
        readConfigFile: vi.fn().mockResolvedValue(source),
        loadConfig: loadConfigFromYaml,
        projectConfig: (config) =>
          engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }),
      }),
    ).resolves.toEqual({ status: "malformed" });
  });

  it("accepts a data directory alias that resolves to the selected physical home", async () => {
    const home = await freshHome();
    const alias = join(home.root, "selected-home-alias");
    await symlink(home.root, alias, "dir");
    const source = `data_source: store\ndata_dir: ${JSON.stringify(alias)}\n`;

    const result = await checkHomeReadiness(home, {
      readConfigFile: vi.fn().mockResolvedValue(source),
      loadConfig: loadConfigFromYaml,
      projectConfig: (config) =>
        engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }),
    });

    expect(result).toMatchObject({ status: "ready" });
    if (result.status === "ready") expect(result.config.dataDir).toBe(alias);
  });

  it("returns the exact loaded Core config and projected engine snapshots", async () => {
    const home = await freshHome();
    const loaded = loadConfigFromYaml({ data_source: "store" }, home.configDir, {
      defaultDataDir: home.root,
    });
    const projected = engineConfigFromConfig(loaded, { catalog: bundledAcceptedCatalog() });
    const loadConfig = vi.fn(() => loaded);
    const projectConfig = vi.fn(() => projected);
    const dependencies: ReadinessDependencies = {
      readConfigFile: vi.fn().mockResolvedValue("data_source: store\n"),
      loadConfig,
      projectConfig,
    };

    const result = await checkHomeReadiness(home, dependencies);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.config).toBe(loaded);
    expect(result.engineConfig).toBe(projected);
    expect(projectConfig).toHaveBeenCalledExactlyOnceWith(loaded);
  });

  it.each(["missing", "unreadable", "malformed", "structurally-invalid"] as const)(
    "keeps a valid selected credential profile ready when auth-profiles.json is %s",
    async (profileState) => {
      const home = await freshHome();
      const configPath = join(home.configDir, "config.yaml");
      const profilesPath = join(home.configDir, "auth-profiles.json");
      await writeFile(configPath, validSource(home), { mode: 0o600 });
      if (profileState === "unreadable") {
        await mkdir(profilesPath);
      } else if (profileState === "malformed") {
        await writeFile(profilesPath, "{");
      } else if (profileState === "structurally-invalid") {
        await writeFile(profilesPath, JSON.stringify({ "selected-profile": [] }));
      }

      await expect(checkHomeReadiness(home)).resolves.toMatchObject({ status: "ready" });
    },
  );

  it("does not change existing configuration bytes, inode, or mode", async () => {
    const home = await freshHome();
    const configPath = join(home.configDir, "config.yaml");
    const bytes = Buffer.from("data_source: [synthetic-private-fragment]\n");
    await writeFile(configPath, bytes, { mode: 0o600 });
    const before = await stat(configPath);

    const result = await checkHomeReadiness(home);
    const after = await stat(configPath);

    expect(result).toEqual({ status: "malformed" });
    expect(await readFile(configPath)).toEqual(bytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
  });

  it("exposes only the closed failure statuses", () => {
    const statuses = [
      "not-configured",
      "unreadable",
      "malformed",
    ] satisfies ReadinessFailureStatus[];
    expect(statuses).toEqual(["not-configured", "unreadable", "malformed"]);
  });
});
