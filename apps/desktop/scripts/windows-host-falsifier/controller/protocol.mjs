import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
} from "../probe-contract.mjs";

export const CONTROLLER_PROTOCOL_SCHEMA_VERSION = 1;
export const CONTROLLER_REQUEST_KIND = "windows-host-probe-controller-request";
export const CONTROLLER_RESPONSE_KIND = "windows-host-probe-controller-response";
export const CONTROLLER_OPERATION_KINDS = Object.freeze([
  "capture-disposition-observation",
  "controller-observation",
  "evidence-quiescence-abandon",
  "evidence-quiescence-acquire",
  "evidence-quiescence-capture",
  "evidence-quiescence-complete",
  "evidence-quiescence-renew",
  "hard-cut-receipt-read",
  "hard-cut-request-claim",
  "run-authorization-claim",
  "scenario-action",
  "source-transcript-sign",
]);
export const CONTROLLER_RESPONSE_OUTCOMES = Object.freeze(["FAILED", "INCONCLUSIVE", "SUCCEEDED"]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const exactVersionPattern = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const preparationOperationKinds = new Set(["controller-observation", "run-authorization-claim"]);
const hardCutOperationKinds = new Set(["hard-cut-receipt-read", "hard-cut-request-claim"]);
const requestDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "candidateSha256",
  "runPlanSha256",
  "runAuthorizationSha256",
  "runAuthorizationClaimSha256",
  "coordinate",
  "operation",
  "intentSha256",
  "payload",
  "controllerIdentitySha256",
]);
const responseDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "requestSha256",
  "outcome",
  "payload",
  "artifacts",
  "controllerIdentitySha256",
  "controllerVersion",
  "controllerPublicKeySha256",
  "signatureAlgorithm",
]);

