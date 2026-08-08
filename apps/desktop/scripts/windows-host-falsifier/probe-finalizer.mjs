import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadContinuation } from "./continuation.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  analyzeProbeCampaignRecords,
  canonicalProbeJson,
  createExternalCheckpointReplayRegistry,
  deriveProbeOutcomeEvidenceDigest,
  deriveProbeSegmentDigest,
  deriveProbeVerificationInputDigest,
  hashProbeCanonicalJson,
  validateExternalCheckpointEvidence,
  validateLabAttestation,
  validateProbeCandidateIdentity,
  validateProbeSegmentRecord,
} from "./probe-contract.mjs";
import {
  probeControllerActionAttestationPath,
  validateProbeControllerActionAttestation,
} from "./probe-controller-action-provenance.mjs";
import {
  deriveProbeSegmentCommitDigest,
  deriveProbeFinalizationOperationDigest,
  validateProbeFinalizationIntent,
  validateProbeSegmentCommitMarker,
  verifyProbeQuiescenceAbandonmentReceipt,
  verifyProbeQuiescenceCompletionReceipt,
  verifyProbeQuiescenceLeaseReceipt,
  verifyProbeQuiescenceLeaseTransition,
  verifyProbeSegmentCommitMarker,
} from "./probe-finalization-lease.mjs";
import { validatePreparedProbeContext } from "./probe-preflight.mjs";
import {
  validateProbeRunAuthorization,
  validateProbeRunAuthorizationClaimReceipt,
  verifyProbeRunAuthorizationClaimReceipt,
} from "./probe-run-authorization.mjs";
import { getProbeRunWorkItem } from "./probe-runner.mjs";
import {
  assertVerifierSourceDigests,
  loadRetainedProbeVerifier,
} from "./probe-verifier-isolate.mjs";
import { getProbeScenarioDefinition } from "./probe-scenarios.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const strictTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const probeContractSourcePath = "apps/desktop/scripts/windows-host-falsifier/probe-contract.mjs";
const probeVerifierSourcePath = "apps/desktop/scripts/windows-host-falsifier/probe-registry.mjs";
const probeTranscriptSourcePath =
  "apps/desktop/scripts/windows-host-falsifier/probe-transcript.mjs";
const nativeClientSourcePath = "apps/desktop/scripts/windows-host-falsifier/native-client.mjs";
const nativeManifestDigestSourcePath =
  "apps/desktop/scripts/windows-host-falsifier/native-manifest-digest.mjs";
const retainedContractPath = "campaign/verifiers/probe-contract.mjs";
const retainedVerifierPath = "campaign/verifiers/probe-registry.mjs";
const retainedTranscriptPath = "campaign/verifiers/probe-transcript.mjs";
const retainedNativeClientPath = "campaign/verifiers/native-client.mjs";
const retainedNativeManifestDigestPath = "campaign/verifiers/native-manifest-digest.mjs";
const retainedRunAuthorizationPath = "campaign/run-authorization.json";

function runAuthorizationClaimPath(environmentId) {
  return `campaign/run-authorization-claims/${safeCoordinatePart(environmentId, "environmentId")}.json`;
}

export class ProbeFinalizerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeFinalizerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeFinalizerError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, label) {
  if (!exactObject(value)) fail("FINALIZER_SCHEMA", `${label} must be an object`);
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("FINALIZER_SCHEMA", `${label} has unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("FINALIZER_SCHEMA", `${label} is missing key: ${key}`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("FINALIZER_SHA256", `${label} must be lowercase 64-hex`);
  }
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(value)
  ) {
    fail("FINALIZER_IDENTIFIER", `${label} is invalid`);
  }
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("FINALIZER_TIMESTAMP", `${label} must be strict UTC ISO-8601`);
  }
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function framedSha256(fields) {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(String(field), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail("FINALIZER_BASE64", `${label} must be canonical padded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    fail("FINALIZER_BASE64", `${label} must be non-empty canonical padded base64`);
  }
  return decoded;
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("FINALIZER_JSON", `${label} must be valid UTF-8 JSON`);
  }
  if (!exactObject(value) || !Buffer.from(canonicalProbeJson(value), "utf8").equals(bytes)) {
    fail("FINALIZER_CANONICAL_JSON", `${label} must use the canonical retained encoding`);
  }
  return value;
}

function rowDefinition(rowId) {
  const row = PROBE_CAMPAIGN_MANIFEST.rows.find((value) => value.rowId === rowId);
  if (row === undefined) fail("FINALIZER_ROW", `row is not in the frozen campaign: ${rowId}`);
  return row;
}

function variantDefinition(row, variantId) {
  if (row.requiredVariantIds.includes(variantId)) return { conditionId: null };
  const conditional = row.conditionalVariants.find((value) => value.variantId === variantId);
  if (conditional === undefined) {
    fail("FINALIZER_VARIANT", `variant is not in the frozen campaign: ${row.rowId}/${variantId}`);
  }
  return conditional;
}

function safeCoordinatePart(value, label) {
  requireIdentifier(value, label);
  return value.toLocaleLowerCase("en-US");
}

function verifyFinalizerRunAuthorization({
  runAuthorization,
  runAuthorizationClaim,
  controllerPublicKeyBytes,
  candidateSha256,
  campaignRunId,
  currentAttestation,
  evidenceRootObjectIdentitySha256,
}) {
  const authorization = validateProbeRunAuthorization(runAuthorization);
  if (
    authorization.candidateSha256 !== candidateSha256 ||
    authorization.campaignRunId !== campaignRunId
  ) {
    fail("FINALIZER_RUN_AUTH", "run authorization is bound to another candidate or campaign");
  }
  const authorizedCurrent = authorization.attestations.find(
    (value) => value.environmentId === currentAttestation.environmentId,
  );
  if (
    authorizedCurrent === undefined ||
    authorizedCurrent.attestationSha256 !== currentAttestation.attestationSha256
  ) {
    fail("FINALIZER_RUN_AUTH", "current lab attestation is not operator-authorized");
  }
  const claim = verifyProbeRunAuthorizationClaimReceipt(runAuthorizationClaim, {
    authorization,
    attestation: currentAttestation,
    controllerPublicKeyBytes,
    evidenceRootObjectIdentitySha256,
  });
  return Object.freeze({ authorization, claim });
}

function assertPreparedAuthorizationAuthority(prepared, authorization, claim) {
  const expected = {
    runPlanSha256: authorization.runPlanSha256,
    runAuthorizationSha256: authorization.authorizationSha256,
    claimReceiptSha256: claim.receiptSha256,
    operatorKeyId: claim.operatorKeyId,
    operatorPublicKeySha256: claim.operatorPublicKeySha256,
    trustStoreId: claim.trustStoreId,
    trustStoreGeneration: claim.trustStoreGeneration,
    trustStoreSha256: claim.trustStoreSha256,
    verifiedAt: claim.verifiedAt,
    authorizationExpiresAt: claim.authorizationExpiresAt,
  };
  if (!canonicalEqual(prepared.executionBundleManifest.authorization, expected)) {
    fail("FINALIZER_RUN_AUTH", "prepared execution bundle has another authorization authority");
  }
}

export function probeSegmentArtifactPaths({ environmentId, pathProfileId, rowId, variantId }) {
  const base = [
    "segments",
    safeCoordinatePart(environmentId, "environmentId"),
    safeCoordinatePart(pathProfileId, "pathProfileId"),
    safeCoordinatePart(rowId, "rowId"),
    safeCoordinatePart(variantId, "variantId"),
  ].join("/");
  return Object.freeze({
    base,
    rawFacts: `${base}/raw-facts.json`,
    evidence: `${base}/evidence`,
    sourceTranscript: `${base}/evidence/source-transcript.json`,
    sourceTranscriptReceipt: `${base}/evidence/source-transcript-receipt.json`,
    nativeTranscripts: `${base}/evidence/native-transcripts`,
    preparedContext: `${base}/prepared-context.json`,
    finalizationIntent: `${base}/finalization-intent.json`,
    quiescenceAcquisitionReceipt: `${base}/quiescence-acquisition-receipt.json`,
    quiescenceCaptureLeaseReceipt: `${base}/quiescence-capture-lease-receipt.json`,
    nativeSeal: `${base}/native-evidence-seal.json`,
    controllerSealReceipt: `${base}/controller-evidence-seal-receipt.json`,
    segment: `${base}/segment.json`,
    quiescenceCompletionLeaseReceipt: `${base}/quiescence-completion-lease-receipt.json`,
    quiescenceCompletionReceipt: `${base}/quiescence-completion-receipt.json`,
    segmentCommit: `${base}/segment-commit.json`,
    quiescenceAbandonmentReceipt: `${base}/quiescence-abandonment-receipt.json`,
  });
}

function controllerReceiptPayload(value) {
  const { receiptSha256: _receiptSha256, signatureBase64: _signatureBase64, ...payload } = value;
  return payload;
}

export function deriveControllerEvidenceSealReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-evidence-seal-receipt.v1",
    receipt: controllerReceiptPayload(value),
  });
}

function validateNativeEvidenceSeal(value) {
  assertExactKeys(
    value,
    ["mode", "rootObjectIdentity", "entryCount", "entries", "totalBytes", "setSha256"],
    "native evidence seal",
  );
  if (value.mode !== "exact-paths") {
    fail("FINALIZER_NATIVE_SEAL", "authoritative finalization requires an exact-paths native seal");
  }
  if (
    typeof value.rootObjectIdentity !== "string" ||
    value.rootObjectIdentity.length === 0 ||
    value.rootObjectIdentity.length > 512
  ) {
    fail("FINALIZER_NATIVE_SEAL", "native seal root identity is invalid");
  }
  for (const key of ["entryCount", "totalBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail("FINALIZER_NATIVE_SEAL", `native seal ${key} is invalid`);
    }
  }
  if (!Array.isArray(value.entries) || value.entries.length !== value.entryCount) {
    fail("FINALIZER_NATIVE_SEAL", "native seal entry count is inconsistent");
  }
  let previous = null;
  let totalBytes = 0;
  const objectIdentities = new Set();
  const framed = ["enduragent.windows-evidence-artifact-set-seal.v1", value.rootObjectIdentity];
  for (const [index, entry] of value.entries.entries()) {
    assertExactKeys(
      entry,
      ["path", "type", "bytes", "sha256", "objectIdentity"],
      `native evidence seal entry ${index}`,
    );
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path !== entry.path.normalize("NFC") ||
      entry.path
        .split("/")
        .some(
          (part) =>
            part.length === 0 || part === "." || part === ".." || !/^[\x20-\x7e]+$/u.test(part),
        )
    ) {
      fail("FINALIZER_NATIVE_SEAL", `native seal entry ${index} path is invalid`);
    }
    if (previous !== null && compareUtf8(previous, entry.path) >= 0) {
      fail("FINALIZER_NATIVE_SEAL", "native seal entries are not unique and UTF-8 sorted");
    }
    if (
      entry.type !== "file" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 512 * 1024 * 1024
    ) {
      fail("FINALIZER_NATIVE_SEAL", `native seal entry ${index} is not a bounded file`);
    }
    requireSha256(entry.sha256, `native seal entry ${index} sha256`);
    if (
      typeof entry.objectIdentity !== "string" ||
      entry.objectIdentity.length === 0 ||
      entry.objectIdentity.length > 128
    ) {
      fail("FINALIZER_NATIVE_SEAL", `native seal entry ${index} object identity is invalid`);
    }
    if (objectIdentities.has(entry.objectIdentity)) {
      fail("FINALIZER_NATIVE_SEAL", "native seal entries contain a duplicate object identity");
    }
    objectIdentities.add(entry.objectIdentity);
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 1024 * 1024 * 1024) {
      fail("FINALIZER_NATIVE_SEAL", "native seal total byte bound is exceeded");
    }
    framed.push(entry.path, entry.type, String(entry.bytes), entry.sha256, entry.objectIdentity);
    previous = entry.path;
  }
  if (totalBytes !== value.totalBytes) {
    fail("FINALIZER_NATIVE_SEAL", "native seal totalBytes is inconsistent");
  }
  requireSha256(value.setSha256, "native seal setSha256");
  if (framedSha256(framed) !== value.setSha256) {
    fail("FINALIZER_NATIVE_SEAL", "native seal setSha256 is invalid");
  }
  return value;
}

