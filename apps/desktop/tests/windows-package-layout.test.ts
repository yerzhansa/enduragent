import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN } from "../scripts/package-inventory.mjs";
import {
  WINDOWS_PACKAGE_GUID,
  windowsPackageArtifactName,
} from "../scripts/windows-package-plan.mjs";
import {
  type WindowsPackageEvidence,
  WindowsPackageVerificationError,
  readWindowsBuilderAuthority,
  verifyWindowsPackage,
  verifyWindowsPackageLayout,
} from "../scripts/verify-windows-package.mjs";

const canonicalDesktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const version = "0.0.1";
const sourceManifest = {
  name: "@enduragent/desktop",
  version,
  main: "out/main/index.js",
  dependencies: { "@enduragent/core": "workspace:*" },
};
const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest)}\n`);
const exclusions = [
  "!**/*.map",
  "!**/.env*",
  "!**/{test,tests,__tests__,fixture,fixtures,dev-fixture,dev-fixtures}/**",
  "!**/*.{test,spec}.{js,cjs,mjs,ts,cts,mts,jsx,tsx}",
  "!**/vitest.config.{js,cjs,mjs,ts,cts,mts}",
  "!**/vitest.workspace.{js,cjs,mjs,ts,cts,mts}",
  "!**/node_modules/vitest/**",
  "!**/node_modules/@vitest/**",
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
];
const runtimeFiles = [
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "icudtl.dat",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader_icd.json",
];
const runtimeBinaries = [
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "ffmpeg.dll",
  "libEGL.dll",
  "libGLESv2.dll",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
];
const telegramRuntimePackages = [
  {
    name: "@enduragent/core",
    root: "node_modules/@enduragent/core",
    main: "dist/index.js",
    dependencies: { grammy: "1.42.0", "@grammyjs/auto-retry": "2.0.2" },
  },
  {
    name: "grammy",
    root: "node_modules/grammy",
    main: "out/mod.js",
    dependencies: {
      "@grammyjs/types": "3.26.0",
      "abort-controller": "3.0.0",
      debug: "4.4.3",
      "node-fetch": "2.7.0",
    },
  },
  {
    name: "@grammyjs/auto-retry",
    root: "node_modules/@grammyjs/auto-retry",
    main: "out/mod.js",
    dependencies: { debug: "4.4.3" },
  },
  {
    name: "@grammyjs/types",
    root: "node_modules/@grammyjs/types",
    main: "mod.js",
    dependencies: {},
  },
  {
    name: "abort-controller",
    root: "node_modules/abort-controller",
    main: "dist/abort-controller",
    entry: "dist/abort-controller.js",
    dependencies: { "event-target-shim": "5.0.1" },
  },
  {
    name: "event-target-shim",
    root: "node_modules/event-target-shim",
    main: "dist/event-target-shim",
    entry: "dist/event-target-shim.js",
    dependencies: {},
  },
  {
    name: "debug",
    root: "node_modules/debug",
    main: "src/index.js",
    dependencies: { ms: "2.1.3" },
  },
  {
    name: "ms",
    root: "node_modules/ms",
    main: "./index",
    entry: "index.js",
    dependencies: {},
  },
  {
    name: "node-fetch",
    root: "node_modules/node-fetch",
    main: "lib/index.js",
    dependencies: { "whatwg-url": "5.0.0" },
  },
  {
    name: "whatwg-url",
    root: "node_modules/whatwg-url",
    main: "lib/public-api.js",
    dependencies: { tr46: "0.0.3", "webidl-conversions": "3.0.1" },
  },
  {
    name: "tr46",
    root: "node_modules/tr46",
    main: "index.js",
    dependencies: {},
  },
  {
    name: "webidl-conversions",
    root: "node_modules/webidl-conversions",
    main: "lib/index.js",
    dependencies: {},
  },
] as const;

type SyntheticWindowsPackage = {
  application: string;
  archiveSource: string;
  artifact: string;
  desktop: string;
  externalPackaged: string;
  rebuild: () => Promise<void>;
  verifyArtifact: () => Promise<WindowsPackageEvidence>;
  writeArchive: (path: string, bytes?: string | Buffer) => Promise<void>;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function checksum(bytes: Buffer): Buffer {
  return Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  matrix.json\n`);
}

