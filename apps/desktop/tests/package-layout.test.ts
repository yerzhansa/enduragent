import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { DEVELOPMENT_PACKAGE_NAME } from "../scripts/development-package-plan.mjs";
import {
  KEYCHAIN_BINDING_ASAR_PATH,
  KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN,
  KEYCHAIN_BINDING_FUSE_CONFIGURATION,
} from "../scripts/package-inventory.mjs";
import { readBuilderAuthority, verifyPackageLayout } from "../scripts/verify-package-layout.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const sourceManifest = {
  name: "@enduragent/desktop",
  version: "0.0.1",
  main: "out/main/index.js",
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

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createSymlinkOrReturnWindowsCapabilityReason(
  target: string,
  path: string,
): Promise<string | undefined> {
  try {
    await symlink(target, path);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return `Windows symlink capability unavailable (${code})`;
    }
    throw error;
  }
}

function checksum(bytes: Buffer): Buffer {
  return Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  matrix.json\n`);
}

const stagedBindingUuid = "00112233445566778899aabbccddeeff";

function machoBundle(uuid: string, signatureBytes = 512, payload = "synthetic binding"): Buffer {
  const signatureOffset = 8_192;
  const bytes = Buffer.alloc(signatureOffset + signatureBytes);
  bytes.writeUInt32LE(0xfeed_facf, 0);
  bytes.writeUInt32LE(0x0100_000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(8, 12);
  bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(112, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  Buffer.from(uuid, "hex").copy(bytes, 40);
  bytes.writeUInt32LE(0x19, 56);
  bytes.writeUInt32LE(72, 60);
  bytes.write("__LINKEDIT", 64, "latin1");
  bytes.writeBigUInt64LE(BigInt(4_096 + signatureBytes), 88);
  bytes.writeBigUInt64LE(BigInt(4_096), 96);
  bytes.writeBigUInt64LE(BigInt(4_096 + signatureBytes), 104);
  bytes.writeUInt32LE(0x1d, 128);
  bytes.writeUInt32LE(16, 132);
  bytes.writeUInt32LE(signatureOffset, 136);
  bytes.writeUInt32LE(signatureBytes, 140);
  bytes.write(payload, 1_024, "latin1");
  bytes.fill(0x5a, signatureOffset);
  return bytes;
}

function builderYaml(
  asarSource = "dist/self-test-asar",
  externalSource = "dist/extra-resources",
): string {
  return [
    "appId: icu.enduragent.desktop",
    "productName: Enduragent",
    "asar: true",
    "asarUnpack:",
    `  - ${KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN}`,
    "electronFuses:",
    ...Object.entries(KEYCHAIN_BINDING_FUSE_CONFIGURATION).map(
      ([name, value]) => `  ${name}: ${String(value)}`,
    ),
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
    `  - from: ${asarSource}`,
    "    to: .",
    "extraResources:",
    `  - from: ${externalSource}`,
    "    to: .",
    "mac:",
    "  icon: resources/app-icon.png",
    "",
  ].join("\n");
}

type SyntheticPackage = {
  app: string;
  archiveSource: string;
  bindingPackaged: string;
  bindingSource: string;
  desktop: string;
  externalPackaged: string;
  externalSource: string;
  resources: string;
  rebuild: () => Promise<void>;
  writeArchive: (path: string, bytes?: string | Buffer) => Promise<void>;
};

async function syntheticPackage(): Promise<SyntheticPackage> {
  const root = await mkdtemp(join(tmpdir(), "desktop-package-layout-"));
  temporaryRoots.push(root);
  const desktop = join(root, "desktop");
  const app = join(root, "Synthetic.app");
  const resources = join(app, "Contents/Resources");
  const archiveSource = join(root, "archive-source");
  const asarSource = join(desktop, "dist/self-test-asar");
  const externalSource = join(desktop, "dist/extra-resources");
  const externalPackaged = join(resources, "self-test");
  const bindingSource = join(asarSource, KEYCHAIN_BINDING_ASAR_PATH);
  const bindingPackaged = join(
    resources,
    "app.asar.unpacked",
    KEYCHAIN_BINDING_ASAR_PATH,
  );
  const matrix = Buffer.from('{"schemaVersion":1}\n');
  const matrixChecksum = checksum(matrix);

  await Promise.all([
    mkdir(resources, { recursive: true }),
    mkdir(join(resources, "en.lproj"), { recursive: true }),
    mkdir(archiveSource, { recursive: true }),
    mkdir(join(asarSource, "resources/self-test"), { recursive: true }),
    mkdir(join(externalSource, "self-test"), { recursive: true }),
    mkdir(dirname(bindingSource), { recursive: true }),
    mkdir(desktop, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(bindingSource, machoBundle(stagedBindingUuid)),
    writeFile(join(desktop, "electron-builder.yml"), builderYaml()),
    writeFile(join(desktop, "package.json"), sourceManifestBytes),
    writeFile(join(resources, "icon.icns"), "synthetic icon"),
    writeFile(join(asarSource, "resources/self-test/matrix.json"), matrix),
    writeFile(join(asarSource, "resources/self-test/matrix.sha256"), matrixChecksum),
    writeFile(join(externalSource, "self-test/matrix.json"), matrix),
    writeFile(join(externalSource, "self-test/matrix.sha256"), matrixChecksum),
    writeFile(
      join(externalSource, "self-test/self-test-runner.cjs"),
      "module.exports = { runSelfTest() { return { ok: true }; } };\n",
    ),
  ]);

  const writeArchive = async (
    path: string,
    bytes: string | Buffer = "synthetic runtime\n",
  ): Promise<void> => {
    const target = join(archiveSource, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  await Promise.all([
    writeArchive("out/main/index.js"),
    writeArchive("out/main/daemon-utility.js"),
    writeArchive("out/preload/index.cjs"),
    writeArchive("out/preload/tray.cjs"),
    writeArchive("out/renderer/index.html", "<!doctype html>\n"),
    writeArchive("out/renderer/tray.html", "<!doctype html>\n"),
    writeArchive("package.json", sourceManifestBytes),
    writeArchive(KEYCHAIN_BINDING_ASAR_PATH, machoBundle(stagedBindingUuid)),
    writeArchive("resources/self-test/matrix.json", matrix),
    writeArchive("resources/self-test/matrix.sha256", matrixChecksum),
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
    await rm(join(resources, "app.asar"), { force: true });
    await rm(join(resources, "app.asar.unpacked"), { force: true, recursive: true });
    const archive = await createPackageWithOptions(archiveSource, join(resources, "app.asar"), {
      unpack: join(archiveSource, KEYCHAIN_BINDING_ASAR_PATH),
    });
    await finished(archive);
  };
  await rebuild();
  await cp(join(externalSource, "self-test"), externalPackaged, { recursive: true });
  return {
    app,
    archiveSource,
    bindingPackaged,
    bindingSource,
    desktop,
    externalPackaged,
    externalSource,
    resources,
    rebuild,
    writeArchive,
  };
}

describe("desktop package layout", () => {
  it("accepts the complete canonical package envelope", async () => {
    const fixture = await syntheticPackage();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it.each(["index.cjs", "tray.cjs"])(
    "rejects a sandboxed %s preload with a relative runtime dependency",
    async (preload) => {
      const fixture = await syntheticPackage();
      await fixture.writeArchive(`out/preload/${preload}`, 'require("./chunks/shared.cjs");\n');
      await fixture.rebuild();

      await expect(
        verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
      ).rejects.toThrow("sandboxed preload has a relative runtime dependency");
    },
  );

  it.each(telegramRuntimePackages.slice(1))(
    "rejects a missing Telegram runtime dependency entry for $name",
    async (runtimePackage) => {
      const fixture = await syntheticPackage();
      const entry = "entry" in runtimePackage ? runtimePackage.entry : runtimePackage.main;
      await rm(join(fixture.archiveSource, runtimePackage.root, entry));
      await fixture.rebuild();
      await expect(
        verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
      ).rejects.toThrow("Telegram runtime dependency entry is missing from ASAR");
    },
  );

  it("keeps ordinary packages byte-exact and updater-inert", async () => {
    const canonical = await syntheticPackage();
    const authored = {
      ...sourceManifest,
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "4.1.4" },
    };
    await writeFile(join(canonical.desktop, "package.json"), `${JSON.stringify(authored)}\n`);
    await canonical.writeArchive("package.json", JSON.stringify(sourceManifest, null, 2));
    await canonical.rebuild();
    await expect(
      verifyPackageLayout(canonical.app, { desktopRoot: canonical.desktop }),
    ).resolves.toBeUndefined();

    const manifestDrift = await syntheticPackage();
    await manifestDrift.writeArchive("package.json", JSON.stringify(sourceManifest, null, 2));
    await manifestDrift.rebuild();
    await expect(
      verifyPackageLayout(manifestDrift.app, { desktopRoot: manifestDrift.desktop }),
    ).rejects.toThrow("ordinary packaged manifest differs from source");

    const marked = await syntheticPackage();
    await marked.writeArchive(
      "package.json",
      `${JSON.stringify({ ...sourceManifest, enduragentDesktopRelease: true })}\n`,
    );
    await marked.rebuild();
    await expect(verifyPackageLayout(marked.app, { desktopRoot: marked.desktop })).rejects.toThrow(
      "ordinary packaged manifest differs from source",
    );

    const configured = await syntheticPackage();
    await writeFile(
      join(configured.resources, "app-update.yml"),
      "provider: generic\nurl: https://updates.example.test/stable/\n",
    );
    await expect(
      verifyPackageLayout(configured.app, { desktopRoot: configured.desktop }),
    ).rejects.toThrow("undeclared package resource");
  });

  it("accepts only the sealed development manifest overlay", async () => {
    const development = await syntheticPackage();
    await development.writeArchive(
      "package.json",
      JSON.stringify(
        {
          ...sourceManifest,
          name: DEVELOPMENT_PACKAGE_NAME,
          enduragentDesktopDevelopment: true,
        },
        null,
        2,
      ),
    );
    await development.rebuild();
    await expect(
      verifyPackageLayout(development.app, {
        desktopRoot: development.desktop,
        development: true,
      }),
    ).resolves.toBeUndefined();

    const production = await syntheticPackage();
    await expect(
      verifyPackageLayout(production.app, {
        desktopRoot: production.desktop,
        development: true,
      }),
    ).rejects.toThrow("development packaged manifest has unexpected drift");
  });

  it("accepts only the exact release manifest and app-update overlay", async () => {
    const version = "2026.7.2";
    const feedUrl = "https://updates.example.test/stable/";
    const fixture = await syntheticPackage();
    await writeFile(
      join(fixture.desktop, "package.json"),
      `${JSON.stringify({
        ...sourceManifest,
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "4.1.4" },
      })}\n`,
    );
    await fixture.writeArchive(
      "package.json",
      JSON.stringify(
        {
          ...sourceManifest,
          version,
          enduragentDesktopRelease: true,
        },
        null,
        2,
      ),
    );
    await fixture.rebuild();
    await writeFile(
      join(fixture.resources, "app-update.yml"),
      [
        "provider: generic",
        `url: ${feedUrl}`,
        "channel: latest",
        "updaterCacheDirName: '@enduragentdesktop-updater'",
        "",
      ].join("\n"),
    );
    await expect(
      verifyPackageLayout(fixture.app, {
        desktopRoot: fixture.desktop,
        release: { version, feedUrl },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects every third release manifest, updater, or resource difference", async () => {
    const version = "2026.7.2";
    const feedUrl = "https://updates.example.test/stable/";
    const manifestDrift = await syntheticPackage();
    await manifestDrift.writeArchive(
      "package.json",
      JSON.stringify(
        {
          ...sourceManifest,
          version,
          enduragentDesktopRelease: true,
          unexpected: true,
        },
        null,
        2,
      ),
    );
    await manifestDrift.rebuild();
    await writeFile(
      join(manifestDrift.resources, "app-update.yml"),
      [
        "provider: generic",
        `url: ${feedUrl}`,
        "channel: latest",
        "updaterCacheDirName: '@enduragentdesktop-updater'",
        "",
      ].join("\n"),
    );
    await expect(
      verifyPackageLayout(manifestDrift.app, {
        desktopRoot: manifestDrift.desktop,
        release: { version, feedUrl },
      }),
    ).rejects.toThrow("release packaged manifest has unexpected drift");

    const updaterDrift = await syntheticPackage();
    await updaterDrift.writeArchive(
      "package.json",
      JSON.stringify(
        {
          ...sourceManifest,
          version,
          enduragentDesktopRelease: true,
        },
        null,
        2,
      ),
    );
    await updaterDrift.rebuild();
    await writeFile(
      join(updaterDrift.resources, "app-update.yml"),
      [
        "provider: generic",
        "url: https://updates.example.test/other/",
        "channel: latest",
        "updaterCacheDirName: '@enduragentdesktop-updater'",
        "unexpected: true",
        "",
      ].join("\n"),
    );
    await expect(
      verifyPackageLayout(updaterDrift.app, {
        desktopRoot: updaterDrift.desktop,
        release: { version, feedUrl },
      }),
    ).rejects.toThrow("invalid release app-update.yml");

    const resourceDrift = await syntheticPackage();
    await resourceDrift.writeArchive(
      "package.json",
      JSON.stringify(
        {
          ...sourceManifest,
          version,
          enduragentDesktopRelease: true,
        },
        null,
        2,
      ),
    );
    await resourceDrift.rebuild();
    await Promise.all([
      writeFile(
        join(resourceDrift.resources, "app-update.yml"),
        [
          "provider: generic",
          `url: ${feedUrl}`,
          "channel: latest",
          "updaterCacheDirName: '@enduragentdesktop-updater'",
          "",
        ].join("\n"),
      ),
      writeFile(join(resourceDrift.resources, "stale-release.bin"), "stale\n"),
    ]);
    await expect(
      verifyPackageLayout(resourceDrift.app, {
        desktopRoot: resourceDrift.desktop,
        release: { version, feedUrl },
      }),
    ).rejects.toThrow("undeclared package resource");
  });

  it("uses the YAML-declared disjoint staging roots as authority", async () => {
    const fixture = await syntheticPackage();
    const alternateAsar = join(fixture.desktop, "dist/inside-authority");
    const alternateExternal = join(fixture.desktop, "dist/outside-authority");
    await Promise.all([
      rename(join(fixture.desktop, "dist/self-test-asar"), alternateAsar),
      rename(fixture.externalSource, alternateExternal),
    ]);
    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/inside-authority", "dist/outside-authority"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it("rejects overlapping or escaping YAML staging roots", async () => {
    const fixture = await syntheticPackage();
    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/self-test-asar", "dist/self-test-asar/nested"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder staging roots must be disjoint");

    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/self-test-asar", "../outside"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder source must be inside its output directory");
  });

  it.each(exclusions)("requires the builder exclusion %s", async (exclusion) => {
    const fixture = await syntheticPackage();
    const yaml = builderYaml().replace(`  - ${JSON.stringify(exclusion)}\n`, "");
    await writeFile(join(fixture.desktop, "electron-builder.yml"), yaml);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder file exclusions are incomplete");
  });

  it.each([
    [
      "top-level extraFiles",
      ["extraFiles:", "  - from: dist/extra-files", "    to: leaked.test.js", ""].join("\n"),
    ],
    [
      "mac.extraFiles",
      ["  extraFiles:", "    - from: dist/extra-files", "      to: leaked.test.js", ""].join("\n"),
    ],
  ])("rejects the alternate builder copy surface %s", async (_label, addition) => {
    const fixture = await syntheticPackage();
    await writeFile(join(fixture.desktop, "electron-builder.yml"), `${builderYaml()}${addition}`);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("alternate builder copy surfaces are forbidden");
  });

  it("validates the checked-in builder authority", async () => {
    await expect(readBuilderAuthority(desktopRoot)).resolves.toMatchObject({
      asarSourceRoot: join(desktopRoot, "dist/self-test-asar"),
      externalSourceRoot: join(desktopRoot, "dist/extra-resources"),
    });
  });

  it("requires the exact keychain binding unpack source", async () => {
    const fixture = await syntheticPackage();
    const yaml = builderYaml().replace(
      KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN,
      KEYCHAIN_BINDING_ASAR_PATH,
    );
    await writeFile(join(fixture.desktop, "electron-builder.yml"), yaml);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");
  });

  it("pins the sole audited Electron locale", async () => {
    const fixture = await syntheticPackage();
    const yaml = builderYaml().replace("electronLanguages:\n  - en-US\n", "");
    await writeFile(join(fixture.desktop, "electron-builder.yml"), yaml);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");

    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml().replace("  - en-US\n", "  - en-US\n  - fr\n"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");

    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml().replace("  - en-US\n", "  - en\n"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");
  });

  it.each([
    "debug.js.map",
    ".env.production",
    "test/helper.js",
    "tests/helper.js",
    "__tests__/helper.js",
    "__snapshots__/obsolete.md",
    "fixture/data.json",
    "fixtures/data.json",
    "dev-fixture/data.json",
    "dev-fixtures/data.json",
    "feature.test.js",
    "feature.spec.ts",
    "out/main/feature.test.d.ts",
    "out/main/feature.spec.d.mts",
    "out/main/index.test.tsx",
    "test.js",
    "spec.mjs",
    "node_modules/@enduragent/sport-cycling/vitest.config.ts",
    "node_modules/@enduragent/sport-cycling/vitest.workspace.mts",
    "node_modules/vitest/index.js",
    "node_modules/@vitest/runner/index.js",
  ])("rejects forbidden ASAR path %s", async (path) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(path);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(/forbidden/u);
  });

  it.each([
    "out/main/feature.test.js.snap",
    "out/main/feature.spec.ts.snap",
    "out/main/renderer.snap",
    "node_modules/@enduragent/sport-cycling/dist/plan.js.snap",
  ])("rejects the snapshot artifact at ASAR path %s", async (path) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(path);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("forbidden test snapshot artifact");
  });

  it("rejects a snapshot artifact staged as an external resource", async () => {
    const fixture = await syntheticPackage();
    await writeFile(join(fixture.externalPackaged, "matrix.test.js.snap"), "exports[`a`] = `b`;\n");
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("forbidden test snapshot artifact");
  });

  it.each([
    "node_modules/@modelcontextprotocol/sdk/dist/cjs/spec.types.js",
    "node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.js",
    "out/main/test.types.js",
    "out/main/test.helpers.js",
    "out/main/spec.helpers.d.ts",
    "out/main/snapshot.js",
    "out/main/snapshots/index.js",
  ])("keeps the published module %s packageable", async (path) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(path);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    "node_modules/@enduragent/engine/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/x.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude-code/cli.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
  ])("rejects the vendored agent CLI at ASAR path %s", async (path) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(path);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("forbidden vendored agent CLI");
  });

  it("keeps the agent SDK itself packageable", async () => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it("rejects a vendored agent CLI staged as an external resource", async () => {
    const fixture = await syntheticPackage();
    await mkdir(
      join(fixture.externalPackaged, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"),
      { recursive: true },
    );
    await writeFile(
      join(
        fixture.externalPackaged,
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      ),
      "synthetic runtime\n",
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("forbidden vendored agent CLI");
  });

  it("rejects forbidden paths in external and unpacked resources", async () => {
    const externalFixture = await syntheticPackage();
    await mkdir(join(externalFixture.externalPackaged, "fixture"), { recursive: true });
    await writeFile(join(externalFixture.externalPackaged, "fixture/private.json"), "{}\n");
    await expect(
      verifyPackageLayout(externalFixture.app, { desktopRoot: externalFixture.desktop }),
    ).rejects.toThrow("forbidden test or fixture directory");

    const unpackedFixture = await syntheticPackage();
    const unpackedTest = join(
      unpackedFixture.resources,
      "app.asar.unpacked/node_modules/@vitest/runner.js",
    );
    await mkdir(dirname(unpackedTest), { recursive: true });
    await writeFile(unpackedTest, "synthetic runtime\n");
    await expect(
      verifyPackageLayout(unpackedFixture.app, { desktopRoot: unpackedFixture.desktop }),
    ).rejects.toThrow("forbidden test or fixture directory");
  });

  it.each([
    "sentinel-anthropic-api-key",
    "sentinel-telegram-bot-token",
    "desktop-sentinel-model-key",
    "synthetic-secret",
    "obviously-fake-provider-key",
    "sk-SECRET",
    "private-token-marker",
  ])("rejects known synthetic plaintext secret marker %s", async (marker) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive("out/main/private-marker.js", marker);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");
  });

  it.each([
    "ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN",
    "ENDURAGENT_ACCEPTANCE_OS_LOGIN_LAUNCH",
  ])("rejects acceptance-only runtime marker %s from a canonical package", async (marker) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive("out/main/daemon-utility.js", marker);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("acceptance-only package marker");
  });

  it("rejects the acceptance ASAR metadata identity from a canonical package", async () => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(
      "package.json",
      `${JSON.stringify({
        ...sourceManifest,
        name: "enduragent-desktop-telegram-acceptance",
        enduragentDesktopTelegramAcceptance: true,
      })}\n`,
    );
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("acceptance-only package marker");
  });

  it("scans external and unpacked files for synthetic secret markers", async () => {
    const externalFixture = await syntheticPackage();
    await writeFile(
      join(externalFixture.externalPackaged, "matrix.json"),
      "sentinel-openai-api-key",
    );
    await expect(
      verifyPackageLayout(externalFixture.app, { desktopRoot: externalFixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");

    const unpackedFixture = await syntheticPackage();
    const nativeFile = join(unpackedFixture.resources, "app.asar.unpacked/native/addon.node");
    await mkdir(dirname(nativeFile), { recursive: true });
    await writeFile(nativeFile, "sentinel-intervals-api-key");
    await expect(
      verifyPackageLayout(unpackedFixture.app, { desktopRoot: unpackedFixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");
  });

  it("scans the packaged icon for synthetic secret markers", async () => {
    const fixture = await syntheticPackage();
    await writeFile(join(fixture.resources, "icon.icns"), "sentinel-google-generative-ai-api-key");
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");
  });

  it("allows only unpacked files declared by the ASAR header", async () => {
    const declared = await syntheticPackage();
    await declared.writeArchive("native/addon.node", "synthetic native bytes\n");
    await rm(join(declared.resources, "app.asar"));
    const archive = await createPackageWithOptions(
      declared.archiveSource,
      join(declared.resources, "app.asar"),
      { unpack: "**/*.node" },
    );
    await finished(archive);
    await expect(
      verifyPackageLayout(declared.app, { desktopRoot: declared.desktop }),
    ).resolves.toBeUndefined();

    const undeclared = await syntheticPackage();
    const stale = join(undeclared.resources, "app.asar.unpacked/native/addon.node");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "synthetic native bytes\n");
    await expect(
      verifyPackageLayout(undeclared.app, { desktopRoot: undeclared.desktop }),
    ).rejects.toThrow("undeclared unpacked resource");
  });

  it.each([
    "out/main/index.js",
    "out/main/daemon-utility.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    "out/renderer/tray.html",
    "package.json",
    "resources/self-test/matrix.json",
    "resources/self-test/matrix.sha256",
  ])("rejects missing required ASAR runtime %s", async (path) => {
    const fixture = await syntheticPackage();
    await rm(join(fixture.archiveSource, path));
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("required runtime file is missing from ASAR");
  });

  it("rejects stale ASAR staging bytes", async () => {
    const fixture = await syntheticPackage();
    const changedMatrix = Buffer.from('{"schemaVersion":2}\n');
    await fixture.writeArchive("resources/self-test/matrix.json", changedMatrix);
    await fixture.writeArchive("resources/self-test/matrix.sha256", checksum(changedMatrix));
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("ASAR staging bytes differ from source");
  });

  it("rejects missing, stale, and unexpected external staging", async () => {
    const missing = await syntheticPackage();
    await rm(join(missing.externalPackaged, "matrix.sha256"));
    await expect(
      verifyPackageLayout(missing.app, { desktopRoot: missing.desktop }),
    ).rejects.toThrow("packaged external resource tree differs from staging");

    const stale = await syntheticPackage();
    await writeFile(join(stale.externalPackaged, "self-test-runner.cjs"), "module.exports = {};\n");
    await expect(verifyPackageLayout(stale.app, { desktopRoot: stale.desktop })).rejects.toThrow(
      "packaged external resource bytes differ from staging",
    );

    const unexpected = await syntheticPackage();
    await writeFile(join(unexpected.externalPackaged, "unexpected.bin"), "unexpected\n");
    await expect(
      verifyPackageLayout(unexpected.app, { desktopRoot: unexpected.desktop }),
    ).rejects.toThrow("packaged external resource tree differs from staging");
  });

  it("rejects undeclared top-level resources", async () => {
    const fixture = await syntheticPackage();
    await writeFile(join(fixture.resources, "stale-resource.json"), "{}\n");
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("undeclared package resource");
  });

  it("rejects undeclared locale directories and locale symlinks", async ({ skip }) => {
    const undeclared = await syntheticPackage();
    await mkdir(join(undeclared.resources, "fr.lproj"));
    await expect(
      verifyPackageLayout(undeclared.app, { desktopRoot: undeclared.desktop }),
    ).rejects.toThrow("undeclared package resource");

    const linked = await syntheticPackage();
    await rm(join(linked.resources, "en.lproj"), { recursive: true });
    const symlinkCapabilityReason = await createSymlinkOrReturnWindowsCapabilityReason(
      linked.resources,
      join(linked.resources, "en.lproj"),
    );
    if (symlinkCapabilityReason) return skip(symlinkCapabilityReason);
    await expect(verifyPackageLayout(linked.app, { desktopRoot: linked.desktop })).rejects.toThrow(
      "symbolic links are forbidden",
    );
  });

  it("requires app.asar to be a regular nonsymlink file", async ({ skip }) => {
    const fixture = await syntheticPackage();
    const archive = join(fixture.resources, "app.asar");
    const target = join(dirname(fixture.app), "saved.asar");
    await rename(archive, target);
    const symlinkCapabilityReason = await createSymlinkOrReturnWindowsCapabilityReason(
      target,
      archive,
    );
    if (symlinkCapabilityReason) return skip(symlinkCapabilityReason);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");
  });

  it("recursively rejects external and unpacked symlinks", async ({ skip }) => {
    const external = await syntheticPackage();
    const externalSymlinkCapabilityReason = await createSymlinkOrReturnWindowsCapabilityReason(
      join(external.externalPackaged, "matrix.json"),
      join(external.externalPackaged, "matrix-link.json"),
    );
    if (externalSymlinkCapabilityReason) return skip(externalSymlinkCapabilityReason);
    await expect(
      verifyPackageLayout(external.app, { desktopRoot: external.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");

    const unpacked = await syntheticPackage();
    const unpackedRoot = join(unpacked.resources, "app.asar.unpacked");
    await mkdir(unpackedRoot, { recursive: true });
    const unpackedSymlinkCapabilityReason = await createSymlinkOrReturnWindowsCapabilityReason(
      unpackedRoot,
      join(unpackedRoot, "loop"),
    );
    if (unpackedSymlinkCapabilityReason) return skip(unpackedSymlinkCapabilityReason);
    await expect(
      verifyPackageLayout(unpacked.app, { desktopRoot: unpacked.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");
  });

  it("accepts a packaged keychain binding re-signed after ASAR staging", async () => {
    const fixture = await syntheticPackage();
    await writeFile(fixture.bindingPackaged, machoBundle(stagedBindingUuid, 4_096));
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["built from a different image", machoBundle("ffeeddccbbaa99887766554433221100")],
    ["patched outside its code signature", machoBundle(stagedBindingUuid, 4_096, "patched")],
  ])("rejects a packaged keychain binding %s", async (_label, replacement) => {
    const fixture = await syntheticPackage();
    await writeFile(fixture.bindingPackaged, replacement);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("packaged keychain binding differs from staging");
  });

  it("rejects a packaged keychain binding that is not a Mach-O bundle", async () => {
    const fixture = await syntheticPackage();
    await writeFile(fixture.bindingPackaged, Buffer.alloc(8_192, 0x61));
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("expected a 64-bit little-endian Mach-O bundle");
  });

  it("rejects a keychain binding built as MH_EXECUTE instead of MH_BUNDLE", async () => {
    const fixture = await syntheticPackage();
    const executable = machoBundle(stagedBindingUuid);
    executable.writeUInt32LE(2, 12);
    await writeFile(fixture.bindingPackaged, executable);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("unsupported Mach-O bundle architecture");
  });

  it("rejects a package that stages no keychain binding source", async () => {
    const fixture = await syntheticPackage();
    await rm(fixture.bindingSource);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("keychain binding staging source is missing");
  });

  it("rejects a package whose ASAR declares no unpacked keychain binding", async () => {
    const fixture = await syntheticPackage();
    await rm(join(fixture.archiveSource, KEYCHAIN_BINDING_ASAR_PATH));
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("declared keychain binding is missing or packed");
  });

  it("rejects the retired external keychain helper", async () => {
    const fixture = await syntheticPackage();
    const retiredSource = join(fixture.externalSource, "keychain/keychain-helper");
    const retiredPackaged = join(fixture.resources, "keychain/keychain-helper");
    await Promise.all([
      mkdir(dirname(retiredSource), { recursive: true }),
      mkdir(dirname(retiredPackaged), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(retiredSource, "retired helper\n"),
      writeFile(retiredPackaged, "retired helper\n"),
    ]);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("forbidden retired keychain helper");
  });

  it("keeps the external runner out of app.asar", async () => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(
      "resources/self-test/self-test-runner.cjs",
      "module.exports = {};\n",
    );
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("self-test runner must remain external");
  });

  it("redacts absolute roots and secret contents from bounded errors", async () => {
    const fixture = await syntheticPackage();
    const marker = "sentinel-openrouter-api-key";
    await fixture.writeArchive("out/main/private.js", marker);
    await fixture.rebuild();
    let message = "";
    try {
      await verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("app.asar/out/main/private.js");
    expect(message.length).toBeLessThanOrEqual(256);
    expect(message).not.toContain(fixture.app);
    expect(message).not.toContain(fixture.desktop);
    expect(message).not.toContain(marker);
    expect(message).not.toContain(process.env.HOME ?? "unreachable-home");
  });

  it("rejects relative application paths before filesystem access", async () => {
    await expect(verifyPackageLayout("dist/Enduragent.app")).rejects.toThrow(
      "application path must be one absolute .app path",
    );
  });
});
