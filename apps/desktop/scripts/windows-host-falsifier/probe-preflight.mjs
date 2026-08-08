import { createHash, createPublicKey } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  hashProbeCanonicalJson,
  validateLabAttestation,
  validateProbeCampaignManifest,
  validateProbeCandidateIdentity,
} from "./probe-contract.mjs";
import {
  validateProbeRunAuthorization,
  validateProbeRunAuthorizationClaimReceipt,
  verifyProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";
import {
  PROBE_BROKER_ENROLLMENT_KIND,
  createProbePreparedBrokerEnrollment,
  selectProbeBrokerEnrollments,
  validateProbeBrokerEnrollmentInventory,
  validateProbePreparedBrokerEnrollmentSet,
} from "./broker/mailbox-protocol.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const strictTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const controllerActorKeys = [
  "powerControlActorSha256",
  "snapshotControlActorSha256",
  "remotePeerActorSha256",
  "secondUserSidSha256",
];
const executionActorKeys = ["primaryStandardUserSidSha256", ...controllerActorKeys];
const forbiddenPreparedKeys = new Set([
  "outcome",
  "rowId",
  "selectedMechanism",
  "selectionDigest",
  "status",
  "variantId",
]);

export class ProbePreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbePreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbePreflightError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("PREFLIGHT_SCHEMA", `${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("PREFLIGHT_SCHEMA", `${label} has unexpected key ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("PREFLIGHT_SCHEMA", `${label} is missing key ${key}`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || value.length > 96 || !identifierPattern.test(value)) {
    fail("PREFLIGHT_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("PREFLIGHT_SHA256", `${label} must be lowercase 64-hex`);
  }
}

function assertTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("PREFLIGHT_TIMESTAMP", `${label} must be strict UTC ISO with milliseconds`);
  }
}

