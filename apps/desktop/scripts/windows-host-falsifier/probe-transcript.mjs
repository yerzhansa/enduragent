import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "./probe-contract.mjs";

const MAX_SOURCE_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_ACTION_ATTESTATION_BYTES = 16 * 1024 * 1024;
const MAX_ACTION_ATTESTATIONS = 4096;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const protocolIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const factKeyPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const rowIdPattern = /^F-\d{2}$/u;

const bindingKeys = Object.freeze([
  "campaignId",
  "manifestSha256",
  "candidateSha256",
  "labAttestationSha256",
  "campaignRunId",
  "executionRunId",
  "executionBundleId",
  "executionBundleManifestSha256",
  "attemptId",
  "preflightSha256",
  "preparationScopeSha256",
  "environmentId",
  "pathProfileId",
  "vmSnapshotId",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "rootPathSha256",
  "evidenceRootObjectIdentitySha256",
  "volumeIdSha256",
  "rowId",
  "variantId",
  "verifierDefinitionSha256",
  "verifierSourceSha256",
]);

const nativeBindingKeys = Object.freeze([
  "campaignRunId",
  "candidateSha256",
  "preflightSha256",
  "executionBundleManifestSha256",
  "nativeHelperArtifactPath",
  "nativeHelperSha256",
  "evidenceRootObjectIdentitySha256",
  "nativeCandidateDigest",
  "nativeManifestSha256",
  "nativeSessionId",
  "runRootIdentity",
  "startupHandshake",
  "startupHandshakeSha256",
]);

const actionAttestationKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "executionBundleId",
  "executionBundleManifestSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "scenarioPlanSha256",
  "producerActionId",
  "operation",
  "runtimeActionIntentSha256",
  "execution",
  "expectedActor",
  "broker",
  "observerCommands",
  "attestationSha256",
]);
const actionAttestationDraftKeys = Object.freeze(
  actionAttestationKeys.filter((key) => key !== "attestationSha256"),
);
const actionAttestationCoordinateKeys = Object.freeze([
  "campaignRunId",
  "executionRunId",
  "attemptId",
  "workId",
  "environmentId",
  "pathProfileId",
  "rowId",
  "variantId",
  "repetition",
]);
const actionAttestationExecutionKeys = Object.freeze([
  "actor",
  "operation",
  "locus",
  "driverId",
  "disruptive",
  "nativeTranscriptRequired",
  "actorSelector",
]);
const actionAttestationBrokerKeys = Object.freeze([
  "brokerAcceptanceSha256",
  "brokerTaskSha256",
  "brokerTaskNonceSha256",
  "brokerResultSha256",
  "brokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "mailboxAclSha256",
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "replayJournalDisposition",
  "replayJournalEntrySha256",
]);
const actionAttestationObserverCommandKeys = Object.freeze([
  "transcriptSha256",
  "sequence",
  "commandId",
  "requestFrameSha256",
  "responseFrameSha256",
  "ok",
]);
const actorIdentitySources = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  controller: "controller.identitySha256",
  "power-control": "actors.powerControlActorSha256",
  "remote-peer": "actors.remotePeerActorSha256",
  "second-user": "actors.secondUserSidSha256",
});
const brokerActorRoles = Object.freeze(["primary-standard-user", "remote-peer", "second-user"]);
const executionLoci = Object.freeze([
  "guest-native-helper",
  "guest-standard-user-worker",
  "guest-second-user-broker",
  "controller-host",
  "controller-remote-peer",
  "controller-orchestrated-guest",
]);

export class ProbeTranscriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeTranscriptError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeTranscriptError(code, message);
}

function exactObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertExactKeys(value, keys, label, code = "TRANSCRIPT_SCHEMA") {
  if (!exactObject(value)) fail(code, `${label} must be a plain object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has unknown or missing fields`);
  }
}

function assertString(value, label, { min = 1, max = 32767 } = {}) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0") ||
    value.normalize("NFC") !== value
  ) {
    fail("TRANSCRIPT_STRING", `${label} must be a bounded NFC string`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("TRANSCRIPT_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("TRANSCRIPT_IDENTIFIER", `${label} must be lowercase kebab-case`);
  }
}

function assertProtocolIdentifier(value, label) {
  if (typeof value !== "string" || !protocolIdentifierPattern.test(value)) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label} must be a protocol identifier`);
  }
}

function assertBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label} must be a bounded integer`);
  }
}

function assertPortableArtifactPath(value, label) {
  assertString(value, label);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("TRANSCRIPT_ARTIFACT_PATH", `${label} must be a canonical relative artifact path`);
  }
}

