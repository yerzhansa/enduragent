import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  WINDOWS_PUBLISHER_DN_PLACEHOLDER,
  requireReleaseCommit,
  windowsReleaseArtifactNames,
  windowsUpdaterMetadataDigest,
} from "./windows-release-plan.mjs";
import {
  safeWindowsReleaseVerificationMessage,
  verifyWindowsReleaseAssets,
} from "./verify-windows-release.mjs";
import {
  createWindowsAuthenticodeVerifyMode,
  safeWindowsAuthenticodeMessage,
} from "./verify-windows-authenticode.mjs";
import { requireStableSemVer } from "./macos-release-plan.mjs";

const execFileAsync = promisify(execFile);
const defaultRepository = "yerzhansa/enduragent";
const safeWindowsReleaseUploadMessages = new Set([
  "release tag mismatch",
  "release tag is unresolvable",
  "release commit mismatch",
  "Windows release upload is incomplete",
  "Authenticode verification mode is required",
  "Windows publisher DN is invalid",
  "Authenticode thumbprint is invalid",
  "unsigned Windows installer refused",
  "artifact directory must be absolute",
  "upload record path must be absolute",
  "upload record must be outside the artifact directory",
  "app-update.yml path must be absolute",
  "app-update.yml is unreadable",
  "signed updater metadata binding is missing",
  "app-update.yml does not match the signed installer",
  "release is not the latest release",
  "release lost latest status during upload; Windows assets removed",
  "Windows release asset digest mismatch",
  "upload record already exists",
  "upload record directory is missing",
  "release repository is invalid",
]);
const safeReleaseStateMessagePattern =
  /^(?:release does not exist|release is still a draft|release is a prerelease): enduragent-desktop@[-A-Za-z0-9@._]+$/u;
const safeExistingAssetMessagePattern = /^Windows release asset already exists: [-A-Za-z0-9@._]+$/u;

async function executeSystemFile(executable, arguments_) {
  const result = await execFileAsync(executable, [...arguments_], { encoding: "utf8" });
  return { stdout: result.stdout };
}

export function safeWindowsReleaseUploadMessage(error) {
  return error instanceof TypeError &&
    (safeWindowsReleaseUploadMessages.has(error.message) ||
      safeReleaseStateMessagePattern.test(error.message) ||
      safeExistingAssetMessagePattern.test(error.message))
    ? error.message
    : undefined;
}

function requirePublisherDn(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value === WINDOWS_PUBLISHER_DN_PLACEHOLDER
  ) {
    throw new TypeError("Windows publisher DN is invalid");
  }
  return value;
}

function requireThumbprint(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new TypeError("Authenticode thumbprint is invalid");
  }
  return value;
}

function recordInsideDirectory(record, directory) {
  const path = relative(resolve(directory), resolve(record));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseLatestRelease(stdout) {
  let release;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new TypeError("release is not the latest release");
  }
  if (!release || typeof release !== "object" || typeof release.tag_name !== "string") {
    throw new TypeError("release is not the latest release");
  }
  return release.tag_name;
}

async function isLatestRelease(executeFile, repository, tag) {
  let result;
  try {
    result = await executeFile("gh-personal", ["api", `repos/${repository}/releases/latest`]);
  } catch {
    return "unknown";
  }
  try {
    return parseLatestRelease(result.stdout) === tag;
  } catch {
    return "unknown";
  }
}

async function requireLatestRelease(executeFile, repository, tag) {
  if ((await isLatestRelease(executeFile, repository, tag)) !== true) {
    throw new TypeError("release is not the latest release");
  }
}

function requireAssetId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Windows release upload is incomplete");
  }
  return value;
}

async function deleteReleaseAssets(executeFile, repository, assets, files) {
  for (const file of files) {
    const id = requireAssetId(assets.get(file.name)?.id);
    try {
      await executeFile("gh-personal", [
        "api",
        "-X",
        "DELETE",
        `repos/${repository}/releases/assets/${id}`,
      ]);
    } catch {
      throw new TypeError("Windows release upload is incomplete");
    }
  }
}