function expectedControllerReceiptBinding(
  prepared,
  nativeSeal,
  rowId,
  variantId,
  runAuthorization,
  finalizationIntent,
  quiescenceLease,
) {
  return {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    quiescenceLeaseId: quiescenceLease.leaseId,
    quiescenceLeaseEpoch: quiescenceLease.leaseEpoch,
    quiescenceRenewalSequence: quiescenceLease.renewalSequence,
    quiescenceLeaseReceiptSha256: quiescenceLease.receiptSha256,
    quiescenceActorSetSha256: quiescenceLease.actorSetSha256,
    quiescenceAcquiredAt: quiescenceLease.acquiredAt,
    quiescenceLeaseExpiresAt: quiescenceLease.expiresAt,
    evidenceRootObjectIdentitySha256: sha256(Buffer.from(nativeSeal.rootObjectIdentity, "utf8")),
    nativeSealSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-native-evidence-seal.v1",
      seal: nativeSeal,
    }),
    controllerIdentitySha256: prepared.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: prepared.executionBundleManifest.controller.version,
  };
}

export function verifyControllerEvidenceSealReceipt(
  receipt,
  {
    preparedContext,
    nativeSeal,
    controllerPublicKeyBytes,
    rowId,
    variantId,
    runAuthorization,
    finalizationIntent,
    quiescenceLease,
  },
) {
  const prepared = validatePreparedProbeContext(preparedContext);
  const validatedSeal = validateNativeEvidenceSeal(nativeSeal);
  const validatedIntent = validateProbeFinalizationIntent(finalizationIntent);
  const validatedLease = verifyProbeQuiescenceLeaseReceipt(quiescenceLease, {
    finalizationIntent: validatedIntent,
    controllerPublicKeyBytes,
    expectedController: {
      identitySha256: prepared.executionBundleManifest.controller.identitySha256,
      publicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
      version: prepared.executionBundleManifest.controller.version,
    },
  });
  if (
    !(controllerPublicKeyBytes instanceof Uint8Array) ||
    controllerPublicKeyBytes.byteLength === 0
  ) {
    fail("FINALIZER_CONTROLLER_KEY", "controller public-key bytes are required");
  }
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "manifestSha256",
      "candidateSha256",
      "campaignRunId",
      "executionRunId",
      "executionBundleId",
      "executionBundleManifestSha256",
      "attemptId",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "runAuthorizationSha256",
      "finalizationOperationSha256",
      "quiescenceLeaseId",
      "quiescenceLeaseEpoch",
      "quiescenceRenewalSequence",
      "quiescenceLeaseReceiptSha256",
      "quiescenceActorSetSha256",
      "quiescenceAcquiredAt",
      "quiescenceLeaseExpiresAt",
      "evidenceRootObjectIdentitySha256",
      "nativeSealSha256",
      "actorsQuiesced",
      "capturedAt",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "controller evidence-seal receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "windows-host-probe-controller-evidence-seal-receipt" ||
    receipt.actorsQuiesced !== true ||
    receipt.signatureAlgorithm !== "Ed25519"
  ) {
    fail("FINALIZER_CONTROLLER_RECEIPT", "controller evidence-seal receipt identity is invalid");
  }
  requireIdentifier(rowId, "rowId");
  requireIdentifier(variantId, "variantId");
  const expected = expectedControllerReceiptBinding(
    prepared,
    validatedSeal,
    rowId,
    variantId,
    runAuthorization,
    validatedIntent,
    validatedLease,
  );
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail("FINALIZER_CONTROLLER_BINDING", `controller receipt ${key} is mismatched`);
    }
  }
  if (
    receipt.evidenceRootObjectIdentitySha256 !==
    prepared.pathProfileObservation.evidenceRootObjectIdentitySha256
  ) {
    fail(
      "FINALIZER_EVIDENCE_ROOT",
      "native evidence seal is not for the preflight-attested evidence root",
    );
  }
  requireTimestamp(receipt.quiescenceAcquiredAt, "controller receipt quiescenceAcquiredAt");
  requireTimestamp(receipt.capturedAt, "controller receipt capturedAt");
  if (Date.parse(receipt.capturedAt) < Date.parse(receipt.quiescenceAcquiredAt)) {
    fail("FINALIZER_CONTROLLER_TIME", "controller evidence seal predates its quiescence lease");
  }
  if (Date.parse(receipt.capturedAt) >= Date.parse(receipt.quiescenceLeaseExpiresAt)) {
    fail("FINALIZER_CONTROLLER_TIME", "controller evidence seal was captured after lease expiry");
  }
  requireSha256(receipt.receiptSha256, "controller receipt receiptSha256");
  if (receipt.receiptSha256 !== deriveControllerEvidenceSealReceiptDigest(receipt)) {
    fail("FINALIZER_CONTROLLER_DIGEST", "controller evidence-seal receipt digest is invalid");
  }
  const keyBytes = Buffer.from(
    controllerPublicKeyBytes.buffer,
    controllerPublicKeyBytes.byteOffset,
    controllerPublicKeyBytes.byteLength,
  );
  if (sha256(keyBytes) !== receipt.controllerPublicKeySha256) {
    fail("FINALIZER_CONTROLLER_KEY", "controller public-key bytes do not match the receipt");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    fail("FINALIZER_CONTROLLER_KEY", "controller public key must be SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("FINALIZER_CONTROLLER_KEY", "controller public key must be Ed25519");
  }
  const signature = decodeCanonicalBase64(receipt.signatureBase64, "controller receipt signature");
  if (!verify(null, Buffer.from(receipt.receiptSha256, "hex"), publicKey, signature)) {
    fail("FINALIZER_CONTROLLER_SIGNATURE", "controller evidence-seal signature is invalid");
  }
  return receipt;
}

async function ensureDirectory(store, relativePath) {
  try {
    await store.createDirectory(relativePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await store.list(relativePath);
  }
}

async function ensureParentDirectories(store, relativePath) {
  const parts = relativePath.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    await ensureDirectory(store, current);
  }
}

async function ensureBytes(store, relativePath, bytes) {
  await ensureParentDirectories(store, relativePath);
  try {
    return await store.writeBytes(relativePath, bytes);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(relativePath);
    if (!retained.bytes.equals(bytes)) {
      fail("FINALIZER_ARTIFACT_COLLISION", `retained artifact differs: ${relativePath}`);
    }
    return { path: relativePath, sha256: retained.sha256 };
  }
}

async function ensureCanonicalJson(store, relativePath, value) {
  return ensureBytes(store, relativePath, Buffer.from(canonicalProbeJson(value), "utf8"));
}

async function collectFiles(store, relativePath) {
  let listing;
  try {
    listing = await store.list(relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const item of listing) {
    const child = `${relativePath}/${item.name}`;
    if (item.kind === "directory") files.push(...(await collectFiles(store, child)));
    else files.push(child);
  }
  return files;
}

function expectedSourceSetSha256(sourceHashes) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-source-set.v1",
    sourceHashes,
  });
}

function candidateSource(candidate, path, label) {
  const source = candidate.sourceHashes.find((artifact) => artifact.path === path);
  if (source === undefined) {
    fail("FINALIZER_VERIFIER_SOURCE", `${label} is absent from the candidate source set`);
  }
  return source;
}

async function retainedProbeVerifier({
  registryArtifact,
  contractArtifact,
  transcriptArtifact,
  nativeClientArtifact,
  nativeManifestDigestArtifact,
  candidate,
}) {
  const candidateRegistry = candidateSource(
    candidate,
    probeVerifierSourcePath,
    "probe verifier source",
  );
  const candidateContract = candidateSource(
    candidate,
    probeContractSourcePath,
    "probe contract source",
  );
  const candidateTranscript = candidateSource(
    candidate,
    probeTranscriptSourcePath,
    "probe transcript reducer source",
  );
  const candidateNativeClient = candidateSource(
    candidate,
    nativeClientSourcePath,
    "native transcript validator source",
  );
  const candidateNativeManifestDigest = candidateSource(
    candidate,
    nativeManifestDigestSourcePath,
    "native manifest digest helper source",
  );
  assertVerifierSourceDigests({
    registrySourceBytes: registryArtifact.bytes,
    registrySourceSha256: candidateRegistry.sha256,
    contractSourceBytes: contractArtifact.bytes,
    contractSourceSha256: candidateContract.sha256,
  });
  if (transcriptArtifact.sha256 !== candidateTranscript.sha256) {
    fail(
      "FINALIZER_VERIFIER_SOURCE",
      "retained transcript reducer source differs from the candidate",
    );
  }
  if (nativeClientArtifact.sha256 !== candidateNativeClient.sha256) {
    fail(
      "FINALIZER_VERIFIER_SOURCE",
      "retained native transcript validator differs from the candidate",
    );
  }
  if (nativeManifestDigestArtifact.sha256 !== candidateNativeManifestDigest.sha256) {
    fail(
      "FINALIZER_VERIFIER_SOURCE",
      "retained native manifest digest helper differs from the candidate",
    );
  }
  return loadRetainedProbeVerifier({
    registrySourceBytes: registryArtifact.bytes,
    contractSourceBytes: contractArtifact.bytes,
    transcriptSourceBytes: transcriptArtifact.bytes,
    nativeClientSourceBytes: nativeClientArtifact.bytes,
    nativeManifestDigestSourceBytes: nativeManifestDigestArtifact.bytes,
  });
}

function expectedSourceTranscriptBinding({
  prepared,
  rowId,
  variantId,
  verifierDefinitionSha256,
  verifierSourceSha256,
}) {
  return {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    labAttestationSha256: prepared.labAttestationSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    preflightSha256: prepared.preflightSha256,
    preparationScopeSha256: prepared.preparationScopeSha256,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    vmSnapshotId: prepared.vmSnapshotId,
    bootIdSha256: prepared.bootIdSha256,
    runnerSessionIdSha256: prepared.runnerSessionIdSha256,
    rootPathSha256: prepared.pathProfileObservation.rootPathSha256,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
    volumeIdSha256: prepared.pathProfileObservation.volumeIdSha256,
    rowId,
    variantId,
    verifierDefinitionSha256,
    verifierSourceSha256,
  };
}

function expectedSourceTranscriptProducer(prepared, transcriptKind) {
  if (transcriptKind === "windows-host-probe-native-transcript") {
    return {
      kind: "native-helper",
      identitySha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
    };
  }
  if (transcriptKind === "windows-host-probe-controller-transcript") {
    return {
      kind: "external-controller",
      identitySha256: prepared.executionBundleManifest.controller.identitySha256,
    };
  }
  fail("FINALIZER_TRANSCRIPT_DEFINITION", "verifier transcript kind is not allowlisted");
}

async function loadTrustedNativeTranscripts({ store, paths, prepared, retainedVerifier, segment }) {
  let listing;
  try {
    listing = await store.list(paths.nativeTranscripts);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript directory is missing");
    }
    throw error;
  }
  if (listing.length === 0 || listing.some((entry) => entry.kind !== "file")) {
    fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript directory must contain only files");
  }
  const identities = [];
  const sessions = new Set();
  const digests = new Set();
  for (const entry of listing) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript filename is not digest-addressed");
    }
    const path = `${paths.nativeTranscripts}/${entry.name}`;
    if (segment !== undefined) artifactByPath(segment, path, "native command transcript");
    const artifact = await store.readArtifact(path);
    const transcript = await retainedVerifier.validateNativeTranscript(artifact.bytes);
    if (transcript.records.length === 0) {
      fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript contains no command evidence");
    }
    if (`${transcript.transcriptSha256}.json` !== entry.name) {
      fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript path differs from its digest");
    }
    if (
      transcript.binding.campaignRunId !== prepared.campaignRunId ||
      transcript.binding.candidateSha256 !== prepared.candidateSha256 ||
      transcript.binding.preflightSha256 !== prepared.preflightSha256 ||
      transcript.binding.executionBundleManifestSha256 !== prepared.executionBundleManifestSha256 ||
      transcript.binding.nativeHelperArtifactPath !==
        prepared.executionBundleManifest.binaries.nativeHelper.path ||
      transcript.binding.nativeHelperSha256 !==
        prepared.executionBundleManifest.binaries.nativeHelper.sha256 ||
      transcript.binding.nativeCandidateDigest !==
        prepared.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest ||
      transcript.binding.nativeManifestSha256 !==
        prepared.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256 ||
      sha256(Buffer.from(transcript.binding.runRootIdentity, "utf8")) !==
        prepared.pathProfileObservation.evidenceRootObjectIdentitySha256
    ) {
      fail(
        "FINALIZER_NATIVE_TRANSCRIPT_BINDING",
        "native transcript differs from the prepared execution identity",
      );
    }
    if (
      sessions.has(transcript.binding.nativeSessionId) ||
      digests.has(transcript.transcriptSha256)
    ) {
      fail("FINALIZER_NATIVE_TRANSCRIPT", "native transcript identity is duplicated");
    }
    sessions.add(transcript.binding.nativeSessionId);
    digests.add(transcript.transcriptSha256);
    identities.push({
      transcriptSha256: transcript.transcriptSha256,
      binding: transcript.binding,
      bytes: Buffer.from(artifact.bytes),
    });
  }
  identities.sort((left, right) =>
    compareUtf8(left.binding.nativeSessionId, right.binding.nativeSessionId),
  );
  return identities;
}