function assertCanonicalEqual(actual, expected, label, code) {
  if (canonicalProbeJson(actual) !== canonicalProbeJson(expected)) {
    fail(code, `${label} does not match the trusted value`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactCanonicalSha256(value) {
  const canonicalValue = JSON.parse(canonicalProbeJson(value));
  return sha256(Buffer.from(JSON.stringify(canonicalValue), "utf8"));
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (exactObject(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

function validateBinding(value, label) {
  assertExactKeys(value, bindingKeys, label, "TRANSCRIPT_BINDING");
  if (value.campaignId !== PROBE_CAMPAIGN_ID) {
    fail("TRANSCRIPT_BINDING", `${label}.campaignId is not the canonical campaign`);
  }
  if (value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256) {
    fail("TRANSCRIPT_BINDING", `${label}.manifestSha256 is not the canonical manifest`);
  }
  for (const key of [
    "manifestSha256",
    "candidateSha256",
    "labAttestationSha256",
    "executionBundleManifestSha256",
    "preflightSha256",
    "preparationScopeSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "rootPathSha256",
    "evidenceRootObjectIdentitySha256",
    "volumeIdSha256",
    "verifierDefinitionSha256",
    "verifierSourceSha256",
  ]) {
    assertSha256(value[key], `${label}.${key}`);
  }
  for (const key of [
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "attemptId",
    "vmSnapshotId",
  ]) {
    assertString(value[key], `${label}.${key}`, { max: 128 });
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("TRANSCRIPT_BINDING", `${label}.environmentId is not allowlisted`);
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("TRANSCRIPT_BINDING", `${label}.pathProfileId is not allowlisted`);
  }
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("TRANSCRIPT_BINDING", `${label}.rowId is invalid`);
  }
  assertIdentifier(value.variantId, `${label}.variantId`);
  return value;
}

function validateProducer(value, label) {
  assertExactKeys(value, ["kind", "identitySha256"], label, "TRANSCRIPT_PRODUCER");
  if (!["native-helper", "external-controller"].includes(value.kind)) {
    fail("TRANSCRIPT_PRODUCER", `${label}.kind is invalid`);
  }
  assertSha256(value.identitySha256, `${label}.identitySha256`);
  return value;
}

function validateController(value) {
  assertExactKeys(
    value,
    ["identitySha256", "publicKeySha256", "version"],
    "expectedController",
    "TRANSCRIPT_CONTROLLER",
  );
  assertSha256(value.identitySha256, "expectedController.identitySha256");
  assertSha256(value.publicKeySha256, "expectedController.publicKeySha256");
  assertString(value.version, "expectedController.version", { max: 128 });
  return value;
}

function controllerReceiptPayload(value) {
  const { receiptSha256: _receiptSha256, signatureBase64: _signatureBase64, ...payload } = value;
  return payload;
}

export function deriveControllerSourceTranscriptReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-source-transcript-receipt.v1",
    receipt: controllerReceiptPayload(value),
  });
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    fail("TRANSCRIPT_CONTROLLER_SIGNATURE", `${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    fail("TRANSCRIPT_CONTROLLER_SIGNATURE", `${label} is not canonical base64`);
  }
  return bytes;
}

function sourceBindingSha256(binding) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-source-transcript-binding.v1",
    binding,
  });
}

function nativeTranscriptSetSha256(nativeTranscripts) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-native-transcript-set.v1",
    nativeTranscripts,
  });
}

function verifyControllerReceipt({
  receipt,
  sourceTranscriptSha256,
  sourceTranscript,
  expectedController,
  controllerPublicKeyBytes,
}) {
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "sourceTranscriptSha256",
      "bindingSha256",
      "producerKind",
      "producerIdentitySha256",
      "nativeTranscriptSetSha256",
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "controllerVersion",
      "signatureAlgorithm",
      "signatureBase64",
      "receiptSha256",
    ],
    "controllerReceipt",
    "TRANSCRIPT_CONTROLLER_RECEIPT",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "windows-host-probe-controller-source-transcript-receipt" ||
    receipt.signatureAlgorithm !== "Ed25519"
  ) {
    fail("TRANSCRIPT_CONTROLLER_RECEIPT", "controllerReceipt identity is invalid");
  }
  for (const key of [
    "sourceTranscriptSha256",
    "bindingSha256",
    "producerIdentitySha256",
    "nativeTranscriptSetSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "receiptSha256",
  ]) {
    assertSha256(receipt[key], `controllerReceipt.${key}`);
  }
  if (!["native-helper", "external-controller"].includes(receipt.producerKind)) {
    fail("TRANSCRIPT_CONTROLLER_RECEIPT", "controllerReceipt.producerKind is invalid");
  }
  assertString(receipt.controllerVersion, "controllerReceipt.controllerVersion", { max: 128 });
  const expected = {
    sourceTranscriptSha256,
    bindingSha256: sourceBindingSha256(sourceTranscript.binding),
    producerKind: sourceTranscript.producer.kind,
    producerIdentitySha256: sourceTranscript.producer.identitySha256,
    nativeTranscriptSetSha256: nativeTranscriptSetSha256(sourceTranscript.nativeTranscripts),
    controllerIdentitySha256: expectedController.identitySha256,
    controllerPublicKeySha256: expectedController.publicKeySha256,
    controllerVersion: expectedController.version,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key] !== expectedValue) {
      fail(
        "TRANSCRIPT_CONTROLLER_RECEIPT_BINDING",
        `controllerReceipt.${key} does not match the trusted transcript context`,
      );
    }
  }
  if (receipt.receiptSha256 !== deriveControllerSourceTranscriptReceiptDigest(receipt)) {
    fail("TRANSCRIPT_CONTROLLER_RECEIPT_DIGEST", "controllerReceipt digest is invalid");
  }
  if (!(controllerPublicKeyBytes instanceof Uint8Array) || controllerPublicKeyBytes.length === 0) {
    fail("TRANSCRIPT_CONTROLLER_KEY", "controllerPublicKeyBytes must be a non-empty Uint8Array");
  }
  const keyBytes = Buffer.from(
    controllerPublicKeyBytes.buffer,
    controllerPublicKeyBytes.byteOffset,
    controllerPublicKeyBytes.byteLength,
  );
  if (sha256(keyBytes) !== expectedController.publicKeySha256) {
    fail("TRANSCRIPT_CONTROLLER_KEY", "controller public-key bytes do not match the trusted key");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    fail("TRANSCRIPT_CONTROLLER_KEY", "controller public key must be SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("TRANSCRIPT_CONTROLLER_KEY", "controller public key must be Ed25519");
  }
  const signature = decodeCanonicalBase64(
    receipt.signatureBase64,
    "controllerReceipt.signatureBase64",
  );
  if (!verify(null, Buffer.from(receipt.receiptSha256, "hex"), publicKey, signature)) {
    fail("TRANSCRIPT_CONTROLLER_SIGNATURE", "controllerReceipt signature is invalid");
  }
}

function validateFactKeys(value, label) {
  if (!Array.isArray(value)) fail("TRANSCRIPT_FACT_ALLOWLIST", `${label} must be an array`);
  let previous = null;
  for (const [index, key] of value.entries()) {
    if (
      typeof key !== "string" ||
      !factKeyPattern.test(key) ||
      ["constructor", "prototype"].includes(key)
    ) {
      fail("TRANSCRIPT_FACT_ALLOWLIST", `${label}[${index}] is not a safe fact key`);
    }
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      fail("TRANSCRIPT_FACT_ALLOWLIST", `${label} must be strictly UTF-8 sorted and unique`);
    }
    previous = key;
  }
  return value;
}

function validateTrustedDefinition(value) {
  assertExactKeys(
    value,
    [
      "rowId",
      "variantId",
      "definitionSha256",
      "verifierSourceSha256",
      "transcriptKind",
      "commands",
    ],
    "trustedDefinition",
    "TRANSCRIPT_DEFINITION",
  );
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("TRANSCRIPT_DEFINITION", "trustedDefinition.rowId is invalid");
  }
  assertIdentifier(value.variantId, "trustedDefinition.variantId");
  assertSha256(value.definitionSha256, "trustedDefinition.definitionSha256");
  assertSha256(value.verifierSourceSha256, "trustedDefinition.verifierSourceSha256");
  if (
    !["windows-host-probe-controller-transcript", "windows-host-probe-native-transcript"].includes(
      value.transcriptKind,
    )
  ) {
    fail("TRANSCRIPT_DEFINITION", "trustedDefinition.transcriptKind is invalid");
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    fail("TRANSCRIPT_COMMAND_ALLOWLIST", "trustedDefinition.commands must be non-empty");
  }
  let previousCommand = null;
  const allFactKeys = new Set();
  for (const [index, command] of value.commands.entries()) {
    assertExactKeys(
      command,
      ["commandId", "factKeys"],
      `trustedDefinition.commands[${index}]`,
      "TRANSCRIPT_COMMAND_ALLOWLIST",
    );
    assertIdentifier(command.commandId, `trustedDefinition.commands[${index}].commandId`);
    if (previousCommand !== null && compareUtf8(previousCommand, command.commandId) >= 0) {
      fail(
        "TRANSCRIPT_COMMAND_ALLOWLIST",
        "trustedDefinition.commands must be strictly UTF-8 sorted and unique",
      );
    }
    previousCommand = command.commandId;
    validateFactKeys(command.factKeys, `trustedDefinition.commands[${index}].factKeys`);
    for (const factKey of command.factKeys) {
      if (allFactKeys.has(factKey)) {
        fail(
          "TRANSCRIPT_FACT_ALLOWLIST",
          `fact key ${factKey} is assigned to more than one command`,
        );
      }
      allFactKeys.add(factKey);
    }
  }
  if (allFactKeys.size === 0) {
    fail("TRANSCRIPT_FACT_ALLOWLIST", "trustedDefinition must allowlist at least one fact key");
  }
  return value;
}

function validateNativeStartupHandshake(value, label, binding) {
  assertExactKeys(
    value,
    ["protocolVersion", "kind", "requestId", "command", "context", "ok", "result"],
    label,
    "TRANSCRIPT_NATIVE_HANDSHAKE",
  );
  if (
    value.protocolVersion !== 1 ||
    value.kind !== "response" ||
    value.command !== "native-binding-check" ||
    value.ok !== true
  ) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label} is not a successful binding response`);
  }
  assertProtocolIdentifier(value.requestId, `${label}.requestId`);
  assertExactKeys(
    value.context,
    [
      "campaignRunId",
      "candidateSha256",
      "preflightSha256",
      "executionBundleManifestSha256",
      "nativeCandidateDigest",
      "nativeManifestSha256",
      "nativeHelperSha256",
      "evidenceRootObjectIdentitySha256",
      "nativeSessionId",
      "operationId",
      "requestFrameSha256",
      "runRootIdentity",
    ],
    `${label}.context`,
    "TRANSCRIPT_NATIVE_HANDSHAKE",
  );
  assertProtocolIdentifier(value.context.operationId, `${label}.context.operationId`);
  const requestContext = {
    campaignRunId: binding.campaignRunId,
    candidateSha256: binding.candidateSha256,
    preflightSha256: binding.preflightSha256,
    executionBundleManifestSha256: binding.executionBundleManifestSha256,
    nativeCandidateDigest: binding.nativeCandidateDigest,
    nativeManifestSha256: binding.nativeManifestSha256,
    nativeHelperSha256: binding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: binding.evidenceRootObjectIdentitySha256,
    nativeSessionId: binding.nativeSessionId,
    operationId: value.context.operationId,
  };
  for (const [key, expected] of Object.entries(requestContext)) {
    if (value.context[key] !== expected) {
      fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label}.context differs from its native binding`);
    }
  }
  if (value.context.runRootIdentity !== binding.runRootIdentity) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label}.context run root differs from its binding`);
  }
  assertSha256(value.context.requestFrameSha256, `${label}.context.requestFrameSha256`);
  const expectedRequestFrameSha256 = compactCanonicalSha256({
    protocolVersion: 1,
    requestId: value.requestId,
    command: "native-binding-check",
    context: requestContext,
    request: {},
  });
  if (value.context.requestFrameSha256 !== expectedRequestFrameSha256) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label} request digest is inconsistent`);
  }
  assertExactKeys(
    value.result,
    [
      "ready",
      "processId",
      "nativeHelperSha256",
      "runRootIdentity",
      "evidenceRootObjectIdentitySha256",
    ],
    `${label}.result`,
    "TRANSCRIPT_NATIVE_HANDSHAKE",
  );
  if (value.result.ready !== true) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label}.result is not ready`);
  }
  assertBoundedInteger(value.result.processId, `${label}.result.processId`, 1, 0x7fffffff);
  assertSha256(value.result.nativeHelperSha256, `${label}.result.nativeHelperSha256`);
  assertString(value.result.runRootIdentity, `${label}.result.runRootIdentity`, { max: 128 });
  assertSha256(
    value.result.evidenceRootObjectIdentitySha256,
    `${label}.result.evidenceRootObjectIdentitySha256`,
  );
  if (
    value.result.nativeHelperSha256 !== binding.nativeHelperSha256 ||
    value.result.runRootIdentity !== binding.runRootIdentity ||
    value.result.evidenceRootObjectIdentitySha256 !== binding.evidenceRootObjectIdentitySha256
  ) {
    fail("TRANSCRIPT_NATIVE_HANDSHAKE", `${label}.result differs from its native binding`);
  }
}