function parseReleaseAssets(stdout, tag) {
  let release;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new TypeError("Windows release asset digest mismatch");
  }
  if (
    !release ||
    typeof release !== "object" ||
    release.tag_name !== tag ||
    !Array.isArray(release.assets)
  ) {
    throw new TypeError("Windows release asset digest mismatch");
  }
  return new Map(
    release.assets.flatMap((asset) =>
      asset !== null && typeof asset === "object" && typeof asset.name === "string"
        ? [[asset.name, asset]]
        : [],
    ),
  );
}

async function reconcileAssetDigests(executeFile, repository, tag, files) {
  let result;
  try {
    result = await executeFile("gh-personal", ["api", `repos/${repository}/releases/tags/${tag}`]);
  } catch {
    throw new TypeError("Windows release asset digest mismatch");
  }
  const assets = parseReleaseAssets(result.stdout, tag);
  for (const file of files) {
    const asset = assets.get(file.name);
    if (
      asset === undefined ||
      asset.size !== file.size ||
      asset.digest !== `sha256:${file.sha256}`
    ) {
      throw new TypeError("Windows release asset digest mismatch");
    }
  }
  return assets;
}

function requireRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new TypeError("release repository is invalid");
  }
  return value;
}

function parseRelease(stdout, tag) {
  let release;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    typeof release.tagName !== "string" ||
    typeof release.isDraft !== "boolean" ||
    typeof release.isPrerelease !== "boolean" ||
    !Array.isArray(release.assets)
  ) {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  if (release.isDraft) throw new TypeError(`release is still a draft: ${tag}`);
  if (release.isPrerelease) throw new TypeError(`release is a prerelease: ${tag}`);
  if (release.tagName !== tag) throw new TypeError("release tag mismatch");
  return release;
}

