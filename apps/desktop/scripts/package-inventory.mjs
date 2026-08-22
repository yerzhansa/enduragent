import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { parse } from "yaml";
import { contained } from "./package-plan.mjs";

export { contained } from "./package-plan.mjs";

export const KEYCHAIN_BINDING_ASAR_PATH = "native/keychain-binding.node";
export const KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN =
  `dist/self-test-asar/${KEYCHAIN_BINDING_ASAR_PATH}`;
export const KEYCHAIN_BINDING_FUSE_CONFIGURATION = Object.freeze({
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
});

const requiredAsarFiles = [
  "out/main/index.js",
  "out/main/daemon-utility.js",
  "out/preload/index.cjs",
  "out/preload/tray.cjs",
  "out/renderer/index.html",
  "out/renderer/tray.html",
  "package.json",
  "resources/self-test/matrix.json",
  "resources/self-test/matrix.sha256",
];
const telegramRuntimeRoots = ["grammy", "@grammyjs/auto-retry"];
const requiredFilePatterns = [
  "out/**",
  "package.json",
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
const vendoredAgentCliPatterns = [
  /(?:^|\/)@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+(?:\/|$)/u,
  /(?:^|\/)@anthropic-ai\/claude-agent-sdk\/(?:.*\/)?(?:vendor\/|claude$|cli\.js$)/u,
];
const forbiddenDirectoryNames = new Set([
  "test",
  "tests",
  "__tests__",
  "__snapshots__",
  "fixture",
  "fixtures",
  "dev-fixture",
  "dev-fixtures",
  "vitest",
  "@vitest",
]);
const knownSecretMarkers = [
  "desktop-sentinel-model-key",
  "private-token-marker",
  "sentinel-anthropic-api-key",
  "sentinel-openai-api-key",
  "sentinel-google-generative-ai-api-key",
  "sentinel-deepseek-api-key",
  "sentinel-alibaba-api-key",
  "sentinel-minimax-api-key",
  "sentinel-moonshot-api-key",
  "sentinel-zai-api-key",
  "sentinel-openrouter-api-key",
  "sentinel-llm-api-key",
  "sentinel-intervals-api-key",
  "sentinel-telegram-bot-token",
  "sentinel-my-llm-key",
  "synthetic-secret",
];
const acceptanceOnlyMarkers = [
  "enduragent_acceptance_telegram_bot_api_origin",
  "enduragent_acceptance_os_login_launch",
  "enduragent-desktop-telegram-acceptance",
  "enduragentdesktoptelegramacceptance",
];
const MACH_O_HEADER_BYTES = 32;
const MACH_O_64_LITTLE_ENDIAN_MAGIC = 0xfeed_facf;
const MACH_O_ARM64_CPU_TYPE = 0x0100_000c;
const MACH_O_EXECUTE_FILE_TYPE = 0x2;
const MACH_O_BUNDLE_FILE_TYPE = 0x8;
const MACH_O_UUID_COMMAND = 0x1b;
const MACH_O_UUID_COMMAND_BYTES = 24;
const MACH_O_SEGMENT_64_COMMAND = 0x19;
const MACH_O_SEGMENT_64_COMMAND_BYTES = 72;
const MACH_O_CODE_SIGNATURE_COMMAND = 0x1d;
const MACH_O_CODE_SIGNATURE_COMMAND_BYTES = 16;
const MACH_O_LINK_EDIT_SEGMENT = "__LINKEDIT";
const MACH_O_MAXIMUM_LOAD_COMMANDS = 1_024;
const MINIMUM_MACH_O_EXECUTABLE_BYTES = 4_096;
const MAXIMUM_MACH_O_EXECUTABLE_BYTES = 8_388_608;
const removedMainManifestKeys = new Set([
  "dist",
  "gitHead",
  "build",
  "jspm",
  "ava",
  "xo",
  "nyc",
  "eslintConfig",
  "contributors",
  "bundleDependencies",
  "tags",
  "scripts",
  "keywords",
  "devDependencies",
]);

export class PackageLayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageLayoutError";
  }
}