function validateNativeBinding(value, label, outerBinding) {
  assertExactKeys(value, nativeBindingKeys, label, "TRANSCRIPT_NATIVE_IDENTITY");
  for (const key of [
    "candidateSha256",
    "preflightSha256",
    "executionBundleManifestSha256",
    "nativeHelperSha256",
    "evidenceRootObjectIdentitySha256",
    "nativeCandidateDigest",
    "nativeManifestSha256",
    "startupHandshakeSha256",
  ]) {
    assertSha256(value[key], `${label}.${key}`);
  }
  assertString(value.campaignRunId, `${label}.campaignRunId`, { max: 128 });
  assertPortableArtifactPath(value.nativeHelperArtifactPath, `${label}.nativeHelperArtifactPath`);
  assertString(value.nativeSessionId, `${label}.nativeSessionId`, { min: 2, max: 64 });
  assertString(value.runRootIdentity, `${label}.runRootIdentity`, { max: 256 });
  if (
    createHash("sha256").update(value.runRootIdentity, "utf8").digest("hex") !==
    value.evidenceRootObjectIdentitySha256
  ) {
    fail("TRANSCRIPT_NATIVE_CONTEXT", `${label}.runRootIdentity differs from its binding`);
  }
  if (
    value.campaignRunId !== outerBinding.campaignRunId ||
    value.candidateSha256 !== outerBinding.candidateSha256 ||
    value.preflightSha256 !== outerBinding.preflightSha256 ||
    value.executionBundleManifestSha256 !== outerBinding.executionBundleManifestSha256 ||
    value.evidenceRootObjectIdentitySha256 !== outerBinding.evidenceRootObjectIdentitySha256
  ) {
    fail(
      "TRANSCRIPT_NATIVE_CONTEXT",
      `${label} does not match the source transcript execution binding`,
    );
  }
  validateNativeStartupHandshake(value.startupHandshake, `${label}.startupHandshake`, value);
  if (compactCanonicalSha256(value.startupHandshake) !== value.startupHandshakeSha256) {
    fail(
      "TRANSCRIPT_NATIVE_HANDSHAKE",
      `${label}.startupHandshakeSha256 differs from the retained handshake`,
    );
  }
  return value;
}

function validateNativeTranscripts(value, label, outerBinding) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("TRANSCRIPT_NATIVE_IDENTITY", `${label} must be a non-empty array`);
  }
  let previousSessionId = null;
  const transcriptDigests = new Set();
  for (const [index, entry] of value.entries()) {
    const entryLabel = `${label}[${index}]`;
    assertExactKeys(
      entry,
      ["transcriptSha256", "binding"],
      entryLabel,
      "TRANSCRIPT_NATIVE_IDENTITY",
    );
    assertSha256(entry.transcriptSha256, `${entryLabel}.transcriptSha256`);
    validateNativeBinding(entry.binding, `${entryLabel}.binding`, outerBinding);
    if (
      previousSessionId !== null &&
      compareUtf8(previousSessionId, entry.binding.nativeSessionId) >= 0
    ) {
      fail("TRANSCRIPT_NATIVE_IDENTITY", `${label} must be strictly sorted by nativeSessionId`);
    }
    if (transcriptDigests.has(entry.transcriptSha256)) {
      fail("TRANSCRIPT_NATIVE_IDENTITY", `${label} contains a duplicate transcript digest`);
    }
    previousSessionId = entry.binding.nativeSessionId;
    transcriptDigests.add(entry.transcriptSha256);
  }
  return value;
}

