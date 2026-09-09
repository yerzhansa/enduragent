import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { WINDOWS_LOCALE_PAK_PATHS } from "./package-locales.mjs";
import {
  PackageLayoutError,
  assertDirectory,
  collectAsar,
  collectTree,
  compareAsarStaging,
  exactObject,
  inspectContents,
  inspectPath,
  readBuilderConfiguration,
  safeLstat,
  safeReadFile,
  validateBuilderInventoryAuthority,
  validateRequiredAsarFiles,
  validateUnpackedTree,
} from "./package-inventory.mjs";
import {
  WINDOWS_PACKAGE_APP_ID,
  WINDOWS_PACKAGE_ARCH,
  WINDOWS_PACKAGE_GUID,
  WINDOWS_PACKAGE_INSTALLER_LANGUAGES,
  WINDOWS_PACKAGE_PRODUCT_NAME,
  WINDOWS_PACKAGE_TARGET,
  createWindowsPackagePlan,
  readWindowsDesktopVersion,
  windowsPackageArtifactName,
} from "./windows-package-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const canonicalInstallerHook = [
  "!macro customUnInstall",
  '  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "icu.enduragent.desktop"',
  '  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "icu.enduragent.desktop"',
  "!macroend",
  "",
].join("\n");
const expectedWindowsRuntime = new Set([
  "Enduragent.exe",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "ffmpeg.dll",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "locales",
  "resources",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
]);
const expectedWindowsLocales = WINDOWS_LOCALE_PAK_PATHS;
const expectedAsarResourceFiles = new Set([
  "resources/tray.ico",
  "resources/trayTemplate.png",
  "resources/trayTemplate@2x.png",
]);
const forbiddenNativeExtensions = new Set([".dylib", ".node", ".so"]);
const x64PeMachine = 0x8664;
const x86PeMachine = 0x014c;
const nsisOverlaySignature = Buffer.concat([
  Buffer.from([0xef, 0xbe, 0xad, 0xde]),
  Buffer.from("NullsoftInst", "latin1"),
]);

export const WINDOWS_PACKAGE_VERIFICATION_STAGES = Object.freeze([
  "artifact",
  "installer-contract",
  "application-inventory",
  "resource-inventory",
  "asar-inventory",
  "binary-platform",
]);

export class WindowsPackageVerificationError extends Error {
  constructor(stage, message, paths = []) {
    const listed = [...new Set(paths)].sort().map((path) => JSON.stringify(path));
    const suffix = listed.length === 0 ? "" : `: ${listed.join(", ")}`;
    super(`windows-package/${stage}: ${message}${suffix}`);
    this.name = "WindowsPackageVerificationError";
    this.stage = stage;
    this.paths = Object.freeze([...new Set(paths)].sort());
  }
}

function failWindows(stage, message, paths) {
  throw new WindowsPackageVerificationError(stage, message, paths);
}

export function safeWindowsPackageVerificationMessage(error) {
  return error instanceof WindowsPackageVerificationError ? error.message : undefined;
}

function expectedWindowsConfiguration() {
  return {
    icon: "resources/app-icon.ico",
    signExecutable: false,
    requestedExecutionLevel: "asInvoker",
    files: ["resources/tray.ico"],
    target: [{ target: WINDOWS_PACKAGE_TARGET, arch: [WINDOWS_PACKAGE_ARCH] }],
  };
}

function expectedNsisConfiguration() {
  return {
    artifactName: "Enduragent-${version}-x64.${ext}",
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
  };
}

