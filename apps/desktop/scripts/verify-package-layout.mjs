import { isAbsolute, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMacosReleaseUpdaterMetadata,
  requireGenericFeedUrl,
  requireStableSemVer,
} from "./macos-release-plan.mjs";
import {
  DEVELOPMENT_PACKAGE_NAME,
  createDevelopmentPackagePlan,
} from "./development-package-plan.mjs";
import {
  KEYCHAIN_BINDING_ASAR_PATH,
  PackageLayoutError,
  assertDirectory,
  assertExactResourceNames,
  assertNoReservedResourceNames,
  assertRegularFile,
  collectAsar,
  collectTree,
  compareAsarStaging,
  compareStagedTree,
  exactObject,
  fail,
  inspectContents,
  machoBundleIdentity,
  readBuilderConfiguration,
  safeLstat,
  safeReadDirectory,
  safeReadFile,
  validateBuilderInventoryAuthority,
  validateRequiredAsarFiles,
  validateUnpackedTree,
} from "./package-inventory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const canonicalApplication = createDevelopmentPackagePlan({
  desktopRoot: canonicalDesktopRoot,
}).applicationPath;
const reservedResourceNames = new Set([
  "app.asar",
  "app.asar.unpacked",
  "app-update.yml",
  "icon.icns",
  "en.lproj",
]);
export async function readBuilderAuthority(desktopRoot = canonicalDesktopRoot) {
  const config = await readBuilderConfiguration(desktopRoot);
  return validateBuilderInventoryAuthority(config, desktopRoot, {
    validateEnvelopeAuthority: (value) =>
      exactObject(value.mac) && value.mac.icon === "resources/app-icon.png",
    hasEnvelopeExtraFiles: (value) => exactObject(value.mac) && value.mac.extraFiles !== undefined,
  });
}

function validateAppUpdate(bytes, release) {
  let update;
  try {
    update = parseMacosReleaseUpdaterMetadata(bytes);
  } catch {
    fail("invalid release app-update.yml", "Contents/Resources/app-update.yml");
  }
  if (update.url !== release.feedUrl) {
    fail("invalid release app-update.yml", "Contents/Resources/app-update.yml");
  }
}

async function validateResourceEnvelope(resourcesRoot, externalSource, release) {
  const names = (await safeReadDirectory(resourcesRoot, "Contents/Resources")).sort();
  const sourceTopLevel = assertNoReservedResourceNames(
    externalSource,
    reservedResourceNames,
    "dist/extra-resources",
  );
  const expected = new Set(["app.asar", "icon.icns", "en.lproj", ...sourceTopLevel]);
  if (release !== undefined) expected.add("app-update.yml");
  if (names.includes("app.asar.unpacked")) expected.add("app.asar.unpacked");
  assertExactResourceNames(names, expected, "Contents/Resources");

  const iconPath = join(resourcesRoot, "icon.icns");
  const iconLabel = "Contents/Resources/icon.icns";
  const iconStat = await safeLstat(iconPath, iconLabel);
  assertRegularFile(iconStat, iconLabel);
  inspectContents(await safeReadFile(iconPath, iconLabel), iconLabel);
  await collectTree(join(resourcesRoot, "en.lproj"), "Contents/Resources/en.lproj", true);
  if (release !== undefined) {
    const updatePath = join(resourcesRoot, "app-update.yml");
    const updateLabel = "Contents/Resources/app-update.yml";
    const updateStat = await safeLstat(updatePath, updateLabel);
    assertRegularFile(updateStat, updateLabel);
    const updateBytes = await safeReadFile(updatePath, updateLabel);
    inspectContents(updateBytes, updateLabel);
    validateAppUpdate(updateBytes, release);
  }
}

