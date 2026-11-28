import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  requireGenericFeedUrl,
  requireStableSemVer,
} from "./macos-release-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalRepositoryRoot = resolve(scriptDirectory, "../../..");
const scriptRequire = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(scriptRequire.resolve("electron-builder"));
const { serializeToYaml } = electronBuilderRequire("builder-util");
const safeWindowsReleaseAssetMessagePattern =
  /^(?:duplicate|unknown|missing) Windows release asset: [-A-Za-z0-9@._]+$/u;
const safeWindowsReleasePlanMessages = new Set([
  "desktop release version must be stable SemVer",
  "release feed URL is invalid",
  "release commit must be a full lowercase SHA-1",
  "Windows release mode must be genesis or steady",
  "genesis Windows release must not name a baseline",
  "steady Windows release requires a lower stable baseline version",
  "release updater metadata is invalid",
  "release updater publisher name mismatch",
  "Windows publisher DN is invalid",
]);

export const WINDOWS_RELEASE_ARCH = "x64";
export const WINDOWS_RELEASE_PLATFORM = "win32";
export const WINDOWS_RELEASE_METADATA_NAME = "latest.yml";
export const WINDOWS_AUTHENTICODE_PENDING = "pending-w19";
export const WINDOWS_PUBLISHER_DN_PLACEHOLDER =
  "CN=ENDURAGENT PUBLISHER DN PLACEHOLDER, O=PLACEHOLDER";
export const WINDOWS_RELEASE_PROVENANCE_PREFIX = "enduragent-release-commit:";
export const WINDOWS_UPDATER_PUBLISHER_PREFIX = "enduragent-updater-publisher-sha256:";
export const WINDOWS_UPDATER_METADATA_PREFIX = "enduragent-updater-metadata-sha256:";

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function freezeBuilderOptions(
  desktopRoot,
  version,
  commit,
  feedUrl,
  publisherDn,
  updaterMetadataSha256,
) {
  const publish = Object.freeze([
    Object.freeze({
      provider: "generic",
      url: feedUrl,
      channel: "latest",
      useMultipleRangeRequest: false,
    }),
  ]);
  const target = Object.freeze([
    Object.freeze({ target: "nsis", arch: Object.freeze([WINDOWS_RELEASE_ARCH]) }),
  ]);
  const config = Object.freeze({
    extends: join(desktopRoot, "electron-builder.yml"),
    artifactName: `Enduragent-${version}-x64.\${ext}`,
    forceCodeSigning: true,
    extraMetadata: Object.freeze({ version, enduragentDesktopRelease: true }),
    publish,
    win: Object.freeze({
      signtoolOptions: Object.freeze({
        publisherName: Object.freeze([publisherDn]),
      }),
      signExecutable: true,
      verifyUpdateCodeSignature: true,
      legalTrademarks: windowsReleaseProvenance(commit, publisherDn, updaterMetadataSha256),
      target,
    }),
    nsis: Object.freeze({
      artifactName: `Enduragent-${version}-x64.\${ext}`,
      differentialPackage: true,
    }),
  });
  return Object.freeze({
    projectDir: desktopRoot,
    publish: "never",
    win: Object.freeze([`nsis:${WINDOWS_RELEASE_ARCH}`]),
    config,
  });
}

export function safeWindowsReleasePlanMessage(error) {
  return error instanceof TypeError &&
    (safeWindowsReleasePlanMessages.has(error.message) ||
      safeWindowsReleaseAssetMessagePattern.test(error.message))
    ? error.message
    : undefined;
}

export function requireReleaseCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError("release commit must be a full lowercase SHA-1");
  }
  return value;
}

export function windowsUpdaterPublisherDigest(publisherDn) {
  if (typeof publisherDn !== "string" || publisherDn.length === 0) {
    throw new TypeError("Windows publisher DN is invalid");
  }
  return createHash("sha256").update(publisherDn, "utf8").digest("hex");
}

export function serializeWindowsReleaseUpdaterMetadata(feedUrl, publisherDn) {
  const url = requireGenericFeedUrl(feedUrl);
  if (
    typeof publisherDn !== "string" ||
    publisherDn.length === 0 ||
    publisherDn !== publisherDn.trim()
  ) {
    throw new TypeError("Windows publisher DN is invalid");
  }
  return Buffer.from(
    serializeToYaml({
      provider: "generic",
      url,
      channel: "latest",
      useMultipleRangeRequest: false,
      updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
      publisherName: [publisherDn],
    }),
    "utf8",
  );
}