function displayPath(path) {
  const printable = Array.from(String(path).replaceAll("\\", "/"), (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127) ? "?" : character;
  }).join("");
  const normalized = printable.replace(/^\/+/u, "");
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

export function fail(message, path) {
  const suffix = path === undefined ? "" : `: ${displayPath(path)}`;
  throw new PackageLayoutError(`${message}${suffix}`);
}

export function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nested(left, right) {
  return left !== right && contained(left, right);
}

export async function safeLstat(path, label) {
  try {
    return await lstat(path);
  } catch {
    fail("missing or unreadable package entry", label);
  }
}

export async function safeReadFile(path, label) {
  try {
    return await readFile(path);
  } catch {
    fail("missing or unreadable package file", label);
  }
}

export async function safeReadDirectory(path, label) {
  try {
    return await readdir(path);
  } catch {
    fail("missing or unreadable package directory", label);
  }
}

export function assertRegularFile(stat, label) {
  if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
  if (!stat.isFile()) fail("expected a regular file", label);
}

export function assertDirectory(stat, label) {
  if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
  if (!stat.isDirectory()) fail("expected a directory", label);
}

export function validateRelativePath(path, label) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\u0000") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("invalid relative package path", label);
  }
  return normalized;
}

export function forbiddenPathReason(path) {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1) ?? "";
  if (base === "keychain-helper" || segments.includes("keychain-helper")) {
    return "retired keychain helper";
  }
  if (vendoredAgentCliPatterns.some((pattern) => pattern.test(lower))) return "vendored agent CLI";
  if (base.endsWith(".map")) return "source map";
  if (base.startsWith(".env")) return "environment file";
  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    return "test or fixture directory";
  }
  if (base.endsWith(".snap")) return "test snapshot artifact";
  if (/(?:^|\.)(?:test|spec)\.(?:d\.)?[a-z0-9]+$/u.test(base)) return "test or spec source";
  if (/^vitest\.(?:config|workspace)\./u.test(base)) return "Vitest configuration";
  return undefined;
}

export function inspectPath(path, label) {
  const reason = forbiddenPathReason(path);
  if (reason !== undefined) fail(`forbidden ${reason}`, label);
}

export function inspectContents(bytes, label) {
  const text = bytes.toString("latin1").toLowerCase();
  if (acceptanceOnlyMarkers.some((marker) => text.includes(marker))) {
    fail("acceptance-only package marker", label);
  }
  if (
    knownSecretMarkers.some((marker) => text.includes(marker)) ||
    /obviously-fake-[a-z0-9-]{1,96}key\b/u.test(text) ||
    /(?:^|[^a-z0-9])sk-secret(?:[^a-z0-9]|$)/u.test(text)
  ) {
    fail("known plaintext secret marker", label);
  }
}