async function loadTrustedControllerActionAttestations({
  store,
  rowId,
  variantId,
  sourceTranscript,
  segment,
}) {
  if (!Array.isArray(sourceTranscript.commandEvents)) {
    fail("FINALIZER_ACTION_ATTESTATION", "source transcript command events are invalid");
  }
  const definition = getProbeScenarioDefinition(rowId, variantId);
  const workItem = getProbeRunWorkItem({
    environmentId: sourceTranscript.binding.environmentId,
    pathProfileId: sourceTranscript.binding.pathProfileId,
    rowId,
    variantId,
  });
  const seen = new Set();
  const attestations = [];
  for (const event of sourceTranscript.commandEvents) {
    if (event.actionAttestationSha256 === null) continue;
    requireSha256(event.actionAttestationSha256, "source command action attestation");
    if (seen.has(event.actionAttestationSha256)) {
      fail("FINALIZER_ACTION_ATTESTATION", "source transcript reuses an action attestation");
    }
    const actions = definition.actions.filter(
      ({ capture }) =>
        capture !== null &&
        capture.sequence === event.sequence &&
        capture.commandId === event.commandId,
    );
    if (actions.length !== 1 || actions[0].actor !== "external-controller") {
      fail(
        "FINALIZER_ACTION_ATTESTATION",
        "source command does not identify one external-controller producing action",
      );
    }
    const action = actions[0];
    const repetition = workItem.requiresExternalCheckpoint
      ? action.phase === "setup"
        ? 1
        : action.phase === "capture"
          ? workItem.continuationRepetitions
          : action.parameters.repetition
      : null;
    const coordinate = {
      campaignRunId: sourceTranscript.binding.campaignRunId,
      executionRunId: sourceTranscript.binding.executionRunId,
      attemptId: sourceTranscript.binding.attemptId,
      workId: workItem.workId,
      environmentId: sourceTranscript.binding.environmentId,
      pathProfileId: sourceTranscript.binding.pathProfileId,
      rowId,
      variantId,
      repetition,
    };
    const path = probeControllerActionAttestationPath({
      coordinate,
      producerActionId: action.actionId,
    });
    if (segment !== undefined) artifactByPath(segment, path, "controller action attestation");
    const artifact = await store.readArtifact(path);
    const attestation = validateProbeControllerActionAttestation(
      parseCanonicalJson(artifact.bytes, "controller action attestation"),
    );
    if (attestation.attestationSha256 !== event.actionAttestationSha256) {
      fail(
        "FINALIZER_ACTION_ATTESTATION",
        "retained controller action attestation differs from the source command",
      );
    }
    if (
      attestation.producerActionId !== action.actionId ||
      canonicalProbeJson(attestation.coordinate) !== canonicalProbeJson(coordinate)
    ) {
      fail(
        "FINALIZER_ACTION_ATTESTATION",
        "retained controller action attestation differs from the frozen producing action",
      );
    }
    seen.add(event.actionAttestationSha256);
    attestations.push(Buffer.from(artifact.bytes));
  }
  return attestations;
}

async function replayProbeSourceTranscript({
  store,
  paths,
  prepared,
  rowId,
  variantId,
  verifierDefinition,
  verifierSourceSha256,
  retainedVerifier,
  controllerPublicKeyBytes,
  segment,
}) {
  const sourceArtifact = await store.readArtifact(paths.sourceTranscript);
  const receiptArtifact = await store.readArtifact(paths.sourceTranscriptReceipt);
  const sourceTranscript = parseCanonicalJson(sourceArtifact.bytes, "source transcript");
  if (segment !== undefined) {
    artifactByPath(segment, paths.sourceTranscript, "source transcript");
    artifactByPath(segment, paths.sourceTranscriptReceipt, "source transcript receipt");
  }
  const trustedMapping = await retainedVerifier.getTranscriptFactDefinition(rowId, variantId);
  if (
    trustedMapping.definitionSha256 !== verifierDefinition.definitionSha256 ||
    trustedMapping.transcriptKind !== verifierDefinition.transcriptKind ||
    trustedMapping.rawFactSchemaId !== verifierDefinition.rawFactSchemaId
  ) {
    fail("FINALIZER_TRANSCRIPT_DEFINITION", "retained transcript fact mapping drifted");
  }
  const trustedNativeTranscripts = await loadTrustedNativeTranscripts({
    store,
    paths,
    prepared,
    retainedVerifier,
    segment,
  });
  const trustedControllerActionAttestations = await loadTrustedControllerActionAttestations({
    store,
    rowId,
    variantId,
    sourceTranscript,
    segment,
  });
  const expectedBinding = expectedSourceTranscriptBinding({
    prepared,
    rowId,
    variantId,
    verifierDefinitionSha256: verifierDefinition.definitionSha256,
    verifierSourceSha256,
  });
  const controller = prepared.executionBundleManifest.controller;
  return retainedVerifier.reduceTranscript({
    sourceTranscriptBytes: sourceArtifact.bytes,
    expectedBinding,
    expectedProducer: expectedSourceTranscriptProducer(prepared, verifierDefinition.transcriptKind),
    expectedController: {
      identitySha256: controller.identitySha256,
      publicKeySha256: controller.publicKeySha256,
      version: controller.version,
    },
    controllerPublicKeyBytes,
    controllerReceipt: parseCanonicalJson(
      receiptArtifact.bytes,
      "source transcript controller receipt",
    ),
    trustedNativeTranscriptBytes: trustedNativeTranscripts.map((entry) => entry.bytes),
    trustedControllerActionAttestationBytes: trustedControllerActionAttestations,
    trustedDefinition: {
      rowId,
      variantId,
      definitionSha256: verifierDefinition.definitionSha256,
      verifierSourceSha256,
      transcriptKind: trustedMapping.transcriptKind,
      commands: trustedMapping.commands,
    },
  });
}

function validateRepositoryState(value, candidate, prepared, label) {
  assertExactKeys(value, ["repositoryCommit", "repositoryDirty", "sourceHashes"], label);
  if (!commitPattern.test(value.repositoryCommit) || value.repositoryDirty !== false) {
    fail("FINALIZER_SOURCE_STATE", `${label} is not a clean exact repository state`);
  }
  if (
    value.repositoryCommit !== candidate.repositoryCommit ||
    !canonicalEqual(value.sourceHashes, candidate.sourceHashes) ||
    expectedSourceSetSha256(value.sourceHashes) !==
      prepared.executionBundleManifest.repository.sourceSetSha256
  ) {
    fail("FINALIZER_SOURCE_DRIFT", `${label} differs from the frozen candidate`);
  }
  return value;
}

function validateProvenanceTiming(value) {
  assertExactKeys(value, ["startedAt", "endedAt", "monotonicDurationMs"], "provenance timing");
  requireTimestamp(value.startedAt, "provenance startedAt");
  requireTimestamp(value.endedAt, "provenance endedAt");
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    fail("FINALIZER_TIME_ORDER", "segment ended before it started");
  }
  if (
    typeof value.monotonicDurationMs !== "number" ||
    !Number.isFinite(value.monotonicDurationMs) ||
    value.monotonicDurationMs < 0
  ) {
    fail("FINALIZER_DURATION", "segment monotonic duration is invalid");
  }
  return value;
}

function validateFinalizationStart(value) {
  assertExactKeys(value, ["startedAt", "startedMonotonicMs"], "finalization start");
  requireTimestamp(value.startedAt, "finalization startedAt");
  if (
    typeof value.startedMonotonicMs !== "number" ||
    !Number.isFinite(value.startedMonotonicMs) ||
    value.startedMonotonicMs < 0
  ) {
    fail("FINALIZER_DURATION", "finalization startedMonotonicMs is invalid");
  }
  return value;
}

function captureFinalizationEnd(start, adapters) {
  const ended = adapters.now();
  const endedMonotonicMs = adapters.monotonicNow();
  if (!(ended instanceof Date) || !Number.isFinite(ended.getTime())) {
    fail("FINALIZER_CLOCK", "finalizer clock returned an invalid instant");
  }
  if (
    typeof endedMonotonicMs !== "number" ||
    !Number.isFinite(endedMonotonicMs) ||
    endedMonotonicMs < start.startedMonotonicMs
  ) {
    fail("FINALIZER_CLOCK", "finalizer monotonic clock moved backwards or is invalid");
  }
  return validateProvenanceTiming({
    startedAt: start.startedAt,
    endedAt: ended.toISOString(),
    monotonicDurationMs: endedMonotonicMs - start.startedMonotonicMs,
  });
}

function continuationScopeMatches(header, prepared, rowId, variantId, repetition, chainId) {
  const expected = {
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    labAttestationSha256: prepared.labAttestationSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
    attemptId: prepared.attemptId,
    vmSnapshotId: prepared.vmSnapshotId,
    repetition,
    chainId,
  };
  return Object.entries(expected).every(([key, expectedValue]) => header[key] === expectedValue);
}

async function loadFinalizerContinuations({
  store,
  prepared,
  attestation,
  rowId,
  variantId,
  chainIds,
  controllerPublicKeyBytes,
}) {
  const hardCut = variantId.startsWith("f07-hard-cut-");
  const repetitions = hardCut
    ? PROBE_CAMPAIGN_MANIFEST.parameters.f07Durability.repetitionsPerHardCutCheckpoint
    : 1;
  if (
    !Array.isArray(chainIds) ||
    chainIds.length !== repetitions ||
    new Set(chainIds).size !== chainIds.length
  ) {
    fail("FINALIZER_CONTINUATIONS", `segment requires ${repetitions} unique continuation chains`);
  }
  const continuations = [];
  const externalCheckpoints = [];
  const checkpointArtifactDigests = new Map();
  const replayRegistry = createExternalCheckpointReplayRegistry();
  for (let index = 0; index < repetitions; index += 1) {
    const repetition = index + 1;
    const chainId = chainIds[index];
    requireIdentifier(chainId, `chainIds[${index}]`);
    const chain = await loadContinuation({ store, chainId });
    if (!continuationScopeMatches(chain.header, prepared, rowId, variantId, repetition, chainId)) {
      fail("FINALIZER_CONTINUATION_SCOPE", `continuation scope differs: ${chainId}`);
    }
    if (
      chain.entries.length === 0 ||
      chain.previousEntrySha256 === null ||
      chain.closure === null
    ) {
      fail("FINALIZER_CONTINUATION_OPEN", `continuation is empty or open: ${chainId}`);
    }
    const receiptSha256 =
      chain.closure.kind === "windows-host-probe-local-continuation-receipt"
        ? chain.closure.receiptSha256
        : chain.closure.checkpointEvidence.receipt.receiptSha256;
    const continuation = {
      repetition,
      chainId,
      scopeSha256: chain.header.scopeSha256,
      headerSha256: chain.header.headerSha256,
      terminalEntrySha256: chain.previousEntrySha256,
      receiptSha256,
    };
    if (hardCut) {
      if (chain.closure.kind !== "windows-host-probe-consumed-external-receipt") {
        fail("FINALIZER_CONTINUATION_KIND", "hard-cut segment requires an external receipt");
      }
      const segmentShell = {
        campaignId: prepared.campaignId,
        manifestSha256: prepared.manifestSha256,
        candidateSha256: prepared.candidateSha256,
        environmentId: prepared.environmentId,
        pathProfileId: prepared.pathProfileId,
        rowId,
        variantId,
        provenance: {
          campaignRunId: prepared.campaignRunId,
          executionRunId: prepared.executionRunId,
          executionBundleId: prepared.executionBundleId,
          executionBundleManifestSha256: prepared.executionBundleManifestSha256,
          attemptId: prepared.attemptId,
          vmSnapshotId: prepared.vmSnapshotId,
        },
      };
      validateExternalCheckpointEvidence(chain.closure.checkpointEvidence, {
        segment: segmentShell,
        continuation,
        repetition,
        replayRegistry,
        expectedController: attestation.controller,
        controllerPublicKeyBytes,
      });
      for (const artifact of chain.closure.checkpointEvidence.receipt.artifactHashes) {
        const retained = await store.readArtifact(artifact.path);
        if (retained.sha256 !== artifact.sha256) {
          fail(
            "FINALIZER_CHECKPOINT_ARTIFACT",
            `external checkpoint artifact changed: ${artifact.path}`,
          );
        }
        const prior = checkpointArtifactDigests.get(artifact.path);
        if (prior !== undefined && prior !== artifact.sha256) {
          fail(
            "FINALIZER_CHECKPOINT_ARTIFACT",
            `external checkpoint artifact has conflicting digests: ${artifact.path}`,
          );
        }
        checkpointArtifactDigests.set(artifact.path, artifact.sha256);
      }
      externalCheckpoints.push(chain.closure.checkpointEvidence);
    } else if (chain.closure.kind !== "windows-host-probe-local-continuation-receipt") {
      fail("FINALIZER_CONTINUATION_KIND", "ordinary segment requires a local receipt");
    }
    continuations.push(continuation);
  }
  return {
    continuations,
    externalCheckpoints,
    checkpointArtifactPaths: [...checkpointArtifactDigests.keys()].sort(compareUtf8),
  };
}

