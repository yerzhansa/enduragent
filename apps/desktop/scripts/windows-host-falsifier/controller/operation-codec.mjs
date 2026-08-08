import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { canonicalProbeJson } from "../probe-contract.mjs";
import { CONTROLLER_OPERATION_KINDS, CONTROLLER_RESPONSE_OUTCOMES } from "./protocol.mjs";

export const CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION = 1;
export const CONTROLLER_OPERATION_REQUEST_KIND = "windows-host-probe-controller-operation-request";
export const CONTROLLER_OPERATION_RESPONSE_KIND =
  "windows-host-probe-controller-operation-response";
export const CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const CONTROLLER_OPERATION_RESPONSE_MAXIMUM_BYTES = 16 * 1024 * 1024;

const intentDigestDomain = "enduragent.windows-host-probe-controller-operation-intent.v1";
const maximumJsonDepth = 64;
const maximumJsonNodes = 100_000;
const maximumArtifactBindings = 4096;
const maximumArtifactPathBytes = 4096;
const maximumArtifactPathSegmentBytes = 255;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const absolutePathPattern = /^(?:[\\/]|[A-Za-z]:[\\/]|file:(?:\/{0,2})[\\/])/iu;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const unsafeArtifactPathCharacterPattern = /[<>:"\\|?*]/u;
const windowsReservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const requestEnvelopeKeys = Object.freeze(["schemaVersion", "kind", "operationKind", "input"]);
const responseEnvelopeKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "operationKind",
  "result",
  "artifactBindings",
]);

export class ControllerOperationCodecError extends Error {
  constructor(code, message, { operationKind = null, outcome = null } = {}) {
    super(message);
    this.name = "ControllerOperationCodecError";
    this.code = code;
    this.operationKind = operationKind;
    this.outcome = outcome;
  }
}