function validateTrustedNativeTranscriptEvidence(value, outerBinding) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "TRANSCRIPT_NATIVE_EVIDENCE",
      "trustedNativeTranscripts must be a non-empty evidence array",
    );
  }
  const identities = value.map((entry, index) => {
    const label = `trustedNativeTranscripts[${index}]`;
    assertExactKeys(
      entry,
      ["transcriptSha256", "binding", "commandRecords"],
      label,
      "TRANSCRIPT_NATIVE_EVIDENCE",
    );
    if (!Array.isArray(entry.commandRecords) || entry.commandRecords.length === 0) {
      fail("TRANSCRIPT_NATIVE_EVIDENCE", `${label}.commandRecords must be non-empty`);
    }
    const framePairs = new Set();
    for (const [recordIndex, record] of entry.commandRecords.entries()) {
      const recordLabel = `${label}.commandRecords[${recordIndex}]`;
      assertExactKeys(
        record,
        ["command", "requestFrameSha256", "responseFrameSha256", "ok"],
        recordLabel,
        "TRANSCRIPT_NATIVE_EVIDENCE",
      );
      assertString(record.command, `${recordLabel}.command`, { max: 64 });
      assertSha256(record.requestFrameSha256, `${recordLabel}.requestFrameSha256`);
      assertSha256(record.responseFrameSha256, `${recordLabel}.responseFrameSha256`);
      if (typeof record.ok !== "boolean") {
        fail("TRANSCRIPT_NATIVE_EVIDENCE", `${recordLabel}.ok must be boolean`);
      }
      const framePair = `${record.requestFrameSha256}\0${record.responseFrameSha256}`;
      if (framePairs.has(framePair)) {
        fail("TRANSCRIPT_NATIVE_EVIDENCE", `${label} contains a duplicate command frame pair`);
      }
      framePairs.add(framePair);
    }
    return { transcriptSha256: entry.transcriptSha256, binding: entry.binding };
  });
  validateNativeTranscripts(identities, "trustedNativeTranscriptIdentities", outerBinding);
  return { evidence: value, identities };
}

function validateSortedUniqueTranscriptDigests(value, label, code) {
  if (!Array.isArray(value)) {
    fail(code, `${label} must be an array`);
  }
  let previous = null;
  for (const [index, digest] of value.entries()) {
    assertSha256(digest, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, digest) >= 0) {
      fail(code, `${label} must be strictly UTF-8 sorted and unique`);
    }
    previous = digest;
  }
  return value;
}

function validateObservationValue(value, label) {
  assertExactKeys(value, ["factKey", "valueKind", "value"], label, "TRANSCRIPT_OBSERVATION");
  if (typeof value.factKey !== "string" || !factKeyPattern.test(value.factKey)) {
    fail("TRANSCRIPT_OBSERVATION", `${label}.factKey is invalid`);
  }
  const scalar = (expectedType) => {
    if (typeof value.value !== expectedType) {
      fail("TRANSCRIPT_OBSERVATION", `${label}.value does not match valueKind`);
    }
    if (expectedType === "number" && !Number.isFinite(value.value)) {
      fail("TRANSCRIPT_OBSERVATION", `${label}.value must be finite`);
    }
    if (expectedType === "string") assertString(value.value, `${label}.value`);
  };
  if (value.valueKind === "null") {
    if (value.value !== null) {
      fail("TRANSCRIPT_OBSERVATION", `${label}.value does not match valueKind`);
    }
    return value.value;
  }
  if (value.valueKind === "boolean") scalar("boolean");
  else if (value.valueKind === "number") scalar("number");
  else if (value.valueKind === "string") scalar("string");
  else if (["boolean-array", "number-array", "string-array"].includes(value.valueKind)) {
    if (!Array.isArray(value.value)) {
      fail("TRANSCRIPT_OBSERVATION", `${label}.value does not match valueKind`);
    }
    const elementType = value.valueKind.slice(0, -"-array".length);
    for (const [index, entry] of value.value.entries()) {
      if (typeof entry !== elementType) {
        fail("TRANSCRIPT_OBSERVATION", `${label}.value[${index}] has the wrong type`);
      }
      if (elementType === "number" && !Number.isFinite(entry)) {
        fail("TRANSCRIPT_OBSERVATION", `${label}.value[${index}] must be finite`);
      }
      if (elementType === "string") assertString(entry, `${label}.value[${index}]`);
    }
  } else {
    fail("TRANSCRIPT_OBSERVATION", `${label}.valueKind is invalid`);
  }
  return value.value;
}

function validateAvailability(value) {
  assertExactKeys(value, ["status", "reason"], "sourceTranscript.availability");
  if (!["available", "unavailable", "unknown"].includes(value.status)) {
    fail("TRANSCRIPT_AVAILABILITY", "sourceTranscript.availability.status is invalid");
  }
  if (value.reason !== null) {
    assertString(value.reason, "sourceTranscript.availability.reason", { max: 1024 });
  }
  if (value.status === "available" && value.reason !== null) {
    fail("TRANSCRIPT_AVAILABILITY", "available evidence cannot carry an unavailable reason");
  }
  return value;
}

function parseCanonicalSourceTranscript(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    fail("TRANSCRIPT_BYTES", "sourceTranscriptBytes must be a Uint8Array");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_TRANSCRIPT_BYTES) {
    fail("TRANSCRIPT_BYTES", "sourceTranscriptBytes exceeds its size bounds");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("TRANSCRIPT_UTF8", "sourceTranscriptBytes is not valid UTF-8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("TRANSCRIPT_JSON", "sourceTranscriptBytes is not valid JSON");
  }
  let canonical;
  try {
    canonical = canonicalProbeJson(value);
  } catch {
    fail("TRANSCRIPT_CANONICAL", "sourceTranscriptBytes contains a noncanonical JSON value");
  }
  if (text !== canonical) {
    fail("TRANSCRIPT_CANONICAL", "sourceTranscriptBytes is not canonical probe JSON");
  }
  return value;
}

function actionAttestationFail(message) {
  fail("TRANSCRIPT_ACTION_ATTESTATION", message);
}

function assertActionAttestationSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    actionAttestationFail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertActionAttestationIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !identifierPattern.test(value)
  ) {
    actionAttestationFail(`${label} must be a bounded protocol identifier`);
  }
}

function validateActionAttestationCoordinate(value, label) {
  assertExactKeys(value, actionAttestationCoordinateKeys, label, "TRANSCRIPT_ACTION_ATTESTATION");
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    assertActionAttestationIdentifier(value[key], `${label}.${key}`);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    actionAttestationFail(`${label}.environmentId is not allowlisted`);
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    actionAttestationFail(`${label}.pathProfileId is not allowlisted`);
  }
  if (typeof value.rowId !== "string" || !/^F-(?:0[1-9]|10)$/u.test(value.rowId)) {
    actionAttestationFail(`${label}.rowId is invalid`);
  }
  if (
    value.repetition !== null &&
    (!Number.isSafeInteger(value.repetition) || value.repetition < 1)
  ) {
    actionAttestationFail(`${label}.repetition is invalid`);
  }
}