export async function readWindowsBuilderAuthority(desktopRoot = canonicalDesktopRoot) {
  let config;
  try {
    config = await readBuilderConfiguration(desktopRoot);
  } catch (error) {
    if (error instanceof PackageLayoutError) {
      failWindows("installer-contract", error.message);
    }
    throw error;
  }
  if (
    !exactObject(config) ||
    config.appId !== WINDOWS_PACKAGE_APP_ID ||
    config.productName !== WINDOWS_PACKAGE_PRODUCT_NAME ||
    !isDeepStrictEqual(config.win, expectedWindowsConfiguration()) ||
    !isDeepStrictEqual(config.nsis, expectedNsisConfiguration())
  ) {
    failWindows("installer-contract", "builder identity is invalid", ["electron-builder.yml"]);
  }
  let authority;
  try {
    authority = validateBuilderInventoryAuthority(config, desktopRoot, {
      validateEnvelopeAuthority: (value) =>
        isDeepStrictEqual(value.win, expectedWindowsConfiguration()) &&
        isDeepStrictEqual(value.nsis, expectedNsisConfiguration()),
      hasEnvelopeExtraFiles: (value) =>
        exactObject(value.win) && value.win.extraFiles !== undefined,
    });
  } catch (error) {
    if (error instanceof PackageLayoutError) {
      failWindows("installer-contract", error.message);
    }
    throw error;
  }
  const hookPath = join(desktopRoot, "build/installer.nsh");
  let hook;
  try {
    hook = await safeReadFile(hookPath, "build/installer.nsh");
  } catch (error) {
    if (error instanceof PackageLayoutError) {
      failWindows("installer-contract", error.message);
    }
    throw error;
  }
  if (hook.toString("utf8").replaceAll("\r\n", "\n") !== canonicalInstallerHook) {
    failWindows("installer-contract", "uninstall hook is invalid", ["build/installer.nsh"]);
  }
  return Object.freeze({
    ...authority,
    applicationSourceRoot: join(desktopRoot, "out"),
    installerHookPath: hookPath,
  });
}

function topLevelNames(tree) {
  return new Set([...tree.keys()].map((path) => path.split("/")[0]));
}

function validateRuntimeEntryTypes(tree) {
  for (const name of expectedWindowsRuntime) {
    const entry = tree.get(name);
    const expectedType = name === "locales" || name === "resources" ? "directory" : "file";
    if (entry === undefined || entry.type !== expectedType) {
      failWindows("application-inventory", "application entry type is invalid", [name]);
    }
  }
}

function validateRuntimeLocales(tree) {
  const missing = expectedWindowsLocales.filter((expected) => {
    const locale = tree.get(expected);
    return (
      locale === undefined ||
      locale.type !== "file" ||
      !Buffer.isBuffer(locale.bytes) ||
      locale.bytes.length === 0
    );
  });
  if (missing.length > 0) {
    failWindows("application-inventory", "missing locale", missing);
  }
  const undeclared = [...tree.keys()].filter(
    (path) => path.startsWith("locales/") && !expectedWindowsLocales.includes(path),
  );
  if (undeclared.length > 0) {
    failWindows("application-inventory", "undeclared locale", undeclared);
  }
}

function exactNameSet(actual, expected, stage, label) {
  const unexpected = [...actual].filter((path) => !expected.has(path));
  if (unexpected.length > 0) failWindows(stage, `undeclared ${label}`, unexpected);
  const missing = [...expected].filter((path) => !actual.has(path));
  if (missing.length > 0) failWindows(stage, `missing ${label}`, missing);
}

function compareExactTrees(expected, actual, stage, label) {
  const expectedPaths = new Set(expected.keys());
  const actualPaths = new Set(actual.keys());
  const unexpected = [...actualPaths].filter((path) => !expectedPaths.has(path));
  if (unexpected.length > 0) failWindows(stage, `undeclared ${label}`, unexpected);
  const missing = [...expectedPaths].filter((path) => !actualPaths.has(path));
  if (missing.length > 0) failWindows(stage, `missing ${label}`, missing);
  for (const path of expectedPaths) {
    const expectedEntry = expected.get(path);
    const actualEntry = actual.get(path);
    if (expectedEntry.type !== actualEntry.type) {
      failWindows(stage, `${label} type differs`, [path]);
    }
    if (
      expectedEntry.type === "file" &&
      (!Buffer.isBuffer(actualEntry.bytes) || !expectedEntry.bytes.equals(actualEntry.bytes))
    ) {
      failWindows(stage, `${label} bytes differ`, [path]);
    }
  }
}

function packageRootForManifest(path) {
  if (!/(?:^|\/)node_modules\/(?:@[^/]+\/[^/]+|[^/]+)\/package\.json$/u.test(path)) {
    return undefined;
  }
  return path.slice(0, -"/package.json".length);
}

function packageNameFromRoot(root) {
  const segments = root.split("/");
  const nodeModules = segments.lastIndexOf("node_modules");
  const first = segments[nodeModules + 1];
  return first.startsWith("@") ? `${first}/${segments[nodeModules + 2]}` : first;
}

