import {
  canonicalProbeJson,
  createExternalCheckpointReplayRegistry,
  deriveProbeContinuationScopeDigest,
  validateExternalCheckpointEvidence,
} from "./probe-contract.mjs";
import { hashEvidenceValue } from "./evidence-store.mjs";

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const rowIdPattern = /^F-\d{2}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const strictIsoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const entryNamePattern = /^(\d{8})\.json$/u;
const digestFilePattern = /^([a-f0-9]{64})\.json$/u;
const forbiddenPayloadKeys = new Set([
  "mechanismId",
  "observations",
  "outcome",
  "selectedMechanism",
  "status",
  "unavailability",
  "verificationMetrics",
  "verifierId",
]);

export class ContinuationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContinuationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContinuationError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, label) {
  if (!exactObject(value)) fail("CONTINUATION_SCHEMA", `${label} must be an object`);
  const expected = [...required].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expected) {
    fail("CONTINUATION_SCHEMA", `${label} shape is invalid`);
  }
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value) || value.length > 128) {
    fail("CONTINUATION_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
  return value;
}

function requireRowId(value) {
  if (typeof value !== "string" || !rowIdPattern.test(value)) {
    fail("CONTINUATION_ROW", "rowId must use the canonical F-nn form");
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CONTINUATION_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictIsoUtc.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("CONTINUATION_TIMESTAMP", `${label} must be strict UTC ISO milliseconds`);
  }
  return value;
}

function requireRepetition(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    fail("CONTINUATION_REPETITION", "repetition must be a bounded positive integer");
  }
  return value;
}

function requirePayload(value) {
  if (!exactObject(value)) fail("CONTINUATION_PAYLOAD", "continuation payload must be an object");
  for (const key of Object.keys(value)) {
    if (forbiddenPayloadKeys.has(key)) {
      fail("CONTINUATION_TRUST", `continuation payload cannot assert ${key}`);
    }
  }
  return value;
}

function headerDigestPayload(value) {
  const { headerSha256: _headerSha256, ...payload } = value;
  return payload;
}

function entryDigestPayload(value) {
  const { entrySha256: _entrySha256, ...payload } = value;
  return payload;
}

function receiptDigestPayload(value) {
  const { receiptSha256: _receiptSha256, ...payload } = value;
  return payload;
}

function externalMarkerDigestPayload(value) {
  const { markerSha256: _markerSha256, ...payload } = value;
  return payload;
}

function externalReceiptTransactionDigestPayload(value) {
  const { transactionSha256: _transactionSha256, ...payload } = value;
  return payload;
}

function canonicalValuesEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function parseCanonical(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CONTINUATION_JSON", `${label} is not JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== bytes.toString("utf8")) {
    fail("CONTINUATION_CANONICAL", `${label} is not canonical JSON`);
  }
  return value;
}

function chainPath(chainId, suffix) {
  requireIdentifier(chainId, "chainId");
  return `continuations/chains/${chainId}/${suffix}`;
}

