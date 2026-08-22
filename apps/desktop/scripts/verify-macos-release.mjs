import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile, statFile, uncache as uncacheAsarFile } from "@electron/asar";
import { parse } from "yaml";
import {
  parseMacosReleaseUpdaterMetadata,
  readDesktopVersion,
  releaseArtifactNames,
  requireStableSemVer,
} from "./macos-release-plan.mjs";
import { KEYCHAIN_BINDING_ASAR_PATH, machoBundleIdentity } from "./package-inventory.mjs";

const localRequire = createRequire(import.meta.url);
const supportedElectronBuilderVersion = "26.15.3";
const execFileAsync = promisify(execFile);
const canonicalBundleIdentifier = "icu.enduragent.desktop";
const canonicalProductName = "Enduragent";
const canonicalPackageName = "@enduragent/desktop";
const canonicalTeamIdentifier = "FA494ACVTF";
const maximumPackageManifestBytes = 16_384;
const maximumUpdaterMetadataBytes = 16_384;
const canonicalEntitlements = JSON.stringify({ "com.apple.security.cs.allow-jit": true });
const canonicalDesignatedRequirement = `identifier "${canonicalBundleIdentifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${canonicalTeamIdentifier}`;
const canonicalDesignatedRequirementSha256 = createHash("sha256")
  .update(canonicalDesignatedRequirement)
  .digest("hex");
const canonicalDesignatedRequirementPattern =
  /^identifier "icu\.enduragent\.desktop" and anchor apple generic and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] (?:exists|\/\* exists \*\/) and certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] (?:exists|\/\* exists \*\/) and certificate leaf\[subject\.OU\] = (?:FA494ACVTF|"FA494ACVTF")$/u;
const canonicalBindingIdentifierPattern = /^keychain-binding(?:\.node)?(?:-[0-9a-f]{1,64})?$/u;
const canonicalBindingDesignatedRequirementPattern =
  /^identifier "keychain-binding(?:\.node)?(?:-[0-9a-f]{1,64})?" and anchor apple generic and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] (?:exists|\/\* exists \*\/) and certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] (?:exists|\/\* exists \*\/) and certificate leaf\[subject\.OU\] = (?:FA494ACVTF|"FA494ACVTF")$/u;

class MacosReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MacosReleaseVerificationError";
  }
}

function fail(message) {
  throw new MacosReleaseVerificationError(message);
}

export function safeMacosReleaseVerificationMessage(error) {
  return error instanceof MacosReleaseVerificationError ? error.message : undefined;
}

async function executeSystemFile(executable, arguments_) {
  return execFileAsync(executable, [...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function outputStream(result, name) {
  if (typeof result === "string" || Buffer.isBuffer(result)) {
    return name === "stdout" ? String(result) : "";
  }
  if (result === null || typeof result !== "object") return "";
  const value = result[name];
  return typeof value === "string" || Buffer.isBuffer(value) ? String(value) : "";
}

function allCommandOutput(result) {
  return `${outputStream(result, "stdout")}\n${outputStream(result, "stderr")}`;
}

async function inspectSystemFile(executeFile, executable, arguments_) {
  try {
    return await executeFile(executable, arguments_);
  } catch {
    fail("macOS signed identity inspection failed");
  }
}

function exactLine(text, pattern) {
  const values = Array.from(text.matchAll(pattern), (match) => match[1]);
  return values.length === 1 ? values[0] : undefined;
}

function hasCanonicalDeveloperIdApplicationIdentity(teamIdentifier, authorities) {
  const authorityPrefix = "Developer ID Application: ";
  const authoritySuffix = ` (${canonicalTeamIdentifier})`;
  const leafAuthority = authorities[0];
  return (
    teamIdentifier === canonicalTeamIdentifier &&
    authorities.length === 3 &&
    typeof leafAuthority === "string" &&
    leafAuthority.startsWith(authorityPrefix) &&
    leafAuthority.endsWith(authoritySuffix) &&
    authorities[1] === "Developer ID Certification Authority" &&
    authorities[2] === "Apple Root CA"
  );
}

function normalizeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!exactObject(value)) fail("macOS signed entitlements are invalid");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function parseJsonOutput(result, failureMessage) {
  const stdout = outputStream(result, "stdout");
  try {
    return JSON.parse(stdout);
  } catch {
    fail(failureMessage);
  }
}

function isExpectedIdentityTemporaryDirectory(path, prefix) {
  return (
    isAbsolute(path) &&
    dirname(path) === dirname(prefix) &&
    path !== prefix &&
    basename(path).startsWith(basename(prefix))
  );
}

async function readNormalizedEntitlements(application, dependencies) {
  const prefix = join(dependencies.tmpdir(), "enduragent-signed-entitlements-");
  let temporaryDirectory;
  try {
    const candidate = await dependencies.mkdtemp(prefix);
    if (!isExpectedIdentityTemporaryDirectory(candidate, prefix)) {
      fail("macOS signed entitlements are invalid");
    }
    temporaryDirectory = candidate;
    const derPath = join(temporaryDirectory, "entitlements.der");
    const plistPath = join(temporaryDirectory, "entitlements.plist");
    await inspectSystemFile(dependencies.executeFile, "/usr/bin/codesign", [
      "--display",
      "--entitlements",
      derPath,
      "--der",
      application,
    ]);
    await inspectSystemFile(dependencies.executeFile, "/usr/bin/derq", [
      "query",
      "--xml",
      "-i",
      derPath,
      "-o",
      plistPath,
    ]);
    const converted = await inspectSystemFile(dependencies.executeFile, "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      "--",
      plistPath,
    ]);
    return JSON.stringify(
      normalizeJson(parseJsonOutput(converted, "macOS signed entitlements are invalid")),
    );
  } catch (error) {
    if (error instanceof MacosReleaseVerificationError) throw error;
    fail("macOS signed entitlements are invalid");
  } finally {
    if (temporaryDirectory !== undefined) {
      try {
        await dependencies.rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        fail("macOS signed entitlements cleanup failed");
      }
    }
  }
}

async function requireApplicationBundle(application, label, dependencies) {
  if (!isAbsolute(application)) fail(`${label} application path must be absolute`);
  let applicationStat;
  let canonicalPath;
  try {
    [applicationStat, canonicalPath] = await Promise.all([
      dependencies.lstat(application),
      dependencies.realpath(application),
    ]);
  } catch {
    fail(`${label} application bundle is invalid`);
  }
  if (applicationStat.isSymbolicLink() || !applicationStat.isDirectory()) {
    fail(`${label} application bundle is invalid`);
  }
  const infoPath = join(application, "Contents/Info.plist");
  const archivePath = join(application, "Contents/Resources/app.asar");
  let entries;
  try {
    entries = await Promise.all([dependencies.lstat(infoPath), dependencies.lstat(archivePath)]);
  } catch {
    fail(`${label} application bundle is invalid`);
  }
  if (entries.some((stat) => stat.isSymbolicLink() || !stat.isFile())) {
    fail(`${label} application bundle is invalid`);
  }
  return { canonicalPath, infoPath, archivePath };
}

function parseSignatureMetadata(result) {
  const output = allCommandOutput(result);
  const identifier = exactLine(output, /^Identifier=([^\r\n]+)$/gmu);
  const teamIdentifier = exactLine(output, /^TeamIdentifier=([^\r\n]+)$/gmu);
  const codeDirectory = exactLine(output, /^CodeDirectory ([^\r\n]+)$/gmu);
  const cdHash = exactLine(output, /^CDHash=([0-9a-f]{40})$/gimu)?.toLowerCase();
  const candidateCDHashFullLines = Array.from(
    output.matchAll(/^CandidateCDHashFull[^\r\n]*$/gmu),
    (match) => match[0],
  );
  const candidateCDHashFullMatch =
    candidateCDHashFullLines.length === 1
      ? /^CandidateCDHashFull sha256=([0-9a-f]{64})$/iu.exec(candidateCDHashFullLines[0])
      : null;
  const codeDirectorySha256 = candidateCDHashFullMatch?.[1].toLowerCase();
  const flags = exactLine(output, /^CodeDirectory [^\r\n]* flags=0x[0-9a-f]+\(([^\r\n)]*)\)/gimu);
  const authorities = Array.from(output.matchAll(/^Authority=([^\r\n]+)$/gmu), (match) => match[1]);
  if (
    identifier !== canonicalBundleIdentifier ||
    teamIdentifier !== canonicalTeamIdentifier ||
    codeDirectory === undefined ||
    cdHash === undefined ||
    codeDirectorySha256 === undefined ||
    cdHash !== codeDirectorySha256.slice(0, 40) ||
    flags === undefined ||
    !flags
      .split(",")
      .map((flag) => flag.trim())
      .includes("runtime") ||
    !hasCanonicalDeveloperIdApplicationIdentity(teamIdentifier, authorities)
  ) {
    fail("macOS signed identity is invalid");
  }
  return {
    identifier,
    teamIdentifier,
    codeDirectory,
    codeDirectorySha256,
    cdHash,
    hardenedRuntime: true,
    authorities: Object.freeze([...authorities]),
  };
}