function deepestRuntimePackageRoot(path) {
  const segments = path.split("/");
  let root;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "node_modules") continue;
    const name = segments[index + 1];
    if (name === undefined) continue;
    const end = name.startsWith("@") ? index + 3 : index + 2;
    if (end > segments.length) continue;
    root = segments.slice(0, end).join("/");
  }
  return root;
}

function parseRuntimeManifest(entry, path) {
  if (entry === undefined || entry.type !== "file" || !Buffer.isBuffer(entry.bytes)) {
    failWindows("asar-inventory", "runtime package manifest is invalid", [path]);
  }
  let manifest;
  try {
    manifest = JSON.parse(entry.bytes.toString("utf8"));
  } catch {
    failWindows("asar-inventory", "runtime package manifest is invalid", [path]);
  }
  if (!exactObject(manifest)) {
    failWindows("asar-inventory", "runtime package manifest is invalid", [path]);
  }
  return manifest;
}

function dependencyNames(manifest, path) {
  const names = new Set();
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (!exactObject(value)) {
      failWindows("asar-inventory", "runtime dependency declaration is invalid", [path]);
    }
    for (const name of Object.keys(value)) names.add(name);
  }
  return names;
}

function resolveRuntimeRoot(roots, importerRoot, packageName) {
  let directory = importerRoot;
  while (true) {
    const candidate =
      directory.length === 0
        ? `node_modules/${packageName}`
        : `${directory}/node_modules/${packageName}`;
    if (roots.has(candidate)) return candidate;
    const separator = directory.lastIndexOf("/");
    if (separator < 0) {
      if (directory.length === 0) return undefined;
      directory = "";
    } else {
      directory = directory.slice(0, separator);
    }
  }
}

function validateRuntimePackageClosure(asar) {
  const roots = new Map();
  for (const [path, entry] of asar) {
    const root = packageRootForManifest(path);
    if (root === undefined) continue;
    const manifest = parseRuntimeManifest(entry, path);
    if (manifest.name !== packageNameFromRoot(root)) {
      failWindows("asar-inventory", "runtime package identity is invalid", [path]);
    }
    roots.set(root, manifest);
  }
  const application = parseRuntimeManifest(asar.get("package.json"), "app.asar/package.json");
  const visited = new Set();
  const visit = (importerRoot, packageName) => {
    const root = resolveRuntimeRoot(roots, importerRoot, packageName);
    if (root === undefined || visited.has(root)) return;
    visited.add(root);
    const manifest = roots.get(root);
    for (const dependency of dependencyNames(manifest, `${root}/package.json`)) {
      visit(root, dependency);
    }
  };
  for (const dependency of dependencyNames(application, "app.asar/package.json")) {
    visit("", dependency);
  }
  const unexpected = [...roots.keys()]
    .filter((root) => !visited.has(root))
    .map((root) => `${root}/package.json`);
  if (unexpected.length > 0) {
    failWindows("asar-inventory", "undeclared runtime package", unexpected);
  }
  return new Set(roots.keys());
}

function peMetadata(bytes, path, stage) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    failWindows(stage, "invalid Windows executable", [path]);
  }
  const header = bytes.readUInt32LE(0x3c);
  if (
    header + 24 > bytes.length ||
    bytes[header] !== 0x50 ||
    bytes[header + 1] !== 0x45 ||
    bytes[header + 2] !== 0 ||
    bytes[header + 3] !== 0
  ) {
    failWindows(stage, "invalid Windows executable", [path]);
  }
  const machine = bytes.readUInt16LE(header + 4);
  const optionalSize = bytes.readUInt16LE(header + 20);
  const optional = header + 24;
  if (optional + optionalSize > bytes.length || optionalSize < 2) {
    failWindows(stage, "invalid Windows executable", [path]);
  }
  const magic = bytes.readUInt16LE(optional);
  const directory = magic === 0x010b ? optional + 96 : magic === 0x020b ? optional + 112 : -1;
  if (directory < 0 || directory + 40 > optional + optionalSize) {
    failWindows(stage, "invalid Windows executable", [path]);
  }
  return {
    machine,
    certificateOffset: bytes.readUInt32LE(directory + 32),
    certificateSize: bytes.readUInt32LE(directory + 36),
  };
}