function fail(code, message, details) {
  throw new ControllerOperationCodecError(code, message, details);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label, { requireDataFields = true } = {}) {
  if (!exactObject(value)) {
    fail("CONTROLLER_OPERATION_CODEC_OBJECT", `${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("CONTROLLER_OPERATION_CODEC_KEYS", `${label} has an invalid field set`);
  }
  const actual = ownKeys.sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("CONTROLLER_OPERATION_CODEC_KEYS", `${label} has an invalid field set`);
  }
  if (
    requireDataFields &&
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })
  ) {
    fail("CONTROLLER_OPERATION_CODEC_VALUE", `${label} fields must be enumerable data`);
  }
}

function assertOperationKind(value, label) {
  if (!CONTROLLER_OPERATION_KINDS.includes(value)) {
    fail("CONTROLLER_OPERATION_CODEC_OPERATION_KIND", `${label} is invalid`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_OPERATION_CODEC_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function base64ValueForKey(value, key) {
  return (
    typeof key === "string" &&
    key.endsWith("Base64") &&
    value.length % 4 === 0 &&
    canonicalBase64Pattern.test(value)
  );
}

function validateJsonValue(root, { rejectRequestPaths = false } = {}) {
  const ancestors = new WeakSet();
  const stack = [{ value: root, key: null, depth: 0, exiting: false }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.exiting) {
      ancestors.delete(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > maximumJsonNodes) {
      fail("CONTROLLER_OPERATION_CODEC_VALUE_BOUND", "JSON value has too many entries");
    }
    if (current.depth > maximumJsonDepth) {
      fail("CONTROLLER_OPERATION_CODEC_VALUE_BOUND", "JSON value is too deeply nested");
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (!isWellFormedString(value)) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON string contains an unpaired surrogate");
      }
      if (
        rejectRequestPaths &&
        !base64ValueForKey(value, current.key) &&
        absolutePathPattern.test(value)
      ) {
        fail(
          "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH",
          "controller operation input contains an absolute path",
        );
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "canonical JSON forbids non-finite numbers");
      }
      continue;
    }
    if (typeof value !== "object") {
      fail("CONTROLLER_OPERATION_CODEC_VALUE", "value is not JSON-safe");
    }
    if (ancestors.has(value)) {
      fail("CONTROLLER_OPERATION_CODEC_VALUE", "canonical JSON forbids cyclic values");
    }
    ancestors.add(value);
    stack.push({ ...current, exiting: true });

    if (Array.isArray(value)) {
      if (value.length > maximumJsonNodes) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE_BOUND", "JSON array has too many entries");
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(?:0|[1-9]\d*)$/u.test(key) ||
              !Object.hasOwn(value, Number(key))),
        )
      ) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON array is sparse or has extra fields");
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON array entries must be enumerable data");
        }
        stack.push({ value: descriptor.value, key: String(index), depth: current.depth + 1 });
      }
      continue;
    }

    if (!exactObject(value)) {
      fail("CONTROLLER_OPERATION_CODEC_VALUE", "canonical JSON forbids exotic objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__") {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON object has an unsafe field name");
      }
      if (!isWellFormedString(key)) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON field name contains an unpaired surrogate");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("CONTROLLER_OPERATION_CODEC_VALUE", "JSON object fields must be enumerable data");
      }
      if (rejectRequestPaths && key === "evidenceRoot") {
        fail(
          "CONTROLLER_OPERATION_CODEC_EVIDENCE_ROOT",
          "controller operation input must not contain evidenceRoot",
        );
      }
      if (rejectRequestPaths && absolutePathPattern.test(key)) {
        fail(
          "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH",
          "controller operation input contains an absolute path",
        );
      }
      stack.push({ value: descriptor.value, key, depth: current.depth + 1, exiting: false });
    }
  }
  return root;
}

function deepFreeze(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) stack.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function canonicalBytes(value, maximumBytes, label) {
  let text;
  try {
    text = canonicalProbeJson(value);
  } catch (error) {
    if (error instanceof ControllerOperationCodecError) throw error;
    fail("CONTROLLER_OPERATION_CODEC_VALUE", `${label} cannot be represented as canonical JSON`);
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    fail("CONTROLLER_OPERATION_CODEC_BYTES_BOUND", `${label} exceeds its byte bound`);
  }
  return bytes;
}

function parseCanonicalBytes(value, maximumBytes, label) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximumBytes) {
    fail(
      "CONTROLLER_OPERATION_CODEC_BYTES_BOUND",
      `${label} must be a non-empty bounded byte array`,
    );
  }
  const bytes = Buffer.from(value);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail("CONTROLLER_OPERATION_CODEC_UTF8", `${label} is not valid UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("CONTROLLER_OPERATION_CODEC_JSON", `${label} is not valid JSON`);
  }
  validateJsonValue(parsed);
  const canonical = canonicalBytes(parsed, maximumBytes, label);
  if (!canonical.equals(bytes)) {
    fail("CONTROLLER_OPERATION_CODEC_CANONICAL", `${label} is not canonical JSON`);
  }
  return { bytes, value: parsed };
}

function validateRequestEnvelope(value) {
  assertExactKeys(value, requestEnvelopeKeys, "controller operation request envelope");
  if (
    value.schemaVersion !== CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION ||
    value.kind !== CONTROLLER_OPERATION_REQUEST_KIND
  ) {
    fail(
      "CONTROLLER_OPERATION_CODEC_ENVELOPE",
      "controller operation request envelope binding is invalid",
    );
  }
  assertOperationKind(value.operationKind, "controller operation request operationKind");
  validateJsonValue(value.input, { rejectRequestPaths: true });
  return value;
}

function validateArtifactPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormedString(value) ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > maximumArtifactPathBytes ||
    value.includes("\\") ||
    absolutePathPattern.test(value)
  ) {
    fail("CONTROLLER_OPERATION_CODEC_ARTIFACT_PATH", `${label} is not a safe relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > maximumArtifactPathSegmentBytes ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint <= 0x1f || codePoint === 0x7f;
        }) ||
        unsafeArtifactPathCharacterPattern.test(segment) ||
        /[. ]$/u.test(segment) ||
        windowsReservedNamePattern.test(segment),
    )
  ) {
    fail("CONTROLLER_OPERATION_CODEC_ARTIFACT_PATH", `${label} is not a safe relative path`);
  }
  return value;
}

function validateArtifactBindings(value) {
  if (!Array.isArray(value) || value.length > maximumArtifactBindings) {
    fail("CONTROLLER_OPERATION_CODEC_ARTIFACT_BINDING", "artifactBindings must be a bounded array");
  }
  let previousPath = null;
  const foldedPaths = new Set();
  const sha256s = new Set();
  for (const [index, binding] of value.entries()) {
    assertExactKeys(binding, ["path", "sha256"], `artifactBindings[${index}]`);
    validateArtifactPath(binding.path, `artifactBindings[${index}].path`);
    assertSha256(binding.sha256, `artifactBindings[${index}].sha256`);
    if (previousPath !== null && compareUtf8(previousPath, binding.path) >= 0) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_ORDER",
        "artifactBindings must be strictly UTF-8 path sorted",
      );
    }
    const foldedPath = binding.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(foldedPath)) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_CASE_COLLISION",
        "artifactBindings contain a case collision",
      );
    }
    if (sha256s.has(binding.sha256)) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_BINDING",
        "one signed artifact cannot bind multiple paths",
      );
    }
    foldedPaths.add(foldedPath);
    sha256s.add(binding.sha256);
    previousPath = binding.path;
  }
  return value;
}

function validateResponseEnvelope(value) {
  assertExactKeys(value, responseEnvelopeKeys, "controller operation response envelope");
  if (
    value.schemaVersion !== CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION ||
    value.kind !== CONTROLLER_OPERATION_RESPONSE_KIND
  ) {
    fail(
      "CONTROLLER_OPERATION_CODEC_ENVELOPE",
      "controller operation response envelope binding is invalid",
    );
  }
  assertOperationKind(value.operationKind, "controller operation response operationKind");
  validateJsonValue(value.result);
  validateArtifactBindings(value.artifactBindings);
  return value;
}

function validateSignedArtifactReferences(value) {
  if (!Array.isArray(value) || value.length > maximumArtifactBindings) {
    fail(
      "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE",
      "signed response artifacts must be a bounded array",
    );
  }
  let previousSha256 = null;
  for (const [index, artifact] of value.entries()) {
    assertExactKeys(
      artifact,
      ["blobPath", "bytes", "sha256"],
      `signed response artifacts[${index}]`,
    );
    assertSha256(artifact.sha256, `signed response artifacts[${index}].sha256`);
    if (artifact.blobPath !== `blobs/sha256/${artifact.sha256}`) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE",
        "signed response artifact is not content-addressed",
      );
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE",
        "signed response artifact byte count is invalid",
      );
    }
    if (previousSha256 !== null && compareUtf8(previousSha256, artifact.sha256) >= 0) {
      fail(
        "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE",
        "signed response artifacts must be sorted and unique",
      );
    }
    previousSha256 = artifact.sha256;
  }
  return value;
}

function assertArtifactSetBinding(artifactBindings, artifacts) {
  const boundSha256s = artifactBindings.map((binding) => binding.sha256).sort(compareUtf8);
  const signedSha256s = artifacts.map((artifact) => artifact.sha256);
  if (
    boundSha256s.length !== signedSha256s.length ||
    boundSha256s.some((sha256, index) => sha256 !== signedSha256s[index])
  ) {
    fail(
      "CONTROLLER_OPERATION_CODEC_ARTIFACT_SET",
      "artifactBindings do not exactly match the signed response artifacts",
    );
  }
}

function requestIntentSha256(envelope) {
  return createHash("sha256")
    .update(
      canonicalProbeJson({
        domain: intentDigestDomain,
        request: envelope,
      }),
      "utf8",
    )
    .digest("hex");
}

function canonicalRequestResult(envelope) {
  validateRequestEnvelope(envelope);
  const bytes = canonicalBytes(
    envelope,
    CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES,
    "controller operation request",
  );
  const canonicalEnvelope = deepFreeze(JSON.parse(bytes.toString("utf8")));
  return Object.freeze({
    envelope: canonicalEnvelope,
    bytes,
    intentSha256: requestIntentSha256(canonicalEnvelope),
  });
}

function canonicalResponseResult(envelope) {
  validateResponseEnvelope(envelope);
  const bytes = canonicalBytes(
    envelope,
    CONTROLLER_OPERATION_RESPONSE_MAXIMUM_BYTES,
    "controller operation response",
  );
  const canonicalEnvelope = deepFreeze(JSON.parse(bytes.toString("utf8")));
  return Object.freeze({ envelope: canonicalEnvelope, bytes });
}

export function encodeControllerOperationRequest(value) {
  assertExactKeys(value, ["operationKind", "input"], "controller operation request input");
  assertOperationKind(value.operationKind, "controller operation request input.operationKind");
  return canonicalRequestResult({
    schemaVersion: CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION,
    kind: CONTROLLER_OPERATION_REQUEST_KIND,
    operationKind: value.operationKind,
    input: value.input,
  });
}

export function decodeControllerOperationRequest(bytes, options = {}) {
  const hasExpectedOperationKind =
    exactObject(options) && Object.hasOwn(options, "expectedOperationKind");
  assertExactKeys(
    options,
    hasExpectedOperationKind ? ["expectedOperationKind"] : [],
    "controller operation request decode options",
    { requireDataFields: false },
  );
  const expectedOperationKind = hasExpectedOperationKind
    ? options.expectedOperationKind
    : undefined;
  if (hasExpectedOperationKind) {
    assertOperationKind(
      expectedOperationKind,
      "controller operation request decode options.expectedOperationKind",
    );
  }
  const parsed = parseCanonicalBytes(
    bytes,
    CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES,
    "controller operation request",
  );
  validateRequestEnvelope(parsed.value);
  if (expectedOperationKind !== undefined && parsed.value.operationKind !== expectedOperationKind) {
    fail(
      "CONTROLLER_OPERATION_CODEC_OPERATION_MISMATCH",
      "controller operation request kind differs from the expected operation",
      { operationKind: parsed.value.operationKind },
    );
  }
  const envelope = deepFreeze(parsed.value);
  return Object.freeze({
    envelope,
    bytes: parsed.bytes,
    intentSha256: requestIntentSha256(envelope),
  });
}

export function encodeControllerOperationResponse(value) {
  assertExactKeys(
    value,
    ["operationKind", "result", "artifactBindings"],
    "controller operation response input",
  );
  assertOperationKind(value.operationKind, "controller operation response input.operationKind");
  return canonicalResponseResult({
    schemaVersion: CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION,
    kind: CONTROLLER_OPERATION_RESPONSE_KIND,
    operationKind: value.operationKind,
    result: value.result,
    artifactBindings: value.artifactBindings,
  });
}

export function decodeControllerOperationResponse(bytes, options) {
  assertExactKeys(
    options,
    ["expectedOperationKind", "outcome", "artifacts"],
    "controller operation response decode options",
    { requireDataFields: false },
  );
  const expectedOperationKind = assertOperationKind(
    options.expectedOperationKind,
    "controller operation response decode options.expectedOperationKind",
  );
  const outcome = options.outcome;
  if (!CONTROLLER_RESPONSE_OUTCOMES.includes(outcome)) {
    fail(
      "CONTROLLER_OPERATION_CODEC_RESPONSE_OUTCOME",
      "signed controller response outcome is invalid",
      { operationKind: expectedOperationKind },
    );
  }
  if (outcome !== "SUCCEEDED") {
    fail(
      "CONTROLLER_OPERATION_CODEC_RESPONSE_OUTCOME",
      "signed controller response did not succeed",
      { operationKind: expectedOperationKind, outcome },
    );
  }

  const parsed = parseCanonicalBytes(
    bytes,
    CONTROLLER_OPERATION_RESPONSE_MAXIMUM_BYTES,
    "controller operation response",
  );
  validateResponseEnvelope(parsed.value);
  if (parsed.value.operationKind !== expectedOperationKind) {
    fail(
      "CONTROLLER_OPERATION_CODEC_OPERATION_MISMATCH",
      "controller operation response kind differs from the expected operation",
      { operationKind: parsed.value.operationKind, outcome },
    );
  }
  const artifacts = validateSignedArtifactReferences(options.artifacts);
  assertArtifactSetBinding(parsed.value.artifactBindings, artifacts);
  return Object.freeze({ envelope: deepFreeze(parsed.value), bytes: parsed.bytes });
}
