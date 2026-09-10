import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_PACKAGE_APP_ID,
  WINDOWS_PACKAGE_ARCH,
  WINDOWS_PACKAGE_DETERMINISM,
  WINDOWS_PACKAGE_GUID,
  WINDOWS_PACKAGE_INSTALLER_LANGUAGES,
  WINDOWS_PACKAGE_OUTPUT_DIRECTORY,
  WINDOWS_PACKAGE_PLATFORM,
  WINDOWS_PACKAGE_PRODUCT_NAME,
  WINDOWS_PACKAGE_TARGET,
  createWindowsPackagePlan,
  readWindowsDesktopVersion,
  requireWindowsDesktopVersion,
  runWindowsPackage,
  windowsPackageArtifactName,
} from "../scripts/windows-package-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const syntheticVersion = "2026.8.11";
const readSyntheticManifest = async (_path: string, _encoding: "utf8"): Promise<string> =>
  `${JSON.stringify({ name: "@enduragent/desktop", version: syntheticVersion })}\n`;
const verificationEvidence = Object.freeze({
  artifact: Object.freeze({
    name: `Enduragent-${syntheticVersion}-x64.exe`,
    size: 4096,
    sha256: "a".repeat(64),
    peMachine: 0x014c as const,
    nsisEnvelope: true as const,
  }),
  application: Object.freeze({
    fileCount: 20,
    directoryCount: 2,
    manifestSha256: "b".repeat(64),
    peMachine: 0x8664 as const,
  }),
});

