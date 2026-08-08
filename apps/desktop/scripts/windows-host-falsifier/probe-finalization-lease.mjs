import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

import { hashProbeCanonicalJson } from "./probe-contract.mjs";

export const PROBE_FINALIZATION_INTENT_SCHEMA_VERSION = 1;
export const PROBE_QUIESCENCE_LEASE_SCHEMA_VERSION = 1;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu;
const strictTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const artifactPathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export class ProbeFinalizationLeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeFinalizationLeaseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeFinalizationLeaseError(code, message);
}

function exactObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, required, label) {
  if (!exactObject(value)) fail("FINALIZATION_LEASE_SCHEMA", `${label} must be a plain object`);
  const expected = [...required].sort().join(",");
  const actual = Object.keys(value).sort().join(",");
  if (actual !== expected) fail("FINALIZATION_LEASE_SCHEMA", `${label} has an invalid shape`);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("FINALIZATION_LEASE_IDENTIFIER", `${label} must be a bounded protocol identifier`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("FINALIZATION_LEASE_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("FINALIZATION_LEASE_TIMESTAMP", `${label} must be strict UTC ISO-8601`);
  }
  return value;
}

function requireInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("FINALIZATION_LEASE_INTEGER", `${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireArtifactPath(value, label) {
  if (
    typeof value !== "string" ||
    !artifactPathPattern.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    fail("FINALIZATION_LEASE_PATH", `${label} must be a canonical ASCII artifact path`);
  }
  return value;
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail("FINALIZATION_LEASE_BASE64", `${label} must be canonical padded base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    fail("FINALIZATION_LEASE_BASE64", `${label} must be non-empty canonical padded base64`);
  }
  return bytes;
}

function validateUniqueIdentifiers(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("FINALIZATION_LEASE_SET", `${label} must be a non-empty array`);
  }
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    requireIdentifier(value, `${label}[${index}]`);
    if (seen.has(value)) fail("FINALIZATION_LEASE_SET", `${label} must be unique`);
    seen.add(value);
  }
  return values;
}

function validateSortedUniqueDigests(values, label) {
  if (!Array.isArray(values)) fail("FINALIZATION_LEASE_SET", `${label} must be an array`);
  let previous = null;
  for (const [index, value] of values.entries()) {
    requireSha256(value, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      fail("FINALIZATION_LEASE_SET", `${label} must be UTF-8 sorted and unique`);
    }
    previous = value;
  }
  return values;
}

function digestPayload(value, digestKey, signatureKey = null) {
  const payload = { ...value };
  delete payload[digestKey];
  if (signatureKey !== null) delete payload[signatureKey];
  return payload;
}

export function deriveProbeFinalizationOperationDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-finalization-operation.v1",
    intent: digestPayload(value, "finalizationOperationSha256"),
  });
}

export function deriveProbeQuiescenceLeaseReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-quiescence-lease-receipt.v1",
    receipt: digestPayload(value, "receiptSha256", "signatureBase64"),
  });
}

export function deriveProbeQuiescenceCompletionReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-quiescence-completion-receipt.v1",
    receipt: digestPayload(value, "receiptSha256", "signatureBase64"),
  });
}

export function deriveProbeQuiescenceAbandonmentReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-quiescence-abandonment-receipt.v1",
    receipt: digestPayload(value, "receiptSha256", "signatureBase64"),
  });
}

export function deriveProbeSegmentCommitDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-segment-commit.v1",
    commit: digestPayload(value, "commitSha256"),
  });
}

export function validateProbeFinalizationIntent(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "candidateSha256",
      "runAuthorizationSha256",
      "runAuthorizationClaimReceiptSha256",
      "campaignRunId",
      "executionRunId",
      "executionBundleId",
      "executionBundleManifestSha256",
      "attemptId",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "evidenceRootObjectIdentitySha256",
      "continuationChainIds",
      "upstreamSelectionDigests",
      "startedAt",
      "finalizationOperationSha256",
    ],
    "finalization intent",
  );
  if (
    value.schemaVersion !== PROBE_FINALIZATION_INTENT_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-finalization-intent" ||
    value.campaignId !== "f01-f10-native-probe-v1"
  ) {
    fail("FINALIZATION_LEASE_IDENTITY", "finalization intent identity is invalid");
  }
  for (const key of [
    "manifestSha256",
    "candidateSha256",
    "runAuthorizationSha256",
    "runAuthorizationClaimReceiptSha256",
    "executionBundleManifestSha256",
    "evidenceRootObjectIdentitySha256",
  ]) {
    requireSha256(value[key], `finalization intent.${key}`);
  }
  for (const key of [
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "attemptId",
    "environmentId",
    "pathProfileId",
    "rowId",
    "variantId",
  ]) {
    requireIdentifier(value[key], `finalization intent.${key}`);
  }
  validateUniqueIdentifiers(value.continuationChainIds, "finalization intent.continuationChainIds");
  validateSortedUniqueDigests(
    value.upstreamSelectionDigests,
    "finalization intent.upstreamSelectionDigests",
  );
  requireTimestamp(value.startedAt, "finalization intent.startedAt");
  requireSha256(value.finalizationOperationSha256, "finalization operation digest");
  if (value.finalizationOperationSha256 !== deriveProbeFinalizationOperationDigest(value)) {
    fail("FINALIZATION_LEASE_DIGEST", "finalization operation digest is invalid");
  }
  return Object.freeze(value);
}

