import { Buffer } from "node:buffer";
import { createHash, createPrivateKey } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalProbeJson } from "../probe-contract.mjs";
import { validateProbeRunAuthorizationClaimReceipt } from "../probe-run-authorization.mjs";
import {
  decodeControllerOperationRequest,
  decodeControllerOperationResponse,
} from "./operation-codec.mjs";
import {
  CONTROLLER_RESPONSE_KIND,
  deriveControllerResponseDigest,
  validateControllerRequest,
  validateControllerResponse,
  verifyControllerResponse,
} from "./protocol.mjs";

export const CONTROLLER_SPOOL_SCHEMA_VERSION = 1;
export const CONTROLLER_SPOOL_MECHANISM = "same-filesystem-hardlink-publication-v1";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const requestLeafPattern = /^([a-f0-9]{64})\.json$/u;
const responseOutcomes = new Set(["FAILED", "INCONCLUSIVE", "SUCCEEDED"]);
const secretTextPatterns = Object.freeze([
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/iu,
  /"(?:api[_-]?key|credential|password|private[_-]?key|secret|token)"\s*:/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
]);

export class ControllerSpoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControllerSpoolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerSpoolError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = [], label = "value") {
  if (!exactObject(value)) fail("CONTROLLER_SPOOL_SCHEMA", `${label} must be a plain object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      fail("CONTROLLER_SPOOL_SCHEMA", `${label} has an unexpected key: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("CONTROLLER_SPOOL_SCHEMA", `${label} is missing key: ${key}`);
    }
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTROLLER_SPOOL_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireStore(value, label) {
  if (!exactObject(value) || typeof value.root !== "string" || value.root.length === 0) {
    fail("CONTROLLER_SPOOL_STORE", `${label} must be an evidence store`);
  }
  for (const method of [
    "createDirectory",
    "writeBytes",
    "readArtifact",
    "list",
    "assertRootStable",
  ]) {
    if (typeof value[method] !== "function") {
      fail("CONTROLLER_SPOOL_STORE", `${label} is missing ${method}`);
    }
  }
  return value;
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    fail("CONTROLLER_SPOOL_BYTES", `${label} must be bytes`);
  }
  return Buffer.from(value);
}

function validateForbiddenValues(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) {
    fail("CONTROLLER_SPOOL_SECRET_POLICY", "forbidden values must be a bounded array");
  }
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length < 8 || entry.length > 4096) {
      fail("CONTROLLER_SPOOL_SECRET_POLICY", "forbidden values are invalid");
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return Object.freeze(result);
}

function encodedForbiddenValues(value) {
  const utf8 = Buffer.from(value, "utf8");
  const utf16LittleEndian = Buffer.from(value, "utf16le");
  const utf16BigEndian = Buffer.from(utf16LittleEndian);
  utf16BigEndian.swap16();
  return [
    utf8,
    utf16LittleEndian,
    utf16BigEndian,
    Buffer.from(utf8.toString("base64"), "ascii"),
    Buffer.from(utf8.toString("hex"), "ascii"),
  ];
}

function parsesAsPrivateKey(bytes) {
  const attempts = [
    () => createPrivateKey(bytes),
    () => createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }),
    () => createPrivateKey({ key: bytes, format: "der", type: "pkcs1" }),
    () => createPrivateKey({ key: bytes, format: "der", type: "sec1" }),
  ];
  return attempts.some((attempt) => {
    try {
      attempt();
      return true;
    } catch {
      return false;
    }
  });
}

export function assertControllerSpoolBytesSafe(value, options = {}) {
  assertExactKeys(options, [], ["forbiddenValues"], "spool byte policy");
  const bytes = requireBytes(value, "spool payload");
  const forbiddenValues = validateForbiddenValues(options.forbiddenValues);
  const utf8 = bytes.toString("utf8");
  if (
    secretTextPatterns.some((pattern) => pattern.test(utf8)) ||
    forbiddenValues.some((entry) =>
      encodedForbiddenValues(entry).some((encoded) => bytes.includes(encoded)),
    ) ||
    parsesAsPrivateKey(bytes)
  ) {
    fail("CONTROLLER_SPOOL_SECRET_MATERIAL", "spool payload contains prohibited material");
  }
  return bytes;
}