function parseDesignatedRequirement(result) {
  const requirement = exactLine(allCommandOutput(result), /^designated => ([^\r\n]+)$/gmu)
    ?.replaceAll(/\s+/gu, " ")
    .trim();
  if (
    requirement === undefined ||
    requirement.length === 0 ||
    requirement.length > 16_384 ||
    !canonicalDesignatedRequirementPattern.test(requirement)
  ) {
    fail("macOS designated requirement is invalid");
  }
  return canonicalDesignatedRequirement;
}

function parseBundleMetadata(result) {
  const info = parseJsonOutput(result, "macOS product identity is invalid");
  if (
    !exactObject(info) ||
    info.CFBundleIdentifier !== canonicalBundleIdentifier ||
    info.CFBundleName !== canonicalProductName ||
    info.CFBundleDisplayName !== canonicalProductName ||
    info.CFBundleExecutable !== canonicalProductName ||
    info.CFBundlePackageType !== "APPL" ||
    info.CFBundleShortVersionString !== info.CFBundleVersion
  ) {
    fail("macOS product identity is invalid");
  }
  try {
    return requireStableSemVer(info.CFBundleShortVersionString);
  } catch {
    fail("macOS product identity is invalid");
  }
}

async function readPackagedManifest(archivePath, dependencies) {
  let entry;
  let manifest;
  let cacheReadAttempted = false;
  let failure = null;
  try {
    dependencies.uncacheAsar(archivePath);
    cacheReadAttempted = true;
    entry = dependencies.statAsarFile(archivePath, "package.json", false);
    if (
      !exactObject(entry) ||
      "files" in entry ||
      "link" in entry ||
      entry.unpacked === true ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > maximumPackageManifestBytes
    ) {
      fail("macOS package identity is invalid");
    }
    const bytes = await dependencies.extractAsarFile(archivePath, "package.json");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length !== entry.size ||
      bytes.length > maximumPackageManifestBytes
    ) {
      fail("macOS package identity is invalid");
    }
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    failure =
      error instanceof MacosReleaseVerificationError
        ? error
        : new MacosReleaseVerificationError("macOS package identity is invalid");
  }

  let cleanupFailure;
  if (cacheReadAttempted) {
    try {
      const removed = dependencies.uncacheAsar(archivePath);
      if (entry !== undefined && removed !== true) {
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS package identity cache cleanup failed",
        );
      }
    } catch {
      cleanupFailure = new MacosReleaseVerificationError(
        "macOS package identity cache cleanup failed",
      );
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (failure !== null) throw failure;
  if (!exactObject(manifest) || manifest.name !== canonicalPackageName) {
    fail("macOS package identity is invalid");
  }
  return Object.freeze({
    version: manifest.version,
    enduragentDesktopRelease: manifest.enduragentDesktopRelease,
  });
}

async function inspectMacosApplicationIdentity(application, bundle, dependencies) {
  await verifyMacosApplication(application, { executeFile: dependencies.executeFile });
  const signatureResult = await inspectSystemFile(dependencies.executeFile, "/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    application,
  ]);
  const signature = parseSignatureMetadata(signatureResult);
  const [requirementResult, infoResult, entitlements, packageMetadata] = await Promise.all([
    inspectSystemFile(dependencies.executeFile, "/usr/bin/codesign", [
      "--display",
      "--requirements",
      "-",
      application,
    ]),
    inspectSystemFile(dependencies.executeFile, "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      "--",
      bundle.infoPath,
    ]),
    readNormalizedEntitlements(application, dependencies),
    readPackagedManifest(bundle.archivePath, dependencies),
  ]);
  const designatedRequirement = parseDesignatedRequirement(requirementResult);
  const version = parseBundleMetadata(infoResult);
  if (packageMetadata.version !== version) fail("macOS package identity is invalid");
  if (entitlements !== canonicalEntitlements) fail("macOS signed entitlements are invalid");
  return Object.freeze({
    version,
    identifier: signature.identifier,
    productName: canonicalProductName,
    packageName: canonicalPackageName,
    enduragentDesktopRelease: packageMetadata.enduragentDesktopRelease,
    teamIdentifier: signature.teamIdentifier,
    designatedRequirement,
    entitlements,
    hardenedRuntime: signature.hardenedRuntime,
    authorities: signature.authorities,
    codeDirectory: signature.codeDirectory,
    codeDirectorySha256: signature.codeDirectorySha256,
    cdHash: signature.cdHash,
  });
}

function olderStableSemVer(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (const [index, part] of leftParts.entries()) {
    if (part < rightParts[index]) return true;
    if (part > rightParts[index]) return false;
  }
  return false;
}

export async function verifyMacosBaselineApplication(baselineApplication, options, overrides = {}) {
  let candidateVersion;
  try {
    candidateVersion = requireStableSemVer(options?.candidateVersion);
  } catch {
    fail("candidate release version is invalid");
  }
  if (typeof baselineApplication !== "string" || !isAbsolute(baselineApplication)) {
    fail("baseline application path must be absolute");
  }
  const dependencies = {
    executeFile: overrides.executeFile ?? executeSystemFile,
    extractAsarFile: overrides.extractAsarFile ?? extractFile,
    lstat: overrides.lstat ?? lstat,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    realpath: overrides.realpath ?? realpath,
    rm: overrides.rm ?? rm,
    statAsarFile: overrides.statAsarFile ?? statFile,
    tmpdir: overrides.tmpdir ?? tmpdir,
    uncacheAsar: overrides.uncacheAsar ?? uncacheAsarFile,
  };
  const bundle = await requireApplicationBundle(baselineApplication, "baseline", dependencies);
  const baseline = await inspectMacosApplicationIdentity(baselineApplication, bundle, dependencies);
  if (!olderStableSemVer(baseline.version, candidateVersion)) {
    fail("baseline application is not older than candidate");
  }
  return Object.freeze({
    baselineVersion: baseline.version,
    teamIdentifier: baseline.teamIdentifier,
  });
}

