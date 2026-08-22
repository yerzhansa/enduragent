import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notarize as notarizeWithPinnedDependency } from "@electron/notarize";
import { parse, stringify } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalRepositoryRoot = resolve(scriptDirectory, "../../..");
const stableSemVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const builderCertificateClassPrefixes = [
  "Developer ID Application:",
  "Developer ID Installer:",
  "3rd Party Mac Developer Application:",
  "3rd Party Mac Developer Installer:",
];
const notarizationCredentialSets = [
  {
    name: "apple-id",
    activators: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"],
    required: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  },
  {
    name: "api-key",
    activators: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    required: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  {
    name: "keychain-profile",
    activators: ["APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"],
    required: ["APPLE_KEYCHAIN_PROFILE"],
  },
];
const safeReleaseArtifactMessagePattern =
  /^(?:missing|invalid|unreadable|unstable) (?:(?:promoted|verified) )?(?:DMG artifact|ZIP artifact|ZIP blockmap|latest-mac\.yml)$/u;
const safeReleasePlanMessages = new Set([
  "release envelope verifier is required",
  "release envelope cleanup failed",
  "release envelope cleanup target changed",
  "release envelope destination is inaccessible",
  "release envelope destination already exists",
  "promoted release artifact differs from builder output",
  "promoted release artifact envelope differs",
  "release artifact changed during promotion",
  "release envelope changed during verification",
]);
export const DESKTOP_UPDATER_CACHE_DIRECTORY = "@enduragentdesktop-updater";

export function safeMacosReleasePlanMessage(error) {
  return error instanceof TypeError &&
    (safeReleasePlanMessages.has(error.message) ||
      safeReleaseArtifactMessagePattern.test(error.message))
    ? error.message
    : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function releaseFileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function sameReleaseFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameVerifiedReleaseFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function releaseDirectoryIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function sameReleaseDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function readRegularReleaseFile(path, label) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw new TypeError(`missing ${label}`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size <= 0
  ) {
    throw new TypeError(`invalid ${label}`);
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new TypeError(`unreadable ${label}`);
  }
  let after;
  try {
    after = await lstat(path);
  } catch {
    throw new TypeError(`unstable ${label}`);
  }
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    bytes.length !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new TypeError(`unstable ${label}`);
  }
  return { bytes, size: before.size, identity: releaseFileIdentity(before) };
}

function credentialValuePresent(environment, name) {
  return typeof environment[name] === "string" && environment[name].length > 0;
}

export function requireNotarizationCredentials(environment = process.env) {
  const activeSets = notarizationCredentialSets.filter((set) =>
    set.activators.some((name) => credentialValuePresent(environment, name)),
  );
  if (activeSets.length === 0) {
    throw new TypeError("notarization credentials are missing");
  }
  const completeSets = activeSets.filter((set) =>
    set.required.every((name) => credentialValuePresent(environment, name)),
  );
  if (completeSets.length !== activeSets.length) {
    throw new TypeError("notarization credentials are incomplete");
  }
  if (completeSets.length !== 1) {
    throw new TypeError("notarization credential configuration is ambiguous");
  }
  const selected = completeSets[0].name;
  if (selected === "apple-id") {
    return Object.freeze({
      name: selected,
      options: Object.freeze({
        appleId: environment.APPLE_ID,
        appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: environment.APPLE_TEAM_ID,
      }),
    });
  }
  if (selected === "api-key") {
    return Object.freeze({
      name: selected,
      options: Object.freeze({
        appleApiKey: environment.APPLE_API_KEY,
        appleApiKeyId: environment.APPLE_API_KEY_ID,
        appleApiIssuer: environment.APPLE_API_ISSUER,
      }),
    });
  }
  const options = {
    keychainProfile: environment.APPLE_KEYCHAIN_PROFILE,
  };
  if (credentialValuePresent(environment, "APPLE_KEYCHAIN")) {
    options.keychain = environment.APPLE_KEYCHAIN;
  }
  return Object.freeze({
    name: selected,
    options: Object.freeze(options),
  });
}