function builderYaml(): string {
  return [
    "appId: icu.enduragent.desktop",
    "productName: Enduragent",
    "asar: true",
    "asarUnpack:",
    `  - ${KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN}`,
    "electronFuses:",
    "  runAsNode: false",
    "  enableNodeOptionsEnvironmentVariable: false",
    "  enableNodeCliInspectArguments: false",
    "  enableEmbeddedAsarIntegrityValidation: true",
    "  onlyLoadAppFromAsar: true",
    "electronLanguages:",
    "  - en-US",
    "directories:",
    "  output: dist",
    "files:",
    "  - out/**",
    "  - package.json",
    ...exclusions.map((pattern) => `  - ${JSON.stringify(pattern)}`),
    "  - from: resources",
    "    to: resources",
    "    filter:",
    "      - trayTemplate.png",
    "      - trayTemplate@2x.png",
    "  - from: dist/self-test-asar",
    "    to: .",
    "extraResources:",
    "  - from: dist/extra-resources",
    "    to: .",
    "mac:",
    "  icon: resources/app-icon.png",
    "  target:",
    "    - target: dir",
    "      arch: [arm64]",
    "win:",
    "  icon: resources/app-icon.ico",
    "  signExecutable: false",
    "  requestedExecutionLevel: asInvoker",
    "  files:",
    "    - resources/tray.ico",
    "  target:",
    "    - target: nsis",
    "      arch: [x64]",
    "nsis:",
    "  artifactName: Enduragent-${version}-x64.${ext}",
    `  guid: ${WINDOWS_PACKAGE_GUID}`,
    "  oneClick: true",
    "  perMachine: false",
    "  packElevateHelper: false",
    "  createStartMenuShortcut: true",
    "  createDesktopShortcut: false",
    "  deleteAppDataOnUninstall: false",
    "  installerLanguages:",
    "    - en_US",
    '  language: "1033"',
    "  multiLanguageInstaller: false",
    "  displayLanguageSelector: false",
    "  differentialPackage: false",
    "  buildUniversalInstaller: false",
    "  include: build/installer.nsh",
    "",
  ].join("\n");
}

const nsisOverlaySignature = Buffer.concat([
  Buffer.from([0xef, 0xbe, 0xad, 0xde]),
  Buffer.from("NullsoftInst", "latin1"),
]);

function windowsExecutable(machine = 0x8664, marker: string | Buffer = ""): Buffer {
  const header = 0x80;
  const optionalSize = machine === 0x014c ? 224 : 240;
  const bytes = Buffer.alloc(header + 24 + optionalSize);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(header, 0x3c);
  bytes.write("PE\0\0", header, "binary");
  bytes.writeUInt16LE(machine, header + 4);
  bytes.writeUInt16LE(optionalSize, header + 20);
  bytes.writeUInt16LE(machine === 0x014c ? 0x010b : 0x020b, header + 24);
  return Buffer.concat([bytes, Buffer.from(marker)]);
}