async function verifyMacosReleaseCandidateBundle(
  candidateApplication,
  candidateVersion,
  bundle,
  dependencies,
) {
  const candidate = await inspectMacosApplicationIdentity(
    candidateApplication,
    bundle,
    dependencies,
  );
  if (candidate.version !== candidateVersion) fail("candidate release identity is invalid");
  return Object.freeze({
    version: candidate.version,
    identifier: candidate.identifier,
    productName: candidate.productName,
    packageName: candidate.packageName,
    teamIdentifier: candidate.teamIdentifier,
    designatedRequirement: candidate.designatedRequirement,
    hardenedRuntime: candidate.hardenedRuntime,
    authorities: candidate.authorities,
    entitlements: candidate.entitlements,
    candidateCodeIdentity: Object.freeze({
      codeDirectory: candidate.codeDirectory,
      codeDirectorySha256: candidate.codeDirectorySha256,
      cdHash: candidate.cdHash,
    }),
  });
}

async function readMacosReleaseUpdaterMetadata(application, dependencies) {
  const path = join(application, "Contents/Resources/app-update.yml");
  let before;
  let bytes;
  try {
    before = await dependencies.lstat(path);
  } catch {
    fail("macOS release updater metadata is invalid");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size <= 0 ||
    before.size > maximumUpdaterMetadataBytes
  ) {
    fail("macOS release updater metadata is invalid");
  }
  try {
    bytes = await dependencies.readFile(path);
  } catch {
    fail("macOS release updater metadata is invalid");
  }
  let after;
  try {
    after = await dependencies.lstat(path);
  } catch {
    fail("macOS release updater metadata is invalid");
  }
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    !(bytes instanceof Uint8Array) ||
    bytes.length !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    fail("macOS release updater metadata is invalid");
  }
  try {
    return parseMacosReleaseUpdaterMetadata(bytes);
  } catch {
    fail("macOS release updater metadata is invalid");
  }
}

async function copyMacosReleaseApplication(source, destination, dependencies) {
  try {
    await dependencies.executeFile("/usr/bin/ditto", [
      "--rsrc",
      "--extattr",
      "--qtn",
      "--acl",
      source,
      destination,
    ]);
  } catch {
    fail("macOS release application snapshot failed");
  }
}

export async function inspectMacosReleaseApplication(application, overrides = {}) {
  if (
    typeof application !== "string" ||
    !isAbsolute(application) ||
    !application.endsWith(".app")
  ) {
    fail("release application path must be one absolute .app path");
  }
  const dependencies = {
    executeFile: overrides.executeFile ?? executeSystemFile,
    extractAsarFile: overrides.extractAsarFile ?? extractFile,
    lstat: overrides.lstat ?? lstat,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    readFile: overrides.readFile ?? readFile,
    realpath: overrides.realpath ?? realpath,
    rm: overrides.rm ?? rm,
    statAsarFile: overrides.statAsarFile ?? statFile,
    tmpdir: overrides.tmpdir ?? tmpdir,
    uncacheAsar: overrides.uncacheAsar ?? uncacheAsarFile,
  };

  await requireApplicationBundle(application, "release", dependencies);
  await verifyMacosApplication(application, { executeFile: dependencies.executeFile });

  const temporaryPrefix = join(dependencies.tmpdir(), "enduragent-release-inspector-");
  let temporaryDirectory;
  let temporaryDirectoryIdentity;
  let result;
  let failure = null;
  try {
    const candidate = await dependencies.mkdtemp(temporaryPrefix);
    temporaryDirectoryIdentity = await requireSecureTemporaryDirectory(
      candidate,
      temporaryPrefix,
      dependencies,
    );
    temporaryDirectory = candidate;
    const snapshot = join(temporaryDirectory, `${canonicalProductName}.app`);
    await copyMacosReleaseApplication(application, snapshot, dependencies);
    const bundle = await requireApplicationBundle(snapshot, "release snapshot", dependencies);
    const identity = await inspectMacosApplicationIdentity(snapshot, bundle, dependencies);
    if (identity.enduragentDesktopRelease !== true) {
      fail("macOS release marker is invalid");
    }
    const updater = await readMacosReleaseUpdaterMetadata(snapshot, dependencies);
    result = Object.freeze({
      version: identity.version,
      enduragentDesktopRelease: true,
      feedUrl: updater.url,
      bundleIdentifier: identity.identifier,
      teamIdentifier: identity.teamIdentifier,
      designatedRequirementSha256: canonicalDesignatedRequirementSha256,
      codeDirectorySha256: identity.codeDirectorySha256,
      cdHash: identity.cdHash,
    });
  } catch (error) {
    failure =
      error instanceof MacosReleaseVerificationError
        ? error
        : new MacosReleaseVerificationError("macOS release application inspection failed");
  }

  let cleanupFailure;
  if (temporaryDirectory !== undefined && temporaryDirectoryIdentity !== undefined) {
    try {
      await requireSameSecureDirectory(
        temporaryDirectory,
        temporaryDirectoryIdentity,
        dependencies,
        "macOS release application snapshot cleanup failed",
      );
      await dependencies.rm(temporaryDirectory, { recursive: true, force: true });
      try {
        await dependencies.lstat(temporaryDirectory);
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS release application snapshot cleanup failed",
        );
      } catch (error) {
        if (!missingPathError(error)) {
          cleanupFailure = new MacosReleaseVerificationError(
            "macOS release application snapshot cleanup failed",
          );
        }
      }
    } catch {
      cleanupFailure = new MacosReleaseVerificationError(
        "macOS release application snapshot cleanup failed",
      );
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (failure !== null) throw failure;
  if (result === undefined) fail("macOS release application inspection failed");
  return result;
}

export async function verifyMacosIdentityContinuity(
  baselineApplication,
  candidateApplication,
  options,
  overrides = {},
) {
  let candidateVersion;
  try {
    candidateVersion = requireStableSemVer(options?.candidateVersion);
  } catch {
    fail("candidate release version is invalid");
  }
  if (typeof baselineApplication !== "string" || !isAbsolute(baselineApplication)) {
    fail("baseline application path must be absolute");
  }
  if (typeof candidateApplication !== "string" || !isAbsolute(candidateApplication)) {
    fail("candidate application path must be absolute");
  }
  if (resolve(baselineApplication) === resolve(candidateApplication)) {
    fail("baseline application must differ from candidate");
  }
  const dependencies = {
    executeFile: overrides.executeFile ?? executeSystemFile,
    extractAsarFile: overrides.extractAsarFile ?? extractFile,
    lstat: overrides.lstat ?? lstat,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    realpath: overrides.realpath ?? realpath,
    rm: overrides.rm ?? rm,
    statAsarFile: overrides.statAsarFile ?? statFile,
    tmpdir: overrides.tmpdir ?? tmpdir,
    uncacheAsar: overrides.uncacheAsar ?? uncacheAsarFile,
  };
  const [baselineBundle, candidateBundle] = await Promise.all([
    requireApplicationBundle(baselineApplication, "baseline", dependencies),
    requireApplicationBundle(candidateApplication, "candidate", dependencies),
  ]);
  if (baselineBundle.canonicalPath === candidateBundle.canonicalPath) {
    fail("baseline application must differ from candidate");
  }
  const [baseline, candidateIdentity] = await Promise.all([
    inspectMacosApplicationIdentity(baselineApplication, baselineBundle, dependencies),
    verifyMacosReleaseCandidateBundle(
      candidateApplication,
      candidateVersion,
      candidateBundle,
      dependencies,
    ),
  ]);
  const candidate = {
    ...candidateIdentity,
    codeDirectory: candidateIdentity.candidateCodeIdentity.codeDirectory,
    codeDirectorySha256: candidateIdentity.candidateCodeIdentity.codeDirectorySha256,
    cdHash: candidateIdentity.candidateCodeIdentity.cdHash,
  };
  if (!olderStableSemVer(baseline.version, candidate.version)) {
    fail("baseline application is not older than candidate");
  }
  if (
    baseline.identifier !== candidate.identifier ||
    baseline.teamIdentifier !== candidate.teamIdentifier ||
    baseline.designatedRequirement !== candidate.designatedRequirement ||
    baseline.entitlements !== candidate.entitlements
  ) {
    fail("macOS signed identity differs from baseline");
  }
  return Object.freeze({
    baselineVersion: baseline.version,
    candidateVersion: candidate.version,
    teamIdentifier: candidate.teamIdentifier,
    candidateCodeIdentity: Object.freeze({
      codeDirectory: candidate.codeDirectory,
      codeDirectorySha256: candidate.codeDirectorySha256,
      cdHash: candidate.cdHash,
    }),
  });
}

function requireCandidateCodeIdentity(value) {
  if (
    !exactObject(value) ||
    typeof value.codeDirectory !== "string" ||
    value.codeDirectory.length === 0 ||
    value.codeDirectory.length > 16_384 ||
    typeof value.codeDirectorySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.codeDirectorySha256) ||
    typeof value.cdHash !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.cdHash) ||
    value.cdHash !== value.codeDirectorySha256.slice(0, 40)
  ) {
    fail("loose candidate code identity is invalid");
  }
  return value;
}