function contentReference(bytes) {
  const digest = sha256(bytes);
  return Object.freeze({
    blobPath: `blobs/sha256/${digest}`,
    bytes: bytes.length,
    sha256: digest,
  });
}

function requireReference(value, label) {
  assertExactKeys(value, ["blobPath", "bytes", "sha256"], [], label);
  requireSha256(value.sha256, `${label}.sha256`);
  if (
    value.blobPath !== `blobs/sha256/${value.sha256}` ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    fail("CONTROLLER_SPOOL_REFERENCE", `${label} is invalid`);
  }
  return value;
}

function parseCanonicalObject(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("CONTROLLER_SPOOL_CANONICAL", `${label} is not UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("CONTROLLER_SPOOL_CANONICAL", `${label} is not JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== text) {
    fail("CONTROLLER_SPOOL_CANONICAL", `${label} is not exact canonical JSON`);
  }
  return value;
}

async function publishExact(store, path, bytes, label) {
  await store.assertRootStable();
  try {
    const retained = await store.writeBytes(path, bytes);
    if (retained.path !== path || retained.sha256 !== sha256(bytes)) {
      fail("CONTROLLER_SPOOL_PUBLICATION", `${label} publication acknowledgment differs`);
    }
    return retained;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(path);
    if (
      retained.path !== path ||
      retained.size !== bytes.length ||
      retained.sha256 !== sha256(bytes) ||
      !retained.bytes.equals(bytes)
    ) {
      fail("CONTROLLER_SPOOL_COLLISION", `${label} replay differs`);
    }
    return Object.freeze({ path, sha256: retained.sha256 });
  }
}

async function readReference(store, reference, label) {
  requireReference(reference, `${label} reference`);
  await store.assertRootStable();
  const retained = await store.readArtifact(reference.blobPath);
  if (
    retained.path !== reference.blobPath ||
    retained.size !== reference.bytes ||
    retained.sha256 !== reference.sha256 ||
    sha256(retained.bytes) !== reference.sha256
  ) {
    fail("CONTROLLER_SPOOL_ARTIFACT", `${label} differs from its content reference`);
  }
  return Buffer.from(retained.bytes);
}

