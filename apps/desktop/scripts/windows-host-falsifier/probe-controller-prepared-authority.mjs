import { Buffer } from "node:buffer";

import { validateEvidenceRelativePath } from "./evidence-store.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
} from "./probe-contract.mjs";
import { validatePreparedProbeContext } from "./probe-preflight.mjs";

export const PROBE_CONTROLLER_PREPARED_AUTHORITY_SCHEMA_VERSION = 1;
export const PROBE_CONTROLLER_PREPARED_AUTHORITY_KIND =
  "windows-host-probe-controller-prepared-authority";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const absolutePathPattern = /^(?:[\\/]|[A-Za-z]:[\\/]|file:(?:\/{0,2})[\\/])/iu;
const fieldKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "candidateSha256",
  "runPlanSha256",
  "runAuthorizationSha256",
  "runAuthorizationClaimReceiptSha256",
  "campaignRunId",
  "executionRunId",
  "executionBundleId",
  "executionBundleManifestSha256",
  "attemptId",
  "environmentId",
  "pathProfileId",
  "vmSnapshotId",
  "preflightSha256",
  "controller",
  "actors",
  "nativeHelper",
  "evidenceRootObjectIdentitySha256",
]);
const controllerKeys = Object.freeze(["identitySha256", "publicKeySha256", "version"]);
const actorKeys = Object.freeze([
  "primaryStandardUserSidSha256",
  "powerControlActorSha256",
  "snapshotControlActorSha256",
  "remotePeerActorSha256",
  "secondUserSidSha256",
]);
const nativeHelperKeys = Object.freeze([
  "artifactPath",
  "sha256",
  "nativeCandidateDigest",
  "nativeManifestSha256",
]);