function parseBuilderMetadata(bytes) {
  let metadata;
  try {
    metadata = parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("builder latest-mac.yml is invalid");
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== 1 ||
    !exactObject(metadata.files[0]) ||
    !hasExactKeys(metadata.files[0], ["url", "sha512", "size"])
  ) {
    throw new TypeError("builder latest-mac.yml is invalid");
  }
  return metadata;
}

function canonicalReleaseDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function replaceMetadataAtomically(metadataPath, metadata) {
  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(join(dirname(metadataPath), ".enduragent-metadata-"));
    const temporaryPath = join(temporaryDirectory, "latest-mac.yml");
    await writeFile(temporaryPath, stringify(metadata, { lineWidth: 0 }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, metadataPath);
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function requireStableSemVer(value) {
  if (typeof value !== "string" || value.length > 32 || !stableSemVerPattern.test(value)) {
    throw new TypeError("desktop release version must be stable SemVer");
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new TypeError("desktop release version must be stable SemVer");
  }
  return value;
}

export function requireGenericFeedUrl(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim()
  ) {
    throw new TypeError("release feed URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("release feed URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    !parsed.pathname.endsWith("/") ||
    parsed.href !== value
  ) {
    throw new TypeError("release feed URL is invalid");
  }
  return value;
}

export function parseMacosReleaseUpdaterMetadata(value) {
  let metadata;
  try {
    const source =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value).toString("utf8")
          : undefined;
    if (source === undefined) throw new TypeError();
    metadata = parse(source);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["provider", "url", "channel", "updaterCacheDirName"]) ||
    metadata.provider !== "generic" ||
    metadata.channel !== "latest" ||
    metadata.updaterCacheDirName !== DESKTOP_UPDATER_CACHE_DIRECTORY
  ) {
    throw new TypeError("release updater metadata is invalid");
  }
  let url;
  try {
    url = requireGenericFeedUrl(metadata.url);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  return Object.freeze({
    provider: "generic",
    url,
    channel: "latest",
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
  });
}

export function requireDeveloperIdIdentity(value) {
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    builderCertificateClassPrefixes.some((prefix) => value.startsWith(prefix)) ||
    hasControlCharacter
  ) {
    throw new TypeError("Developer ID identity qualifier is invalid");
  }
  return value;
}

export function requireMacosBaselineApplication(value) {
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    hasControlCharacter
  ) {
    throw new TypeError("signed baseline application path is invalid");
  }
  return value;
}

export async function readDesktopVersion(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? canonicalRepositoryRoot;
  if (!isAbsolute(repositoryRoot)) {
    throw new TypeError("repository root must be absolute");
  }
  const desktopRoot = options.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) {
    throw new TypeError("desktop root must be absolute");
  }
  const read = options.readFile ?? readFile;
  const manifestPath = join(desktopRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await read(manifestPath, "utf8"));
  } catch {
    throw new TypeError("desktop release manifest is invalid");
  }
  if (!exactObject(manifest) || !Object.hasOwn(manifest, "version")) {
    throw new TypeError("desktop release manifest is invalid");
  }
  return requireStableSemVer(manifest.version);
}

export function releaseArtifactNames(version) {
  const stableVersion = requireStableSemVer(version);
  const base = `Enduragent-${stableVersion}-arm64`;
  return Object.freeze({
    dmg: `${base}.dmg`,
    zip: `${base}.zip`,
    blockmap: `${base}.zip.blockmap`,
    metadata: "latest-mac.yml",
  });
}