async function syntheticWindowsPackage(): Promise<SyntheticWindowsPackage> {
  const root = await mkdtemp(join(tmpdir(), "windows-package-layout-"));
  temporaryRoots.push(root);
  const desktop = join(root, "desktop");
  const archiveSource = join(root, "archive-source");
  const application = join(root, "win-unpacked");
  const packagedResources = join(application, "resources");
  const asarSource = join(desktop, "dist/self-test-asar");
  const externalSource = join(desktop, "dist/extra-resources");
  const externalPackaged = join(packagedResources, "self-test");
  const sourceResources = join(desktop, "resources");
  const sourceOut = join(desktop, "out");
  const artifact = join(root, windowsPackageArtifactName(version));
  const matrix = Buffer.from('{"schemaVersion":1}\n');
  const matrixChecksum = checksum(matrix);
  const runner = "module.exports = { runSelfTest() { return { ok: true }; } };\n";
  const hook = [
    "!macro customUnInstall",
    '  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "icu.enduragent.desktop"',
    '  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "icu.enduragent.desktop"',
    "!macroend",
    "",
  ].join("\n");

  await Promise.all([
    mkdir(join(application, "locales"), { recursive: true }),
    mkdir(packagedResources, { recursive: true }),
    mkdir(archiveSource, { recursive: true }),
    mkdir(join(asarSource, "resources/self-test"), { recursive: true }),
    mkdir(join(externalSource, "self-test"), { recursive: true }),
    mkdir(sourceResources, { recursive: true }),
    mkdir(sourceOut, { recursive: true }),
    mkdir(join(desktop, "build"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(desktop, "electron-builder.yml"), builderYaml()),
    writeFile(join(desktop, "package.json"), sourceManifestBytes),
    writeFile(join(desktop, "build/installer.nsh"), hook),
    writeFile(join(asarSource, "resources/self-test/matrix.json"), matrix),
    writeFile(join(asarSource, "resources/self-test/matrix.sha256"), matrixChecksum),
    writeFile(join(externalSource, "self-test/matrix.json"), matrix),
    writeFile(join(externalSource, "self-test/matrix.sha256"), matrixChecksum),
    writeFile(join(externalSource, "self-test/self-test-runner.cjs"), runner),
    writeFile(join(application, "locales/en-US.pak"), "synthetic locale\n"),
    writeFile(join(sourceResources, "tray.ico"), "tray ico\n"),
    writeFile(join(sourceResources, "trayTemplate.png"), "tray png\n"),
    writeFile(join(sourceResources, "trayTemplate@2x.png"), "tray 2x png\n"),
    writeFile(
      join(application, "Enduragent.exe"),
      windowsExecutable(0x8664, 'requestedExecutionLevel level="asInvoker" uiAccess="false"'),
    ),
    ...runtimeFiles.map((path) => writeFile(join(application, path), `synthetic ${path}\n`)),
    ...runtimeBinaries.map((path) => writeFile(join(application, path), windowsExecutable())),
  ]);

  const writeArchive = async (
    path: string,
    bytes: string | Buffer = "synthetic runtime\n",
  ): Promise<void> => {
    const target = join(archiveSource, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  const applicationOutputs = [
    ["main/index.js", "synthetic main\n"],
    ["main/daemon-utility.js", "synthetic daemon\n"],
    ["preload/index.cjs", "synthetic preload\n"],
    ["preload/tray.cjs", "synthetic tray preload\n"],
    ["renderer/index.html", "<!doctype html>\n"],
    ["renderer/tray.html", "<!doctype html>\n"],
  ] as const;
  await Promise.all(
    applicationOutputs.flatMap(([path, bytes]) => [
      writeArchive(`out/${path}`, bytes),
      mkdir(dirname(join(sourceOut, path)), { recursive: true }).then(() =>
        writeFile(join(sourceOut, path), bytes),
      ),
    ]),
  );
  await Promise.all([
    writeArchive("package.json", sourceManifestBytes),
    writeArchive("resources/self-test/matrix.json", matrix),
    writeArchive("resources/self-test/matrix.sha256", matrixChecksum),
    writeArchive("resources/tray.ico", "tray ico\n"),
    writeArchive("resources/trayTemplate.png", "tray png\n"),
    writeArchive("resources/trayTemplate@2x.png", "tray 2x png\n"),
    ...telegramRuntimePackages.flatMap((runtimePackage) => [
      writeArchive(
        `${runtimePackage.root}/package.json`,
        `${JSON.stringify({
          name: runtimePackage.name,
          version: "1.0.0",
          main: runtimePackage.main,
          dependencies: runtimePackage.dependencies,
        })}\n`,
      ),
      writeArchive(
        `${runtimePackage.root}/${"entry" in runtimePackage ? runtimePackage.entry : runtimePackage.main}`,
      ),
    ]),
  ]);

  const rebuild = async (): Promise<void> => {
    await rm(join(packagedResources, "app.asar"), { force: true });
    const archive = await createPackage(archiveSource, join(packagedResources, "app.asar"));
    await finished(archive);
  };
  await rebuild();
  await cp(join(externalSource, "self-test"), externalPackaged, { recursive: true });
  await writeFile(artifact, windowsExecutable(0x014c, nsisOverlaySignature));

  const verifyArtifact = async (): Promise<WindowsPackageEvidence> =>
    verifyWindowsPackage(artifact, application, { desktopRoot: desktop });

  return {
    application,
    archiveSource,
    artifact,
    desktop,
    externalPackaged,
    rebuild,
    verifyArtifact,
    writeArchive,
  };
}

describe("Windows package verification", () => {
  it("accepts the exact x64 application and unsigned NSIS package", async () => {
    const fixture = await syntheticWindowsPackage();
    const layout = await verifyWindowsPackageLayout(fixture.application, {
      desktopRoot: fixture.desktop,
    });
    const evidence = await fixture.verifyArtifact();
    const repeated = await fixture.verifyArtifact();
    expect(layout).toEqual(evidence.application);
    expect(evidence).toEqual(repeated);
    expect(evidence).toMatchObject({
      artifact: {
        name: windowsPackageArtifactName(version),
        peMachine: 0x014c,
        nsisEnvelope: true,
      },
      application: { peMachine: 0x8664 },
    });
    expect(evidence.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.application.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.artifact.size).toBe((await readFile(fixture.artifact)).length);
    expect(evidence.application.fileCount).toBeGreaterThan(0);
    expect(evidence.application.directoryCount).toBeGreaterThan(0);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.artifact)).toBe(true);
    expect(Object.isFrozen(evidence.application)).toBe(true);
  });

  it("changes artifact and retained-tree digests when one byte changes", async () => {
    const fixture = await syntheticWindowsPackage();
    const before = await fixture.verifyArtifact();
    await writeFile(
      fixture.artifact,
      Buffer.concat([await readFile(fixture.artifact), Buffer.from([0])]),
    );
    const artifactMutation = await fixture.verifyArtifact();
    expect(artifactMutation.artifact.sha256).not.toBe(before.artifact.sha256);

    await writeFile(join(fixture.application, "LICENSE.electron.txt"), "changed by one byte!\n");
    const applicationMutation = await fixture.verifyArtifact();
    expect(applicationMutation.application.manifestSha256).not.toBe(
      before.application.manifestSha256,
    );
  });

  it("validates the checked-in builder identity and uninstall hook", async () => {
    const authority = await readWindowsBuilderAuthority(canonicalDesktopRoot);
    const hook = await readFile(authority.installerHookPath, "utf8");
    expect(authority).toMatchObject({
      asarSourceRoot: join(canonicalDesktopRoot, "dist/self-test-asar"),
      externalSourceRoot: join(canonicalDesktopRoot, "dist/extra-resources"),
      applicationSourceRoot: join(canonicalDesktopRoot, "out"),
    });
    expect(hook).toContain(
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "icu.enduragent.desktop"',
    );
    expect(hook).toContain(
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "icu.enduragent.desktop"',
    );
    expect(hook).not.toMatch(/RMDir|USERPROFILE|LOCALAPPDATA/u);
  });

  it("accepts CRLF in the exact uninstall hook and rejects content drift", async () => {
    const fixture = await syntheticWindowsPackage();
    const hookPath = join(fixture.desktop, "build/installer.nsh");
    const hook = await readFile(hookPath, "utf8");
    await writeFile(hookPath, hook.replaceAll("\n", "\r\n"));
    await expect(readWindowsBuilderAuthority(fixture.desktop)).resolves.toMatchObject({
      installerHookPath: hookPath,
    });

    await writeFile(hookPath, hook.replace("DeleteRegValue", "DeleteRegKey"));
    await expect(readWindowsBuilderAuthority(fixture.desktop)).rejects.toThrow(
      'windows-package/installer-contract: uninstall hook is invalid: "build/installer.nsh"',
    );
  });

  it("fails closed with a stage code and the exact undeclared layout path", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.application, "unexpected.bin"), "unexpected\n");
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      'windows-package/application-inventory: undeclared application entry: "unexpected.bin"',
    );
  });

  it("requires the shipped en-US locale pak", async () => {
    const missing = await syntheticWindowsPackage();
    await rm(join(missing.application, "locales/en-US.pak"));
    await expect(
      verifyWindowsPackageLayout(missing.application, { desktopRoot: missing.desktop }),
    ).rejects.toThrow(
      'windows-package/application-inventory: missing locale: "locales/en-US.pak"',
    );

    const empty = await syntheticWindowsPackage();
    await writeFile(join(empty.application, "locales/en-US.pak"), "");
    await expect(
      verifyWindowsPackageLayout(empty.application, { desktopRoot: empty.desktop }),
    ).rejects.toThrow(
      'windows-package/application-inventory: missing locale: "locales/en-US.pak"',
    );
  });

  it("rejects locales beyond the pinned en-US pak", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.application, "locales/fr.pak"), "synthetic locale\n");
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      'windows-package/application-inventory: undeclared locale: "locales/fr.pak"',
    );
  });

  it.each(["out/main/private.js.map", "fixtures/athlete.json", "out/main/feature.test.js"])(
    "rejects forbidden ASAR path %s",
    async (path) => {
      const fixture = await syntheticWindowsPackage();
      await fixture.writeArchive(path);
      await fixture.rebuild();
      await expect(
        verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
      ).rejects.toThrow(/windows-package\/asar-inventory: .*forbidden/u);
    },
  );

  it("rejects plaintext secrets in the ASAR", async () => {
    const fixture = await syntheticWindowsPackage();
    await fixture.writeArchive("out/main/private.js", "sentinel-openai-api-key");
    await fixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(/windows-package\/asar-inventory: .*known plaintext secret marker/u);
  });

  it("rejects undeclared package resources", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.application, "resources/stale-resource.json"), "{}\n");
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      'windows-package/resource-inventory: undeclared package resource: "stale-resource.json"',
    );
  });

  it("rejects stale external resource bytes", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.externalPackaged, "matrix.json"), '{"schemaVersion":2}\n');
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      'windows-package/resource-inventory: package resource bytes differ: "self-test/matrix.json"',
    );
  });

  it("rejects wrong-platform application binaries", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.application, "ffmpeg.dll"), windowsExecutable(0x014c));
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow('windows-package/binary-platform: wrong-platform binary: "ffmpeg.dll"');
  });

  it("rejects native packages inside the ASAR", async () => {
    const fixture = await syntheticWindowsPackage();
    await fixture.writeArchive("node_modules/@enduragent/core/native.node");
    await fixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      'windows-package/binary-platform: unexpected native package: "app.asar/node_modules/@enduragent/core/native.node"',
    );
  });

  it("rejects undeclared runtime packages and ASAR roots", async () => {
    const packageFixture = await syntheticWindowsPackage();
    await packageFixture.writeArchive(
      "node_modules/undeclared/package.json",
      '{"name":"undeclared","version":"1.0.0","main":"index.js"}\n',
    );
    await packageFixture.writeArchive("node_modules/undeclared/index.js");
    await packageFixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(packageFixture.application, {
        desktopRoot: packageFixture.desktop,
      }),
    ).rejects.toThrow(
      'windows-package/asar-inventory: undeclared runtime package: "node_modules/undeclared/package.json"',
    );

    const rootFixture = await syntheticWindowsPackage();
    await rootFixture.writeArchive("undeclared.bin");
    await rootFixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(rootFixture.application, { desktopRoot: rootFixture.desktop }),
    ).rejects.toThrow(
      'windows-package/asar-inventory: undeclared ASAR entry: "app.asar/undeclared.bin"',
    );

    const nestedFixture = await syntheticWindowsPackage();
    await nestedFixture.writeArchive("node_modules/@enduragent/core/node_modules/orphan/index.js");
    await nestedFixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(nestedFixture.application, {
        desktopRoot: nestedFixture.desktop,
      }),
    ).rejects.toThrow(
      'windows-package/asar-inventory: undeclared ASAR entry: "app.asar/node_modules/@enduragent/core/node_modules/orphan", "app.asar/node_modules/@enduragent/core/node_modules/orphan/index.js"',
    );
  });

  it("keeps ordinary Windows packages updater-inert", async () => {
    const resourceFixture = await syntheticWindowsPackage();
    await writeFile(
      join(resourceFixture.application, "resources/app-update.yml"),
      "provider: generic\nurl: https://updates.example.test/\n",
    );
    await expect(
      verifyWindowsPackageLayout(resourceFixture.application, {
        desktopRoot: resourceFixture.desktop,
      }),
    ).rejects.toThrow(
      'windows-package/resource-inventory: undeclared package resource: "app-update.yml"',
    );

    const markerFixture = await syntheticWindowsPackage();
    await markerFixture.writeArchive(
      "package.json",
      `${JSON.stringify({ ...sourceManifest, enduragentDesktopRelease: true })}\n`,
    );
    await markerFixture.rebuild();
    await expect(
      verifyWindowsPackageLayout(markerFixture.application, { desktopRoot: markerFixture.desktop }),
    ).rejects.toThrow(/windows-package\/asar-inventory: .*ordinary packaged manifest differs/u);
  });

  it("rejects signed, renamed, and non-NSIS installer artifacts", async () => {
    const signed = await syntheticWindowsPackage();
    const signedBytes = await readFile(signed.artifact);
    const certificateDirectory = 0x80 + 24 + 96 + 32;
    signedBytes.writeUInt32LE(1, certificateDirectory);
    signedBytes.writeUInt32LE(1, certificateDirectory + 4);
    await writeFile(signed.artifact, signedBytes);
    await expect(signed.verifyArtifact()).rejects.toThrow(
      `windows-package/artifact: installer must be unsigned: "${windowsPackageArtifactName(version)}"`,
    );

    const renamed = await syntheticWindowsPackage();
    const wrongName = join(dirname(renamed.artifact), "Enduragent-9.9.9-x64.exe");
    await cp(renamed.artifact, wrongName);
    await expect(
      verifyWindowsPackage(wrongName, renamed.application, { desktopRoot: renamed.desktop }),
    ).rejects.toThrow(
      'windows-package/artifact: artifact name is invalid: "Enduragent-9.9.9-x64.exe"',
    );

    const notNsis = await syntheticWindowsPackage();
    await writeFile(notNsis.artifact, windowsExecutable(0x014c));
    await expect(notNsis.verifyArtifact()).rejects.toThrow(
      `windows-package/artifact: installer is not an NSIS package: "${windowsPackageArtifactName(version)}"`,
    );
  });

  it("accepts x86 and x64 envelopes but rejects unsupported PE machines", async () => {
    const x64 = await syntheticWindowsPackage();
    await writeFile(x64.artifact, windowsExecutable(0x8664, nsisOverlaySignature));
    await expect(x64.verifyArtifact()).resolves.toMatchObject({
      artifact: { peMachine: 0x8664 },
    });

    const unsupported = await syntheticWindowsPackage();
    await writeFile(unsupported.artifact, windowsExecutable(0xaa64, nsisOverlaySignature));
    await expect(unsupported.verifyArtifact()).rejects.toThrow(
      `windows-package/artifact: installer is not a Windows executable: "${windowsPackageArtifactName(version)}"`,
    );
  });

  it("requires the contiguous NSIS overlay signature", async () => {
    const textOnly = await syntheticWindowsPackage();
    await writeFile(textOnly.artifact, windowsExecutable(0x014c, "NullsoftInst"));
    await expect(textOnly.verifyArtifact()).rejects.toThrow(
      `windows-package/artifact: installer is not an NSIS package: "${windowsPackageArtifactName(version)}"`,
    );

    const separated = await syntheticWindowsPackage();
    await writeFile(
      separated.artifact,
      windowsExecutable(
        0x014c,
        Buffer.concat([Buffer.from([0xef, 0xbe, 0xad, 0xde, 0]), Buffer.from("NullsoftInst")]),
      ),
    );
    await expect(separated.verifyArtifact()).rejects.toThrow(
      `windows-package/artifact: installer is not an NSIS package: "${windowsPackageArtifactName(version)}"`,
    );
  });

  it("requires the retained application path explicitly", async () => {
    const fixture = await syntheticWindowsPackage();
    await expect(
      verifyWindowsPackage(fixture.artifact, "win-unpacked", { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(
      "windows-package/application-inventory: application path must be absolute",
    );
  });

  it("exposes only bounded stage-coded verification errors", async () => {
    const fixture = await syntheticWindowsPackage();
    await writeFile(join(fixture.application, "private-token.txt"), "private-token-marker");
    let error: unknown;
    try {
      await verifyWindowsPackageLayout(fixture.application, { desktopRoot: fixture.desktop });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WindowsPackageVerificationError);
    expect((error as WindowsPackageVerificationError).stage).toBe("application-inventory");
    expect((error as Error).message).not.toContain(fixture.application);
    expect((error as Error).message).not.toContain(fixture.desktop);
    expect((error as Error).message).not.toContain("private-token-marker");
  });
});