async function createDirectoryIfAbsent(store, relativePath) {
  try {
    await store.createDirectory(relativePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function validateScopeFields(value) {
  if (value.campaignId !== "f01-f10-native-probe-v1") {
    fail("CONTINUATION_CAMPAIGN", "continuation campaign is not the frozen PR-01b campaign");
  }
  requireSha256(value.manifestSha256, "manifestSha256");
  requireSha256(value.candidateSha256, "candidateSha256");
  requireSha256(value.labAttestationSha256, "labAttestationSha256");
  requireIdentifier(value.campaignRunId, "campaignRunId");
  requireIdentifier(value.executionRunId, "executionRunId");
  requireIdentifier(value.executionBundleId, "executionBundleId");
  requireSha256(value.executionBundleManifestSha256, "executionBundleManifestSha256");
  requireIdentifier(value.environmentId, "environmentId");
  requireIdentifier(value.pathProfileId, "pathProfileId");
  requireRowId(value.rowId);
  requireIdentifier(value.variantId, "variantId");
  requireIdentifier(value.attemptId, "attemptId");
  requireIdentifier(value.vmSnapshotId, "vmSnapshotId");
  requireRepetition(value.repetition);
  requireIdentifier(value.chainId, "chainId");
}

function scopeFromHeader(value) {
  return {
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    candidateSha256: value.candidateSha256,
    campaignRunId: value.campaignRunId,
    executionRunId: value.executionRunId,
    executionBundleId: value.executionBundleId,
    executionBundleManifestSha256: value.executionBundleManifestSha256,
    environmentId: value.environmentId,
    pathProfileId: value.pathProfileId,
    rowId: value.rowId,
    variantId: value.variantId,
    attemptId: value.attemptId,
    repetition: value.repetition,
    chainId: value.chainId,
  };
}

function validateHeader(value) {
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
      "executionBundleManifestSha256",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "attemptId",
      "vmSnapshotId",
      "repetition",
      "chainId",
      "scopeSha256",
      "createdAt",
      "headerSha256",
    ],
    "continuation header",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-continuation") {
    fail("CONTINUATION_HEADER", "continuation header identity is invalid");
  }
  validateScopeFields(value);
  requireSha256(value.scopeSha256, "scopeSha256");
  requireTimestamp(value.createdAt, "createdAt");
  requireSha256(value.headerSha256, "headerSha256");
  if (value.scopeSha256 !== deriveProbeContinuationScopeDigest(scopeFromHeader(value))) {
    fail("CONTINUATION_SCOPE", "continuation header scope digest mismatch");
  }
  const expected = hashEvidenceValue(
    "enduragent.windows-host-probe-continuation-header.v1",
    headerDigestPayload(value),
  );
  if (value.headerSha256 !== expected) fail("CONTINUATION_HEADER_DIGEST", "header digest mismatch");
  return value;
}

function validateEntry(value, header, sequence, previousEntrySha256) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "chainId",
      "scopeSha256",
      "operationId",
      "sequence",
      "previousEntrySha256",
      "createdAt",
      "payload",
      "entrySha256",
    ],
    "continuation entry",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-continuation-entry") {
    fail("CONTINUATION_ENTRY", "continuation entry identity is invalid");
  }
  if (value.chainId !== header.chainId || value.scopeSha256 !== header.scopeSha256) {
    fail("CONTINUATION_BINDING", "continuation entry is bound to another scope");
  }
  requireIdentifier(value.operationId, "entry.operationId");
  if (value.sequence !== sequence || value.previousEntrySha256 !== previousEntrySha256) {
    fail("CONTINUATION_CHAIN", "continuation sequence or predecessor is invalid");
  }
  requireTimestamp(value.createdAt, "entry.createdAt");
  requirePayload(value.payload);
  requireSha256(value.entrySha256, "entry.entrySha256");
  const expected = hashEvidenceValue(
    "enduragent.windows-host-probe-continuation-entry.v1",
    entryDigestPayload(value),
  );
  if (value.entrySha256 !== expected) fail("CONTINUATION_ENTRY_DIGEST", "entry digest mismatch");
  return value;
}

function assertHeaderMatchesScope(header, scope) {
  const retainedScope = {};
  for (const key of Object.keys(scope)) retainedScope[key] = header[key];
  if (!canonicalValuesEqual(retainedScope, scope)) {
    fail("CONTINUATION_SCOPE_COLLISION", "continuation chain belongs to another exact scope");
  }
}

function continuationReference(chain, receiptSha256) {
  return Object.freeze({
    repetition: chain.header.repetition,
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    headerSha256: chain.header.headerSha256,
    terminalEntrySha256: chain.previousEntrySha256,
    receiptSha256,
  });
}

function retainedOperation(chain, operationId, payload) {
  const retained = chain.entries.find((entry) => entry.operationId === operationId);
  if (retained === undefined) return null;
  if (!canonicalValuesEqual(retained.payload, payload)) {
    fail(
      "CONTINUATION_OPERATION_COLLISION",
      "continuation operation id was already retained with another payload",
    );
  }
  return Object.freeze(retained);
}

