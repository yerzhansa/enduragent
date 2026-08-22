import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createPackage, uncache } from "@electron/asar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  inspectMacosReleaseApplication,
  safeMacosReleaseVerificationMessage,
  verifyMacosApplication,
  verifyMacosBaselineApplication,
  verifyMacosIdentityContinuity,
  verifyMacosKeychainBinding,
  verifyMacosReleaseApplicationContents,
  verifyMacosReleaseArtifacts,
  verifyMacosReleaseEnvelope,
} from "../scripts/verify-macos-release.mjs";

const localRequire = createRequire(import.meta.url);
const builderRequire = createRequire(localRequire.resolve("electron-builder"));
const { buildBlockMap: installedBuildBlockMap } = builderRequire(
  "app-builder-lib/out/targets/blockmap/blockmap",
) as {
  buildBlockMap(inputPath: string, compression: "gzip", outputPath: string): Promise<unknown>;
};
const roots: string[] = [];
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.1.2";
const names = {
  dmg: `Enduragent-${version}-arm64.dmg`,
  zip: `Enduragent-${version}-arm64.zip`,
  blockmap: `Enduragent-${version}-arm64.zip.blockmap`,
  metadata: "latest-mac.yml",
};

function dmgSigningIdentityResult(
  teamIdentifier = "FA494ACVTF",
  authorityTeamIdentifier = teamIdentifier,
) {
  return {
    stdout: "",
    stderr: [
      `Authority=Developer ID Application: Enduragent Test (${authorityTeamIdentifier})`,
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      `TeamIdentifier=${teamIdentifier}`,
    ].join("\n"),
  };
}

const keychainBindingIdentifier = "keychain-binding.node-a1b2c3";
const machoBundleFileType = 0x8;
const keychainBindingDesignatedRequirement = [
  `identifier "${keychainBindingIdentifier}" and anchor apple generic and certificate`,
  "1[field.1.2.840.113635.100.6.2.6] exists and certificate",
  "leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = FA494ACVTF",
].join(" ");
const keychainBindingImageIdentity = Object.freeze({
  cpuType: 0x0100000c,
  cpuSubtype: 0,
  fileType: machoBundleFileType,
  uuid: "a1".repeat(16),
  contentSha256: "b2".repeat(32),
});

function keychainBindingIdentityResult(teamIdentifier = "FA494ACVTF", flags = "runtime") {
  return {
    stdout: "",
    stderr: [
      `Identifier=${keychainBindingIdentifier}`,
      `CodeDirectory v=20500 size=402 flags=0x10000(${flags}) hashes=6+2 location=embedded`,
      `Authority=Developer ID Application: Enduragent Test (${teamIdentifier})`,
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      `TeamIdentifier=${teamIdentifier}`,
    ].join("\n"),
  };
}