function validateActionAttestationExpectedActor(value, label) {
  assertExactKeys(
    value,
    ["role", "identitySource", "identitySha256"],
    label,
    "TRANSCRIPT_ACTION_ATTESTATION",
  );
  if (
    !Object.hasOwn(actorIdentitySources, value.role) ||
    value.identitySource !== actorIdentitySources[value.role]
  ) {
    actionAttestationFail(`${label} is not a closed actor identity`);
  }
  assertActionAttestationSha256(value.identitySha256, `${label}.identitySha256`);
  return value;
}

function validateActionAttestationActorSelector(value, expectedActor, label) {
  if (!exactObject(value)) actionAttestationFail(`${label} must be a plain object`);
  if (value.kind === "fixed") {
    assertExactKeys(value, ["kind", "role"], label, "TRANSCRIPT_ACTION_ATTESTATION");
    if (value.role !== expectedActor.role) {
      actionAttestationFail(`${label}.role differs from the expected actor`);
    }
    return;
  }
  assertExactKeys(
    value,
    ["kind", "parameter", "roleByValue"],
    label,
    "TRANSCRIPT_ACTION_ATTESTATION",
  );
  if (value.kind !== "parameter" || value.parameter !== "actor") {
    actionAttestationFail(`${label} parameter selector is invalid`);
  }
  assertExactKeys(
    value.roleByValue,
    ["current-user", "second-user"],
    `${label}.roleByValue`,
    "TRANSCRIPT_ACTION_ATTESTATION",
  );
  if (
    value.roleByValue["current-user"] !== "primary-standard-user" ||
    value.roleByValue["second-user"] !== "second-user" ||
    !Object.values(value.roleByValue).includes(expectedActor.role)
  ) {
    actionAttestationFail(`${label} role map cannot select the expected actor`);
  }
}

function validateActionAttestationExecution(value, expectedActor, label) {
  assertExactKeys(value, actionAttestationExecutionKeys, label, "TRANSCRIPT_ACTION_ATTESTATION");
  if (value.actor !== "external-controller") {
    actionAttestationFail(`${label}.actor is invalid`);
  }
  assertActionAttestationIdentifier(value.operation, `${label}.operation`);
  assertActionAttestationIdentifier(value.driverId, `${label}.driverId`);
  if (!executionLoci.includes(value.locus)) {
    actionAttestationFail(`${label}.locus is invalid`);
  }
  if (
    typeof value.disruptive !== "boolean" ||
    typeof value.nativeTranscriptRequired !== "boolean"
  ) {
    actionAttestationFail(`${label} flags are invalid`);
  }
  validateActionAttestationActorSelector(
    value.actorSelector,
    expectedActor,
    `${label}.actorSelector`,
  );
  const allowedLoci = {
    "primary-standard-user": ["guest-standard-user-worker", "controller-orchestrated-guest"],
    controller: ["controller-host"],
    "power-control": ["controller-host"],
    "remote-peer": ["controller-remote-peer"],
    "second-user": ["guest-second-user-broker"],
  };
  if (value.actorSelector.kind === "parameter") {
    if (
      value.operation !== "exercise-directory-access" ||
      value.locus !== "controller-orchestrated-guest"
    ) {
      actionAttestationFail(`${label} parameter routing is not the frozen action`);
    }
  } else if (!allowedLoci[expectedActor.role]?.includes(value.locus)) {
    actionAttestationFail(`${label}.locus differs from the expected actor`);
  }
  if (value.disruptive && !["controller", "power-control"].includes(expectedActor.role)) {
    actionAttestationFail(`${label} assigns a disruptive action to a guest actor`);
  }
}

function validateActionAttestationBroker(value, expectedActor, label) {
  assertExactKeys(value, actionAttestationBrokerKeys, label, "TRANSCRIPT_ACTION_ATTESTATION");
  for (const key of [
    "brokerAcceptanceSha256",
    "brokerTaskSha256",
    "brokerTaskNonceSha256",
    "brokerResultSha256",
    "brokerEnrollmentSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "replayJournalEntrySha256",
  ]) {
    assertActionAttestationSha256(value[key], `${label}.${key}`);
  }
  assertActionAttestationIdentifier(value.brokerInstanceId, `${label}.brokerInstanceId`);
  const sidBoundRole = ["primary-standard-user", "second-user"].includes(expectedActor.role);
  if (
    value.brokerRole !== expectedActor.role ||
    (sidBoundRole && value.processSidSha256 !== expectedActor.identitySha256)
  ) {
    actionAttestationFail(`${label} differs from the expected actor`);
  }
  if (!["accepted", "idempotent-replay"].includes(value.replayJournalDisposition)) {
    actionAttestationFail(`${label}.replayJournalDisposition is invalid`);
  }
}

function validateActionAttestationObserverCommands(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTION_ATTESTATIONS) {
    actionAttestationFail(`${label} must be a bounded non-empty array`);
  }
  let previous = null;
  const frameBindings = new Set();
  for (const [index, command] of value.entries()) {
    const commandLabel = `${label}[${index}]`;
    assertExactKeys(
      command,
      actionAttestationObserverCommandKeys,
      commandLabel,
      "TRANSCRIPT_ACTION_ATTESTATION",
    );
    assertActionAttestationSha256(command.transcriptSha256, `${commandLabel}.transcriptSha256`);
    if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
      actionAttestationFail(`${commandLabel}.sequence is invalid`);
    }
    assertActionAttestationIdentifier(command.commandId, `${commandLabel}.commandId`);
    assertActionAttestationSha256(command.requestFrameSha256, `${commandLabel}.requestFrameSha256`);
    assertActionAttestationSha256(
      command.responseFrameSha256,
      `${commandLabel}.responseFrameSha256`,
    );
    if (typeof command.ok !== "boolean") {
      actionAttestationFail(`${commandLabel}.ok must be boolean`);
    }
    const orderKey = `${command.transcriptSha256}\0${String(command.sequence).padStart(16, "0")}`;
    const frameBinding = [
      command.transcriptSha256,
      command.commandId,
      command.requestFrameSha256,
      command.responseFrameSha256,
    ].join("\0");
    if (
      (previous !== null && compareUtf8(previous, orderKey) >= 0) ||
      frameBindings.has(frameBinding)
    ) {
      actionAttestationFail(`${label} is not strictly ordered and unique`);
    }
    previous = orderKey;
    frameBindings.add(frameBinding);
  }
}