function sortedUniqueDigests(values, label) {
  if (!Array.isArray(values)) fail("FINALIZER_DIGEST_SET", `${label} must be an array`);
  for (const value of values) requireSha256(value, label);
  const sorted = [...values].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length) {
    fail("FINALIZER_DIGEST_SET", `${label} must not contain duplicates`);
  }
  return sorted;
}

function orderedUniqueChainIds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("FINALIZER_CONTINUATIONS", "continuationChainIds must be a non-empty array");
  }
  const seen = new Set();
  return values.map((value, index) => {
    requireIdentifier(value, `continuationChainIds[${index}]`);
    if (seen.has(value)) {
      fail("FINALIZER_CONTINUATIONS", "continuationChainIds must not contain duplicates");
    }
    seen.add(value);
    return value;
  });
}

function createFinalizationIntent({
  prepared,
  runAuthorization,
  runAuthorizationClaim,
  rowId,
  variantId,
  continuationChainIds,
  upstreamSelectionDigests,
  startedAt,
}) {
  requireTimestamp(startedAt, "finalization startedAt");
  const unsigned = {
    schemaVersion: 1,
    kind: "windows-host-probe-finalization-intent",
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaim.receiptSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
    continuationChainIds: orderedUniqueChainIds(continuationChainIds),
    upstreamSelectionDigests: sortedUniqueDigests(
      upstreamSelectionDigests,
      "upstreamSelectionDigests",
    ),
    startedAt,
  };
  return validateProbeFinalizationIntent({
    ...unsigned,
    finalizationOperationSha256: deriveProbeFinalizationOperationDigest(unsigned),
  });
}

async function artifactHashesForPaths(store, paths) {
  const sorted = [...new Set(paths)].sort(compareUtf8);
  const folded = new Set();
  const artifacts = [];
  for (const path of sorted) {
    const lower = path.toLocaleLowerCase("en-US");
    if (folded.has(lower)) fail("FINALIZER_ARTIFACT_COLLISION", "artifact paths case-collide");
    const artifact = await store.readArtifact(path);
    artifacts.push({ path, sha256: artifact.sha256 });
    folded.add(lower);
  }
  return artifacts;
}

async function artifactHashesMatchingNativeSeal(store, paths, nativeSeal) {
  const artifacts = await artifactHashesForPaths(store, paths);
  if (artifacts.length !== nativeSeal.entries.length) {
    fail("FINALIZER_NATIVE_ARTIFACT_SET", "native seal has another artifact count");
  }
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const nativeEntry = nativeSeal.entries[index];
    if (artifact.path !== nativeEntry.path || artifact.sha256 !== nativeEntry.sha256) {
      fail("FINALIZER_NATIVE_ARTIFACT_SET", "native seal differs from the retained artifact set");
    }
    const retained = await store.readArtifact(artifact.path);
    if (retained.bytes.byteLength !== nativeEntry.bytes) {
      fail("FINALIZER_NATIVE_ARTIFACT_SET", "native seal byte count differs from an artifact");
    }
  }
  return artifacts;
}

function requireExactSegmentArtifactSet(segment, paths, nativeSeal) {
  const expected = [
    ...nativeSeal.entries.map((entry) => entry.path),
    paths.nativeSeal,
    paths.controllerSealReceipt,
  ].sort(compareUtf8);
  const actual = segment.artifactHashes.map((artifact) => artifact.path);
  if (!canonicalEqual(actual, expected)) {
    fail("FINALIZER_NATIVE_ARTIFACT_SET", "segment contains an unsealed or missing artifact");
  }
}

function artifactByPath(segment, path, label) {
  const artifact = segment.artifactHashes.find((value) => value.path === path);
  if (artifact === undefined) {
    fail("FINALIZER_ARTIFACT_MISSING", `${label} is not bound by the segment artifact set`);
  }
  return artifact;
}

function requireCanonicalArtifactValue(artifact, expected, label) {
  const actual = parseCanonicalJson(artifact.bytes, label);
  if (!canonicalEqual(actual, expected)) {
    fail("FINALIZER_ARTIFACT_VALUE", `${label} differs from the expected value`);
  }
  return actual;
}

function verificationMatchesSegment(verification, segment) {
  return (
    verification.outcome === segment.outcome &&
    verification.verifierId === segment.verifierId &&
    verification.verifierSourceSha256 === segment.verifierSourceSha256 &&
    verification.mechanismId === segment.mechanismId &&
    canonicalEqual(verification.verificationMetrics, segment.verificationMetrics) &&
    canonicalEqual(verification.observations, segment.observations) &&
    canonicalEqual(verification.unavailability, segment.unavailability)
  );
}

function expectedControllerIdentity(prepared) {
  return {
    identitySha256: prepared.executionBundleManifest.controller.identitySha256,
    publicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    version: prepared.executionBundleManifest.controller.version,
  };
}