function validateClosure(value, header, entries, terminalEntrySha256) {
  if (value.kind === "windows-host-probe-local-continuation-receipt") {
    assertExactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "chainId",
        "scopeSha256",
        "headerSha256",
        "terminalEntrySha256",
        "entryCount",
        "closedAt",
        "receiptSha256",
      ],
      "local continuation receipt",
    );
    if (
      value.schemaVersion !== 1 ||
      value.chainId !== header.chainId ||
      value.scopeSha256 !== header.scopeSha256 ||
      value.headerSha256 !== header.headerSha256 ||
      value.terminalEntrySha256 !== terminalEntrySha256 ||
      value.entryCount !== entries.length
    ) {
      fail("CONTINUATION_RECEIPT", "local continuation receipt binding is invalid");
    }
    requireTimestamp(value.closedAt, "receipt.closedAt");
    requireSha256(value.receiptSha256, "receipt.receiptSha256");
    const expected = hashEvidenceValue(
      "enduragent.windows-host-probe-local-continuation-receipt.v1",
      receiptDigestPayload(value),
    );
    if (value.receiptSha256 !== expected) {
      fail("CONTINUATION_RECEIPT", "local continuation receipt digest mismatch");
    }
    return value;
  }
  if (value.kind === "windows-host-probe-consumed-external-receipt") {
    assertExactKeys(
      value,
      [
        "schemaVersion",
        "kind",
        "chainId",
        "scopeSha256",
        "headerSha256",
        "terminalEntrySha256",
        "checkpointEvidence",
        "consumedAt",
        "markerSha256",
      ],
      "external continuation receipt",
    );
    if (
      value.schemaVersion !== 1 ||
      value.chainId !== header.chainId ||
      value.scopeSha256 !== header.scopeSha256 ||
      value.headerSha256 !== header.headerSha256 ||
      value.terminalEntrySha256 !== terminalEntrySha256
    ) {
      fail("CONTINUATION_RECEIPT", "external continuation receipt binding is invalid");
    }
    requireTimestamp(value.consumedAt, "receipt.consumedAt");
    requireSha256(value.checkpointEvidence?.receipt?.receiptSha256, "receipt.receiptSha256");
    requireSha256(value.markerSha256, "receipt.markerSha256");
    const expected = hashEvidenceValue(
      "enduragent.windows-host-probe-consumed-external-receipt.v1",
      externalMarkerDigestPayload(value),
    );
    if (value.markerSha256 !== expected) {
      fail("CONTINUATION_RECEIPT", "external continuation marker digest mismatch");
    }
    return value;
  }
  fail("CONTINUATION_RECEIPT", "continuation receipt identity is invalid");
}

function validateExternalReceiptTransaction(value, header, entries, terminalEntrySha256) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "chainId",
      "scopeSha256",
      "nonceSha256",
      "requestSha256",
      "receiptSha256",
      "marker",
      "transactionSha256",
    ],
    "external receipt transaction",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "windows-host-probe-external-receipt-transaction" ||
    value.chainId !== header.chainId ||
    value.scopeSha256 !== header.scopeSha256
  ) {
    fail("CONTINUATION_RECEIPT_TRANSACTION", "external receipt transaction binding is invalid");
  }
  requireSha256(value.nonceSha256, "transaction.nonceSha256");
  requireSha256(value.requestSha256, "transaction.requestSha256");
  requireSha256(value.receiptSha256, "transaction.receiptSha256");
  requireSha256(value.transactionSha256, "transaction.transactionSha256");
  const marker = validateClosure(value.marker, header, entries, terminalEntrySha256);
  if (
    marker.kind !== "windows-host-probe-consumed-external-receipt" ||
    marker.checkpointEvidence?.request?.nonceSha256 !== value.nonceSha256 ||
    marker.checkpointEvidence?.request?.requestSha256 !== value.requestSha256 ||
    marker.checkpointEvidence?.receipt?.receiptSha256 !== value.receiptSha256
  ) {
    fail("CONTINUATION_RECEIPT_TRANSACTION", "external receipt transaction tuple is invalid");
  }
  const expected = hashEvidenceValue(
    "enduragent.windows-host-probe-external-receipt-transaction.v1",
    externalReceiptTransactionDigestPayload(value),
  );
  if (value.transactionSha256 !== expected) {
    fail("CONTINUATION_RECEIPT_TRANSACTION", "external receipt transaction digest mismatch");
  }
  return value;
}

async function loadClosure(store, chainId, header, entries, terminalEntrySha256) {
  const listing = await store.list(chainPath(chainId, "receipts"));
  if (listing.length > 1 || listing.some((entry) => entry.kind !== "file")) {
    fail("CONTINUATION_RECEIPT", "continuation receipt directory is invalid");
  }
  if (listing.length === 0) return null;
  if (!new Set(["external.json", "local.json"]).has(listing[0].name)) {
    fail("CONTINUATION_RECEIPT", "continuation receipt name is invalid");
  }
  const artifact = await store.readArtifact(chainPath(chainId, `receipts/${listing[0].name}`));
  return validateClosure(
    parseCanonical(artifact.bytes, "continuation receipt"),
    header,
    entries,
    terminalEntrySha256,
  );
}