export function windowsUpdaterMetadataDigest(bytes) {
  if (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) {
    throw new TypeError("release updater metadata is invalid");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha256(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("release updater metadata is invalid");
  }
  return value;
}

export function windowsReleaseProvenance(commit, publisherDn, updaterMetadataSha256) {
  return `${WINDOWS_RELEASE_PROVENANCE_PREFIX}${requireReleaseCommit(commit)} ${WINDOWS_UPDATER_PUBLISHER_PREFIX}${windowsUpdaterPublisherDigest(publisherDn)} ${WINDOWS_UPDATER_METADATA_PREFIX}${requireSha256(updaterMetadataSha256)}`;
}

export function parseWindowsReleaseProvenance(value) {
  if (typeof value !== "string") return null;
  const tokens = value.split(" ");
  if (
    tokens.length !== 3 ||
    !tokens[0].startsWith(WINDOWS_RELEASE_PROVENANCE_PREFIX) ||
    !tokens[1].startsWith(WINDOWS_UPDATER_PUBLISHER_PREFIX) ||
    !tokens[2].startsWith(WINDOWS_UPDATER_METADATA_PREFIX)
  ) {
    return null;
  }
  const commit = tokens[0].slice(WINDOWS_RELEASE_PROVENANCE_PREFIX.length);
  const publisherSha256 = tokens[1].slice(WINDOWS_UPDATER_PUBLISHER_PREFIX.length);
  const updaterMetadataSha256 = tokens[2].slice(WINDOWS_UPDATER_METADATA_PREFIX.length);
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !/^[0-9a-f]{64}$/u.test(publisherSha256) ||
    !/^[0-9a-f]{64}$/u.test(updaterMetadataSha256)
  ) {
    return null;
  }
  return Object.freeze({ commit, publisherSha256, updaterMetadataSha256 });
}

export function windowsReleaseArtifactNames(version) {
  const stableVersion = requireStableSemVer(version);
  const installer = `Enduragent-${stableVersion}-${WINDOWS_RELEASE_ARCH}.exe`;
  return Object.freeze({
    installer,
    blockmap: `${installer}.blockmap`,
    metadata: WINDOWS_RELEASE_METADATA_NAME,
  });
}

export function windowsReleaseAssetNames(version) {
  return Object.freeze(Object.values(windowsReleaseArtifactNames(version)).sort());
}

export function assertKnownWindowsReleaseAssets(names, version) {
  if (!Array.isArray(names)) throw new TypeError("unknown Windows release asset: latest.yml");
  const expected = windowsReleaseAssetNames(version);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new TypeError(`duplicate Windows release asset: ${duplicate}`);
  const seen = new Set();
  for (const name of names) {
    seen.add(name);
    if (!expected.includes(name)) throw new TypeError(`unknown Windows release asset: ${name}`);
  }
  for (const name of expected) {
    if (!seen.has(name)) throw new TypeError(`missing Windows release asset: ${name}`);
  }
  return expected;
}

