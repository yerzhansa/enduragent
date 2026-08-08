import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  hashProbeCanonicalJson,
  validateLabAttestation,
} from "./probe-contract.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "./probe-runner.mjs";

export const PROBE_RUN_AUTHORIZATION_SCHEMA_VERSION = 1;
export const PROBE_RUN_AUTHORIZATION_MAXIMUM_MS = 24 * 60 * 60 * 1000;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const strictTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class ProbeRunAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeRunAuthorizationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeRunAuthorizationError(code, message);
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
  if (!exactObject(value)) fail("RUN_AUTH_SCHEMA", `${label} must be a plain object`);
  const expected = [...required].sort().join(",");
  const actual = Object.keys(value).sort().join(",");
  if (actual !== expected) fail("RUN_AUTH_SCHEMA", `${label} has an invalid shape`);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("RUN_AUTH_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("RUN_AUTH_IDENTIFIER", `${label} must be a bounded protocol identifier`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("RUN_AUTH_TIMESTAMP", `${label} must be strict UTC ISO-8601`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("RUN_AUTH_INTEGER", `${label} must be a positive safe integer`);
  }
  return value;
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail("RUN_AUTH_BASE64", `${label} must be canonical padded base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    fail("RUN_AUTH_BASE64", `${label} must be non-empty canonical padded base64`);
  }
  return bytes;
}

function authorizationPayload(value) {
  const {
    authorizationSha256: _authorizationSha256,
    signatureBase64: _signatureBase64,
    ...rest
  } = value;
  return rest;
}

function trustStorePayload(value) {
  const { trustStoreSha256: _trustStoreSha256, ...rest } = value;
  return rest;
}

function claimReceiptPayload(value) {
  const { receiptSha256: _receiptSha256, signatureBase64: _signatureBase64, ...rest } = value;
  return rest;
}

export function deriveProbeRunAuthorizationDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-run-authorization.v1",
    authorization: authorizationPayload(value),
  });
}

export function deriveProbeOperatorTrustStoreDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-operator-trust-store.v1",
    trustStore: trustStorePayload(value),
  });
}

export function deriveProbeRunAuthorizationClaimReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-run-authorization-claim-receipt.v1",
    receipt: claimReceiptPayload(value),
  });
}

function validateAttestationReferences(value) {
  if (!Array.isArray(value) || value.length !== PROBE_ENVIRONMENT_IDS.length) {
    fail("RUN_AUTH_ATTESTATIONS", "authorization must bind exactly two lab attestations");
  }
  const expectedIds = [...PROBE_ENVIRONMENT_IDS].sort(compareUtf8);
  return value.map((entry, index) => {
    const label = `authorization.attestations[${index}]`;
    assertExactKeys(entry, ["environmentId", "attestationSha256"], label);
    if (entry.environmentId !== expectedIds[index]) {
      fail("RUN_AUTH_ATTESTATIONS", "authorization attestations must be complete and sorted");
    }
    requireSha256(entry.attestationSha256, `${label}.attestationSha256`);
    return Object.freeze({ ...entry });
  });
}

export function validateProbeRunAuthorization(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "runPlanSha256",
      "candidateSha256",
      "campaignRunId",
      "attestations",
      "issuedAt",
      "expiresAt",
      "operatorKeyId",
      "trustStoreId",
      "trustStoreGeneration",
      "signatureAlgorithm",
      "authorizationSha256",
      "signatureBase64",
    ],
    "authorization",
  );
  if (
    value.schemaVersion !== PROBE_RUN_AUTHORIZATION_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-run-authorization" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    value.signatureAlgorithm !== "Ed25519"
  ) {
    fail("RUN_AUTH_IDENTITY", "authorization identity is invalid");
  }
  requireSha256(value.candidateSha256, "authorization.candidateSha256");
  requireIdentifier(value.campaignRunId, "authorization.campaignRunId");
  validateAttestationReferences(value.attestations);
  requireTimestamp(value.issuedAt, "authorization.issuedAt");
  requireTimestamp(value.expiresAt, "authorization.expiresAt");
  const durationMs = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (durationMs <= 0 || durationMs > PROBE_RUN_AUTHORIZATION_MAXIMUM_MS) {
    fail("RUN_AUTH_WINDOW", "authorization validity must be positive and at most 24 hours");
  }
  requireIdentifier(value.operatorKeyId, "authorization.operatorKeyId");
  requireIdentifier(value.trustStoreId, "authorization.trustStoreId");
  requirePositiveInteger(value.trustStoreGeneration, "authorization.trustStoreGeneration");
  requireSha256(value.authorizationSha256, "authorization.authorizationSha256");
  decodeCanonicalBase64(value.signatureBase64, "authorization.signatureBase64");
  if (value.authorizationSha256 !== deriveProbeRunAuthorizationDigest(value)) {
    fail("RUN_AUTH_DIGEST", "authorization digest is invalid");
  }
  return Object.freeze(value);
}

export function validateProbeOperatorTrustStore(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "trustStoreId", "generation", "keys", "trustStoreSha256"],
    "operator trust store",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-operator-trust-store" ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0
  ) {
    fail("RUN_AUTH_TRUST_STORE", "operator trust store identity is invalid");
  }
  requireIdentifier(value.trustStoreId, "operator trust store.trustStoreId");
  requirePositiveInteger(value.generation, "operator trust store.generation");
  let previous = null;
  const keys = value.keys.map((entry, index) => {
    const label = `operator trust store.keys[${index}]`;
    assertExactKeys(
      entry,
      ["operatorKeyId", "publicKeySpkiBase64", "publicKeySha256", "status"],
      label,
    );
    requireIdentifier(entry.operatorKeyId, `${label}.operatorKeyId`);
    const keyBytes = decodeCanonicalBase64(
      entry.publicKeySpkiBase64,
      `${label}.publicKeySpkiBase64`,
    );
    requireSha256(entry.publicKeySha256, `${label}.publicKeySha256`);
    if (createHash("sha256").update(keyBytes).digest("hex") !== entry.publicKeySha256) {
      fail("RUN_AUTH_TRUST_STORE", `${label} public-key digest is invalid`);
    }
    if (entry.status !== "active" && entry.status !== "revoked") {
      fail("RUN_AUTH_TRUST_STORE", `${label}.status is invalid`);
    }
    if (previous !== null && compareUtf8(previous, entry.operatorKeyId) >= 0) {
      fail("RUN_AUTH_TRUST_STORE", "operator trust-store keys must be sorted and unique");
    }
    previous = entry.operatorKeyId;
    return Object.freeze({ ...entry });
  });
  requireSha256(value.trustStoreSha256, "operator trust store.trustStoreSha256");
  if (value.trustStoreSha256 !== deriveProbeOperatorTrustStoreDigest(value)) {
    fail("RUN_AUTH_TRUST_STORE", "operator trust-store digest is invalid");
  }
  return Object.freeze({ ...value, keys: Object.freeze(keys) });
}

function validateExpectedAttestations(values) {
  if (!Array.isArray(values)) {
    fail("RUN_AUTH_ATTESTATIONS", "expected attestations must be an array");
  }
  return validateAttestationReferences(values);
}

export function verifyProbeRunAuthorizationAtController(value, options) {
  const authorization = validateProbeRunAuthorization(value);
  assertExactKeys(
    options,
    ["trustStore", "candidateSha256", "campaignRunId", "attestations", "verificationInstant"],
    "controller authorization verification options",
  );
  const trustStore = validateProbeOperatorTrustStore(options.trustStore);
  if (
    authorization.trustStoreId !== trustStore.trustStoreId ||
    authorization.trustStoreGeneration !== trustStore.generation
  ) {
    fail("RUN_AUTH_TRUST_STORE", "authorization selects another protected trust store");
  }
  const trustedKey = trustStore.keys.find(
    (entry) => entry.operatorKeyId === authorization.operatorKeyId,
  );
  if (trustedKey === undefined || trustedKey.status !== "active") {
    fail("RUN_AUTH_UNTRUSTED_KEY", "operator key is absent or revoked");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: decodeCanonicalBase64(trustedKey.publicKeySpkiBase64, "operator public key"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("RUN_AUTH_KEY", "operator public key must be SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("RUN_AUTH_KEY", "operator public key must be Ed25519");
  }
  if (
    !verify(
      null,
      Buffer.from(authorization.authorizationSha256, "hex"),
      publicKey,
      decodeCanonicalBase64(authorization.signatureBase64, "authorization.signatureBase64"),
    )
  ) {
    fail("RUN_AUTH_SIGNATURE", "authorization signature is invalid");
  }
  if (
    authorization.candidateSha256 !== options.candidateSha256 ||
    authorization.campaignRunId !== options.campaignRunId
  ) {
    fail("RUN_AUTH_BINDING", "authorization is bound to another candidate or campaign run");
  }
  const expectedAttestations = validateExpectedAttestations(options.attestations);
  if (
    expectedAttestations.some(
      (entry, index) =>
        entry.environmentId !== authorization.attestations[index].environmentId ||
        entry.attestationSha256 !== authorization.attestations[index].attestationSha256,
    )
  ) {
    fail("RUN_AUTH_BINDING", "authorization is bound to another lab attestation set");
  }
  if (
    !(options.verificationInstant instanceof Date) ||
    !Number.isFinite(options.verificationInstant.getTime())
  ) {
    fail("RUN_AUTH_TIMESTAMP", "controller verification instant is invalid");
  }
  const verifiedAt = options.verificationInstant.getTime();
  if (
    verifiedAt < Date.parse(authorization.issuedAt) ||
    verifiedAt >= Date.parse(authorization.expiresAt)
  ) {
    fail("RUN_AUTH_EXPIRED", "authorization is outside its controller verification window");
  }
  return Object.freeze({
    authorization,
    trustStore,
    operatorPublicKeySha256: trustedKey.publicKeySha256,
    verifiedAt: options.verificationInstant.toISOString(),
  });
}

export function validateProbeRunAuthorizationClaimReceipt(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "runPlanSha256",
      "candidateSha256",
      "campaignRunId",
      "environmentId",
      "labAttestationSha256",
      "evidenceRootObjectIdentitySha256",
      "authorizationSha256",
      "operatorKeyId",
      "operatorPublicKeySha256",
      "trustStoreId",
      "trustStoreGeneration",
      "trustStoreSha256",
      "verifiedAt",
      "authorizationExpiresAt",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "authorization claim receipt",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-run-authorization-claim-receipt" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256 ||
    value.signatureAlgorithm !== "Ed25519"
  ) {
    fail("RUN_AUTH_CLAIM_IDENTITY", "authorization claim receipt identity is invalid");
  }
  for (const key of [
    "candidateSha256",
    "labAttestationSha256",
    "evidenceRootObjectIdentitySha256",
    "authorizationSha256",
    "operatorPublicKeySha256",
    "trustStoreSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "receiptSha256",
  ]) {
    requireSha256(value[key], `authorization claim receipt.${key}`);
  }
  for (const key of ["campaignRunId", "environmentId", "operatorKeyId", "trustStoreId"]) {
    requireIdentifier(value[key], `authorization claim receipt.${key}`);
  }
  requirePositiveInteger(
    value.trustStoreGeneration,
    "authorization claim receipt.trustStoreGeneration",
  );
  requireTimestamp(value.verifiedAt, "authorization claim receipt.verifiedAt");
  requireTimestamp(
    value.authorizationExpiresAt,
    "authorization claim receipt.authorizationExpiresAt",
  );
  if (typeof value.controllerVersion !== "string" || value.controllerVersion.length === 0) {
    fail("RUN_AUTH_CLAIM_IDENTITY", "authorization claim controllerVersion is invalid");
  }
  decodeCanonicalBase64(value.signatureBase64, "authorization claim receipt.signatureBase64");
  if (value.receiptSha256 !== deriveProbeRunAuthorizationClaimReceiptDigest(value)) {
    fail("RUN_AUTH_CLAIM_DIGEST", "authorization claim receipt digest is invalid");
  }
  return Object.freeze(value);
}

export function verifyProbeRunAuthorizationClaimReceipt(value, options) {
  const receipt = validateProbeRunAuthorizationClaimReceipt(value);
  assertExactKeys(
    options,
    [
      "authorization",
      "attestation",
      "controllerPublicKeyBytes",
      "evidenceRootObjectIdentitySha256",
    ],
    "authorization claim verification options",
  );
  const authorization = validateProbeRunAuthorization(options.authorization);
  const attestation = validateLabAttestation(options.attestation);
  requireSha256(
    options.evidenceRootObjectIdentitySha256,
    "expected evidence-root object identity digest",
  );
  const expected = {
    campaignId: authorization.campaignId,
    manifestSha256: authorization.manifestSha256,
    runPlanSha256: authorization.runPlanSha256,
    candidateSha256: authorization.candidateSha256,
    campaignRunId: authorization.campaignRunId,
    environmentId: attestation.environmentId,
    labAttestationSha256: attestation.attestationSha256,
    evidenceRootObjectIdentitySha256: options.evidenceRootObjectIdentitySha256,
    authorizationSha256: authorization.authorizationSha256,
    operatorKeyId: authorization.operatorKeyId,
    trustStoreId: authorization.trustStoreId,
    trustStoreGeneration: authorization.trustStoreGeneration,
    authorizationExpiresAt: authorization.expiresAt,
    controllerIdentitySha256: attestation.controller.identitySha256,
    controllerPublicKeySha256: attestation.controller.publicKeySha256,
    controllerVersion: attestation.controller.version,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail("RUN_AUTH_CLAIM_BINDING", `authorization claim ${key} is mismatched`);
    }
  }
  if (
    Date.parse(receipt.verifiedAt) < Date.parse(authorization.issuedAt) ||
    Date.parse(receipt.verifiedAt) >= Date.parse(authorization.expiresAt)
  ) {
    fail("RUN_AUTH_CLAIM_EXPIRED", "authorization claim was issued outside the run window");
  }
  if (!(options.controllerPublicKeyBytes instanceof Uint8Array)) {
    fail("RUN_AUTH_CLAIM_KEY", "controller public-key bytes are required");
  }
  const keyBytes = Buffer.from(
    options.controllerPublicKeyBytes.buffer,
    options.controllerPublicKeyBytes.byteOffset,
    options.controllerPublicKeyBytes.byteLength,
  );
  if (createHash("sha256").update(keyBytes).digest("hex") !== receipt.controllerPublicKeySha256) {
    fail("RUN_AUTH_CLAIM_KEY", "controller public-key bytes do not match the claim");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    fail("RUN_AUTH_CLAIM_KEY", "controller public key must be SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("RUN_AUTH_CLAIM_KEY", "controller public key must be Ed25519");
  }
  if (
    !verify(
      null,
      Buffer.from(receipt.receiptSha256, "hex"),
      publicKey,
      decodeCanonicalBase64(receipt.signatureBase64, "authorization claim signature"),
    )
  ) {
    fail("RUN_AUTH_CLAIM_SIGNATURE", "authorization claim signature is invalid");
  }
  return receipt;
}
