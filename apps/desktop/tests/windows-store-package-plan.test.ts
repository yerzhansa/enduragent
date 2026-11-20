import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_PACKAGE_APP_ID,
  WINDOWS_PACKAGE_PRODUCT_NAME,
} from "../scripts/windows-package-plan.mjs";
import {
  WINDOWS_STORE_IDENTITY_ENVIRONMENT,
  WINDOWS_STORE_PACKAGE_APPLICATION_ID,
  WINDOWS_STORE_PACKAGE_ARCH,
  WINDOWS_STORE_PACKAGE_LANGUAGES,
  WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY,
  WINDOWS_STORE_PACKAGE_PLATFORM,
  WINDOWS_STORE_PACKAGE_TARGET,
  createWindowsStorePackagePlan,
  readWindowsStoreIdentity,
  runWindowsStorePackage,
  safeWindowsStorePackageMessage,
  windowsStorePackageArtifactName,
} from "../scripts/windows-store-package-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const syntheticVersion = "2026.8.11";
const readSyntheticManifest = async (_path: string, _encoding: "utf8"): Promise<string> =>
  `${JSON.stringify({ name: "@enduragent/desktop", version: syntheticVersion })}\n`;
const syntheticIdentity = Object.freeze({
  identityName: "00000Synthetic.EnduragentTest",
  publisher: "CN=00000000-0000-0000-0000-000000000000",
  publisherDisplayName: "Synthetic Publisher",
});
const syntheticEnvironment = Object.freeze({
  [WINDOWS_STORE_IDENTITY_ENVIRONMENT.identityName]: syntheticIdentity.identityName,
  [WINDOWS_STORE_IDENTITY_ENVIRONMENT.publisher]: syntheticIdentity.publisher,
  [WINDOWS_STORE_IDENTITY_ENVIRONMENT.publisherDisplayName]: syntheticIdentity.publisherDisplayName,
});
const expectedArtifact = join(
  desktopRoot,
  WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY,
  `Enduragent-${syntheticVersion}-x64.appx`,
);
const fileMetadata = (size: number) => ({ isFile: () => true, size });

