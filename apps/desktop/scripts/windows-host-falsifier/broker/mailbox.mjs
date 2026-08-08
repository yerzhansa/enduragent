import { Buffer } from "node:buffer";
import { createHash, createPrivateKey } from "node:crypto";

import { canonicalProbeJson } from "../probe-contract.mjs";
import {
  PROBE_BROKER_MAX_ARTIFACT_BYTES,
  PROBE_BROKER_MAX_CANONICAL_BYTES,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  validateProbeBrokerControllerAcceptanceInputForTask,
  validateProbeBrokerResult,
  validateProbeBrokerTask,
} from "./protocol.mjs";
import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  createProbeBrokerMailboxRefusalEnvelope,
  createProbeBrokerMailboxResultEnvelope,
  createProbeBrokerMailboxTaskEnvelope,
  validateProbeBrokerMailboxRefusalEnvelope,
  validateProbeBrokerMailboxResultEnvelope,
  validateProbeBrokerMailboxTaskEnvelope,
  validateProbeBrokerMailboxObservation,
  validateProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";

export const PROBE_BROKER_MAILBOX_SCHEMA_VERSION = 1;
export const PROBE_BROKER_MAILBOX_MECHANISM = "role-separated-hardlink-publication-v1";
export const PROBE_BROKER_MAILBOX_PRINCIPALS = Object.freeze(["broker", "controller"]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const mailboxLeafPattern = /^([a-f0-9]{64})\.json$/u;
const principals = new Set(PROBE_BROKER_MAILBOX_PRINCIPALS);
const secretTextPatterns = Object.freeze([
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/iu,
  /"(?:access[_-]?token|api[_-]?key|client[_-]?secret|credential|password|private[_-]?key|secret|session[_-]?cookie|token)"\s*:/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:cookie|set-cookie)"?\s*:\s*"?(?:[^;\r\n"]*;\s*)*(?:(?:__host-|__secure-)?(?:auth[_-]?session|session(?:[_-]?(?:cookie|id|token))?)|asp\.net_sessionid|connect\.sid|j?sessionid|phpsessid|sid)\s*=\s*[^\s;"',]{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
]);
const basicAuthorizationPattern =
  /\bauthorization"?\s*:\s*"?basic[ \t]+([A-Za-z0-9+/]{2,}={0,2})(?=["\s,}]|$)/gimu;
const actorIdentitySourceByRole = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  "second-user": "actors.secondUserSidSha256",
  "remote-peer": "actors.remotePeerActorSha256",
});

export class ProbeBrokerMailboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerMailboxError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerMailboxError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = [], label = "value") {
  if (!exactObject(value)) fail("BROKER_MAILBOX_SCHEMA", `${label} must be a plain object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      fail("BROKER_MAILBOX_SCHEMA", `${label} has an unexpected key: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("BROKER_MAILBOX_SCHEMA", `${label} is missing key: ${key}`);
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_MAILBOX_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireStore(value, label) {
  if (!exactObject(value) || typeof value.root !== "string" || value.root.length === 0) {
    fail("BROKER_MAILBOX_STORE", `${label} must be an evidence store`);
  }
  for (const method of [
    "createDirectory",
    "writeBytes",
    "readArtifact",
    "list",
    "assertRootStable",
  ]) {
    if (typeof value[method] !== "function") {
      fail("BROKER_MAILBOX_STORE", `${label} is missing ${method}`);
    }
  }
  return value;
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    fail("BROKER_MAILBOX_BYTES", `${label} must be bytes`);
  }
  if (value.byteLength > PROBE_BROKER_MAX_ARTIFACT_BYTES) {
    fail("BROKER_MAILBOX_BYTES", `${label} exceeds the broker artifact bound`);
  }
  return Buffer.from(value);
}

function validateForbiddenValues(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) {
    fail("BROKER_MAILBOX_SECRET_POLICY", "forbidden values must be a bounded array");
  }
  const unique = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length < 8 || entry.length > 4096) {
      fail("BROKER_MAILBOX_SECRET_POLICY", "forbidden values are invalid");
    }
    unique.add(entry);
  }
  return Object.freeze([...unique]);
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