function nativeMagic(bytes) {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return "ELF";
  }
  const magic = bytes.readUInt32BE(0);
  if (
    [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
      0xbfbafeca,
    ].includes(magic)
  ) {
    return "Mach-O";
  }
  return bytes[0] === 0x4d && bytes[1] === 0x5a ? "PE" : undefined;
}

function validateApplicationBinaries(tree) {
  for (const [path, entry] of tree) {
    if (entry.type !== "file") continue;
    const extension = extname(path).toLowerCase();
    const magic = nativeMagic(entry.bytes);
    if (forbiddenNativeExtensions.has(extension) || magic === "ELF" || magic === "Mach-O") {
      failWindows("binary-platform", "unexpected native package", [path]);
    }
    if (extension === ".exe" || extension === ".dll" || magic === "PE") {
      if (extension !== ".exe" && extension !== ".dll") {
        failWindows("binary-platform", "undeclared Windows binary", [path]);
      }
      if (peMetadata(entry.bytes, path, "binary-platform").machine !== x64PeMachine) {
        failWindows("binary-platform", "wrong-platform binary", [path]);
      }
    }
  }
  const executable = tree.get(`${WINDOWS_PACKAGE_PRODUCT_NAME}.exe`);
  if (executable === undefined || executable.type !== "file") {
    failWindows("binary-platform", "application executable is invalid", [
      `${WINDOWS_PACKAGE_PRODUCT_NAME}.exe`,
    ]);
  }
  const source = executable.bytes.toString("utf8");
  if (
    !source.includes('requestedExecutionLevel level="asInvoker" uiAccess="false"') ||
    source.includes('requestedExecutionLevel level="highestAvailable"') ||
    source.includes('requestedExecutionLevel level="requireAdministrator"')
  ) {
    failWindows("binary-platform", "application execution level is invalid", [
      `${WINDOWS_PACKAGE_PRODUCT_NAME}.exe`,
    ]);
  }
  return x64PeMachine;
}

function applicationEvidence(tree, peMachine) {
  const manifest = createHash("sha256");
  let fileCount = 0;
  let directoryCount = 0;
  for (const path of [...tree.keys()].sort()) {
    const entry = tree.get(path);
    if (entry.type === "directory") {
      directoryCount += 1;
      manifest.update(`${JSON.stringify({ path, type: entry.type })}\n`);
      continue;
    }
    fileCount += 1;
    manifest.update(
      `${JSON.stringify({
        path,
        type: entry.type,
        size: entry.bytes.length,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      })}\n`,
    );
  }
  return Object.freeze({
    fileCount,
    directoryCount,
    manifestSha256: manifest.digest("hex"),
    peMachine,
  });
}

function asarNativeEntries(asar) {
  const rejected = [];
  for (const [path, entry] of asar) {
    if (entry.type !== "file") continue;
    const extension = extname(path).toLowerCase();
    const magic = Buffer.isBuffer(entry.bytes) ? nativeMagic(entry.bytes) : undefined;
    if (
      forbiddenNativeExtensions.has(extension) ||
      extension === ".dll" ||
      extension === ".exe" ||
      magic !== undefined
    ) {
      rejected.push(`app.asar/${path}`);
    }
  }
  return rejected;
}

function validateAsarDeclaration(asar, packageRoots, applicationSource, asarStaging) {
  const allowed = new Set(["package.json"]);
  for (const path of applicationSource.keys()) allowed.add(`out/${path}`);
  for (const path of asarStaging.keys()) allowed.add(path);
  for (const path of expectedAsarResourceFiles) allowed.add(path);
  for (const path of asar.keys()) {
    const packageRoot = deepestRuntimePackageRoot(path);
    if (packageRoot !== undefined && packageRoots.has(packageRoot)) allowed.add(path);
  }
  for (const path of allowed) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      allowed.add(segments.slice(0, index).join("/"));
    }
  }
  const unexpected = [...asar.keys()].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    failWindows(
      "asar-inventory",
      "undeclared ASAR entry",
      unexpected.map((path) => `app.asar/${path}`),
    );
  }
}

