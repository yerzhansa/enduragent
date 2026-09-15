import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const safeMessages = new Set([
  "Windows verification evidence input is invalid",
  "Windows verification evidence release state is unknown",
  "release identity mismatch before evidence upload",
  "release assets changed before evidence upload",
  "existing Windows verification evidence conflicts with this run",
  "Windows verification evidence upload failed",
  "Windows verification evidence state is unknown",
  "release identity changed during evidence upload; verification evidence removed",
  "release assets changed during evidence upload; verification evidence removed",
  "Windows verification evidence state became unknown; created asset removed",
  "Windows verification evidence cleanup failed",
]);

async function executeSystemFile(executable, arguments_) {
  const result = await execFileAsync(executable, [...arguments_], { encoding: "utf8" });
  return { stdout: result.stdout };
}

async function uploadSystemAsset(uploadUrl, evidenceName, bytes) {
  const token = process.env.GH_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("Windows verification evidence upload failed");
  }
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(evidenceName)}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: bytes,
  });
  if (!response.ok) throw new TypeError("Windows verification evidence upload failed");
  try {
    return await response.json();
  } catch {
    throw new TypeError("Windows verification evidence state is unknown");
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function safeWindowsVerificationEvidenceMessage(error) {
  return error instanceof TypeError && safeMessages.has(error.message) ? error.message : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireInput(input) {
  const version = input?.version;
  const repository = input?.repository;
  const releaseId = input?.releaseId;
  const commit = input?.commit;
  const evidencePath = input?.evidencePath;
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version) ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    typeof releaseId !== "string" ||
    !/^[1-9]\d*$/u.test(releaseId) ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    typeof evidencePath !== "string" ||
    !isAbsolute(evidencePath)
  ) {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  const tag = `enduragent-desktop@${version}`;
  const evidenceName = `Enduragent-${version}-x64-verification.json`;
  if (basename(evidencePath) !== evidenceName) {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  return Object.freeze({ version, repository, releaseId, commit, evidencePath, tag, evidenceName });
}

function parseEvidence(bytes, input) {
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  if (
    !exactObject(evidence) ||
    !hasExactKeys(evidence, [
      "schemaVersion",
      "tag",
      "version",
      "commit",
      "catalog",
      "arch",
      "authenticode",
      "installerSha256",
      "publisherDnSha256",
      "files",
    ]) ||
    evidence.schemaVersion !== 3 ||
    evidence.tag !== input.tag ||
    evidence.version !== input.version ||
    evidence.commit !== input.commit ||
    !exactObject(evidence.catalog) ||
    !hasExactKeys(evidence.catalog, ["releaseGroupId", "revision", "digest"]) ||
    typeof evidence.catalog.releaseGroupId !== "string" ||
    !/^[0-9a-f]{40}$/u.test(evidence.catalog.releaseGroupId) ||
    evidence.catalog.releaseGroupId !== evidence.commit ||
    typeof evidence.catalog.revision !== "number" ||
    !Number.isSafeInteger(evidence.catalog.revision) ||
    evidence.catalog.revision < 1 ||
    typeof evidence.catalog.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(evidence.catalog.digest) ||
    evidence.arch !== "x64" ||
    evidence.authenticode !== "verified" ||
    typeof evidence.installerSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(evidence.installerSha256) ||
    typeof evidence.publisherDnSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(evidence.publisherDnSha256) ||
    !Array.isArray(evidence.files) ||
    evidence.files.length !== 3 ||
    !evidence.files.every(
      (file) =>
        exactObject(file) &&
        hasExactKeys(file, ["id", "name", "size", "sha256"]) &&
        Number.isSafeInteger(file.id) &&
        file.id > 0 &&
        typeof file.name === "string" &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        typeof file.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(file.sha256),
    )
  ) {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  const installerName = `Enduragent-${input.version}-x64.exe`;
  const expectedNames = [
    installerName,
    `Enduragent-${input.version}-x64.exe.blockmap`,
    "latest.yml",
  ].sort();
  const actualNames = evidence.files.map((file) => file.name).sort();
  if (
    actualNames.some((name, index) => name !== expectedNames[index]) ||
    new Set(evidence.files.map((file) => file.id)).size !== evidence.files.length ||
    evidence.files.find((file) => file.name === installerName)?.sha256 !== evidence.installerSha256
  ) {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  return Object.freeze({
    ...evidence,
    files: Object.freeze(evidence.files.map((file) => Object.freeze({ ...file }))),
  });
}

function parseRelease(stdout) {
  let release;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  if (
    !exactObject(release) ||
    !(
      (Number.isSafeInteger(release.id) && release.id > 0) ||
      (typeof release.id === "string" && /^[1-9]\d*$/u.test(release.id))
    ) ||
    typeof release.tag_name !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    typeof release.upload_url !== "string" ||
    !Array.isArray(release.assets)
  ) {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return release;
}

async function viewRelease(executeFile, repository, releaseId) {
  let result;
  try {
    result = await executeFile("gh", ["api", `repos/${repository}/releases/${releaseId}`]);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return parseRelease(result.stdout);
}

async function viewLatestRelease(executeFile, repository) {
  let result;
  try {
    result = await executeFile("gh", ["api", `repos/${repository}/releases/latest`]);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return parseRelease(result.stdout);
}

function parseGitObject(stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  const object = response?.object;
  if (
    !exactObject(object) ||
    (object.type !== "commit" && object.type !== "tag") ||
    typeof object.sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(object.sha)
  ) {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return object;
}

async function resolveTagCommit(executeFile, repository, tag) {
  let reference;
  try {
    const result = await executeFile("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]);
    reference = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  if (reference.type === "commit") return reference.sha;
  let peeled;
  try {
    const result = await executeFile("gh", [
      "api",
      `repos/${repository}/git/tags/${reference.sha}`,
    ]);
    peeled = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  if (peeled.type !== "commit") {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return peeled.sha;
}

function sameReleaseIdentity(release, input) {
  return (
    String(release.id) === input.releaseId &&
    release.tag_name === input.tag &&
    release.draft === false &&
    release.prerelease === false
  );
}

function releaseFilesMatch(release, expectedFiles) {
  return expectedFiles.every((expected) => {
    const matches = release.assets.filter(
      (asset) => exactObject(asset) && asset.name === expected.name,
    );
    return (
      matches.length === 1 &&
      matches[0].id === expected.id &&
      matches[0].state === "uploaded" &&
      matches[0].size === expected.size &&
      matches[0].digest === `sha256:${expected.sha256}`
    );
  });
}

function releaseUploadUrl(release, input) {
  const templateSuffix = "{?name,label}";
  if (!release.upload_url.endsWith(templateSuffix)) {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  const value = release.upload_url.slice(0, -templateSuffix.length);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== `/repos/${input.repository}/releases/${input.releaseId}/assets`
  ) {
    throw new TypeError("Windows verification evidence release state is unknown");
  }
  return url.toString();
}

async function requireReleaseIdentity(executeFile, input, expectedFiles) {
  const release = await viewRelease(executeFile, input.repository, input.releaseId);
  const latest = await viewLatestRelease(executeFile, input.repository);
  const tagCommit = await resolveTagCommit(executeFile, input.repository, input.tag);
  if (
    !sameReleaseIdentity(release, input) ||
    !sameReleaseIdentity(latest, input) ||
    tagCommit !== input.commit
  ) {
    throw new TypeError("release identity mismatch before evidence upload");
  }
  if (!releaseFilesMatch(release, expectedFiles) || !releaseFilesMatch(latest, expectedFiles)) {
    throw new TypeError("release assets changed before evidence upload");
  }
  return release;
}

function evidenceAssets(release, evidenceName) {
  return release.assets.filter((asset) => exactObject(asset) && asset.name === evidenceName);
}

function assetById(release, assetId) {
  return (
    release.assets.find(
      (asset) => exactObject(asset) && Number.isSafeInteger(asset.id) && asset.id === assetId,
    ) ?? null
  );
}

function requireAssetId(asset) {
  if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) {
    throw new TypeError("Windows verification evidence state is unknown");
  }
  return asset.id;
}

function requireCreatedAssetId(asset, evidenceName) {
  if (!exactObject(asset) || asset.name !== evidenceName) {
    throw new TypeError("Windows verification evidence state is unknown");
  }
  return requireAssetId(asset);
}

function assetMatches(asset, expected) {
  return (
    asset.state === "uploaded" && asset.size === expected.size && asset.digest === expected.digest
  );
}

function findSingleEvidenceAsset(release, evidenceName) {
  const assets = evidenceAssets(release, evidenceName);
  if (assets.length > 1) {
    throw new TypeError("Windows verification evidence state is unknown");
  }
  return assets[0] ?? null;
}

async function removeCreatedAsset(executeFile, input, assetId) {
  try {
    await executeFile("gh", [
      "api",
      "-X",
      "DELETE",
      `repos/${input.repository}/releases/assets/${assetId}`,
    ]);
  } catch {
    // A failed DELETE may mean that the owned asset was already removed or replaced.
  }
  try {
    const release = await viewRelease(executeFile, input.repository, input.releaseId);
    if (assetById(release, assetId) !== null) throw new TypeError();
  } catch {
    throw new TypeError("Windows verification evidence cleanup failed");
  }
}

async function removeCreatedAssetAfterFailure(executeFile, input, assetId, error) {
  await removeCreatedAsset(executeFile, input, assetId);
  if (
    error instanceof TypeError &&
    error.message === "release identity mismatch before evidence upload"
  ) {
    throw new TypeError(
      "release identity changed during evidence upload; verification evidence removed",
    );
  }
  if (
    error instanceof TypeError &&
    error.message === "release assets changed before evidence upload"
  ) {
    throw new TypeError(
      "release assets changed during evidence upload; verification evidence removed",
    );
  }
  throw new TypeError("Windows verification evidence state became unknown; created asset removed");
}

function createStagingName() {
  return `Enduragent-Windows-verification-staging-${randomBytes(24).toString("hex")}`;
}

async function reconcileStagedAsset(executeFile, input, stagingName, createdAssetId, delay) {
  let observedRelease = false;
  let observedAmbiguity = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const release = await viewRelease(executeFile, input.repository, input.releaseId);
      observedRelease = true;
      if (createdAssetId !== null) {
        const asset = assetById(release, createdAssetId);
        if (asset !== null) return { asset, assetId: createdAssetId };
      } else {
        const assets = evidenceAssets(release, stagingName);
        if (assets.length === 1) {
          const asset = assets[0];
          return { asset, assetId: requireAssetId(asset) };
        }
        if (assets.length > 1) observedAmbiguity = true;
      }
    } catch (error) {
      if (safeWindowsVerificationEvidenceMessage(error) === undefined) throw error;
    }
    if (attempt < 2) await delay(1_000);
  }
  if (observedAmbiguity || !observedRelease) {
    throw new TypeError("Windows verification evidence state is unknown");
  }
  return null;
}

async function promoteCreatedAsset(executeFile, input, assetId) {
  try {
    await executeFile("gh", [
      "api",
      "-X",
      "PATCH",
      "-f",
      `name=${input.evidenceName}`,
      `repos/${input.repository}/releases/assets/${assetId}`,
    ]);
  } catch {
    // The PATCH may have committed even when its response was lost.
  }
}

async function reconcilePromotion(executeFile, input, assetId, delay) {
  let observedRelease = false;
  let lastOwnedAsset = null;
  let lastRelease = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const release = await viewRelease(executeFile, input.repository, input.releaseId);
      observedRelease = true;
      lastRelease = release;
      const asset = assetById(release, assetId);
      if (asset !== null) {
        lastOwnedAsset = asset;
        if (asset.name === input.evidenceName) return { asset, release };
      }
    } catch (error) {
      if (safeWindowsVerificationEvidenceMessage(error) === undefined) throw error;
    }
    if (attempt < 2) await delay(1_000);
  }
  if (!observedRelease) {
    throw new TypeError("Windows verification evidence state is unknown");
  }
  return lastOwnedAsset === null ? null : { asset: lastOwnedAsset, release: lastRelease };
}

async function cleanupOwnedAssetForUnknownState(executeFile, input, assetId) {
  await removeCreatedAsset(executeFile, input, assetId);
  throw new TypeError("Windows verification evidence state became unknown; created asset removed");
}

async function recoverStagedAsset(
  executeFile,
  input,
  expected,
  stagingName,
  uploadResponseAssetId,
  delay,
) {
  let staging;
  try {
    staging = await reconcileStagedAsset(
      executeFile,
      input,
      stagingName,
      uploadResponseAssetId,
      delay,
    );
  } catch {
    if (uploadResponseAssetId !== null) {
      await cleanupOwnedAssetForUnknownState(executeFile, input, uploadResponseAssetId);
    }
    throw new TypeError("Windows verification evidence state is unknown");
  }
  if (staging === null) {
    if (uploadResponseAssetId === null) {
      throw new TypeError("Windows verification evidence upload failed");
    }
    await cleanupOwnedAssetForUnknownState(executeFile, input, uploadResponseAssetId);
  }
  if (staging.asset.name !== stagingName || !assetMatches(staging.asset, expected)) {
    await cleanupOwnedAssetForUnknownState(executeFile, input, staging.assetId);
  }
  return Object.freeze({ assetId: staging.assetId, name: stagingName });
}

async function stabilizeOwnedStagingAsset(executeFile, input, expectedFiles, expected, staging) {
  try {
    const release = await requireReleaseIdentity(executeFile, input, expectedFiles);
    const asset = assetById(release, staging.assetId);
    if (
      asset === null ||
      asset.name !== staging.name ||
      !assetMatches(asset, expected) ||
      evidenceAssets(release, input.evidenceName).length !== 0
    ) {
      throw new TypeError("Windows verification evidence state is unknown");
    }
  } catch (error) {
    await removeCreatedAssetAfterFailure(executeFile, input, staging.assetId, error);
  }
}

async function reconcileCanonicalAsset(executeFile, input, expected, assetId, delay) {
  const promoted = await reconcilePromotion(executeFile, input, assetId, delay);
  if (promoted !== null) {
    const canonicalAssets = evidenceAssets(promoted.release, input.evidenceName);
    if (
      promoted.asset.name === input.evidenceName &&
      canonicalAssets.length === 1 &&
      canonicalAssets[0].id === assetId &&
      assetMatches(promoted.asset, expected)
    ) {
      return;
    }
  }
  throw new TypeError("Windows verification evidence state is unknown");
}

async function stabilizePromotedAsset(executeFile, input, expectedFiles, expected, assetId) {
  try {
    const release = await requireReleaseIdentity(executeFile, input, expectedFiles);
    const asset = findSingleEvidenceAsset(release, input.evidenceName);
    if (asset === null || asset.id !== assetId || !assetMatches(asset, expected)) {
      throw new TypeError("Windows verification evidence state is unknown");
    }
  } catch (error) {
    await removeCreatedAssetAfterFailure(executeFile, input, assetId, error);
  }
}

export async function runWindowsVerificationEvidenceUpload(inputValue, dependencies = {}) {
  const input = requireInput(inputValue);
  const executeFile = dependencies.executeFile ?? executeSystemFile;
  const uploadAsset = dependencies.uploadAsset ?? uploadSystemAsset;
  const delay = dependencies.delay ?? wait;
  const read = dependencies.readFile ?? readFile;
  let bytes;
  try {
    bytes = await read(input.evidencePath);
  } catch {
    throw new TypeError("Windows verification evidence input is invalid");
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const evidence = parseEvidence(bytes, input);
  const expected = Object.freeze({
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });

  const boundaryRelease = await requireReleaseIdentity(executeFile, input, evidence.files);
  const existing = findSingleEvidenceAsset(boundaryRelease, input.evidenceName);
  if (existing !== null) {
    const assetId = requireAssetId(existing);
    if (!assetMatches(existing, expected)) {
      throw new TypeError("existing Windows verification evidence conflicts with this run");
    }
    const stableRelease = await requireReleaseIdentity(executeFile, input, evidence.files);
    const stableAsset = findSingleEvidenceAsset(stableRelease, input.evidenceName);
    if (
      stableAsset === null ||
      stableAsset.id !== assetId ||
      !assetMatches(stableAsset, expected)
    ) {
      throw new TypeError("Windows verification evidence state is unknown");
    }
    return Object.freeze({
      status: "existing",
      tag: input.tag,
      releaseId: input.releaseId,
      commit: input.commit,
      assetId,
      name: input.evidenceName,
      ...expected,
    });
  }

  const uploadUrl = releaseUploadUrl(boundaryRelease, input);
  const stagingName = createStagingName();
  let uploadResponseAssetId = null;
  try {
    const createdAsset = await uploadAsset(uploadUrl, stagingName, bytes);
    uploadResponseAssetId = requireCreatedAssetId(createdAsset, stagingName);
  } catch {
    uploadResponseAssetId = null;
  }

  const staging = await recoverStagedAsset(
    executeFile,
    input,
    expected,
    stagingName,
    uploadResponseAssetId,
    delay,
  );
  await stabilizeOwnedStagingAsset(executeFile, input, evidence.files, expected, staging);

  await promoteCreatedAsset(executeFile, input, staging.assetId);
  try {
    await reconcileCanonicalAsset(executeFile, input, expected, staging.assetId, delay);
  } catch {
    await cleanupOwnedAssetForUnknownState(executeFile, input, staging.assetId);
  }
  await stabilizePromotedAsset(executeFile, input, evidence.files, expected, staging.assetId);

  return Object.freeze({
    status: "uploaded",
    tag: input.tag,
    releaseId: input.releaseId,
    commit: input.commit,
    assetId: staging.assetId,
    name: input.evidenceName,
    ...expected,
  });
}

function parseArguments(arguments_) {
  const options = {
    version: "version",
    repository: "repository",
    "release-id": "releaseId",
    commit: "commit",
    evidence: "evidencePath",
  };
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    const key = typeof name === "string" && name.startsWith("--") ? name.slice(2) : "";
    const option = Object.hasOwn(options, key) ? options[key] : undefined;
    if (
      option === undefined ||
      value === undefined ||
      value.startsWith("--") ||
      Object.hasOwn(parsed, option)
    ) {
      throw new TypeError("Windows verification evidence input is invalid");
    }
    parsed[option] = value;
  }
  return parsed;
}

async function main() {
  const result = await runWindowsVerificationEvidenceUpload(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Windows verification evidence ${result.status}: ${result.name}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${safeWindowsVerificationEvidenceMessage(error) ?? "Windows verification evidence upload failed"}\n`,
    );
    process.exitCode = 1;
  }
}