async function createDirectoryIfAbsent(store, path) {
  try {
    await store.createDirectory(path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export async function initializeControllerSpoolStores(options) {
  assertExactKeys(options, ["inboxStore", "outboxStore"], [], "spool initialization");
  const inboxStore = requireStore(options.inboxStore, "inboxStore");
  const outboxStore = requireStore(options.outboxStore, "outboxStore");
  if (inboxStore.root === outboxStore.root) {
    fail("CONTROLLER_SPOOL_ROOT", "inbox and outbox must have distinct ACL roots");
  }
  for (const store of [inboxStore, outboxStore]) {
    await store.assertRootStable();
    await createDirectoryIfAbsent(store, "blobs");
    await createDirectoryIfAbsent(store, "blobs/sha256");
  }
  await createDirectoryIfAbsent(inboxStore, "requests");
  await createDirectoryIfAbsent(outboxStore, "responses");
  return Object.freeze({
    schemaVersion: CONTROLLER_SPOOL_SCHEMA_VERSION,
    kind: "windows-host-probe-controller-spool-initialized",
    mechanism: CONTROLLER_SPOOL_MECHANISM,
  });
}

function validateClientOptions(options) {
  assertExactKeys(
    options,
    [
      "inboxStore",
      "outboxStore",
      "controllerIdentitySha256",
      "controllerVersion",
      "controllerPublicKeyBytes",
    ],
    ["forbiddenValues", "monotonicNow", "pollIntervalMs", "responseTimeoutMs"],
    "spool client options",
  );
  const inboxStore = requireStore(options.inboxStore, "inboxStore");
  const outboxStore = requireStore(options.outboxStore, "outboxStore");
  if (inboxStore.root === outboxStore.root) {
    fail("CONTROLLER_SPOOL_ROOT", "inbox and outbox must have distinct ACL roots");
  }
  requireSha256(options.controllerIdentitySha256, "controllerIdentitySha256");
  if (typeof options.controllerVersion !== "string" || options.controllerVersion.length === 0) {
    fail("CONTROLLER_SPOOL_AUTHORITY", "controllerVersion must be non-empty");
  }
  const controllerPublicKeyBytes = requireBytes(
    options.controllerPublicKeyBytes,
    "controllerPublicKeyBytes",
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  if (typeof monotonicNow !== "function") {
    fail("CONTROLLER_SPOOL_CLOCK", "monotonicNow must be a function");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const responseTimeoutMs = options.responseTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    fail("CONTROLLER_SPOOL_TIMEOUT", "pollIntervalMs must be between 1 and 1000");
  }
  if (
    !Number.isSafeInteger(responseTimeoutMs) ||
    responseTimeoutMs < pollIntervalMs ||
    responseTimeoutMs > 3_600_000
  ) {
    fail("CONTROLLER_SPOOL_TIMEOUT", "responseTimeoutMs is invalid");
  }
  return Object.freeze({
    inboxStore,
    outboxStore,
    controllerIdentitySha256: options.controllerIdentitySha256,
    controllerVersion: options.controllerVersion,
    controllerPublicKeyBytes,
    forbiddenValues: validateForbiddenValues(options.forbiddenValues),
    monotonicNow,
    pollIntervalMs,
    responseTimeoutMs,
  });
}

function monotonicSample(clock, previous) {
  const current = clock();
  if (typeof current !== "number" || !Number.isFinite(current) || current < 0) {
    fail("CONTROLLER_SPOOL_CLOCK", "monotonic clock returned an invalid sample");
  }
  if (previous !== null && current < previous) {
    fail("CONTROLLER_SPOOL_CLOCK", "monotonic clock regressed");
  }
  return current;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createControllerSpoolClient(options) {
  const config = validateClientOptions(options);
  return Object.freeze({
    async exchange(input) {
      assertExactKeys(input, ["request", "payloadBytes"], ["signal"], "spool exchange");
      const request = validateControllerRequest(input.request);
      if (request.controllerIdentitySha256 !== config.controllerIdentitySha256) {
        fail("CONTROLLER_SPOOL_AUTHORITY", "request selects another controller identity");
      }
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
        fail("CONTROLLER_SPOOL_ABORT", "signal must be an AbortSignal");
      }
      if (input.signal?.aborted) {
        fail("CONTROLLER_SPOOL_ABORT", "controller exchange was aborted before publication");
      }
      const payloadBytes = assertControllerSpoolBytesSafe(input.payloadBytes, {
        forbiddenValues: config.forbiddenValues,
      });
      const payload = contentReference(payloadBytes);
      if (canonicalProbeJson(payload) !== canonicalProbeJson(request.payload)) {
        fail("CONTROLLER_SPOOL_PAYLOAD", "request payload reference differs from its bytes");
      }
      const requestBytes = assertControllerSpoolBytesSafe(
        Buffer.from(canonicalProbeJson(request), "utf8"),
        { forbiddenValues: config.forbiddenValues },
      );
      await publishExact(
        config.inboxStore,
        request.payload.blobPath,
        payloadBytes,
        "request payload",
      );
      await publishExact(
        config.inboxStore,
        `requests/${request.requestSha256}.json`,
        requestBytes,
        "request envelope",
      );

      const started = monotonicSample(config.monotonicNow, null);
      let previous = started;
      while (true) {
        if (input.signal?.aborted) {
          fail("CONTROLLER_SPOOL_ABORT", "controller exchange was aborted");
        }
        try {
          const envelope = await config.outboxStore.readArtifact(
            `responses/${request.requestSha256}.json`,
          );
          const response = verifyControllerResponse(
            parseCanonicalObject(envelope.bytes, "controller response"),
            {
              request,
              controllerIdentitySha256: config.controllerIdentitySha256,
              controllerVersion: config.controllerVersion,
              controllerPublicKeyBytes: config.controllerPublicKeyBytes,
            },
          );
          const responsePayloadBytes = await readReference(
            config.outboxStore,
            response.payload,
            "response payload",
          );
          const artifacts = [];
          for (const reference of response.artifacts) {
            artifacts.push(
              Object.freeze({
                reference,
                bytes: await readReference(config.outboxStore, reference, "response artifact"),
              }),
            );
          }
          return Object.freeze({ response, payloadBytes: responsePayloadBytes, artifacts });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const current = monotonicSample(config.monotonicNow, previous);
        previous = current;
        if (current - started >= config.responseTimeoutMs) {
          fail("CONTROLLER_SPOOL_TIMEOUT", "controller response deadline expired");
        }
        await delay(config.pollIntervalMs);
      }
    },
  });
}

function validateServerOptions(options) {
  assertExactKeys(
    options,
    ["inboxStore", "outboxStore", "journal", "handler", "signResponseDigest"],
    ["forbiddenValues"],
    "spool server options",
  );
  const inboxStore = requireStore(options.inboxStore, "inboxStore");
  const outboxStore = requireStore(options.outboxStore, "outboxStore");
  if (inboxStore.root === outboxStore.root) {
    fail("CONTROLLER_SPOOL_ROOT", "inbox and outbox must have distinct ACL roots");
  }
  if (!exactObject(options.journal)) {
    fail("CONTROLLER_SPOOL_JOURNAL", "journal must be a controller journal");
  }
  for (const method of [
    "claimOperation",
    "retainBlob",
    "readBlob",
    "completeOperation",
    "scan",
    "assertRootStable",
  ]) {
    if (typeof options.journal[method] !== "function") {
      fail("CONTROLLER_SPOOL_JOURNAL", `journal is missing ${method}`);
    }
  }
  if (typeof options.handler !== "function" || typeof options.signResponseDigest !== "function") {
    fail("CONTROLLER_SPOOL_HANDLER", "handler and signResponseDigest must be functions");
  }
  return Object.freeze({
    inboxStore,
    outboxStore,
    journal: options.journal,
    handler: options.handler,
    signResponseDigest: options.signResponseDigest,
    forbiddenValues: validateForbiddenValues(options.forbiddenValues),
  });
}

function validateHandlerResult(value, forbiddenValues) {
  assertExactKeys(
    value,
    ["outcome", "payloadBytes", "artifactBytes"],
    [],
    "controller operation result",
  );
  if (!responseOutcomes.has(value.outcome)) {
    fail("CONTROLLER_SPOOL_HANDLER", "controller operation outcome is invalid");
  }
  const payloadBytes = assertControllerSpoolBytesSafe(value.payloadBytes, { forbiddenValues });
  if (!Array.isArray(value.artifactBytes) || value.artifactBytes.length > 4096) {
    fail("CONTROLLER_SPOOL_HANDLER", "controller operation artifacts are invalid");
  }
  const artifactBytes = value.artifactBytes.map((bytes) =>
    assertControllerSpoolBytesSafe(bytes, { forbiddenValues }),
  );
  return Object.freeze({ outcome: value.outcome, payloadBytes, artifactBytes });
}

function deriveIssuedAuthorizationClaim({
  request,
  requestPayloadBytes,
  handled,
  artifacts,
  authority,
}) {
  if (request.operation.kind !== "run-authorization-claim" || handled.outcome !== "SUCCEEDED") {
    return null;
  }
  const decodedRequest = decodeControllerOperationRequest(requestPayloadBytes, {
    expectedOperationKind: request.operation.kind,
  });
  if (decodedRequest.intentSha256 !== request.intentSha256) {
    fail("CONTROLLER_SPOOL_INTENT", "authorization claim request intent differs from its payload");
  }
  const decodedResponse = decodeControllerOperationResponse(handled.payloadBytes, {
    expectedOperationKind: request.operation.kind,
    outcome: handled.outcome,
    artifacts,
  });
  const receipt = validateProbeRunAuthorizationClaimReceipt(decodedResponse.envelope.result);
  const evidenceRootObjectIdentitySha256 =
    decodedRequest.envelope.input?.evidenceRootObjectIdentitySha256;
  if (
    receipt.campaignId !== request.campaignId ||
    receipt.manifestSha256 !== request.manifestSha256 ||
    receipt.runPlanSha256 !== request.runPlanSha256 ||
    receipt.candidateSha256 !== request.candidateSha256 ||
    receipt.campaignRunId !== request.coordinate.campaignRunId ||
    receipt.environmentId !== request.coordinate.environmentId ||
    receipt.evidenceRootObjectIdentitySha256 !== evidenceRootObjectIdentitySha256 ||
    receipt.authorizationSha256 !== request.runAuthorizationSha256 ||
    receipt.controllerIdentitySha256 !== authority.controllerIdentitySha256 ||
    receipt.controllerPublicKeySha256 !== authority.controllerPublicKeySha256 ||
    receipt.controllerVersion !== authority.controllerVersion
  ) {
    fail(
      "CONTROLLER_SPOOL_AUTHORIZATION_CLAIM",
      "authorization claim receipt differs from its controller request",
    );
  }
  return receipt.receiptSha256;
}

function requireCanonicalSignature(value) {
  if (typeof value !== "string" || !canonicalBase64Pattern.test(value)) {
    fail("CONTROLLER_SPOOL_SIGNATURE", "controller signature is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    fail("CONTROLLER_SPOOL_SIGNATURE", "controller signature is invalid");
  }
  return value;
}

async function publishCompletedResponse(config, record) {
  if (record.state !== "complete" || record.response === null) {
    fail("CONTROLLER_SPOOL_JOURNAL", "controller operation is not complete");
  }
  const references = [record.response.payload, ...record.response.artifacts];
  for (const reference of references) {
    const bytes = await config.journal.readBlob(reference);
    await publishExact(config.outboxStore, reference.blobPath, bytes, "response blob");
  }
  await publishExact(
    config.outboxStore,
    `responses/${record.request.requestSha256}.json`,
    Buffer.from(canonicalProbeJson(record.response), "utf8"),
    "response envelope",
  );
  return Object.freeze({
    requestSha256: record.request.requestSha256,
    responseSha256: record.response.responseSha256,
  });
}

export async function createControllerSpoolServer(options) {
  const config = validateServerOptions(options);
  const initialAuthority = await config.journal.scan();
  let operationTail = Promise.resolve();

  async function serialize(operation) {
    let release;
    const turn = new Promise((resolve) => {
      release = resolve;
    });
    const previous = operationTail;
    operationTail = turn;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function processRequest(requestSha256) {
    return serialize(async () => {
      requireSha256(requestSha256, "requestSha256");
      await config.inboxStore.assertRootStable();
      await config.outboxStore.assertRootStable();
      await config.journal.assertRootStable();
      const envelope = await config.inboxStore.readArtifact(`requests/${requestSha256}.json`);
      const request = validateControllerRequest(
        parseCanonicalObject(envelope.bytes, "controller request"),
      );
      if (request.requestSha256 !== requestSha256) {
        fail("CONTROLLER_SPOOL_REQUEST", "request filename differs from its digest");
      }
      const payloadBytes = assertControllerSpoolBytesSafe(
        await readReference(config.inboxStore, request.payload, "request payload"),
        { forbiddenValues: config.forbiddenValues },
      );
      const retainedRequestPayload = await config.journal.retainBlob(payloadBytes);
      if (canonicalProbeJson(retainedRequestPayload) !== canonicalProbeJson(request.payload)) {
        fail("CONTROLLER_SPOOL_JOURNAL", "journal retained another request payload");
      }
      const claim = await config.journal.claimOperation(request);
      if (claim.record.state === "complete") {
        const published = await publishCompletedResponse(config, claim.record);
        return Object.freeze({ ...published, recovered: true, handlerInvoked: false });
      }

      const handled = validateHandlerResult(
        await config.handler(
          Object.freeze({
            request,
            payloadBytes: Buffer.from(payloadBytes),
            recoveryRequired: !claim.created,
          }),
        ),
        config.forbiddenValues,
      );
      const responsePayload = await config.journal.retainBlob(handled.payloadBytes);
      const retainedArtifacts = [];
      const artifactDigests = new Set([responsePayload.sha256]);
      for (const bytes of handled.artifactBytes) {
        const reference = await config.journal.retainBlob(bytes);
        if (artifactDigests.has(reference.sha256)) {
          fail("CONTROLLER_SPOOL_HANDLER", "controller response blobs are duplicated");
        }
        artifactDigests.add(reference.sha256);
        retainedArtifacts.push(reference);
      }
      retainedArtifacts.sort((left, right) =>
        Buffer.from(left.sha256, "utf8").compare(Buffer.from(right.sha256, "utf8")),
      );
      const authority = await config.journal.scan();
      if (
        authority.controllerIdentitySha256 !== initialAuthority.controllerIdentitySha256 ||
        authority.controllerPublicKeySha256 !== initialAuthority.controllerPublicKeySha256 ||
        authority.controllerVersion !== initialAuthority.controllerVersion
      ) {
        fail("CONTROLLER_SPOOL_AUTHORITY", "controller journal authority changed");
      }
      const issuedAuthorizationClaimSha256 = deriveIssuedAuthorizationClaim({
        request,
        requestPayloadBytes: payloadBytes,
        handled,
        artifacts: retainedArtifacts,
        authority,
      });
      const draft = {
        schemaVersion: 1,
        kind: CONTROLLER_RESPONSE_KIND,
        campaignId: request.campaignId,
        requestSha256: request.requestSha256,
        outcome: handled.outcome,
        payload: responsePayload,
        artifacts: retainedArtifacts,
        controllerIdentitySha256: authority.controllerIdentitySha256,
        controllerVersion: authority.controllerVersion,
        controllerPublicKeySha256: authority.controllerPublicKeySha256,
        signatureAlgorithm: "Ed25519",
      };
      const responseSha256 = deriveControllerResponseDigest(draft);
      const signatureBase64 = requireCanonicalSignature(
        await config.signResponseDigest(
          Object.freeze({ responseSha256, request, responseDraft: Object.freeze(draft) }),
        ),
      );
      const response = validateControllerResponse({
        ...draft,
        signatureBase64,
        responseSha256,
      });
      const completed = await config.journal.completeOperation({
        request,
        response,
        issuedAuthorizationClaimSha256,
      });
      const published = await publishCompletedResponse(config, completed);
      return Object.freeze({
        ...published,
        recovered: !claim.created,
        handlerInvoked: true,
      });
    });
  }

  async function processPending() {
    const entries = await config.inboxStore.list("requests");
    const requestDigests = [];
    for (const entry of entries) {
      const match = requestLeafPattern.exec(entry.name);
      if (entry.kind !== "file" || match === null) {
        fail("CONTROLLER_SPOOL_REQUEST_TREE", "request tree contains an invalid object");
      }
      requestDigests.push(match[1]);
    }
    requestDigests.sort();
    const results = [];
    for (const requestSha256 of requestDigests) {
      results.push(await processRequest(requestSha256));
    }
    return Object.freeze(results);
  }

  return Object.freeze({ processRequest, processPending });
}