describe("Windows NSIS package plan", () => {
  it("seals every frozen identity value in the unsigned x64 NSIS plan", async () => {
    const plan = await createWindowsPackagePlan(
      { desktopRoot },
      { readFile: readSyntheticManifest },
    );
    const outputPath = join(desktopRoot, WINDOWS_PACKAGE_OUTPUT_DIRECTORY);
    const applicationPath = join(outputPath, "win-unpacked");
    const artifactName = `Enduragent-${syntheticVersion}-x64.exe`;

    expect(plan).toEqual({
      applicationPath,
      executablePath: join(applicationPath, "Enduragent.exe"),
      outputPath,
      builderOptions: {
        projectDir: desktopRoot,
        publish: "never",
        win: ["nsis:x64"],
        config: {
          extends: join(desktopRoot, "electron-builder.yml"),
          appId: WINDOWS_PACKAGE_APP_ID,
          productName: WINDOWS_PACKAGE_PRODUCT_NAME,
          artifactName: `Enduragent-${syntheticVersion}-x64.\${ext}`,
          directories: { output: WINDOWS_PACKAGE_OUTPUT_DIRECTORY },
          forceCodeSigning: false,
          extraMetadata: { version: syntheticVersion },
          win: {
            icon: "resources/app-icon.ico",
            signExecutable: false,
            requestedExecutionLevel: "asInvoker",
            files: ["resources/tray.ico"],
            target: [{ target: WINDOWS_PACKAGE_TARGET, arch: [WINDOWS_PACKAGE_ARCH] }],
          },
          nsis: {
            artifactName: `Enduragent-${syntheticVersion}-x64.\${ext}`,
            guid: WINDOWS_PACKAGE_GUID,
            oneClick: true,
            perMachine: false,
            packElevateHelper: false,
            createStartMenuShortcut: true,
            createDesktopShortcut: false,
            deleteAppDataOnUninstall: false,
            installerLanguages: [...WINDOWS_PACKAGE_INSTALLER_LANGUAGES],
            language: "1033",
            multiLanguageInstaller: true,
            displayLanguageSelector: false,
            differentialPackage: false,
            buildUniversalInstaller: false,
            include: "build/installer.nsh",
          },
        },
      },
      version: syntheticVersion,
      artifactName,
      artifactPath: join(outputPath, artifactName),
      platform: WINDOWS_PACKAGE_PLATFORM,
      arch: WINDOWS_PACKAGE_ARCH,
      target: WINDOWS_PACKAGE_TARGET,
      signed: false,
      distribution: "private-test-only",
      updateEligible: false,
      determinism: WINDOWS_PACKAGE_DETERMINISM,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.determinism)).toBe(true);
    expect(
      [plan.outputPath, plan.applicationPath, plan.executablePath, plan.artifactPath].every(
        isAbsolute,
      ),
    ).toBe(true);
    expect(relative(desktopRoot, plan.outputPath)).toBe(join("dist", "windows"));
    expect(plan.builderOptions.config).not.toHaveProperty("publish");
    expect(plan.builderOptions.config.extraMetadata).not.toHaveProperty("enduragentDesktopRelease");
  });

  it("reads the artifact version from the desktop manifest", async () => {
    const readFile = vi.fn(readSyntheticManifest);
    await expect(readWindowsDesktopVersion({ desktopRoot }, { readFile })).resolves.toBe(
      syntheticVersion,
    );
    expect(readFile).toHaveBeenCalledWith(join(desktopRoot, "package.json"), "utf8");
    expect(windowsPackageArtifactName(syntheticVersion)).toBe(
      `Enduragent-${syntheticVersion}-x64.exe`,
    );
  });

  it.each(["", "1", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta.1", "v1.2.3", 123, null])(
    "rejects unstable or invalid desktop version %j",
    async (version) => {
      expect(() => requireWindowsDesktopVersion(version)).toThrow(
        "desktop package version is invalid",
      );
      await expect(
        readWindowsDesktopVersion(
          { desktopRoot },
          {
            readFile: async () => `${JSON.stringify({ version })}\n`,
          },
        ),
      ).rejects.toThrow("desktop package version is invalid");
    },
  );

  it("rejects an invalid manifest and a relative desktop root", async () => {
    await expect(
      readWindowsDesktopVersion(
        { desktopRoot },
        {
          readFile: async () => "not json",
        },
      ),
    ).rejects.toThrow("desktop package manifest is invalid");
    await expect(createWindowsPackagePlan({ desktopRoot: "relative" })).rejects.toThrow(
      "desktop root must be absolute",
    );
  });

  it("cleans, builds, checks the singleton artifact, and verifies in order", async () => {
    const expectedArtifact = join(
      desktopRoot,
      WINDOWS_PACKAGE_OUTPUT_DIRECTORY,
      `Enduragent-${syntheticVersion}-x64.exe`,
    );
    const remove = vi.fn(async () => undefined);
    const build = vi.fn(async () => [expectedArtifact]);
    const verifyWindowsPackage = vi.fn(async () => verificationEvidence);
    const stages: string[] = [];
    const result = await runWindowsPackage(
      { desktopRoot },
      {
        readFile: readSyntheticManifest,
        rm: remove,
        build,
        verifyWindowsPackage,
        reportStage: (stage) => stages.push(stage),
      },
    );

    expect(stages).toEqual([
      "package-plan",
      "output-cleanup",
      "electron-builder",
      "artifact-set",
      "package-verification",
    ]);
    expect(remove).toHaveBeenCalledWith(join(desktopRoot, "dist/windows"), {
      recursive: true,
      force: true,
    });
    expect(build).toHaveBeenCalledWith(result.plan.builderOptions);
    expect(verifyWindowsPackage).toHaveBeenCalledWith(
      expectedArtifact,
      join(desktopRoot, WINDOWS_PACKAGE_OUTPUT_DIRECTORY, "win-unpacked"),
      { desktopRoot },
    );
    expect(result.evidence).toBe(verificationEvidence);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0]!);
    expect(build.mock.invocationCallOrder[0]).toBeLessThan(
      verifyWindowsPackage.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed before verification when builder returns any other artifact set", async () => {
    const verifyWindowsPackage = vi.fn(async () => verificationEvidence);
    await expect(
      runWindowsPackage(
        { desktopRoot },
        {
          readFile: readSyntheticManifest,
          rm: async () => undefined,
          build: async () => [
            join(desktopRoot, "dist/windows", `Enduragent-${syntheticVersion}-x64.exe`),
            join(desktopRoot, "dist/windows", `Enduragent-${syntheticVersion}-x64.exe.blockmap`),
          ],
          verifyWindowsPackage,
        },
      ),
    ).rejects.toThrow("Windows package artifact set is invalid");
    expect(verifyWindowsPackage).not.toHaveBeenCalled();
  });
});