function keychainBindingRequirementResult(teamIdentifier = "FA494ACVTF") {
  return {
    stdout: `designated => ${keychainBindingDesignatedRequirement.replace("FA494ACVTF", teamIdentifier)}\n`,
    stderr: "",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("safe macOS release verification diagnostics", () => {
  it("reports only failures created by the release verifier", async () => {
    let verificationFailure: unknown;
    try {
      await verifyMacosReleaseArtifacts("relative-artifacts");
    } catch (error) {
      verificationFailure = error;
    }

    expect(safeMacosReleaseVerificationMessage(verificationFailure)).toBe(
      "artifact directory must be absolute",
    );
    expect(
      safeMacosReleaseVerificationMessage(new Error("must-not-reach-release-logs")),
    ).toBeUndefined();
  });
});

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-macos-release-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const artifactDirectory = join(root, "artifacts");
  await Promise.all([
    mkdir(join(repositoryRoot, "apps/desktop"), { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(repositoryRoot, "apps/desktop/package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  const zip = Buffer.from("synthetic signed ZIP bytes\n");
  const dmg = Buffer.from("synthetic signed DMG bytes\n");
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const zipPath = join(artifactDirectory, names.zip);
  const blockmapPath = join(artifactDirectory, names.blockmap);
  await Promise.all([writeFile(join(artifactDirectory, names.dmg), dmg), writeFile(zipPath, zip)]);
  await installedBuildBlockMap(zipPath, "gzip", blockmapPath);
  await writeFile(
    join(artifactDirectory, names.metadata),
    [
      `version: ${version}`,
      "files:",
      `  - url: ${names.zip}`,
      `    sha512: ${zipSha512}`,
      `    size: ${zip.length}`,
      `  - url: ${names.dmg}`,
      `    sha512: ${dmgSha512}`,
      `    size: ${dmg.length}`,
      `path: ${names.zip}`,
      `sha512: ${zipSha512}`,
      "releaseDate: '2026-07-24T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
  return {
    root,
    artifactDirectory,
    repositoryRoot,
    zip,
    dmg,
    zipSha512,
    dmgSha512,
    blockmap: await readFile(blockmapPath),
  };
}

function deterministicTemporaryDirectory(root: string) {
  const directory = join(root, "enduragent-blockmap-test");
  return {
    directory,
    tmpdir: vi.fn(() => root),
    mkdtemp: vi.fn(async (prefix: string) => {
      expect(prefix).toBe(join(root, "enduragent-blockmap-"));
      await mkdir(directory);
      return directory;
    }),
  };
}

interface SignedApplicationMetadata {
  version: string;
  teamIdentifier: string;
  identifier: string;
  requirement: string;
  flags: string;
  info: Record<string, unknown>;
  manifest: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  extraAuthorities: string[];
  codeDirectory: string;
  candidateCDHashFullLines: string[];
  cdHash: string;
}

const canonicalDesignatedRequirement =
  'identifier "icu.enduragent.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = FA494ACVTF';
const syntheticPackageManifestBytes = 8_192;

function signedApplicationMetadata(version: string, cdHash: string): SignedApplicationMetadata {
  const codeDirectorySha256 = `${cdHash}${cdHash.slice(0, 24)}`;
  return {
    version,
    teamIdentifier: "FA494ACVTF",
    identifier: "icu.enduragent.desktop",
    requirement: canonicalDesignatedRequirement,
    flags: "runtime",
    codeDirectory: "v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded",
    candidateCDHashFullLines: [`CandidateCDHashFull sha256=${codeDirectorySha256}`],
    cdHash,
    info: {
      CFBundleIdentifier: "icu.enduragent.desktop",
      CFBundleName: "Enduragent",
      CFBundleDisplayName: "Enduragent",
      CFBundleExecutable: "Enduragent",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    },
    manifest: {
      name: "@enduragent/desktop",
      version,
      enduragentDesktopRelease: true,
    },
    entitlements: { "com.apple.security.cs.allow-jit": true },
    extraAuthorities: [],
  };
}

async function signedIdentityFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-signed-identity-"));
  roots.push(root);
  const baseline = join(root, "baseline/Enduragent.app");
  const candidate = join(root, "candidate/Enduragent.app");
  for (const [index, application] of [baseline, candidate].entries()) {
    await mkdir(join(application, "Contents/Resources"), { recursive: true });
    const archiveSource = join(root, `archive-source-${index}`);
    await mkdir(archiveSource);
    await Promise.all([
      writeFile(join(application, "Contents/Info.plist"), "synthetic plist authority\n"),
      writeFile(
        join(archiveSource, "package.json"),
        "{}".padEnd(syntheticPackageManifestBytes, " "),
      ),
      writeFile(
        join(application, "Contents/Resources/app-update.yml"),
        [
          "provider: generic",
          "url: https://github.com/yerzhansa/enduragent/releases/latest/download/",
          "channel: latest",
          "updaterCacheDirName: '@enduragentdesktop-updater'",
          "",
        ].join("\n"),
      ),
    ]);
    const archive = await createPackage(
      archiveSource,
      join(application, "Contents/Resources/app.asar"),
    );
    await finished(archive);
  }
  const metadata = new Map<string, SignedApplicationMetadata>([
    [baseline, signedApplicationMetadata("0.1.1", "a".repeat(40))],
    [candidate, signedApplicationMetadata("0.1.2", "b".repeat(40))],
  ]);
  const applicationForPath = (path: string) =>
    [...metadata.keys()].find(
      (application) => path === application || path.startsWith(`${application}/`),
    );
  const temporaryEntitlements = new Map<string, Record<string, unknown>>();
  const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
    const finalArgument = arguments_.at(-1);
    if (typeof finalArgument !== "string") throw new Error("synthetic command shape rejected");
    if (executable === "/usr/bin/ditto") {
      const source = arguments_.at(-2);
      if (
        typeof source !== "string" ||
        arguments_.slice(0, -2).join(" ") !== "--rsrc --extattr --qtn --acl" ||
        metadata.has(source) === false ||
        metadata.has(finalArgument)
      ) {
        throw new Error("synthetic application snapshot shape rejected");
      }
      await cp(source, finalArgument, { recursive: true });
      metadata.set(finalArgument, structuredClone(metadata.get(source)!));
      return { stdout: "", stderr: "" };
    }
    if (executable === "/usr/bin/xcrun" || executable === "/usr/sbin/spctl") {
      return { stdout: "", stderr: "" };
    }
    if (executable === "/usr/bin/codesign" && arguments_.includes("--verify")) {
      return { stdout: "", stderr: "" };
    }
    const application = applicationForPath(finalArgument);
    if (executable === "/usr/bin/codesign" && application !== undefined) {
      const selected = metadata.get(application)!;
      if (arguments_.includes("--verbose=4")) {
        return {
          stdout: "",
          stderr: [
            `Executable=${application}/Contents/MacOS/Enduragent`,
            `Identifier=${selected.identifier}`,
            `CodeDirectory ${selected.codeDirectory.replace(`(${selected.codeDirectory.includes("runtime") ? "runtime" : "none"})`, `(${selected.flags})`)}`,
            ...selected.candidateCDHashFullLines,
            `CDHash=${selected.cdHash}`,
            `Authority=Developer ID Application: Enduragent Test (${selected.teamIdentifier})`,
            "Authority=Developer ID Certification Authority",
            "Authority=Apple Root CA",
            ...selected.extraAuthorities.map((authority) => `Authority=${authority}`),
            `TeamIdentifier=${selected.teamIdentifier}`,
          ].join("\n"),
        };
      }
      if (arguments_.includes("--requirements")) {
        return {
          stdout: "",
          stderr: `Executable=${application}/Contents/MacOS/Enduragent\ndesignated => ${selected.requirement}\n`,
        };
      }
      if (arguments_.includes("--entitlements")) {
        const entitlementPath = arguments_[arguments_.indexOf("--entitlements") + 1];
        if (
          typeof entitlementPath !== "string" ||
          entitlementPath === "-" ||
          !arguments_.includes("--der")
        ) {
          throw new Error("synthetic entitlement extraction shape rejected");
        }
        temporaryEntitlements.set(entitlementPath, selected.entitlements);
        await writeFile(entitlementPath, Buffer.from([0x70, 0x2b, 0x02, 0x01, 0x01]));
        return {
          stdout: "",
          stderr: `Executable=${application}/Contents/MacOS/Enduragent\n`,
        };
      }
    }
    if (executable === "/usr/bin/derq") {
      const inputPath = arguments_[arguments_.indexOf("-i") + 1];
      const outputPath = arguments_[arguments_.indexOf("-o") + 1];
      if (
        arguments_.join(" ").startsWith("query --xml ") === false ||
        typeof inputPath !== "string" ||
        typeof outputPath !== "string"
      ) {
        throw new Error("synthetic DER query shape rejected");
      }
      const entitlements = temporaryEntitlements.get(inputPath);
      if (entitlements === undefined) throw new Error("synthetic DER authority rejected");
      temporaryEntitlements.set(outputPath, entitlements);
      await writeFile(outputPath, '<?xml version="1.0"?><plist><dict/></plist>');
      return { stdout: "", stderr: "" };
    }
    if (executable === "/usr/bin/plutil" && finalArgument.endsWith("Info.plist")) {
      const selectedApplication = applicationForPath(finalArgument);
      if (selectedApplication === undefined) throw new Error("synthetic plist path rejected");
      return { stdout: JSON.stringify(metadata.get(selectedApplication)!.info), stderr: "" };
    }
    if (executable === "/usr/bin/plutil" && finalArgument.endsWith("entitlements.plist")) {
      const entitlements = temporaryEntitlements.get(finalArgument);
      if (entitlements === undefined) throw new Error("synthetic plist authority rejected");
      return { stdout: JSON.stringify(entitlements), stderr: "" };
    }
    throw new Error("synthetic command rejected");
  });
  const extractAsarFile = vi.fn(async (archivePath: string) => {
    const application = applicationForPath(archivePath);
    if (application === undefined) throw new Error("synthetic ASAR path rejected");
    const serialized = Buffer.from(JSON.stringify(metadata.get(application)!.manifest));
    if (serialized.length > syntheticPackageManifestBytes) {
      throw new Error("synthetic manifest exceeds fixed ASAR entry");
    }
    return Buffer.concat([
      serialized,
      Buffer.alloc(syntheticPackageManifestBytes - serialized.length, 0x20),
    ]);
  });
  return { baseline, candidate, executeFile, extractAsarFile, metadata };
}

describe.skipIf(process.platform === "win32")("macOS signed identity continuity", () => {
  it("inspects one marked release application through the canonical native identity pipeline", async () => {
    const fixture = await signedIdentityFixture();
    const uncacheAsar = vi.fn(uncache);

    const inspected = await inspectMacosReleaseApplication(fixture.candidate, {
      executeFile: fixture.executeFile,
      extractAsarFile: fixture.extractAsarFile,
      uncacheAsar,
    });

    expect(inspected).toEqual({
      version,
      enduragentDesktopRelease: true,
      feedUrl: "https://github.com/yerzhansa/enduragent/releases/latest/download/",
      bundleIdentifier: "icu.enduragent.desktop",
      teamIdentifier: "FA494ACVTF",
      designatedRequirementSha256: createHash("sha256")
        .update(canonicalDesignatedRequirement)
        .digest("hex"),
      codeDirectorySha256: "b".repeat(64),
      cdHash: "b".repeat(40),
    });
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(uncacheAsar.mock.results.map(({ value }) => value)).toEqual([false, true]);
  });

  it.each(["missing", "false", "nested"])("rejects a %s packaged release marker", async (shape) => {
    const fixture = await signedIdentityFixture();
    const manifest = fixture.metadata.get(fixture.candidate)!.manifest;
    if (shape === "missing") delete manifest.enduragentDesktopRelease;
    else if (shape === "false") manifest.enduragentDesktopRelease = false;
    else {
      delete manifest.enduragentDesktopRelease;
      manifest.build = { enduragentDesktopRelease: true };
    }

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ).rejects.toThrow("macOS release marker is invalid");
  });

  it("rejects a noncanonical signer before inspecting the packaged manifest", async () => {
    const fixture = await signedIdentityFixture();
    fixture.metadata.get(fixture.candidate)!.teamIdentifier = "ZZZZZ99999";
    const statAsarFile = vi.fn((_archivePath: string, _filename: string, _followLinks: false) => ({
      size: syntheticPackageManifestBytes,
    }));
    const uncacheAsar = vi.fn(() => false);

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
        statAsarFile,
        uncacheAsar,
      }),
    ).rejects.toThrow("macOS signed identity is invalid");
    expect(statAsarFile).not.toHaveBeenCalled();
    expect(fixture.extractAsarFile).not.toHaveBeenCalled();
    expect(uncacheAsar).not.toHaveBeenCalled();
  });

  it("rejects oversized packaged manifest metadata before extracting bytes", async () => {
    const fixture = await signedIdentityFixture();
    const statAsarFile = vi.fn((_archivePath: string, _filename: string, _followLinks: false) => ({
      size: 16_385,
    }));
    const uncacheAsar = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
        statAsarFile,
        uncacheAsar,
      }),
    ).rejects.toThrow("macOS package identity is invalid");
    expect(statAsarFile).toHaveBeenCalledOnce();
    expect(fixture.extractAsarFile).not.toHaveBeenCalled();
    expect(uncacheAsar).toHaveBeenCalledTimes(2);
  });

  it("rejects inspection when packaged manifest cache eviction cannot be confirmed", async () => {
    const fixture = await signedIdentityFixture();
    const statAsarFile = vi.fn((_archivePath: string, _filename: string, _followLinks: false) => ({
      size: syntheticPackageManifestBytes,
    }));
    const uncacheAsar = vi.fn(() => false);

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
        statAsarFile,
        uncacheAsar,
      }),
    ).rejects.toThrow("macOS package identity cache cleanup failed");
    expect(fixture.extractAsarFile).toHaveBeenCalledOnce();
    expect(uncacheAsar).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "provider",
      "provider: github\nurl: https://github.com/yerzhansa/enduragent/releases/latest/download/\nchannel: latest\nupdaterCacheDirName: '@enduragentdesktop-updater'\n",
    ],
    [
      "channel",
      "provider: generic\nurl: https://github.com/yerzhansa/enduragent/releases/latest/download/\nchannel: beta\nupdaterCacheDirName: '@enduragentdesktop-updater'\n",
    ],
    [
      "cache directory",
      "provider: generic\nurl: https://github.com/yerzhansa/enduragent/releases/latest/download/\nchannel: latest\nupdaterCacheDirName: alternate\n",
    ],
    [
      "HTTPS feed",
      "provider: generic\nurl: http://github.com/yerzhansa/enduragent/releases/latest/download/\nchannel: latest\nupdaterCacheDirName: '@enduragentdesktop-updater'\n",
    ],
    [
      "exact keys",
      "provider: generic\nurl: https://github.com/yerzhansa/enduragent/releases/latest/download/\nchannel: latest\nupdaterCacheDirName: '@enduragentdesktop-updater'\nextra: forbidden\n",
    ],
  ])("rejects updater metadata with invalid %s", async (_label, contents) => {
    const fixture = await signedIdentityFixture();
    await writeFile(join(fixture.candidate, "Contents/Resources/app-update.yml"), contents);

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ).rejects.toThrow("macOS release updater metadata is invalid");
  });

  it.each(["missing", "directory", "symlink", "malformed"])(
    "rejects %s updater metadata",
    async (shape) => {
      const fixture = await signedIdentityFixture();
      const updaterPath = join(fixture.candidate, "Contents/Resources/app-update.yml");
      await rm(updaterPath);
      if (shape === "directory") await mkdir(updaterPath);
      if (shape === "symlink") await symlink("app.asar", updaterPath);
      if (shape === "malformed") await writeFile(updaterPath, "[unterminated\n");

      await expect(
        inspectMacosReleaseApplication(fixture.candidate, {
          executeFile: fixture.executeFile,
          extractAsarFile: fixture.extractAsarFile,
        }),
      ).rejects.toThrow("macOS release updater metadata is invalid");
    },
  );

  it("rejects updater metadata that changes while it is read", async () => {
    const fixture = await signedIdentityFixture();
    let updaterInspectionCount = 0;

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
        lstat: async (path) => {
          const stat = await lstat(path);
          if (
            !path.endsWith("/Contents/Resources/app-update.yml") ||
            ++updaterInspectionCount === 1
          ) {
            return stat;
          }
          return new Proxy(stat, {
            get(target, property) {
              if (property === "mtimeMs") return target.mtimeMs + 1;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      }),
    ).rejects.toThrow("macOS release updater metadata is invalid");
  });

  it("rejects oversized updater metadata without reading it", async () => {
    const fixture = await signedIdentityFixture();
    await writeFile(
      join(fixture.candidate, "Contents/Resources/app-update.yml"),
      "x".repeat(16_385),
    );
    const readUpdater = vi.fn((path: string) => readFile(path));

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
        readFile: readUpdater,
      }),
    ).rejects.toThrow("macOS release updater metadata is invalid");
    expect(readUpdater).not.toHaveBeenCalled();
  });

  it("derives marker and updater evidence only from the verified snapshot", async () => {
    const fixture = await signedIdentityFixture();
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      const result = await fixture.executeFile(executable, arguments_);
      if (executable === "/usr/bin/ditto") {
        fixture.metadata.get(fixture.candidate)!.manifest.enduragentDesktopRelease = false;
        await writeFile(
          join(fixture.candidate, "Contents/Resources/app-update.yml"),
          "provider: github\nurl: http://invalid.example/\n",
        );
      }
      return result;
    });

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ).resolves.toMatchObject({
      enduragentDesktopRelease: true,
      feedUrl: "https://github.com/yerzhansa/enduragent/releases/latest/download/",
    });
    expect(executeFile).toHaveBeenCalledWith(
      "/usr/bin/ditto",
      expect.arrayContaining([fixture.candidate]),
    );
  });

  it("does not read updater metadata before the snapshot signature verifies", async () => {
    const fixture = await signedIdentityFixture();
    const readUpdater = vi.fn((path: string) => readFile(path));
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      const application = arguments_.at(-1);
      if (
        executable === "/usr/bin/codesign" &&
        arguments_.includes("--verify") &&
        typeof application === "string" &&
        application.includes("/enduragent-release-inspector-")
      ) {
        throw new Error("synthetic snapshot signature failure");
      }
      return fixture.executeFile(executable, arguments_);
    });

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile,
        extractAsarFile: fixture.extractAsarFile,
        readFile: readUpdater,
      }),
    ).rejects.toThrow("macOS application signature verification failed");
    expect(readUpdater).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", []],
    [
      "duplicate",
      [
        `CandidateCDHashFull sha256=${"b".repeat(64)}`,
        `CandidateCDHashFull sha256=${"b".repeat(64)}`,
      ],
    ],
    ["malformed", ["CandidateCDHashFull sha256=not-a-digest"]],
    ["CDHash prefix mismatch", [`CandidateCDHashFull sha256=${"c".repeat(64)}`]],
  ])("rejects an %s full CodeDirectory digest", async (_label, lines) => {
    const fixture = await signedIdentityFixture();
    fixture.metadata.get(fixture.candidate)!.candidateCDHashFullLines = lines;

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ).rejects.toThrow("macOS signed identity is invalid");
  });

  it("normalizes the full CodeDirectory digest and CDHash to lowercase", async () => {
    const fixture = await signedIdentityFixture();
    const metadata = fixture.metadata.get(fixture.candidate)!;
    metadata.candidateCDHashFullLines = [`CandidateCDHashFull sha256=${"B".repeat(64)}`];
    metadata.cdHash = "B".repeat(40);

    await expect(
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ).resolves.toMatchObject({
      codeDirectorySha256: "b".repeat(64),
      cdHash: "b".repeat(40),
    });
  });

  it.each([undefined, "Enduragent.app", "/tmp/Enduragent"])(
    "rejects a non-absolute or non-app inspector input before native inspection: %s",
    async (application) => {
      const fixture = await signedIdentityFixture();

      await expect(
        inspectMacosReleaseApplication(application as never, {
          executeFile: fixture.executeFile,
          extractAsarFile: fixture.extractAsarFile,
        }),
      ).rejects.toThrow("release application path must be one absolute .app path");
      expect(fixture.executeFile).not.toHaveBeenCalled();
    },
  );

  it("preflights the complete signed baseline before a candidate exists", async () => {
    const fixture = await signedIdentityFixture();

    await expect(
      verifyMacosBaselineApplication(
        fixture.baseline,
        { candidateVersion: version },
        {
          executeFile: fixture.executeFile,
          extractAsarFile: fixture.extractAsarFile,
        },
      ),
    ).resolves.toEqual({
      baselineVersion: "0.1.1",
      teamIdentifier: "FA494ACVTF",
    });
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      fixture.baseline,
    ]);
    expect(fixture.extractAsarFile).toHaveBeenCalledOnce();
    expect(fixture.extractAsarFile).toHaveBeenCalledWith(
      join(fixture.baseline, "Contents/Resources/app.asar"),
      "package.json",
    );
  });

  it("accepts only an older baseline with the same canonical signed identity", async () => {
    const fixture = await signedIdentityFixture();

    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        {
          executeFile: fixture.executeFile,
          extractAsarFile: fixture.extractAsarFile,
        },
      ),
    ).resolves.toEqual({
      baselineVersion: "0.1.1",
      candidateVersion: version,
      teamIdentifier: "FA494ACVTF",
      candidateCodeIdentity: {
        codeDirectory: "v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded",
        codeDirectorySha256: "b".repeat(64),
        cdHash: "b".repeat(40),
      },
    });

    for (const application of [fixture.baseline, fixture.candidate]) {
      expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        application,
      ]);
      expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/xcrun", [
        "stapler",
        "validate",
        "-v",
        application,
      ]);
      expect(fixture.executeFile).toHaveBeenCalledWith("/usr/sbin/spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=4",
        application,
      ]);
      expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/codesign", [
        "--display",
        "--verbose=4",
        application,
      ]);
      expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/codesign", [
        "--display",
        "--requirements",
        "-",
        application,
      ]);
    }
    const entitlementExtractions = fixture.executeFile.mock.calls.filter(
      ([executable, arguments_]) =>
        executable === "/usr/bin/codesign" && arguments_.includes("--entitlements"),
    );
    expect(entitlementExtractions).toHaveLength(2);
    for (const [, arguments_] of entitlementExtractions) {
      expect(arguments_).toEqual([
        "--display",
        "--entitlements",
        expect.stringMatching(/\/entitlements\.der$/u),
        "--der",
        expect.stringMatching(/\/Enduragent\.app$/u),
      ]);
    }
    const entitlementConversions = fixture.executeFile.mock.calls.filter(
      ([executable]) => executable === "/usr/bin/derq",
    );
    expect(entitlementConversions).toHaveLength(2);
    for (const [, arguments_] of entitlementConversions) {
      expect(arguments_).toEqual([
        "query",
        "--xml",
        "-i",
        expect.stringMatching(/\/entitlements\.der$/u),
        "-o",
        expect.stringMatching(/\/entitlements\.plist$/u),
      ]);
    }
    expect(fixture.extractAsarFile).toHaveBeenCalledTimes(2);
  });

  it("normalizes canonical codesign comments and quoted or unquoted Team Identifiers", async () => {
    const fixture = await signedIdentityFixture();
    fixture.metadata.get(fixture.baseline)!.requirement =
      'identifier "icu.enduragent.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "FA494ACVTF"';

    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).resolves.toMatchObject({ teamIdentifier: "FA494ACVTF" });

    const [commented, canonical] = await Promise.all([
      inspectMacosReleaseApplication(fixture.baseline, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
      inspectMacosReleaseApplication(fixture.candidate, {
        executeFile: fixture.executeFile,
        extractAsarFile: fixture.extractAsarFile,
      }),
    ]);
    expect(commented.designatedRequirementSha256).toBe(canonical.designatedRequirementSha256);
    expect(canonical.designatedRequirementSha256).toBe(
      createHash("sha256").update(canonicalDesignatedRequirement).digest("hex"),
    );
  });

  it.each([
    canonicalDesignatedRequirement.replace(" and anchor", " or anchor"),
    `${canonicalDesignatedRequirement} and true`,
    canonicalDesignatedRequirement.replace("anchor apple generic", "anchor apple"),
    canonicalDesignatedRequirement.replace(
      "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
      'certificate 1[subject.CN] = "Developer ID Certification Authority"',
    ),
    canonicalDesignatedRequirement.replace(
      "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
      "certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ exists",
    ),
    canonicalDesignatedRequirement.replace(
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
      "/* exists */ certificate leaf[field.1.2.840.113635.100.6.1.13]",
    ),
  ])("rejects a permissive or alternate designated requirement: %s", async (requirement) => {
    const fixture = await signedIdentityFixture();
    fixture.metadata.get(fixture.candidate)!.requirement = requirement;

    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow("macOS designated requirement is invalid");
  });

  it.each([
    "XFA494ACVTF",
    "FA494ACVTFX",
    "FA494ACVTE",
    '"XFA494ACVTF"',
    '"FA494ACVTFX"',
    '"FA494ACVTE"',
  ])("rejects a near-match Team Identifier in the designated requirement: %s", async (team) => {
    const fixture = await signedIdentityFixture();
    fixture.metadata.get(fixture.candidate)!.requirement = canonicalDesignatedRequirement.replace(
      "FA494ACVTF",
      team,
    );

    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow("macOS designated requirement is invalid");
  });

  it.each([undefined, "", "Enduragent.app", " relative/Enduragent.app"])(
    "rejects a missing or non-absolute baseline before native inspection: %s",
    async (baseline) => {
      const fixture = await signedIdentityFixture();
      await expect(
        verifyMacosIdentityContinuity(
          baseline as never,
          fixture.candidate,
          { candidateVersion: version },
          { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
        ),
      ).rejects.toThrow("baseline application path must be absolute");
      expect(fixture.executeFile).not.toHaveBeenCalled();
    },
  );

  it("rejects the candidate itself as its own baseline", async () => {
    const fixture = await signedIdentityFixture();
    await expect(
      verifyMacosIdentityContinuity(
        fixture.candidate,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow("baseline application must differ from candidate");
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it("rejects a candidate alias reached through a symlinked parent", async () => {
    const fixture = await signedIdentityFixture();
    const aliasParent = join(fixture.candidate, "../..", "candidate-alias");
    await symlink(join(fixture.candidate, ".."), aliasParent, "dir");
    const aliasedCandidate = join(aliasParent, "Enduragent.app");
    await expect(
      verifyMacosIdentityContinuity(
        aliasedCandidate,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow("baseline application must differ from candidate");
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it.each(["0.1.2", "0.1.3"])(
    "rejects a baseline that is not older than the candidate: %s",
    async (baselineVersion) => {
      const fixture = await signedIdentityFixture();
      const baseline = fixture.metadata.get(fixture.baseline)!;
      baseline.version = baselineVersion;
      baseline.info.CFBundleShortVersionString = baselineVersion;
      baseline.info.CFBundleVersion = baselineVersion;
      baseline.manifest.version = baselineVersion;
      await expect(
        verifyMacosIdentityContinuity(
          fixture.baseline,
          fixture.candidate,
          { candidateVersion: version },
          { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
        ),
      ).rejects.toThrow("baseline application is not older than candidate");
    },
  );

  it("rejects a mutually matching but noncanonical Team Identifier", async () => {
    const fixture = await signedIdentityFixture();
    for (const application of [fixture.baseline, fixture.candidate]) {
      const metadata = fixture.metadata.get(application)!;
      metadata.teamIdentifier = "ABCDE12345";
      metadata.requirement =
        'identifier "icu.enduragent.desktop" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"';
    }
    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow("macOS signed identity is invalid");
  });

  it.each([
    {
      label: "Team Identifier",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.teamIdentifier = "ZZZZZ99999";
      },
      error: "macOS signed identity is invalid",
    },
    {
      label: "designated requirement",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.requirement =
          'identifier "icu.enduragent.desktop" and anchor apple generic and certificate leaf[subject.OU] = "FA494ACVTF" and certificate leaf[subject.CN] = "Unexpected"';
      },
      error: "macOS designated requirement is invalid",
    },
    {
      label: "hardened runtime",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.flags = "none";
      },
      error: "macOS signed identity is invalid",
    },
    {
      label: "certificate chain",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.extraAuthorities.push("Unexpected Extra Authority");
      },
      error: "macOS signed identity is invalid",
    },
    {
      label: "bundle identifier",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.info.CFBundleIdentifier = "icu.example.desktop";
      },
      error: "macOS product identity is invalid",
    },
    {
      label: "product name",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.info.CFBundleDisplayName = "Example";
      },
      error: "macOS product identity is invalid",
    },
    {
      label: "package name",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.manifest.name = "@example/desktop";
      },
      error: "macOS package identity is invalid",
    },
    {
      label: "signed entitlements",
      mutate(metadata: SignedApplicationMetadata) {
        metadata.entitlements["com.apple.security.network.server"] = true;
      },
      error: "macOS signed entitlements are invalid",
    },
  ])("rejects candidate $label drift", async ({ mutate, error }) => {
    const fixture = await signedIdentityFixture();
    mutate(fixture.metadata.get(fixture.candidate)!);
    await expect(
      verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      ),
    ).rejects.toThrow(error);
  });

  it("redacts native inspection failures and never returns command output or paths", async () => {
    const fixture = await signedIdentityFixture();
    const sentinel = `${fixture.baseline}: Developer ID Application private output`;
    fixture.executeFile.mockRejectedValueOnce(new Error(sentinel));

    let failure: unknown;
    try {
      await verifyMacosIdentityContinuity(
        fixture.baseline,
        fixture.candidate,
        { candidateVersion: version },
        { executeFile: fixture.executeFile, extractAsarFile: fixture.extractAsarFile },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("macOS application signature verification failed");
    expect((failure as Error).message).not.toContain(sentinel);
    expect((failure as Error).message).not.toContain(fixture.baseline);
  });
});

type PackagedRootShape =
  | "invalid-presentation"
  | "missing"
  | "multiple"
  | "presentation"
  | "symlink"
  | "unrelated"
  | "valid";
interface PackagedCodeIdentity {
  readonly codeDirectory: string;
  readonly codeDirectorySha256: string;
  readonly cdHash: string;
}

const looseCandidateCodeIdentity: PackagedCodeIdentity = Object.freeze({
  codeDirectory: "v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded",
  codeDirectorySha256: "b".repeat(64),
  cdHash: "b".repeat(40),
});

async function packagedApplicationFixture(
  options: {
    zipShape?: PackagedRootShape;
    dmgShape?: PackagedRootShape;
    zipCodeIdentity?: PackagedCodeIdentity;
    dmgCodeIdentity?: PackagedCodeIdentity;
    mountMetadata?: unknown;
    privateVarMountMetadata?: boolean;
    identityFailure?: "zip" | "dmg";
    realpathEscape?: "zip" | "dmg";
    attachFailureAfterMount?: boolean;
    discoveryFailure?: boolean;
    detachFailure?: boolean;
    detachLeavesMounted?: boolean;
    beforeDetachImageSwap?: boolean;
    beforeDetachDeviceSwap?: boolean;
    postDetachImageRemains?: boolean;
    postDetachMountOccupied?: boolean;
    postDetachDeviceRemains?: boolean;
    nonHdiutilReplacementMount?: boolean;
    mountReappearsAfterRmdir?: boolean;
    mountPointRemovedByPeer?: boolean;
    preexistingImage?: boolean;
    preAttachExactCollision?: boolean;
    reusePreexistingDevice?: boolean;
    cleanupFailure?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "desktop-packaged-applications-"));
  roots.push(root);
  const artifactDirectory = join(root, "envelope");
  const dmgArtifact = join(artifactDirectory, names.dmg);
  const baseline = join(root, "baseline/Enduragent.app");
  const symlinkTarget = join(root, "symlink-target/Enduragent.app");
  const replacementImage = join(root, "replacement.dmg");
  const preexistingImage = join(root, "preexisting.dmg");
  const preexistingMount = join(root, "preexisting-mount");
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(baseline, { recursive: true }),
    mkdir(preexistingMount, { recursive: true }),
    mkdir(symlinkTarget, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(artifactDirectory, names.zip), "synthetic ZIP authority\n"),
    writeFile(join(artifactDirectory, names.dmg), "synthetic DMG authority\n"),
    writeFile(replacementImage, "synthetic replacement image\n"),
    writeFile(preexistingImage, "synthetic preexisting image\n"),
  ]);
  const canonicalDmgArtifact = await realpath(dmgArtifact);
  let mountPoint = "";
  const temporaryDirectories: string[] = [];
  const mkdtempTracked = vi.fn(async (prefix: string) => {
    const path = await mkdtemp(prefix);
    temporaryDirectories.push(path);
    mountPoint = join(path, "dmg");
    return path;
  });
  const populate = async (directory: string, shape: PackagedRootShape) => {
    if (shape === "missing") return;
    const application = join(directory, "Enduragent.app");
    if (shape === "symlink") {
      await symlink(symlinkTarget, application, "dir");
      return;
    }
    await mkdir(application);
    if (shape === "multiple") await mkdir(join(directory, "Other.app"));
    if (shape === "unrelated") await writeFile(join(directory, "unexpected.txt"), "unexpected\n");
    if (shape === "presentation") {
      await Promise.all([
        symlink("/Applications", join(directory, "Applications"), "dir"),
        writeFile(join(directory, ".background.tiff"), "synthetic background\n"),
        writeFile(join(directory, ".DS_Store"), "synthetic presentation metadata\n"),
        writeFile(join(directory, ".VolumeIcon.icns"), "synthetic icon\n"),
      ]);
    }
    if (shape === "invalid-presentation") {
      await mkdir(join(directory, ".background.tiff"));
    }
  };
  let attached = false;
  let attachedImage = "";
  let infoRequestCount = 0;
  let afterAttachStateServed = false;
  let beforeDetachStateServed = false;
  const pendingPlistConversions: unknown[] = [];
  const convertedPlists: unknown[] = [];
  const systemEntities = (device = "/dev/disk42s1", reportedMountPoint = mountPoint) => [
    { "dev-entry": device.replace(/s[1-9]\d*$/u, "") },
    {
      "dev-entry": device,
      "mount-point": options.privateVarMountMetadata
        ? reportedMountPoint.replace(/^\/var\//u, "/private/var/")
        : reportedMountPoint,
    },
  ];
  const defaultMountMetadata = () => ({ "system-entities": systemEntities() });
  const preexistingImageRecord = () => ({
    "image-path": preexistingImage,
    "system-entities": [
      { "dev-entry": options.reusePreexistingDevice ? "/dev/disk42" : "/dev/disk90" },
      {
        "dev-entry": options.reusePreexistingDevice ? "/dev/disk42s9" : "/dev/disk90s1",
        "mount-point": preexistingMount,
      },
    ],
  });
  const retainedImages = () => [
    ...(options.preexistingImage || options.reusePreexistingDevice
      ? [preexistingImageRecord()]
      : []),
    ...(options.preAttachExactCollision
      ? [{ "image-path": canonicalDmgArtifact, "system-entities": systemEntities() }]
      : []),
  ];
  const infoMetadata = (imagePath = attachedImage, device = "/dev/disk42s1") => ({
    images: [
      ...retainedImages(),
      { "image-path": imagePath, "system-entities": systemEntities(device) },
    ],
  });
  const emptyInfoMetadata = () => ({ images: retainedImages() });
  const preDetachMetadata = () => {
    if (options.beforeDetachImageSwap) return infoMetadata(replacementImage);
    if (options.beforeDetachDeviceSwap) return infoMetadata(attachedImage, "/dev/disk43s1");
    return infoMetadata();
  };
  const postDetachMetadata = () => {
    if (options.postDetachImageRemains) {
      return {
        images: [
          ...retainedImages(),
          {
            "image-path": attachedImage,
            "system-entities": systemEntities("/dev/disk43s1", preexistingMount),
          },
        ],
      };
    }
    if (options.postDetachMountOccupied) {
      return {
        images: [
          ...retainedImages(),
          {
            "image-path": replacementImage,
            "system-entities": systemEntities("/dev/disk43s1"),
          },
        ],
      };
    }
    if (options.postDetachDeviceRemains) {
      return {
        images: [
          ...retainedImages(),
          {
            "image-path": replacementImage,
            "system-entities": [
              { "dev-entry": "/dev/disk42" },
              { "dev-entry": "/dev/disk43s1", "mount-point": preexistingMount },
            ],
          },
        ],
      };
    }
    return emptyInfoMetadata();
  };
  const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
    if (executable === "/usr/bin/ditto") {
      const destination = arguments_.at(-1);
      if (typeof destination !== "string") throw new Error("synthetic ditto path rejected");
      await populate(destination, options.zipShape ?? "valid");
      return { stdout: "", stderr: "" };
    }
    if (executable === "/usr/bin/hdiutil" && arguments_[0] === "attach") {
      const mountPointIndex = arguments_.indexOf("-mountpoint");
      const selected = arguments_[mountPointIndex + 1];
      if (selected !== mountPoint || mountPoint.length === 0) {
        throw new Error("synthetic mount path rejected");
      }
      attachedImage = arguments_.at(-1) ?? "";
      await populate(mountPoint, options.dmgShape ?? "valid");
      attached = true;
      if (options.attachFailureAfterMount) throw new Error("private interrupted attach output");
      pendingPlistConversions.push(options.mountMetadata ?? defaultMountMetadata());
      return { stdout: "synthetic hdiutil plist\n", stderr: "private attach details" };
    }
    if (executable === "/usr/bin/hdiutil" && arguments_[0] === "info") {
      infoRequestCount += 1;
      if (options.discoveryFailure && infoRequestCount >= 3) {
        throw new Error("private hdiutil info output");
      }
      let metadata: unknown;
      if (infoRequestCount === 1) {
        metadata = emptyInfoMetadata();
      } else if (attached && !options.attachFailureAfterMount && !afterAttachStateServed) {
        afterAttachStateServed = true;
        metadata = infoMetadata();
      } else if (attached && !beforeDetachStateServed) {
        beforeDetachStateServed = true;
        metadata = preDetachMetadata();
      } else if (attached) {
        metadata = preDetachMetadata();
      } else {
        metadata = postDetachMetadata();
      }
      pendingPlistConversions.push(metadata);
      return { stdout: "synthetic hdiutil info plist\n", stderr: "private info details" };
    }
    if (executable === "/usr/bin/plutil") {
      const converted = pendingPlistConversions.shift();
      convertedPlists.push(converted);
      return {
        stdout: JSON.stringify(converted),
        stderr: "",
      };
    }
    if (executable === "/usr/bin/hdiutil" && arguments_[0] === "detach") {
      if (options.detachFailure) throw new Error("private detach output");
      if (!options.detachLeavesMounted) {
        attached = false;
        await Promise.all(
          (await readdir(mountPoint)).map((entry) =>
            rm(join(mountPoint, entry), { recursive: true, force: true }),
          ),
        );
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error("synthetic command rejected");
  });
  const verifyIdentityContinuity = vi.fn(
    async (
      _baseline: string,
      application: string,
      verificationOptions: { candidateVersion: string },
    ) => {
      const source = application.includes("/zip/") ? "zip" : "dmg";
      if (options.identityFailure === source) {
        throw new Error(`${application}: private signing output`);
      }
      return {
        baselineVersion: "0.1.1",
        candidateVersion: verificationOptions.candidateVersion,
        teamIdentifier: "FA494ACVTF",
        candidateCodeIdentity:
          source === "zip"
            ? (options.zipCodeIdentity ?? looseCandidateCodeIdentity)
            : (options.dmgCodeIdentity ?? looseCandidateCodeIdentity),
      };
    },
  );
  const remove = vi.fn(async (path: string, removeOptions: { recursive: true; force: true }) => {
    if (options.cleanupFailure && temporaryDirectories.includes(path)) {
      throw new Error("private cleanup output");
    }
    await rm(path, removeOptions);
  });
  const removeMountPoint = vi.fn(async (path: string) => {
    if (options.nonHdiutilReplacementMount || options.preAttachExactCollision) {
      throw Object.assign(new Error("synthetic replacement mount is busy"), { code: "EBUSY" });
    }
    if (options.mountPointRemovedByPeer) {
      await rmdir(path);
      throw Object.assign(new Error("synthetic mountpoint disappeared"), { code: "ENOENT" });
    }
    await rmdir(path);
    if (options.mountReappearsAfterRmdir) await mkdir(path, { mode: 0o700 });
  });
  const resolveRealpath = vi.fn(async (path: string) => {
    const source = path.includes("/zip/") ? "zip" : path.includes("/dmg/") ? "dmg" : undefined;
    if (source === options.realpathEscape && path.endsWith("/Enduragent.app")) {
      return symlinkTarget;
    }
    return realpath(path);
  });
  const verify = () =>
    verifyMacosReleaseApplicationContents(
      artifactDirectory,
      baseline,
      { candidateVersion: version, looseCandidateCodeIdentity },
      {
        executeFile,
        mkdtemp: mkdtempTracked,
        realpath: resolveRealpath,
        rm: remove,
        rmdir: removeMountPoint,
        tmpdir: () => root,
        verifyIdentityContinuity,
      },
    );
  return {
    artifactDirectory,
    baseline,
    canonicalDmgArtifact,
    convertedPlists,
    executeFile,
    intendedMountPoint: () => mountPoint,
    verifyIdentityContinuity,
    remove,
    removeMountPoint,
    temporaryDirectories,
    verify,
  };
}