function machoIdentity(bytes, label, expectedFileType, kind) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < MINIMUM_MACH_O_EXECUTABLE_BYTES ||
    bytes.length > MAXIMUM_MACH_O_EXECUTABLE_BYTES ||
    bytes.readUInt32LE(0) !== MACH_O_64_LITTLE_ENDIAN_MAGIC
  ) {
    fail(`expected a 64-bit little-endian Mach-O ${kind}`, label);
  }
  const cpuType = bytes.readUInt32LE(4);
  const cpuSubtype = bytes.readUInt32LE(8);
  const fileType = bytes.readUInt32LE(12);
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandEnd = MACH_O_HEADER_BYTES + commandBytes;
  if (cpuType !== MACH_O_ARM64_CPU_TYPE || fileType !== expectedFileType) {
    fail(`unsupported Mach-O ${kind} architecture`, label);
  }
  if (
    commandCount === 0 ||
    commandCount > MACH_O_MAXIMUM_LOAD_COMMANDS ||
    commandBytes < 8 ||
    commandEnd > bytes.length
  ) {
    fail("invalid Mach-O load commands", label);
  }
  let offset = MACH_O_HEADER_BYTES;
  let uuid;
  let linkEditCommand;
  let signatureCommand;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandEnd) fail("invalid Mach-O load commands", label);
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > commandEnd) {
      fail("invalid Mach-O load commands", label);
    }
    if (command === MACH_O_UUID_COMMAND) {
      if (size !== MACH_O_UUID_COMMAND_BYTES || uuid !== undefined) {
        fail("invalid Mach-O image identifier", label);
      }
      uuid = bytes.subarray(offset + 8, offset + MACH_O_UUID_COMMAND_BYTES).toString("hex");
    }
    if (
      command === MACH_O_SEGMENT_64_COMMAND &&
      size === MACH_O_SEGMENT_64_COMMAND_BYTES &&
      bytes.subarray(offset + 8, offset + 24).toString("latin1").replace(/\0+$/u, "") ===
        MACH_O_LINK_EDIT_SEGMENT
    ) {
      if (linkEditCommand !== undefined) fail("invalid Mach-O link edit segment", label);
      linkEditCommand = offset;
    }
    if (command === MACH_O_CODE_SIGNATURE_COMMAND) {
      if (size !== MACH_O_CODE_SIGNATURE_COMMAND_BYTES || signatureCommand !== undefined) {
        fail("invalid Mach-O code signature", label);
      }
      signatureCommand = offset;
    }
    offset += size;
  }
  if (offset !== commandEnd || uuid === undefined) {
    fail("invalid Mach-O image identifier", label);
  }
  if (linkEditCommand === undefined) fail("invalid Mach-O link edit segment", label);
  if (signatureCommand === undefined) fail("invalid Mach-O code signature", label);
  const signatureOffset = bytes.readUInt32LE(signatureCommand + 8);
  const signatureBytes = bytes.readUInt32LE(signatureCommand + 12);
  if (
    signatureOffset < commandEnd ||
    signatureBytes === 0 ||
    signatureOffset + signatureBytes !== bytes.length
  ) {
    fail("invalid Mach-O code signature", label);
  }
  const content = Buffer.from(bytes.subarray(0, signatureOffset));
  content.fill(0, linkEditCommand + 32, linkEditCommand + 40);
  content.fill(0, linkEditCommand + 48, linkEditCommand + 56);
  content.fill(0, signatureCommand + 8, signatureCommand + MACH_O_CODE_SIGNATURE_COMMAND_BYTES);
  return {
    cpuType,
    cpuSubtype,
    fileType,
    uuid,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function machoExecutableIdentity(bytes, label) {
  return machoIdentity(bytes, label, MACH_O_EXECUTE_FILE_TYPE, "executable");
}

export function machoBundleIdentity(bytes, label) {
  return machoIdentity(bytes, label, MACH_O_BUNDLE_FILE_TYPE, "bundle");
}

function fileSet(value) {
  if (!exactObject(value) || typeof value.from !== "string" || typeof value.to !== "string") {
    fail("invalid builder FileSet");
  }
  return value;
}

export function outputChild(desktopRoot, outputRoot, source, label) {
  if (isAbsolute(source)) fail("builder source must be relative", label);
  const resolved = resolve(desktopRoot, source);
  if (resolved === outputRoot || !contained(outputRoot, resolved)) {
    fail("builder source must be inside its output directory", label);
  }
  return resolved;
}

export async function readBuilderConfiguration(desktopRoot) {
  if (!isAbsolute(desktopRoot)) fail("desktop root must be absolute");
  const bytes = await safeReadFile(
    join(desktopRoot, "electron-builder.yml"),
    "electron-builder.yml",
  );
  try {
    return parse(bytes.toString("utf8"));
  } catch {
    fail("invalid builder configuration", "electron-builder.yml");
  }
}

export function validateBuilderInventoryAuthority(config, desktopRoot, options = {}) {
  const validateEnvelopeAuthority = options.validateEnvelopeAuthority ?? (() => true);
  const hasEnvelopeExtraFiles = options.hasEnvelopeExtraFiles ?? (() => false);
  if (
    !exactObject(config) ||
    config.asar !== true ||
    !Array.isArray(config.electronLanguages) ||
    config.electronLanguages.length !== 1 ||
    config.electronLanguages[0] !== "en-US" ||
    !exactObject(config.directories) ||
    config.directories.output !== "dist" ||
    !Array.isArray(config.files) ||
    !Array.isArray(config.extraResources) ||
    !Array.isArray(config.asarUnpack) ||
    config.asarUnpack.length !== 1 ||
    config.asarUnpack[0] !== KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN ||
    !isDeepStrictEqual(config.electronFuses, KEYCHAIN_BINDING_FUSE_CONFIGURATION) ||
    validateEnvelopeAuthority(config) !== true
  ) {
    fail("invalid builder packaging authority", "electron-builder.yml");
  }
  if (config.extraFiles !== undefined || hasEnvelopeExtraFiles(config)) {
    fail("alternate builder copy surfaces are forbidden", "electron-builder.yml");
  }

  const patternEntries = config.files.filter((entry) => typeof entry === "string");
  if (
    patternEntries.length !== requiredFilePatterns.length ||
    new Set(patternEntries).size !== patternEntries.length ||
    requiredFilePatterns.some((pattern) => !patternEntries.includes(pattern))
  ) {
    fail("builder file exclusions are incomplete", "electron-builder.yml");
  }

  const configuredFileSets = config.files.filter((entry) => typeof entry !== "string").map(fileSet);
  const resourceSets = configuredFileSets.filter(
    (entry) => entry.from === "resources" && entry.to === "resources",
  );
  if (
    resourceSets.length !== 1 ||
    !Array.isArray(resourceSets[0].filter) ||
    resourceSets[0].filter.length !== 2 ||
    !resourceSets[0].filter.includes("trayTemplate.png") ||
    !resourceSets[0].filter.includes("trayTemplate@2x.png")
  ) {
    fail("builder runtime resources are incomplete", "electron-builder.yml");
  }
  const asarSets = configuredFileSets.filter((entry) => entry.to === ".");
  if (configuredFileSets.length !== 2 || asarSets.length !== 1) {
    fail("builder ASAR staging authority is ambiguous", "electron-builder.yml");
  }
  if (Object.keys(asarSets[0]).some((key) => !["from", "to"].includes(key))) {
    fail("builder ASAR staging authority is filtered", "electron-builder.yml");
  }
  if (config.extraResources.length !== 1) {
    fail("builder external staging authority is ambiguous", "electron-builder.yml");
  }
  const externalSet = fileSet(config.extraResources[0]);
  if (
    externalSet.to !== "." ||
    Object.keys(externalSet).some((key) => !["from", "to"].includes(key))
  ) {
    fail("builder external staging authority is filtered", "electron-builder.yml");
  }

  const outputRoot = resolve(desktopRoot, "dist");
  const asarSourceRoot = outputChild(
    desktopRoot,
    outputRoot,
    asarSets[0].from,
    "electron-builder.yml/files",
  );
  const externalSourceRoot = outputChild(
    desktopRoot,
    outputRoot,
    externalSet.from,
    "electron-builder.yml/extraResources",
  );
  if (
    asarSourceRoot === externalSourceRoot ||
    nested(asarSourceRoot, externalSourceRoot) ||
    nested(externalSourceRoot, asarSourceRoot)
  ) {
    fail("builder staging roots must be disjoint", "electron-builder.yml");
  }
  return { asarSourceRoot, externalSourceRoot };
}

export async function collectTree(root, labelRoot, scan) {
  const rootStat = await safeLstat(root, labelRoot);
  assertDirectory(rootStat, labelRoot);
  const tree = new Map();

  async function visit(directory, relativeRoot) {
    const names = (await safeReadDirectory(directory, labelRoot)).sort();
    for (const name of names) {
      const relativePath = validateRelativePath(
        relativeRoot.length === 0 ? name : `${relativeRoot}/${name}`,
        labelRoot,
      );
      const label = `${labelRoot}/${relativePath}`;
      if (scan) inspectPath(relativePath, label);
      const absolutePath = join(directory, name);
      const stat = await safeLstat(absolutePath, label);
      if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
      if (stat.isDirectory()) {
        tree.set(relativePath, { type: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) fail("unsupported package entry type", label);
      const bytes = await safeReadFile(absolutePath, label);
      if (scan) inspectContents(bytes, label);
      tree.set(relativePath, { type: "file", bytes });
    }
  }

  await visit(root, "");
  return tree;
}

function safeAsarList(archivePath, archiveLabel) {
  try {
    return listPackage(archivePath);
  } catch {
    fail("invalid ASAR archive", archiveLabel);
  }
}

function safeAsarStat(archivePath, listedPath, entryLabelRoot) {
  const path = listedPath.replace(/^[/\\]+/u, "");
  try {
    return statFile(archivePath, path, false);
  } catch {
    fail("invalid ASAR entry", `${entryLabelRoot}/${path}`);
  }
}

function safeAsarExtract(archivePath, listedPath, entryLabelRoot) {
  const path = listedPath.replace(/^[/\\]+/u, "");
  try {
    return extractFile(archivePath, path, false);
  } catch {
    fail("unreadable ASAR entry", `${entryLabelRoot}/${path}`);
  }
}

export function collectAsar(archivePath, options) {
  uncache(archivePath);
  const tree = new Map();
  for (const listedPath of safeAsarList(archivePath, options.archiveLabel)) {
    const path = validateRelativePath(listedPath, options.archiveLabel);
    if (tree.has(path)) fail("duplicate ASAR entry", `${options.entryLabelRoot}/${path}`);
    const label = `${options.entryLabelRoot}/${path}`;
    inspectPath(path, label);
    const metadata = safeAsarStat(archivePath, listedPath, options.entryLabelRoot);
    if ("link" in metadata) fail("symbolic links are forbidden", label);
    if ("files" in metadata) {
      tree.set(path, { type: "directory", unpacked: metadata.unpacked === true });
      continue;
    }
    let bytes;
    if (metadata.unpacked !== true) {
      bytes = safeAsarExtract(archivePath, listedPath, options.entryLabelRoot);
      inspectContents(bytes, label);
    }
    tree.set(path, { type: "file", unpacked: metadata.unpacked === true, bytes });
  }
  return tree;
}

export async function validateUnpackedTree(unpackedRoot, asar, present, labels) {
  const expected = new Map();
  for (const [path, entry] of asar) {
    if (entry.type !== "file" || entry.unpacked !== true) continue;
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expected.set(segments.slice(0, index).join("/"), { type: "directory" });
    }
    expected.set(path, { type: "file" });
  }
  if (!present) {
    if (expected.size > 0) {
      fail("declared unpacked resources are missing", labels.root);
    }
    return;
  }
  const actual = await collectTree(unpackedRoot, labels.root, true);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    fail("undeclared unpacked resource", labels.root);
  }
  for (const path of expectedPaths) {
    if (expected.get(path).type !== actual.get(path).type) {
      fail("unpacked resource type differs from ASAR", `${labels.entries}/${path}`);
    }
  }
}

export function compareStagedTree(expected, actual, actualRoot, options = {}) {
  const signedExecutables = new Set(options.signedExecutables ?? []);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    fail("packaged external resource tree differs from staging", actualRoot);
  }
  for (const path of expectedPaths) {
    const expectedEntry = expected.get(path);
    const actualEntry = actual.get(path);
    if (expectedEntry.type !== actualEntry.type) {
      fail("packaged external resource type differs from staging", `${actualRoot}/${path}`);
    }
    if (expectedEntry.type !== "file") continue;
    if (signedExecutables.has(path)) {
      const staged = machoExecutableIdentity(expectedEntry.bytes, `${actualRoot}/${path}`);
      const packaged = machoExecutableIdentity(actualEntry.bytes, `${actualRoot}/${path}`);
      if (
        staged.uuid !== packaged.uuid ||
        staged.contentSha256 !== packaged.contentSha256 ||
        staged.cpuType !== packaged.cpuType ||
        staged.cpuSubtype !== packaged.cpuSubtype ||
        staged.fileType !== packaged.fileType
      ) {
        fail("packaged external executable differs from staging", `${actualRoot}/${path}`);
      }
      continue;
    }
    if (!expectedEntry.bytes.equals(actualEntry.bytes)) {
      fail("packaged external resource bytes differ from staging", `${actualRoot}/${path}`);
    }
  }
}

