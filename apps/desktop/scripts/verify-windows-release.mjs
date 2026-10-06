import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse } from "yaml";
import {
  WINDOWS_AUTHENTICODE_PENDING,
  parseWindowsReleaseUpdaterMetadata,
  requireReleaseCommit,
  serializeWindowsReleaseUpdaterMetadata,
  windowsReleaseArtifactNames,
  windowsUpdaterMetadataDigest,
} from "./windows-release-plan.mjs";
import { requireStableSemVer } from "./macos-release-plan.mjs";
import { createWindowsAuthenticodeVerifyMode } from "./verify-windows-authenticode.mjs";

export const WINDOWS_UPDATER_METADATA_MAX_BYTES = 16_384;
const BLOCKMAP_CHECKSUM_BYTES = 18;
const scriptRequire = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(scriptRequire.resolve("electron-builder"));
const { blake2b } = electronBuilderRequire("@noble/hashes/blake2.js");

class WindowsReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WindowsReleaseVerificationError";
  }
}

function fail(message) {
  throw new WindowsReleaseVerificationError(message);
}

export function safeWindowsReleaseVerificationMessage(error) {
  return error instanceof WindowsReleaseVerificationError ? error.message : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

async function readRegularFile(path, label, dependencies, maximumBytes) {
  let stat;
  try {
    stat = await dependencies.lstat(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0
  ) {
    fail(`invalid ${label}`);
  }
  if (maximumBytes !== undefined && stat.size > maximumBytes) fail("latest.yml is invalid");
  let bytes;
  try {
    bytes = await dependencies.readFile(path);
  } catch {
    fail(`unreadable ${label}`);
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  let after;
  try {
    after = await dependencies.lstat(path);
  } catch {
    fail(`unreadable ${label}`);
  }
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    bytes.length !== stat.size ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.mode !== stat.mode ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs
  ) {
    fail(`invalid ${label}`);
  }
  return bytes;
}

function parseUpdaterMetadata(bytes) {
  let metadata;
  try {
    metadata = parse(bytes.toString("utf8"));
  } catch {
    fail("latest.yml is invalid");
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== 1 ||
    !exactObject(metadata.files[0]) ||
    !hasExactKeys(metadata.files[0], ["url", "sha512", "size"])
  ) {
    fail("latest.yml is invalid");
  }
  return metadata;
}

function canonicalReleaseDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function installerMetadataMatches(metadata, version, installerName, sha512, size) {
  const file = metadata.files[0];
  return (
    metadata.version === version &&
    metadata.path === installerName &&
    metadata.sha512 === sha512 &&
    canonicalReleaseDate(metadata.releaseDate) &&
    file.url === installerName &&
    file.sha512 === sha512 &&
    file.size === size &&
    Number.isSafeInteger(file.size) &&
    file.size > 0
  );
}

export function checkWindowsInstallerBlockmap(bytes, installer) {
  if (
    !(bytes instanceof Uint8Array) ||
    !(installer instanceof Uint8Array) ||
    bytes.length < 2 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b
  ) {
    return "installer blockmap is invalid";
  }
  let blockmap;
  try {
    blockmap = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    return "installer blockmap is invalid";
  }
  if (
    !exactObject(blockmap) ||
    !hasExactKeys(blockmap, ["version", "files"]) ||
    blockmap.version !== "2" ||
    !Array.isArray(blockmap.files) ||
    blockmap.files.length !== 1 ||
    !exactObject(blockmap.files[0]) ||
    !hasExactKeys(blockmap.files[0], ["name", "offset", "checksums", "sizes"])
  ) {
    return "installer blockmap is invalid";
  }
  const file = blockmap.files[0];
  if (
    file.name !== "file" ||
    file.offset !== 0 ||
    !Array.isArray(file.checksums) ||
    !Array.isArray(file.sizes) ||
    file.checksums.length === 0 ||
    file.checksums.length !== file.sizes.length ||
    !file.checksums.every(
      (checksum) =>
        validBase64(checksum) && Buffer.from(checksum, "base64").length === BLOCKMAP_CHECKSUM_BYTES,
    ) ||
    !file.sizes.every((size) => Number.isSafeInteger(size) && size > 0)
  ) {
    return "installer blockmap is invalid";
  }
  if (file.sizes.reduce((total, size) => total + size, 0) !== installer.length) {
    return "installer blockmap does not match the Windows installer";
  }
  let offset = file.offset;
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index];
    const expectedChecksum = Buffer.from(
      blake2b(installer.subarray(offset, offset + size), { dkLen: BLOCKMAP_CHECKSUM_BYTES }),
    ).toString("base64");
    if (file.checksums[index] !== expectedChecksum) {
      return "installer blockmap does not match the Windows installer";
    }
    offset += size;
  }
  return null;
}