function validateControllerIdentity(value, label) {
  requireSha256(value.controllerIdentitySha256, `${label}.controllerIdentitySha256`);
  requireSha256(value.controllerPublicKeySha256, `${label}.controllerPublicKeySha256`);
  if (typeof value.controllerVersion !== "string" || value.controllerVersion.length === 0) {
    fail("FINALIZATION_LEASE_CONTROLLER", `${label}.controllerVersion is invalid`);
  }
  if (value.signatureAlgorithm !== "Ed25519") {
    fail("FINALIZATION_LEASE_CONTROLLER", `${label}.signatureAlgorithm is invalid`);
  }
  decodeCanonicalBase64(value.signatureBase64, `${label}.signatureBase64`);
}

function verifyControllerSignature(value, digest, controllerPublicKeyBytes, expectedController) {
  assertExactKeys(
    expectedController,
    ["identitySha256", "publicKeySha256", "version"],
    "expected controller",
  );
  if (
    value.controllerIdentitySha256 !== expectedController.identitySha256 ||
    value.controllerPublicKeySha256 !== expectedController.publicKeySha256 ||
    value.controllerVersion !== expectedController.version
  ) {
    fail("FINALIZATION_LEASE_CONTROLLER", "receipt belongs to another controller");
  }
  if (!(controllerPublicKeyBytes instanceof Uint8Array)) {
    fail("FINALIZATION_LEASE_CONTROLLER", "controller public-key bytes are required");
  }
  const keyBytes = Buffer.from(
    controllerPublicKeyBytes.buffer,
    controllerPublicKeyBytes.byteOffset,
    controllerPublicKeyBytes.byteLength,
  );
  if (createHash("sha256").update(keyBytes).digest("hex") !== value.controllerPublicKeySha256) {
    fail("FINALIZATION_LEASE_CONTROLLER", "controller public-key digest is mismatched");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    fail("FINALIZATION_LEASE_CONTROLLER", "controller public key must be SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("FINALIZATION_LEASE_CONTROLLER", "controller public key must be Ed25519");
  }
  if (
    !verify(
      null,
      Buffer.from(digest, "hex"),
      publicKey,
      decodeCanonicalBase64(value.signatureBase64, "controller receipt signature"),
    )
  ) {
    fail("FINALIZATION_LEASE_SIGNATURE", "controller receipt signature is invalid");
  }
}

export function validateProbeQuiescenceLeaseReceipt(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "finalizationOperationSha256",
      "runAuthorizationSha256",
      "runAuthorizationClaimReceiptSha256",
      "evidenceRootObjectIdentitySha256",
      "leaseId",
      "leaseEpoch",
      "renewalSequence",
      "actorSetSha256",
      "acquiredAt",
      "expiresAt",
      "state",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "quiescence lease receipt",
  );
  if (
    value.schemaVersion !== PROBE_QUIESCENCE_LEASE_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-controller-quiescence-lease-receipt" ||
    value.state !== "active"
  ) {
    fail("FINALIZATION_LEASE_IDENTITY", "quiescence lease receipt identity is invalid");
  }
  for (const key of [
    "finalizationOperationSha256",
    "runAuthorizationSha256",
    "runAuthorizationClaimReceiptSha256",
    "evidenceRootObjectIdentitySha256",
    "actorSetSha256",
    "receiptSha256",
  ]) {
    requireSha256(value[key], `quiescence lease receipt.${key}`);
  }
  requireIdentifier(value.leaseId, "quiescence lease receipt.leaseId");
  requireInteger(value.leaseEpoch, 1, "quiescence lease receipt.leaseEpoch");
  requireInteger(value.renewalSequence, 0, "quiescence lease receipt.renewalSequence");
  requireTimestamp(value.acquiredAt, "quiescence lease receipt.acquiredAt");
  requireTimestamp(value.expiresAt, "quiescence lease receipt.expiresAt");
  if (Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) {
    fail("FINALIZATION_LEASE_TIME", "quiescence lease expiry must follow acquisition");
  }
  validateControllerIdentity(value, "quiescence lease receipt");
  if (value.receiptSha256 !== deriveProbeQuiescenceLeaseReceiptDigest(value)) {
    fail("FINALIZATION_LEASE_DIGEST", "quiescence lease receipt digest is invalid");
  }
  return Object.freeze(value);
}