function receiptIndexMarker(transaction) {
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-receipt-index",
    transactionSha256: transaction.transactionSha256,
    chainId: transaction.chainId,
    scopeSha256: transaction.scopeSha256,
    nonceSha256: transaction.nonceSha256,
    requestSha256: transaction.requestSha256,
    receiptSha256: transaction.receiptSha256,
  };
}

async function replayRegistryFromStore(store, transaction = null) {
  const registry = createExternalCheckpointReplayRegistry();
  const expectedMarker = transaction === null ? null : receiptIndexMarker(transaction);
  for (const [directory, target, allowedDigest] of [
    ["continuations/receipt-index/nonces", registry.nonces, transaction?.nonceSha256],
    ["continuations/receipt-index/requests", registry.requests, transaction?.requestSha256],
    ["continuations/receipt-index/receipts", registry.receipts, transaction?.receiptSha256],
  ]) {
    const listing = await store.list(directory);
    for (const entry of listing) {
      if (entry.kind !== "file") fail("CONTINUATION_RECEIPT_INDEX", "receipt index is invalid");
      const match = digestFilePattern.exec(entry.name);
      if (match === null) fail("CONTINUATION_RECEIPT_INDEX", "receipt index name is invalid");
      if (match[1] === allowedDigest) {
        try {
          const artifact = await store.readArtifact(`${directory}/${entry.name}`);
          const retained = parseCanonical(artifact.bytes, "receipt index");
          if (!canonicalValuesEqual(retained, expectedMarker)) {
            fail("CONTINUATION_RECEIPT_REPLAY", "receipt index belongs to another transaction");
          }
        } catch (error) {
          if (error instanceof ContinuationError && error.code === "CONTINUATION_RECEIPT_REPLAY") {
            throw error;
          }
          fail("CONTINUATION_RECEIPT_REPLAY", "receipt index is not recoverable");
        }
        continue;
      }
      target.add(match[1]);
    }
  }
  return registry;
}

async function writeReplayIndex(store, category, digest, marker) {
  const path = `continuations/receipt-index/${category}/${digest}.json`;
  try {
    await store.writeCanonicalJson(path, marker);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        const artifact = await store.readArtifact(path);
        const retained = parseCanonical(artifact.bytes, "receipt index");
        if (canonicalValuesEqual(retained, marker)) return;
      } catch (readError) {
        if (
          readError instanceof ContinuationError &&
          readError.code === "CONTINUATION_RECEIPT_REPLAY"
        ) {
          throw readError;
        }
      }
      fail("CONTINUATION_RECEIPT_REPLAY", "hard-cut request or receipt was already consumed");
    }
    throw error;
  }
}