export function compareAsarStaging(expected, asar) {
  for (const [path, expectedEntry] of expected) {
    const actualEntry = asar.get(path);
    if (
      actualEntry === undefined ||
      actualEntry.type !== expectedEntry.type ||
      (expectedEntry.type === "file" &&
        actualEntry.unpacked !== (path === KEYCHAIN_BINDING_ASAR_PATH))
    ) {
      fail("ASAR staging entry is missing or unpacked", `app.asar/${path}`);
    }
    if (
      path !== KEYCHAIN_BINDING_ASAR_PATH &&
      expectedEntry.type === "file" &&
      (!Buffer.isBuffer(actualEntry.bytes) || !expectedEntry.bytes.equals(actualEntry.bytes))
    ) {
      fail("ASAR staging bytes differ from source", `app.asar/${path}`);
    }
  }
}

export function parseManifest(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("packaged manifest is invalid", label);
  }
  if (!exactObject(manifest) || manifest.main !== "out/main/index.js") {
    fail("packaged manifest has an invalid main entry", label);
  }
  return manifest;
}

function asarRuntimeFile(asar, path) {
  const entry = asar.get(path);
  return entry !== undefined && entry.type === "file" && entry.unpacked !== true
    ? entry
    : undefined;
}

function resolveRuntimePackageRoot(asar, importerRoot, packageName) {
  let directory = importerRoot;
  while (true) {
    const candidate =
      directory.length === 0
        ? `node_modules/${packageName}`
        : `${directory}/node_modules/${packageName}`;
    if (asarRuntimeFile(asar, `${candidate}/package.json`) !== undefined) return candidate;
    const separator = directory.lastIndexOf("/");
    if (separator < 0) {
      if (directory.length === 0) break;
      directory = "";
    } else {
      directory = directory.slice(0, separator);
    }
  }
  fail("Telegram runtime dependency is missing from ASAR", packageName);
}