export function verifyProbeQuiescenceLeaseReceipt(value, options) {
  const receipt = validateProbeQuiescenceLeaseReceipt(value);
  assertExactKeys(
    options,
    ["finalizationIntent", "controllerPublicKeyBytes", "expectedController"],
    "quiescence lease verification options",
  );
  const intent = validateProbeFinalizationIntent(options.finalizationIntent);
  const expected = {
    finalizationOperationSha256: intent.finalizationOperationSha256,
    runAuthorizationSha256: intent.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: intent.runAuthorizationClaimReceiptSha256,
    evidenceRootObjectIdentitySha256: intent.evidenceRootObjectIdentitySha256,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail("FINALIZATION_LEASE_BINDING", `quiescence lease ${key} is mismatched`);
    }
  }
  verifyControllerSignature(
    receipt,
    receipt.receiptSha256,
    options.controllerPublicKeyBytes,
    options.expectedController,
  );
  return receipt;
}

export function verifyProbeQuiescenceLeaseTransition(value, options) {
  assertExactKeys(
    options,
    ["previousReceipt", "finalizationIntent", "controllerPublicKeyBytes", "expectedController"],
    "quiescence lease transition options",
  );
  const previous = verifyProbeQuiescenceLeaseReceipt(options.previousReceipt, {
    finalizationIntent: options.finalizationIntent,
    controllerPublicKeyBytes: options.controllerPublicKeyBytes,
    expectedController: options.expectedController,
  });
  const next = verifyProbeQuiescenceLeaseReceipt(value, {
    finalizationIntent: options.finalizationIntent,
    controllerPublicKeyBytes: options.controllerPublicKeyBytes,
    expectedController: options.expectedController,
  });
  if (next.receiptSha256 === previous.receiptSha256) return next;
  if (
    next.leaseId !== previous.leaseId ||
    next.leaseEpoch !== previous.leaseEpoch ||
    next.acquiredAt !== previous.acquiredAt ||
    next.actorSetSha256 !== previous.actorSetSha256 ||
    next.renewalSequence !== previous.renewalSequence + 1 ||
    Date.parse(next.expiresAt) <= Date.parse(previous.expiresAt)
  ) {
    fail("FINALIZATION_LEASE_TRANSITION", "lease renewal is not the next exact epoch sequence");
  }
  return next;
}