export async function verifyPackageLayout(application, options = {}) {
  if (!isAbsolute(application) || !application.endsWith(".app")) {
    fail("application path must be one absolute .app path");
  }
  const desktopRoot = options.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) fail("desktop root must be absolute");
  const development = options.development === true;
  if (options.development !== undefined && options.development !== true) {
    fail("invalid development package-layout option");
  }
  let release;
  if (options.release !== undefined) {
    if (
      !exactObject(options.release) ||
      Object.keys(options.release).length !== 2 ||
      !Object.hasOwn(options.release, "version") ||
      !Object.hasOwn(options.release, "feedUrl")
    ) {
      fail("invalid release package-layout options");
    }
    release = {
      version: requireStableSemVer(options.release.version),
      feedUrl: requireGenericFeedUrl(options.release.feedUrl),
    };
  }
  if (development && release !== undefined) {
    fail("package layout cannot be both development and release");
  }

  try {
    const applicationStat = await safeLstat(application, "Enduragent.app");
    assertDirectory(applicationStat, "Enduragent.app");
    const contentsRoot = join(application, "Contents");
    const contentsStat = await safeLstat(contentsRoot, "Contents");
    assertDirectory(contentsStat, "Contents");
    const resourcesRoot = join(contentsRoot, "Resources");
    const resourcesStat = await safeLstat(resourcesRoot, "Contents/Resources");
    assertDirectory(resourcesStat, "Contents/Resources");

    const authority = await readBuilderAuthority(desktopRoot);
    const [asarStaging, externalSource, sourceManifest] = await Promise.all([
      collectTree(authority.asarSourceRoot, "dist/ASAR-staging", false),
      collectTree(authority.externalSourceRoot, "dist/extra-resources", false),
      safeReadFile(join(desktopRoot, "package.json"), "package.json"),
    ]);
    await validateResourceEnvelope(resourcesRoot, externalSource, release);

    const archivePath = join(resourcesRoot, "app.asar");
    const archiveStat = await safeLstat(archivePath, "Contents/Resources/app.asar");
    assertRegularFile(archiveStat, "Contents/Resources/app.asar");
    const asar = collectAsar(archivePath, {
      archiveLabel: "Contents/Resources/app.asar",
      entryLabelRoot: "app.asar",
    });
    validateRequiredAsarFiles(asar, sourceManifest, {
      macos: true,
      release,
      development,
      developmentPackageName: DEVELOPMENT_PACKAGE_NAME,
    });
    compareAsarStaging(asarStaging, asar);

    const externalPackaged = new Map();
    for (const topLevel of new Set([...externalSource.keys()].map((path) => path.split("/")[0]))) {
      const subtree = await collectTree(
        join(resourcesRoot, topLevel),
        `Contents/Resources/${topLevel}`,
        true,
      );
      externalPackaged.set(topLevel, { type: "directory" });
      for (const [path, entry] of subtree) {
        externalPackaged.set(`${topLevel}/${path}`, entry);
      }
    }
    compareStagedTree(externalSource, externalPackaged, "Contents/Resources");
    const runner = externalPackaged.get("self-test/self-test-runner.cjs");
    if (runner === undefined || runner.type !== "file") {
      fail(
        "external self-test runner is missing",
        "Contents/Resources/self-test/self-test-runner.cjs",
      );
    }
    const unpackedPresent = (await safeReadDirectory(resourcesRoot, "Contents/Resources")).includes(
      "app.asar.unpacked",
    );
    await validateUnpackedTree(join(resourcesRoot, "app.asar.unpacked"), asar, unpackedPresent, {
      root: "Contents/Resources/app.asar.unpacked",
      entries: "app.asar.unpacked",
    });
    const stagedBinding = asarStaging.get(KEYCHAIN_BINDING_ASAR_PATH);
    if (stagedBinding === undefined || stagedBinding.type !== "file") {
      fail(
        "keychain binding staging source is missing",
        `dist/ASAR-staging/${KEYCHAIN_BINDING_ASAR_PATH}`,
      );
    }
    const bindingPath = join(resourcesRoot, "app.asar.unpacked", KEYCHAIN_BINDING_ASAR_PATH);
    const bindingLabel = `Contents/Resources/app.asar.unpacked/${KEYCHAIN_BINDING_ASAR_PATH}`;
    const bindingStat = await safeLstat(bindingPath, bindingLabel);
    assertRegularFile(bindingStat, bindingLabel);
    const stagedIdentity = machoBundleIdentity(stagedBinding.bytes, bindingLabel);
    const packagedIdentity = machoBundleIdentity(
      await safeReadFile(bindingPath, bindingLabel),
      bindingLabel,
    );
    if (
      stagedIdentity.uuid !== packagedIdentity.uuid ||
      stagedIdentity.contentSha256 !== packagedIdentity.contentSha256 ||
      stagedIdentity.cpuType !== packagedIdentity.cpuType ||
      stagedIdentity.cpuSubtype !== packagedIdentity.cpuSubtype ||
      stagedIdentity.fileType !== packagedIdentity.fileType
    ) {
      fail("packaged keychain binding differs from staging", bindingLabel);
    }
  } catch (error) {
    if (error instanceof PackageLayoutError) throw error;
    fail("package layout verification failed");
  }
}

function applicationArgument(args) {
  if (args.length === 0) return canonicalApplication;
  if (args.length !== 1 || !isAbsolute(args[0]) || !args[0].endsWith(".app")) {
    fail("expected zero arguments or one absolute .app path");
  }
  return args[0];
}

async function main() {
  try {
    const arguments_ = process.argv.slice(2);
    await verifyPackageLayout(applicationArgument(arguments_), {
      development: arguments_.length === 0 ? true : undefined,
    });
    process.stdout.write("package layout verified\n");
  } catch (error) {
    const message =
      error instanceof PackageLayoutError ? error.message : "package layout verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
