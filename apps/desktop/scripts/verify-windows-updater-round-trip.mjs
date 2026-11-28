import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  WINDOWS_RELEASE_METADATA_NAME,
  windowsReleaseArtifactNames,
} from "./windows-release-plan.mjs";
import { requireGenericFeedUrl, requireStableSemVer } from "./macos-release-plan.mjs";
import {
  WINDOWS_UPDATER_METADATA_MAX_BYTES,
  checkWindowsInstallerBlockmap,
} from "./verify-windows-release.mjs";
import {
  safeDifferentialBlockmapVerificationMessage,
  verifyDifferentialBlockmap,
} from "./verify-differential-blockmap.mjs";

const maximumPublisherNameCharacters = 512;
const invalidMetadataMessage = `${WINDOWS_RELEASE_METADATA_NAME} is invalid`;

class WindowsUpdaterRoundTripError extends Error {
  constructor(message) {
    super(message);
    this.name = "WindowsUpdaterRoundTripError";
  }
}

function fail(message) {
  throw new WindowsUpdaterRoundTripError(message);
}

export function safeWindowsUpdaterRoundTripMessage(error) {
  return error instanceof WindowsUpdaterRoundTripError ? error.message : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireRoundTripVersion(value) {
  try {
    return requireStableSemVer(value);
  } catch {
    fail("updater round-trip version must be stable SemVer");
  }
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function parseUpdaterMetadata(value) {
  let source;
  if (typeof value === "string") source = value;
  else if (value instanceof Uint8Array) source = Buffer.from(value).toString("utf8");
  else fail(invalidMetadataMessage);
  if (Buffer.byteLength(source, "utf8") > WINDOWS_UPDATER_METADATA_MAX_BYTES) {
    fail(invalidMetadataMessage);
  }
  let metadata;
  try {
    metadata = parse(source);
  } catch {
    fail(invalidMetadataMessage);
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== 1 ||
    !exactObject(metadata.files[0]) ||
    !hasExactKeys(metadata.files[0], ["url", "sha512", "size"])
  ) {
    fail(invalidMetadataMessage);
  }
  return metadata;
}

function validBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function installerDescriptor(value) {
  if (value instanceof Uint8Array) {
    return Object.freeze({
      sha512: createHash("sha512").update(value).digest("base64"),
      size: value.byteLength,
    });
  }
  if (
    !exactObject(value) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !validBase64(value.sha512)
  ) {
    fail("installer descriptor is invalid");
  }
  return Object.freeze({ sha512: value.sha512, size: value.size });
}

function canonicalReleaseDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function verifyMetadata(metadata, version, installer) {
  const installerName = windowsReleaseArtifactNames(version).installer;
  const file = metadata.files[0];
  if (metadata.version !== version) fail(`${WINDOWS_RELEASE_METADATA_NAME} version mismatch`);
  if (metadata.path !== installerName || file.url !== installerName) {
    fail(`${WINDOWS_RELEASE_METADATA_NAME} installer name mismatch`);
  }
  if (metadata.sha512 !== installer.sha512 || file.sha512 !== installer.sha512) {
    fail(`${WINDOWS_RELEASE_METADATA_NAME} installer sha512 mismatch`);
  }
  if (file.size !== installer.size) {
    fail(`${WINDOWS_RELEASE_METADATA_NAME} installer size mismatch`);
  }
  if (!canonicalReleaseDate(metadata.releaseDate)) fail(invalidMetadataMessage);
  return installerName;
}

function verifyBlockmap(value, installer) {
  if (!(installer instanceof Uint8Array)) fail("installer blockmap requires installer bytes");
  const message = checkWindowsInstallerBlockmap(value, installer);
  if (message !== null) fail(message);
}

function fullDistinguishedName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumPublisherNameCharacters ||
    value !== value.trim()
  ) {
    return false;
  }
  const rdns = value.split(", ");
  return (
    rdns.length >= 2 &&
    rdns.every((rdn) => {
      const equals = rdn.indexOf("=");
      return (
        equals > 0 &&
        equals < rdn.length - 1 &&
        rdn.slice(0, equals) === rdn.slice(0, equals).trim() &&
        rdn.slice(equals + 1) === rdn.slice(equals + 1).trim()
      );
    }) &&
    rdns.some((rdn) => rdn.startsWith("CN="))
  );
}

export function verifyWindowsUpdaterRoundTrip(input) {
  const baselineVersion = requireRoundTripVersion(input?.baseline?.version);
  const candidateVersion = requireRoundTripVersion(input?.candidate?.version);
  if (compareStableVersions(candidateVersion, baselineVersion) <= 0) {
    fail("updater round-trip candidate must be a higher version than the baseline");
  }

  const baselineMetadata = parseUpdaterMetadata(input.baseline.metadata);
  const candidateMetadata = parseUpdaterMetadata(input.candidate.metadata);
  const baselineInstaller = installerDescriptor(input.baseline.installer);
  const candidateInstaller = installerDescriptor(input.candidate.installer);
  verifyMetadata(baselineMetadata, baselineVersion, baselineInstaller);
  const candidateInstallerName = verifyMetadata(
    candidateMetadata,
    candidateVersion,
    candidateInstaller,
  );

  if (input.candidate.blockmap === undefined) fail("missing candidate installer blockmap");
  verifyBlockmap(input.candidate.blockmap, input.candidate.installer);
  let differential = null;
  if (input.baseline.blockmap !== undefined) {
    verifyBlockmap(input.baseline.blockmap, input.baseline.installer);
    try {
      differential = verifyDifferentialBlockmap(input.baseline.blockmap, input.candidate.blockmap, {
        oldArtifact: input.baseline.installer,
        newArtifact: input.candidate.installer,
      });
    } catch (error) {
      fail(
        safeDifferentialBlockmapVerificationMessage(error) ??
          "differential blockmap verification failed",
      );
    }
  }

  let feedUrl;
  try {
    feedUrl = requireGenericFeedUrl(input.preflight?.feedUrl);
  } catch {
    fail("updater preflight feed URL is invalid");
  }
  if (
    !exactObject(input.preflight) ||
    !hasExactKeys(input.preflight, [
      "feedUrl",
      "channel",
      "publisherName",
      "useMultipleRangeRequest",
      "disableWebInstaller",
      "verifyUpdateCodeSignature",
    ]) ||
    input.preflight.channel !== "latest" ||
    input.preflight.useMultipleRangeRequest !== false ||
    input.preflight.disableWebInstaller !== true ||
    input.preflight.verifyUpdateCodeSignature !== true
  ) {
    fail("updater preflight is invalid");
  }
  if (!fullDistinguishedName(input.preflight.publisherName)) {
    fail("updater preflight publisher name must be a full distinguished name");
  }
  const preflight = Object.freeze({
    feedUrl,
    channel: "latest",
    publisherName: input.preflight.publisherName,
    useMultipleRangeRequest: false,
    disableWebInstaller: true,
    verifyUpdateCodeSignature: true,
  });
  return Object.freeze({
    baselineVersion,
    candidateVersion,
    candidateInstallerName,
    candidateInstallerSha512: candidateInstaller.sha512,
    candidateInstallerSize: candidateInstaller.size,
    differential,
    preflight,
    authenticode: "pending-w19",
  });
}