function validateSegmentProof(value, label, exact = false) {
  const keys = [
    "segmentPath",
    "segmentSha256",
    "segmentArtifactSha256",
    "verificationInputSha256",
    "outcomeEvidenceSha256",
  ];
  if (exact) {
    assertExactKeys(value, keys, label);
  } else if (!exactObject(value) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail("FINALIZATION_LEASE_SCHEMA", `${label} is missing its segment proof`);
  }
  requireArtifactPath(value.segmentPath, `${label}.segmentPath`);
  for (const key of [
    "segmentSha256",
    "segmentArtifactSha256",
    "verificationInputSha256",
    "outcomeEvidenceSha256",
  ]) {
    requireSha256(value[key], `${label}.${key}`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function validateProbeQuiescenceCompletionReceipt(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "finalizationOperationSha256",
      "leaseId",
      "leaseEpoch",
      "leaseReceiptSha256",
      "evidenceCaptureReceiptSha256",
      "segmentPath",
      "segmentSha256",
      "segmentArtifactSha256",
      "verificationInputSha256",
      "outcomeEvidenceSha256",
      "completedAt",
      "state",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "quiescence completion receipt",
  );
  if (
    value.schemaVersion !== PROBE_QUIESCENCE_LEASE_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-controller-quiescence-completion-receipt" ||
    value.state !== "completed"
  ) {
    fail("FINALIZATION_LEASE_IDENTITY", "quiescence completion receipt identity is invalid");
  }
  for (const key of [
    "finalizationOperationSha256",
    "leaseReceiptSha256",
    "evidenceCaptureReceiptSha256",
    "receiptSha256",
  ]) {
    requireSha256(value[key], `quiescence completion receipt.${key}`);
  }
  requireIdentifier(value.leaseId, "quiescence completion receipt.leaseId");
  requireInteger(value.leaseEpoch, 1, "quiescence completion receipt.leaseEpoch");
  validateSegmentProof(value, "quiescence completion receipt");
  requireTimestamp(value.completedAt, "quiescence completion receipt.completedAt");
  validateControllerIdentity(value, "quiescence completion receipt");
  if (value.receiptSha256 !== deriveProbeQuiescenceCompletionReceiptDigest(value)) {
    fail("FINALIZATION_LEASE_DIGEST", "quiescence completion receipt digest is invalid");
  }
  return Object.freeze(value);
}

export function verifyProbeQuiescenceCompletionReceipt(value, options) {
  const receipt = validateProbeQuiescenceCompletionReceipt(value);
  assertExactKeys(
    options,
    [
      "finalizationIntent",
      "leaseReceipt",
      "evidenceCaptureReceiptSha256",
      "segmentProof",
      "controllerPublicKeyBytes",
      "expectedController",
    ],
    "quiescence completion verification options",
  );
  const intent = validateProbeFinalizationIntent(options.finalizationIntent);
  const lease = verifyProbeQuiescenceLeaseReceipt(options.leaseReceipt, {
    finalizationIntent: intent,
    controllerPublicKeyBytes: options.controllerPublicKeyBytes,
    expectedController: options.expectedController,
  });
  requireSha256(options.evidenceCaptureReceiptSha256, "expected evidence capture receipt digest");
  const proof = validateSegmentProof(options.segmentProof, "expected segment proof", true);
  const expected = {
    finalizationOperationSha256: intent.finalizationOperationSha256,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    leaseReceiptSha256: lease.receiptSha256,
    evidenceCaptureReceiptSha256: options.evidenceCaptureReceiptSha256,
    ...proof,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail("FINALIZATION_LEASE_BINDING", `completion receipt ${key} is mismatched`);
    }
  }
  if (
    Date.parse(receipt.completedAt) < Date.parse(lease.acquiredAt) ||
    Date.parse(receipt.completedAt) >= Date.parse(lease.expiresAt)
  ) {
    fail("FINALIZATION_LEASE_TIME", "controller completion is outside the active lease window");
  }
  verifyControllerSignature(
    receipt,
    receipt.receiptSha256,
    options.controllerPublicKeyBytes,
    options.expectedController,
  );
  return receipt;
}

export function validateProbeQuiescenceAbandonmentReceipt(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "finalizationOperationSha256",
      "leaseId",
      "leaseEpoch",
      "leaseReceiptSha256",
      "reasonCode",
      "abandonedAt",
      "state",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "quiescence abandonment receipt",
  );
  if (
    value.schemaVersion !== PROBE_QUIESCENCE_LEASE_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-controller-quiescence-abandonment-receipt" ||
    value.state !== "abandoned"
  ) {
    fail("FINALIZATION_LEASE_IDENTITY", "quiescence abandonment receipt identity is invalid");
  }
  for (const key of ["finalizationOperationSha256", "leaseReceiptSha256", "receiptSha256"]) {
    requireSha256(value[key], `quiescence abandonment receipt.${key}`);
  }
  requireIdentifier(value.leaseId, "quiescence abandonment receipt.leaseId");
  requireInteger(value.leaseEpoch, 1, "quiescence abandonment receipt.leaseEpoch");
  requireIdentifier(value.reasonCode, "quiescence abandonment receipt.reasonCode");
  requireTimestamp(value.abandonedAt, "quiescence abandonment receipt.abandonedAt");
  validateControllerIdentity(value, "quiescence abandonment receipt");
  if (value.receiptSha256 !== deriveProbeQuiescenceAbandonmentReceiptDigest(value)) {
    fail("FINALIZATION_LEASE_DIGEST", "quiescence abandonment receipt digest is invalid");
  }
  return Object.freeze(value);
}