export class ProbeControllerPreparedAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeControllerPreparedAuthorityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeControllerPreparedAuthorityError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertExactDataKeys(value, keys, label) {
  if (!exactObject(value)) {
    fail("CONTROLLER_PREPARED_AUTHORITY_SCHEMA", `${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("CONTROLLER_PREPARED_AUTHORITY_SCHEMA", `${label} has an invalid field set`);
  }
  const expected = [...keys].sort(compareUtf8);
  actual.sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("CONTROLLER_PREPARED_AUTHORITY_SCHEMA", `${label} has an invalid field set`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(
        "CONTROLLER_PREPARED_AUTHORITY_SCHEMA",
        `${label}.${key} must be an enumerable data property`,
      );
    }
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_PREPARED_AUTHORITY_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || value.length > 96 || !identifierPattern.test(value)) {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_IDENTIFIER",
      `${label} must be bounded lowercase kebab-case`,
    );
  }
  return value;
}

function requireBoundedString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  ) {
    fail("CONTROLLER_PREPARED_AUTHORITY_VALUE", `${label} must be a bounded NFC string`);
  }
  return value;
}

function requireArtifactPath(value) {
  try {
    return validateEvidenceRelativePath(value);
  } catch {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_ARTIFACT_PATH",
      "controller prepared authority native-helper artifact path must be safe and relative",
    );
  }
}

function assertRootFree(value, path = "controllerPreparedAuthority") {
  if (typeof value === "string") {
    if (absolutePathPattern.test(value)) {
      fail("CONTROLLER_PREPARED_AUTHORITY_ABSOLUTE_PATH", `${path} contains an absolute path`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertRootFree(entry, `${path}[${index}]`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidenceRoot" || absolutePathPattern.test(key)) {
      fail("CONTROLLER_PREPARED_AUTHORITY_ABSOLUTE_PATH", `${path} contains a local-root field`);
    }
    assertRootFree(entry, `${path}.${key}`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeFields(value) {
  assertExactDataKeys(value, fieldKeys, "controller prepared authority");
  if (
    value.schemaVersion !== PROBE_CONTROLLER_PREPARED_AUTHORITY_SCHEMA_VERSION ||
    value.kind !== PROBE_CONTROLLER_PREPARED_AUTHORITY_KIND ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_IDENTITY",
      "controller prepared authority identity is invalid",
    );
  }
  for (const key of [
    "manifestSha256",
    "candidateSha256",
    "runPlanSha256",
    "runAuthorizationSha256",
    "runAuthorizationClaimReceiptSha256",
    "executionBundleManifestSha256",
    "preflightSha256",
    "evidenceRootObjectIdentitySha256",
  ]) {
    requireSha256(value[key], `controllerPreparedAuthority.${key}`);
  }
  for (const key of [
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "attemptId",
    "vmSnapshotId",
  ]) {
    requireIdentifier(value[key], `controllerPreparedAuthority.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_ENVIRONMENT",
      "controller prepared authority environment is outside the campaign",
    );
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_PATH_PROFILE",
      "controller prepared authority path profile is outside the campaign",
    );
  }

  assertExactDataKeys(value.controller, controllerKeys, "controller prepared authority.controller");
  const controller = {
    identitySha256: requireSha256(
      value.controller.identitySha256,
      "controllerPreparedAuthority.controller.identitySha256",
    ),
    publicKeySha256: requireSha256(
      value.controller.publicKeySha256,
      "controllerPreparedAuthority.controller.publicKeySha256",
    ),
    version: requireBoundedString(
      value.controller.version,
      "controllerPreparedAuthority.controller.version",
    ),
  };

  assertExactDataKeys(value.actors, actorKeys, "controller prepared authority.actors");
  const actors = Object.fromEntries(
    actorKeys.map((key) => [
      key,
      requireSha256(value.actors[key], `controllerPreparedAuthority.actors.${key}`),
    ]),
  );
  if (new Set(Object.values(actors)).size !== actorKeys.length) {
    fail(
      "CONTROLLER_PREPARED_AUTHORITY_ACTORS",
      "controller prepared authority actors must be pairwise distinct",
    );
  }

  assertExactDataKeys(
    value.nativeHelper,
    nativeHelperKeys,
    "controller prepared authority.nativeHelper",
  );
  const nativeHelper = {
    artifactPath: requireArtifactPath(value.nativeHelper.artifactPath),
    sha256: requireSha256(
      value.nativeHelper.sha256,
      "controllerPreparedAuthority.nativeHelper.sha256",
    ),
    nativeCandidateDigest: requireSha256(
      value.nativeHelper.nativeCandidateDigest,
      "controllerPreparedAuthority.nativeHelper.nativeCandidateDigest",
    ),
    nativeManifestSha256: requireSha256(
      value.nativeHelper.nativeManifestSha256,
      "controllerPreparedAuthority.nativeHelper.nativeManifestSha256",
    ),
  };
  const fields = {
    schemaVersion: PROBE_CONTROLLER_PREPARED_AUTHORITY_SCHEMA_VERSION,
    kind: PROBE_CONTROLLER_PREPARED_AUTHORITY_KIND,
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    candidateSha256: value.candidateSha256,
    runPlanSha256: value.runPlanSha256,
    runAuthorizationSha256: value.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: value.runAuthorizationClaimReceiptSha256,
    campaignRunId: value.campaignRunId,
    executionRunId: value.executionRunId,
    executionBundleId: value.executionBundleId,
    executionBundleManifestSha256: value.executionBundleManifestSha256,
    attemptId: value.attemptId,
    environmentId: value.environmentId,
    pathProfileId: value.pathProfileId,
    vmSnapshotId: value.vmSnapshotId,
    preflightSha256: value.preflightSha256,
    controller,
    actors,
    nativeHelper,
    evidenceRootObjectIdentitySha256: value.evidenceRootObjectIdentitySha256,
  };
  assertRootFree(fields);
  canonicalProbeJson(fields);
  return fields;
}

export function validateProbeControllerPreparedAuthority(value) {
  return deepFreeze(normalizeFields(value));
}

export function createProbeControllerPreparedAuthority(preparedContext) {
  const prepared = validatePreparedProbeContext(preparedContext);
  const nativeHelper = prepared.executionBundleManifest.binaries.nativeHelper;
  const fields = {
    schemaVersion: PROBE_CONTROLLER_PREPARED_AUTHORITY_SCHEMA_VERSION,
    kind: PROBE_CONTROLLER_PREPARED_AUTHORITY_KIND,
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    runPlanSha256: prepared.runPlanSha256,
    runAuthorizationSha256: prepared.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: prepared.runAuthorizationClaimReceiptSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    vmSnapshotId: prepared.vmSnapshotId,
    preflightSha256: prepared.preflightSha256,
    controller: {
      identitySha256: prepared.executionBundleManifest.controller.identitySha256,
      publicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
      version: prepared.executionBundleManifest.controller.version,
    },
    actors: { ...prepared.executionBundleManifest.actors },
    nativeHelper: {
      artifactPath: nativeHelper.path,
      sha256: nativeHelper.sha256,
      nativeCandidateDigest: nativeHelper.nativeCandidateDigest,
      nativeManifestSha256: nativeHelper.nativeManifestSha256,
    },
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  };
  return deepFreeze(normalizeFields(fields));
}