async function readOptionalCanonicalArtifact(store, path, label) {
  try {
    const artifact = await store.readArtifact(path);
    return Object.freeze({ artifact, value: parseCanonicalJson(artifact.bytes, label) });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function segmentProofFromArtifact(segment, artifact) {
  return Object.freeze({
    segmentPath: artifact.path,
    segmentSha256: segment.segmentSha256,
    segmentArtifactSha256: artifact.sha256,
    verificationInputSha256: segment.verificationInputSha256,
    outcomeEvidenceSha256: segment.outcomeEvidenceSha256,
  });
}

function assertSameLeaseEpoch(acquisition, lease) {
  if (
    lease.leaseId !== acquisition.leaseId ||
    lease.leaseEpoch !== acquisition.leaseEpoch ||
    lease.acquiredAt !== acquisition.acquiredAt ||
    lease.actorSetSha256 !== acquisition.actorSetSha256 ||
    lease.renewalSequence < acquisition.renewalSequence ||
    lease.renewalSequence > acquisition.renewalSequence + 2
  ) {
    fail("FINALIZER_LEASE_RECOVERY", "controller returned an ambiguous lease epoch");
  }
  if (
    lease.renewalSequence === acquisition.renewalSequence &&
    lease.receiptSha256 !== acquisition.receiptSha256
  ) {
    fail("FINALIZER_LEASE_RECOVERY", "controller changed the acquisition receipt");
  }
}

function verifyLeaseReceipt(receipt, finalizationIntent, controllerPublicKeyBytes, prepared) {
  return verifyProbeQuiescenceLeaseReceipt(receipt, {
    finalizationIntent,
    controllerPublicKeyBytes,
    expectedController: expectedControllerIdentity(prepared),
  });
}

function verifyLeaseTransition(
  receipt,
  previousReceipt,
  finalizationIntent,
  controllerPublicKeyBytes,
  prepared,
) {
  return verifyProbeQuiescenceLeaseTransition(receipt, {
    previousReceipt,
    finalizationIntent,
    controllerPublicKeyBytes,
    expectedController: expectedControllerIdentity(prepared),
  });
}

async function retainStageLease({
  store,
  path,
  label,
  expectedSequence,
  previousReceipt,
  currentReceipt,
  finalizationIntent,
  controllerPublicKeyBytes,
  prepared,
  renew,
}) {
  const retained = await readOptionalCanonicalArtifact(store, path, label);
  let receipt;
  if (retained !== null) {
    receipt = verifyLeaseTransition(
      retained.value,
      previousReceipt,
      finalizationIntent,
      controllerPublicKeyBytes,
      prepared,
    );
    if (
      currentReceipt.renewalSequence < receipt.renewalSequence ||
      currentReceipt.renewalSequence > receipt.renewalSequence + 1 ||
      (currentReceipt.renewalSequence === receipt.renewalSequence &&
        currentReceipt.receiptSha256 !== receipt.receiptSha256)
    ) {
      fail("FINALIZER_LEASE_RECOVERY", `${label} differs from the controller journal`);
    }
  } else if (currentReceipt.renewalSequence === expectedSequence) {
    receipt = verifyLeaseTransition(
      currentReceipt,
      previousReceipt,
      finalizationIntent,
      controllerPublicKeyBytes,
      prepared,
    );
  } else if (currentReceipt.renewalSequence === previousReceipt.renewalSequence) {
    receipt = verifyLeaseTransition(
      await renew(),
      previousReceipt,
      finalizationIntent,
      controllerPublicKeyBytes,
      prepared,
    );
  } else {
    fail("FINALIZER_LEASE_RECOVERY", `${label} is missing from an advanced controller journal`);
  }
  if (receipt.renewalSequence !== expectedSequence) {
    fail("FINALIZER_LEASE_RECOVERY", `${label} has an unexpected renewal sequence`);
  }
  await ensureCanonicalJson(store, path, receipt);
  return receipt;
}

export async function verifyCommittedProbeSegment({ store, commitPath, candidate, attestation }) {
  if (!exactObject(store) || typeof store.readArtifact !== "function") {
    fail("FINALIZER_STORE", "an evidence store is required");
  }
  const validatedCandidate = validateProbeCandidateIdentity(candidate);
  const validatedAttestation = validateLabAttestation(attestation);
  const commitArtifact = await store.readArtifact(commitPath);
  const commit = validateProbeSegmentCommitMarker(
    parseCanonicalJson(commitArtifact.bytes, "segment commit marker"),
  );
  const segment = await verifyFinalizedProbeSegment({
    store,
    segmentPath: commit.segmentPath,
    candidate: validatedCandidate,
    attestation: validatedAttestation,
  });
  const paths = probeSegmentArtifactPaths({
    environmentId: segment.environmentId,
    pathProfileId: segment.pathProfileId,
    rowId: segment.rowId,
    variantId: segment.variantId,
  });
  if (commitPath !== paths.segmentCommit || commit.segmentPath !== paths.segment) {
    fail("FINALIZER_COMMIT_PATH", "segment commit marker is stored under another coordinate");
  }
  const segmentArtifact = await store.readArtifact(paths.segment);
  const segmentProof = segmentProofFromArtifact(segment, segmentArtifact);
  const preparedArtifact = await store.readArtifact(paths.preparedContext);
  const prepared = validatePreparedProbeContext(
    parseCanonicalJson(preparedArtifact.bytes, "prepared commit context"),
  );
  const intentArtifact = await store.readArtifact(paths.finalizationIntent);
  const finalizationIntent = validateProbeFinalizationIntent(
    parseCanonicalJson(intentArtifact.bytes, "committed finalization intent"),
  );
  const controllerKeyArtifact = await store.readArtifact(prepared.controllerPublicKeyArtifact.path);
  if (controllerKeyArtifact.sha256 !== prepared.controllerPublicKeyArtifact.sha256) {
    fail("FINALIZER_CONTROLLER_KEY", "retained controller public key changed");
  }
  const controllerPublicKeyBytes = controllerKeyArtifact.bytes;
  const acquisitionArtifact = await store.readArtifact(paths.quiescenceAcquisitionReceipt);
  const acquisitionReceipt = verifyLeaseReceipt(
    parseCanonicalJson(acquisitionArtifact.bytes, "quiescence acquisition receipt"),
    finalizationIntent,
    controllerPublicKeyBytes,
    prepared,
  );
  if (acquisitionReceipt.renewalSequence !== 0) {
    fail("FINALIZER_LEASE_RECOVERY", "quiescence acquisition is not renewal sequence zero");
  }
  const captureLeaseArtifact = await store.readArtifact(paths.quiescenceCaptureLeaseReceipt);
  const captureLeaseReceipt = verifyLeaseTransition(
    parseCanonicalJson(captureLeaseArtifact.bytes, "quiescence capture lease receipt"),
    acquisitionReceipt,
    finalizationIntent,
    controllerPublicKeyBytes,
    prepared,
  );
  if (captureLeaseReceipt.renewalSequence !== 1) {
    fail("FINALIZER_LEASE_RECOVERY", "capture lease is not renewal sequence one");
  }
  const finalLeaseArtifact = await store.readArtifact(paths.quiescenceCompletionLeaseReceipt);
  const finalLeaseReceipt = verifyLeaseTransition(
    parseCanonicalJson(finalLeaseArtifact.bytes, "quiescence completion lease receipt"),
    captureLeaseReceipt,
    finalizationIntent,
    controllerPublicKeyBytes,
    prepared,
  );
  if (finalLeaseReceipt.renewalSequence !== 2) {
    fail("FINALIZER_LEASE_RECOVERY", "completion lease is not renewal sequence two");
  }
  const captureArtifact = await store.readArtifact(paths.controllerSealReceipt);
  const captureReceipt = verifyControllerEvidenceSealReceipt(
    parseCanonicalJson(captureArtifact.bytes, "controller evidence-seal receipt"),
    {
      preparedContext: prepared,
      nativeSeal: parseCanonicalJson(
        (await store.readArtifact(paths.nativeSeal)).bytes,
        "native evidence seal",
      ),
      controllerPublicKeyBytes,
      rowId: segment.rowId,
      variantId: segment.variantId,
      runAuthorization: validateProbeRunAuthorization(
        parseCanonicalJson(
          (await store.readArtifact(retainedRunAuthorizationPath)).bytes,
          "run authorization",
        ),
      ),
      finalizationIntent,
      quiescenceLease: captureLeaseReceipt,
    },
  );
  const completionArtifact = await store.readArtifact(paths.quiescenceCompletionReceipt);
  const completionReceipt = verifyProbeQuiescenceCompletionReceipt(
    parseCanonicalJson(completionArtifact.bytes, "quiescence completion receipt"),
    {
      finalizationIntent,
      leaseReceipt: finalLeaseReceipt,
      evidenceCaptureReceiptSha256: captureReceipt.receiptSha256,
      segmentProof,
      controllerPublicKeyBytes,
      expectedController: expectedControllerIdentity(prepared),
    },
  );
  verifyProbeSegmentCommitMarker(commit, {
    finalizationIntent,
    acquisitionReceipt,
    finalLeaseReceipt,
    completionReceipt,
  });
  const runAuthorization = validateProbeRunAuthorization(
    parseCanonicalJson(
      (await store.readArtifact(retainedRunAuthorizationPath)).bytes,
      "committed run authorization",
    ),
  );
  const runAuthorizationClaim = validateProbeRunAuthorizationClaimReceipt(
    parseCanonicalJson(
      (await store.readArtifact(runAuthorizationClaimPath(segment.environmentId))).bytes,
      "committed run authorization claim",
    ),
  );
  const verifiedAuthority = verifyFinalizerRunAuthorization({
    runAuthorization,
    runAuthorizationClaim,
    controllerPublicKeyBytes,
    candidateSha256: validatedCandidate.candidateSha256,
    campaignRunId: segment.provenance.campaignRunId,
    currentAttestation: validatedAttestation,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  });
  return Object.freeze({
    segment,
    path: paths.segment,
    commit,
    commitPath: paths.segmentCommit,
    runAuthorization: verifiedAuthority.authorization,
    runAuthorizationClaim: verifiedAuthority.claim,
  });
}

async function recoverFinalizedProbeSegment({
  store,
  paths,
  prepared,
  candidate,
  attestation,
  continuationChainIds,
  upstreamSelectionDigests,
  startedAt,
  runAuthorization,
  finalizationIntent,
}) {
  try {
    await store.readArtifact(paths.segmentCommit);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const committed = await verifyCommittedProbeSegment({
    store,
    commitPath: paths.segmentCommit,
    candidate,
    attestation,
  });
  const segment = committed.segment;
  const retainedPreparedArtifact = await store.readArtifact(paths.preparedContext);
  const retainedPrepared = validatePreparedProbeContext(
    parseCanonicalJson(retainedPreparedArtifact.bytes, "prepared context"),
  );
  const retainedChainIds = segment.continuations.map((continuation) => continuation.chainId);
  const retainedIntentArtifact = await store.readArtifact(paths.finalizationIntent);
  const retainedIntent = validateProbeFinalizationIntent(
    parseCanonicalJson(retainedIntentArtifact.bytes, "finalization intent"),
  );
  const expectedUpstream = sortedUniqueDigests(
    upstreamSelectionDigests,
    "upstreamSelectionDigests",
  );
  if (
    !canonicalEqual(retainedPrepared, prepared) ||
    !canonicalEqual(retainedIntent, finalizationIntent) ||
    retainedIntent.runAuthorizationSha256 !== runAuthorization.authorizationSha256 ||
    !canonicalEqual(retainedChainIds, continuationChainIds) ||
    !canonicalEqual(segment.upstreamSelectionDigests, expectedUpstream) ||
    segment.provenance.startedAt !== startedAt
  ) {
    fail(
      "FINALIZER_SEGMENT_COLLISION",
      "segment coordinate was finalized from another exact invocation",
    );
  }
  return Object.freeze({
    segment,
    path: paths.segment,
    commit: committed.commit,
    commitPath: paths.segmentCommit,
  });
}

export async function verifyFinalizedProbeSegment({ store, segmentPath, candidate, attestation }) {
  if (!exactObject(store) || typeof store.readArtifact !== "function") {
    fail("FINALIZER_STORE", "an evidence store is required");
  }
  const validatedCandidate = validateProbeCandidateIdentity(candidate);
  const validatedAttestation = validateLabAttestation(attestation);
  const segmentArtifact = await store.readArtifact(segmentPath);
  const segment = validateProbeSegmentRecord(
    parseCanonicalJson(segmentArtifact.bytes, "finalized segment"),
  );
  const paths = probeSegmentArtifactPaths({
    environmentId: segment.environmentId,
    pathProfileId: segment.pathProfileId,
    rowId: segment.rowId,
    variantId: segment.variantId,
  });
  if (segmentPath !== paths.segment) {
    fail("FINALIZER_SEGMENT_PATH", "segment record is stored under another coordinate");
  }
  if (
    segment.candidateSha256 !== validatedCandidate.candidateSha256 ||
    segment.labAttestationSha256 !== validatedAttestation.attestationSha256 ||
    segment.environmentId !== validatedAttestation.environmentId
  ) {
    fail("FINALIZER_CONTEXT_BINDING", "segment, candidate, and attestation differ");
  }
  await store.verifyArtifactSet(segment.artifactHashes);

  const runAuthorizationArtifact = await store.readArtifact(retainedRunAuthorizationPath);
  artifactByPath(segment, retainedRunAuthorizationPath, "run authorization");
  const retainedRunAuthorization = validateProbeRunAuthorization(
    parseCanonicalJson(runAuthorizationArtifact.bytes, "run authorization"),
  );
  const preparedAuthorityArtifact = await store.readArtifact(paths.preparedContext);
  const preparedAuthorityContext = validatePreparedProbeContext(
    parseCanonicalJson(preparedAuthorityArtifact.bytes, "prepared authority context"),
  );
  const authorityControllerKeyArtifact = await store.readArtifact(
    preparedAuthorityContext.controllerPublicKeyArtifact.path,
  );
  if (
    authorityControllerKeyArtifact.sha256 !==
    preparedAuthorityContext.controllerPublicKeyArtifact.sha256
  ) {
    fail("FINALIZER_CONTROLLER_KEY", "retained authority controller key changed");
  }
  const authorityClaimArtifact = await store.readArtifact(
    runAuthorizationClaimPath(segment.environmentId),
  );
  const controllerVerifiedAuthority = verifyFinalizerRunAuthorization({
    runAuthorization: retainedRunAuthorization,
    runAuthorizationClaim: parseCanonicalJson(
      authorityClaimArtifact.bytes,
      "run authorization claim",
    ),
    controllerPublicKeyBytes: authorityControllerKeyArtifact.bytes,
    candidateSha256: validatedCandidate.candidateSha256,
    campaignRunId: segment.provenance.campaignRunId,
    currentAttestation: validatedAttestation,
    evidenceRootObjectIdentitySha256:
      preparedAuthorityContext.pathProfileObservation.evidenceRootObjectIdentitySha256,
  });
  const validatedRunAuthorization = controllerVerifiedAuthority.authorization;

  const preparedArtifact = await store.readArtifact(paths.preparedContext);
  artifactByPath(segment, paths.preparedContext, "prepared context");
  const prepared = validatePreparedProbeContext(
    parseCanonicalJson(preparedArtifact.bytes, "prepared context"),
  );
  if (
    prepared.candidateSha256 !== segment.candidateSha256 ||
    prepared.labAttestationSha256 !== segment.labAttestationSha256 ||
    prepared.runPlanSha256 !== validatedRunAuthorization.runPlanSha256 ||
    prepared.runAuthorizationSha256 !== validatedRunAuthorization.authorizationSha256 ||
    prepared.runAuthorizationClaimReceiptSha256 !==
      controllerVerifiedAuthority.claim.receiptSha256 ||
    prepared.environmentId !== segment.environmentId ||
    prepared.pathProfileId !== segment.pathProfileId ||
    prepared.campaignRunId !== segment.provenance.campaignRunId ||
    prepared.executionRunId !== segment.provenance.executionRunId ||
    prepared.executionBundleId !== segment.provenance.executionBundleId ||
    prepared.executionBundleManifestSha256 !== segment.provenance.executionBundleManifestSha256 ||
    prepared.attemptId !== segment.provenance.attemptId ||
    prepared.vmSnapshotId !== segment.provenance.vmSnapshotId ||
    prepared.bootIdSha256 !== segment.provenance.bootIdSha256
  ) {
    fail("FINALIZER_PREPARED_CONTEXT", "segment differs from its retained prepared context");
  }
  const finalizationIntentArtifact = await store.readArtifact(paths.finalizationIntent);
  artifactByPath(segment, paths.finalizationIntent, "finalization intent");
  const finalizationIntent = validateProbeFinalizationIntent(
    parseCanonicalJson(finalizationIntentArtifact.bytes, "finalization intent"),
  );
  if (
    finalizationIntent.campaignId !== segment.campaignId ||
    finalizationIntent.manifestSha256 !== segment.manifestSha256 ||
    finalizationIntent.candidateSha256 !== segment.candidateSha256 ||
    finalizationIntent.runAuthorizationSha256 !== validatedRunAuthorization.authorizationSha256 ||
    finalizationIntent.runAuthorizationClaimReceiptSha256 !==
      controllerVerifiedAuthority.claim.receiptSha256 ||
    finalizationIntent.campaignRunId !== segment.provenance.campaignRunId ||
    finalizationIntent.executionRunId !== segment.provenance.executionRunId ||
    finalizationIntent.executionBundleId !== segment.provenance.executionBundleId ||
    finalizationIntent.executionBundleManifestSha256 !==
      segment.provenance.executionBundleManifestSha256 ||
    finalizationIntent.attemptId !== segment.provenance.attemptId ||
    finalizationIntent.environmentId !== segment.environmentId ||
    finalizationIntent.pathProfileId !== segment.pathProfileId ||
    finalizationIntent.rowId !== segment.rowId ||
    finalizationIntent.variantId !== segment.variantId ||
    finalizationIntent.evidenceRootObjectIdentitySha256 !==
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256 ||
    finalizationIntent.startedAt !== segment.provenance.startedAt ||
    !canonicalEqual(
      finalizationIntent.continuationChainIds,
      segment.continuations.map((value) => value.chainId),
    ) ||
    !canonicalEqual(finalizationIntent.upstreamSelectionDigests, segment.upstreamSelectionDigests)
  ) {
    fail("FINALIZER_INTENT_BINDING", "segment differs from its finalization intent");
  }

  const candidateArtifact = await store.readArtifact("campaign/candidate.json");
  artifactByPath(segment, "campaign/candidate.json", "candidate identity");
  requireCanonicalArtifactValue(candidateArtifact, validatedCandidate, "candidate identity");
  const attestationPath = `campaign/attestations/${safeCoordinatePart(segment.environmentId, "environmentId")}.json`;
  const attestationArtifact = await store.readArtifact(attestationPath);
  artifactByPath(segment, attestationPath, "lab attestation");
  requireCanonicalArtifactValue(attestationArtifact, validatedAttestation, "lab attestation");

  const verifierArtifact = await store.readArtifact(retainedVerifierPath);
  artifactByPath(segment, retainedVerifierPath, "verifier source");
  const contractArtifact = await store.readArtifact(retainedContractPath);
  artifactByPath(segment, retainedContractPath, "verifier contract source");
  const transcriptArtifact = await store.readArtifact(retainedTranscriptPath);
  artifactByPath(segment, retainedTranscriptPath, "transcript reducer source");
  const nativeClientArtifact = await store.readArtifact(retainedNativeClientPath);
  artifactByPath(segment, retainedNativeClientPath, "native transcript validator source");
  const nativeManifestDigestArtifact = await store.readArtifact(retainedNativeManifestDigestPath);
  artifactByPath(segment, retainedNativeManifestDigestPath, "native manifest digest helper source");
  const retainedVerifier = await retainedProbeVerifier({
    registryArtifact: verifierArtifact,
    contractArtifact,
    transcriptArtifact,
    nativeClientArtifact,
    nativeManifestDigestArtifact,
    candidate: validatedCandidate,
  });
  if (segment.verifierSourceSha256 !== verifierArtifact.sha256) {
    fail("FINALIZER_VERIFIER_SOURCE", "retained verifier source differs from the candidate");
  }
  const definition = await retainedVerifier.getDefinition(segment.rowId, segment.variantId);
  const mechanismPath = `campaign/mechanisms/${safeCoordinatePart(segment.rowId, "rowId")}.json`;
  const mechanismArtifact = await store.readArtifact(mechanismPath);
  artifactByPath(segment, mechanismPath, "mechanism definition");
  requireCanonicalArtifactValue(
    mechanismArtifact,
    definition.mechanismDefinition,
    "mechanism definition",
  );
  if (
    segment.mechanismDefinitionSha256 !== mechanismArtifact.sha256 ||
    segment.mechanismId !== definition.mechanismId
  ) {
    fail("FINALIZER_MECHANISM", "segment mechanism was not minted by the allowlisted verifier");
  }

  const controllerKeyReference = prepared.controllerPublicKeyArtifact;
  artifactByPath(segment, controllerKeyReference.path, "controller public key");
  const controllerKeyArtifact = await store.readArtifact(controllerKeyReference.path);
  if (controllerKeyArtifact.sha256 !== controllerKeyReference.sha256) {
    fail("FINALIZER_CONTROLLER_KEY", "retained controller public key changed");
  }
  const runAuthorizationClaimArtifact = await store.readArtifact(
    runAuthorizationClaimPath(segment.environmentId),
  );
  artifactByPath(
    segment,
    runAuthorizationClaimPath(segment.environmentId),
    "run authorization claim",
  );
  const verifiedRunAuthority = verifyFinalizerRunAuthorization({
    runAuthorization: validatedRunAuthorization,
    runAuthorizationClaim: parseCanonicalJson(
      runAuthorizationClaimArtifact.bytes,
      "run authorization claim",
    ),
    controllerPublicKeyBytes: controllerKeyArtifact.bytes,
    candidateSha256: validatedCandidate.candidateSha256,
    campaignRunId: segment.provenance.campaignRunId,
    currentAttestation: validatedAttestation,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  });
  assertPreparedAuthorizationAuthority(
    prepared,
    verifiedRunAuthority.authorization,
    verifiedRunAuthority.claim,
  );
  const nativeSealArtifact = await store.readArtifact(paths.nativeSeal);
  artifactByPath(segment, paths.nativeSeal, "native evidence seal");
  const nativeSeal = validateNativeEvidenceSeal(
    parseCanonicalJson(nativeSealArtifact.bytes, "native evidence seal"),
  );
  requireExactSegmentArtifactSet(segment, paths, nativeSeal);
  await artifactHashesMatchingNativeSeal(
    store,
    nativeSeal.entries.map((entry) => entry.path),
    nativeSeal,
  );
  const controllerReceiptArtifact = await store.readArtifact(paths.controllerSealReceipt);
  artifactByPath(segment, paths.controllerSealReceipt, "controller evidence-seal receipt");
  const retainedControllerReceipt = parseCanonicalJson(
    controllerReceiptArtifact.bytes,
    "controller evidence-seal receipt",
  );
  const captureLeaseArtifact = await store.readArtifact(paths.quiescenceCaptureLeaseReceipt);
  artifactByPath(segment, paths.quiescenceCaptureLeaseReceipt, "quiescence capture lease receipt");
  const acquisitionLeaseArtifact = await store.readArtifact(paths.quiescenceAcquisitionReceipt);
  artifactByPath(segment, paths.quiescenceAcquisitionReceipt, "quiescence acquisition receipt");
  const acquisitionLease = verifyLeaseReceipt(
    parseCanonicalJson(acquisitionLeaseArtifact.bytes, "quiescence acquisition receipt"),
    finalizationIntent,
    controllerKeyArtifact.bytes,
    prepared,
  );
  if (acquisitionLease.renewalSequence !== 0) {
    fail("FINALIZER_LEASE_RECOVERY", "quiescence acquisition is not sequence zero");
  }
  const retainedLease = verifyLeaseTransition(
    parseCanonicalJson(captureLeaseArtifact.bytes, "quiescence capture lease receipt"),
    acquisitionLease,
    finalizationIntent,
    controllerKeyArtifact.bytes,
    prepared,
  );
  if (retainedLease.renewalSequence !== 1) {
    fail("FINALIZER_LEASE_RECOVERY", "capture lease is not renewal sequence one");
  }
  const controllerReceipt = verifyControllerEvidenceSealReceipt(retainedControllerReceipt, {
    preparedContext: prepared,
    nativeSeal,
    controllerPublicKeyBytes: controllerKeyArtifact.bytes,
    rowId: segment.rowId,
    variantId: segment.variantId,
    runAuthorization: validatedRunAuthorization,
    finalizationIntent,
    quiescenceLease: retainedLease,
  });
  if (
    Date.parse(controllerReceipt.capturedAt) < Date.parse(segment.provenance.startedAt) ||
    Date.parse(controllerReceipt.capturedAt) > Date.parse(segment.provenance.endedAt)
  ) {
    fail("FINALIZER_CONTROLLER_TIME", "controller evidence seal is outside the segment run");
  }

  const continuationEvidence = await loadFinalizerContinuations({
    store,
    prepared,
    attestation: validatedAttestation,
    rowId: segment.rowId,
    variantId: segment.variantId,
    chainIds: segment.continuations.map((value) => value.chainId),
    controllerPublicKeyBytes: controllerKeyArtifact.bytes,
  });
  if (
    !canonicalEqual(continuationEvidence.continuations, segment.continuations) ||
    !canonicalEqual(
      continuationEvidence.externalCheckpoints,
      segment.provenance.externalCheckpoints,
    )
  ) {
    fail("FINALIZER_CONTINUATION_DRIFT", "segment continuation evidence changed");
  }

  const rawArtifact = await store.readArtifact(paths.rawFacts);
  artifactByPath(segment, paths.rawFacts, "raw facts");
  const rawFacts = await replayProbeSourceTranscript({
    store,
    paths,
    prepared,
    rowId: segment.rowId,
    variantId: segment.variantId,
    verifierDefinition: definition,
    verifierSourceSha256: verifierArtifact.sha256,
    retainedVerifier,
    controllerPublicKeyBytes: controllerKeyArtifact.bytes,
    segment,
  });
  requireCanonicalArtifactValue(rawArtifact, rawFacts, "raw facts");
  const verification = await retainedVerifier.verify({
    rowId: segment.rowId,
    variantId: segment.variantId,
    rawFacts,
    artifactHashes: segment.artifactHashes,
    verifierSourceSha256: verifierArtifact.sha256,
  });
  if (!verificationMatchesSegment(verification, segment)) {
    fail("FINALIZER_VERIFICATION_DRIFT", "retained segment differs from verifier output");
  }
  if (
    verification.verifierDefinitionSha256 !== definition.definitionSha256 ||
    !canonicalEqual(verification.mechanismDefinition, definition.mechanismDefinition)
  ) {
    fail("FINALIZER_VERIFIER_DRIFT", "retained verifier definition changed");
  }
  return Object.freeze(segment);
}

export async function finalizeProbeCampaign({ manifest, candidate, attestations, segmentSources }) {
  const validatedCandidate = validateProbeCandidateIdentity(candidate);
  if (
    hashProbeCanonicalJson(manifest) !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    !canonicalEqual(manifest, PROBE_CAMPAIGN_MANIFEST)
  ) {
    fail("FINALIZER_CAMPAIGN_MANIFEST", "campaign manifest is not the frozen PR-01b manifest");
  }
  if (!Array.isArray(attestations) || !Array.isArray(segmentSources)) {
    fail("FINALIZER_CAMPAIGN", "attestations and segmentSources must be arrays");
  }
  const attestationByEnvironment = new Map();
  for (const rawAttestation of attestations) {
    const validated = validateLabAttestation(rawAttestation);
    if (attestationByEnvironment.has(validated.environmentId)) {
      fail("FINALIZER_CAMPAIGN", "campaign contains a duplicate environment attestation");
    }
    attestationByEnvironment.set(validated.environmentId, validated);
  }
  const segments = [];
  let campaignAuthorization = null;
  let campaignAuthority = null;
  for (const source of segmentSources) {
    assertExactKeys(source, ["store", "commitPath"], "committed segment source");
    const commitArtifact = await source.store.readArtifact(source.commitPath);
    const commit = validateProbeSegmentCommitMarker(
      parseCanonicalJson(commitArtifact.bytes, "campaign segment commit preview"),
    );
    const previewArtifact = await source.store.readArtifact(commit.segmentPath);
    const preview = validateProbeSegmentRecord(
      parseCanonicalJson(previewArtifact.bytes, "campaign segment preview"),
    );
    const attestation = attestationByEnvironment.get(preview.environmentId);
    if (attestation === undefined) {
      fail("FINALIZER_CAMPAIGN", `missing attestation for ${preview.environmentId}`);
    }
    const committed = await verifyCommittedProbeSegment({
      store: source.store,
      commitPath: source.commitPath,
      candidate: validatedCandidate,
      attestation,
    });
    if (campaignAuthorization === null) {
      campaignAuthorization = committed.runAuthorization;
      campaignAuthority = {
        authorizationSha256: committed.runAuthorization.authorizationSha256,
        runPlanSha256: committed.runAuthorization.runPlanSha256,
        campaignRunId: committed.runAuthorization.campaignRunId,
        operatorKeyId: committed.runAuthorizationClaim.operatorKeyId,
        operatorPublicKeySha256: committed.runAuthorizationClaim.operatorPublicKeySha256,
        trustStoreId: committed.runAuthorizationClaim.trustStoreId,
        trustStoreGeneration: committed.runAuthorizationClaim.trustStoreGeneration,
        trustStoreSha256: committed.runAuthorizationClaim.trustStoreSha256,
      };
    } else {
      const authority = committed.runAuthorizationClaim;
      if (
        !canonicalEqual(committed.runAuthorization, campaignAuthorization) ||
        authority.authorizationSha256 !== campaignAuthority.authorizationSha256 ||
        authority.runPlanSha256 !== campaignAuthority.runPlanSha256 ||
        authority.campaignRunId !== campaignAuthority.campaignRunId ||
        authority.operatorKeyId !== campaignAuthority.operatorKeyId ||
        authority.operatorPublicKeySha256 !== campaignAuthority.operatorPublicKeySha256 ||
        authority.trustStoreId !== campaignAuthority.trustStoreId ||
        authority.trustStoreGeneration !== campaignAuthority.trustStoreGeneration ||
        authority.trustStoreSha256 !== campaignAuthority.trustStoreSha256
      ) {
        fail(
          "FINALIZER_CAMPAIGN_AUTHORITY",
          "committed segments do not share one operator authorization authority",
        );
      }
    }
    segments.push(committed.segment);
  }
  const analysis = analyzeProbeCampaignRecords({
    manifest,
    candidate: validatedCandidate,
    attestations: [...attestationByEnvironment.values()],
    segments,
  });
  const verifiedSegmentDigests = segments.map((segment) => segment.segmentSha256).sort(compareUtf8);
  const draft = {
    schemaVersion: 1,
    kind: "windows-host-probe-campaign-result",
    authority: "verified-artifact-finalizer",
    campaignId: analysis.campaignId,
    manifestSha256: analysis.manifestSha256,
    candidateSha256: analysis.candidateSha256,
    phase: analysis.phase,
    status: analysis.status,
    selectionEligible: analysis.status === "PASS",
    rowClosureClaimed: false,
    issues: analysis.issues,
    rowResults: analysis.rowResults,
    analysisSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-campaign-analysis.v1",
      analysis,
    }),
    verifiedSegmentDigests,
  };
  return Object.freeze({
    ...draft,
    campaignResultSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-campaign-result.v1",
      result: draft,
    }),
  });
}