async function verifyResources(resourcesRoot, authority, desktopRoot) {
  let resources;
  let externalSource;
  let asarStaging;
  let applicationSource;
  let sourceManifest;
  try {
    [resources, externalSource, asarStaging, applicationSource, sourceManifest] = await Promise.all(
      [
        collectTree(resourcesRoot, "resources", false),
        collectTree(authority.externalSourceRoot, "dist/extra-resources", false),
        collectTree(authority.asarSourceRoot, "dist/ASAR-staging", false),
        collectTree(authority.applicationSourceRoot, "out", false),
        safeReadFile(join(desktopRoot, "package.json"), "package.json"),
      ],
    );
    for (const [path, entry] of resources) {
      if (path === "app.asar") continue;
      inspectPath(path, `resources/${path}`);
      if (entry.type === "file") inspectContents(entry.bytes, `resources/${path}`);
    }
    const packagedEnvelope = new Map(
      [...resources].filter(
        ([path]) => path !== "app.asar.unpacked" && !path.startsWith("app.asar.unpacked/"),
      ),
    );
    const expectedResources = new Map(externalSource);
    expectedResources.set("app.asar", { type: "file", bytes: resources.get("app.asar")?.bytes });
    compareExactTrees(
      expectedResources,
      packagedEnvelope,
      "resource-inventory",
      "package resource",
    );
  } catch (error) {
    if (error instanceof WindowsPackageVerificationError) throw error;
    if (error instanceof PackageLayoutError) {
      failWindows("resource-inventory", error.message);
    }
    failWindows("resource-inventory", "resource verification failed");
  }
  try {
    const archive = join(resourcesRoot, "app.asar");
    const asar = collectAsar(archive, {
      archiveLabel: "resources/app.asar",
      entryLabelRoot: "app.asar",
    });
    await validateUnpackedTree(
      join(resourcesRoot, "app.asar.unpacked"),
      asar,
      resources.has("app.asar.unpacked"),
      { root: "resources/app.asar.unpacked", entries: "app.asar.unpacked" },
    );
    const runtimeAsar = new Map(
      [...asar].map(([path, entry]) => {
        if (entry.type !== "file" || entry.unpacked !== true) return [path, entry];
        const unpacked = resources.get(`app.asar.unpacked/${path}`);
        return [path, unpacked?.type === "file" ? { ...entry, bytes: unpacked.bytes } : entry];
      }),
    );
    validateRequiredAsarFiles(asar, sourceManifest);
    compareAsarStaging(asarStaging, asar);
    for (const [path, entry] of applicationSource) {
      const packaged = asar.get(`out/${path}`);
      if (
        packaged === undefined ||
        packaged.type !== entry.type ||
        packaged.unpacked === true ||
        (entry.type === "file" &&
          (!Buffer.isBuffer(packaged.bytes) || !entry.bytes.equals(packaged.bytes)))
      ) {
        failWindows("asar-inventory", "application output differs from staging", [
          `app.asar/out/${path}`,
        ]);
      }
    }
    for (const path of expectedAsarResourceFiles) {
      const sourcePath = join(desktopRoot, path);
      const source = await safeReadFile(sourcePath, path);
      const packaged = asar.get(path);
      if (
        packaged === undefined ||
        packaged.type !== "file" ||
        packaged.unpacked === true ||
        !Buffer.isBuffer(packaged.bytes) ||
        !source.equals(packaged.bytes)
      ) {
        failWindows("asar-inventory", "runtime resource differs from source", [`app.asar/${path}`]);
      }
    }
    const nativeEntries = asarNativeEntries(runtimeAsar);
    if (nativeEntries.length > 0) {
      failWindows("binary-platform", "unexpected native package", nativeEntries);
    }
    const packageRoots = validateRuntimePackageClosure(runtimeAsar);
    validateAsarDeclaration(runtimeAsar, packageRoots, applicationSource, asarStaging);
  } catch (error) {
    if (error instanceof WindowsPackageVerificationError) throw error;
    if (error instanceof PackageLayoutError) {
      failWindows("asar-inventory", error.message);
    }
    failWindows("asar-inventory", "ASAR verification failed");
  }
}