async function createMacosReleasePlanCore(input, dependencies = {}) {
  const repositoryRoot = input.repositoryRoot ?? canonicalRepositoryRoot;
  const desktopRoot = input.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) {
    throw new TypeError("desktop root must be absolute");
  }
  const version = await readDesktopVersion({
    repositoryRoot,
    desktopRoot,
    readFile: dependencies.readFile,
  });
  const feedUrl = requireGenericFeedUrl(input.feedUrl);
  const identity = requireDeveloperIdIdentity(input.identity);
  const builderOptions = {
    projectDir: desktopRoot,
    publish: "never",
    config: {
      extends: join(desktopRoot, "electron-builder.yml"),
      artifactName: "${productName}-${version}-${arch}.${ext}",
      forceCodeSigning: true,
      extraMetadata: {
        version,
        enduragentDesktopRelease: true,
      },
      publish: [
        {
          provider: "generic",
          url: feedUrl,
          channel: "latest",
        },
      ],
      mac: {
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
      },
      dmg: {
        sign: true,
        writeUpdateInfo: false,
      },
    },
  };
  return Object.freeze({
    version,
    feedUrl,
    artifactNames: releaseArtifactNames(version),
    builderOptions,
  });
}

export async function createMacosReleasePlan(input, dependencies = {}) {
  const plan = await createMacosReleasePlanCore(input, dependencies);
  const baselineApplication = requireMacosBaselineApplication(input.baselineApplication);
  const candidateApplication = join(
    plan.builderOptions.projectDir,
    "dist/mac-arm64/Enduragent.app",
  );
  if (resolve(baselineApplication) === resolve(candidateApplication)) {
    throw new TypeError("signed baseline application must differ from candidate");
  }
  return Object.freeze({ ...plan, baselineApplication });
}

export async function sealMacosReleaseMetadata(plan) {
  const artifactDirectory = join(plan.builderOptions.projectDir, "dist");
  const paths = {
    dmg: join(artifactDirectory, plan.artifactNames.dmg),
    zip: join(artifactDirectory, plan.artifactNames.zip),
    metadata: join(artifactDirectory, plan.artifactNames.metadata),
  };
  const [dmg, zip, metadataFile] = await Promise.all([
    readRegularReleaseFile(paths.dmg, "DMG artifact"),
    readRegularReleaseFile(paths.zip, "ZIP artifact"),
    readRegularReleaseFile(paths.metadata, "builder latest-mac.yml"),
  ]);
  const metadata = parseBuilderMetadata(metadataFile.bytes);
  const zipSha512 = createHash("sha512").update(zip.bytes).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg.bytes).digest("base64");
  const zipFile = metadata.files[0];
  if (
    metadata.version !== plan.version ||
    metadata.path !== plan.artifactNames.zip ||
    metadata.sha512 !== zipSha512 ||
    !canonicalReleaseDate(metadata.releaseDate) ||
    zipFile.url !== plan.artifactNames.zip ||
    zipFile.sha512 !== zipSha512 ||
    zipFile.size !== zip.size ||
    !Number.isSafeInteger(zipFile.size) ||
    zipFile.size <= 0
  ) {
    throw new TypeError("builder latest-mac.yml does not match the ZIP artifact");
  }
  await replaceMetadataAtomically(paths.metadata, {
    version: plan.version,
    files: [
      {
        url: plan.artifactNames.zip,
        sha512: zipSha512,
        size: zip.size,
      },
      {
        url: plan.artifactNames.dmg,
        sha512: dmgSha512,
        size: dmg.size,
      },
    ],
    path: plan.artifactNames.zip,
    sha512: zipSha512,
    releaseDate: metadata.releaseDate,
  });
}