function verifyBlockmap(bytes, installer) {
  const message = checkWindowsInstallerBlockmap(bytes, installer);
  if (message !== null) fail(message);
}

function requireVersion(value) {
  try {
    return requireStableSemVer(value);
  } catch {
    fail("desktop release version must be stable SemVer");
  }
}

function requireCommit(value) {
  try {
    return requireReleaseCommit(value);
  } catch {
    fail("release commit must be a full lowercase SHA-1");
  }
}

function requireAuthenticodeMode(value) {
  if (value === WINDOWS_AUTHENTICODE_PENDING) return value;
  if (exactObject(value) && typeof value.verify === "function") return value;
  fail("Authenticode verification mode is required");
}

export async function verifyWindowsReleaseAssets(artifactDirectory, options, overrides = {}) {
  if (!isAbsolute(artifactDirectory)) fail("artifact directory must be absolute");
  const version = requireVersion(options?.version);
  const commit = options?.commit === undefined ? null : requireCommit(options.commit);
  const authenticodeMode = requireAuthenticodeMode(options?.authenticode);
  if (authenticodeMode !== WINDOWS_AUTHENTICODE_PENDING && commit === null) {
    fail("release commit is required for Authenticode verification");
  }
  const dependencies = {
    lstat: overrides.lstat ?? lstat,
    readdir: overrides.readdir ?? readdir,
    readFile: overrides.readFile ?? readFile,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    chmod: overrides.chmod ?? chmod,
    writeFile: overrides.writeFile ?? writeFile,
    rm: overrides.rm ?? rm,
    notice: overrides.notice,
  };
  let directoryStat;
  try {
    directoryStat = await dependencies.lstat(artifactDirectory);
  } catch {
    fail("release artifact envelope differs");
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail("release artifact envelope differs");
  }
  let entries;
  try {
    entries = await dependencies.readdir(artifactDirectory);
  } catch {
    fail("release artifact envelope differs");
  }
  const names = windowsReleaseArtifactNames(version);
  const expectedNames = Object.values(names).sort();
  const actualNames = [...entries].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail("release artifact envelope differs");
  }
  const paths = Object.freeze({
    installer: join(artifactDirectory, names.installer),
    blockmap: join(artifactDirectory, names.blockmap),
    metadata: join(artifactDirectory, names.metadata),
  });
  const [installer, blockmap, metadataBytes] = await Promise.all([
    readRegularFile(paths.installer, "Windows installer", dependencies),
    readRegularFile(paths.blockmap, "installer blockmap", dependencies),
    readRegularFile(paths.metadata, "latest.yml", dependencies, WINDOWS_UPDATER_METADATA_MAX_BYTES),
  ]);
  const metadata = parseUpdaterMetadata(metadataBytes);
  const installerSha512 = createHash("sha512").update(installer).digest("base64");
  const installerSha256 = createHash("sha256").update(installer).digest("hex");
  if (
    !installerMetadataMatches(metadata, version, names.installer, installerSha512, installer.length)
  ) {
    fail("latest.yml does not match the Windows installer");
  }
  verifyBlockmap(blockmap, installer);
  let updaterMetadataSha256 = null;
  if (options.appUpdateMetadata !== undefined) {
    try {
      const updaterMetadataBytes =
        typeof options.appUpdateMetadata === "string"
          ? Buffer.from(options.appUpdateMetadata, "utf8")
          : Buffer.from(options.appUpdateMetadata);
      const updaterMetadata = parseWindowsReleaseUpdaterMetadata(
        updaterMetadataBytes,
        options.expectedPublisherName === undefined
          ? {}
          : { expectedPublisherName: options.expectedPublisherName },
      );
      if (updaterMetadata.publisherName === undefined) {
        throw new TypeError("release updater metadata is invalid");
      }
      const canonicalBytes = serializeWindowsReleaseUpdaterMetadata(
        updaterMetadata.url,
        updaterMetadata.publisherName,
      );
      if (!canonicalBytes.equals(updaterMetadataBytes)) {
        fail("release updater metadata is not canonical");
      }
      updaterMetadataSha256 = windowsUpdaterMetadataDigest(updaterMetadataBytes);
    } catch (error) {
      if (error instanceof WindowsReleaseVerificationError) throw error;
      fail(error instanceof TypeError ? error.message : "release updater metadata is invalid");
    }
  }
  let authenticode;
  if (authenticodeMode === WINDOWS_AUTHENTICODE_PENDING) {
    dependencies.notice?.("Authenticode verification is pending W19; signature not verified");
    authenticode = WINDOWS_AUTHENTICODE_PENDING;
  } else {
    let staging;
    try {
      staging = await dependencies.mkdtemp(join(tmpdir(), "enduragent-windows-verify-"));
      await dependencies.chmod(staging, 0o700);
      const stagedInstaller = join(staging, names.installer);
      await dependencies.writeFile(stagedInstaller, installer, { flag: "wx", mode: 0o400 });
      await authenticodeMode.verify(stagedInstaller, {
        version,
        commit,
        publisherName: options.expectedPublisherName,
        updaterMetadataSha256: updaterMetadataSha256 ?? undefined,
      });
    } catch {
      fail("Windows installer Authenticode verification failed");
    } finally {
      if (staging !== undefined) {
        try {
          await dependencies.rm(staging, { recursive: true, force: true });
        } catch {}
      }
    }
    authenticode = "verified";
  }
  return Object.freeze({
    version,
    commit,
    names,
    paths,
    sizes: Object.freeze({
      installer: installer.length,
      blockmap: blockmap.length,
      metadata: metadataBytes.length,
    }),
    installerSha512,
    installerSha256,
    files: Object.freeze(
      [
        [names.installer, installer],
        [names.blockmap, blockmap],
        [names.metadata, metadataBytes],
      ].map(([name, bytes]) =>
        Object.freeze({
          name,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      ),
    ),
    updaterMetadataSha256,
    authenticode,
    bytes: Object.freeze({ installer, blockmap, metadata: metadataBytes }),
  });
}

function parseArguments(arguments_) {
  let directory;
  let version;
  let commit;
  let authenticode;
  let publisherDn;
  let thumbprint;
  let allowSelfSignedTest = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--") && directory === undefined) {
      directory = argument;
      continue;
    }
    if (argument === "--allow-self-signed-test" && !allowSelfSignedTest) {
      allowSelfSignedTest = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) fail("Windows release verification failed");
    index += 1;
    if (argument === "--version" && version === undefined) version = value;
    else if (argument === "--commit" && commit === undefined) commit = value;
    else if (argument === "--authenticode" && authenticode === undefined) authenticode = value;
    else if (argument === "--publisher-dn" && publisherDn === undefined) publisherDn = value;
    else if (argument === "--thumbprint" && thumbprint === undefined) thumbprint = value;
    else fail("Windows release verification failed");
  }
  return { directory, version, commit, authenticode, publisherDn, thumbprint, allowSelfSignedTest };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  let authenticodeMode;
  if (
    arguments_.authenticode === WINDOWS_AUTHENTICODE_PENDING &&
    arguments_.publisherDn === undefined &&
    arguments_.thumbprint === undefined &&
    !arguments_.allowSelfSignedTest
  ) {
    authenticodeMode = WINDOWS_AUTHENTICODE_PENDING;
  } else if (
    arguments_.authenticode === "verify" &&
    arguments_.publisherDn !== undefined &&
    arguments_.commit !== undefined
  ) {
    authenticodeMode = createWindowsAuthenticodeVerifyMode({
      expectedPublisherDn: arguments_.publisherDn,
      expectedThumbprint: arguments_.thumbprint,
      allowSelfSignedTest: arguments_.allowSelfSignedTest,
    });
  } else {
    fail("Authenticode verification mode is required");
  }
  const result = await verifyWindowsReleaseAssets(
    arguments_.directory,
    {
      version: arguments_.version,
      commit: arguments_.commit,
      expectedPublisherName: arguments_.publisherDn,
      authenticode: authenticodeMode,
    },
    { notice: (message) => process.stderr.write(`${message}\n`) },
  );
  process.stdout.write(`Windows release envelope verified ${result.installerSha256}\n`);
  process.stdout.write(`Windows release evidence files ${JSON.stringify(result.files)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${safeWindowsReleaseVerificationMessage(error) ?? "Windows release verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