export async function verifyWindowsPackageLayout(application, options = {}) {
  if (!isAbsolute(application)) {
    failWindows("application-inventory", "application path must be absolute");
  }
  const desktopRoot = options.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) {
    failWindows("installer-contract", "desktop root must be absolute");
  }
  try {
    const metadata = await safeLstat(application, "win-unpacked");
    assertDirectory(metadata, "win-unpacked");
    const tree = await collectTree(application, "win-unpacked", false);
    exactNameSet(
      topLevelNames(tree),
      expectedWindowsRuntime,
      "application-inventory",
      "application entry",
    );
    validateRuntimeEntryTypes(tree);
    validateRuntimeLocales(tree);
    for (const [path, entry] of tree) {
      if (path === "resources" || path.startsWith("resources/")) continue;
      inspectPath(path, `win-unpacked/${path}`);
      if (entry.type === "file") inspectContents(entry.bytes, `win-unpacked/${path}`);
    }
    const authority = await readWindowsBuilderAuthority(desktopRoot);
    await verifyResources(join(application, "resources"), authority, desktopRoot);
    const peMachine = validateApplicationBinaries(tree);
    return applicationEvidence(tree, peMachine);
  } catch (error) {
    if (error instanceof WindowsPackageVerificationError) throw error;
    if (error instanceof PackageLayoutError) {
      failWindows("application-inventory", error.message);
    }
    failWindows("application-inventory", "package layout verification failed");
  }
}

function validateInstallerArtifact(bytes, path) {
  const metadata = peMetadata(bytes, path, "artifact");
  if (![x86PeMachine, x64PeMachine].includes(metadata.machine)) {
    failWindows("artifact", "installer is not a Windows executable", [path]);
  }
  if (metadata.certificateOffset !== 0 || metadata.certificateSize !== 0) {
    failWindows("artifact", "installer must be unsigned", [path]);
  }
  if (!bytes.includes(nsisOverlaySignature)) {
    failWindows("artifact", "installer is not an NSIS package", [path]);
  }
  return metadata;
}

export async function verifyWindowsPackage(artifact, application, options = {}, overrides = {}) {
  if (!isAbsolute(artifact) || extname(artifact).toLowerCase() !== ".exe") {
    failWindows("artifact", "artifact path must be one absolute .exe path");
  }
  if (!isAbsolute(application)) {
    failWindows("application-inventory", "application path must be absolute");
  }
  const desktopRoot = options.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) failWindows("installer-contract", "desktop root must be absolute");
  const version = await readWindowsDesktopVersion(
    { desktopRoot },
    { readFile: overrides.readVersionFile },
  ).catch(() => failWindows("installer-contract", "desktop package manifest is invalid"));
  const expectedName = windowsPackageArtifactName(version);
  if (basename(artifact) !== expectedName) {
    failWindows("artifact", "artifact name is invalid", [basename(artifact)]);
  }
  let stat;
  try {
    stat = await (overrides.lstat ?? lstat)(artifact);
  } catch {
    failWindows("artifact", "artifact is missing", [expectedName]);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    failWindows("artifact", "artifact is invalid", [expectedName]);
  }
  const artifactBytes = await (overrides.readFile ?? readFile)(artifact).catch(() =>
    failWindows("artifact", "artifact is unreadable", [expectedName]),
  );
  try {
    inspectContents(artifactBytes, expectedName);
  } catch (error) {
    if (error instanceof PackageLayoutError) {
      failWindows("artifact", error.message, [expectedName]);
    }
    throw error;
  }
  const metadata = validateInstallerArtifact(artifactBytes, expectedName);
  const applicationResult = await verifyWindowsPackageLayout(application, { desktopRoot });
  return Object.freeze({
    artifact: Object.freeze({
      name: expectedName,
      size: artifactBytes.length,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      peMachine: metadata.machine,
      nsisEnvelope: true,
    }),
    application: applicationResult,
  });
}

async function packageArguments(args) {
  if (args.length === 0) {
    const plan = await createWindowsPackagePlan();
    return { artifact: plan.artifactPath, application: plan.applicationPath };
  }
  if (
    args.length !== 2 ||
    !isAbsolute(args[0]) ||
    extname(args[0]).toLowerCase() !== ".exe" ||
    !isAbsolute(args[1])
  ) {
    failWindows("artifact", "expected zero arguments or absolute artifact and application paths");
  }
  return { artifact: args[0], application: args[1] };
}

async function main() {
  try {
    const input = await packageArguments(process.argv.slice(2));
    const evidence = await verifyWindowsPackage(input.artifact, input.application);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    process.stderr.write(
      `${safeWindowsPackageVerificationMessage(error) ?? "Windows package verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