function missingPathError(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

async function requireReleaseDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new TypeError(`missing ${label}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`invalid ${label}`);
  }
  return releaseDirectoryIdentity(stat);
}

async function removeBoundReleaseDirectory(path, expectedIdentity) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (missingPathError(error)) return;
    throw new TypeError("release envelope cleanup failed");
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !sameReleaseDirectoryIdentity(releaseDirectoryIdentity(stat), expectedIdentity)
  ) {
    throw new TypeError("release envelope cleanup target changed");
  }
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    throw new TypeError("release envelope cleanup failed");
  }
}

async function requireMissingReleasePath(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (missingPathError(error)) return;
    throw new TypeError("release envelope destination is inaccessible");
  }
  throw new TypeError("release envelope destination already exists");
}

export function macosReleaseEnvelopePath(plan) {
  return join(plan.builderOptions.projectDir, "dist", `release-envelope-${plan.version}-mac-arm64`);
}

export async function promoteMacosReleaseEnvelope(plan, verifyEnvelope, overrides = {}) {
  if (typeof verifyEnvelope !== "function") {
    throw new TypeError("release envelope verifier is required");
  }
  const artifactDirectory = join(plan.builderOptions.projectDir, "dist");
  await requireReleaseDirectory(artifactDirectory, "release build directory");
  const dependencies = { rename: overrides.rename ?? rename };
  const envelopePath = macosReleaseEnvelopePath(plan);
  await requireMissingReleasePath(envelopePath);
  const sourceEntries = [
    {
      name: plan.artifactNames.dmg,
      path: join(artifactDirectory, plan.artifactNames.dmg),
      label: "DMG artifact",
    },
    {
      name: plan.artifactNames.zip,
      path: join(artifactDirectory, plan.artifactNames.zip),
      label: "ZIP artifact",
    },
    {
      name: plan.artifactNames.blockmap,
      path: join(artifactDirectory, plan.artifactNames.blockmap),
      label: "ZIP blockmap",
    },
    {
      name: plan.artifactNames.metadata,
      path: join(artifactDirectory, plan.artifactNames.metadata),
      label: "latest-mac.yml",
    },
  ];
  const snapshots = await Promise.all(
    sourceEntries.map(async (entry) => ({
      ...entry,
      snapshot: await readRegularReleaseFile(entry.path, entry.label),
    })),
  );
  let cleanupPath;
  let cleanupIdentity;
  try {
    const temporaryDirectory = await mkdtemp(
      join(artifactDirectory, `.release-envelope-${plan.version}-mac-arm64-`),
    );
    cleanupIdentity = await requireReleaseDirectory(
      temporaryDirectory,
      "temporary release envelope",
    );
    cleanupPath = temporaryDirectory;
    await Promise.all(
      snapshots.map(({ name, snapshot }) =>
        writeFile(join(temporaryDirectory, name), snapshot.bytes, {
          flag: "wx",
          mode: 0o600,
        }),
      ),
    );
    const promotedSnapshots = await Promise.all(
      snapshots.map(({ name, label }) =>
        readRegularReleaseFile(join(temporaryDirectory, name), `promoted ${label}`),
      ),
    );
    if (
      promotedSnapshots.some(
        (promoted, index) => !promoted.bytes.equals(snapshots[index].snapshot.bytes),
      )
    ) {
      throw new TypeError("promoted release artifact differs from builder output");
    }
    const names = (await readdir(temporaryDirectory)).sort();
    const expectedNames = snapshots.map(({ name }) => name).sort();
    if (
      names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])
    ) {
      throw new TypeError("promoted release artifact envelope differs");
    }
    await requireMissingReleasePath(envelopePath);
    await dependencies.rename(temporaryDirectory, envelopePath);
    cleanupPath = envelopePath;
    await verifyEnvelope(envelopePath);
    const currentSources = await Promise.all(
      snapshots.map(({ path, label }) => readRegularReleaseFile(path, label)),
    );
    if (
      currentSources.some(
        (current, index) =>
          !sameReleaseFileIdentity(current.identity, snapshots[index].snapshot.identity) ||
          !current.bytes.equals(snapshots[index].snapshot.bytes),
      )
    ) {
      throw new TypeError("release artifact changed during promotion");
    }
    const verifiedSnapshots = await Promise.all(
      snapshots.map(({ name, label }) =>
        readRegularReleaseFile(join(envelopePath, name), `verified ${label}`),
      ),
    );
    if (
      verifiedSnapshots.some(
        (verified, index) =>
          !sameVerifiedReleaseFileIdentity(verified.identity, promotedSnapshots[index].identity) ||
          !verified.bytes.equals(promotedSnapshots[index].bytes),
      )
    ) {
      throw new TypeError("release envelope changed during verification");
    }
    const verifiedNames = (await readdir(envelopePath)).sort();
    if (
      verifiedNames.length !== expectedNames.length ||
      verifiedNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new TypeError("release envelope changed during verification");
    }
    const verifiedDirectoryIdentity = await requireReleaseDirectory(
      envelopePath,
      "verified release envelope",
    );
    if (!sameReleaseDirectoryIdentity(verifiedDirectoryIdentity, cleanupIdentity)) {
      throw new TypeError("release envelope changed during verification");
    }
    cleanupPath = undefined;
    return envelopePath;
  } finally {
    if (cleanupPath !== undefined && cleanupIdentity !== undefined) {
      await removeBoundReleaseDirectory(cleanupPath, cleanupIdentity);
    }
  }
}

export async function notarizeMacosDmg(dmgPath, credentials, dependencies = {}) {
  if (!isAbsolute(dmgPath)) {
    throw new TypeError("DMG path must be absolute");
  }
  if (
    !exactObject(credentials) ||
    !exactObject(credentials.options) ||
    !["apple-id", "api-key", "keychain-profile"].includes(credentials.name)
  ) {
    throw new TypeError("notarization credentials are invalid");
  }
  const notarize = dependencies.notarize ?? notarizeWithPinnedDependency;
  if (typeof notarize !== "function") {
    throw new TypeError("macOS DMG notarization dependency is unavailable");
  }
  try {
    await notarize({
      ...credentials.options,
      appPath: dmgPath,
      tool: "notarytool",
    });
  } catch {
    throw new TypeError("macOS DMG notarization failed");
  }
}

export async function prepareMacosReleaseKeychainBinding(desktopRoot) {
  const [{ buildKeychainBinding, copyKeychainBindingToAsarStaging }, { readBuilderAuthority }] =
    await Promise.all([
      import("./build-keychain-binding.mjs"),
      import("./verify-package-layout.mjs"),
    ]);
  const authority = await readBuilderAuthority(desktopRoot);
  const built = await buildKeychainBinding(desktopRoot);
  const staged = await copyKeychainBindingToAsarStaging(desktopRoot, authority.asarSourceRoot);
  if (built === undefined || staged === undefined) {
    throw new TypeError("macOS keychain binding preparation is unavailable");
  }
  return Object.freeze({ built, staged });
}

export async function runMacosRelease(input, dependencies = {}) {
  dependencies.reportStage?.("release-plan");
  const plan = await createMacosReleasePlan(input, dependencies);
  dependencies.reportStage?.("notarization-credentials");
  const notarizationCredentials = requireNotarizationCredentials(
    dependencies.environment ?? process.env,
  );
  const verification = await import("./verify-macos-release.mjs");
  const verifyBaselineApplication =
    dependencies.verifyBaselineApplication ??
    ((baseline, options) =>
      verification.verifyMacosBaselineApplication(baseline, options, {
        executeFile: dependencies.executeFile,
      }));
  dependencies.reportStage?.("baseline-verification");
  await verifyBaselineApplication(plan.baselineApplication, {
    candidateVersion: plan.version,
  });
  const prepareKeychainBinding =
    dependencies.prepareKeychainBinding ?? prepareMacosReleaseKeychainBinding;
  dependencies.reportStage?.("keychain-binding-preparation");
  await prepareKeychainBinding(plan.builderOptions.projectDir);
  const build = dependencies.build ?? (await import("electron-builder")).build;
  dependencies.reportStage?.("electron-builder");
  const artifacts = await build(plan.builderOptions);
  const application = join(plan.builderOptions.projectDir, "dist/mac-arm64/Enduragent.app");
  const verifyPackageLayout =
    dependencies.verifyPackageLayout ??
    (await import("./verify-package-layout.mjs")).verifyPackageLayout;
  dependencies.reportStage?.("package-layout");
  await verifyPackageLayout(application, {
    desktopRoot: plan.builderOptions.projectDir,
    release: {
      version: plan.version,
      feedUrl: plan.feedUrl,
    },
  });
  const verifyKeychainBinding =
    dependencies.verifyKeychainBinding ??
    ((candidate) =>
      verification.verifyMacosKeychainBinding(candidate, {
        executeFile: dependencies.executeFile,
      }));
  dependencies.reportStage?.("keychain-binding");
  await verifyKeychainBinding(application);
  const verifyElectronFuses =
    dependencies.verifyElectronFuses ??
    (await import("./verify-electron-fuses.mjs")).verifyElectronFuses;
  dependencies.reportStage?.("electron-fuses");
  await verifyElectronFuses(join(application, "Contents/MacOS/Enduragent"));
  const verifyIdentityContinuity =
    dependencies.verifyIdentityContinuity ??
    ((baseline, candidate, options) =>
      verification.verifyMacosIdentityContinuity(baseline, candidate, options, {
        executeFile: dependencies.executeFile,
      }));
  const verifyDmg =
    dependencies.verifyDmg ??
    ((path) =>
      verification.verifyMacosDmg(path, {
        executeFile: dependencies.executeFile,
      }));
  dependencies.reportStage?.("identity-continuity");
  await verifyIdentityContinuity(plan.baselineApplication, application, {
    candidateVersion: plan.version,
  });
  const verifyBackendSelection =
    dependencies.verifyBackendSelection ??
    (async (candidate) =>
      (await import("./verify-macos-backend-selection.mjs")).verifyMacosBackendSelection(candidate, {
        executeFile: dependencies.executeFile,
      }));
  dependencies.reportStage?.("backend-selection");
  await verifyBackendSelection(application);
  const dmgPath = join(plan.builderOptions.projectDir, "dist", plan.artifactNames.dmg);
  dependencies.reportStage?.("dmg-notarization");
  await notarizeMacosDmg(dmgPath, notarizationCredentials, {
    notarize: dependencies.notarize,
  });
  dependencies.reportStage?.("dmg-verification");
  await verifyDmg(dmgPath);
  const sealReleaseMetadata = dependencies.sealReleaseMetadata ?? sealMacosReleaseMetadata;
  dependencies.reportStage?.("metadata-sealing");
  await sealReleaseMetadata(plan);
  const verifyEnvelope = (artifactDirectory) =>
    verification.verifyMacosReleaseEnvelope(
      artifactDirectory,
      plan.baselineApplication,
      application,
      {
        repositoryRoot: input.repositoryRoot ?? canonicalRepositoryRoot,
        readVersionFile: dependencies.readFile,
      },
      {
        executeFile: dependencies.executeFile,
        verifyIdentityContinuity,
        verifyReleaseApplicationContents: dependencies.verifyReleaseApplicationContents,
        verifyReleaseArtifacts: dependencies.verifyReleaseArtifacts,
      },
    );
  const promoteReleaseEnvelope = dependencies.promoteReleaseEnvelope ?? promoteMacosReleaseEnvelope;
  dependencies.reportStage?.("envelope-promotion");
  const envelopePath = await promoteReleaseEnvelope(plan, verifyEnvelope);
  return { plan, artifacts, envelopePath };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(
    process.execPath,
    [join(scriptDirectory, "macos-release-cli.mjs"), ...process.argv.slice(2)],
    {
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    process.stderr.write("macOS release build failed at initialization\n");
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}