async function requireSecureTemporaryDirectory(path, prefix, dependencies) {
  if (!isExpectedTemporaryDirectory(path, prefix) || resolve(path) !== path) {
    fail("macOS release application temporary directory is invalid");
  }
  let stat;
  try {
    stat = await dependencies.lstat(path);
  } catch {
    fail("macOS release application temporary directory is invalid");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    fail("macOS release application temporary directory is invalid");
  }
  return filesystemObjectIdentity(stat);
}

async function createSecureChildDirectory(path, dependencies) {
  try {
    await dependencies.mkdir(path, { mode: 0o700 });
    const stat = await dependencies.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      fail("macOS release application temporary directory is invalid");
    }
    return filesystemObjectIdentity(stat);
  } catch (error) {
    if (error instanceof MacosReleaseVerificationError) throw error;
    fail("macOS release application temporary directory is invalid");
  }
}

async function requireSingleRootApplication(directory, label, dependencies) {
  let entries;
  let canonicalDirectory;
  try {
    const [stat, resolvedDirectory, directoryEntries] = await Promise.all([
      dependencies.lstat(directory),
      dependencies.realpath(directory),
      dependencies.readdir(directory),
    ]);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`${label} root application is invalid`);
    }
    canonicalDirectory = resolvedDirectory;
    entries = directoryEntries;
  } catch {
    fail(`${label} root application is invalid`);
  }
  const applicationName = `${canonicalProductName}.app`;
  const applicationEntries = entries.filter((entry) => entry.toLowerCase().endsWith(".app"));
  const allowedDmgPresentationEntries = new Set([
    applicationName,
    "Applications",
    ".background.tiff",
    ".DS_Store",
    ".VolumeIcon.icns",
  ]);
  if (
    applicationEntries.length !== 1 ||
    applicationEntries[0] !== applicationName ||
    (label === "ZIP" && (entries.length !== 1 || entries[0] !== applicationName)) ||
    (label === "DMG" && entries.some((entry) => !allowedDmgPresentationEntries.has(entry)))
  ) {
    fail(`${label} root application is invalid`);
  }
  if (label === "DMG") {
    try {
      await Promise.all(
        entries
          .filter((entry) => entry !== applicationName)
          .map(async (entry) => {
            const path = join(directory, entry);
            const stat = await dependencies.lstat(path);
            if (entry === "Applications") {
              if (
                !stat.isSymbolicLink() ||
                (await dependencies.readlink(path)) !== "/Applications"
              ) {
                fail("DMG root application is invalid");
              }
              return;
            }
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
              fail("DMG root application is invalid");
            }
          }),
      );
    } catch (error) {
      if (error instanceof MacosReleaseVerificationError) throw error;
      fail("DMG root application is invalid");
    }
  }
  const application = join(directory, applicationName);
  let stat;
  let canonicalApplication;
  try {
    [stat, canonicalApplication] = await Promise.all([
      dependencies.lstat(application),
      dependencies.realpath(application),
    ]);
  } catch {
    fail(`${label} root application is invalid`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(canonicalApplication) !== canonicalDirectory ||
    basename(canonicalApplication) !== applicationName
  ) {
    fail(`${label} root application is invalid`);
  }
  return application;
}

function validHdiutilPath(path) {
  return (
    typeof path === "string" &&
    isAbsolute(path) &&
    path.length > 0 &&
    path.length <= 4_096 &&
    path === path.trim() &&
    Array.from(path).every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    })
  );
}

function parseHdiutilSystemEntities(value, failureMessage) {
  const entities = exactObject(value) ? value["system-entities"] : undefined;
  if (!Array.isArray(entities) || entities.some((entry) => !exactObject(entry))) {
    fail(failureMessage);
  }
  for (const entry of entities) {
    const device = entry["dev-entry"];
    if (
      typeof device !== "string" ||
      !/^\/dev\/disk[1-9]\d*(?:s[1-9]\d*)?$/u.test(device) ||
      (Object.hasOwn(entry, "mount-point") && !validHdiutilPath(entry["mount-point"]))
    ) {
      fail(failureMessage);
    }
  }
  return entities;
}

async function mountedDeviceAtMountPoint(
  result,
  mountPoint,
  dependencies,
  failureMessage,
  requireOnlyMountedEntity,
) {
  const mounted = parseHdiutilSystemEntities(
    parseJsonOutput(result, failureMessage),
    failureMessage,
  ).filter((entry) => Object.hasOwn(entry, "mount-point"));
  if (requireOnlyMountedEntity && mounted.length !== 1) fail(failureMessage);
  let canonicalExpectedMountPoint;
  try {
    canonicalExpectedMountPoint = await dependencies.realpath(mountPoint);
  } catch {
    fail(failureMessage);
  }
  const matches = [];
  for (const entry of mounted) {
    let canonicalReportedMountPoint;
    try {
      canonicalReportedMountPoint = await dependencies.realpath(entry["mount-point"]);
    } catch {
      fail(failureMessage);
    }
    if (canonicalExpectedMountPoint === canonicalReportedMountPoint) matches.push(entry);
  }
  if (matches.length !== 1) {
    if (!requireOnlyMountedEntity && matches.length === 0) return undefined;
    fail(failureMessage);
  }
  return matches[0]["dev-entry"];
}