function runtimePackageEntry(manifest, packageName) {
  const candidate = typeof manifest.main === "string" ? manifest.main : undefined;
  if (candidate === undefined || candidate.length === 0) {
    fail("Telegram runtime dependency has no main entry", packageName);
  }
  const normalized = candidate.replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("Telegram runtime dependency has an invalid main entry", packageName);
  }
  return normalized;
}

function validateTelegramRuntimeClosure(asar) {
  const coreRoot = "node_modules/@enduragent/core";
  if (asarRuntimeFile(asar, `${coreRoot}/package.json`) === undefined) {
    fail("Telegram runtime host is missing from ASAR", "@enduragent/core");
  }
  const visited = new Set();
  const visit = (importerRoot, packageName) => {
    const packageRoot = resolveRuntimePackageRoot(asar, importerRoot, packageName);
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    const manifestEntry = asarRuntimeFile(asar, `${packageRoot}/package.json`);
    let manifest;
    try {
      manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
    } catch {
      fail("Telegram runtime dependency manifest is invalid", packageName);
    }
    if (!exactObject(manifest) || manifest.name !== packageName) {
      fail("Telegram runtime dependency manifest is invalid", packageName);
    }
    const entry = runtimePackageEntry(manifest, packageName);
    const candidates = [entry, `${entry}.js`, `${entry}/index.js`];
    if (!candidates.some((path) => asarRuntimeFile(asar, `${packageRoot}/${path}`) !== undefined)) {
      fail("Telegram runtime dependency entry is missing from ASAR", packageName);
    }
    if (manifest.dependencies === undefined) return;
    if (!exactObject(manifest.dependencies)) {
      fail("Telegram runtime dependency manifest is invalid", packageName);
    }
    for (const dependency of Object.keys(manifest.dependencies)) visit(packageRoot, dependency);
  };
  for (const packageName of telegramRuntimeRoots) visit(coreRoot, packageName);
}

