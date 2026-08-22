import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  createMacosReleasePlan,
  macosReleaseEnvelopePath,
  notarizeMacosDmg,
  promoteMacosReleaseEnvelope,
  requireDeveloperIdIdentity,
  requireMacosBaselineApplication,
  requireNotarizationCredentials,
  runMacosRelease,
  safeMacosReleasePlanMessage,
  sealMacosReleaseMetadata,
} from "../scripts/macos-release-plan.mjs";
import type {
  MacosReleaseBuilderOptions,
  MacosReleasePlan,
} from "../scripts/macos-release-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const feedUrl = "https://updates.example.test/stable/";
const identity = "Enduragent Test (ABCDE12345)";
const baselineApplication = "/synthetic/prior/Enduragent.app";
const notarizationEnvironment = {
  APPLE_API_KEY: "/synthetic/AuthKey.p8",
  APPLE_API_KEY_ID: "SYNTHETICKEY",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};
const verifiedLooseIdentity = Object.freeze({
  baselineVersion: "2026.7.1",
  candidateVersion: "2026.7.2",
  teamIdentifier: "FA494ACVTF",
  candidateCodeIdentity: Object.freeze({
    codeDirectory: "v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded",
    codeDirectorySha256: "b".repeat(64),
    cdHash: "b".repeat(40),
  }),
});
const verifiedBaselineApplication = Object.freeze({
  baselineVersion: "2026.7.1",
  teamIdentifier: "FA494ACVTF",
});
const verifiedBackendSelection = Object.freeze({
  binding:
    "/synthetic/Enduragent.app/Contents/Resources/app.asar.unpacked/native/keychain-binding.node",
  service: "icu.enduragent.desktop",
  teamIdentifier: "FA494ACVTF",
  designatedRequirement: 'identifier "keychain-binding.node" and anchor apple generic',
});
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function versionReader(version = "2026.7.2") {
  return vi.fn(async () => JSON.stringify({ version }));
}

function canonicalDmgSigningIdentityResult() {
  return {
    stdout: "",
    stderr: [
      "Authority=Developer ID Application: Enduragent Test (FA494ACVTF)",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      "TeamIdentifier=FA494ACVTF",
    ].join("\n"),
  };
}

function baselineVerifier() {
  return vi.fn(async () => verifiedBaselineApplication);
}

function keychainBindingPreparer() {
  return vi.fn(async (_desktopRoot: string) => ({
    built: "/synthetic/keychain-binding.node",
    staged: "/synthetic/ASAR-staging/native/keychain-binding.node",
  }));
}

function keychainBindingVerifier() {
  return vi.fn(async () => {});
}

function electronFusesVerifier() {
  return vi.fn(async () => {});
}

function backendSelectionVerifier() {
  return vi.fn(async () => verifiedBackendSelection);
}

function verifiedReleaseArtifactsAt(artifactDirectory: string) {
  const artifactNames = {
    dmg: "Enduragent-2026.7.2-arm64.dmg",
    zip: "Enduragent-2026.7.2-arm64.zip",
    blockmap: "Enduragent-2026.7.2-arm64.zip.blockmap",
    metadata: "latest-mac.yml" as const,
  };
  return Object.freeze({
    version: "2026.7.2",
    names: artifactNames,
    paths: Object.freeze({
      dmg: join(artifactDirectory, artifactNames.dmg),
      zip: join(artifactDirectory, artifactNames.zip),
      blockmap: join(artifactDirectory, artifactNames.blockmap),
      metadata: join(artifactDirectory, artifactNames.metadata),
    }),
    sizes: Object.freeze({ dmg: 1, zip: 1, blockmap: 1 }),
    dmgSha512: "synthetic-dmg-sha512",
    zipSha512: "synthetic-zip-sha512",
  });
}

async function metadataSealFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-metadata-seal-"));
  temporaryRoots.push(root);
  const fixtureDesktopRoot = join(root, "desktop");
  const artifactDirectory = join(fixtureDesktopRoot, "dist");
  await mkdir(artifactDirectory, { recursive: true });
  const plan = await createMacosReleasePlan(
    {
      repositoryRoot: join(root, "repository"),
      desktopRoot: fixtureDesktopRoot,
      feedUrl,
      identity,
      baselineApplication,
    },
    { readFile: versionReader() },
  );
  const zip = Buffer.from("synthetic release ZIP\n");
  const dmg = Buffer.from("synthetic release DMG\n");
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const metadataPath = join(artifactDirectory, plan.artifactNames.metadata);
  await Promise.all([
    writeFile(join(artifactDirectory, plan.artifactNames.zip), zip),
    writeFile(join(artifactDirectory, plan.artifactNames.dmg), dmg),
    writeFile(join(artifactDirectory, plan.artifactNames.blockmap), "synthetic blockmap\n"),
    writeFile(
      metadataPath,
      [
        `version: ${plan.version}`,
        "files:",
        `  - url: ${plan.artifactNames.zip}`,
        `    sha512: ${zipSha512}`,
        `    size: ${zip.length}`,
        `path: ${plan.artifactNames.zip}`,
        `sha512: ${zipSha512}`,
        "releaseDate: '2026-07-24T00:00:00.000Z'",
        "",
      ].join("\n"),
    ),
  ]);
  return {
    artifactDirectory,
    dmg,
    dmgSha512,
    metadataPath,
    plan,
    zip,
    zipSha512,
  };
}