async function inspectHdiutilState(result, dependencies, failureMessage) {
  const value = parseJsonOutput(result, failureMessage);
  const images = exactObject(value) ? value.images : undefined;
  if (!Array.isArray(images) || images.some((image) => !exactObject(image))) {
    fail(failureMessage);
  }
  const state = [];
  for (const image of images) {
    const imagePath = image["image-path"];
    if (!validHdiutilPath(imagePath)) fail(failureMessage);
    let canonicalImagePath;
    try {
      canonicalImagePath = await dependencies.realpath(imagePath);
    } catch {
      fail(failureMessage);
    }
    const entities = parseHdiutilSystemEntities(image, failureMessage);
    const normalizedEntities = [];
    for (const entity of entities) {
      let canonicalMountPoint;
      if (Object.hasOwn(entity, "mount-point")) {
        try {
          canonicalMountPoint = await dependencies.realpath(entity["mount-point"]);
        } catch {
          fail(failureMessage);
        }
      }
      normalizedEntities.push({
        device: entity["dev-entry"],
        canonicalMountPoint,
      });
    }
    state.push({ canonicalImagePath, entities: normalizedEntities });
  }
  return state;
}

async function runRedactedSystemFile(dependencies, executable, arguments_, failureMessage) {
  try {
    return await dependencies.executeFile(executable, arguments_);
  } catch {
    fail(failureMessage);
  }
}

async function convertHdiutilPlist(result, path, dependencies, failureMessage) {
  const bytes = outputStream(result, "stdout");
  if (bytes.length === 0 || Buffer.byteLength(bytes) > 1024 * 1024) fail(failureMessage);
  try {
    await dependencies.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    fail(failureMessage);
  }
  return runRedactedSystemFile(
    dependencies,
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", path],
    failureMessage,
  );
}

async function inspectCurrentHdiutilState(temporaryDirectory, sequence, dependencies) {
  const failureMessage = "macOS release DMG detach state verification failed";
  const result = await runRedactedSystemFile(
    dependencies,
    "/usr/bin/hdiutil",
    ["info", "-plist"],
    failureMessage,
  );
  const converted = await convertHdiutilPlist(
    result,
    join(temporaryDirectory, `hdiutil-info-${sequence}.plist`),
    dependencies,
    failureMessage,
  );
  return inspectHdiutilState(converted, dependencies, failureMessage);
}

function mountedImageAssociations(state) {
  return state.flatMap((image) =>
    image.entities
      .filter((entity) => entity.canonicalMountPoint !== undefined)
      .map((entity) => ({
        canonicalImagePath: image.canonicalImagePath,
        canonicalMountPoint: entity.canonicalMountPoint,
        device: entity.device,
      })),
  );
}

function findAttachedImageIdentity(
  state,
  canonicalImagePath,
  canonicalMountPoint,
  deviceFromAttach,
) {
  const associations = mountedImageAssociations(state);
  const atMountPoint = associations.filter(
    (association) => association.canonicalMountPoint === canonicalMountPoint,
  );
  const imageRecords = state.filter((image) => image.canonicalImagePath === canonicalImagePath);
  const forImage = associations.filter(
    (association) => association.canonicalImagePath === canonicalImagePath,
  );
  const matchingDeviceEntries =
    deviceFromAttach === undefined
      ? []
      : state.flatMap((image) =>
          image.entities.filter((entity) => entity.device === deviceFromAttach),
        );
  if (
    atMountPoint.length === 0 &&
    imageRecords.length === 0 &&
    matchingDeviceEntries.length === 0
  ) {
    return undefined;
  }
  if (
    atMountPoint.length !== 1 ||
    imageRecords.length !== 1 ||
    forImage.length !== 1 ||
    atMountPoint[0] !== forImage[0] ||
    (deviceFromAttach !== undefined &&
      (atMountPoint[0].device !== deviceFromAttach || matchingDeviceEntries.length !== 1))
  ) {
    fail("macOS release DMG detach state verification failed");
  }
  return Object.freeze({
    canonicalImagePath,
    canonicalMountPoint,
    device: atMountPoint[0].device,
    instanceDevices: Object.freeze(imageRecords[0].entities.map((entity) => entity.device).sort()),
  });
}

function requireNewImageInstance(attachment, previousState) {
  const previousDevices = new Set(
    previousState.flatMap((image) => image.entities.map((entity) => entity.device)),
  );
  if (attachment.instanceDevices.some((device) => previousDevices.has(device))) {
    fail("macOS release DMG detach state verification failed");
  }
}

function requireSameImageInstance(actual, expected) {
  if (
    actual === undefined ||
    actual.canonicalImagePath !== expected.canonicalImagePath ||
    actual.canonicalMountPoint !== expected.canonicalMountPoint ||
    actual.device !== expected.device ||
    actual.instanceDevices.length !== expected.instanceDevices.length ||
    actual.instanceDevices.some((device, index) => device !== expected.instanceDevices[index])
  ) {
    fail("macOS release DMG detach state verification failed");
  }
  return actual;
}

function requireDetachedImageIdentity(state, canonicalImagePath, canonicalMountPoint, devices) {
  const associations = mountedImageAssociations(state);
  const expectedDevices = Array.isArray(devices) ? devices : devices === undefined ? [] : [devices];
  if (
    state.some((image) => image.canonicalImagePath === canonicalImagePath) ||
    state.some((image) =>
      image.entities.some((entity) => expectedDevices.includes(entity.device)),
    ) ||
    associations.some((association) => association.canonicalMountPoint === canonicalMountPoint)
  ) {
    fail("macOS release DMG detach state verification failed");
  }
}