function validateSandboxedPreloads(asar) {
  for (const path of ["out/preload/index.cjs", "out/preload/tray.cjs"]) {
    const source = asarRuntimeFile(asar, path).bytes.toString("utf8");
    if (/\b(?:require|import)\s*\(\s*["']\.\.?\//u.test(source)) {
      fail("sandboxed preload has a relative runtime dependency", `app.asar/${path}`);
    }
  }
}

export function validateManifest(asar, sourceBytes, options = {}) {
  const packagedBytes = asar.get("package.json").bytes;
  const source = parseManifest(sourceBytes, "package.json");
  const packaged = parseManifest(packagedBytes, "app.asar/package.json");
  if (Object.hasOwn(source, "enduragentDesktopRelease")) {
    fail("source manifest contains a release marker", "package.json");
  }
  if (Object.hasOwn(source, "enduragentDesktopDevelopment")) {
    fail("source manifest contains a development marker", "package.json");
  }
  const expected = structuredClone(source);
  if (options.release !== undefined) {
    expected.version = options.release.version;
    expected.enduragentDesktopRelease = true;
  }
  if (options.development === true) {
    expected.name = options.developmentPackageName;
    expected.enduragentDesktopDevelopment = true;
  }
  let transformed = options.release !== undefined || options.development === true;
  for (const key of Object.keys(expected)) {
    if (key.startsWith("_") || removedMainManifestKeys.has(key)) {
      delete expected[key];
      transformed = true;
    }
  }
  if (
    exactObject(expected.dependencies) &&
    !Object.keys(expected.dependencies).some((key) => key.startsWith("babel")) &&
    Object.hasOwn(expected, "babel")
  ) {
    delete expected.babel;
    transformed = true;
  }
  const expectedBytes = transformed ? Buffer.from(JSON.stringify(expected, null, 2)) : sourceBytes;
  if (!expectedBytes.equals(packagedBytes) || !isDeepStrictEqual(packaged, expected)) {
    if (options.development === true) {
      fail("development packaged manifest has unexpected drift", "app.asar/package.json");
    }
    if (options.release === undefined) {
      fail("ordinary packaged manifest differs from source", "app.asar/package.json");
    }
    fail("release packaged manifest has unexpected drift", "app.asar/package.json");
  }
}

export function validateRequiredAsarFiles(asar, sourceManifest, options = {}) {
  for (const path of requiredAsarFiles) {
    const entry = asar.get(path);
    if (entry === undefined || entry.type !== "file" || entry.unpacked === true) {
      fail("required runtime file is missing from ASAR", `app.asar/${path}`);
    }
  }
  for (const path of asar.keys()) {
    if (path.split("/").at(-1) === "self-test-runner.cjs") {
      fail("self-test runner must remain external", `app.asar/${path}`);
    }
  }
  const binding = asar.get(KEYCHAIN_BINDING_ASAR_PATH);
  if (options.macos === true) {
    if (binding === undefined || binding.type !== "file" || binding.unpacked !== true) {
      fail(
        "declared keychain binding is missing or packed",
        `app.asar/${KEYCHAIN_BINDING_ASAR_PATH}`,
      );
    }
  } else if (binding !== undefined) {
    fail(
      "macOS keychain binding is forbidden on this platform",
      `app.asar/${KEYCHAIN_BINDING_ASAR_PATH}`,
    );
  }

  validateManifest(asar, sourceManifest, options);
  validateTelegramRuntimeClosure(asar);
  validateSandboxedPreloads(asar);

  const matrix = asar.get("resources/self-test/matrix.json").bytes;
  const checksum = asar.get("resources/self-test/matrix.sha256").bytes;
  const expectedChecksum = `${createHash("sha256").update(matrix).digest("hex")}  matrix.json\n`;
  if (checksum.toString("utf8") !== expectedChecksum) {
    fail("self-test checksum does not match its matrix", "app.asar/resources/self-test");
  }
}

export function assertNoReservedResourceNames(tree, reservedNames, label) {
  const topLevelNames = new Set([...tree.keys()].map((path) => path.split("/")[0]));
  for (const name of topLevelNames) {
    if (reservedNames.has(name)) {
      fail("external resources collide with reserved package entries", label);
    }
  }
  return topLevelNames;
}

export function assertExactResourceNames(names, expected, label) {
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    fail("undeclared package resource", label);
  }
}