function assertArtifactReference(value, label) {
  assertExactKeys(value, ["path", "sha256"], label);
  if (typeof value.path !== "string" || value.path.length === 0) {
    fail("PREFLIGHT_ARTIFACT", `${label}.path must be non-empty`);
  }
  assertSha256(value.sha256, `${label}.sha256`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function assertNoAuthorityClaims(value, path = "preparedContext") {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertNoAuthorityClaims(entry, `${path}[${index}]`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenPreparedKeys.has(key)) {
      fail("PREFLIGHT_AUTHORITY", `${path} cannot contain probe authority field ${key}`);
    }
    assertNoAuthorityClaims(entry, `${path}.${key}`);
  }
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function brokerEnrollmentStaticFields(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: PROBE_BROKER_ENROLLMENT_KIND,
    environmentId: value.environmentId,
    brokerRole: value.brokerRole,
    brokerInstanceId: value.brokerInstanceId,
    mailboxRoot: value.mailboxRoot,
    mailboxSecurityProfile: value.mailboxSecurityProfile,
    mailboxAclSha256: value.mailboxAclSha256,
    journalRoot: value.journalRoot,
    journalSecurityProfile: value.journalSecurityProfile,
    journalRootAclSha256: value.journalRootAclSha256,
    journalDatabaseAclSha256: value.journalDatabaseAclSha256,
    processSidSha256: value.processSidSha256,
    peerAuthoritySha256: value.peerAuthoritySha256,
    brokerEnrollmentSha256: value.brokerEnrollmentSha256,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateRequest(value) {
  assertExactKeys(
    value,
    [
      "campaignRunId",
      "executionRunId",
      "executionBundleId",
      "attemptId",
      "environmentId",
      "pathProfileId",
      "vmSnapshotId",
      "bootIdSha256",
      "runnerSessionIdSha256",
      "nativeHelperArtifactPath",
      "nativeCandidateDigest",
      "nativeManifestSha256",
      "nsisArtifactPath",
    ],
    "request",
  );
  for (const key of ["campaignRunId", "executionRunId", "executionBundleId", "attemptId"]) {
    assertIdentifier(value[key], `request.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("PREFLIGHT_ENVIRONMENT", "request environment is outside the campaign");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("PREFLIGHT_PATH_PROFILE", "request path profile is outside the campaign");
  }
  assertIdentifier(value.vmSnapshotId, "request.vmSnapshotId");
  assertSha256(value.bootIdSha256, "request.bootIdSha256");
  assertSha256(value.runnerSessionIdSha256, "request.runnerSessionIdSha256");
  assertSha256(value.nativeCandidateDigest, "request.nativeCandidateDigest");
  assertSha256(value.nativeManifestSha256, "request.nativeManifestSha256");
  for (const key of ["nativeHelperArtifactPath", "nsisArtifactPath"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      fail("PREFLIGHT_ARTIFACT", `request.${key} must be a non-empty candidate artifact path`);
    }
  }
  if (value.nativeHelperArtifactPath === value.nsisArtifactPath) {
    fail("PREFLIGHT_BINARY", "native helper and NSIS must be distinct candidate artifacts");
  }
  return value;
}

function validateLifecyclePolicy(value, trustedEvaluationAt) {
  assertExactKeys(value, ["policyId", "evaluatedAt", "mappings"], "lifecyclePolicy");
  assertIdentifier(value.policyId, "lifecyclePolicy.policyId");
  assertTimestamp(value.evaluatedAt, "lifecyclePolicy.evaluatedAt");
  assertTimestamp(trustedEvaluationAt, "trustedEvaluationAt");
  const trustedTime = Date.parse(trustedEvaluationAt);
  const policyTime = Date.parse(value.evaluatedAt);
  if (policyTime > trustedTime) {
    fail("PREFLIGHT_LIFECYCLE_FUTURE", "lifecycle policy evaluation is in the future");
  }
  if (trustedTime - policyTime > 24 * 60 * 60 * 1_000) {
    fail("PREFLIGHT_LIFECYCLE_STALE", "lifecycle policy evaluation is older than 24 hours");
  }
  if (!Array.isArray(value.mappings) || value.mappings.length !== PROBE_ENVIRONMENT_IDS.length) {
    fail("PREFLIGHT_LIFECYCLE", "lifecycle policy must map both campaign environments");
  }
  const expected = new Map([
    ["win11-floor", { role: "floor", windowsVersion: "24H2" }],
    ["win11-current", { role: "current", windowsVersion: "25H2" }],
  ]);
  const mappings = new Map();
  for (const mapping of value.mappings) {
    assertExactKeys(
      mapping,
      [
        "environmentId",
        "role",
        "windowsVersion",
        "minimumBuild",
        "maximumBuild",
        "supportedFrom",
        "supportedUntil",
        "declaredSupported",
      ],
      "lifecyclePolicy.mapping",
    );
    const required = expected.get(mapping.environmentId);
    if (
      required === undefined ||
      mappings.has(mapping.environmentId) ||
      mapping.role !== required.role ||
      mapping.windowsVersion !== required.windowsVersion ||
      mapping.declaredSupported !== true
    ) {
      fail("PREFLIGHT_LIFECYCLE", "lifecycle environment mapping is invalid");
    }
    if (
      !Number.isSafeInteger(mapping.minimumBuild) ||
      mapping.minimumBuild < 22_000 ||
      (mapping.maximumBuild !== null &&
        (!Number.isSafeInteger(mapping.maximumBuild) ||
          mapping.maximumBuild < mapping.minimumBuild))
    ) {
      fail("PREFLIGHT_LIFECYCLE", "lifecycle build range is invalid");
    }
    assertTimestamp(mapping.supportedFrom, "lifecyclePolicy.mapping.supportedFrom");
    assertTimestamp(mapping.supportedUntil, "lifecyclePolicy.mapping.supportedUntil");
    if (
      Date.parse(mapping.supportedFrom) > trustedTime ||
      trustedTime >= Date.parse(mapping.supportedUntil)
    ) {
      fail("PREFLIGHT_LIFECYCLE_STALE", `${mapping.environmentId} is outside active servicing`);
    }
    mappings.set(mapping.environmentId, mapping);
  }
  return {
    mappings,
    sha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-lifecycle-policy.v1",
      policy: value,
    }),
  };
}

function validateRepositoryState(value, candidate) {
  assertExactKeys(
    value,
    ["repositoryCommit", "repositoryDirty", "sourceHashes"],
    "repositoryState",
  );
  if (!commitPattern.test(value.repositoryCommit)) {
    fail("PREFLIGHT_REPOSITORY", "repository commit must be lowercase 40-hex");
  }
  if (value.repositoryDirty !== false) {
    fail("PREFLIGHT_REPOSITORY_DIRTY", "authoritative probe requires a clean repository");
  }
  if (
    value.repositoryCommit !== candidate.repositoryCommit ||
    !canonicalEqual(value.sourceHashes, candidate.sourceHashes)
  ) {
    fail("PREFLIGHT_SOURCE_DRIFT", "live repository does not match the candidate source identity");
  }
  return {
    repositoryCommit: value.repositoryCommit,
    sourceSetSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-source-set.v1",
      sourceHashes: value.sourceHashes,
    }),
  };
}

function assertRuntimeMatchesCandidate(runtime, candidate) {
  const pairs = [
    ["nodeVersion", "nodeVersion"],
    ["powerShellVersion", "powerShellVersion"],
    ["powerShellEdition", "powerShellEdition"],
    ["powerShellExecutableSha256", "powerShellExecutableSha256"],
    ["clrVersion", "clrVersion"],
    ["electronVersion", "electronVersion"],
    ["electronBuilderVersion", "electronBuilderVersion"],
    ["updaterVersion", "updaterVersion"],
    ["nsisVersion", "nsisVersion"],
  ];
  for (const [runtimeKey, candidateKey] of pairs) {
    if (runtime[runtimeKey] !== candidate.toolchain[candidateKey]) {
      fail("PREFLIGHT_RUNTIME_DRIFT", `VM runtime ${runtimeKey} differs from the candidate`);
    }
  }
}

function validateGuestObservation(value, { attestation, candidate, request, lifecycleMapping }) {
  const guestEvidenceEntry = attestation.guestEvidenceByPathProfile.find(
    (entry) => entry.pathProfileId === request.pathProfileId,
  );
  if (guestEvidenceEntry === undefined) {
    fail(
      "PREFLIGHT_GUEST_EVIDENCE",
      "attestation has no guest evidence for the requested path profile",
    );
  }
  assertExactKeys(
    value,
    [
      "environmentId",
      "pathProfileId",
      "host",
      "snapshot",
      "runner",
      "runtime",
      "bootIdSha256",
      "runnerSessionIdSha256",
      "pathProfile",
      "guestEvidence",
    ],
    "guestObservation",
  );
  if (
    value.environmentId !== request.environmentId ||
    value.pathProfileId !== request.pathProfileId ||
    !canonicalEqual(value.host, attestation.host) ||
    !canonicalEqual(value.snapshot, attestation.snapshot) ||
    !canonicalEqual(value.runner, attestation.runner) ||
    !canonicalEqual(value.runtime, attestation.runtime) ||
    !canonicalEqual(value.guestEvidence, guestEvidenceEntry.artifact)
  ) {
    fail("PREFLIGHT_GUEST_DRIFT", "live guest observation differs from its attestation");
  }
  if (
    value.snapshot.vmSnapshotId !== request.vmSnapshotId ||
    value.bootIdSha256 !== request.bootIdSha256 ||
    value.runnerSessionIdSha256 !== request.runnerSessionIdSha256
  ) {
    fail("PREFLIGHT_EXECUTION_IDENTITY", "guest snapshot, boot, or session identity mismatches");
  }
  assertRuntimeMatchesCandidate(value.runtime, candidate);
  const observedBuild = Number(value.host.osBuild);
  if (
    value.host.windowsVersion !== lifecycleMapping.windowsVersion ||
    observedBuild < lifecycleMapping.minimumBuild ||
    (lifecycleMapping.maximumBuild !== null && observedBuild > lifecycleMapping.maximumBuild)
  ) {
    fail(
      "PREFLIGHT_ENVIRONMENT_MAPPING",
      `${request.environmentId} does not satisfy its injected Windows lifecycle mapping`,
    );
  }
  assertExactKeys(
    value.pathProfile,
    [
      "profileId",
      "rootPathSha256",
      "evidenceRootObjectIdentitySha256",
      "volumeIdSha256",
      "localAbsolute",
      "networkPath",
      "removableVolume",
      "reparsePoint",
      "nfcNormalized",
      "containsSpaces",
      "containsUnicode",
    ],
    "guestObservation.pathProfile",
  );
  assertSha256(value.pathProfile.rootPathSha256, "guestObservation.pathProfile.rootPathSha256");
  assertSha256(
    value.pathProfile.evidenceRootObjectIdentitySha256,
    "guestObservation.pathProfile.evidenceRootObjectIdentitySha256",
  );
  assertSha256(value.pathProfile.volumeIdSha256, "guestObservation.pathProfile.volumeIdSha256");
  const expectsComplexPath = request.pathProfileId === "spaces-unicode";
  if (
    value.pathProfile.profileId !== request.pathProfileId ||
    value.pathProfile.volumeIdSha256 !== attestation.host.testVolumeIdSha256 ||
    value.pathProfile.localAbsolute !== true ||
    value.pathProfile.networkPath !== false ||
    value.pathProfile.removableVolume !== false ||
    value.pathProfile.reparsePoint !== false ||
    value.pathProfile.nfcNormalized !== true ||
    value.pathProfile.containsSpaces !== expectsComplexPath ||
    value.pathProfile.containsUnicode !== expectsComplexPath
  ) {
    fail("PREFLIGHT_PATH_PROFILE", "live path does not satisfy the requested path profile");
  }
  return value;
}

function validateControllerObservation(value, { attestation, request }) {
  assertExactKeys(
    value,
    [
      "identitySha256",
      "publicKeySha256",
      "version",
      "vmSnapshotId",
      "bootIdSha256",
      "runnerSessionIdSha256",
      "capabilities",
      "actors",
      "controllerEvidence",
      "publicKeyArtifact",
    ],
    "controllerObservation",
  );
  if (
    value.identitySha256 !== attestation.controller.identitySha256 ||
    value.publicKeySha256 !== attestation.controller.publicKeySha256 ||
    value.version !== attestation.controller.version ||
    value.vmSnapshotId !== request.vmSnapshotId ||
    value.bootIdSha256 !== request.bootIdSha256 ||
    value.runnerSessionIdSha256 !== request.runnerSessionIdSha256 ||
    !canonicalEqual(value.capabilities, attestation.capabilities) ||
    !canonicalEqual(value.controllerEvidence, attestation.controllerEvidence) ||
    !canonicalEqual(value.publicKeyArtifact, attestation.controller.publicKeyArtifact)
  ) {
    fail("PREFLIGHT_CONTROLLER_DRIFT", "live controller observation differs from its attestation");
  }
  if (Object.values(value.capabilities).some((available) => available !== true)) {
    fail("PREFLIGHT_CAPABILITY", "all authoritative controller capabilities must be available");
  }
  assertExactKeys(value.actors, controllerActorKeys, "controllerObservation.actors");
  const actors = controllerActorKeys.map((key) => value.actors[key]);
  for (const key of controllerActorKeys) {
    assertSha256(value.actors[key], `controllerObservation.actors.${key}`);
  }
  if (
    new Set(actors).size !== actors.length ||
    actors.includes(attestation.host.standardUserSidSha256)
  ) {
    fail("PREFLIGHT_ACTOR_IDENTITY", "external controller actors must be distinct and independent");
  }
  return value;
}

function validateExecutionActors(value) {
  assertExactKeys(value, executionActorKeys, "bundle.actors");
  const actors = executionActorKeys.map((key) => value[key]);
  for (const key of executionActorKeys) {
    assertSha256(value[key], `bundle.actors.${key}`);
  }
  if (new Set(actors).size !== actors.length) {
    fail("PREFLIGHT_ACTOR_IDENTITY", "execution bundle actors must be pairwise distinct");
  }
  return value;
}

async function readVerifiedArtifact(reader, reference, label) {
  const value = await reader(reference);
  assertExactKeys(value, ["path", "sha256", "bytes", "stableRead", "regularFile"], label);
  if (!(value.bytes instanceof Uint8Array)) {
    fail("PREFLIGHT_ARTIFACT", `${label}.bytes must be a byte array`);
  }
  if (
    value.path !== reference.path ||
    value.sha256 !== reference.sha256 ||
    sha256(value.bytes) !== reference.sha256 ||
    value.stableRead !== true ||
    value.regularFile !== true
  ) {
    fail("PREFLIGHT_ARTIFACT", `${label} was not read as the exact stable regular artifact`);
  }
  return value;
}

function assertEd25519PublicKey(bytes) {
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(bytes), format: "der", type: "spki" });
  } catch {
    fail("PREFLIGHT_CONTROLLER_KEY", "controller public-key artifact is not SPKI DER");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("PREFLIGHT_CONTROLLER_KEY", "controller public key must be Ed25519");
  }
}

function assertAmd64Pe(bytes) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 64 || view[0] !== 0x4d || view[1] !== 0x5a) {
    fail("PREFLIGHT_HELPER_PE", "native helper is not a PE executable");
  }
  const peOffset = view.readUInt32LE(0x3c);
  if (
    peOffset + 6 > view.length ||
    view[peOffset] !== 0x50 ||
    view[peOffset + 1] !== 0x45 ||
    view[peOffset + 2] !== 0 ||
    view[peOffset + 3] !== 0 ||
    view.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    fail("PREFLIGHT_HELPER_PE", "native helper must be an AMD64 PE executable");
  }
}

function findCandidateBinary(candidate, path, label) {
  const artifact = candidate.binaryHashes.find((entry) => entry.path === path);
  if (artifact === undefined) {
    fail("PREFLIGHT_BINARY", `${label} is not bound by candidate.binaryHashes`);
  }
  return artifact;
}

function executionBundleDigestPayload(value) {
  const { executionBundleManifestSha256: _digest, ...payload } = value;
  return payload;
}

export function deriveProbeExecutionBundleManifestDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-execution-bundle.v1",
    manifest: executionBundleDigestPayload(value),
  });
}

export function deriveProbePreparationScopeDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-preparation-scope.v1",
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    candidateSha256: value.candidateSha256,
    labAttestationSha256: value.labAttestationSha256,
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
    bootIdSha256: value.bootIdSha256,
    runnerSessionIdSha256: value.runnerSessionIdSha256,
    lifecyclePolicySha256: value.lifecyclePolicySha256,
    trustedEvaluationAt: value.trustedEvaluationAt,
    controllerPublicKeyArtifact: value.controllerPublicKeyArtifact,
    pathProfileObservation: value.pathProfileObservation,
    executionBundleManifest: value.executionBundleManifest,
  });
}

export function deriveProbePreparationClaimReceiptDigest(scopeSha256) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-preparation-claim.v1",
    scopeSha256,
    claimed: true,
    reused: false,
  });
}

export function deriveProbePreparationRequestDigest(request) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-preparation-request.v1",
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    request,
  });
}

function preparedContextDigestPayload(value) {
  const { preflightSha256: _digest, ...payload } = value;
  return payload;
}

export function derivePreparedProbeContextDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-prepared-context.v1",
    context: preparedContextDigestPayload(value),
  });
}

function preparationTransactionDigestPayload(value) {
  const { transactionSha256: _digest, ...payload } = value;
  return payload;
}

export function deriveProbePreparationTransactionDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-preparation-transaction.v1",
    transaction: preparationTransactionDigestPayload(value),
  });
}

function preparationStablePayload(value) {
  const {
    trustedEvaluationAt: _trustedEvaluationAt,
    executionBundleManifestSha256: _executionBundleManifestSha256,
    preparationScopeSha256: _preparationScopeSha256,
    preparationClaimReceiptSha256: _preparationClaimReceiptSha256,
    preflightSha256: _preflightSha256,
    executionBundleManifest,
    ...context
  } = value;
  const {
    trustedEvaluationAt: _bundleTrustedEvaluationAt,
    executionBundleManifestSha256: _bundleSha256,
    ...bundle
  } = executionBundleManifest;
  return { ...context, executionBundleManifest: bundle };
}

function validateExecutionBundleManifest(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "candidateSha256",
      "labAttestationSha256",
      "campaignRunId",
      "executionRunId",
      "executionBundleId",
      "environmentId",
      "authorization",
      "repository",
      "lifecyclePolicySha256",
      "trustedEvaluationAt",
      "vm",
      "runtime",
      "controller",
      "actors",
      "brokerEnrollments",
      "evidenceArtifacts",
      "binaries",
      "executionBundleManifestSha256",
    ],
    "executionBundleManifest",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-execution-bundle" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    fail("PREFLIGHT_BUNDLE", "execution bundle identity is invalid");
  }
  for (const key of [
    "candidateSha256",
    "labAttestationSha256",
    "lifecyclePolicySha256",
    "executionBundleManifestSha256",
  ]) {
    assertSha256(value[key], `executionBundleManifest.${key}`);
  }
  for (const key of ["campaignRunId", "executionRunId", "executionBundleId"]) {
    assertIdentifier(value[key], `executionBundleManifest.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("PREFLIGHT_BUNDLE", "execution bundle environment is invalid");
  }
  assertExactKeys(
    value.authorization,
    [
      "runPlanSha256",
      "runAuthorizationSha256",
      "claimReceiptSha256",
      "operatorKeyId",
      "operatorPublicKeySha256",
      "trustStoreId",
      "trustStoreGeneration",
      "trustStoreSha256",
      "verifiedAt",
      "authorizationExpiresAt",
    ],
    "bundle.authorization",
  );
  for (const key of [
    "runPlanSha256",
    "runAuthorizationSha256",
    "claimReceiptSha256",
    "operatorPublicKeySha256",
    "trustStoreSha256",
  ]) {
    assertSha256(value.authorization[key], `bundle.authorization.${key}`);
  }
  for (const key of ["operatorKeyId", "trustStoreId"]) {
    assertIdentifier(value.authorization[key], `bundle.authorization.${key}`);
  }
  if (
    !Number.isSafeInteger(value.authorization.trustStoreGeneration) ||
    value.authorization.trustStoreGeneration < 1
  ) {
    fail("PREFLIGHT_BUNDLE", "bundle authorization trust-store generation is invalid");
  }
  assertTimestamp(value.authorization.verifiedAt, "bundle.authorization.verifiedAt");
  assertTimestamp(
    value.authorization.authorizationExpiresAt,
    "bundle.authorization.authorizationExpiresAt",
  );
  assertTimestamp(value.trustedEvaluationAt, "executionBundleManifest.trustedEvaluationAt");
  assertExactKeys(value.repository, ["repositoryCommit", "sourceSetSha256"], "bundle.repository");
  if (!commitPattern.test(value.repository.repositoryCommit)) {
    fail("PREFLIGHT_BUNDLE", "bundle repository commit is invalid");
  }
  assertSha256(value.repository.sourceSetSha256, "bundle.repository.sourceSetSha256");
  assertExactKeys(value.vm, ["vmSnapshotId", "bootIdSha256", "runnerSessionIdSha256"], "bundle.vm");
  assertIdentifier(value.vm.vmSnapshotId, "bundle.vm.vmSnapshotId");
  assertSha256(value.vm.bootIdSha256, "bundle.vm.bootIdSha256");
  assertSha256(value.vm.runnerSessionIdSha256, "bundle.vm.runnerSessionIdSha256");
  assertExactKeys(
    value.controller,
    ["identitySha256", "publicKeySha256", "publicKeyArtifact", "version"],
    "bundle.controller",
  );
  assertSha256(value.controller.identitySha256, "bundle.controller.identitySha256");
  assertSha256(value.controller.publicKeySha256, "bundle.controller.publicKeySha256");
  assertArtifactReference(
    value.controller.publicKeyArtifact,
    "bundle.controller.publicKeyArtifact",
  );
  if (value.controller.publicKeyArtifact.sha256 !== value.controller.publicKeySha256) {
    fail("PREFLIGHT_BUNDLE", "bundle controller key artifact does not bind its public key");
  }
  const actors = validateExecutionActors(value.actors);
  if (!Array.isArray(value.evidenceArtifacts) || value.evidenceArtifacts.length !== 3) {
    fail("PREFLIGHT_BUNDLE", "bundle must bind guest, controller, and public-key artifacts");
  }
  for (const [index, artifact] of value.evidenceArtifacts.entries()) {
    assertArtifactReference(artifact, `bundle.evidenceArtifacts[${index}]`);
  }
  assertExactKeys(value.binaries, ["nativeHelper", "nsis"], "bundle.binaries");
  assertExactKeys(
    value.binaries.nativeHelper,
    ["path", "sha256", "machine", "nativeCandidateDigest", "nativeManifestSha256"],
    "bundle.nativeHelper",
  );
  assertArtifactReference(
    { path: value.binaries.nativeHelper.path, sha256: value.binaries.nativeHelper.sha256 },
    "bundle.nativeHelper",
  );
  if (value.binaries.nativeHelper.machine !== "x64") {
    fail("PREFLIGHT_BUNDLE", "bundle native helper machine is invalid");
  }
  assertSha256(
    value.binaries.nativeHelper.nativeCandidateDigest,
    "bundle.nativeHelper.nativeCandidateDigest",
  );
  assertSha256(
    value.binaries.nativeHelper.nativeManifestSha256,
    "bundle.nativeHelper.nativeManifestSha256",
  );
  assertArtifactReference(value.binaries.nsis, "bundle.nsis");
  if (value.executionBundleManifestSha256 !== deriveProbeExecutionBundleManifestDigest(value)) {
    fail("PREFLIGHT_BUNDLE_DIGEST", "execution bundle manifest digest mismatch");
  }
  const brokerEnrollments = validateProbePreparedBrokerEnrollmentSet(
    value.brokerEnrollments,
    value.environmentId,
  );
  const [primaryEnrollment, secondUserEnrollment, remotePeerEnrollment] = brokerEnrollments;
  if (
    primaryEnrollment.processSidSha256 !== actors.primaryStandardUserSidSha256 ||
    secondUserEnrollment.processSidSha256 !== actors.secondUserSidSha256 ||
    remotePeerEnrollment.peerAuthoritySha256 !== actors.remotePeerActorSha256
  ) {
    fail(
      "PREFLIGHT_BROKER_ACTOR_BINDING",
      "prepared broker enrollments differ from the execution actor registry",
    );
  }
  if (
    brokerEnrollments.some(
      (entry) => entry.nativeHelperSha256 !== value.binaries.nativeHelper.sha256,
    )
  ) {
    fail(
      "PREFLIGHT_BROKER_NATIVE_BINDING",
      "prepared broker enrollments differ from the execution native helper",
    );
  }
  return value;
}

export function validatePreparedProbeContext(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "candidateSha256",
      "labAttestationSha256",
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
      "bootIdSha256",
      "runnerSessionIdSha256",
      "lifecyclePolicySha256",
      "trustedEvaluationAt",
      "controllerPublicKeyArtifact",
      "pathProfileObservation",
      "executionBundleManifest",
      "preparationScopeSha256",
      "preparationClaimReceiptSha256",
      "preflightSha256",
    ],
    "preparedContext",
  );
  assertNoAuthorityClaims(value);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-prepared-context" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    fail("PREFLIGHT_CONTEXT", "prepared context identity is invalid");
  }
  for (const key of [
    "candidateSha256",
    "labAttestationSha256",
    "runPlanSha256",
    "runAuthorizationSha256",
    "runAuthorizationClaimReceiptSha256",
    "executionBundleManifestSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "lifecyclePolicySha256",
    "preparationScopeSha256",
    "preparationClaimReceiptSha256",
    "preflightSha256",
  ]) {
    assertSha256(value[key], `preparedContext.${key}`);
  }
  assertArtifactReference(
    value.controllerPublicKeyArtifact,
    "preparedContext.controllerPublicKeyArtifact",
  );
  assertTimestamp(value.trustedEvaluationAt, "preparedContext.trustedEvaluationAt");
  for (const key of [
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "attemptId",
    "vmSnapshotId",
  ]) {
    assertIdentifier(value[key], `preparedContext.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("PREFLIGHT_CONTEXT", "prepared context environment is invalid");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("PREFLIGHT_CONTEXT", "prepared context path profile is invalid");
  }
  assertExactKeys(
    value.pathProfileObservation,
    [
      "profileId",
      "rootPathSha256",
      "evidenceRootObjectIdentitySha256",
      "volumeIdSha256",
      "localAbsolute",
      "networkPath",
      "removableVolume",
      "reparsePoint",
      "nfcNormalized",
      "containsSpaces",
      "containsUnicode",
    ],
    "preparedContext.pathProfileObservation",
  );
  assertSha256(
    value.pathProfileObservation.rootPathSha256,
    "preparedContext.pathProfileObservation.rootPathSha256",
  );
  assertSha256(
    value.pathProfileObservation.evidenceRootObjectIdentitySha256,
    "preparedContext.pathProfileObservation.evidenceRootObjectIdentitySha256",
  );
  assertSha256(
    value.pathProfileObservation.volumeIdSha256,
    "preparedContext.pathProfileObservation.volumeIdSha256",
  );
  const expectsComplexPath = value.pathProfileId === "spaces-unicode";
  if (
    value.pathProfileObservation.profileId !== value.pathProfileId ||
    value.pathProfileObservation.localAbsolute !== true ||
    value.pathProfileObservation.networkPath !== false ||
    value.pathProfileObservation.removableVolume !== false ||
    value.pathProfileObservation.reparsePoint !== false ||
    value.pathProfileObservation.nfcNormalized !== true ||
    value.pathProfileObservation.containsSpaces !== expectsComplexPath ||
    value.pathProfileObservation.containsUnicode !== expectsComplexPath
  ) {
    fail("PREFLIGHT_CONTEXT", "prepared context path-profile observation is invalid");
  }
  const bundle = validateExecutionBundleManifest(value.executionBundleManifest);
  for (const key of [
    "candidateSha256",
    "labAttestationSha256",
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "environmentId",
  ]) {
    if (value[key] !== bundle[key]) {
      fail("PREFLIGHT_CONTEXT_BINDING", `prepared context ${key} differs from its bundle`);
    }
  }
  if (
    value.runPlanSha256 !== bundle.authorization.runPlanSha256 ||
    value.runAuthorizationSha256 !== bundle.authorization.runAuthorizationSha256 ||
    value.runAuthorizationClaimReceiptSha256 !== bundle.authorization.claimReceiptSha256 ||
    value.executionBundleManifestSha256 !== bundle.executionBundleManifestSha256 ||
    value.lifecyclePolicySha256 !== bundle.lifecyclePolicySha256 ||
    value.trustedEvaluationAt !== bundle.trustedEvaluationAt ||
    !canonicalEqual(value.controllerPublicKeyArtifact, bundle.controller.publicKeyArtifact) ||
    value.vmSnapshotId !== bundle.vm.vmSnapshotId ||
    value.bootIdSha256 !== bundle.vm.bootIdSha256 ||
    value.runnerSessionIdSha256 !== bundle.vm.runnerSessionIdSha256
  ) {
    fail("PREFLIGHT_CONTEXT_BINDING", "prepared context differs from its execution bundle");
  }
  const expectedScope = deriveProbePreparationScopeDigest(value);
  if (value.preparationScopeSha256 !== expectedScope) {
    fail("PREFLIGHT_SCOPE", "prepared context scope digest mismatch");
  }
  if (
    value.preparationClaimReceiptSha256 !==
    deriveProbePreparationClaimReceiptDigest(value.preparationScopeSha256)
  ) {
    fail("PREFLIGHT_CLAIM", "prepared context claim receipt mismatch");
  }
  if (value.preflightSha256 !== derivePreparedProbeContextDigest(value)) {
    fail("PREFLIGHT_DIGEST", "prepared context digest mismatch");
  }
  return value;
}

export function validateProbePreparationTransaction(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "requestSha256",
      "scopeSha256",
      "claimReceiptSha256",
      "preparedContext",
      "transactionSha256",
    ],
    "preparationTransaction",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-preparation-transaction") {
    fail("PREFLIGHT_TRANSACTION", "preparation transaction identity is invalid");
  }
  for (const key of ["requestSha256", "scopeSha256", "claimReceiptSha256", "transactionSha256"]) {
    assertSha256(value[key], `preparationTransaction.${key}`);
  }
  const prepared = validatePreparedProbeContext(value.preparedContext);
  if (
    value.scopeSha256 !== prepared.preparationScopeSha256 ||
    value.claimReceiptSha256 !== prepared.preparationClaimReceiptSha256
  ) {
    fail("PREFLIGHT_TRANSACTION_BINDING", "preparation transaction context binding is invalid");
  }
  if (value.transactionSha256 !== deriveProbePreparationTransactionDigest(value)) {
    fail("PREFLIGHT_TRANSACTION_DIGEST", "preparation transaction digest mismatch");
  }
  return value;
}

export async function prepareAuthoritativeProbeContext({
  manifest,
  candidate,
  attestation,
  runAuthorization,
  runAuthorizationClaim,
  request,
  lifecyclePolicy,
  brokerEnrollments,
  readers,
  now,
}) {
  validateProbeCampaignManifest(manifest);
  const validatedCandidate = validateProbeCandidateIdentity(candidate);
  const validatedAttestation = validateLabAttestation(attestation);
  const validatedRequest = validateRequest(request);
  const validatedRunAuthorization = validateProbeRunAuthorization(runAuthorization);
  const validatedRunAuthorizationClaim =
    validateProbeRunAuthorizationClaimReceipt(runAuthorizationClaim);
  const validatedBrokerEnrollmentInventory =
    validateProbeBrokerEnrollmentInventory(brokerEnrollments);
  const selectedBrokerEnrollments = selectProbeBrokerEnrollments(
    validatedBrokerEnrollmentInventory,
    validatedRequest.environmentId,
  );
  if (validatedAttestation.environmentId !== validatedRequest.environmentId) {
    fail("PREFLIGHT_ENVIRONMENT", "request and attestation environments differ");
  }
  if (validatedAttestation.snapshot.vmSnapshotId !== validatedRequest.vmSnapshotId) {
    fail("PREFLIGHT_SNAPSHOT", "request does not name the attested immutable snapshot");
  }
  if (
    validatedRunAuthorization.candidateSha256 !== validatedCandidate.candidateSha256 ||
    validatedRunAuthorization.campaignRunId !== validatedRequest.campaignRunId ||
    !validatedRunAuthorization.attestations.some(
      (value) =>
        value.environmentId === validatedAttestation.environmentId &&
        value.attestationSha256 === validatedAttestation.attestationSha256,
    )
  ) {
    fail("PREFLIGHT_RUN_AUTH", "run authorization is bound to another preflight context");
  }
  assertExactKeys(
    readers,
    [
      "readPreparationTransaction",
      "readRepositoryState",
      "observeGuest",
      "observeController",
      "observeBrokerMailbox",
      "readVerifiedEvidenceArtifact",
      "readVerifiedBinaryArtifact",
      "persistPreparation",
    ],
    "readers",
  );
  for (const [name, reader] of Object.entries(readers)) {
    if (typeof reader !== "function") fail("PREFLIGHT_READER", `${name} must be a function`);
  }
  if (typeof now !== "function") fail("PREFLIGHT_CLOCK", "preflight requires a trusted clock");
  const preparationRequestSha256 = deriveProbePreparationRequestDigest(validatedRequest);
  const recoveredValue = await readers.readPreparationTransaction(preparationRequestSha256);
  if (recoveredValue !== null) {
    const recoveredTransaction = validateProbePreparationTransaction(recoveredValue);
    const recovered = recoveredTransaction.preparedContext;
    if (
      recoveredTransaction.requestSha256 !== preparationRequestSha256 ||
      recovered.candidateSha256 !== validatedCandidate.candidateSha256 ||
      recovered.labAttestationSha256 !== validatedAttestation.attestationSha256 ||
      recovered.runPlanSha256 !== validatedRunAuthorization.runPlanSha256 ||
      recovered.runAuthorizationSha256 !== validatedRunAuthorization.authorizationSha256 ||
      recovered.runAuthorizationClaimReceiptSha256 !==
        validatedRunAuthorizationClaim.receiptSha256 ||
      recovered.campaignRunId !== validatedRequest.campaignRunId ||
      recovered.executionRunId !== validatedRequest.executionRunId ||
      recovered.executionBundleId !== validatedRequest.executionBundleId ||
      recovered.attemptId !== validatedRequest.attemptId ||
      recovered.environmentId !== validatedRequest.environmentId ||
      recovered.pathProfileId !== validatedRequest.pathProfileId ||
      recovered.vmSnapshotId !== validatedRequest.vmSnapshotId ||
      recovered.bootIdSha256 !== validatedRequest.bootIdSha256 ||
      recovered.runnerSessionIdSha256 !== validatedRequest.runnerSessionIdSha256 ||
      recovered.executionBundleManifest.binaries.nativeHelper.path !==
        validatedRequest.nativeHelperArtifactPath ||
      recovered.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest !==
        validatedRequest.nativeCandidateDigest ||
      recovered.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256 !==
        validatedRequest.nativeManifestSha256 ||
      recovered.executionBundleManifest.binaries.nsis.path !== validatedRequest.nsisArtifactPath ||
      !canonicalEqual(
        recovered.controllerPublicKeyArtifact,
        validatedAttestation.controller.publicKeyArtifact,
      ) ||
      !canonicalEqual(
        recovered.executionBundleManifest.brokerEnrollments.map(brokerEnrollmentStaticFields),
        selectedBrokerEnrollments.map(brokerEnrollmentStaticFields),
      )
    ) {
      fail(
        "PREFLIGHT_TRANSACTION_COLLISION",
        "retained preparation transaction differs from the requested authority scope",
      );
    }
    const retainedLifecycle = validateLifecyclePolicy(
      lifecyclePolicy,
      recovered.trustedEvaluationAt,
    );
    if (retainedLifecycle.sha256 !== recovered.lifecyclePolicySha256) {
      fail(
        "PREFLIGHT_TRANSACTION_COLLISION",
        "retained preparation transaction names another lifecycle policy",
      );
    }
    const publicKeyArtifact = await readVerifiedArtifact(
      readers.readVerifiedEvidenceArtifact,
      recovered.controllerPublicKeyArtifact,
      "recoveredControllerPublicKey",
    );
    assertEd25519PublicKey(publicKeyArtifact.bytes);
    verifyProbeRunAuthorizationClaimReceipt(validatedRunAuthorizationClaim, {
      authorization: validatedRunAuthorization,
      attestation: validatedAttestation,
      controllerPublicKeyBytes: publicKeyArtifact.bytes,
      evidenceRootObjectIdentitySha256:
        recovered.pathProfileObservation.evidenceRootObjectIdentitySha256,
    });
    return deepFreeze(recovered);
  }
  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) {
    fail("PREFLIGHT_CLOCK", "trusted clock returned an invalid instant");
  }
  if (
    observedNow.getTime() < Date.parse(validatedRunAuthorization.issuedAt) ||
    observedNow.getTime() >= Date.parse(validatedRunAuthorization.expiresAt)
  ) {
    fail("PREFLIGHT_RUN_AUTH_EXPIRED", "new preparation is outside the authorized run window");
  }
  const trustedEvaluationAt = observedNow.toISOString();
  const lifecycle = validateLifecyclePolicy(lifecyclePolicy, trustedEvaluationAt);
  const lifecycleMapping = lifecycle.mappings.get(validatedRequest.environmentId);
  if (lifecycleMapping === undefined) {
    fail("PREFLIGHT_LIFECYCLE", "request environment has no lifecycle mapping");
  }

  const [repositoryState, guestObservation, controllerObservation, brokerMailboxObservations] =
    await Promise.all([
      readers.readRepositoryState(),
      readers.observeGuest(validatedRequest),
      readers.observeController(validatedRequest),
      Promise.all(
        selectedBrokerEnrollments.map((enrollment) =>
          readers.observeBrokerMailbox(enrollment, validatedRequest),
        ),
      ),
    ]);
  const repository = validateRepositoryState(repositoryState, validatedCandidate);
  const guest = validateGuestObservation(guestObservation, {
    attestation: validatedAttestation,
    candidate: validatedCandidate,
    request: validatedRequest,
    lifecycleMapping,
  });
  const controller = validateControllerObservation(controllerObservation, {
    attestation: validatedAttestation,
    request: validatedRequest,
  });

  const nativeHelperReference = findCandidateBinary(
    validatedCandidate,
    validatedRequest.nativeHelperArtifactPath,
    "native helper",
  );
  const nsisReference = findCandidateBinary(
    validatedCandidate,
    validatedRequest.nsisArtifactPath,
    "NSIS",
  );
  if (nsisReference.sha256 !== validatedAttestation.runtime.nsisExecutableSha256) {
    fail("PREFLIGHT_NSIS", "candidate NSIS artifact differs from the attested VM runtime");
  }
  const [guestEvidence, controllerEvidence, publicKeyArtifact, nativeHelper, nsis] =
    await Promise.all([
      readVerifiedArtifact(
        readers.readVerifiedEvidenceArtifact,
        guest.guestEvidence,
        "guestEvidence",
      ),
      readVerifiedArtifact(
        readers.readVerifiedEvidenceArtifact,
        controller.controllerEvidence,
        "controllerEvidence",
      ),
      readVerifiedArtifact(
        readers.readVerifiedEvidenceArtifact,
        controller.publicKeyArtifact,
        "controllerPublicKey",
      ),
      readVerifiedArtifact(
        readers.readVerifiedBinaryArtifact,
        nativeHelperReference,
        "nativeHelper",
      ),
      readVerifiedArtifact(readers.readVerifiedBinaryArtifact, nsisReference, "nsis"),
    ]);
  assertEd25519PublicKey(publicKeyArtifact.bytes);
  assertAmd64Pe(nativeHelper.bytes);
  const verifiedRunAuthorizationClaim = verifyProbeRunAuthorizationClaimReceipt(
    validatedRunAuthorizationClaim,
    {
      authorization: validatedRunAuthorization,
      attestation: validatedAttestation,
      controllerPublicKeyBytes: publicKeyArtifact.bytes,
      evidenceRootObjectIdentitySha256: guest.pathProfile.evidenceRootObjectIdentitySha256,
    },
  );
  const preparedBrokerEnrollments = validateProbePreparedBrokerEnrollmentSet(
    selectedBrokerEnrollments.map((enrollment, index) =>
      createProbePreparedBrokerEnrollment(enrollment, brokerMailboxObservations[index]),
    ),
    validatedRequest.environmentId,
  );

  const evidenceArtifacts = [guestEvidence, controllerEvidence, publicKeyArtifact]
    .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const executionBundleDraft = {
    schemaVersion: 1,
    kind: "windows-host-probe-execution-bundle",
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: validatedCandidate.candidateSha256,
    labAttestationSha256: validatedAttestation.attestationSha256,
    campaignRunId: validatedRequest.campaignRunId,
    executionRunId: validatedRequest.executionRunId,
    executionBundleId: validatedRequest.executionBundleId,
    environmentId: validatedRequest.environmentId,
    authorization: {
      runPlanSha256: validatedRunAuthorization.runPlanSha256,
      runAuthorizationSha256: validatedRunAuthorization.authorizationSha256,
      claimReceiptSha256: verifiedRunAuthorizationClaim.receiptSha256,
      operatorKeyId: verifiedRunAuthorizationClaim.operatorKeyId,
      operatorPublicKeySha256: verifiedRunAuthorizationClaim.operatorPublicKeySha256,
      trustStoreId: verifiedRunAuthorizationClaim.trustStoreId,
      trustStoreGeneration: verifiedRunAuthorizationClaim.trustStoreGeneration,
      trustStoreSha256: verifiedRunAuthorizationClaim.trustStoreSha256,
      verifiedAt: verifiedRunAuthorizationClaim.verifiedAt,
      authorizationExpiresAt: verifiedRunAuthorizationClaim.authorizationExpiresAt,
    },
    repository,
    lifecyclePolicySha256: lifecycle.sha256,
    trustedEvaluationAt,
    vm: {
      vmSnapshotId: validatedRequest.vmSnapshotId,
      bootIdSha256: validatedRequest.bootIdSha256,
      runnerSessionIdSha256: validatedRequest.runnerSessionIdSha256,
    },
    runtime: guest.runtime,
    controller: {
      identitySha256: controller.identitySha256,
      publicKeySha256: controller.publicKeySha256,
      publicKeyArtifact: {
        path: publicKeyArtifact.path,
        sha256: publicKeyArtifact.sha256,
      },
      version: controller.version,
    },
    actors: {
      primaryStandardUserSidSha256: guest.host.standardUserSidSha256,
      powerControlActorSha256: controller.actors.powerControlActorSha256,
      snapshotControlActorSha256: controller.actors.snapshotControlActorSha256,
      remotePeerActorSha256: controller.actors.remotePeerActorSha256,
      secondUserSidSha256: controller.actors.secondUserSidSha256,
    },
    brokerEnrollments: preparedBrokerEnrollments,
    evidenceArtifacts,
    binaries: {
      nativeHelper: {
        path: nativeHelper.path,
        sha256: nativeHelper.sha256,
        machine: "x64",
        nativeCandidateDigest: validatedRequest.nativeCandidateDigest,
        nativeManifestSha256: validatedRequest.nativeManifestSha256,
      },
      nsis: { path: nsis.path, sha256: nsis.sha256 },
    },
  };
  const executionBundleManifest = {
    ...executionBundleDraft,
    executionBundleManifestSha256: deriveProbeExecutionBundleManifestDigest(executionBundleDraft),
  };
  validateExecutionBundleManifest(executionBundleManifest);
  const contextDraft = {
    schemaVersion: 1,
    kind: "windows-host-probe-prepared-context",
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: validatedCandidate.candidateSha256,
    labAttestationSha256: validatedAttestation.attestationSha256,
    runPlanSha256: validatedRunAuthorization.runPlanSha256,
    runAuthorizationSha256: validatedRunAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: verifiedRunAuthorizationClaim.receiptSha256,
    campaignRunId: validatedRequest.campaignRunId,
    executionRunId: validatedRequest.executionRunId,
    executionBundleId: validatedRequest.executionBundleId,
    executionBundleManifestSha256: executionBundleManifest.executionBundleManifestSha256,
    attemptId: validatedRequest.attemptId,
    environmentId: validatedRequest.environmentId,
    pathProfileId: validatedRequest.pathProfileId,
    vmSnapshotId: validatedRequest.vmSnapshotId,
    bootIdSha256: validatedRequest.bootIdSha256,
    runnerSessionIdSha256: validatedRequest.runnerSessionIdSha256,
    lifecyclePolicySha256: lifecycle.sha256,
    trustedEvaluationAt,
    controllerPublicKeyArtifact: executionBundleManifest.controller.publicKeyArtifact,
    pathProfileObservation: guest.pathProfile,
    executionBundleManifest,
  };
  const preparationScopeSha256 = deriveProbePreparationScopeDigest(contextDraft);
  const claimReceiptSha256 = deriveProbePreparationClaimReceiptDigest(preparationScopeSha256);
  const unsigned = {
    ...contextDraft,
    preparationScopeSha256,
    preparationClaimReceiptSha256: claimReceiptSha256,
  };
  const prepared = {
    ...unsigned,
    preflightSha256: derivePreparedProbeContextDigest(unsigned),
  };
  validatePreparedProbeContext(prepared);
  const transactionDraft = {
    schemaVersion: 1,
    kind: "windows-host-probe-preparation-transaction",
    requestSha256: preparationRequestSha256,
    scopeSha256: preparationScopeSha256,
    claimReceiptSha256,
    preparedContext: prepared,
    transactionSha256: "",
  };
  transactionDraft.transactionSha256 = deriveProbePreparationTransactionDigest(transactionDraft);
  validateProbePreparationTransaction(transactionDraft);
  const persistence = await readers.persistPreparation(deepFreeze(transactionDraft));
  assertExactKeys(persistence, ["transaction", "reused"], "preparationPersistence");
  if (typeof persistence.reused !== "boolean") {
    fail("PREFLIGHT_TRANSACTION", "preparation persistence state is invalid");
  }
  const retainedTransaction = validateProbePreparationTransaction(persistence.transaction);
  if (retainedTransaction.requestSha256 !== preparationRequestSha256) {
    fail("PREFLIGHT_TRANSACTION_COLLISION", "preparation request belongs to another transaction");
  }
  if (!persistence.reused && !canonicalEqual(retainedTransaction, transactionDraft)) {
    fail("PREFLIGHT_TRANSACTION_COLLISION", "new preparation transaction was not retained exactly");
  }
  if (persistence.reused) {
    validateLifecyclePolicy(
      lifecyclePolicy,
      retainedTransaction.preparedContext.trustedEvaluationAt,
    );
    if (
      !canonicalEqual(
        preparationStablePayload(retainedTransaction.preparedContext),
        preparationStablePayload(prepared),
      )
    ) {
      fail(
        "PREFLIGHT_TRANSACTION_COLLISION",
        "retained preparation transaction differs from current verified inputs",
      );
    }
  }
  return deepFreeze(retainedTransaction.preparedContext);
}