describe.skipIf(process.platform === "win32")("macOS release plan", () => {
  it("exposes only controlled release-plan failures to the release log", () => {
    expect(
      safeMacosReleasePlanMessage(new TypeError("release envelope changed during verification")),
    ).toBe("release envelope changed during verification");
    expect(safeMacosReleasePlanMessage(new TypeError("unstable verified DMG artifact"))).toBe(
      "unstable verified DMG artifact",
    );
    expect(
      safeMacosReleasePlanMessage(new TypeError("must-not-reach-release-logs")),
    ).toBeUndefined();
  });

  it("uses only the desktop package version and creates the exact sealed overlay", async () => {
    const readVersion = versionReader();
    const plan = await createMacosReleasePlan(
      {
        repositoryRoot: "/synthetic/repository",
        desktopRoot: "/synthetic/repository/apps/desktop",
        feedUrl,
        identity,
        baselineApplication,
      },
      { readFile: readVersion },
    );
    expect(readVersion).toHaveBeenCalledOnce();
    expect(readVersion).toHaveBeenCalledWith(
      "/synthetic/repository/apps/desktop/package.json",
      "utf8",
    );
    expect(plan.version).toBe("2026.7.2");
    expect(plan.baselineApplication).toBe(baselineApplication);
    expect(plan.artifactNames).toEqual({
      dmg: "Enduragent-2026.7.2-arm64.dmg",
      zip: "Enduragent-2026.7.2-arm64.zip",
      blockmap: "Enduragent-2026.7.2-arm64.zip.blockmap",
      metadata: "latest-mac.yml",
    });
    expect(plan.builderOptions.publish).toBe("never");
    expect(plan.builderOptions.config.forceCodeSigning).toBe(true);
    expect(plan.builderOptions.config.extraMetadata).toEqual({
      version: "2026.7.2",
      enduragentDesktopRelease: true,
    });
    expect(Object.keys(plan.builderOptions.config.extraMetadata).sort()).toEqual([
      "enduragentDesktopRelease",
      "version",
    ]);
    expect(plan.builderOptions.config.publish).toEqual([
      { provider: "generic", url: feedUrl, channel: "latest" },
    ]);
    expect(plan.builderOptions.config.mac).toEqual({
      target: [
        { target: "dmg", arch: ["arm64"] },
        { target: "zip", arch: ["arm64"] },
      ],
      identity,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true,
    });
    expect(plan.builderOptions.config.dmg).toEqual({
      sign: true,
      writeUpdateInfo: false,
    });
  });

  it("accepts only a bounded unprefixed Developer ID lookup qualifier", () => {
    expect(requireDeveloperIdIdentity(identity)).toBe(identity);
    for (const prefixed of [
      `Developer ID Application: ${identity}`,
      `Developer ID Installer: ${identity}`,
      `3rd Party Mac Developer Application: ${identity}`,
      `3rd Party Mac Developer Installer: ${identity}`,
    ]) {
      expect(() => requireDeveloperIdIdentity(prefixed)).toThrow(
        "Developer ID identity qualifier is invalid",
      );
    }
    for (const invalid of [
      "",
      " ",
      ` ${identity}`,
      `${identity} `,
      `Enduragent\nTest`,
      "x".repeat(513),
    ]) {
      expect(() => requireDeveloperIdIdentity(invalid)).toThrow(
        "Developer ID identity qualifier is invalid",
      );
    }
  });

  it("requires an absolute signed baseline distinct from the build candidate", async () => {
    expect(requireMacosBaselineApplication(baselineApplication)).toBe(baselineApplication);
    for (const invalid of [
      undefined,
      "",
      "Enduragent.app",
      " /Applications/Enduragent.app",
      "/bad\napp",
    ]) {
      expect(() => requireMacosBaselineApplication(invalid)).toThrow(
        "signed baseline application path is invalid",
      );
    }
    await expect(
      createMacosReleasePlan(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication:
            "/synthetic/repository/apps/desktop/dist/mac-arm64/../mac-arm64/Enduragent.app",
        },
        { readFile: versionReader() },
      ),
    ).rejects.toThrow("signed baseline application must differ from candidate");
  });

  it("fails baseline preflight before loading or invoking electron-builder", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication: undefined,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
        },
      ),
    ).rejects.toThrow("signed baseline application path is invalid");
    expect(build).not.toHaveBeenCalled();
  });

  it("fails the steady CLI with a safe actionable stage", () => {
    const secretSentinel = "must-not-reach-stderr";
    const result = spawnSync(
      process.execPath,
      [join(desktopRoot, "scripts/macos-release-plan.mjs")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ENDURAGENT_DESKTOP_UPDATE_URL: feedUrl,
          ENDURAGENT_DEVELOPER_ID_IDENTITY: identity,
          ENDURAGENT_MACOS_BASELINE_APP: "/synthetic/missing/Enduragent.app",
          APPLE_API_KEY: `/synthetic/${secretSentinel}.p8`,
          APPLE_API_KEY_ID: "SYNTHETICKEY",
          APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
          NODE_OPTIONS: "--unhandled-rejections=none",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "macOS release build failed at baseline-verification: baseline application bundle is invalid",
    );
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.stderr).not.toContain(secretSentinel);
  });

  it("fails closed when the steady release command never settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-release-cli-unsettled-"));
    temporaryRoots.push(root);
    const scripts = join(await realpath(root), "scripts");
    await mkdir(scripts);
    const releaseCli = await readFile(join(desktopRoot, "scripts/macos-release-cli.mjs"), "utf8");
    await Promise.all([
      writeFile(join(scripts, "macos-release-cli.mjs"), releaseCli),
      writeFile(
        join(scripts, "macos-release-plan.mjs"),
        [
          "export function safeMacosReleasePlanMessage() { return undefined; }",
          "export async function runMacosRelease() { await new Promise(() => {}); }",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(scripts, "verify-macos-release.mjs"),
        "export function safeMacosReleaseVerificationMessage() { return undefined; }\n",
      ),
    ]);

    const result = spawnSync(process.execPath, [join(scripts, "macos-release-cli.mjs")], {
      encoding: "utf8",
    });

    expect(result.status).toBe(13);
    expect(result.signal).toBeNull();
  });

  it("rejects a missing absolute baseline before invoking electron-builder", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication: "/synthetic/missing/Enduragent.app",
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
        },
      ),
    ).rejects.toThrow("baseline application bundle is invalid");
    expect(build).not.toHaveBeenCalled();
  });

  it("rejects an invalid signed baseline before invoking electron-builder", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-invalid-release-baseline-"));
    temporaryRoots.push(root);
    const invalidBaseline = join(root, "Enduragent.app");
    await mkdir(join(invalidBaseline, "Contents/Resources"), { recursive: true });
    await Promise.all([
      writeFile(join(invalidBaseline, "Contents/Info.plist"), "synthetic plist\n"),
      writeFile(join(invalidBaseline, "Contents/Resources/app.asar"), "synthetic ASAR\n"),
    ]);
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic invalid baseline signature");
    });

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication: invalidBaseline,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          executeFile,
        },
      ),
    ).rejects.toThrow("macOS application signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
    expect(executeFile).toHaveBeenCalledWith("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      invalidBaseline,
    ]);
    expect(build).not.toHaveBeenCalled();
  });

  it("stops before electron-builder when fresh keychain binding preparation fails", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const failure = new Error("synthetic keychain binding preparation failure");
    const prepareKeychainBinding = vi.fn(async () => {
      throw failure;
    });

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding,
          verifyBaselineApplication: baselineVerifier(),
        },
      ),
    ).rejects.toBe(failure);
    expect(prepareKeychainBinding).toHaveBeenCalledOnce();
    expect(prepareKeychainBinding).toHaveBeenCalledWith(
      "/synthetic/repository/apps/desktop",
    );
    expect(build).not.toHaveBeenCalled();
  });

  it("matches the pinned builder identity qualifier contract without reading a keychain", async () => {
    const localRequire = createRequire(import.meta.url);
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    const builderManifest = builderRequire("app-builder-lib/package.json") as {
      version: string;
    };
    const macCodeSign = builderRequire("app-builder-lib/out/codeSign/macCodeSign") as {
      appleCertificatePrefixes: string[];
      findIdentityRawResult: Promise<string[]> | null;
      findIdentity(type: "Developer ID Application", qualifier: string): Promise<unknown>;
    };
    expect(builderManifest.version).toBe("26.15.3");
    expect(macCodeSign.appleCertificatePrefixes).toEqual([
      "Developer ID Application:",
      "Developer ID Installer:",
      "3rd Party Mac Developer Application:",
      "3rd Party Mac Developer Installer:",
    ]);

    const originalRawResult = macCodeSign.findIdentityRawResult;
    macCodeSign.findIdentityRawResult = Promise.resolve([]);
    try {
      expect(() =>
        macCodeSign.findIdentity(
          "Developer ID Application",
          `Developer ID Application: ${identity}`,
        ),
      ).toThrow("Please remove prefix");
      const lookup = macCodeSign.findIdentity("Developer ID Application", identity);
      expect(lookup).toBeInstanceOf(Promise);
      await expect(lookup).resolves.toBeNull();
    } finally {
      macCodeSign.findIdentityRawResult = originalRawResult;
    }
  });

  it("notarizes the DMG before sealing, promoting, and verifying the exact envelope", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => [
      "/synthetic/Enduragent-2026.7.2-arm64.dmg",
    ]);
    const prepareKeychainBinding = keychainBindingPreparer();
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const verifyKeychainBinding = keychainBindingVerifier();
    const verifyElectronFuses = electronFusesVerifier();
    const verifyBackendSelection = backendSelectionVerifier();
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
        return canonicalDmgSigningIdentityResult();
      }
      return { stdout: "", stderr: "" };
    });
    const notarize = vi.fn(async () => {});
    const verifyBaselineApplication = baselineVerifier();
    const verifyIdentityContinuity = vi.fn(async () => verifiedLooseIdentity);
    const verifyReleaseApplicationContents = vi.fn(async () => {});
    const envelopePath =
      "/synthetic/repository/apps/desktop/dist/release-envelope-2026.7.2-mac-arm64";
    const temporaryEnvelopePath =
      "/synthetic/repository/apps/desktop/dist/.release-envelope-2026.7.2-mac-arm64-test";
    const promotionCommitted = vi.fn();
    const promoteReleaseEnvelope = vi.fn(
      async (
        _plan: MacosReleasePlan,
        verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
      ) => {
        await verifyEnvelope(temporaryEnvelopePath);
        promotionCommitted();
        return envelopePath;
      },
    );
    const verifyReleaseArtifacts = vi.fn(async (artifactDirectory: string) =>
      verifiedReleaseArtifactsAt(artifactDirectory),
    );
    const reportStage = vi.fn();
    const result = await runMacosRelease(
      {
        repositoryRoot: "/synthetic/repository",
        desktopRoot: "/synthetic/repository/apps/desktop",
        feedUrl,
        identity,
        baselineApplication,
      },
      {
        readFile: versionReader(),
        environment: notarizationEnvironment,
        build,
        prepareKeychainBinding,
        executeFile,
        notarize,
        sealReleaseMetadata,
        verifyBaselineApplication,
        verifyPackageLayout,
        verifyKeychainBinding,
        verifyElectronFuses,
        verifyBackendSelection,
        verifyIdentityContinuity,
        verifyReleaseApplicationContents,
        promoteReleaseEnvelope,
        verifyReleaseArtifacts,
        reportStage,
      },
    );
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(result.plan.builderOptions);
    expect(build.mock.calls[0]![0].publish).toBe("never");
    expect(sealReleaseMetadata).toHaveBeenCalledOnce();
    expect(sealReleaseMetadata).toHaveBeenCalledWith(result.plan);
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledWith(
      "/synthetic/repository/apps/desktop/dist/mac-arm64/Enduragent.app",
      {
        desktopRoot: "/synthetic/repository/apps/desktop",
        release: {
          version: "2026.7.2",
          feedUrl,
        },
      },
    );
    const application = "/synthetic/repository/apps/desktop/dist/mac-arm64/Enduragent.app";
    const dmg = "/synthetic/repository/apps/desktop/dist/Enduragent-2026.7.2-arm64.dmg";
    expect(verifyBaselineApplication).toHaveBeenCalledOnce();
    expect(verifyBaselineApplication).toHaveBeenCalledWith(baselineApplication, {
      candidateVersion: "2026.7.2",
    });
    expect(notarize).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledWith({
      appPath: dmg,
      tool: "notarytool",
      appleApiKey: notarizationEnvironment.APPLE_API_KEY,
      appleApiKeyId: notarizationEnvironment.APPLE_API_KEY_ID,
      appleApiIssuer: notarizationEnvironment.APPLE_API_ISSUER,
    });
    expect(verifyIdentityContinuity).toHaveBeenCalledWith(baselineApplication, application, {
      candidateVersion: "2026.7.2",
    });
    expect(verifyIdentityContinuity).toHaveBeenCalledTimes(2);
    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--verbose=2", dmg]],
      ["/usr/bin/codesign", ["--display", "--verbose=4", dmg]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", dmg]],
      [
        "/usr/sbin/spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          "--verbose=4",
          dmg,
        ],
      ],
    ]);
    expect(promoteReleaseEnvelope).toHaveBeenCalledOnce();
    expect(promoteReleaseEnvelope).toHaveBeenCalledWith(result.plan, expect.any(Function));
    expect(verifyReleaseArtifacts).toHaveBeenCalledWith(
      temporaryEnvelopePath,
      {
        repositoryRoot: "/synthetic/repository",
        readVersionFile: expect.any(Function),
      },
      expect.objectContaining({ executeFile }),
    );
    expect(verifyReleaseApplicationContents).toHaveBeenCalledWith(
      temporaryEnvelopePath,
      baselineApplication,
      {
        candidateVersion: "2026.7.2",
        looseCandidateCodeIdentity: verifiedLooseIdentity.candidateCodeIdentity,
      },
      expect.objectContaining({ executeFile }),
    );
    expect(result.envelopePath).toBe(envelopePath);
    expect(verifyBaselineApplication.mock.invocationCallOrder[0]).toBeLessThan(
      prepareKeychainBinding.mock.invocationCallOrder[0]!,
    );
    expect(prepareKeychainBinding).toHaveBeenCalledOnce();
    expect(prepareKeychainBinding).toHaveBeenCalledWith(
      "/synthetic/repository/apps/desktop",
    );
    expect(prepareKeychainBinding.mock.invocationCallOrder[0]).toBeLessThan(
      build.mock.invocationCallOrder[0]!,
    );
    expect(build.mock.invocationCallOrder[0]).toBeLessThan(
      verifyPackageLayout.mock.invocationCallOrder[0]!,
    );
    expect(verifyKeychainBinding).toHaveBeenCalledOnce();
    expect(verifyKeychainBinding).toHaveBeenCalledWith(application);
    expect(verifyPackageLayout.mock.invocationCallOrder[0]).toBeLessThan(
      verifyKeychainBinding.mock.invocationCallOrder[0]!,
    );
    expect(verifyElectronFuses).toHaveBeenCalledOnce();
    expect(verifyElectronFuses).toHaveBeenCalledWith(
      join(application, "Contents/MacOS/Enduragent"),
    );
    expect(verifyKeychainBinding.mock.invocationCallOrder[0]).toBeLessThan(
      verifyElectronFuses.mock.invocationCallOrder[0]!,
    );
    expect(verifyBackendSelection).toHaveBeenCalledOnce();
    expect(verifyBackendSelection).toHaveBeenCalledWith(application);
    expect(verifyElectronFuses.mock.invocationCallOrder[0]).toBeLessThan(
      verifyIdentityContinuity.mock.invocationCallOrder[0]!,
    );
    expect(verifyIdentityContinuity.mock.invocationCallOrder[0]).toBeLessThan(
      verifyBackendSelection.mock.invocationCallOrder[0]!,
    );
    expect(verifyBackendSelection.mock.invocationCallOrder[0]).toBeLessThan(
      notarize.mock.invocationCallOrder[0]!,
    );
    expect(notarize.mock.invocationCallOrder[0]).toBeLessThan(
      executeFile.mock.invocationCallOrder[0]!,
    );
    expect(
      executeFile.mock.invocationCallOrder[executeFile.mock.invocationCallOrder.length - 1]!,
    ).toBeLessThan(sealReleaseMetadata.mock.invocationCallOrder[0]!);
    expect(sealReleaseMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      promoteReleaseEnvelope.mock.invocationCallOrder[0]!,
    );
    expect(verifyReleaseArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      verifyIdentityContinuity.mock.invocationCallOrder[1]!,
    );
    expect(verifyIdentityContinuity.mock.invocationCallOrder[1]).toBeLessThan(
      verifyReleaseApplicationContents.mock.invocationCallOrder[0]!,
    );
    expect(verifyReleaseApplicationContents.mock.invocationCallOrder[0]).toBeLessThan(
      promotionCommitted.mock.invocationCallOrder[0]!,
    );
    expect(reportStage.mock.calls.map(([stage]) => stage)).toEqual([
      "release-plan",
      "notarization-credentials",
      "baseline-verification",
      "keychain-binding-preparation",
      "electron-builder",
      "package-layout",
      "keychain-binding",
      "electron-fuses",
      "identity-continuity",
      "backend-selection",
      "dmg-notarization",
      "dmg-verification",
      "metadata-sealing",
      "envelope-promotion",
    ]);
  });

  it("propagates release package-layout verification failures", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const failure = new Error("release package layout rejected");
    const verifyPackageLayout = vi.fn(async () => {
      throw failure;
    });
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding: keychainBindingPreparer(),
          sealReleaseMetadata,
          verifyBaselineApplication: baselineVerifier(),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection: backendSelectionVerifier(),
          verifyPackageLayout,
        },
      ),
    ).rejects.toBe(failure);
    expect(build).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
  });

  it("fails the release before notarization when backend selection is rejected", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const notarize = vi.fn(async () => {});
    const verifyIdentityContinuity = vi.fn(async () => verifiedLooseIdentity);
    const failure = new Error("bundled keychain binding refused the capability probe");
    const verifyBackendSelection = vi.fn(async () => {
      throw failure;
    });
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding: keychainBindingPreparer(),
          sealReleaseMetadata,
          notarize,
          verifyBaselineApplication: baselineVerifier(),
          verifyPackageLayout: vi.fn(async () => {}),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection,
          verifyIdentityContinuity,
        },
      ),
    ).rejects.toBe(failure);
    expect(verifyBackendSelection).toHaveBeenCalledOnce();
    expect(verifyIdentityContinuity).toHaveBeenCalledOnce();
    expect(verifyIdentityContinuity.mock.invocationCallOrder[0]).toBeLessThan(
      verifyBackendSelection.mock.invocationCallOrder[0]!,
    );
    expect(notarize).not.toHaveBeenCalled();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
  });

  it("fails closed after notarization and native verification when metadata sealing fails", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const failure = new Error("release metadata rejected");
    const sealReleaseMetadata = vi.fn(async () => {
      throw failure;
    });
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
        return canonicalDmgSigningIdentityResult();
      }
      return { stdout: "", stderr: "" };
    });
    const notarize = vi.fn(async () => {});
    const verifyIdentityContinuity = vi.fn(async () => verifiedLooseIdentity);
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding: keychainBindingPreparer(),
          executeFile,
          notarize,
          sealReleaseMetadata,
          verifyBaselineApplication: baselineVerifier(),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection: backendSelectionVerifier(),
          verifyPackageLayout,
          verifyIdentityContinuity,
          promoteReleaseEnvelope,
        },
      ),
    ).rejects.toBe(failure);
    expect(build).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledOnce();
    expect(verifyIdentityContinuity).toHaveBeenCalledOnce();
    expect(executeFile).toHaveBeenCalledTimes(4);
    expect(sealReleaseMetadata).toHaveBeenCalledOnce();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
  });

  it("requires exactly one complete notarization credential set", () => {
    expect(
      requireNotarizationCredentials({
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toEqual({
      name: "apple-id",
      options: {
        appleId: "release@example.test",
        appleIdPassword: "synthetic-password",
        teamId: "ABCDE12345",
      },
    });
    expect(requireNotarizationCredentials(notarizationEnvironment)).toEqual({
      name: "api-key",
      options: {
        appleApiKey: "/synthetic/AuthKey.p8",
        appleApiKeyId: "SYNTHETICKEY",
        appleApiIssuer: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(
      requireNotarizationCredentials({
        APPLE_KEYCHAIN: "/synthetic/login.keychain-db",
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      }),
    ).toEqual({
      name: "keychain-profile",
      options: {
        keychain: "/synthetic/login.keychain-db",
        keychainProfile: "enduragent-notary",
      },
    });
    expect(
      requireNotarizationCredentials({
        APPLE_KEYCHAIN_PROFILE: "enduragent-default-keychain-notary",
      }),
    ).toEqual({
      name: "keychain-profile",
      options: {
        keychainProfile: "enduragent-default-keychain-notary",
      },
    });

    expect(() => requireNotarizationCredentials({})).toThrow(
      "notarization credentials are missing",
    );
    expect(() =>
      requireNotarizationCredentials({
        APPLE_ID: "release@example.test",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toThrow("notarization credentials are incomplete");
    expect(() =>
      requireNotarizationCredentials({
        ...notarizationEnvironment,
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toThrow("notarization credential configuration is ambiguous");
  });

  it.each([
    {
      environment: {
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      },
      options: {
        appleId: "release@example.test",
        appleIdPassword: "synthetic-password",
        teamId: "ABCDE12345",
      },
    },
    {
      environment: notarizationEnvironment,
      options: {
        appleApiKey: "/synthetic/AuthKey.p8",
        appleApiKeyId: "SYNTHETICKEY",
        appleApiIssuer: "00000000-0000-0000-0000-000000000000",
      },
    },
    {
      environment: {
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      },
      options: {
        keychainProfile: "enduragent-notary",
      },
    },
    {
      environment: {
        APPLE_KEYCHAIN: "/synthetic/login.keychain-db",
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      },
      options: {
        keychain: "/synthetic/login.keychain-db",
        keychainProfile: "enduragent-notary",
      },
    },
  ])("maps the selected credential strategy exactly into the pinned API", async (fixture) => {
    const notarize = vi.fn(async () => {});
    const credentials = requireNotarizationCredentials(fixture.environment);

    await notarizeMacosDmg("/synthetic/Enduragent.dmg", credentials, { notarize });

    expect(notarize).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledWith({
      appPath: "/synthetic/Enduragent.dmg",
      tool: "notarytool",
      ...fixture.options,
    });
  });

  it("keeps DMG path and notarytool authoritative over credential option fields", async () => {
    const notarize = vi.fn(async () => {});
    const credentials = {
      name: "keychain-profile",
      options: {
        keychainProfile: "enduragent-notary",
        appPath: "/synthetic/untrusted.dmg",
        tool: "legacy",
      },
    } as never;

    await notarizeMacosDmg("/synthetic/authoritative.dmg", credentials, {
      notarize,
    });

    expect(notarize).toHaveBeenCalledWith({
      keychainProfile: "enduragent-notary",
      appPath: "/synthetic/authoritative.dmg",
      tool: "notarytool",
    });
  });

  it("fails credential preflight before loading or invoking electron-builder", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: {},
          build,
          sealReleaseMetadata,
        },
      ),
    ).rejects.toThrow("notarization credentials are missing");
    expect(build).not.toHaveBeenCalled();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
  });

  it("stops before notarization and promotion when signed identity continuity fails", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const failure = new Error("synthetic identity continuity failure");
    const verifyIdentityContinuity = vi.fn(async () => {
      throw failure;
    });
    const notarize = vi.fn(async () => {});
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");
    const verifyReleaseArtifacts = vi.fn(async (artifactDirectory: string) =>
      verifiedReleaseArtifactsAt(artifactDirectory),
    );
    const verifyBackendSelection = backendSelectionVerifier();

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding: keychainBindingPreparer(),
          sealReleaseMetadata,
          verifyBaselineApplication: baselineVerifier(),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection,
          verifyPackageLayout,
          verifyIdentityContinuity,
          notarize,
          promoteReleaseEnvelope,
          verifyReleaseArtifacts,
        },
      ),
    ).rejects.toBe(failure);
    expect(verifyIdentityContinuity).toHaveBeenCalledOnce();
    expect(verifyBackendSelection).not.toHaveBeenCalled();
    expect(notarize).not.toHaveBeenCalled();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
    expect(verifyReleaseArtifacts).not.toHaveBeenCalled();
  });

  it("redacts notarize or staple failures and stops before sealing or promotion", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async () => {});
    const verifyIdentityContinuity = vi.fn(async () => verifiedLooseIdentity);
    const notarize = vi.fn(async () => {
      throw new Error(`submission failed for ${notarizationEnvironment.APPLE_API_KEY_ID}`);
    });
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");

    let failure: unknown;
    try {
      await runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          prepareKeychainBinding: keychainBindingPreparer(),
          verifyBaselineApplication: baselineVerifier(),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection: backendSelectionVerifier(),
          verifyPackageLayout,
          verifyIdentityContinuity,
          executeFile,
          notarize,
          sealReleaseMetadata,
          promoteReleaseEnvelope,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("macOS DMG notarization failed");
    expect((failure as Error).message).not.toContain(notarizationEnvironment.APPLE_API_KEY_ID);
    expect(verifyIdentityContinuity).toHaveBeenCalledOnce();
    expect(executeFile).not.toHaveBeenCalled();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
  });

  it("atomically seals zip-only builder metadata with ZIP-first and DMG-second authority", async () => {
    const fixture = await metadataSealFixture();
    const expectedEnvelope = Object.values(fixture.plan.artifactNames).sort();
    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(expectedEnvelope);

    await sealMacosReleaseMetadata(fixture.plan);

    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(expectedEnvelope);
    expect(parse(await readFile(fixture.metadataPath, "utf8"))).toEqual({
      version: fixture.plan.version,
      files: [
        {
          url: fixture.plan.artifactNames.zip,
          sha512: fixture.zipSha512,
          size: fixture.zip.length,
        },
        {
          url: fixture.plan.artifactNames.dmg,
          sha512: fixture.dmgSha512,
          size: fixture.dmg.length,
        },
      ],
      path: fixture.plan.artifactNames.zip,
      sha512: fixture.zipSha512,
      releaseDate: "2026-07-24T00:00:00.000Z",
    });
  });

  it("hashes the final stapled DMG bytes only after outer notarization completes", async () => {
    const fixture = await metadataSealFixture();
    const stapledDmg = Buffer.concat([fixture.dmg, Buffer.from("synthetic stapled ticket\n")]);
    const notarize = vi.fn(async (options: { appPath: string }) => {
      await writeFile(options.appPath, stapledDmg);
    });
    const verifyIdentityContinuity = vi.fn(async () => verifiedLooseIdentity);
    const verifyReleaseApplicationContents = vi.fn(async () => {});
    const verifyDmg = vi.fn(async (path: string) => {
      expect(await readFile(path)).toEqual(stapledDmg);
    });
    const envelopePath = join(fixture.artifactDirectory, "synthetic-envelope");

    await runMacosRelease(
      {
        repositoryRoot: join(fixture.artifactDirectory, "repository"),
        desktopRoot: fixture.plan.builderOptions.projectDir,
        feedUrl,
        identity,
        baselineApplication,
      },
      {
        readFile: versionReader(),
        environment: notarizationEnvironment,
        build: vi.fn(async () => []),
        prepareKeychainBinding: keychainBindingPreparer(),
        verifyBaselineApplication: baselineVerifier(),
        verifyKeychainBinding: keychainBindingVerifier(),
        verifyElectronFuses: electronFusesVerifier(),
        verifyBackendSelection: backendSelectionVerifier(),
        verifyPackageLayout: vi.fn(async () => {}),
        verifyIdentityContinuity,
        verifyReleaseApplicationContents,
        notarize,
        verifyDmg,
        promoteReleaseEnvelope: vi.fn(
          async (
            _plan: MacosReleasePlan,
            verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
          ) => {
            await verifyEnvelope(envelopePath);
            return envelopePath;
          },
        ),
        verifyReleaseArtifacts: vi.fn(async (artifactDirectory: string) =>
          verifiedReleaseArtifactsAt(artifactDirectory),
        ),
      },
    );

    const metadata = parse(await readFile(fixture.metadataPath, "utf8")) as {
      files: Array<{ url: string; sha512: string; size: number }>;
    };
    expect(notarize).toHaveBeenCalledOnce();
    expect(verifyDmg).toHaveBeenCalledOnce();
    expect(notarize.mock.invocationCallOrder[0]).toBeLessThan(
      verifyDmg.mock.invocationCallOrder[0]!,
    );
    expect(metadata.files[1]).toEqual({
      url: fixture.plan.artifactNames.dmg,
      sha512: createHash("sha512").update(stapledDmg).digest("base64"),
      size: stapledDmg.length,
    });
    expect(metadata.files[1]?.sha512).not.toBe(fixture.dmgSha512);
  });

  it("keeps exact packaged-application inspection inside the envelope TOCTOU guard", async () => {
    const fixture = await metadataSealFixture();
    const verifyReleaseArtifacts = vi.fn(async (artifactDirectory: string) =>
      verifiedReleaseArtifactsAt(artifactDirectory),
    );
    const verifyReleaseApplicationContents = vi.fn(async (temporaryEnvelope: string) => {
      await writeFile(
        join(temporaryEnvelope, fixture.plan.artifactNames.zip),
        "mutated during packaged application inspection\n",
      );
    });

    await expect(
      runMacosRelease(
        {
          repositoryRoot: join(fixture.artifactDirectory, "repository"),
          desktopRoot: fixture.plan.builderOptions.projectDir,
          feedUrl,
          identity,
          baselineApplication,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build: vi.fn(async () => []),
          prepareKeychainBinding: keychainBindingPreparer(),
          verifyBaselineApplication: baselineVerifier(),
          verifyKeychainBinding: keychainBindingVerifier(),
          verifyElectronFuses: electronFusesVerifier(),
          verifyBackendSelection: backendSelectionVerifier(),
          verifyPackageLayout: vi.fn(async () => {}),
          verifyIdentityContinuity: vi.fn(async () => verifiedLooseIdentity),
          notarize: vi.fn(async () => {}),
          verifyDmg: vi.fn(async () => {}),
          verifyReleaseArtifacts,
          verifyReleaseApplicationContents,
        },
      ),
    ).rejects.toThrow("release envelope changed during verification");

    expect(verifyReleaseArtifacts).toHaveBeenCalledOnce();
    expect(verifyReleaseApplicationContents).toHaveBeenCalledOnce();
    expect(verifyReleaseArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      verifyReleaseApplicationContents.mock.invocationCallOrder[0]!,
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(fixture.artifactDirectory, fixture.plan.artifactNames.zip))).toEqual(
      fixture.zip,
    );
  });

  it("leaves builder metadata untouched when zip-only authority validation fails", async () => {
    const fixture = await metadataSealFixture();
    const original = await readFile(fixture.metadataPath);
    await writeFile(
      fixture.metadataPath,
      original.toString("utf8").replace(fixture.zipSha512, "stale"),
    );
    const invalid = await readFile(fixture.metadataPath);

    await expect(sealMacosReleaseMetadata(fixture.plan)).rejects.toThrow(
      "builder latest-mac.yml does not match the ZIP artifact",
    );
    expect(await readFile(fixture.metadataPath)).toEqual(invalid);
    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(
      Object.values(fixture.plan.artifactNames).sort(),
    );
  });

  it("atomically promotes only the four release artifacts while preserving builder output", async () => {
    const fixture = await metadataSealFixture();
    const builderApplication = join(fixture.artifactDirectory, "mac-arm64/Enduragent.app");
    const builderScratch = join(fixture.artifactDirectory, "builder-scratch");
    await Promise.all([
      mkdir(builderApplication, { recursive: true }),
      mkdir(builderScratch, { recursive: true }),
    ]);
    await sealMacosReleaseMetadata(fixture.plan);
    const sourceBytes = new Map(
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map(
          async (name) => [name, await readFile(join(fixture.artifactDirectory, name))] as const,
        ),
      ),
    );

    const verifyEnvelope = vi.fn(async (candidatePath: string) => {
      expect(candidatePath).toBe(macosReleaseEnvelopePath(fixture.plan));
      expect((await lstat(candidatePath)).isDirectory()).toBe(true);
      expect((await readdir(candidatePath)).sort()).toEqual(
        Object.values(fixture.plan.artifactNames).sort(),
      );
    });

    const envelopePath = await promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope);

    expect(envelopePath).toBe(macosReleaseEnvelopePath(fixture.plan));
    expect(verifyEnvelope).toHaveBeenCalledOnce();
    expect((await readdir(envelopePath)).sort()).toEqual(
      Object.values(fixture.plan.artifactNames).sort(),
    );
    for (const [name, bytes] of sourceBytes) {
      expect(await readFile(join(envelopePath, name))).toEqual(bytes);
      expect(await readFile(join(fixture.artifactDirectory, name))).toEqual(bytes);
    }
    expect((await lstat(builderApplication)).isDirectory()).toBe(true);
    expect((await lstat(builderScratch)).isDirectory()).toBe(true);
  });

  it("accepts verification-only timestamp changes when file identity and bytes are stable", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const sourceBytes = new Map(
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map(
          async (name) => [name, await readFile(join(fixture.artifactDirectory, name))] as const,
        ),
      ),
    );
    const verificationTimestamp = new Date("2000-01-01T00:00:00.000Z");

    const envelopePath = await promoteMacosReleaseEnvelope(fixture.plan, async (candidatePath) => {
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map((name) =>
          utimes(join(candidatePath, name), verificationTimestamp, verificationTimestamp),
        ),
      );
    });

    for (const [name, bytes] of sourceBytes) {
      expect(await readFile(join(envelopePath, name))).toEqual(bytes);
      expect(await readFile(join(fixture.artifactDirectory, name))).toEqual(bytes);
    }
  });

  it("never overwrites a stale release envelope", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const sentinelPath = join(envelopePath, "sentinel");
    await mkdir(envelopePath);
    await writeFile(sentinelPath, "keep me\n");

    const verifyEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope)).rejects.toThrow(
      "release envelope destination already exists",
    );
    expect(verifyEnvelope).not.toHaveBeenCalled();
    expect(await readFile(sentinelPath, "utf8")).toBe("keep me\n");
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it("cleans a semantically rejected temp envelope and permits a clean rerun", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const sourceBytes = new Map(
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map(
          async (name) => [name, await readFile(join(fixture.artifactDirectory, name))] as const,
        ),
      ),
    );
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const failure = new Error("semantic envelope rejection");
    const rejectEnvelope = vi.fn(async (candidatePath: string) => {
      expect(candidatePath).toBe(envelopePath);
      expect((await readdir(candidatePath)).sort()).toEqual(
        Object.values(fixture.plan.artifactNames).sort(),
      );
      throw failure;
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, rejectEnvelope)).rejects.toBe(failure);

    await expect(lstat(envelopePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
    for (const [name, bytes] of sourceBytes) {
      expect(await readFile(join(fixture.artifactDirectory, name))).toEqual(bytes);
    }

    const acceptEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, acceptEnvelope)).resolves.toBe(
      envelopePath,
    );
    expect(acceptEnvelope).toHaveBeenCalledOnce();
  });

  it("rejects a canonical artifact changed by semantic verification", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const mutateEnvelope = vi.fn(async (temporaryPath: string) => {
      await writeFile(
        join(temporaryPath, fixture.plan.artifactNames.zip),
        "mutated during semantic verification\n",
      );
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, mutateEnvelope)).rejects.toThrow(
      "release envelope changed during verification",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it("rejects an entry swap at the final rename seam and removes only the bound envelope", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const renameAtCommit = vi.fn(async (source: string, destination: string) => {
      await writeFile(
        join(source, fixture.plan.artifactNames.zip),
        "swapped at the final rename seam\n",
      );
      await rename(source, destination);
    });

    await expect(
      promoteMacosReleaseEnvelope(fixture.plan, async () => {}, { rename: renameAtCommit }),
    ).rejects.toThrow("release envelope changed during verification");

    expect(renameAtCommit).toHaveBeenCalledOnce();
    await expect(lstat(envelopePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a whole-directory swap at the final rename seam without deleting the substitute", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const displacedOriginal = join(fixture.artifactDirectory, ".displaced-original-envelope");
    const sentinelPath = join(envelopePath, "substitute-sentinel");
    const renameAtCommit = vi.fn(async (source: string, destination: string) => {
      await rename(source, displacedOriginal);
      await mkdir(source, { mode: 0o700 });
      await writeFile(join(source, "substitute-sentinel"), "preserve substitute\n");
      await rename(source, destination);
    });

    await expect(
      promoteMacosReleaseEnvelope(fixture.plan, async () => {}, { rename: renameAtCommit }),
    ).rejects.toThrow("release envelope cleanup target changed");

    expect(renameAtCommit).toHaveBeenCalledOnce();
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve substitute\n");
    expect((await lstat(displacedOriginal)).isDirectory()).toBe(true);
  });

  it("rechecks builder source identity after semantic verification", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const mutateSource = vi.fn(async () => {
      await writeFile(
        join(fixture.artifactDirectory, fixture.plan.artifactNames.zip),
        "builder source changed during verification\n",
      );
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, mutateSource)).rejects.toThrow(
      "release artifact changed during promotion",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires semantic verification before release-envelope promotion", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);

    await expect(promoteMacosReleaseEnvelope(fixture.plan, undefined as never)).rejects.toThrow(
      "release envelope verifier is required",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects symlinked source artifacts without leaving a partial envelope", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const blockmapPath = join(fixture.artifactDirectory, fixture.plan.artifactNames.blockmap);
    await rm(blockmapPath);
    await symlink(fixture.plan.artifactNames.zip, blockmapPath);

    const verifyEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope)).rejects.toThrow(
      "invalid ZIP blockmap",
    );
    expect(verifyEnvelope).not.toHaveBeenCalled();
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-1", "", "latest"])(
    "rejects a non-stable release version: %s",
    async (version) => {
      await expect(
        createMacosReleasePlan(
          {
            repositoryRoot: "/synthetic/repository",
            feedUrl,
            identity,
            baselineApplication,
          },
          { readFile: versionReader(version) },
        ),
      ).rejects.toThrow("stable SemVer");
    },
  );

  it.each([
    "http://updates.example.test/stable/",
    "https://user:secret@updates.example.test/stable/",
    "https://updates.example.test/stable",
    "https://updates.example.test/stable/?token=value",
    "https://updates.example.test/stable/#fragment",
    "/stable/",
    "",
  ])("rejects a noncanonical release feed URL: %s", async (invalidFeedUrl) => {
    await expect(
      createMacosReleasePlan(
        {
          repositoryRoot: "/synthetic/repository",
          feedUrl: invalidFeedUrl,
          identity,
          baselineApplication,
        },
        { readFile: versionReader() },
      ),
    ).rejects.toThrow("feed URL");
  });

  it("checks in only the minimum Electron hardened-runtime entitlement", async () => {
    const entitlements = await readFile(join(desktopRoot, "build/entitlements.mac.plist"), "utf8");
    expect(Array.from(entitlements.matchAll(/<key>([^<]+)<\/key>/gu), (match) => match[1])).toEqual(
      ["com.apple.security.cs.allow-jit"],
    );
    expect(entitlements.match(/<true\/>/gu)).toHaveLength(1);
    expect(entitlements).not.toMatch(
      /allow-unsigned-executable-memory|disable-library-validation|network\.server/iu,
    );
  });

  it("matches electron-builder's updater cache name for the scoped desktop package", () => {
    const localRequire = createRequire(import.meta.url);
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    const { sanitizeFileName } = builderRequire("builder-util/out/filename") as {
      sanitizeFileName(value: string): string;
    };
    expect(DESKTOP_UPDATER_CACHE_DIRECTORY).toBe(
      `${sanitizeFileName("@enduragent/desktop").toLowerCase()}-updater`,
    );
  });

  it("declares and resolves the exact pinned outer notarization dependency", async () => {
    const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const localRequire = createRequire(import.meta.url);
    const dependencyManifest = JSON.parse(
      await readFile(localRequire.resolve("@electron/notarize/package.json"), "utf8"),
    ) as { version: string };

    expect(manifest.devDependencies["@electron/notarize"]).toBe("2.5.0");
    expect(dependencyManifest.version).toBe("2.5.0");
  });

  it("reads the live desktop version authority without consulting the npm manifest", async () => {
    const plan = await createMacosReleasePlan({
      repositoryRoot,
      desktopRoot,
      feedUrl,
      identity,
      baselineApplication,
    });
    const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(plan.version).toBe(manifest.version);
    expect(plan.version).not.toBe("0.0.1");
  });
});