describe.skipIf(process.platform === "win32")("macOS packaged application identity binding", () => {
  it("binds both mandatory packaged applications to the loose candidate before cleanup", async () => {
    const fixture = await packagedApplicationFixture();

    await expect(fixture.verify()).resolves.toBeUndefined();

    expect(fixture.verifyIdentityContinuity).toHaveBeenCalledTimes(2);
    for (const [baseline, application, verificationOptions] of fixture.verifyIdentityContinuity.mock
      .calls) {
      expect(baseline).toBe(fixture.baseline);
      expect(application).toMatch(/\/(?:zip|dmg)\/Enduragent\.app$/u);
      expect(verificationOptions).toEqual({ candidateVersion: version });
    }
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/ditto", [
      "-x",
      "-k",
      join(fixture.artifactDirectory, names.zip),
      expect.stringMatching(/\/zip$/u),
    ]);
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-plist",
      "-mountpoint",
      fixture.intendedMountPoint(),
      join(fixture.artifactDirectory, names.dmg),
    ]);
    expect(fixture.intendedMountPoint()).not.toBe("");
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
    const detachCall = fixture.executeFile.mock.calls.findIndex(
      ([executable, arguments_]) => executable === "/usr/bin/hdiutil" && arguments_[0] === "detach",
    );
    const infoCalls = fixture.executeFile.mock.calls
      .map(([executable, arguments_], index) => ({ executable, arguments_, index }))
      .filter(
        ({ executable, arguments_ }) =>
          executable === "/usr/bin/hdiutil" && arguments_[0] === "info",
      );
    expect(infoCalls).toHaveLength(4);
    expect(infoCalls[2]!.index).toBeLessThan(detachCall);
    expect(detachCall).toBeLessThan(infoCalls[3]!.index);
    expect(fixture.executeFile.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fixture.removeMountPoint.mock.invocationCallOrder[0]!,
    );
    expect(fixture.removeMountPoint.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.remove.mock.invocationCallOrder[0]!,
    );
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the standard electron-builder DMG presentation root", async () => {
    const fixture = await packagedApplicationFixture({ dmgShape: "presentation" });
    await expect(fixture.verify()).resolves.toBeUndefined();
    expect(fixture.verifyIdentityContinuity).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid-presentation", "unrelated"] as const)(
    "rejects a DMG root with %s entries",
    async (dmgShape) => {
      const fixture = await packagedApplicationFixture({ dmgShape });
      await expect(fixture.verify()).rejects.toThrow("DMG root application is invalid");
      await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("accepts the canonical /private/var alias for a /var mountpoint", async () => {
    const fixture = await packagedApplicationFixture({ privateVarMountMetadata: true });
    await expect(fixture.verify()).resolves.toBeUndefined();
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
  });

  it("leaves an unrelated preexisting disk image attached", async () => {
    const fixture = await packagedApplicationFixture({ preexistingImage: true });

    await expect(fixture.verify()).resolves.toBeUndefined();

    const detachCalls = fixture.executeFile.mock.calls.filter(
      ([executable, arguments_]) => executable === "/usr/bin/hdiutil" && arguments_[0] === "detach",
    );
    expect(detachCalls).toEqual([["/usr/bin/hdiutil", ["detach", "/dev/disk42s1"]]]);
  });

  it("never attaches or detaches when the exact image, mountpoint, and device preexist", async () => {
    const fixture = await packagedApplicationFixture({ preAttachExactCollision: true });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG mountpoint cleanup failed");

    const intendedMountPoint = fixture.intendedMountPoint();
    expect(intendedMountPoint).not.toBe("");
    expect(fixture.convertedPlists).toEqual([
      {
        images: [
          {
            "image-path": fixture.canonicalDmgArtifact,
            "system-entities": [
              { "dev-entry": "/dev/disk42" },
              { "dev-entry": "/dev/disk42s1", "mount-point": intendedMountPoint },
            ],
          },
        ],
      },
    ]);
    expect(
      fixture.executeFile.mock.calls.some(
        ([executable, arguments_]) =>
          executable === "/usr/bin/hdiutil" &&
          (arguments_[0] === "attach" || arguments_[0] === "detach"),
      ),
    ).toBe(false);
    expect(fixture.removeMountPoint).toHaveBeenCalledOnce();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("never detaches an attachment that reuses a preexisting device", async () => {
    const fixture = await packagedApplicationFixture({ reusePreexistingDevice: true });

    await expect(fixture.verify()).rejects.toThrow(
      "macOS release DMG detach state verification failed",
    );

    expect(
      fixture.executeFile.mock.calls.some(
        ([executable, arguments_]) =>
          executable === "/usr/bin/hdiutil" && arguments_[0] === "attach",
      ),
    ).toBe(true);
    expect(
      fixture.executeFile.mock.calls.some(
        ([executable, arguments_]) =>
          executable === "/usr/bin/hdiutil" && arguments_[0] === "detach",
      ),
    ).toBe(false);
    expect(fixture.removeMountPoint).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it.each([
    ["image", { beforeDetachImageSwap: true }],
    ["device", { beforeDetachDeviceSwap: true }],
  ] as const)("never detaches or removes a %s-swapped mount", async (_label, options) => {
    const fixture = await packagedApplicationFixture(options);

    await expect(fixture.verify()).rejects.toThrow(
      "macOS release DMG detach state verification failed",
    );

    expect(
      fixture.executeFile.mock.calls.some(
        ([executable, arguments_]) =>
          executable === "/usr/bin/hdiutil" && arguments_[0] === "detach",
      ),
    ).toBe(false);
    expect(fixture.removeMountPoint).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it.each([
    ["canonical image remains", { postDetachImageRemains: true }],
    ["canonical mountpoint is occupied", { postDetachMountOccupied: true }],
    ["bound device remains", { postDetachDeviceRemains: true }],
  ] as const)("preserves recovery storage when the %s after detach", async (_label, options) => {
    const fixture = await packagedApplicationFixture(options);

    await expect(fixture.verify()).rejects.toThrow(
      "macOS release DMG detach state verification failed",
    );

    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
    expect(fixture.removeMountPoint).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("does not trust hdiutil absence when a non-hdiutil mount keeps the mountpoint busy", async () => {
    const fixture = await packagedApplicationFixture({ nonHdiutilReplacementMount: true });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG mountpoint cleanup failed");

    expect(fixture.removeMountPoint).toHaveBeenCalledOnce();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("detects a mountpoint that reappears after non-recursive removal", async () => {
    const fixture = await packagedApplicationFixture({ mountReappearsAfterRmdir: true });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG mountpoint cleanup failed");

    expect(fixture.removeMountPoint).toHaveBeenCalledOnce();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("preserves recovery storage when the mountpoint disappears during non-recursive removal", async () => {
    const fixture = await packagedApplicationFixture({ mountPointRemovedByPeer: true });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG mountpoint cleanup failed");

    expect(fixture.removeMountPoint).toHaveBeenCalledOnce();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("never recursively removes a temporary path that fails prefix validation", async () => {
    const fixture = await packagedApplicationFixture();
    const remove = vi.fn(async () => {});

    await expect(
      verifyMacosReleaseApplicationContents(
        fixture.artifactDirectory,
        fixture.baseline,
        { candidateVersion: version, looseCandidateCodeIdentity },
        {
          executeFile: fixture.executeFile,
          mkdtemp: vi.fn(async () => fixture.artifactDirectory),
          rm: remove,
          tmpdir: () => dirname(fixture.artifactDirectory),
          verifyIdentityContinuity: fixture.verifyIdentityContinuity,
        },
      ),
    ).rejects.toThrow("macOS release application temporary directory is invalid");

    expect(remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.artifactDirectory)).isDirectory()).toBe(true);
  });

  it("redacts temporary-directory creation failures", async () => {
    const fixture = await packagedApplicationFixture();
    const sentinel = `${fixture.artifactDirectory}: private temporary output`;
    let failure: unknown;
    try {
      await verifyMacosReleaseApplicationContents(
        fixture.artifactDirectory,
        fixture.baseline,
        { candidateVersion: version, looseCandidateCodeIdentity },
        {
          executeFile: fixture.executeFile,
          mkdtemp: vi.fn(async () => {
            throw new Error(sentinel);
          }),
          tmpdir: () => dirname(fixture.artifactDirectory),
          verifyIdentityContinuity: fixture.verifyIdentityContinuity,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("macOS release application verification failed");
    expect((failure as Error).message).not.toContain(sentinel);
  });

  it.each([
    ["ZIP", { zipCodeIdentity: { ...looseCandidateCodeIdentity, codeDirectory: "different" } }],
    ["DMG", { dmgCodeIdentity: { ...looseCandidateCodeIdentity, codeDirectory: "different" } }],
    [
      "same signed identity but different CDHash",
      {
        dmgCodeIdentity: {
          ...looseCandidateCodeIdentity,
          codeDirectorySha256: "c".repeat(64),
          cdHash: "c".repeat(40),
        },
      },
    ],
    [
      "ZIP with the same signed identity and CDHash prefix but different full digest content",
      {
        zipCodeIdentity: {
          ...looseCandidateCodeIdentity,
          codeDirectorySha256: `${"b".repeat(40)}${"c".repeat(24)}`,
        },
      },
    ],
    [
      "DMG with the same signed identity and CDHash prefix but different full digest content",
      {
        dmgCodeIdentity: {
          ...looseCandidateCodeIdentity,
          codeDirectorySha256: `${"b".repeat(40)}${"c".repeat(24)}`,
        },
      },
    ],
  ])("rejects %s application drift", async (_label, options) => {
    const fixture = await packagedApplicationFixture(options);
    await expect(fixture.verify()).rejects.toThrow(
      "packaged macOS application differs from the loose candidate",
    );
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["zip", "dmg"] as const)("requires the %s artifact", async (artifact) => {
    const fixture = await packagedApplicationFixture();
    await rm(join(fixture.artifactDirectory, names[artifact]));
    await expect(fixture.verify()).rejects.toThrow(`missing ${artifact.toUpperCase()} artifact`);
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it.each([
    ["ZIP", "zipShape", "missing"],
    ["ZIP", "zipShape", "multiple"],
    ["ZIP", "zipShape", "symlink"],
    ["DMG", "dmgShape", "missing"],
    ["DMG", "dmgShape", "multiple"],
    ["DMG", "dmgShape", "symlink"],
  ] as const)("rejects a %s %s root application", async (label, key, shape) => {
    const fixture = await packagedApplicationFixture({ [key]: shape });
    await expect(fixture.verify()).rejects.toThrow(`${label} root application is invalid`);
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["zip", "dmg"] as const)("rejects a %s application realpath escape", async (source) => {
    const fixture = await packagedApplicationFixture({ realpathEscape: source });
    await expect(fixture.verify()).rejects.toThrow(
      `${source.toUpperCase()} root application is invalid`,
    );
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { "system-entities": [] },
    {
      "system-entities": [{ "dev-entry": "/dev/disk42s1", "mount-point": "/Volumes/Unexpected" }],
    },
    {
      "system-entities": [
        { "dev-entry": "/dev/disk42s1;touch /tmp/leak", "mount-point": "expected" },
      ],
    },
    {
      "system-entities": [
        { "dev-entry": "/dev/disk42s1", "mount-point": "first" },
        { "dev-entry": "/dev/disk43s1", "mount-point": "second" },
      ],
    },
  ])(
    "rejects invalid or malicious hdiutil metadata and detaches the exact mount",
    async (metadata) => {
      const fixture = await packagedApplicationFixture({ mountMetadata: metadata });
      await expect(fixture.verify()).rejects.toThrow("macOS release DMG mount metadata is invalid");
      const detach = fixture.executeFile.mock.calls.find(
        ([executable, arguments_]) =>
          executable === "/usr/bin/hdiutil" && arguments_[0] === "detach",
      );
      expect(detach?.[1]).toEqual(["detach", "/dev/disk42s1"]);
      await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("detaches and removes the exact temporary root when packaged identity verification fails", async () => {
    const fixture = await packagedApplicationFixture({ identityFailure: "dmg" });
    await expect(fixture.verify()).rejects.toThrow(
      "packaged macOS application identity verification failed",
    );
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
    expect(fixture.remove).toHaveBeenCalledWith(fixture.temporaryDirectories[0], {
      recursive: true,
      force: true,
    });
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers and detaches a device when attach populates the mount then throws", async () => {
    const fixture = await packagedApplicationFixture({ attachFailureAfterMount: true });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG mount failed");

    expect(fixture.verifyIdentityContinuity).toHaveBeenCalledTimes(1);
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", ["info", "-plist"]);
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
    expect(fixture.remove).toHaveBeenCalledWith(fixture.temporaryDirectories[0], {
      recursive: true,
      force: true,
    });
    await expect(lstat(fixture.temporaryDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a partially mounted root when detach fails after interrupted attach", async () => {
    const fixture = await packagedApplicationFixture({
      attachFailureAfterMount: true,
      detachFailure: true,
    });

    await expect(fixture.verify()).rejects.toThrow("macOS release DMG detach failed");

    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("preserves a possibly mounted root when mount-state discovery fails", async () => {
    const fixture = await packagedApplicationFixture({ discoveryFailure: true });

    await expect(fixture.verify()).rejects.toThrow(
      "macOS release DMG detach state verification failed",
    );

    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("preserves a root when the device remains mounted after detach reports success", async () => {
    const fixture = await packagedApplicationFixture({ detachLeavesMounted: true });

    await expect(fixture.verify()).rejects.toThrow(
      "macOS release DMG detach state verification failed",
    );

    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("blocks promotion and preserves the mount root when exact detach fails", async () => {
    const fixture = await packagedApplicationFixture({ detachFailure: true });
    await expect(fixture.verify()).rejects.toThrow("macOS release DMG detach failed");
    expect(fixture.remove).not.toHaveBeenCalled();
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("blocks promotion when exact temporary-root removal fails", async () => {
    const fixture = await packagedApplicationFixture({ cleanupFailure: true });
    await expect(fixture.verify()).rejects.toThrow("macOS release application cleanup failed");
    expect(fixture.executeFile).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "/dev/disk42s1",
    ]);
    expect((await lstat(fixture.temporaryDirectories[0]!)).isDirectory()).toBe(true);
  });

  it("redacts native output and application paths from packaged verification failures", async () => {
    const fixture = await packagedApplicationFixture({ identityFailure: "zip" });
    let failure: unknown;
    try {
      await fixture.verify();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "packaged macOS application identity verification failed",
    );
    expect((failure as Error).message).not.toContain(fixture.temporaryDirectories[0]!);
    expect((failure as Error).message).not.toContain("private signing output");
  });
});

describe.skipIf(process.platform === "win32")("macOS release artifact envelope", () => {
  it("verifies artifacts, the loose candidate, and packaged applications as one envelope", async () => {
    const fixture = await releaseFixture();
    const baselineApplication = "/synthetic/baseline/Enduragent.app";
    const looseCandidateApplication = "/synthetic/candidate/Enduragent.app";
    const artifacts = Object.freeze({
      version,
      names: Object.freeze({ ...names, metadata: "latest-mac.yml" as const }),
      paths: Object.freeze({
        dmg: join(fixture.artifactDirectory, names.dmg),
        zip: join(fixture.artifactDirectory, names.zip),
        blockmap: join(fixture.artifactDirectory, names.blockmap),
        metadata: join(fixture.artifactDirectory, names.metadata),
      }),
      sizes: Object.freeze({
        dmg: fixture.dmg.length,
        zip: fixture.zip.length,
        blockmap: fixture.blockmap.length,
      }),
      dmgSha512: fixture.dmgSha512,
      zipSha512: fixture.zipSha512,
    });
    const identityContinuity = Object.freeze({
      baselineVersion: "0.1.1",
      candidateVersion: version,
      teamIdentifier: "FA494ACVTF",
      candidateCodeIdentity: Object.freeze({
        codeDirectory: "v=20500 size=100 flags=0x10000(runtime) hashes=1+7 location=embedded",
        codeDirectorySha256: "b".repeat(64),
        cdHash: "b".repeat(40),
      }),
    });
    const verifyReleaseArtifacts = vi.fn(async () => artifacts);
    const verifyIdentityContinuity = vi.fn(async () => identityContinuity);
    const verifyReleaseApplicationContents = vi.fn(async () => {});

    const verified = await verifyMacosReleaseEnvelope(
      fixture.artifactDirectory,
      baselineApplication,
      looseCandidateApplication,
      { repositoryRoot: fixture.repositoryRoot },
      {
        verifyReleaseArtifacts,
        verifyIdentityContinuity,
        verifyReleaseApplicationContents,
      },
    );

    expect(verified).toEqual({ artifacts, identityContinuity });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(verifyReleaseArtifacts).toHaveBeenCalledWith(
      fixture.artifactDirectory,
      { repositoryRoot: fixture.repositoryRoot },
      expect.any(Object),
    );
    expect(verifyIdentityContinuity).toHaveBeenCalledWith(
      baselineApplication,
      looseCandidateApplication,
      { candidateVersion: version },
      expect.any(Object),
    );
    expect(verifyReleaseApplicationContents).toHaveBeenCalledWith(
      fixture.artifactDirectory,
      baselineApplication,
      {
        candidateVersion: version,
        looseCandidateCodeIdentity: identityContinuity.candidateCodeIdentity,
      },
      expect.any(Object),
    );
    expect(verifyReleaseArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      verifyIdentityContinuity.mock.invocationCallOrder[0]!,
    );
    expect(verifyIdentityContinuity.mock.invocationCallOrder[0]).toBeLessThan(
      verifyReleaseApplicationContents.mock.invocationCallOrder[0]!,
    );
  });

  it("stops packaged-application verification when loose identity continuity fails", async () => {
    const fixture = await releaseFixture();
    const failure = new Error("synthetic loose identity failure");
    const verifyReleaseApplicationContents = vi.fn(async () => {});

    await expect(
      verifyMacosReleaseEnvelope(
        fixture.artifactDirectory,
        "/synthetic/baseline/Enduragent.app",
        "/synthetic/candidate/Enduragent.app",
        { repositoryRoot: fixture.repositoryRoot },
        {
          verifyReleaseArtifacts: vi.fn(async () => ({
            version,
            names: { ...names, metadata: "latest-mac.yml" as const },
            paths: {
              dmg: join(fixture.artifactDirectory, names.dmg),
              zip: join(fixture.artifactDirectory, names.zip),
              blockmap: join(fixture.artifactDirectory, names.blockmap),
              metadata: join(fixture.artifactDirectory, names.metadata),
            },
            sizes: {
              dmg: fixture.dmg.length,
              zip: fixture.zip.length,
              blockmap: fixture.blockmap.length,
            },
            dmgSha512: fixture.dmgSha512,
            zipSha512: fixture.zipSha512,
          })),
          verifyIdentityContinuity: vi.fn(async () => {
            throw failure;
          }),
          verifyReleaseApplicationContents,
        },
      ),
    ).rejects.toBe(failure);
    expect(verifyReleaseApplicationContents).not.toHaveBeenCalled();
  });

  it("requires three absolute paths at the standalone verifier boundary", () => {
    const script = join(desktopRoot, "scripts/verify-macos-release.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "/synthetic/artifacts", "relative-baseline.app", "/synthetic/candidate.app"],
      { cwd: desktopRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("expected absolute artifact, baseline, and loose candidate paths\n");
  });

  it("validates both artifacts and exact regenerated blockmap bytes through the seam", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    const verifySignature = vi.fn(async () => {});
    const verifyNotarization = vi.fn(async () => {});
    const buildBlockMap = vi.fn(
      async (_inputPath: string, _compression: "gzip", outputPath: string) => {
        await writeFile(outputPath, fixture.blockmap);
      },
    );
    const verified = await verifyMacosReleaseArtifacts(
      fixture.artifactDirectory,
      { repositoryRoot: fixture.repositoryRoot },
      {
        buildBlockMap,
        mkdtemp: temporary.mkdtemp,
        tmpdir: temporary.tmpdir,
        verifySignature,
        verifyNotarization,
      },
    );
    expect(verified).toMatchObject({
      version,
      names,
      zipSha512: fixture.zipSha512,
      dmgSha512: fixture.dmgSha512,
      sizes: {
        zip: fixture.zip.length,
        dmg: fixture.dmg.length,
      },
    });
    expect(buildBlockMap).toHaveBeenCalledOnce();
    expect(buildBlockMap).toHaveBeenCalledWith(
      join(fixture.artifactDirectory, names.zip),
      "gzip",
      join(temporary.directory, "expected.zip.blockmap"),
    );
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(verifySignature).toHaveBeenCalledWith(verified);
    expect(verifyNotarization).toHaveBeenCalledOnce();
    expect(verifyNotarization).toHaveBeenCalledWith(verified);
  });

  it("accepts the pinned blockmap and invokes mandatory DMG verification defaults", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
        return dmgSigningIdentityResult();
      }
      return { stdout: "", stderr: "" };
    });
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        {
          repositoryRoot: fixture.repositoryRoot,
        },
        { executeFile },
      ),
    ).resolves.toMatchObject({
      zipSha512: fixture.zipSha512,
      dmgSha512: fixture.dmgSha512,
    });
    const dmgPath = join(fixture.artifactDirectory, names.dmg);
    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--verbose=2", dmgPath]],
      ["/usr/bin/codesign", ["--display", "--verbose=4", dmgPath]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", dmgPath]],
      [
        "/usr/sbin/spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          "--verbose=4",
          dmgPath,
        ],
      ],
    ]);
  });

  it("verifies the unpacked application with codesign, stapler, and Gatekeeper", async () => {
    const application = "/synthetic/Enduragent.app";
    const executeFile = vi.fn(async () => {});

    await verifyMacosApplication(application, { executeFile });

    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", application]],
      ["/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", application]],
    ]);
  });

  it("verifies the packaged keychain binding image, identity, and designated requirement", async () => {
    const application = "/synthetic/Enduragent.app";
    const binding = `${application}/Contents/Resources/app.asar.unpacked/native/keychain-binding.node`;
    const inspectBindingImage = vi.fn(async () => keychainBindingImageIdentity);
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (arguments_.includes("--requirements")) return keychainBindingRequirementResult();
      if (arguments_.includes("--verbose=4")) return keychainBindingIdentityResult();
      return { stdout: "", stderr: "" };
    });

    await expect(
      verifyMacosKeychainBinding(application, { executeFile, inspectBindingImage }),
    ).resolves.toEqual({
      binding,
      identifier: keychainBindingIdentifier,
      teamIdentifier: "FA494ACVTF",
      designatedRequirement: keychainBindingDesignatedRequirement,
      imageIdentity: keychainBindingImageIdentity,
    });
    expect(inspectBindingImage).toHaveBeenCalledWith(binding);
    expect(keychainBindingImageIdentity.fileType).toBe(machoBundleFileType);
    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binding]],
      ["/usr/bin/codesign", ["--display", "--verbose=4", binding]],
      ["/usr/bin/codesign", ["--display", "--requirements", "-", binding]],
    ]);
  });

  it.each([
    [
      "an unverifiable signature",
      () => ({ verifies: false }),
      "macOS keychain binding signature verification failed",
    ],
    [
      "a foreign team identifier",
      () => ({ teamIdentifier: "ZZZZZZZZZZ" }),
      "macOS keychain binding signing identity is invalid",
    ],
    [
      "a binding without the hardened runtime",
      () => ({ flags: "adhoc" }),
      "macOS keychain binding signing identity is invalid",
    ],
    [
      "a designated requirement naming another team",
      () => ({ requirementTeamIdentifier: "ZZZZZZZZZZ" }),
      "macOS keychain binding designated requirement is invalid",
    ],
    [
      "a native image that is not MH_BUNDLE",
      () => ({ imageValid: false }),
      "macOS keychain binding image is invalid",
    ],
  ])("rejects %s", async (_label, overrides, message) => {
    const options = overrides() as {
      verifies?: boolean;
      teamIdentifier?: string;
      flags?: string;
      requirementTeamIdentifier?: string;
      imageValid?: boolean;
    };
    const inspectBindingImage = vi.fn(async () => {
      if (options.imageValid === false) throw new Error("synthetic non-MH_BUNDLE image");
      return keychainBindingImageIdentity;
    });
    const executeFile = vi.fn(async (_executable: string, arguments_: readonly string[]) => {
      if (arguments_.includes("--verify") && options.verifies === false) {
        throw new Error("synthetic native verification failure");
      }
      if (arguments_.includes("--requirements")) {
        return keychainBindingRequirementResult(options.requirementTeamIdentifier);
      }
      if (arguments_.includes("--verbose=4")) {
        return keychainBindingIdentityResult(options.teamIdentifier, options.flags);
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      verifyMacosKeychainBinding("/synthetic/Enduragent.app", {
        executeFile,
        inspectBindingImage,
      }),
    ).rejects.toThrow(message);
  });

  it("fails closed without invoking later application verification commands", async () => {
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic native verification failure");
    });

    await expect(
      verifyMacosApplication("/synthetic/Enduragent.app", { executeFile }),
    ).rejects.toThrow("macOS application signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("fails final-envelope verification when the DMG staple is absent", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
        return dmgSigningIdentityResult();
      }
      if (executable === "/usr/bin/xcrun") {
        throw new Error("synthetic missing staple");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        { executeFile },
      ),
    ).rejects.toThrow("macOS DMG staple verification failed");
    expect(executeFile.mock.calls).toEqual([
      [
        "/usr/bin/codesign",
        ["--verify", "--verbose=2", join(fixture.artifactDirectory, names.dmg)],
      ],
      [
        "/usr/bin/codesign",
        ["--display", "--verbose=4", join(fixture.artifactDirectory, names.dmg)],
      ],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", join(fixture.artifactDirectory, names.dmg)]],
    ]);
  });

  it.each([
    ["team identifier", "ABCDE12345", "FA494ACVTF"],
    ["leaf authority", "FA494ACVTF", "ABCDE12345"],
  ])(
    "rejects a valid notarized DMG with an alternate Developer ID %s",
    async (_label, teamIdentifier, authorityTeamIdentifier) => {
      const fixture = await releaseFixture();
      const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
        if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
          return dmgSigningIdentityResult(teamIdentifier, authorityTeamIdentifier);
        }
        return { stdout: "", stderr: "" };
      });

      await expect(
        verifyMacosReleaseArtifacts(
          fixture.artifactDirectory,
          { repositoryRoot: fixture.repositoryRoot },
          { executeFile },
        ),
      ).rejects.toThrow("macOS DMG signing identity is invalid");
      expect(executeFile.mock.calls).toEqual([
        [
          "/usr/bin/codesign",
          ["--verify", "--verbose=2", join(fixture.artifactDirectory, names.dmg)],
        ],
        [
          "/usr/bin/codesign",
          ["--display", "--verbose=4", join(fixture.artifactDirectory, names.dmg)],
        ],
      ]);
    },
  );

  it("redacts DMG signing identity inspection failures", async () => {
    const fixture = await releaseFixture();
    const sentinel = "private alternate signing certificate output";
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === "/usr/bin/codesign" && arguments_.includes("--display")) {
        throw new Error(sentinel);
      }
      return { stdout: "", stderr: "" };
    });
    let failure: unknown;

    try {
      await verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        { executeFile },
      );
    } catch (error) {
      failure = error;
    }

    expect(safeMacosReleaseVerificationMessage(failure)).toBe(
      "macOS DMG signing identity inspection failed",
    );
    expect((failure as Error).message).not.toContain(sentinel);
    expect(executeFile).toHaveBeenCalledTimes(2);
  });

  it("rejects an envelope when mandatory DMG verification fails", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic native verification failure");
    });

    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        { executeFile },
      ),
    ).rejects.toThrow("macOS DMG signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("cleans the exact temporary blockmap after regeneration fails", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    const buildBlockMap = vi.fn(
      async (_inputPath: string, _compression: "gzip", outputPath: string) => {
        await writeFile(outputPath, "partial regenerated blockmap");
        throw new Error("synthetic regeneration failure");
      },
    );
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        {
          buildBlockMap,
          mkdtemp: temporary.mkdtemp,
          tmpdir: temporary.tmpdir,
        },
      ),
    ).rejects.toThrow("unable to regenerate ZIP blockmap");
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing and extra release artifacts", async () => {
    const missing = await releaseFixture();
    await rm(join(missing.artifactDirectory, names.blockmap));
    await expect(
      verifyMacosReleaseArtifacts(missing.artifactDirectory, {
        repositoryRoot: missing.repositoryRoot,
      }),
    ).rejects.toThrow("release artifact envelope differs");

    const extra = await releaseFixture();
    await writeFile(join(extra.artifactDirectory, "stale-mac.yml"), "stale\n");
    await expect(
      verifyMacosReleaseArtifacts(extra.artifactDirectory, {
        repositoryRoot: extra.repositoryRoot,
      }),
    ).rejects.toThrow("release artifact envelope differs");
  });

  it.each([
    ["version", (source: string) => source.replace(version, "0.1.1")],
    ["ZIP filename", (source: string) => source.replace(names.zip, "stale.zip")],
    [
      "ZIP SHA-512",
      (source: string) => source.replace(/sha512: [A-Za-z0-9+/=]+/u, "sha512: stale"),
    ],
    ["ZIP size", (source: string) => source.replace(/size: \d+/u, "size: 1")],
    ["third metadata key", (source: string) => `${source}unexpected: true\n`],
  ])("rejects stale %s metadata", async (_label, mutate) => {
    const fixture = await releaseFixture();
    const path = join(fixture.artifactDirectory, names.metadata);
    await writeFile(path, mutate(await readFile(path, "utf8")));
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow(/latest-mac\.yml/u);
  });

  it("rejects metadata whose artifact authority is not ZIP first and DMG second", async () => {
    const fixture = await releaseFixture();
    const metadataPath = join(fixture.artifactDirectory, names.metadata);
    const metadata = parse(await readFile(metadataPath, "utf8")) as {
      files: unknown[];
    };
    metadata.files.reverse();
    await writeFile(metadataPath, stringify(metadata));
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects stale ZIP bytes even when filenames remain unchanged", async () => {
    const fixture = await releaseFixture();
    await writeFile(join(fixture.artifactDirectory, names.zip), "different ZIP bytes\n");
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects tampered DMG bytes even when filenames remain unchanged", async () => {
    const fixture = await releaseFixture();
    await writeFile(join(fixture.artifactDirectory, names.dmg), "different DMG bytes\n");
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects a blockmap that is not the exact gzip blockmap of the ZIP", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    await writeFile(join(fixture.artifactDirectory, names.blockmap), "tampered blockmap\n");
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        {
          mkdtemp: temporary.mkdtemp,
          tmpdir: temporary.tmpdir,
        },
      ),
    ).rejects.toThrow("ZIP blockmap does not match the ZIP artifact");
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