async function loadExternalReceiptTransaction(store, chain) {
  const path = `continuations/receipt-transactions/${chain.header.chainId}.json`;
  try {
    const artifact = await store.readArtifact(path);
    return validateExternalReceiptTransaction(
      parseCanonical(artifact.bytes, "external receipt transaction"),
      chain.header,
      chain.entries,
      chain.previousEntrySha256,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertTransactionMatchesEvidence(transaction, checkpointEvidence) {
  if (!canonicalValuesEqual(transaction.marker.checkpointEvidence, checkpointEvidence)) {
    fail("CONTINUATION_RECEIPT_REPLAY", "continuation transaction belongs to another receipt");
  }
}

async function writeExternalClosure(store, chain, marker) {
  const path = chainPath(chain.header.chainId, "receipts/external.json");
  if (chain.closure !== null) {
    if (
      chain.closure.kind === "windows-host-probe-consumed-external-receipt" &&
      canonicalValuesEqual(chain.closure, marker)
    ) {
      return;
    }
    fail("CONTINUATION_RECEIPT_REPLAY", "continuation already closed with another receipt");
  }
  try {
    await store.writeCanonicalJson(path, marker);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        const artifact = await store.readArtifact(path);
        const retained = parseCanonical(artifact.bytes, "external continuation receipt");
        if (canonicalValuesEqual(retained, marker)) return;
      } catch (readError) {
        if (
          readError instanceof ContinuationError &&
          readError.code === "CONTINUATION_RECEIPT_REPLAY"
        ) {
          throw readError;
        }
      }
      fail("CONTINUATION_RECEIPT_REPLAY", "continuation already consumed another receipt");
    }
    throw error;
  }
}

export async function initializeContinuation({ store, scope, now = () => new Date() }) {
  assertExactKeys(
    scope,
    [
      "campaignId",
      "manifestSha256",
      "candidateSha256",
      "labAttestationSha256",
      "campaignRunId",
      "executionRunId",
      "executionBundleId",
      "executionBundleManifestSha256",
      "environmentId",
      "pathProfileId",
      "rowId",
      "variantId",
      "attemptId",
      "vmSnapshotId",
      "repetition",
      "chainId",
    ],
    "continuation scope",
  );
  validateScopeFields(scope);
  await createDirectoryIfAbsent(store, "continuations");
  await createDirectoryIfAbsent(store, "continuations/chains");
  await createDirectoryIfAbsent(store, "continuations/receipt-transactions");
  await createDirectoryIfAbsent(store, "continuations/receipt-index");
  await createDirectoryIfAbsent(store, "continuations/receipt-index/nonces");
  await createDirectoryIfAbsent(store, "continuations/receipt-index/requests");
  await createDirectoryIfAbsent(store, "continuations/receipt-index/receipts");
  await createDirectoryIfAbsent(store, `continuations/chains/${scope.chainId}`);
  const chainRoot = `continuations/chains/${scope.chainId}`;
  const before = await store.list(chainRoot);
  const allowed = new Map([
    ["header.json", "file"],
    ["entries", "directory"],
    ["receipts", "directory"],
  ]);
  for (const entry of before) {
    if (allowed.get(entry.name) !== entry.kind) {
      fail("CONTINUATION_INITIALIZATION_COLLISION", "continuation chain root is not recoverable");
    }
  }
  const retainedHeaderItem = before.find((entry) => entry.name === "header.json");
  if (retainedHeaderItem === undefined) {
    for (const directory of ["entries", "receipts"]) {
      const item = before.find((entry) => entry.name === directory);
      if (item !== undefined && (await store.list(`${chainRoot}/${directory}`)).length !== 0) {
        fail(
          "CONTINUATION_INITIALIZATION_COLLISION",
          "headerless continuation chain contains retained state",
        );
      }
    }
  }
  if (retainedHeaderItem !== undefined) {
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "entries"));
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "receipts"));
    const retained = await loadContinuation({ store, chainId: scope.chainId });
    assertHeaderMatchesScope(retained.header, scope);
    return Object.freeze(retained.header);
  }
  const createdAt = now().toISOString();
  requireTimestamp(createdAt, "createdAt");
  const header = {
    schemaVersion: 1,
    kind: "windows-host-probe-continuation",
    ...scope,
    scopeSha256: deriveProbeContinuationScopeDigest(scope),
    createdAt,
    headerSha256: "",
  };
  header.headerSha256 = hashEvidenceValue(
    "enduragent.windows-host-probe-continuation-header.v1",
    headerDigestPayload(header),
  );
  try {
    await store.writeCanonicalJson(chainPath(scope.chainId, "header.json"), header);
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "entries"));
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "receipts"));
    return Object.freeze(header);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "entries"));
    await createDirectoryIfAbsent(store, chainPath(scope.chainId, "receipts"));
    const retained = await loadContinuation({ store, chainId: scope.chainId });
    assertHeaderMatchesScope(retained.header, scope);
    return Object.freeze(retained.header);
  }
}

export async function loadContinuation({ store, chainId }) {
  const headerArtifact = await store.readArtifact(chainPath(chainId, "header.json"));
  const header = validateHeader(parseCanonical(headerArtifact.bytes, "continuation header"));
  const listing = await store.list(chainPath(chainId, "entries"));
  const entries = [];
  const operationIds = new Set();
  let previousEntrySha256 = null;
  for (const [index, item] of listing.entries()) {
    if (item.kind !== "file") fail("CONTINUATION_ENTRY", "entry directory contains a directory");
    const match = entryNamePattern.exec(item.name);
    if (match === null || Number(match[1]) !== index + 1) {
      fail("CONTINUATION_CHAIN", "continuation entries are missing, duplicated, or out of order");
    }
    const artifact = await store.readArtifact(chainPath(chainId, `entries/${item.name}`));
    const entry = validateEntry(
      parseCanonical(artifact.bytes, `continuation entry ${item.name}`),
      header,
      index + 1,
      previousEntrySha256,
    );
    if (operationIds.has(entry.operationId)) {
      fail("CONTINUATION_OPERATION_COLLISION", "continuation operation id is duplicated");
    }
    entries.push(entry);
    operationIds.add(entry.operationId);
    previousEntrySha256 = entry.entrySha256;
  }
  const closure = await loadClosure(store, chainId, header, entries, previousEntrySha256);
  return Object.freeze({
    header,
    entries: Object.freeze(entries),
    nextSequence: entries.length + 1,
    previousEntrySha256,
    closure,
  });
}