async function completeAndCommitProbeSegment({
  store,
  paths,
  candidate,
  attestation,
  prepared,
  finalizationIntent,
  acquisitionReceipt,
  finalLeaseReceipt,
  controllerPublicKeyBytes,
  adapters,
  recoveredCompletionReceipt,
  onControllerCompleted,
}) {
  const segment = await verifyFinalizedProbeSegment({
    store,
    segmentPath: paths.segment,
    candidate,
    attestation,
  });
  const segmentArtifact = await store.readArtifact(paths.segment);
  const segmentProof = segmentProofFromArtifact(segment, segmentArtifact);
  const captureReceiptArtifact = await store.readArtifact(paths.controllerSealReceipt);
  const captureReceipt = parseCanonicalJson(
    captureReceiptArtifact.bytes,
    "controller evidence-seal receipt",
  );
  const rawCompletionReceipt =
    recoveredCompletionReceipt ??
    (await adapters.completeEvidenceQuiescence({
      finalizationIntent,
      leaseReceipt: finalLeaseReceipt,
      evidenceCaptureReceiptSha256: captureReceipt.receiptSha256,
      segmentProof,
    }));
  onControllerCompleted();
  const completionReceipt = verifyProbeQuiescenceCompletionReceipt(rawCompletionReceipt, {
    finalizationIntent,
    leaseReceipt: finalLeaseReceipt,
    evidenceCaptureReceiptSha256: captureReceipt.receiptSha256,
    segmentProof,
    controllerPublicKeyBytes,
    expectedController: expectedControllerIdentity(prepared),
  });
  await ensureCanonicalJson(store, paths.quiescenceCompletionLeaseReceipt, finalLeaseReceipt);
  await ensureCanonicalJson(store, paths.quiescenceCompletionReceipt, completionReceipt);
  const commitDraft = {
    schemaVersion: 1,
    kind: "windows-host-probe-segment-commit",
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    runAuthorizationSha256: finalizationIntent.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: finalizationIntent.runAuthorizationClaimReceiptSha256,
    leaseId: finalLeaseReceipt.leaseId,
    leaseEpoch: finalLeaseReceipt.leaseEpoch,
    acquisitionReceiptSha256: acquisitionReceipt.receiptSha256,
    finalLeaseReceiptSha256: finalLeaseReceipt.receiptSha256,
    evidenceCaptureReceiptSha256: completionReceipt.evidenceCaptureReceiptSha256,
    completionReceiptSha256: completionReceipt.receiptSha256,
    ...segmentProof,
  };
  const commit = validateProbeSegmentCommitMarker({
    ...commitDraft,
    commitSha256: deriveProbeSegmentCommitDigest(commitDraft),
  });
  await ensureCanonicalJson(store, paths.segmentCommit, commit);
  const committed = await verifyCommittedProbeSegment({
    store,
    commitPath: paths.segmentCommit,
    candidate,
    attestation,
  });
  return Object.freeze({
    segment: committed.segment,
    path: committed.path,
    commit: committed.commit,
    commitPath: committed.commitPath,
  });
}