export class ControllerProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControllerProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerProtocolError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("CONTROLLER_PROTOCOL_OBJECT", `${label} must be a plain object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("CONTROLLER_PROTOCOL_KEYS", `${label} has an invalid field set`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_PROTOCOL_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !identifierPattern.test(value)
  ) {
    fail("CONTROLLER_PROTOCOL_IDENTIFIER", `${label} must be a bounded identifier`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CONTROLLER_PROTOCOL_INTEGER", `${label} must be a positive safe integer`);
  }
}

function freezeCanonical(value) {
  const copy = JSON.parse(canonicalProbeJson(value));
  const visit = (entry) => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) visit(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return visit(copy);
}

function validateContentAddressedReference(value, label) {
  assertExactKeys(value, ["blobPath", "bytes", "sha256"], label);
  assertSha256(value.sha256, `${label}.sha256`);
  if (value.blobPath !== `blobs/sha256/${value.sha256}`) {
    fail("CONTROLLER_PROTOCOL_ARTIFACT", `${label} path is not content-addressed`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("CONTROLLER_PROTOCOL_ARTIFACT", `${label} byte count is invalid`);
  }
  return value;
}

function validateCoordinate(value, operationKind) {
  assertExactKeys(
    value,
    [
      "campaignRunId",
      "executionRunId",
      "workId",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "attemptId",
      "repetition",
    ],
    "controller request coordinate",
  );
  for (const key of ["campaignRunId", "executionRunId", "attemptId"]) {
    assertIdentifier(value[key], `controller request coordinate.${key}`);
  }
  if (!new Set(["win11-current", "win11-floor"]).has(value.environmentId)) {
    fail(
      "CONTROLLER_PROTOCOL_COORDINATE",
      "controller request coordinate.environmentId is invalid",
    );
  }
  if (!new Set(["ascii", "spaces-unicode"]).has(value.pathProfileId)) {
    fail(
      "CONTROLLER_PROTOCOL_COORDINATE",
      "controller request coordinate.pathProfileId is invalid",
    );
  }
  const scopedValues = [value.workId, value.rowId, value.variantId, value.repetition];
  if (preparationOperationKinds.has(operationKind)) {
    if (scopedValues.some((entry) => entry !== null)) {
      fail(
        "CONTROLLER_PROTOCOL_COORDINATE_SCOPE",
        "preparation operation has work-scoped coordinate fields",
      );
    }
    return value;
  }
  if ([value.workId, value.rowId, value.variantId].some((entry) => entry === null)) {
    fail(
      "CONTROLLER_PROTOCOL_COORDINATE_SCOPE",
      "work operation has an incomplete coordinate scope",
    );
  }
  assertIdentifier(value.workId, "controller request coordinate.workId");
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("CONTROLLER_PROTOCOL_COORDINATE", "controller request coordinate.rowId is invalid");
  }
  assertIdentifier(value.variantId, "controller request coordinate.variantId");
  if (hardCutOperationKinds.has(operationKind)) {
    assertPositiveInteger(value.repetition, "controller request coordinate.repetition");
  } else if (operationKind === "scenario-action" && value.repetition !== null) {
    assertPositiveInteger(value.repetition, "controller request coordinate.repetition");
  } else if (value.repetition !== null) {
    fail(
      "CONTROLLER_PROTOCOL_COORDINATE_SCOPE",
      "non-repeated work operation must not carry a repetition",
    );
  }
  return value;
}

function validateOperation(value) {
  assertExactKeys(value, ["operationId", "kind", "sequence"], "controller request operation");
  assertIdentifier(value.operationId, "controller request operation.operationId");
  if (!CONTROLLER_OPERATION_KINDS.includes(value.kind)) {
    fail("CONTROLLER_PROTOCOL_OPERATION", "controller request operation.kind is invalid");
  }
  assertPositiveInteger(value.sequence, "controller request operation.sequence");
  return value;
}

function validateControllerRequestPayload(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest ? [...requestDraftKeys, "requestSha256"] : requestDraftKeys,
    "controller request",
  );
  if (
    value.schemaVersion !== CONTROLLER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== CONTROLLER_REQUEST_KIND ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256
  ) {
    fail("CONTROLLER_PROTOCOL_REQUEST_BINDING", "controller request campaign binding is invalid");
  }
  for (const [key, label] of [
    ["manifestSha256", "manifestSha256"],
    ["candidateSha256", "candidateSha256"],
    ["runPlanSha256", "runPlanSha256"],
    ["runAuthorizationSha256", "runAuthorizationSha256"],
    ["intentSha256", "intentSha256"],
    ["controllerIdentitySha256", "controllerIdentitySha256"],
  ]) {
    assertSha256(value[key], `controller request ${label}`);
  }
  validateOperation(value.operation);
  if (value.operation.kind === "run-authorization-claim") {
    if (value.runAuthorizationClaimSha256 !== null) {
      fail(
        "CONTROLLER_PROTOCOL_AUTHORIZATION_CLAIM",
        "run-authorization claim request must not bind a prior claim",
      );
    }
  } else {
    assertSha256(
      value.runAuthorizationClaimSha256,
      "controller request runAuthorizationClaimSha256",
    );
  }
  validateCoordinate(value.coordinate, value.operation.kind);
  validateContentAddressedReference(value.payload, "controller request payload");
  if (includeDigest) assertSha256(value.requestSha256, "controller request requestSha256");
  return value;
}

function requestDigestPayload(value) {
  const includeDigest = exactObject(value) && Object.hasOwn(value, "requestSha256");
  validateControllerRequestPayload(value, includeDigest);
  const { requestSha256: _requestSha256, ...payload } = value;
  return payload;
}

export function deriveControllerRequestDigest(value) {
  return createHash("sha256")
    .update(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-controller-request.v1",
        request: requestDigestPayload(value),
      }),
      "utf8",
    )
    .digest("hex");
}

export function validateControllerRequest(value) {
  validateControllerRequestPayload(value, true);
  if (value.requestSha256 !== deriveControllerRequestDigest(value)) {
    fail("CONTROLLER_PROTOCOL_REQUEST_DIGEST", "controller request digest mismatch");
  }
  return freezeCanonical(value);
}

function validateArtifacts(value) {
  if (!Array.isArray(value) || value.length > 4096) {
    fail("CONTROLLER_PROTOCOL_ARTIFACT", "controller artifacts must be a bounded array");
  }
  let previous = null;
  for (const [index, artifact] of value.entries()) {
    validateContentAddressedReference(artifact, `controller artifact ${index}`);
    if (previous !== null && compareUtf8(previous, artifact.sha256) >= 0) {
      fail("CONTROLLER_PROTOCOL_ARTIFACT", "controller artifacts must be sorted and unique");
    }
    previous = artifact.sha256;
  }
  return value;
}

function decodeEd25519Signature(value) {
  if (typeof value !== "string" || !canonicalBase64Pattern.test(value)) {
    fail("CONTROLLER_PROTOCOL_SIGNATURE", "controller response signature is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    fail("CONTROLLER_PROTOCOL_SIGNATURE", "controller response signature is invalid");
  }
  return decoded;
}

function validateControllerResponsePayload(value, includeTerminalFields) {
  assertExactKeys(
    value,
    includeTerminalFields
      ? [...responseDraftKeys, "signatureBase64", "responseSha256"]
      : responseDraftKeys,
    "controller response",
  );
  if (
    value.schemaVersion !== CONTROLLER_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== CONTROLLER_RESPONSE_KIND ||
    value.campaignId !== PROBE_CAMPAIGN_ID
  ) {
    fail("CONTROLLER_PROTOCOL_RESPONSE_BINDING", "controller response campaign binding is invalid");
  }
  assertSha256(value.requestSha256, "controller response requestSha256");
  if (!CONTROLLER_RESPONSE_OUTCOMES.includes(value.outcome)) {
    fail("CONTROLLER_PROTOCOL_RESPONSE_OUTCOME", "controller response outcome is invalid");
  }
  validateContentAddressedReference(value.payload, "controller response payload");
  validateArtifacts(value.artifacts);
  if (value.artifacts.some((artifact) => artifact.sha256 === value.payload.sha256)) {
    fail(
      "CONTROLLER_PROTOCOL_ARTIFACT",
      "controller response payload cannot be duplicated as evidence",
    );
  }
  assertSha256(value.controllerIdentitySha256, "controller response controllerIdentitySha256");
  if (
    typeof value.controllerVersion !== "string" ||
    value.controllerVersion.length > 64 ||
    !exactVersionPattern.test(value.controllerVersion)
  ) {
    fail("CONTROLLER_PROTOCOL_VERSION", "controller response version is invalid");
  }
  assertSha256(value.controllerPublicKeySha256, "controller response controllerPublicKeySha256");
  if (value.signatureAlgorithm !== "Ed25519") {
    fail("CONTROLLER_PROTOCOL_SIGNATURE", "controller response signature algorithm is invalid");
  }
  if (includeTerminalFields) {
    decodeEd25519Signature(value.signatureBase64);
    assertSha256(value.responseSha256, "controller response responseSha256");
  }
  return value;
}

function responseDigestPayload(value) {
  const includeTerminalFields =
    exactObject(value) &&
    (Object.hasOwn(value, "signatureBase64") || Object.hasOwn(value, "responseSha256"));
  validateControllerResponsePayload(value, includeTerminalFields);
  const { signatureBase64: _signatureBase64, responseSha256: _responseSha256, ...payload } = value;
  return payload;
}

export function deriveControllerResponseDigest(value) {
  return createHash("sha256")
    .update(
      canonicalProbeJson({
        domain: "enduragent.windows-host-probe-controller-response.v1",
        response: responseDigestPayload(value),
      }),
      "utf8",
    )
    .digest("hex");
}

export function validateControllerResponse(value) {
  validateControllerResponsePayload(value, true);
  if (value.responseSha256 !== deriveControllerResponseDigest(value)) {
    fail("CONTROLLER_PROTOCOL_RESPONSE_DIGEST", "controller response digest mismatch");
  }
  return freezeCanonical(value);
}

function loadCanonicalEd25519PublicKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 4096) {
    fail("CONTROLLER_PROTOCOL_PUBLIC_KEY", "controller public key bytes are invalid");
  }
  const bytes = Buffer.from(value);
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    fail("CONTROLLER_PROTOCOL_PUBLIC_KEY", "controller public key is not SPKI DER");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(key.export({ format: "der", type: "spki" })).equals(bytes)
  ) {
    fail("CONTROLLER_PROTOCOL_PUBLIC_KEY", "controller public key is not canonical Ed25519");
  }
  return Object.freeze({ key, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}

export function verifyControllerResponse(value, options) {
  assertExactKeys(
    options,
    ["request", "controllerIdentitySha256", "controllerVersion", "controllerPublicKeyBytes"],
    "controller response verification options",
  );
  const request = validateControllerRequest(options.request);
  const response = validateControllerResponse(value);
  const publicKey = loadCanonicalEd25519PublicKey(options.controllerPublicKeyBytes);
  if (
    response.requestSha256 !== request.requestSha256 ||
    response.controllerIdentitySha256 !== options.controllerIdentitySha256 ||
    response.controllerIdentitySha256 !== request.controllerIdentitySha256 ||
    response.controllerVersion !== options.controllerVersion ||
    response.controllerPublicKeySha256 !== publicKey.sha256
  ) {
    fail("CONTROLLER_PROTOCOL_RESPONSE_AUTHORITY", "controller response authority differs");
  }
  if (
    !verify(
      null,
      Buffer.from(response.responseSha256, "hex"),
      publicKey.key,
      decodeEd25519Signature(response.signatureBase64),
    )
  ) {
    fail("CONTROLLER_PROTOCOL_RESPONSE_SIGNATURE", "controller response signature is invalid");
  }
  return response;
}