export function parseWindowsReleaseUpdaterMetadata(bytes, options = {}) {
  let metadata;
  try {
    const source =
      typeof bytes === "string"
        ? bytes
        : bytes instanceof Uint8Array
          ? Buffer.from(bytes).toString("utf8")
          : undefined;
    if (source === undefined) throw new TypeError();
    metadata = parse(source);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  const keys = ["provider", "url", "channel", "useMultipleRangeRequest", "updaterCacheDirName"];
  if (exactObject(metadata) && Object.hasOwn(metadata, "publisherName")) keys.push("publisherName");
  let publisherName;
  if (exactObject(metadata) && Object.hasOwn(metadata, "publisherName")) {
    publisherName =
      Array.isArray(metadata.publisherName) && metadata.publisherName.length === 1
        ? metadata.publisherName[0]
        : metadata.publisherName;
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, keys) ||
    metadata.provider !== "generic" ||
    metadata.channel !== "latest" ||
    metadata.useMultipleRangeRequest !== false ||
    metadata.updaterCacheDirName !== DESKTOP_UPDATER_CACHE_DIRECTORY ||
    (Object.hasOwn(metadata, "publisherName") &&
      (typeof publisherName !== "string" ||
        publisherName.length === 0 ||
        publisherName !== publisherName.trim()))
  ) {
    throw new TypeError("release updater metadata is invalid");
  }
  let url;
  try {
    url = requireGenericFeedUrl(metadata.url);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  if (
    Object.hasOwn(options, "expectedPublisherName") &&
    options.expectedPublisherName !== publisherName
  ) {
    throw new TypeError("release updater publisher name mismatch");
  }
  const result = {
    provider: "generic",
    url,
    channel: "latest",
    useMultipleRangeRequest: false,
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
  };
  if (publisherName !== undefined) result.publisherName = publisherName;
  return Object.freeze(result);
}

export async function readWindowsReleaseVersion(options = {}, dependencies = {}) {
  const repositoryRoot = options.repositoryRoot ?? canonicalRepositoryRoot;
  if (!isAbsolute(repositoryRoot)) throw new TypeError("repository root must be absolute");
  const desktopRoot = options.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const read = dependencies.readFile ?? readFile;
  let manifest;
  try {
    manifest = JSON.parse(await read(join(desktopRoot, "package.json"), "utf8"));
  } catch {
    throw new TypeError("desktop release manifest is invalid");
  }
  if (!exactObject(manifest) || !Object.hasOwn(manifest, "version")) {
    throw new TypeError("desktop release manifest is invalid");
  }
  return requireStableSemVer(manifest.version);
}

export function createWindowsReleasePlan(input) {
  const version = requireStableSemVer(input.version);
  const commit = requireReleaseCommit(input.commit);
  const feedUrl = requireGenericFeedUrl(input.feedUrl);
  const publisherDn =
    input.publisherDn === undefined ? WINDOWS_PUBLISHER_DN_PLACEHOLDER : input.publisherDn?.trim();
  if (typeof publisherDn !== "string" || publisherDn.length === 0) {
    throw new TypeError("Windows publisher DN is invalid");
  }
  if (input.mode !== "genesis" && input.mode !== "steady") {
    throw new TypeError("Windows release mode must be genesis or steady");
  }
  let baselineVersion = null;
  if (input.mode === "genesis") {
    if (input.baselineVersion !== undefined) {
      throw new TypeError("genesis Windows release must not name a baseline");
    }
  } else {
    try {
      baselineVersion = requireStableSemVer(input.baselineVersion);
    } catch {
      throw new TypeError("steady Windows release requires a lower stable baseline version");
    }
    if (compareStableVersions(baselineVersion, version) >= 0) {
      throw new TypeError("steady Windows release requires a lower stable baseline version");
    }
  }
  const repositoryRoot = input.repositoryRoot ?? canonicalRepositoryRoot;
  if (!isAbsolute(repositoryRoot)) throw new TypeError("repository root must be absolute");
  const desktopRoot = input.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const artifactNames = windowsReleaseArtifactNames(version);
  const assetNames = windowsReleaseAssetNames(version);
  const updaterMetadata = Object.freeze({
    provider: "generic",
    url: feedUrl,
    channel: "latest",
    useMultipleRangeRequest: false,
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
    publisherName: publisherDn,
  });
  const updaterMetadataSha256 = windowsUpdaterMetadataDigest(
    serializeWindowsReleaseUpdaterMetadata(feedUrl, publisherDn),
  );
  return Object.freeze({
    version,
    commit,
    tag: `enduragent-desktop@${version}`,
    platform: WINDOWS_RELEASE_PLATFORM,
    arch: WINDOWS_RELEASE_ARCH,
    mode: input.mode,
    baselineVersion,
    feedUrl,
    publisherDn,
    publisherDnIsPlaceholder: publisherDn === WINDOWS_PUBLISHER_DN_PLACEHOLDER,
    artifactNames,
    assetNames,
    updaterMetadata,
    updaterMetadataSha256,
    authenticode: WINDOWS_AUTHENTICODE_PENDING,
    builderOptions: freezeBuilderOptions(
      desktopRoot,
      version,
      commit,
      feedUrl,
      publisherDn,
      updaterMetadataSha256,
    ),
  });
}