export async function finalizeProbeSegment({
  store,
  preparedContext,
  candidate,
  attestation,
  runAuthorization,
  runAuthorizationClaim,
  rowId,
  variantId,
  continuationChainIds,
  upstreamSelectionDigests,
  provenance,
  adapters,
}) {
  if (
    !exactObject(store) ||
    typeof store.readArtifact !== "function" ||
    typeof store.scan !== "function"
  ) {
    fail("FINALIZER_STORE", "an evidence store is required");
  }
  const prepared = validatePreparedProbeContext(preparedContext);
  const validatedCandidate = validateProbeCandidateIdentity(candidate);
  const validatedAttestation = validateLabAttestation(attestation);
  const validatedRunAuthorization = validateProbeRunAuthorization(runAuthorization);
  const validatedRunAuthorizationClaim =
    validateProbeRunAuthorizationClaimReceipt(runAuthorizationClaim);
  if (
    validatedRunAuthorization.candidateSha256 !== validatedCandidate.candidateSha256 ||
    validatedRunAuthorization.campaignRunId !== prepared.campaignRunId ||
    !validatedRunAuthorization.attestations.some(
      (value) =>
        value.environmentId === validatedAttestation.environmentId &&
        value.attestationSha256 === validatedAttestation.attestationSha256,
    )
  ) {
    fail("FINALIZER_RUN_AUTH", "run authorization is bound to another campaign context");
  }
  const row = rowDefinition(rowId);
  variantDefinition(row, variantId);
  if (
    prepared.candidateSha256 !== validatedCandidate.candidateSha256 ||
    prepared.labAttestationSha256 !== validatedAttestation.attestationSha256 ||
    prepared.runPlanSha256 !== validatedRunAuthorization.runPlanSha256 ||
    prepared.runAuthorizationSha256 !== validatedRunAuthorization.authorizationSha256 ||
    prepared.runAuthorizationClaimReceiptSha256 !== validatedRunAuthorizationClaim.receiptSha256 ||
    prepared.environmentId !== validatedAttestation.environmentId ||
    prepared.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    fail("FINALIZER_CONTEXT_BINDING", "prepared context, candidate, and attestation differ");
  }
  assertExactKeys(
    adapters,
    [
      "readRepositoryState",
      "readVerifierSource",
      "readContractSource",
      "readTranscriptSource",
      "readNativeClientSource",
      "readNativeManifestDigestSource",
      "recoverOrAcquireEvidenceQuiescence",
      "renewEvidenceQuiescence",
      "captureQuiescedEvidenceSeal",
      "completeEvidenceQuiescence",
      "abandonEvidenceQuiescence",
      "now",
      "monotonicNow",
    ],
    "finalizer adapters",
  );
  for (const [name, adapter] of Object.entries(adapters)) {
    if (typeof adapter !== "function") fail("FINALIZER_ADAPTER", `${name} must be a function`);
  }
  const finalizationStart = validateFinalizationStart(provenance);
  const paths = probeSegmentArtifactPaths({
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
  });
  const runAuthorizationArtifact = await ensureCanonicalJson(
    store,
    retainedRunAuthorizationPath,
    validatedRunAuthorization,
  );
  const runAuthorizationClaimArtifact = await ensureCanonicalJson(
    store,
    runAuthorizationClaimPath(prepared.environmentId),
    validatedRunAuthorizationClaim,
  );
  const finalizationIntent = createFinalizationIntent({
    prepared,
    runAuthorization: validatedRunAuthorization,
    runAuthorizationClaim: validatedRunAuthorizationClaim,
    rowId,
    variantId,
    continuationChainIds,
    upstreamSelectionDigests,
    startedAt: finalizationStart.startedAt,
  });
  let finalizationIntentArtifact;
  try {
    finalizationIntentArtifact = await ensureCanonicalJson(
      store,
      paths.finalizationIntent,
      finalizationIntent,
    );
  } catch (error) {
    if (error?.code === "FINALIZER_ARTIFACT_COLLISION") {
      fail("FINALIZER_SEGMENT_COLLISION", "segment coordinate has another finalization operation");
    }
    throw error;
  }
  const recovered = await recoverFinalizedProbeSegment({
    store,
    paths,
    prepared,
    candidate: validatedCandidate,
    attestation: validatedAttestation,
    continuationChainIds,
    upstreamSelectionDigests,
    startedAt: finalizationStart.startedAt,
    runAuthorization: validatedRunAuthorization,
    finalizationIntent,
  });
  if (recovered !== null) {
    return recovered;
  }
  const candidateArtifact = await ensureCanonicalJson(
    store,
    "campaign/candidate.json",
    validatedCandidate,
  );
  const attestationArtifact = await ensureCanonicalJson(
    store,
    `campaign/attestations/${safeCoordinatePart(prepared.environmentId, "environmentId")}.json`,
    validatedAttestation,
  );
  const preparedArtifact = await ensureCanonicalJson(store, paths.preparedContext, prepared);

  const controllerKeyReference = prepared.controllerPublicKeyArtifact;
  const controllerKeyArtifact = await store.readArtifact(controllerKeyReference.path);
  if (controllerKeyArtifact.sha256 !== controllerKeyReference.sha256) {
    fail("FINALIZER_CONTROLLER_KEY", "retained controller public-key artifact changed");
  }
  const controllerPublicKeyBytes = controllerKeyArtifact.bytes;
  const verifiedRunAuthority = verifyFinalizerRunAuthorization({
    runAuthorization: validatedRunAuthorization,
    runAuthorizationClaim: validatedRunAuthorizationClaim,
    controllerPublicKeyBytes,
    candidateSha256: validatedCandidate.candidateSha256,
    campaignRunId: prepared.campaignRunId,
    currentAttestation: validatedAttestation,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  });
  assertPreparedAuthorizationAuthority(
    prepared,
    verifiedRunAuthority.authorization,
    verifiedRunAuthority.claim,
  );
  const leaseState = await adapters.recoverOrAcquireEvidenceQuiescence({
    finalizationIntent,
  });
  assertExactKeys(
    leaseState,
    ["acquisitionReceipt", "leaseReceipt", "completionReceipt"],
    "controller quiescence recovery",
  );
  const acquisitionReceipt = verifyLeaseReceipt(
    leaseState.acquisitionReceipt,
    finalizationIntent,
    controllerPublicKeyBytes,
    prepared,
  );
  if (acquisitionReceipt.renewalSequence !== 0) {
    fail("FINALIZER_LEASE_RECOVERY", "controller acquisition is not renewal sequence zero");
  }
  let currentLeaseReceipt = verifyLeaseReceipt(
    leaseState.leaseReceipt,
    finalizationIntent,
    controllerPublicKeyBytes,
    prepared,
  );
  assertSameLeaseEpoch(acquisitionReceipt, currentLeaseReceipt);
  await ensureCanonicalJson(store, paths.quiescenceAcquisitionReceipt, acquisitionReceipt);

  let controllerCompleted = leaseState.completionReceipt !== null;
  try {
    const retainedSegment = await readOptionalCanonicalArtifact(
      store,
      paths.segment,
      "recoverable finalized segment",
    );
    if (controllerCompleted || retainedSegment !== null) {
      if (retainedSegment === null) {
        fail(
          "FINALIZER_COMPLETION_RECOVERY",
          "controller completed finalization without a retained segment",
        );
      }
      const captureLeaseReceipt = await retainStageLease({
        store,
        path: paths.quiescenceCaptureLeaseReceipt,
        label: "quiescence capture lease receipt",
        expectedSequence: 1,
        previousReceipt: acquisitionReceipt,
        currentReceipt: currentLeaseReceipt,
        finalizationIntent,
        controllerPublicKeyBytes,
        prepared,
        renew: async () => {
          fail("FINALIZER_LEASE_RECOVERY", "capture lease cannot be minted after a segment");
        },
      });
      const finalLeaseReceipt = await retainStageLease({
        store,
        path: paths.quiescenceCompletionLeaseReceipt,
        label: "quiescence completion lease receipt",
        expectedSequence: 2,
        previousReceipt: captureLeaseReceipt,
        currentReceipt: currentLeaseReceipt,
        finalizationIntent,
        controllerPublicKeyBytes,
        prepared,
        renew: async () => {
          fail("FINALIZER_LEASE_RECOVERY", "completion lease cannot be minted after a segment");
        },
      });
      if (currentLeaseReceipt.receiptSha256 !== finalLeaseReceipt.receiptSha256) {
        fail("FINALIZER_LEASE_RECOVERY", "controller journal is not at the final segment lease");
      }
      return await completeAndCommitProbeSegment({
        store,
        paths,
        candidate: validatedCandidate,
        attestation: validatedAttestation,
        prepared,
        finalizationIntent,
        acquisitionReceipt,
        finalLeaseReceipt,
        controllerPublicKeyBytes,
        adapters,
        recoveredCompletionReceipt: leaseState.completionReceipt,
        onControllerCompleted: () => {
          controllerCompleted = true;
        },
      });
    }

    const captureLeaseReceipt = await retainStageLease({
      store,
      path: paths.quiescenceCaptureLeaseReceipt,
      label: "quiescence capture lease receipt",
      expectedSequence: 1,
      previousReceipt: acquisitionReceipt,
      currentReceipt: currentLeaseReceipt,
      finalizationIntent,
      controllerPublicKeyBytes,
      prepared,
      renew: async () =>
        adapters.renewEvidenceQuiescence({
          finalizationIntent,
          previousLeaseReceipt: currentLeaseReceipt,
          purpose: "capture",
        }),
    });
    if (currentLeaseReceipt.renewalSequence < captureLeaseReceipt.renewalSequence) {
      currentLeaseReceipt = captureLeaseReceipt;
    }

    await store.scan();

    const sourceAtStart = validateRepositoryState(
      await adapters.readRepositoryState(),
      validatedCandidate,
      prepared,
      "sourceAtStart",
    );
    const verifierBytes = Buffer.from(await adapters.readVerifierSource());
    const contractBytes = Buffer.from(await adapters.readContractSource());
    const transcriptBytes = Buffer.from(await adapters.readTranscriptSource());
    const nativeClientBytes = Buffer.from(await adapters.readNativeClientSource());
    const nativeManifestDigestBytes = Buffer.from(await adapters.readNativeManifestDigestSource());
    const verifierSourceSha256 = sha256(verifierBytes);
    const contractSourceSha256 = sha256(contractBytes);
    const transcriptSourceSha256 = sha256(transcriptBytes);
    const nativeClientSourceSha256 = sha256(nativeClientBytes);
    const nativeManifestDigestSourceSha256 = sha256(nativeManifestDigestBytes);
    const candidateVerifierSource = candidateSource(
      validatedCandidate,
      probeVerifierSourcePath,
      "probe verifier source",
    );
    const candidateContractSource = candidateSource(
      validatedCandidate,
      probeContractSourcePath,
      "probe contract source",
    );
    const candidateTranscriptSource = candidateSource(
      validatedCandidate,
      probeTranscriptSourcePath,
      "probe transcript reducer source",
    );
    const candidateNativeClientSource = candidateSource(
      validatedCandidate,
      nativeClientSourcePath,
      "native transcript validator source",
    );
    const candidateNativeManifestDigestSource = candidateSource(
      validatedCandidate,
      nativeManifestDigestSourcePath,
      "native manifest digest helper source",
    );
    if (
      candidateVerifierSource.sha256 !== verifierSourceSha256 ||
      candidateContractSource.sha256 !== contractSourceSha256 ||
      candidateTranscriptSource.sha256 !== transcriptSourceSha256 ||
      candidateNativeClientSource.sha256 !== nativeClientSourceSha256 ||
      candidateNativeManifestDigestSource.sha256 !== nativeManifestDigestSourceSha256
    ) {
      fail("FINALIZER_VERIFIER_SOURCE", "live verifier closure differs from the candidate");
    }
    const verifierArtifact = await ensureBytes(store, retainedVerifierPath, verifierBytes);
    const contractArtifact = await ensureBytes(store, retainedContractPath, contractBytes);
    const transcriptArtifact = await ensureBytes(store, retainedTranscriptPath, transcriptBytes);
    const nativeClientArtifact = await ensureBytes(
      store,
      retainedNativeClientPath,
      nativeClientBytes,
    );
    const nativeManifestDigestArtifact = await ensureBytes(
      store,
      retainedNativeManifestDigestPath,
      nativeManifestDigestBytes,
    );
    const retainedVerifier = await retainedProbeVerifier({
      registryArtifact: { ...verifierArtifact, bytes: verifierBytes },
      contractArtifact: { ...contractArtifact, bytes: contractBytes },
      transcriptArtifact: { ...transcriptArtifact, bytes: transcriptBytes },
      nativeClientArtifact: { ...nativeClientArtifact, bytes: nativeClientBytes },
      nativeManifestDigestArtifact: {
        ...nativeManifestDigestArtifact,
        bytes: nativeManifestDigestBytes,
      },
      candidate: validatedCandidate,
    });
    const verifierDefinition = await retainedVerifier.getDefinition(rowId, variantId);
    const mechanismArtifact = await ensureCanonicalJson(
      store,
      `campaign/mechanisms/${safeCoordinatePart(rowId, "rowId")}.json`,
      verifierDefinition.mechanismDefinition,
    );
    const provisionalRawFacts = await replayProbeSourceTranscript({
      store,
      paths,
      prepared,
      rowId,
      variantId,
      verifierDefinition,
      verifierSourceSha256,
      retainedVerifier,
      controllerPublicKeyBytes,
    });
    await ensureCanonicalJson(store, paths.rawFacts, provisionalRawFacts);
    const { continuations, externalCheckpoints, checkpointArtifactPaths } =
      await loadFinalizerContinuations({
        store,
        prepared,
        attestation: validatedAttestation,
        rowId,
        variantId,
        chainIds: continuationChainIds,
        controllerPublicKeyBytes,
      });
    const evidencePaths = await collectFiles(store, paths.evidence);
    const continuationPaths = [];
    for (const chainId of continuationChainIds) {
      continuationPaths.push(
        ...(await collectFiles(
          store,
          `continuations/chains/${safeCoordinatePart(chainId, "chainId")}`,
        )),
      );
    }
    const retainedAttestationEvidence = prepared.executionBundleManifest.evidenceArtifacts.map(
      (artifact) => artifact.path,
    );
    const sealedArtifactPaths = [
      ...new Set([
        paths.rawFacts,
        ...evidencePaths,
        ...continuationPaths,
        ...checkpointArtifactPaths,
        verifierArtifact.path,
        contractArtifact.path,
        transcriptArtifact.path,
        nativeClientArtifact.path,
        nativeManifestDigestArtifact.path,
        mechanismArtifact.path,
        candidateArtifact.path,
        attestationArtifact.path,
        preparedArtifact.path,
        finalizationIntentArtifact.path,
        paths.quiescenceAcquisitionReceipt,
        paths.quiescenceCaptureLeaseReceipt,
        runAuthorizationArtifact.path,
        runAuthorizationClaimArtifact.path,
        controllerKeyReference.path,
        ...retainedAttestationEvidence,
      ]),
    ].sort(compareUtf8);

    const captured = await adapters.captureQuiescedEvidenceSeal({
      finalizationIntent,
      quiescenceLease: captureLeaseReceipt,
      campaignId: prepared.campaignId,
      manifestSha256: prepared.manifestSha256,
      candidateSha256: prepared.candidateSha256,
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      executionBundleId: prepared.executionBundleId,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      attemptId: prepared.attemptId,
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      rowId,
      variantId,
      exactArtifactPaths: sealedArtifactPaths,
    });
    assertExactKeys(captured, ["nativeSeal", "controllerReceipt"], "captured evidence seal");
    const nativeSeal = validateNativeEvidenceSeal(captured.nativeSeal);
    const controllerReceipt = verifyControllerEvidenceSealReceipt(captured.controllerReceipt, {
      preparedContext: prepared,
      nativeSeal,
      controllerPublicKeyBytes,
      rowId,
      variantId,
      runAuthorization: validatedRunAuthorization,
      finalizationIntent,
      quiescenceLease: captureLeaseReceipt,
    });
    if (Date.parse(controllerReceipt.capturedAt) < Date.parse(finalizationStart.startedAt)) {
      fail("FINALIZER_CONTROLLER_TIME", "controller evidence seal predates this segment run");
    }
    const sealedArtifactHashes = await artifactHashesMatchingNativeSeal(
      store,
      sealedArtifactPaths,
      nativeSeal,
    );
    const rawFacts = await replayProbeSourceTranscript({
      store,
      paths,
      prepared,
      rowId,
      variantId,
      verifierDefinition,
      verifierSourceSha256,
      retainedVerifier,
      controllerPublicKeyBytes,
    });
    const rawArtifact = await store.readArtifact(paths.rawFacts);
    requireCanonicalArtifactValue(rawArtifact, rawFacts, "sealed raw facts");
    await artifactHashesMatchingNativeSeal(store, sealedArtifactPaths, nativeSeal);
    const nativeSealArtifact = await ensureCanonicalJson(store, paths.nativeSeal, nativeSeal);
    const controllerSealArtifact = await ensureCanonicalJson(
      store,
      paths.controllerSealReceipt,
      controllerReceipt,
    );

    const finalLeaseReceipt = await retainStageLease({
      store,
      path: paths.quiescenceCompletionLeaseReceipt,
      label: "quiescence completion lease receipt",
      expectedSequence: 2,
      previousReceipt: captureLeaseReceipt,
      currentReceipt: currentLeaseReceipt,
      finalizationIntent,
      controllerPublicKeyBytes,
      prepared,
      renew: async () =>
        adapters.renewEvidenceQuiescence({
          finalizationIntent,
          previousLeaseReceipt: captureLeaseReceipt,
          purpose: "completion",
        }),
    });
    currentLeaseReceipt = finalLeaseReceipt;
    const sourceAtEnd = validateRepositoryState(
      await adapters.readRepositoryState(),
      validatedCandidate,
      prepared,
      "sourceAtEnd",
    );
    if (!canonicalEqual(sourceAtStart, sourceAtEnd)) {
      fail("FINALIZER_SOURCE_DRIFT", "repository source identity changed during finalization");
    }
    const timing = captureFinalizationEnd(finalizationStart, adapters);
    if (Date.parse(controllerReceipt.capturedAt) > Date.parse(timing.endedAt)) {
      fail("FINALIZER_CONTROLLER_TIME", "controller evidence seal postdates finalization");
    }
    const artifactHashes = [
      ...sealedArtifactHashes,
      { path: nativeSealArtifact.path, sha256: nativeSealArtifact.sha256 },
      { path: controllerSealArtifact.path, sha256: controllerSealArtifact.sha256 },
    ].sort((left, right) => compareUtf8(left.path, right.path));
    const verification = await retainedVerifier.verify({
      rowId,
      variantId,
      rawFacts,
      artifactHashes,
      verifierSourceSha256,
    });
    if (
      verification.verifierDefinitionSha256 !== verifierDefinition.definitionSha256 ||
      verification.mechanismId !== verifierDefinition.mechanismId ||
      !canonicalEqual(verification.mechanismDefinition, verifierDefinition.mechanismDefinition)
    ) {
      fail("FINALIZER_VERIFIER_DRIFT", "allowlisted verifier definition changed while used");
    }
    const upstream = sortedUniqueDigests(upstreamSelectionDigests, "upstreamSelectionDigests");
    const segmentDraft = {
      schemaVersion: 1,
      kind: "windows-host-probe-segment",
      campaignId: PROBE_CAMPAIGN_ID,
      manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
      candidateSha256: validatedCandidate.candidateSha256,
      labAttestationSha256: validatedAttestation.attestationSha256,
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      rowId,
      variantId,
      phase: "probe",
      outcome: verification.outcome,
      mechanismId: verification.mechanismId,
      mechanismDefinitionSha256: mechanismArtifact.sha256,
      upstreamSelectionDigests: upstream,
      verifierId: verification.verifierId,
      verifierSourceSha256,
      verificationMetrics: verification.verificationMetrics,
      verificationInputSha256: "",
      outcomeEvidenceSha256: "",
      observations: verification.observations,
      artifactHashes,
      unavailability: verification.unavailability,
      provenance: {
        campaignRunId: prepared.campaignRunId,
        executionRunId: prepared.executionRunId,
        executionBundleId: prepared.executionBundleId,
        executionBundleManifestSha256: prepared.executionBundleManifestSha256,
        attemptId: prepared.attemptId,
        startedAt: timing.startedAt,
        endedAt: timing.endedAt,
        monotonicDurationMs: timing.monotonicDurationMs,
        vmSnapshotId: prepared.vmSnapshotId,
        bootIdSha256: prepared.bootIdSha256,
        externalCheckpoints,
      },
      continuations,
      rowClosureClaimed: false,
    };
    segmentDraft.verificationInputSha256 = deriveProbeVerificationInputDigest(segmentDraft);
    segmentDraft.outcomeEvidenceSha256 = deriveProbeOutcomeEvidenceDigest(segmentDraft);
    const segment = validateProbeSegmentRecord({
      ...segmentDraft,
      segmentSha256: deriveProbeSegmentDigest(segmentDraft),
    });
    await ensureCanonicalJson(store, paths.segment, segment);
    return await completeAndCommitProbeSegment({
      store,
      paths,
      candidate: validatedCandidate,
      attestation: validatedAttestation,
      prepared,
      finalizationIntent,
      acquisitionReceipt,
      finalLeaseReceipt,
      controllerPublicKeyBytes,
      adapters,
      recoveredCompletionReceipt: null,
      onControllerCompleted: () => {
        controllerCompleted = true;
      },
    });
  } catch (error) {
    if (!controllerCompleted) {
      try {
        const abandonmentReceipt = verifyProbeQuiescenceAbandonmentReceipt(
          await adapters.abandonEvidenceQuiescence({
            finalizationIntent,
            leaseReceipt: currentLeaseReceipt,
            reasonCode: "finalization-failed",
          }),
          {
            finalizationIntent,
            leaseReceipt: currentLeaseReceipt,
            controllerPublicKeyBytes,
            expectedController: expectedControllerIdentity(prepared),
          },
        );
        await ensureCanonicalJson(store, paths.quiescenceAbandonmentReceipt, abandonmentReceipt);
      } catch (abandonmentError) {
        const failure = new ProbeFinalizerError(
          "FINALIZER_ABANDONMENT_UNPROVEN",
          "finalization failed and controller abandonment could not be proven",
        );
        failure.cause = abandonmentError;
        throw failure;
      }
    }
    throw error;
  }
}

export async function readDefaultProbeVerifierSource() {
  return readFile(new URL("./probe-registry.mjs", import.meta.url));
}

export async function readDefaultProbeContractSource() {
  return readFile(new URL("./probe-contract.mjs", import.meta.url));
}

export async function readDefaultProbeTranscriptSource() {
  return readFile(new URL("./probe-transcript.mjs", import.meta.url));
}

export async function readDefaultNativeClientSource() {
  return readFile(new URL("./native-client.mjs", import.meta.url));
}

export async function readDefaultNativeManifestDigestSource() {
  return readFile(new URL("./native-manifest-digest.mjs", import.meta.url));
}