export async function appendContinuation({
  store,
  chainId,
  operationId,
  payload,
  now = () => new Date(),
}) {
  requireIdentifier(operationId, "operationId");
  requirePayload(payload);
  const chain = await loadContinuation({ store, chainId });
  const repeated = retainedOperation(chain, operationId, payload);
  if (repeated !== null) return repeated;
  if (chain.closure !== null) fail("CONTINUATION_CLOSED", "continuation is already closed");
  if (chain.nextSequence > 99_999_999) fail("CONTINUATION_BOUND", "continuation is exhausted");
  const createdAt = now().toISOString();
  requireTimestamp(createdAt, "createdAt");
  const entry = {
    schemaVersion: 1,
    kind: "windows-host-probe-continuation-entry",
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    operationId,
    sequence: chain.nextSequence,
    previousEntrySha256: chain.previousEntrySha256,
    createdAt,
    payload,
    entrySha256: "",
  };
  entry.entrySha256 = hashEvidenceValue(
    "enduragent.windows-host-probe-continuation-entry.v1",
    entryDigestPayload(entry),
  );
  const name = `${String(entry.sequence).padStart(8, "0")}.json`;
  try {
    await store.writeCanonicalJson(chainPath(chainId, `entries/${name}`), entry);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const reloaded = await loadContinuation({ store, chainId });
      const recovered = retainedOperation(reloaded, operationId, payload);
      if (recovered !== null) return recovered;
      fail("CONTINUATION_RACE", "continuation append lost an ownership race");
    }
    throw error;
  }
  return Object.freeze(entry);
}

export async function closeContinuation({ store, chainId, now = () => new Date() }) {
  const chain = await loadContinuation({ store, chainId });
  if (chain.closure?.kind === "windows-host-probe-local-continuation-receipt") {
    return continuationReference(chain, chain.closure.receiptSha256);
  }
  if (chain.closure !== null) fail("CONTINUATION_CLOSED", "continuation is already closed");
  if (chain.entries.length === 0 || chain.previousEntrySha256 === null) {
    fail("CONTINUATION_EMPTY", "continuation cannot close without retained entries");
  }
  const closedAt = now().toISOString();
  requireTimestamp(closedAt, "closedAt");
  const receipt = {
    schemaVersion: 1,
    kind: "windows-host-probe-local-continuation-receipt",
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    headerSha256: chain.header.headerSha256,
    terminalEntrySha256: chain.previousEntrySha256,
    entryCount: chain.entries.length,
    closedAt,
    receiptSha256: "",
  };
  receipt.receiptSha256 = hashEvidenceValue(
    "enduragent.windows-host-probe-local-continuation-receipt.v1",
    receiptDigestPayload(receipt),
  );
  try {
    await store.writeCanonicalJson(chainPath(chainId, "receipts/local.json"), receipt);
    return continuationReference(chain, receipt.receiptSha256);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const reloaded = await loadContinuation({ store, chainId });
    if (reloaded.closure?.kind !== "windows-host-probe-local-continuation-receipt") {
      fail("CONTINUATION_CLOSED", "continuation was closed by another receipt");
    }
    return continuationReference(reloaded, reloaded.closure.receiptSha256);
  }
}

