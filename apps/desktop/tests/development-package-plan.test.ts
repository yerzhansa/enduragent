import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  DEVELOPMENT_APP_ID,
  DEVELOPMENT_OUTPUT_DIRECTORY,
  DEVELOPMENT_PACKAGE_NAME,
  DEVELOPMENT_PRODUCT_NAME,
  createDevelopmentPackagePlan,
  runDevelopmentPackage,
} from "../scripts/development-package-plan.mjs";
import { createMacosReleasePlan } from "../scripts/macos-release-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");

describe("Desktop development package plan", () => {
  it("seals the exact non-production identity and deterministic output", () => {
    const plan = createDevelopmentPackagePlan({ desktopRoot });
    expect(plan).toEqual({
      applicationPath: join(desktopRoot, "dist/development/mac-arm64/Enduragent Development.app"),
      executablePath: join(
        desktopRoot,
        "dist/development/mac-arm64/Enduragent Development.app/Contents/MacOS/Enduragent Development",
      ),
      outputPath: join(desktopRoot, "dist/development"),
      builderOptions: {
        projectDir: desktopRoot,
        publish: "never",
        config: {
          extends: join(desktopRoot, "electron-builder.yml"),
          appId: DEVELOPMENT_APP_ID,
          productName: DEVELOPMENT_PRODUCT_NAME,
          directories: { output: DEVELOPMENT_OUTPUT_DIRECTORY },
          forceCodeSigning: false,
          extraMetadata: {
            name: DEVELOPMENT_PACKAGE_NAME,
            enduragentDesktopDevelopment: true,
          },
          mac: {
            identity: "-",
            hardenedRuntime: false,
            target: [{ target: "dir", arch: ["arm64"] }],
          },
        },
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => createDevelopmentPackagePlan({ desktopRoot: "relative" })).toThrow(
      "desktop root must be absolute",
    );
  });

  it("removes only development output, builds, and verifies the exact app", async () => {
    const remove = vi.fn(async () => undefined);
    const build = vi.fn(async () => ["synthetic-artifact"]);
    const verifyPackageLayout = vi.fn(async () => undefined);
    const result = await runDevelopmentPackage(
      { desktopRoot },
      { rm: remove, build, verifyPackageLayout },
    );
    expect(remove).toHaveBeenCalledWith(join(desktopRoot, "dist/development"), {
      recursive: true,
      force: true,
    });
    expect(build).toHaveBeenCalledWith(result.plan.builderOptions);
    expect(verifyPackageLayout).toHaveBeenCalledWith(result.plan.applicationPath, {
      desktopRoot,
      development: true,
    });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0]);
    expect(build.mock.invocationCallOrder[0]).toBeLessThan(
      verifyPackageLayout.mock.invocationCallOrder[0],
    );
  });

  it("keeps the checked-in and signed-release identities production-authoritative", async () => {
    const builder = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"));
    expect(builder).toMatchObject({
      appId: "icu.enduragent.desktop",
      productName: "Enduragent",
      directories: { output: "dist" },
      mac: {
        icon: "resources/app-icon.png",
        extendInfo: { ElectronSquirrelPreventDowngrades: true },
      },
    });
    const release = await createMacosReleasePlan(
      {
        repositoryRoot,
        desktopRoot,
        feedUrl: "https://updates.example.test/stable/",
        identity: "Enduragent Test (ABCDE12345)",
        baselineApplication: join(desktopRoot, "dist/baseline/Enduragent.app"),
      },
      { readFile: async () => JSON.stringify({ version: "2026.8.6" }) },
    );
    expect(release.builderOptions.config.extends).toBe(join(desktopRoot, "electron-builder.yml"));
    expect(release.builderOptions.config.forceCodeSigning).toBe(true);
    expect(release.builderOptions.config.extraMetadata).toEqual({
      version: "2026.8.6",
      enduragentDesktopRelease: true,
    });
    expect(DEVELOPMENT_APP_ID).not.toBe(builder.appId);
    expect(DEVELOPMENT_PRODUCT_NAME).not.toBe(builder.productName);
    expect(DEVELOPMENT_OUTPUT_DIRECTORY).not.toBe(builder.directories.output);
  });

  it("rejects package:dir arguments before loading the builder", () => {
    const script = join(desktopRoot, "scripts/development-package-plan.mjs");
    const result = spawnSync(process.execPath, [script, "--config.appId=icu.invalid"], {
      cwd: desktopRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("development package build failed\n");
  });
});