function containsBasicAuthorization(value) {
  for (const match of value.matchAll(basicAuthorizationPattern)) {
    const encoded = match[1];
    const decoded = Buffer.from(encoded, "base64");
    if (
      decoded.includes(0x3a) &&
      decoded.toString("base64").replace(/=+$/u, "") === encoded.replace(/=+$/u, "")
    ) {
      return true;
    }
  }
  return false;
}

export function assertProbeBrokerMailboxBytesSafe(value, options = {}) {
  assertExactKeys(options, [], ["forbiddenValues"], "broker mailbox byte policy");
  const bytes = requireBytes(value, "broker mailbox payload");
  const forbiddenValues = validateForbiddenValues(options.forbiddenValues);
  const utf8 = bytes.toString("utf8");
  if (
    secretTextPatterns.some((pattern) => pattern.test(utf8)) ||
    containsBasicAuthorization(utf8) ||
    forbiddenValues.some((entry) =>
      encodedForbiddenValues(entry).some((encoded) => bytes.includes(encoded)),
    ) ||
    parsesAsPrivateKey(bytes)
  ) {
    fail("BROKER_MAILBOX_SECRET_MATERIAL", "broker mailbox payload contains prohibited material");
  }
  return bytes;
}

function parseCanonicalObject(bytes, label) {
  const input = requireBytes(bytes, label);
  if (input.byteLength > PROBE_BROKER_MAX_CANONICAL_BYTES) {
    fail("BROKER_MAILBOX_CANONICAL", `${label} exceeds the canonical envelope bound`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("BROKER_MAILBOX_CANONICAL", `${label} is not UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("BROKER_MAILBOX_CANONICAL", `${label} is not JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== text) {
    fail("BROKER_MAILBOX_CANONICAL", `${label} is not exact canonical JSON`);
  }
  return value;
}

async function createDirectoryIfAbsent(store, path) {
  try {
    await store.createDirectory(path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export async function initializeProbeBrokerMailboxStore(options) {
  assertExactKeys(options, ["store"], [], "broker mailbox initialization");
  const store = requireStore(options.store, "store");
  await store.assertRootStable();
  for (const directory of ["blobs", "blobs/sha256", "tasks", "terminals", "results", "refusals"]) {
    await createDirectoryIfAbsent(store, directory);
  }
  return Object.freeze({
    schemaVersion: PROBE_BROKER_MAILBOX_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-mailbox-initialized",
    mechanism: PROBE_BROKER_MAILBOX_MECHANISM,
  });
}

async function publishExact(store, path, bytes, label) {
  await store.assertRootStable();
  try {
    const retained = await store.writeBytes(path, bytes);
    if (retained.path !== path || retained.sha256 !== sha256(bytes)) {
      fail("BROKER_MAILBOX_PUBLICATION", `${label} publication acknowledgment differs`);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(path);
    if (
      retained.path !== path ||
      retained.size !== bytes.byteLength ||
      retained.sha256 !== sha256(bytes) ||
      !retained.bytes.equals(bytes)
    ) {
      fail("BROKER_MAILBOX_COLLISION", `${label} exact replay differs`);
    }
  }
}

function normalizeReference(value, label) {
  if (!exactObject(value)) fail("BROKER_MAILBOX_REFERENCE", `${label} must be an object`);
  const keys = ["blobPath", "bytes", "sha256"];
  const actual = Object.keys(value)
    .filter((key) => keys.includes(key))
    .sort()
    .join(",");
  if (actual !== [...keys].sort().join(",")) {
    fail("BROKER_MAILBOX_REFERENCE", `${label} has an invalid shape`);
  }
  requireSha256(value.sha256, `${label}.sha256`);
  if (
    value.blobPath !== `blobs/sha256/${value.sha256}` ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > PROBE_BROKER_MAX_ARTIFACT_BYTES
  ) {
    fail("BROKER_MAILBOX_REFERENCE", `${label} is invalid`);
  }
  return Object.freeze({
    blobPath: value.blobPath,
    bytes: value.bytes,
    sha256: value.sha256,
  });
}

function assertReferenceBytes(referenceValue, bytesValue, forbiddenValues, label) {
  const reference = normalizeReference(referenceValue, `${label} reference`);
  const bytes = assertProbeBrokerMailboxBytesSafe(bytesValue, { forbiddenValues });
  if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
    fail("BROKER_MAILBOX_BLOB", `${label} bytes differ from their content reference`);
  }
  return { reference, bytes };
}

async function readReference(readArtifact, referenceValue, forbiddenValues, label) {
  const reference = normalizeReference(referenceValue, `${label} reference`);
  const retained = await readArtifact(reference.blobPath);
  const bytes = assertProbeBrokerMailboxBytesSafe(retained.bytes, { forbiddenValues });
  if (
    retained.path !== reference.blobPath ||
    retained.size !== reference.bytes ||
    retained.sha256 !== reference.sha256 ||
    sha256(bytes) !== reference.sha256
  ) {
    fail("BROKER_MAILBOX_BLOB", `${label} differs from its content reference`);
  }
  return Buffer.from(bytes);
}

function requirePrincipal(value) {
  if (!principals.has(value)) {
    fail("BROKER_MAILBOX_PRINCIPAL", "broker mailbox principal is invalid");
  }
  return value;
}

function assertPrincipal(actual, expected, operation) {
  if (actual !== expected) {
    fail("BROKER_MAILBOX_PRINCIPAL", `${operation} requires the ${expected} principal`);
  }
}

function assertTaskAuthority(taskValue, binding) {
  const task = validateProbeBrokerTask(taskValue);
  if (
    task.brokerEnrollmentSha256 !== binding.brokerEnrollmentSha256 ||
    task.brokerRole !== binding.brokerRole ||
    task.brokerInstanceId !== binding.brokerInstanceId ||
    task.mailboxAclSha256 !== binding.mailboxAclSha256 ||
    task.processSidSha256 !== binding.processSidSha256 ||
    task.bootIdSha256 !== binding.bootIdSha256 ||
    task.runnerSessionIdSha256 !== binding.runnerSessionIdSha256 ||
    task.expectedActor.role !== binding.brokerRole ||
    task.expectedActor.identitySource !== actorIdentitySourceByRole[binding.brokerRole]
  ) {
    fail("BROKER_MAILBOX_TASK_AUTHORITY", "broker task differs from prepared mailbox authority");
  }
  const expectedActorIdentitySha256 =
    binding.brokerRole === "remote-peer" ? binding.peerAuthoritySha256 : binding.processSidSha256;
  if (task.expectedActor.identitySha256 !== expectedActorIdentitySha256) {
    fail(
      "BROKER_MAILBOX_TASK_AUTHORITY",
      "broker task actor differs from prepared mailbox authority",
    );
  }
  return task;
}

function assertEnvelopeForTask(envelope, task) {
  if (
    envelope.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    envelope.brokerRole !== task.brokerRole ||
    envelope.brokerInstanceId !== task.brokerInstanceId ||
    envelope.semanticKeySha256 !== deriveProbeBrokerTaskSemanticKeySha256(task) ||
    envelope.physicalOperationKeySha256 !== deriveProbeBrokerTaskPhysicalOperationKeySha256(task) ||
    envelope.taskSha256 !== task.taskSha256
  ) {
    fail("BROKER_MAILBOX_ENVELOPE_BINDING", "mailbox envelope differs from its expected task");
  }
}

function resultReferences(result) {
  const values = [
    result.driverResult.resultArtifact,
    ...result.proofArtifacts,
    ...result.observerTranscripts,
    ...(result.pausedSessionReceipt === null ? [] : [result.pausedSessionReceipt]),
  ];
  const references = new Map();
  for (const [index, value] of values.entries()) {
    const reference = normalizeReference(value, `broker result reference ${index}`);
    const retained = references.get(reference.sha256);
    if (retained !== undefined && canonicalProbeJson(retained) !== canonicalProbeJson(reference)) {
      fail("BROKER_MAILBOX_REFERENCE", "one digest names conflicting result references");
    }
    references.set(reference.sha256, reference);
  }
  return [...references.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

function validateArtifactInputs(values, expectedReferences, forbiddenValues) {
  if (!Array.isArray(values)) {
    fail("BROKER_MAILBOX_ARTIFACTS", "broker mailbox artifacts must be an array");
  }
  const supplied = new Map();
  for (const [index, value] of values.entries()) {
    assertExactKeys(value, ["reference", "bytes"], [], `broker mailbox artifact ${index}`);
    const retained = assertReferenceBytes(
      value.reference,
      value.bytes,
      forbiddenValues,
      `broker mailbox artifact ${index}`,
    );
    if (supplied.has(retained.reference.sha256)) {
      fail("BROKER_MAILBOX_ARTIFACTS", "broker mailbox artifact inputs contain a duplicate");
    }
    supplied.set(retained.reference.sha256, retained);
  }
  if (
    supplied.size !== expectedReferences.length ||
    expectedReferences.some((reference) => !supplied.has(reference.sha256))
  ) {
    fail("BROKER_MAILBOX_ARTIFACTS", "broker mailbox artifact inputs are not exact");
  }
  return expectedReferences.map((reference) => supplied.get(reference.sha256));
}

async function readOptional(readArtifact, path) {
  try {
    return await readArtifact(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function terminalClaim(selected, physicalOperationKeySha256, envelopeSha256) {
  return Object.freeze({
    schemaVersion: PROBE_BROKER_MAILBOX_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-terminal-claim",
    physicalOperationKeySha256,
    selected,
    envelopeSha256,
  });
}

function validateTerminalClaim(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "physicalOperationKeySha256", "selected", "envelopeSha256"],
    [],
    "broker terminal claim",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-broker-terminal-claim" ||
    !["result", "refusal"].includes(value.selected)
  ) {
    fail("BROKER_MAILBOX_COMPLETION_CLAIM", "broker terminal claim identity is invalid");
  }
  requireSha256(value.physicalOperationKeySha256, "terminal claim physical operation key");
  requireSha256(value.envelopeSha256, "terminal claim envelope digest");
  return terminalClaim(value.selected, value.physicalOperationKeySha256, value.envelopeSha256);
}

async function readTerminalClaim(readArtifact, physicalOperationKeySha256) {
  const retained = await readOptional(readArtifact, `terminals/${physicalOperationKeySha256}.json`);
  if (retained === null) return null;
  const claim = validateTerminalClaim(
    parseCanonicalObject(retained.bytes, "broker terminal claim"),
  );
  if (claim.physicalOperationKeySha256 !== physicalOperationKeySha256) {
    fail(
      "BROKER_MAILBOX_COMPLETION_CLAIM",
      "broker terminal claim filename differs from its physical operation key",
    );
  }
  return claim;
}

async function assertTerminalCompatible(
  readArtifact,
  physicalOperationKeySha256,
  selected,
  envelopeSha256,
  { required = false } = {},
) {
  const retained = await readTerminalClaim(readArtifact, physicalOperationKeySha256);
  if (retained === null) {
    if (required) {
      fail(
        "BROKER_MAILBOX_COMPLETION_CLAIM",
        "broker terminal envelope has no atomic completion claim",
      );
    }
    return null;
  }
  if (retained.selected !== selected || retained.envelopeSha256 !== envelopeSha256) {
    fail(
      "BROKER_MAILBOX_COMPLETION_COLLISION",
      "broker physical operation already selected another terminal completion",
    );
  }
  return retained;
}

async function publishTerminalClaim(
  publishArtifact,
  readArtifact,
  physicalOperationKeySha256,
  selected,
  envelopeSha256,
) {
  const claim = terminalClaim(selected, physicalOperationKeySha256, envelopeSha256);
  const bytes = Buffer.from(canonicalProbeJson(claim), "utf8");
  try {
    await publishArtifact(
      `terminals/${physicalOperationKeySha256}.json`,
      bytes,
      "broker terminal claim",
    );
  } catch (error) {
    if (error?.code !== "BROKER_MAILBOX_COLLISION") throw error;
  }
  await assertTerminalCompatible(
    readArtifact,
    physicalOperationKeySha256,
    selected,
    envelopeSha256,
    { required: true },
  );
  return claim;
}

export function openProbeBrokerMailbox(options) {
  assertExactKeys(
    options,
    ["store", "binding", "principal"],
    ["assertMailboxAuthority", "forbiddenValues"],
    "broker mailbox options",
  );
  const store = requireStore(options.store, "store");
  const binding = validateProbePreparedBrokerEnrollment(options.binding);
  const principal = requirePrincipal(options.principal);
  if (typeof options.assertMailboxAuthority !== "function") {
    fail(
      "BROKER_MAILBOX_AUTHORITY_GUARD",
      "broker mailbox requires a task-independent live authority guard",
    );
  }
  const authorityGuard = options.assertMailboxAuthority;
  const forbiddenValues = validateForbiddenValues(options.forbiddenValues);
  if (store.root !== binding.mailboxRoot) {
    fail("BROKER_MAILBOX_ROOT", "evidence store root differs from prepared mailbox root");
  }

  const authorityRequest = Object.freeze({
    preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
    environmentId: binding.environmentId,
    brokerRole: binding.brokerRole,
    brokerInstanceId: binding.brokerInstanceId,
    mailboxRoot: binding.mailboxRoot,
  });
  const {
    preparedBrokerEnrollmentSha256: _preparedBrokerEnrollmentSha256,
    kind: _preparedKind,
    ...preparedObservationFields
  } = binding;
  const expectedObservation = Object.freeze({
    ...preparedObservationFields,
    kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  });

  async function assertMailboxAuthority() {
    await store.assertRootStable();
    const observed = validateProbeBrokerMailboxObservation(await authorityGuard(authorityRequest));
    await store.assertRootStable();
    if (canonicalProbeJson(observed) !== canonicalProbeJson(expectedObservation)) {
      fail(
        "BROKER_MAILBOX_AUTHORITY_DRIFT",
        "live mailbox authority differs from its prepared broker enrollment",
      );
    }
    return observed;
  }

  async function withMailboxAuthority(operation) {
    await assertMailboxAuthority();
    try {
      return await operation();
    } finally {
      await assertMailboxAuthority();
    }
  }

  const readAuthorizedArtifact = (path) => withMailboxAuthority(() => store.readArtifact(path));
  const listAuthorized = (path) => withMailboxAuthority(() => store.list(path));
  const publishAuthorized = (path, bytes, label) =>
    withMailboxAuthority(() => publishExact(store, path, bytes, label));

  async function publishTask(input) {
    assertPrincipal(principal, "controller", "task publication");
    assertExactKeys(input, ["task", "driverRequestBytes"], [], "task publication");
    const task = assertTaskAuthority(input.task, binding);
    const driverRequest = assertReferenceBytes(
      task.driverRequest.requestArtifact,
      input.driverRequestBytes,
      forbiddenValues,
      "broker driver request",
    );
    const envelope = createProbeBrokerMailboxTaskEnvelope(task);
    await publishAuthorized(
      driverRequest.reference.blobPath,
      driverRequest.bytes,
      "broker driver request blob",
    );
    await publishAuthorized(
      `tasks/${envelope.physicalOperationKeySha256}.json`,
      Buffer.from(canonicalProbeJson(envelope), "utf8"),
      "broker task envelope",
    );
    return envelope;
  }

  async function readTask(physicalOperationKeySha256) {
    assertPrincipal(principal, "broker", "task read");
    requireSha256(physicalOperationKeySha256, "physicalOperationKeySha256");
    const artifact = await readAuthorizedArtifact(`tasks/${physicalOperationKeySha256}.json`);
    const envelope = validateProbeBrokerMailboxTaskEnvelope(
      parseCanonicalObject(artifact.bytes, "broker task envelope"),
    );
    if (envelope.physicalOperationKeySha256 !== physicalOperationKeySha256) {
      fail("BROKER_MAILBOX_TASK_PATH", "broker task filename differs from its physical key");
    }
    const task = assertTaskAuthority(envelope.task, binding);
    const driverRequestBytes = await readReference(
      readAuthorizedArtifact,
      task.driverRequest.requestArtifact,
      forbiddenValues,
      "broker driver request",
    );
    return Object.freeze({
      envelope,
      task,
      driverRequestBytes,
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    });
  }

  async function listTaskPhysicalOperationKeys() {
    assertPrincipal(principal, "broker", "task listing");
    const entries = await listAuthorized("tasks");
    const keys = [];
    for (const entry of entries) {
      const match = mailboxLeafPattern.exec(entry.name);
      if (entry.kind !== "file" || match === null) {
        fail("BROKER_MAILBOX_TASK_TREE", "broker task tree contains an invalid object");
      }
      keys.push(match[1]);
    }
    return Object.freeze(keys.sort());
  }

  function prepareResultPublication(taskValue, resultValue, controllerAcceptanceInputValue) {
    const task = assertTaskAuthority(taskValue, binding);
    const result = validateProbeBrokerResult(resultValue);
    const controllerAcceptanceInput = validateProbeBrokerControllerAcceptanceInputForTask(
      controllerAcceptanceInputValue,
      task,
      result,
    );
    const envelope = createProbeBrokerMailboxResultEnvelope(
      task,
      result,
      controllerAcceptanceInput,
    );
    return Object.freeze({
      task,
      result,
      controllerAcceptanceInput,
      envelope,
      physicalKey: envelope.physicalOperationKeySha256,
      references: Object.freeze(resultReferences(result)),
    });
  }

  async function stageResultArtifacts(input) {
    assertPrincipal(principal, "broker", "result artifact staging");
    assertExactKeys(
      input,
      ["task", "result", "controllerAcceptanceInput", "artifacts"],
      [],
      "result artifact staging",
    );
    const publication = prepareResultPublication(
      input.task,
      input.result,
      input.controllerAcceptanceInput,
    );
    const artifacts = validateArtifactInputs(
      input.artifacts,
      publication.references,
      forbiddenValues,
    );
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      publication.physicalKey,
      "result",
      publication.envelope.resultEnvelopeSha256,
    );
    for (const artifact of artifacts) {
      await publishAuthorized(artifact.reference.blobPath, artifact.bytes, "broker result blob");
    }
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      publication.physicalKey,
      "result",
      publication.envelope.resultEnvelopeSha256,
    );
    return publication.envelope;
  }

  async function publishRetainedResult(input) {
    assertPrincipal(principal, "broker", "retained result publication");
    assertExactKeys(
      input,
      ["task", "result", "controllerAcceptanceInput"],
      [],
      "retained result publication",
    );
    const publication = prepareResultPublication(
      input.task,
      input.result,
      input.controllerAcceptanceInput,
    );
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      publication.physicalKey,
      "result",
      publication.envelope.resultEnvelopeSha256,
    );
    for (const reference of publication.references) {
      await readReference(
        readAuthorizedArtifact,
        reference,
        forbiddenValues,
        "staged broker result blob",
      );
    }
    await publishTerminalClaim(
      publishAuthorized,
      readAuthorizedArtifact,
      publication.physicalKey,
      "result",
      publication.envelope.resultEnvelopeSha256,
    );
    await publishAuthorized(
      `results/${publication.physicalKey}.json`,
      Buffer.from(canonicalProbeJson(publication.envelope), "utf8"),
      "broker result envelope",
    );
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      publication.physicalKey,
      "result",
      publication.envelope.resultEnvelopeSha256,
      { required: true },
    );
    return publication.envelope;
  }

  async function publishResult(input) {
    assertPrincipal(principal, "broker", "result publication");
    assertExactKeys(
      input,
      ["task", "result", "controllerAcceptanceInput", "artifacts"],
      [],
      "result publication",
    );
    await stageResultArtifacts(input);
    return publishRetainedResult({
      task: input.task,
      result: input.result,
      controllerAcceptanceInput: input.controllerAcceptanceInput,
    });
  }

  async function readResult(taskValue) {
    assertPrincipal(principal, "controller", "result read");
    const task = assertTaskAuthority(taskValue, binding);
    const physicalKey = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
    const artifact = await readAuthorizedArtifact(`results/${physicalKey}.json`);
    const envelope = validateProbeBrokerMailboxResultEnvelope(
      parseCanonicalObject(artifact.bytes, "broker result envelope"),
    );
    assertEnvelopeForTask(envelope, task);
    const controllerAcceptanceInput = validateProbeBrokerControllerAcceptanceInputForTask(
      envelope.controllerAcceptanceInput,
      task,
      envelope.result,
    );
    createProbeBrokerMailboxResultEnvelope(task, envelope.result, controllerAcceptanceInput);
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      physicalKey,
      "result",
      envelope.resultEnvelopeSha256,
      { required: true },
    );
    const artifacts = [];
    for (const reference of resultReferences(envelope.result)) {
      artifacts.push(
        Object.freeze({
          reference,
          bytes: await readReference(
            readAuthorizedArtifact,
            reference,
            forbiddenValues,
            "broker result blob",
          ),
        }),
      );
    }
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      physicalKey,
      "result",
      envelope.resultEnvelopeSha256,
      { required: true },
    );
    await assertMailboxAuthority();
    return Object.freeze({
      envelope,
      result: envelope.result,
      controllerAcceptanceInput,
      artifacts: Object.freeze(artifacts),
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    });
  }

  async function publishRefusal(input) {
    assertPrincipal(principal, "broker", "refusal publication");
    assertExactKeys(input, ["task", "refusalCode"], [], "refusal publication");
    const task = assertTaskAuthority(input.task, binding);
    const envelope = createProbeBrokerMailboxRefusalEnvelope(task, input.refusalCode);
    const physicalKey = envelope.physicalOperationKeySha256;
    await publishTerminalClaim(
      publishAuthorized,
      readAuthorizedArtifact,
      physicalKey,
      "refusal",
      envelope.refusalEnvelopeSha256,
    );
    await publishAuthorized(
      `refusals/${physicalKey}.json`,
      Buffer.from(canonicalProbeJson(envelope), "utf8"),
      "broker refusal envelope",
    );
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      physicalKey,
      "refusal",
      envelope.refusalEnvelopeSha256,
      { required: true },
    );
    return envelope;
  }

  async function readRefusal(taskValue) {
    assertPrincipal(principal, "controller", "refusal read");
    const task = assertTaskAuthority(taskValue, binding);
    const physicalKey = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
    const artifact = await readAuthorizedArtifact(`refusals/${physicalKey}.json`);
    const envelope = validateProbeBrokerMailboxRefusalEnvelope(
      parseCanonicalObject(artifact.bytes, "broker refusal envelope"),
    );
    assertEnvelopeForTask(envelope, task);
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      physicalKey,
      "refusal",
      envelope.refusalEnvelopeSha256,
      { required: true },
    );
    await assertTerminalCompatible(
      readAuthorizedArtifact,
      physicalKey,
      "refusal",
      envelope.refusalEnvelopeSha256,
      { required: true },
    );
    await assertMailboxAuthority();
    return Object.freeze({
      envelope,
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    });
  }

  return Object.freeze({
    binding,
    principal,
    assertMailboxAuthority,
    listTaskPhysicalOperationKeys,
    publishTask,
    readTask,
    stageResultArtifacts,
    publishRetainedResult,
    publishResult,
    readResult,
    publishRefusal,
    readRefusal,
  });
}