function validateActionAttestation(value, label) {
  assertExactKeys(value, actionAttestationKeys, label, "TRANSCRIPT_ACTION_ATTESTATION");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-controller-action-attestation" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    actionAttestationFail(`${label} identity is invalid`);
  }
  for (const key of [
    "runPlanSha256",
    "candidateSha256",
    "executionBundleManifestSha256",
    "runAuthorizationClaimReceiptSha256",
    "scenarioPlanSha256",
    "runtimeActionIntentSha256",
    "attestationSha256",
  ]) {
    assertActionAttestationSha256(value[key], `${label}.${key}`);
  }
  assertActionAttestationIdentifier(value.executionBundleId, `${label}.executionBundleId`);
  validateActionAttestationCoordinate(value.coordinate, `${label}.coordinate`);
  assertActionAttestationIdentifier(value.producerActionId, `${label}.producerActionId`);
  assertExactKeys(
    value.operation,
    ["operationId", "kind", "sequence"],
    `${label}.operation`,
    "TRANSCRIPT_ACTION_ATTESTATION",
  );
  assertActionAttestationIdentifier(value.operation.operationId, `${label}.operation.operationId`);
  if (
    value.operation.kind !== "scenario-action" ||
    !Number.isSafeInteger(value.operation.sequence) ||
    value.operation.sequence < 1
  ) {
    actionAttestationFail(`${label}.operation is invalid`);
  }
  const expectedActor = validateActionAttestationExpectedActor(
    value.expectedActor,
    `${label}.expectedActor`,
  );
  validateActionAttestationExecution(value.execution, expectedActor, `${label}.execution`);
  if (brokerActorRoles.includes(expectedActor.role)) {
    if (value.broker === null) {
      actionAttestationFail(`${label}.broker is required for a broker actor`);
    }
    validateActionAttestationBroker(value.broker, expectedActor, `${label}.broker`);
  } else if (value.broker !== null) {
    actionAttestationFail(`${label}.broker must be null for a direct controller actor`);
  }
  validateActionAttestationObserverCommands(value.observerCommands, `${label}.observerCommands`);
  const draft = Object.fromEntries(actionAttestationDraftKeys.map((key) => [key, value[key]]));
  const expectedDigest = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-controller-action-attestation.v1",
    attestation: draft,
  });
  if (value.attestationSha256 !== expectedDigest) {
    actionAttestationFail(`${label}.attestationSha256 is invalid`);
  }
  return value;
}