export function verifyProbeQuiescenceAbandonmentReceipt(value, options) {
  const receipt = validateProbeQuiescenceAbandonmentReceipt(value);
  assertExactKeys(
    options,
    ["finalizationIntent", "leaseReceipt", "controllerPublicKeyBytes", "expectedController"],
    "quiescence abandonment verification options",
  );
  const intent = validateProbeFinalizationIntent(options.finalizationIntent);
  const lease = verifyProbeQuiescenceLeaseReceipt(options.leaseReceipt, {
    finalizationIntent: intent,
    controllerPublicKeyBytes: options.controllerPublicKeyBytes,
    expectedController: options.expectedController,
  });
  if (
    receipt.finalizationOperationSha256 !== intent.finalizationOperationSha256 ||
    receipt.leaseId !== lease.leaseId ||
    receipt.leaseEpoch !== lease.leaseEpoch ||
    receipt.leaseReceiptSha256 !== lease.receiptSha256 ||
    Date.parse(receipt.abandonedAt) < Date.parse(lease.acquiredAt)
  ) {
    fail("FINALIZATION_LEASE_BINDING", "abandonment receipt is bound to another lease");
  }
  verifyControllerSignature(
    receipt,
    receipt.receiptSha256,
    options.controllerPublicKeyBytes,
    options.expectedController,
  );
  return receipt;
}

export function validateProbeSegmentCommitMarker(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "finalizationOperationSha256",
      "runAuthorizationSha256",
      "runAuthorizationClaimReceiptSha256",
      "leaseId",
      "leaseEpoch",
      "acquisitionReceiptSha256",
      "finalLeaseReceiptSha256",
      "evidenceCaptureReceiptSha256",
      "completionReceiptSha256",
      "segmentPath",
      "segmentSha256",
      "segmentArtifactSha256",
      "verificationInputSha256",
      "outcomeEvidenceSha256",
      "commitSha256",
    ],
    "segment commit marker",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-segment-commit") {
    fail("FINALIZATION_LEASE_IDENTITY", "segment commit marker identity is invalid");
  }
  for (const key of [
    "finalizationOperationSha256",
    "runAuthorizationSha256",
    "runAuthorizationClaimReceiptSha256",
    "acquisitionReceiptSha256",
    "finalLeaseReceiptSha256",
    "evidenceCaptureReceiptSha256",
    "completionReceiptSha256",
    "commitSha256",
  ]) {
    requireSha256(value[key], `segment commit marker.${key}`);
  }
  requireIdentifier(value.leaseId, "segment commit marker.leaseId");
  requireInteger(value.leaseEpoch, 1, "segment commit marker.leaseEpoch");
  validateSegmentProof(value, "segment commit marker");
  if (value.commitSha256 !== deriveProbeSegmentCommitDigest(value)) {
    fail("FINALIZATION_LEASE_DIGEST", "segment commit marker digest is invalid");
  }
  return Object.freeze(value);
}

export function verifyProbeSegmentCommitMarker(value, options) {
  const marker = validateProbeSegmentCommitMarker(value);
  assertExactKeys(
    options,
    ["finalizationIntent", "acquisitionReceipt", "finalLeaseReceipt", "completionReceipt"],
    "segment commit verification options",
  );
  const intent = validateProbeFinalizationIntent(options.finalizationIntent);
  const acquisition = validateProbeQuiescenceLeaseReceipt(options.acquisitionReceipt);
  const finalLease = validateProbeQuiescenceLeaseReceipt(options.finalLeaseReceipt);
  const completion = validateProbeQuiescenceCompletionReceipt(options.completionReceipt);
  const expected = {
    finalizationOperationSha256: intent.finalizationOperationSha256,
    runAuthorizationSha256: intent.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: intent.runAuthorizationClaimReceiptSha256,
    leaseId: finalLease.leaseId,
    leaseEpoch: finalLease.leaseEpoch,
    acquisitionReceiptSha256: acquisition.receiptSha256,
    finalLeaseReceiptSha256: finalLease.receiptSha256,
    evidenceCaptureReceiptSha256: completion.evidenceCaptureReceiptSha256,
    completionReceiptSha256: completion.receiptSha256,
    segmentPath: completion.segmentPath,
    segmentSha256: completion.segmentSha256,
    segmentArtifactSha256: completion.segmentArtifactSha256,
    verificationInputSha256: completion.verificationInputSha256,
    outcomeEvidenceSha256: completion.outcomeEvidenceSha256,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (marker[key] !== expectedValue) {
      fail("FINALIZATION_LEASE_BINDING", `segment commit marker ${key} is mismatched`);
    }
  }
  if (
    acquisition.renewalSequence !== 0 ||
    acquisition.leaseId !== finalLease.leaseId ||
    acquisition.leaseEpoch !== finalLease.leaseEpoch ||
    completion.leaseReceiptSha256 !== finalLease.receiptSha256
  ) {
    fail("FINALIZATION_LEASE_BINDING", "segment commit marker lease chain is invalid");
  }
  return marker;
}