function missingPathError(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

function filesystemObjectIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function sameFilesystemObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function requireSameSecureDirectory(path, expectedIdentity, dependencies, failureMessage) {
  let stat;
  try {
    stat = await dependencies.lstat(path);
  } catch {
    fail(failureMessage);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    !sameFilesystemObject(filesystemObjectIdentity(stat), expectedIdentity)
  ) {
    fail(failureMessage);
  }
}

async function inspectPackagedApplication(application, expectedCodeIdentity, verifyCandidate) {
  let verifiedCandidate;
  try {
    verifiedCandidate = await verifyCandidate(application);
  } catch (error) {
    if (error instanceof MacosReleaseVerificationError) throw error;
    fail("packaged macOS application identity verification failed");
  }
  const actualCodeIdentity = requireCandidateCodeIdentity(verifiedCandidate?.candidateCodeIdentity);
  if (
    actualCodeIdentity.codeDirectory !== expectedCodeIdentity.codeDirectory ||
    actualCodeIdentity.codeDirectorySha256 !== expectedCodeIdentity.codeDirectorySha256 ||
    actualCodeIdentity.cdHash !== expectedCodeIdentity.cdHash
  ) {
    fail("packaged macOS application differs from the loose candidate");
  }
}

async function verifyMacosReleaseApplicationContentsWithCandidate(
  artifactDirectory,
  options,
  overrides,
  verifyCandidate,
) {
  if (!isAbsolute(artifactDirectory)) fail("artifact directory must be absolute");
  let candidateVersion;
  try {
    candidateVersion = requireStableSemVer(options?.candidateVersion);
  } catch {
    fail("candidate release version is invalid");
  }
  const expectedCodeIdentity = requireCandidateCodeIdentity(options?.looseCandidateCodeIdentity);
  const dependencies = {
    executeFile: overrides.executeFile ?? executeSystemFile,
    extractAsarFile: overrides.extractAsarFile ?? extractFile,
    lstat: overrides.lstat ?? lstat,
    mkdir: overrides.mkdir ?? mkdir,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    readFile: overrides.readFile ?? readFile,
    readlink: overrides.readlink ?? readlink,
    readdir: overrides.readdir ?? readdir,
    realpath: overrides.realpath ?? realpath,
    rm: overrides.rm ?? rm,
    rmdir: overrides.rmdir ?? rmdir,
    tmpdir: overrides.tmpdir ?? tmpdir,
    writeFile: overrides.writeFile ?? writeFile,
  };
  const names = releaseArtifactNames(candidateVersion);
  const zipPath = join(artifactDirectory, names.zip);
  const dmgPath = join(artifactDirectory, names.dmg);
  for (const [path, label] of [
    [zipPath, "ZIP artifact"],
    [dmgPath, "DMG artifact"],
  ]) {
    let stat;
    try {
      stat = await dependencies.lstat(path);
    } catch {
      fail(`missing ${label}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) fail(`invalid ${label}`);
  }

  let temporaryBase;
  try {
    temporaryBase = dependencies.tmpdir();
  } catch {
    fail("macOS release application temporary directory is invalid");
  }
  if (
    typeof temporaryBase !== "string" ||
    !isAbsolute(temporaryBase) ||
    temporaryBase.length === 0 ||
    temporaryBase.length > 4_096 ||
    temporaryBase !== temporaryBase.trim()
  ) {
    fail("macOS release application temporary directory is invalid");
  }
  const temporaryPrefix = join(temporaryBase, "enduragent-release-applications-");
  let temporaryDirectory;
  let mountPoint;
  let canonicalDmgPath;
  let canonicalMountPoint;
  let deviceFromAttach;
  let hdiutilBeforeAttach;
  let attachmentIdentity;
  let temporaryDirectoryIdentity;
  let mountPointIdentity;
  let attachmentAttempted = false;
  let failure = null;
  try {
    const candidateTemporaryDirectory = await dependencies.mkdtemp(temporaryPrefix);
    temporaryDirectoryIdentity = await requireSecureTemporaryDirectory(
      candidateTemporaryDirectory,
      temporaryPrefix,
      dependencies,
    );
    temporaryDirectory = candidateTemporaryDirectory;
    const zipDirectory = join(temporaryDirectory, "zip");
    mountPoint = join(temporaryDirectory, "dmg");
    await createSecureChildDirectory(zipDirectory, dependencies);
    mountPointIdentity = await createSecureChildDirectory(mountPoint, dependencies);
    try {
      [canonicalDmgPath, canonicalMountPoint] = await Promise.all([
        dependencies.realpath(dmgPath),
        dependencies.realpath(mountPoint),
      ]);
    } catch {
      fail("macOS release DMG mount metadata is invalid");
    }

    await runRedactedSystemFile(
      dependencies,
      "/usr/bin/ditto",
      ["-x", "-k", zipPath, zipDirectory],
      "macOS release ZIP extraction failed",
    );
    const zipApplication = await requireSingleRootApplication(zipDirectory, "ZIP", dependencies);
    await inspectPackagedApplication(zipApplication, expectedCodeIdentity, verifyCandidate);

    hdiutilBeforeAttach = await inspectCurrentHdiutilState(
      temporaryDirectory,
      "before-attach",
      dependencies,
    );
    requireDetachedImageIdentity(
      hdiutilBeforeAttach,
      canonicalDmgPath,
      canonicalMountPoint,
      undefined,
    );

    attachmentAttempted = true;
    const attachResult = await runRedactedSystemFile(
      dependencies,
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-plist",
        "-mountpoint",
        mountPoint,
        dmgPath,
      ],
      "macOS release DMG mount failed",
    );
    const converted = await convertHdiutilPlist(
      attachResult,
      join(temporaryDirectory, "hdiutil-attach.plist"),
      dependencies,
      "macOS release DMG mount metadata is invalid",
    );
    deviceFromAttach = await mountedDeviceAtMountPoint(
      converted,
      mountPoint,
      dependencies,
      "macOS release DMG mount metadata is invalid",
      true,
    );
    const afterAttach = await inspectCurrentHdiutilState(
      temporaryDirectory,
      "after-attach",
      dependencies,
    );
    const candidateAttachmentIdentity = findAttachedImageIdentity(
      afterAttach,
      canonicalDmgPath,
      canonicalMountPoint,
      deviceFromAttach,
    );
    if (candidateAttachmentIdentity === undefined) {
      fail("macOS release DMG mount metadata is invalid");
    }
    requireNewImageInstance(candidateAttachmentIdentity, hdiutilBeforeAttach);
    attachmentIdentity = candidateAttachmentIdentity;
    const dmgApplication = await requireSingleRootApplication(mountPoint, "DMG", dependencies);
    await inspectPackagedApplication(dmgApplication, expectedCodeIdentity, verifyCandidate);
  } catch (error) {
    failure =
      error instanceof MacosReleaseVerificationError
        ? error
        : new MacosReleaseVerificationError("macOS release application verification failed");
  }

  let cleanupFailure;
  let safeToRemove = false;
  if (
    attachmentAttempted &&
    mountPoint !== undefined &&
    canonicalDmgPath !== undefined &&
    canonicalMountPoint !== undefined &&
    temporaryDirectory !== undefined
  ) {
    let attachment;
    try {
      const beforeDetach = await inspectCurrentHdiutilState(
        temporaryDirectory,
        "before-detach",
        dependencies,
      );
      const observedAttachment = findAttachedImageIdentity(
        beforeDetach,
        canonicalDmgPath,
        canonicalMountPoint,
        deviceFromAttach,
      );
      if (attachmentIdentity === undefined) {
        if (observedAttachment !== undefined && hdiutilBeforeAttach !== undefined) {
          requireNewImageInstance(observedAttachment, hdiutilBeforeAttach);
        }
        attachment = observedAttachment;
      } else {
        attachment = requireSameImageInstance(observedAttachment, attachmentIdentity);
      }
    } catch {
      cleanupFailure = new MacosReleaseVerificationError(
        "macOS release DMG detach state verification failed",
      );
    }
    if (cleanupFailure === undefined && attachment !== undefined) {
      try {
        await dependencies.executeFile("/usr/bin/hdiutil", ["detach", attachment.device]);
      } catch {
        cleanupFailure = new MacosReleaseVerificationError("macOS release DMG detach failed");
      }
    }
    if (cleanupFailure === undefined) {
      try {
        const afterDetach = await inspectCurrentHdiutilState(
          temporaryDirectory,
          "after-detach",
          dependencies,
        );
        requireDetachedImageIdentity(
          afterDetach,
          canonicalDmgPath,
          canonicalMountPoint,
          attachment?.instanceDevices ?? deviceFromAttach,
        );
      } catch {
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS release DMG detach state verification failed",
        );
      }
    }
  }
  if (cleanupFailure === undefined && mountPoint !== undefined) {
    if (mountPointIdentity === undefined) {
      cleanupFailure = new MacosReleaseVerificationError(
        "macOS release DMG mountpoint cleanup failed",
      );
    } else {
      try {
        await requireSameSecureDirectory(
          mountPoint,
          mountPointIdentity,
          dependencies,
          "macOS release DMG mountpoint cleanup failed",
        );
        await dependencies.rmdir(mountPoint);
      } catch {
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS release DMG mountpoint cleanup failed",
        );
      }
    }
    if (cleanupFailure === undefined) {
      try {
        await dependencies.lstat(mountPoint);
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS release DMG mountpoint cleanup failed",
        );
      } catch (error) {
        if (!missingPathError(error)) {
          cleanupFailure = new MacosReleaseVerificationError(
            "macOS release DMG mountpoint cleanup failed",
          );
        }
      }
    }
    safeToRemove = cleanupFailure === undefined;
  } else if (cleanupFailure === undefined && mountPoint === undefined) {
    safeToRemove = true;
  }
  if (cleanupFailure === undefined && safeToRemove && temporaryDirectory !== undefined) {
    if (temporaryDirectoryIdentity === undefined) {
      cleanupFailure = new MacosReleaseVerificationError(
        "macOS release application cleanup failed",
      );
    } else {
      try {
        await requireSameSecureDirectory(
          temporaryDirectory,
          temporaryDirectoryIdentity,
          dependencies,
          "macOS release application cleanup failed",
        );
        await dependencies.rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailure = new MacosReleaseVerificationError(
          "macOS release application cleanup failed",
        );
      }
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (failure !== null) throw failure;
}

export async function verifyMacosReleaseApplicationContents(
  artifactDirectory,
  baselineApplication,
  options,
  overrides = {},
) {
  if (typeof baselineApplication !== "string" || !isAbsolute(baselineApplication)) {
    fail("baseline application path must be absolute");
  }
  const verifyIdentityContinuity =
    overrides.verifyIdentityContinuity ?? verifyMacosIdentityContinuity;
  return verifyMacosReleaseApplicationContentsWithCandidate(
    artifactDirectory,
    options,
    overrides,
    (application) =>
      verifyIdentityContinuity(
        baselineApplication,
        application,
        { candidateVersion: options?.candidateVersion },
        overrides,
      ),
  );
}

async function runSystemVerification(executeFile, executable, arguments_, failureMessage) {
  try {
    await executeFile(executable, arguments_);
  } catch {
    fail(failureMessage);
  }
}

async function verifyMacosDmgSignature(dmgPath, executeFile) {
  await runSystemVerification(
    executeFile,
    "/usr/bin/codesign",
    ["--verify", "--verbose=2", dmgPath],
    "macOS DMG signature verification failed",
  );
  let signatureResult;
  try {
    signatureResult = await executeFile("/usr/bin/codesign", ["--display", "--verbose=4", dmgPath]);
  } catch {
    fail("macOS DMG signing identity inspection failed");
  }
  const output = allCommandOutput(signatureResult);
  const teamIdentifier = exactLine(output, /^TeamIdentifier=([^\r\n]+)$/gmu);
  const authorities = Array.from(output.matchAll(/^Authority=([^\r\n]+)$/gmu), (match) => match[1]);
  if (!hasCanonicalDeveloperIdApplicationIdentity(teamIdentifier, authorities)) {
    fail("macOS DMG signing identity is invalid");
  }
}

async function verifyMacosDmgNotarization(dmgPath, executeFile) {
  await runSystemVerification(
    executeFile,
    "/usr/bin/xcrun",
    ["stapler", "validate", "-v", dmgPath],
    "macOS DMG staple verification failed",
  );
  await runSystemVerification(
    executeFile,
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
    "macOS DMG Gatekeeper verification failed",
  );
}

export async function verifyMacosKeychainBinding(application, overrides = {}) {
  if (!isAbsolute(application)) fail("application path must be absolute");
  const executeFile = overrides.executeFile ?? executeSystemFile;
  const binding = join(
    application,
    "Contents/Resources/app.asar.unpacked",
    KEYCHAIN_BINDING_ASAR_PATH,
  );
  let imageIdentity;
  try {
    imageIdentity = await (
      overrides.inspectBindingImage ??
      (async (path) => machoBundleIdentity(await readFile(path), KEYCHAIN_BINDING_ASAR_PATH))
    )(binding);
  } catch {
    fail("macOS keychain binding image is invalid");
  }
  await runSystemVerification(
    executeFile,
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", binding],
    "macOS keychain binding signature verification failed",
  );
  let signatureResult;
  let requirementResult;
  try {
    [signatureResult, requirementResult] = await Promise.all([
      executeFile("/usr/bin/codesign", ["--display", "--verbose=4", binding]),
      executeFile("/usr/bin/codesign", ["--display", "--requirements", "-", binding]),
    ]);
  } catch {
    fail("macOS keychain binding identity inspection failed");
  }
  const output = allCommandOutput(signatureResult);
  const identifier = exactLine(output, /^Identifier=([^\r\n]+)$/gmu);
  const teamIdentifier = exactLine(output, /^TeamIdentifier=([^\r\n]+)$/gmu);
  const authorities = Array.from(output.matchAll(/^Authority=([^\r\n]+)$/gmu), (match) => match[1]);
  const flags = exactLine(output, /^CodeDirectory [^\r\n]* flags=0x[0-9a-f]+\(([^\r\n)]*)\)/gimu);
  if (
    identifier === undefined ||
    !canonicalBindingIdentifierPattern.test(identifier) ||
    !hasCanonicalDeveloperIdApplicationIdentity(teamIdentifier, authorities) ||
    flags === undefined ||
    !flags
      .split(",")
      .map((flag) => flag.trim())
      .includes("runtime")
  ) {
    fail("macOS keychain binding signing identity is invalid");
  }
  const requirement = exactLine(allCommandOutput(requirementResult), /^designated => ([^\r\n]+)$/gmu)
    ?.replaceAll(/\s+/gu, " ")
    .trim();
  if (
    requirement === undefined ||
    requirement.length === 0 ||
    requirement.length > 16_384 ||
    !canonicalBindingDesignatedRequirementPattern.test(requirement)
  ) {
    fail("macOS keychain binding designated requirement is invalid");
  }
  return Object.freeze({
    binding,
    identifier,
    teamIdentifier,
    designatedRequirement: requirement,
    imageIdentity,
  });
}

export async function verifyMacosApplication(application, overrides = {}) {
  if (!isAbsolute(application)) fail("application path must be absolute");
  const executeFile = overrides.executeFile ?? executeSystemFile;
  await runSystemVerification(
    executeFile,
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", application],
    "macOS application signature verification failed",
  );
  await runSystemVerification(
    executeFile,
    "/usr/bin/xcrun",
    ["stapler", "validate", "-v", application],
    "macOS application staple verification failed",
  );
  await runSystemVerification(
    executeFile,
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", application],
    "macOS application Gatekeeper verification failed",
  );
}

export async function verifyMacosDmg(dmgPath, overrides = {}) {
  if (!isAbsolute(dmgPath)) fail("DMG path must be absolute");
  const executeFile = overrides.executeFile ?? executeSystemFile;
  await verifyMacosDmgSignature(dmgPath, executeFile);
  await verifyMacosDmgNotarization(dmgPath, executeFile);
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function installedBuildBlockMap(inputPath, compression, outputPath) {
  let electronBuilderManifest;
  let blockMapPackageManifest;
  let blockMapModule;
  try {
    electronBuilderManifest = localRequire("electron-builder/package.json");
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    blockMapPackageManifest = builderRequire("app-builder-lib/package.json");
    blockMapModule = builderRequire("app-builder-lib/out/targets/blockmap/blockmap");
  } catch {
    fail("electron-builder blockmap implementation is unavailable");
  }
  if (
    electronBuilderManifest.version !== supportedElectronBuilderVersion ||
    blockMapPackageManifest.version !== supportedElectronBuilderVersion ||
    typeof blockMapModule.buildBlockMap !== "function"
  ) {
    fail("electron-builder blockmap implementation is unsupported");
  }
  return blockMapModule.buildBlockMap(inputPath, compression, outputPath);
}

async function readRegularFile(path, label, dependencies) {
  let stat;
  try {
    stat = await dependencies.lstat(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`invalid ${label}`);
  let bytes;
  try {
    bytes = await dependencies.readFile(path);
  } catch {
    fail(`unreadable ${label}`);
  }
  if (bytes.length === 0) fail(`empty ${label}`);
  return bytes;
}

function parseMetadata(bytes) {
  let metadata;
  try {
    metadata = parse(bytes.toString("utf8"));
  } catch {
    fail("invalid latest-mac.yml");
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== 2 ||
    !exactObject(metadata.files[0]) ||
    !hasExactKeys(metadata.files[0], ["url", "sha512", "size"]) ||
    !exactObject(metadata.files[1]) ||
    !hasExactKeys(metadata.files[1], ["url", "sha512", "size"])
  ) {
    fail("invalid latest-mac.yml");
  }
  return metadata;
}

function validateReleaseDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function metadataFileMatches(file, name, sha512, size) {
  return (
    file.url === name &&
    file.sha512 === sha512 &&
    file.size === size &&
    Number.isSafeInteger(file.size) &&
    file.size > 0
  );
}

function isExpectedTemporaryDirectory(path, prefix) {
  return (
    isAbsolute(path) &&
    dirname(path) === dirname(prefix) &&
    path !== prefix &&
    basename(path).startsWith(basename(prefix))
  );
}

async function regenerateBlockmap(zipPath, dependencies) {
  const temporaryPrefix = join(dependencies.tmpdir(), "enduragent-blockmap-");
  let temporaryDirectory;
  let regenerated;
  try {
    const candidate = await dependencies.mkdtemp(temporaryPrefix);
    if (!isExpectedTemporaryDirectory(candidate, temporaryPrefix)) {
      fail("invalid temporary ZIP blockmap directory");
    }
    temporaryDirectory = candidate;
    const temporaryPath = join(temporaryDirectory, "expected.zip.blockmap");
    await dependencies.buildBlockMap(zipPath, "gzip", temporaryPath);
    regenerated = await readRegularFile(temporaryPath, "regenerated ZIP blockmap", dependencies);
  } catch {
    fail("unable to regenerate ZIP blockmap");
  } finally {
    if (temporaryDirectory !== undefined) {
      try {
        await dependencies.rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        fail("unable to clean regenerated ZIP blockmap");
      }
    }
  }
  return regenerated;
}

export async function verifyMacosReleaseArtifacts(artifactDirectory, options = {}, overrides = {}) {
  if (!isAbsolute(artifactDirectory)) fail("artifact directory must be absolute");
  const dependencies = {
    lstat: overrides.lstat ?? lstat,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    readFile: overrides.readFile ?? readFile,
    readdir: overrides.readdir ?? readdir,
    rm: overrides.rm ?? rm,
    tmpdir: overrides.tmpdir ?? tmpdir,
    buildBlockMap: overrides.buildBlockMap ?? installedBuildBlockMap,
    executeFile: overrides.executeFile ?? executeSystemFile,
    verifySignature: overrides.verifySignature,
    verifyNotarization: overrides.verifyNotarization,
  };
  const version = await readDesktopVersion({
    repositoryRoot: options.repositoryRoot,
    desktopRoot: options.desktopRoot,
    readFile: options.readVersionFile,
  });
  const names = releaseArtifactNames(version);
  let directoryStat;
  try {
    directoryStat = await dependencies.lstat(artifactDirectory);
  } catch {
    fail("release artifact directory is missing");
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail("release artifact directory is invalid");
  }
  let entries;
  try {
    entries = await dependencies.readdir(artifactDirectory);
  } catch {
    fail("release artifact directory is missing");
  }
  const expectedNames = Object.values(names).sort();
  const actualNames = [...entries].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail("release artifact envelope differs");
  }

  const paths = Object.freeze({
    dmg: join(artifactDirectory, names.dmg),
    zip: join(artifactDirectory, names.zip),
    blockmap: join(artifactDirectory, names.blockmap),
    metadata: join(artifactDirectory, names.metadata),
  });
  const [dmg, zip, blockmap, metadataBytes] = await Promise.all([
    readRegularFile(paths.dmg, "DMG artifact", dependencies),
    readRegularFile(paths.zip, "ZIP artifact", dependencies),
    readRegularFile(paths.blockmap, "ZIP blockmap", dependencies),
    readRegularFile(paths.metadata, "latest-mac.yml", dependencies),
  ]);
  const metadata = parseMetadata(metadataBytes);
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const zipFile = metadata.files[0];
  const dmgFile = metadata.files[1];
  if (
    metadata.version !== version ||
    metadata.path !== names.zip ||
    metadata.sha512 !== zipSha512 ||
    !validateReleaseDate(metadata.releaseDate) ||
    !metadataFileMatches(zipFile, names.zip, zipSha512, zip.length) ||
    !metadataFileMatches(dmgFile, names.dmg, dmgSha512, dmg.length)
  ) {
    fail("latest-mac.yml does not match the release artifacts");
  }

  const regeneratedBlockmap = await regenerateBlockmap(paths.zip, dependencies);
  if (!blockmap.equals(regeneratedBlockmap)) fail("ZIP blockmap does not match the ZIP artifact");

  const artifacts = Object.freeze({
    version,
    names,
    paths,
    sizes: Object.freeze({
      dmg: dmg.length,
      zip: zip.length,
      blockmap: blockmap.length,
    }),
    dmgSha512,
    zipSha512,
  });
  const verifySignature =
    dependencies.verifySignature ??
    ((verifiedArtifacts) =>
      verifyMacosDmgSignature(verifiedArtifacts.paths.dmg, dependencies.executeFile));
  const verifyNotarization =
    dependencies.verifyNotarization ??
    ((verifiedArtifacts) =>
      verifyMacosDmgNotarization(verifiedArtifacts.paths.dmg, dependencies.executeFile));
  await verifySignature(artifacts);
  await verifyNotarization(artifacts);
  return artifacts;
}

export async function verifyMacosReleaseEnvelope(
  artifactDirectory,
  baselineApplication,
  looseCandidateApplication,
  options = {},
  overrides = {},
) {
  const verifyReleaseArtifacts = overrides.verifyReleaseArtifacts ?? verifyMacosReleaseArtifacts;
  const artifacts = await verifyReleaseArtifacts(artifactDirectory, options, overrides);
  let candidateVersion;
  try {
    candidateVersion = requireStableSemVer(artifacts?.version);
  } catch {
    fail("verified release version is invalid");
  }
  const verifyIdentityContinuity =
    overrides.verifyIdentityContinuity ?? verifyMacosIdentityContinuity;
  const identityContinuity = await verifyIdentityContinuity(
    baselineApplication,
    looseCandidateApplication,
    { candidateVersion },
    overrides,
  );
  if (identityContinuity?.candidateVersion !== candidateVersion) {
    fail("loose candidate release identity is invalid");
  }
  const looseCandidateCodeIdentity = requireCandidateCodeIdentity(
    identityContinuity.candidateCodeIdentity,
  );
  const verifyReleaseApplicationContents =
    overrides.verifyReleaseApplicationContents ?? verifyMacosReleaseApplicationContents;
  await verifyReleaseApplicationContents(
    artifactDirectory,
    baselineApplication,
    { candidateVersion, looseCandidateCodeIdentity },
    overrides,
  );
  return Object.freeze({ artifacts, identityContinuity });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args.some((argument) => !isAbsolute(argument))) {
    fail("expected absolute artifact, baseline, and loose candidate paths");
  }
  await verifyMacosReleaseEnvelope(args[0], args[1], args[2]);
  process.stdout.write("macOS release envelope verified\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof MacosReleaseVerificationError
        ? error.message
        : "macOS release verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