function parseTrustedControllerActionAttestation(bytes, index) {
  const label = `trustedControllerActionAttestationBytes[${index}]`;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    actionAttestationFail(`${label} must contain non-empty bytes`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    actionAttestationFail(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    actionAttestationFail(`${label} is not valid JSON`);
  }
  let canonical;
  try {
    canonical = canonicalProbeJson(value);
  } catch {
    actionAttestationFail(`${label} contains a noncanonical JSON value`);
  }
  if (text !== canonical) {
    actionAttestationFail(`${label} is not canonical probe JSON`);
  }
  return validateActionAttestation(value, label);
}

function validateActionAttestationSourceBinding(attestation, binding, label) {
  const coordinate = attestation.coordinate;
  if (
    attestation.campaignId !== binding.campaignId ||
    attestation.manifestSha256 !== binding.manifestSha256 ||
    attestation.candidateSha256 !== binding.candidateSha256 ||
    attestation.executionBundleId !== binding.executionBundleId ||
    attestation.executionBundleManifestSha256 !== binding.executionBundleManifestSha256 ||
    coordinate.campaignRunId !== binding.campaignRunId ||
    coordinate.executionRunId !== binding.executionRunId ||
    coordinate.attemptId !== binding.attemptId ||
    coordinate.environmentId !== binding.environmentId ||
    coordinate.pathProfileId !== binding.pathProfileId ||
    coordinate.rowId !== binding.rowId ||
    coordinate.variantId !== binding.variantId ||
    (attestation.broker !== null &&
      (attestation.broker.bootIdSha256 !== binding.bootIdSha256 ||
        attestation.broker.runnerSessionIdSha256 !== binding.runnerSessionIdSha256))
  ) {
    actionAttestationFail(`${label} does not match the source transcript execution binding`);
  }
}

function validateTrustedControllerActionAttestations(value, expectedBinding) {
  if (!Array.isArray(value) || value.length > MAX_ACTION_ATTESTATIONS) {
    actionAttestationFail("trustedControllerActionAttestationBytes must be a bounded array");
  }
  let totalBytes = 0;
  const attestations = new Map();
  for (const [index, bytes] of value.entries()) {
    if (!(bytes instanceof Uint8Array)) {
      actionAttestationFail(
        `trustedControllerActionAttestationBytes[${index}] must be a Uint8Array`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ACTION_ATTESTATION_BYTES) {
      actionAttestationFail("trusted controller action attestations exceed their byte bound");
    }
    const attestation = parseTrustedControllerActionAttestation(bytes, index);
    validateActionAttestationSourceBinding(
      attestation,
      expectedBinding,
      `trustedControllerActionAttestationBytes[${index}]`,
    );
    if (attestations.has(attestation.attestationSha256)) {
      actionAttestationFail("trusted controller action attestations contain a duplicate digest");
    }
    attestations.set(attestation.attestationSha256, attestation);
  }
  return attestations;
}

function validateCoordinates(binding, definition) {
  if (
    binding.rowId !== definition.rowId ||
    binding.variantId !== definition.variantId ||
    binding.verifierDefinitionSha256 !== definition.definitionSha256 ||
    binding.verifierSourceSha256 !== definition.verifierSourceSha256
  ) {
    fail(
      "TRANSCRIPT_DEFINITION_BINDING",
      "source transcript coordinates or verifier identities do not match the trusted definition",
    );
  }
}

function transcriptKindForProducer(kind) {
  return kind === "native-helper"
    ? "windows-host-probe-native-transcript"
    : "windows-host-probe-controller-transcript";
}

export function reduceProbeSourceTranscript(input) {
  assertExactKeys(
    input,
    [
      "sourceTranscriptBytes",
      "expectedBinding",
      "expectedProducer",
      "expectedController",
      "controllerPublicKeyBytes",
      "controllerReceipt",
      "trustedNativeTranscripts",
      "trustedControllerActionAttestationBytes",
      "trustedDefinition",
    ],
    "transcript reducer input",
    "TRANSCRIPT_INPUT",
  );
  const expectedBinding = validateBinding(input.expectedBinding, "expectedBinding");
  const expectedProducer = validateProducer(input.expectedProducer, "expectedProducer");
  const expectedController = validateController(input.expectedController);
  const trustedDefinition = validateTrustedDefinition(input.trustedDefinition);
  const trustedControllerActionAttestations = validateTrustedControllerActionAttestations(
    input.trustedControllerActionAttestationBytes,
    expectedBinding,
  );
  const trustedNative = validateTrustedNativeTranscriptEvidence(
    input.trustedNativeTranscripts,
    expectedBinding,
  );
  const trustedNativeTranscripts = trustedNative.identities;
  validateCoordinates(expectedBinding, trustedDefinition);
  if (transcriptKindForProducer(expectedProducer.kind) !== trustedDefinition.transcriptKind) {
    fail(
      "TRANSCRIPT_PRODUCER_KIND",
      "trusted producer kind does not match the verifier transcript kind",
    );
  }
  if (
    (expectedProducer.kind === "native-helper" && trustedControllerActionAttestations.size !== 0) ||
    (expectedProducer.kind === "external-controller" &&
      trustedControllerActionAttestations.size !== trustedDefinition.commands.length)
  ) {
    fail(
      "TRANSCRIPT_ACTION_ATTESTATION",
      "trusted action attestations must map one-to-one to external-controller command events",
    );
  }
  if (
    expectedProducer.kind === "external-controller" &&
    expectedProducer.identitySha256 !== expectedController.identitySha256
  ) {
    fail(
      "TRANSCRIPT_PRODUCER_IDENTITY",
      "external-controller producer identity does not match the trusted controller",
    );
  }
  if (
    expectedProducer.kind === "native-helper" &&
    trustedNativeTranscripts.some(
      (entry) => entry.binding.nativeHelperSha256 !== expectedProducer.identitySha256,
    )
  ) {
    fail(
      "TRANSCRIPT_LOADED_IMAGE",
      "native producer identity does not match every loaded helper image",
    );
  }

  const sourceTranscript = parseCanonicalSourceTranscript(input.sourceTranscriptBytes);
  const sourceTranscriptSha256 = sha256(Buffer.from(input.sourceTranscriptBytes));
  assertExactKeys(
    sourceTranscript,
    [
      "schemaVersion",
      "kind",
      "producer",
      "binding",
      "nativeTranscripts",
      "observerNativeTranscriptSha256s",
      "captureComplete",
      "availability",
      "commandEvents",
    ],
    "sourceTranscript",
  );
  if (
    sourceTranscript.schemaVersion !== 1 ||
    sourceTranscript.kind !== "windows-host-probe-source-transcript"
  ) {
    fail("TRANSCRIPT_SCHEMA", "sourceTranscript schemaVersion/kind is invalid");
  }
  if (typeof sourceTranscript.captureComplete !== "boolean") {
    fail("TRANSCRIPT_CAPTURE", "sourceTranscript.captureComplete must be boolean");
  }
  validateAvailability(sourceTranscript.availability);
  validateBinding(sourceTranscript.binding, "sourceTranscript.binding");
  validateCoordinates(sourceTranscript.binding, trustedDefinition);
  assertCanonicalEqual(
    sourceTranscript.binding,
    expectedBinding,
    "sourceTranscript.binding",
    "TRANSCRIPT_BINDING_MISMATCH",
  );
  validateProducer(sourceTranscript.producer, "sourceTranscript.producer");
  assertCanonicalEqual(
    sourceTranscript.producer,
    expectedProducer,
    "sourceTranscript.producer",
    "TRANSCRIPT_PRODUCER_MISMATCH",
  );
  if (
    transcriptKindForProducer(sourceTranscript.producer.kind) !== trustedDefinition.transcriptKind
  ) {
    fail(
      "TRANSCRIPT_PRODUCER_KIND",
      "source transcript producer kind does not match the verifier transcript kind",
    );
  }
  validateNativeTranscripts(
    sourceTranscript.nativeTranscripts,
    "sourceTranscript.nativeTranscripts",
    sourceTranscript.binding,
  );
  assertCanonicalEqual(
    sourceTranscript.nativeTranscripts,
    trustedNativeTranscripts,
    "sourceTranscript.nativeTranscripts",
    "TRANSCRIPT_NATIVE_IDENTITY_MISMATCH",
  );
  const trustedNativeTranscriptSha256Set = new Set(
    trustedNativeTranscripts.map((entry) => entry.transcriptSha256),
  );
  validateSortedUniqueTranscriptDigests(
    sourceTranscript.observerNativeTranscriptSha256s,
    "sourceTranscript.observerNativeTranscriptSha256s",
    "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
  );
  const observerNativeTranscriptSha256Set = new Set(
    sourceTranscript.observerNativeTranscriptSha256s,
  );
  for (const transcriptSha256 of observerNativeTranscriptSha256Set) {
    if (!trustedNativeTranscriptSha256Set.has(transcriptSha256)) {
      fail(
        "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
        "source transcript classifies an untrusted native transcript as an observer",
      );
    }
  }
  if (
    sourceTranscript.producer.kind === "native-helper" &&
    sourceTranscript.nativeTranscripts.some(
      (entry) => entry.binding.nativeHelperSha256 !== sourceTranscript.producer.identitySha256,
    )
  ) {
    fail(
      "TRANSCRIPT_LOADED_IMAGE",
      "source transcript producer does not match every loaded helper image",
    );
  }
  if (
    sourceTranscript.producer.kind === "external-controller" &&
    sourceTranscript.producer.identitySha256 !== expectedController.identitySha256
  ) {
    fail(
      "TRANSCRIPT_PRODUCER_IDENTITY",
      "source transcript external producer is not the trusted controller",
    );
  }
  verifyControllerReceipt({
    receipt: input.controllerReceipt,
    sourceTranscriptSha256,
    sourceTranscript,
    expectedController,
    controllerPublicKeyBytes: input.controllerPublicKeyBytes,
  });

  if (
    !Array.isArray(sourceTranscript.commandEvents) ||
    sourceTranscript.commandEvents.length !== trustedDefinition.commands.length
  ) {
    fail(
      "TRANSCRIPT_COMMAND_SET",
      "source transcript must contain exactly the allowlisted command events",
    );
  }
  const facts = {};
  const observedFactKeys = new Set();
  const matchedNativeTranscriptSha256s = new Set();
  const eventNativeTranscriptSha256s = new Set();
  const usedActionAttestationSha256s = new Set();
  for (const [index, command] of trustedDefinition.commands.entries()) {
    const event = sourceTranscript.commandEvents[index];
    const label = `sourceTranscript.commandEvents[${index}]`;
    assertExactKeys(
      event,
      [
        "sequence",
        "producerKind",
        "actionAttestationSha256",
        "commandId",
        "requestSha256",
        "responseSha256",
        "nativeTranscriptSha256s",
        "observations",
      ],
      label,
      "TRANSCRIPT_COMMAND_EVENT",
    );
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) {
      fail("TRANSCRIPT_COMMAND_SEQUENCE", `${label}.sequence must be contiguous and ordered`);
    }
    if (event.producerKind !== sourceTranscript.producer.kind) {
      fail("TRANSCRIPT_PRODUCER_KIND", `${label}.producerKind does not match its producer`);
    }
    if (event.commandId !== command.commandId) {
      fail("TRANSCRIPT_COMMAND_SET", `${label}.commandId is not the allowlisted command`);
    }
    assertSha256(event.requestSha256, `${label}.requestSha256`);
    assertSha256(event.responseSha256, `${label}.responseSha256`);
    validateSortedUniqueTranscriptDigests(
      event.nativeTranscriptSha256s,
      `${label}.nativeTranscriptSha256s`,
      "TRANSCRIPT_NATIVE_EVENT_BINDING",
    );
    for (const transcriptSha256 of event.nativeTranscriptSha256s) {
      if (!trustedNativeTranscriptSha256Set.has(transcriptSha256)) {
        fail(
          "TRANSCRIPT_NATIVE_EVENT_BINDING",
          `${label} names a native transcript outside the trusted union`,
        );
      }
      eventNativeTranscriptSha256s.add(transcriptSha256);
    }
    if (sourceTranscript.producer.kind === "native-helper") {
      if (event.actionAttestationSha256 !== null) {
        fail(
          "TRANSCRIPT_ACTION_ATTESTATION",
          `${label} cannot attach a controller action attestation to a native event`,
        );
      }
    } else {
      assertActionAttestationSha256(
        event.actionAttestationSha256,
        `${label}.actionAttestationSha256`,
      );
      if (usedActionAttestationSha256s.has(event.actionAttestationSha256)) {
        fail(
          "TRANSCRIPT_ACTION_ATTESTATION",
          `${label} reuses an action attestation from another command event`,
        );
      }
      const attestation = trustedControllerActionAttestations.get(event.actionAttestationSha256);
      if (attestation === undefined) {
        fail(
          "TRANSCRIPT_ACTION_ATTESTATION",
          `${label} does not name an independently trusted action attestation`,
        );
      }
      const retainedMatchingTranscriptSha256s = [];
      for (const transcript of trustedNative.evidence) {
        const matches = transcript.commandRecords.filter(
          (record) =>
            record.command === event.commandId &&
            record.requestFrameSha256 === event.requestSha256 &&
            record.responseFrameSha256 === event.responseSha256,
        );
        if (matches.length > 1) {
          fail(
            "TRANSCRIPT_ACTION_ATTESTATION",
            `${label} ambiguously matches retained observer command records`,
          );
        }
        if (matches.length === 1)
          retainedMatchingTranscriptSha256s.push(transcript.transcriptSha256);
      }
      retainedMatchingTranscriptSha256s.sort(compareUtf8);
      const attestedMatchingTranscriptSha256s = attestation.observerCommands
        .filter(
          (observerCommand) =>
            observerCommand.commandId === event.commandId &&
            observerCommand.requestFrameSha256 === event.requestSha256 &&
            observerCommand.responseFrameSha256 === event.responseSha256,
        )
        .map((observerCommand) => observerCommand.transcriptSha256)
        .sort(compareUtf8);
      if (
        retainedMatchingTranscriptSha256s.length !== event.nativeTranscriptSha256s.length ||
        retainedMatchingTranscriptSha256s.some(
          (transcriptSha256, transcriptIndex) =>
            transcriptSha256 !== event.nativeTranscriptSha256s[transcriptIndex],
        ) ||
        attestedMatchingTranscriptSha256s.length !== event.nativeTranscriptSha256s.length ||
        attestedMatchingTranscriptSha256s.some(
          (transcriptSha256, transcriptIndex) =>
            transcriptSha256 !== event.nativeTranscriptSha256s[transcriptIndex],
        )
      ) {
        fail(
          "TRANSCRIPT_ACTION_ATTESTATION",
          `${label} command frames do not exactly match its attested observer records`,
        );
      }
      usedActionAttestationSha256s.add(event.actionAttestationSha256);
    }
    if (sourceTranscript.producer.kind === "native-helper") {
      const matches = [];
      for (const transcript of trustedNative.evidence) {
        for (const record of transcript.commandRecords) {
          if (
            record.command === event.commandId &&
            record.requestFrameSha256 === event.requestSha256 &&
            record.responseFrameSha256 === event.responseSha256
          ) {
            matches.push(transcript.transcriptSha256);
          }
        }
      }
      if (matches.length !== 1) {
        fail(
          "TRANSCRIPT_NATIVE_COMMAND_BINDING",
          `${label} must match exactly one retained native command record`,
        );
      }
      const matchedTranscriptSha256 = matches[0];
      if (
        event.nativeTranscriptSha256s.length !== 1 ||
        event.nativeTranscriptSha256s[0] !== matchedTranscriptSha256
      ) {
        fail(
          "TRANSCRIPT_NATIVE_EVENT_BINDING",
          `${label} does not name the one transcript containing its command frames`,
        );
      }
      if (observerNativeTranscriptSha256Set.has(matchedTranscriptSha256)) {
        fail(
          "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
          `${label} classifies its fact-producing native transcript as observer-only`,
        );
      }
      matchedNativeTranscriptSha256s.add(matchedTranscriptSha256);
    }
    if (
      !Array.isArray(event.observations) ||
      event.observations.length !== command.factKeys.length
    ) {
      fail(
        "TRANSCRIPT_FACT_SET",
        `${label}.observations must contain exactly the command fact allowlist`,
      );
    }
    for (const [observationIndex, expectedFactKey] of command.factKeys.entries()) {
      const observation = event.observations[observationIndex];
      const observationLabel = `${label}.observations[${observationIndex}]`;
      const primitiveValue = validateObservationValue(observation, observationLabel);
      if (observation.factKey !== expectedFactKey) {
        fail(
          "TRANSCRIPT_FACT_SET",
          `${observationLabel}.factKey is missing, duplicated, unknown, or assigned to the wrong command`,
        );
      }
      if (observedFactKeys.has(observation.factKey)) {
        fail("TRANSCRIPT_FACT_SET", `fact key ${observation.factKey} was observed more than once`);
      }
      observedFactKeys.add(observation.factKey);
      facts[observation.factKey] = primitiveValue;
    }
  }
  const expectedFactCount = trustedDefinition.commands.reduce(
    (count, command) => count + command.factKeys.length,
    0,
  );
  if (observedFactKeys.size !== expectedFactCount) {
    fail(
      "TRANSCRIPT_FACT_SET",
      "source transcript did not provide every allowlisted fact exactly once",
    );
  }
  if (usedActionAttestationSha256s.size !== trustedControllerActionAttestations.size) {
    fail(
      "TRANSCRIPT_ACTION_ATTESTATION",
      "trusted controller action attestations contain unused evidence",
    );
  }
  const classifiedNativeTranscriptSha256s = new Set([
    ...eventNativeTranscriptSha256s,
    ...observerNativeTranscriptSha256Set,
  ]);
  if (
    classifiedNativeTranscriptSha256s.size !== trustedNativeTranscriptSha256Set.size ||
    [...trustedNativeTranscriptSha256Set].some(
      (transcriptSha256) => !classifiedNativeTranscriptSha256s.has(transcriptSha256),
    )
  ) {
    fail(
      "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
      "trusted native transcript union contains an unclassified transcript",
    );
  }
  if (
    sourceTranscript.producer.kind === "native-helper" &&
    [...trustedNativeTranscriptSha256Set].some(
      (transcriptSha256) =>
        !observerNativeTranscriptSha256Set.has(transcriptSha256) &&
        !matchedNativeTranscriptSha256s.has(transcriptSha256),
    )
  ) {
    fail(
      "TRANSCRIPT_NATIVE_COMMAND_BINDING",
      "every non-observer native transcript must contribute a matched command record",
    );
  }

  const orderedFacts = Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => compareUtf8(left, right)),
  );
  const factsSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-transcript-facts.v1",
    rowId: trustedDefinition.rowId,
    variantId: trustedDefinition.variantId,
    facts: orderedFacts,
  });
  const captureSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-transcript-capture.v1",
    rowId: trustedDefinition.rowId,
    variantId: trustedDefinition.variantId,
    schemaVersion: 1,
    kind: "windows-host-probe-raw-facts",
    captureComplete: sourceTranscript.captureComplete,
    availability: sourceTranscript.availability,
    facts: orderedFacts,
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-raw-facts",
    captureComplete: sourceTranscript.captureComplete,
    availability: sourceTranscript.availability,
    scenario: {
      variantId: trustedDefinition.variantId,
      definitionSha256: trustedDefinition.definitionSha256,
      evidenceSha256: sourceTranscriptSha256,
      transcript: {
        schemaVersion: 1,
        kind: trustedDefinition.transcriptKind,
        rowId: trustedDefinition.rowId,
        variantId: trustedDefinition.variantId,
        verifierDefinitionSha256: trustedDefinition.definitionSha256,
        commandIds: trustedDefinition.commands.map((command) => command.commandId),
        sourceTranscriptSha256,
        factsSha256,
        captureSha256,
      },
    },
    facts: orderedFacts,
  });
}