describe("Windows Store package plan", () => {
  it("seals the unsigned x64 AppX plan with the Partner Center identity", async () => {
    const plan = await createWindowsStorePackagePlan(
      { desktopRoot, environment: syntheticEnvironment },
      { readFile: readSyntheticManifest },
    );
    const outputPath = join(desktopRoot, WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY);
    const applicationPath = join(outputPath, "win-unpacked");
    const artifactPattern = `Enduragent-${syntheticVersion}-x64.\${ext}`;

    expect(plan).toEqual({
      applicationPath,
      executablePath: join(applicationPath, "Enduragent.exe"),
      outputPath,
      builderOptions: {
        projectDir: desktopRoot,
        publish: "never",
        win: ["appx:x64"],
        config: {
          extends: join(desktopRoot, "electron-builder.yml"),
          appId: WINDOWS_PACKAGE_APP_ID,
          productName: WINDOWS_PACKAGE_PRODUCT_NAME,
          artifactName: artifactPattern,
          directories: { output: WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY },
          forceCodeSigning: false,
          extraMetadata: { version: syntheticVersion, enduragentDesktopRelease: true },
          win: {
            icon: "resources/app-icon.ico",
            signExecutable: false,
            requestedExecutionLevel: "asInvoker",
            files: ["resources/tray.ico"],
            target: [{ target: WINDOWS_STORE_PACKAGE_TARGET, arch: [WINDOWS_STORE_PACKAGE_ARCH] }],
          },
          appx: {
            artifactName: artifactPattern,
            applicationId: WINDOWS_STORE_PACKAGE_APPLICATION_ID,
            identityName: syntheticIdentity.identityName,
            publisher: syntheticIdentity.publisher,
            publisherDisplayName: syntheticIdentity.publisherDisplayName,
            displayName: "Enduragent",
            languages: ["en-US"],
            backgroundColor: "transparent",
            showNameOnTiles: false,
            addAutoLaunchExtension: false,
            capabilities: ["runFullTrust"],
            electronUpdaterAware: false,
            setBuildNumber: false,
            minVersion: "10.0.22000.0",
            maxVersionTested: "10.0.26100.0",
          },
        },
      },
      version: syntheticVersion,
      identity: syntheticIdentity,
      artifactName: `Enduragent-${syntheticVersion}-x64.appx`,
      artifactPath: expectedArtifact,
      platform: WINDOWS_STORE_PACKAGE_PLATFORM,
      arch: WINDOWS_STORE_PACKAGE_ARCH,
      target: WINDOWS_STORE_PACKAGE_TARGET,
      signed: false,
      distribution: "microsoft-store-submission",
      updateEligible: false,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.identity)).toBe(true);
    expect(WINDOWS_STORE_PACKAGE_LANGUAGES).toEqual(["en-US"]);
    expect(
      [plan.outputPath, plan.applicationPath, plan.executablePath, plan.artifactPath].every(
        isAbsolute,
      ),
    ).toBe(true);
    expect(relative(desktopRoot, plan.outputPath)).toBe(join("dist", "windows-store"));
    expect(plan.builderOptions.config).not.toHaveProperty("publish");
    expect(plan.builderOptions.config).not.toHaveProperty("nsis");
    expect(windowsStorePackageArtifactName(syntheticVersion)).toBe(
      `Enduragent-${syntheticVersion}-x64.appx`,
    );
  });

  it("starts with a digit-free application id so a numeric Partner Center name stays valid", () => {
    expect(WINDOWS_STORE_PACKAGE_APPLICATION_ID).toMatch(/^[A-Za-z][A-Za-z0-9]*$/u);
  });

  it.each([
    ["identityName", undefined],
    ["identityName", ""],
    ["identityName", "ab"],
    ["identityName", "a".repeat(51)],
    ["identityName", "Synthetic_Enduragent"],
    ["identityName", " Synthetic.Enduragent"],
    ["publisher", undefined],
    ["publisher", "CN=Synthetic Publisher"],
    ["publisher", "CN=00000000-0000-0000-0000-00000000000"],
    ["publisher", "cn=00000000-0000-0000-0000-000000000000"],
    ["publisher", "CN=0000000a-0000-0000-0000-000000000000"],
    ["publisher", "CN=00000000-0000-0000-0000-000000000000 "],
    ["publisherDisplayName", undefined],
    ["publisherDisplayName", ""],
    ["publisherDisplayName", " Synthetic Publisher"],
    ["publisherDisplayName", "Synthetic\nPublisher"],
    ["publisherDisplayName", "a".repeat(257)],
    ["publisherDisplayName", "Synthetic & Publisher"],
    ["publisherDisplayName", "Synthetic <Publisher>"],
  ] as const)("rejects %s %j and names the variable to fix", async (key, value) => {
    const name = WINDOWS_STORE_IDENTITY_ENVIRONMENT[key];
    const environment = { ...syntheticEnvironment, [name]: value };
    const readFile = vi.fn(readSyntheticManifest);

    expect(() => readWindowsStoreIdentity(environment)).toThrow(TypeError);
    let caught: unknown;
    try {
      readWindowsStoreIdentity(environment);
    } catch (error) {
      caught = error;
    }
    expect(safeWindowsStorePackageMessage(caught)).toMatch(
      new RegExp(`^${name} must be the Package/[A-Za-z/]+ from Partner Center$`, "u"),
    );
    await expect(
      createWindowsStorePackagePlan({ desktopRoot, environment }, { readFile }),
    ).rejects.toThrow(name);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps unknown failures out of the printed message", () => {
    expect(safeWindowsStorePackageMessage(new TypeError("C:\\Users\\Athlete\\secret"))).toBe(
      undefined,
    );
    expect(safeWindowsStorePackageMessage(new Error("desktop package version is invalid"))).toBe(
      undefined,
    );
    expect(
      safeWindowsStorePackageMessage(new TypeError("desktop package version is invalid")),
    ).toBe("desktop package version is invalid");
  });

  it("rejects an unstable desktop version and a relative desktop root", async () => {
    await expect(
      createWindowsStorePackagePlan(
        { desktopRoot, environment: syntheticEnvironment },
        { readFile: async () => `${JSON.stringify({ version: "1.2.3-beta.1" })}\n` },
      ),
    ).rejects.toThrow("desktop package version is invalid");
    await expect(
      createWindowsStorePackagePlan({ desktopRoot: "relative", environment: syntheticEnvironment }),
    ).rejects.toThrow("desktop root must be absolute");
  });

  it("cleans, builds, and checks the singleton non-empty artifact in order", async () => {
    const remove = vi.fn(async () => undefined);
    const build = vi.fn(async () => [expectedArtifact]);
    const inspect = vi.fn(async () => fileMetadata(4096));
    const stages: string[] = [];
    const result = await runWindowsStorePackage(
      { desktopRoot, environment: syntheticEnvironment },
      {
        readFile: readSyntheticManifest,
        rm: remove,
        build,
        stat: inspect,
        reportStage: (stage) => stages.push(stage),
      },
    );

    expect(stages).toEqual(["package-plan", "output-cleanup", "electron-builder", "artifact-set"]);
    expect(remove).toHaveBeenCalledWith(join(desktopRoot, "dist/windows-store"), {
      recursive: true,
      force: true,
    });
    expect(build).toHaveBeenCalledWith(result.plan.builderOptions);
    expect(inspect).toHaveBeenCalledWith(expectedArtifact);
    expect(result.artifacts).toEqual([expectedArtifact]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0]!);
  });

  it.each([
    [[]],
    [[expectedArtifact, `${expectedArtifact}.blockmap`]],
    [[join(desktopRoot, "dist/windows-store", `Enduragent-${syntheticVersion}-x64.msix`)]],
  ])("fails closed when the builder returns %j", async (artifacts) => {
    const inspect = vi.fn(async () => fileMetadata(4096));
    await expect(
      runWindowsStorePackage(
        { desktopRoot, environment: syntheticEnvironment },
        {
          readFile: readSyntheticManifest,
          rm: async () => undefined,
          build: async () => artifacts,
          stat: inspect,
        },
      ),
    ).rejects.toThrow("Windows Store package artifact set is invalid");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed when the artifact is empty or not a file", async () => {
    for (const metadata of [fileMetadata(0), { isFile: () => false, size: 4096 }]) {
      await expect(
        runWindowsStorePackage(
          { desktopRoot, environment: syntheticEnvironment },
          {
            readFile: readSyntheticManifest,
            rm: async () => undefined,
            build: async () => [expectedArtifact],
            stat: async () => metadata,
          },
        ),
      ).rejects.toThrow("Windows Store package artifact set is invalid");
    }
  });
});