export async function consumeContinuationReceipt({
  store,
  chainId,
  checkpointEvidence,
  expectedController,
  controllerPublicKeyBytes,
  now = () => new Date(),
}) {
  if (!exactObject(checkpointEvidence)) {
    fail("CONTINUATION_RECEIPT", "checkpoint evidence must be an object");
  }
  const chain = await loadContinuation({ store, chainId });
  if (chain.entries.length === 0 || chain.previousEntrySha256 === null) {
    fail("CONTINUATION_EMPTY", "external receipt cannot close an empty continuation");
  }
  const receiptSha256 = checkpointEvidence.receipt?.receiptSha256;
  requireSha256(receiptSha256, "checkpointEvidence.receipt.receiptSha256");
  const continuation = {
    repetition: chain.header.repetition,
    chainId: chain.header.chainId,
    scopeSha256: chain.header.scopeSha256,
    headerSha256: chain.header.headerSha256,
    terminalEntrySha256: chain.previousEntrySha256,
    receiptSha256,
  };
  const segment = {
    campaignId: chain.header.campaignId,
    manifestSha256: chain.header.manifestSha256,
    candidateSha256: chain.header.candidateSha256,
    environmentId: chain.header.environmentId,
    pathProfileId: chain.header.pathProfileId,
    rowId: chain.header.rowId,
    variantId: chain.header.variantId,
    provenance: {
      campaignRunId: chain.header.campaignRunId,
      executionRunId: chain.header.executionRunId,
      executionBundleId: chain.header.executionBundleId,
      executionBundleManifestSha256: chain.header.executionBundleManifestSha256,
      attemptId: chain.header.attemptId,
      vmSnapshotId: checkpointEvidence.request?.sourceVmSnapshotId,
    },
  };
  if (checkpointEvidence.request?.sourceVmSnapshotId !== chain.header.vmSnapshotId) {
    fail("CONTINUATION_RECEIPT", "hard-cut request uses another VM snapshot");
  }
  await createDirectoryIfAbsent(store, "continuations/receipt-transactions");
  let transaction = await loadExternalReceiptTransaction(store, chain);
  if (chain.closure !== null && transaction === null) {
    fail("CONTINUATION_RECEIPT_REPLAY", "closed continuation has no receipt transaction");
  }
  if (transaction !== null) {
    assertTransactionMatchesEvidence(transaction, checkpointEvidence);
  }
  const replayRegistry = await replayRegistryFromStore(store, transaction);
  try {
    validateExternalCheckpointEvidence(checkpointEvidence, {
      segment,
      continuation,
      repetition: chain.header.repetition,
      replayRegistry,
      expectedController,
      controllerPublicKeyBytes,
    });
  } catch (error) {
    fail(
      "CONTINUATION_RECEIPT",
      error instanceof Error ? error.message : "receipt verification failed",
    );
  }
  if (transaction === null) {
    const consumedAt = now().toISOString();
    requireTimestamp(consumedAt, "consumedAt");
    const marker = {
      schemaVersion: 1,
      kind: "windows-host-probe-consumed-external-receipt",
      chainId: chain.header.chainId,
      scopeSha256: chain.header.scopeSha256,
      headerSha256: chain.header.headerSha256,
      terminalEntrySha256: chain.previousEntrySha256,
      checkpointEvidence,
      consumedAt,
      markerSha256: "",
    };
    marker.markerSha256 = hashEvidenceValue(
      "enduragent.windows-host-probe-consumed-external-receipt.v1",
      externalMarkerDigestPayload(marker),
    );
    const transactionDraft = {
      schemaVersion: 1,
      kind: "windows-host-probe-external-receipt-transaction",
      chainId: chain.header.chainId,
      scopeSha256: chain.header.scopeSha256,
      nonceSha256: checkpointEvidence.request.nonceSha256,
      requestSha256: checkpointEvidence.request.requestSha256,
      receiptSha256,
      marker,
      transactionSha256: "",
    };
    transactionDraft.transactionSha256 = hashEvidenceValue(
      "enduragent.windows-host-probe-external-receipt-transaction.v1",
      externalReceiptTransactionDigestPayload(transactionDraft),
    );
    const path = `continuations/receipt-transactions/${chain.header.chainId}.json`;
    try {
      await store.writeCanonicalJson(path, transactionDraft);
      transaction = transactionDraft;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      transaction = await loadExternalReceiptTransaction(store, chain);
      if (transaction === null) {
        fail("CONTINUATION_RECEIPT_TRANSACTION", "receipt transaction ownership was lost");
      }
      assertTransactionMatchesEvidence(transaction, checkpointEvidence);
    }
  }
  const indexMarker = receiptIndexMarker(transaction);
  await writeReplayIndex(store, "nonces", checkpointEvidence.request.nonceSha256, indexMarker);
  await writeReplayIndex(store, "requests", checkpointEvidence.request.requestSha256, indexMarker);
  await writeReplayIndex(store, "receipts", receiptSha256, indexMarker);
  await writeExternalClosure(store, chain, transaction.marker);
  return Object.freeze({
    continuation: Object.freeze(continuation),
    checkpointEvidence: transaction.marker.checkpointEvidence,
  });
}