async function viewRelease(executeFile, tag, repository) {
  let result;
  try {
    result = await executeFile("gh-personal", [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "id,tagName,isDraft,isPrerelease,assets",
    ]);
  } catch {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  return parseRelease(result.stdout, tag);
}

function releaseAssetNames(release) {
  return release.assets.flatMap((asset) =>
    asset !== null && typeof asset === "object" && typeof asset.name === "string"
      ? [asset.name]
      : [],
  );
}

function parseGitObject(stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  const object = response?.object;
  if (
    object === null ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    (object.type !== "commit" && object.type !== "tag") ||
    typeof object.sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(object.sha)
  ) {
    throw new TypeError("release tag is unresolvable");
  }
  return object;
}

async function resolveTagCommit(executeFile, repository, tag) {
  let reference;
  try {
    const result = await executeFile("gh-personal", [
      "api",
      `repos/${repository}/git/ref/tags/${tag}`,
    ]);
    reference = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  if (reference.type === "commit") return reference.sha;
  let peeled;
  try {
    const result = await executeFile("gh-personal", [
      "api",
      `repos/${repository}/git/tags/${reference.sha}`,
    ]);
    peeled = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  if (peeled.type !== "commit") throw new TypeError("release tag is unresolvable");
  return peeled.sha;
}

function releaseFileRecords(verified) {
  const entries = [
    [verified.names.installer, verified.bytes.installer, verified.sizes.installer],
    [verified.names.blockmap, verified.bytes.blockmap, verified.sizes.blockmap],
    [verified.names.metadata, verified.bytes.metadata, verified.sizes.metadata],
  ];
  return Object.freeze(
    entries.map(([name, bytes, size]) => {
      if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
        throw new TypeError("Windows release upload is incomplete");
      }
      return Object.freeze({
        name,
        size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }),
  );
}

async function stageVerifiedBytes(verified, dependencies) {
  const directory = await dependencies.mkdtemp(join(tmpdir(), "enduragent-windows-release-"));
  await dependencies.chmod(directory, 0o700);
  const paths = {};
  for (const key of ["installer", "blockmap", "metadata"]) {
    const path = join(directory, verified.names[key]);
    await dependencies.writeFile(path, verified.bytes[key], { flag: "wx", mode: 0o400 });
    paths[key] = path;
  }
  return Object.freeze({ directory, paths: Object.freeze(paths) });
}

export async function runWindowsReleaseUpload(input, dependencies = {}) {
  const version = requireStableSemVer(input.version);
  const commit = requireReleaseCommit(input.commit);
  if (typeof input.directory !== "string" || !isAbsolute(input.directory)) {
    throw new TypeError("artifact directory must be absolute");
  }
  if (input.authenticode !== "verify") {
    throw new TypeError("Authenticode verification mode is required");
  }
  const publisherDn = requirePublisherDn(input.publisherDn);
  const thumbprint = requireThumbprint(input.thumbprint);
  const authenticodeMode = createWindowsAuthenticodeVerifyMode({
    expectedPublisherDn: publisherDn,
    expectedThumbprint: thumbprint,
  });
  const repository = requireRepository(input.repo ?? defaultRepository);
  if (input.record !== undefined && !isAbsolute(input.record)) {
    throw new TypeError("upload record path must be absolute");
  }
  if (input.record !== undefined && recordInsideDirectory(input.record, input.directory)) {
    throw new TypeError("upload record must be outside the artifact directory");
  }
  if (typeof input.appUpdateMetadata !== "string" || !isAbsolute(input.appUpdateMetadata)) {
    throw new TypeError("app-update.yml path must be absolute");
  }
  const executeFile = dependencies.executeFile ?? executeSystemFile;
  const verifyAssets = dependencies.verifyAssets ?? verifyWindowsReleaseAssets;
  const fileDependencies = {
    readFile: dependencies.readFile ?? readFile,
    writeFile: dependencies.writeFile ?? writeFile,
    mkdtemp: dependencies.mkdtemp ?? mkdtemp,
    chmod: dependencies.chmod ?? chmod,
    rm: dependencies.rm ?? rm,
  };
  const tag = `enduragent-desktop@${version}`;
  const expectedNames = Object.values(windowsReleaseArtifactNames(version));
  if (input.record !== undefined) {
    try {
      await fileDependencies.writeFile(input.record, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code === "EEXIST") throw new TypeError("upload record already exists");
      if (error?.code === "ENOENT") throw new TypeError("upload record directory is missing");
      throw error;
    }
  }
  let uploaded = false;
  let uploadedAssets = [];
  let staging;
  const reconcile = async () => {
    try {
      const current = await viewRelease(executeFile, tag, repository);
      const currentNames = new Set(releaseAssetNames(current));
      uploadedAssets = expectedNames.filter((name) => currentNames.has(name));
      uploaded = uploadedAssets.length > 0;
    } catch {
      uploadedAssets = null;
      uploaded = "unknown";
    }
  };
  try {
    let appUpdateMetadata;
    try {
      appUpdateMetadata = await fileDependencies.readFile(input.appUpdateMetadata);
    } catch {
      throw new TypeError("app-update.yml is unreadable");
    }
    const verified = await verifyAssets(input.directory, {
      version,
      commit,
      expectedPublisherName: publisherDn,
      appUpdateMetadata,
      authenticode: authenticodeMode,
    });
    if (verified.authenticode !== "verified") {
      throw new TypeError("unsigned Windows installer refused");
    }
    if (
      typeof verified.updaterMetadataSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(verified.updaterMetadataSha256)
    ) {
      throw new TypeError("signed updater metadata binding is missing");
    }
    if (verified.updaterMetadataSha256 !== windowsUpdaterMetadataDigest(appUpdateMetadata)) {
      throw new TypeError("app-update.yml does not match the signed installer");
    }
    const files = releaseFileRecords(verified);
    staging = await stageVerifiedBytes(verified, fileDependencies);
    const release = await viewRelease(executeFile, tag, repository);
    await requireLatestRelease(executeFile, repository, tag);
    const tagCommit = await resolveTagCommit(executeFile, repository, tag);
    if (tagCommit !== commit) throw new TypeError("release commit mismatch");
    const existingNames = new Set(releaseAssetNames(release));
    for (const name of expectedNames) {
      if (existingNames.has(name)) {
        throw new TypeError(`Windows release asset already exists: ${name}`);
      }
    }
    try {
      await executeFile("gh-personal", [
        "release",
        "upload",
        tag,
        "--repo",
        repository,
        staging.paths.installer,
        staging.paths.blockmap,
        staging.paths.metadata,
      ]);
    } catch (error) {
      await reconcile();
      if (uploaded !== false) throw new TypeError("Windows release upload is incomplete");
      throw error;
    }
    uploaded = true;
    await reconcile();
    if (uploadedAssets === null || uploadedAssets.length !== expectedNames.length) {
      throw new TypeError("Windows release upload is incomplete");
    }
    const assets = await reconcileAssetDigests(executeFile, repository, tag, files);
    const stillLatest = await isLatestRelease(executeFile, repository, tag);
    if (stillLatest === "unknown") throw new TypeError("Windows release upload is incomplete");
    if (stillLatest === false) {
      try {
        await deleteReleaseAssets(executeFile, repository, assets, files);
      } finally {
        await reconcile();
      }
      if (uploaded !== false) throw new TypeError("Windows release upload is incomplete");
      throw new TypeError("release lost latest status during upload; Windows assets removed");
    }
    const record = Object.freeze({
      schemaVersion: 1,
      tag,
      version,
      commit,
      tagCommit,
      arch: "x64",
      status: "uploaded",
      authenticode: verified.authenticode,
      updaterMetadataSha256: verified.updaterMetadataSha256,
      files,
    });
    if (input.record !== undefined) {
      await fileDependencies.writeFile(input.record, `${JSON.stringify(record, null, 2)}\n`, {
        flag: "w",
        mode: 0o600,
      });
    }
    return record;
  } catch (error) {
    if (input.record !== undefined) {
      const failureRecord = {
        schemaVersion: 1,
        tag,
        version,
        commit,
        arch: "x64",
        status: "failed",
        error:
          safeWindowsReleaseUploadMessage(error) ??
          safeWindowsReleaseVerificationMessage(error) ??
          safeWindowsAuthenticodeMessage(error) ??
          "Windows release upload failed",
        uploaded,
        uploadedAssets,
      };
      try {
        await fileDependencies.writeFile(
          input.record,
          `${JSON.stringify(failureRecord, null, 2)}\n`,
          { flag: "w", mode: 0o600 },
        );
      } catch {}
    }
    throw error;
  } finally {
    if (staging !== undefined) {
      try {
        await fileDependencies.rm(staging.directory, { recursive: true, force: true });
      } catch {}
    }
  }
}

const commandOptions = Object.freeze({
  version: "version",
  directory: "directory",
  commit: "commit",
  authenticode: "authenticode",
  "publisher-dn": "publisherDn",
  thumbprint: "thumbprint",
  "app-update-metadata": "appUpdateMetadata",
  repo: "repo",
  record: "record",
});

function parseArguments(arguments_) {
  const parsed = { repo: defaultRepository };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || !name.startsWith("--") || value.startsWith("--")) {
      throw new TypeError("Windows release upload failed");
    }
    const key = name.slice(2);
    const option = Object.hasOwn(commandOptions, key) ? commandOptions[key] : undefined;
    if (option === undefined) throw new TypeError("Windows release upload failed");
    if (Object.hasOwn(parsed, option) && option !== "repo") {
      throw new TypeError("Windows release upload failed");
    }
    parsed[option] = value;
  }
  return parsed;
}

async function main() {
  const result = await runWindowsReleaseUpload(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Windows release uploaded ${result.tag}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message =
      safeWindowsReleaseUploadMessage(error) ??
      safeWindowsReleaseVerificationMessage(error) ??
      safeWindowsAuthenticodeMessage(error) ??
      "Windows release upload failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
