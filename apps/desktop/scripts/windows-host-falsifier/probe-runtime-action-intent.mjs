import { Buffer } from "node:buffer";

import { getProbeActionMapping, resolveProbeActionActor } from "./probe-action-map.mjs";
import { validateProbeControllerPreparedAuthority } from "./probe-controller-prepared-authority.mjs";
import { canonicalProbeJson, hashProbeCanonicalJson } from "./probe-contract.mjs";
import { validatePreparedProbeContext } from "./probe-preflight.mjs";

export const PROBE_RUNTIME_ACTION_INTENT_SCHEMA_VERSION = 2;

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const invocationKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "rowId",
  "variantId",
  "planSha256",
  "action",
]);
const actionKeys = Object.freeze([
  "sequence",
  "actionId",
  "actor",
  "phase",
  "operation",
  "parameters",
  "prerequisiteActionIds",
  "capture",
]);

export class ProbeRuntimeActionIntentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeRuntimeActionIntentError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeRuntimeActionIntentError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertExactDataKeys(value, keys, label) {
  if (!exactObject(value)) fail("RUNTIME_ACTION_SCHEMA", `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("RUNTIME_ACTION_SCHEMA", `${label} has an invalid field set`);
  }
  const expected = [...keys].sort(compareUtf8);
  actual.sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("RUNTIME_ACTION_SCHEMA", `${label} has an invalid field set`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("RUNTIME_ACTION_SCHEMA", `${label} fields must be enumerable data`);
    }
  }
}

function readOwnData(value, key, label, { optional = false } = {}) {
  if (!exactObject(value)) fail("RUNTIME_ACTION_SCHEMA", `${label} must be a plain object`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (optional) return undefined;
    fail("RUNTIME_ACTION_SCHEMA", `${label}.${key} is missing`);
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    fail("RUNTIME_ACTION_SCHEMA", `${label}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || value.length > 128 || !identifierPattern.test(value)) {
    fail("RUNTIME_ACTION_OPERATION", `${label} must be bounded lowercase kebab-case`);
  }
  return value;
}

function requireBoundedString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  ) {
    fail("RUNTIME_ACTION_SCHEMA", `${label} must be a bounded NFC string`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("RUNTIME_ACTION_SCHEMA", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function projectOperationCommand(command) {
  const repetition = readOwnData(command, "repetition", "command", { optional: true });
  if (repetition !== undefined && (!Number.isSafeInteger(repetition) || repetition < 1)) {
    fail("RUNTIME_ACTION_OPERATION", "scenario operation repetition must be a positive integer");
  }
  return Object.freeze({
    campaignRunId: requireIdentifier(
      readOwnData(command, "campaignRunId", "command"),
      "scenario operation campaignRunId",
    ),
    attemptId: requireIdentifier(
      readOwnData(command, "attemptId", "command"),
      "scenario operation attemptId",
    ),
    workId: requireIdentifier(
      readOwnData(command, "workId", "command"),
      "scenario operation workId",
    ),
    repetition: repetition ?? null,
  });
}

function projectCommand(command) {
  const operation = projectOperationCommand(command);
  return Object.freeze({
    ...operation,
    rowId: requireBoundedString(readOwnData(command, "rowId", "command"), "command.rowId"),
    variantId: requireBoundedString(
      readOwnData(command, "variantId", "command"),
      "command.variantId",
    ),
  });
}

function cloneJsonData(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("RUNTIME_ACTION_SCHEMA", `${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    fail("RUNTIME_ACTION_SCHEMA", `${label} is not acyclic JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("RUNTIME_ACTION_SCHEMA", `${label} must be a plain array`);
      }
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("RUNTIME_ACTION_SCHEMA", `${label}[${index}] must be enumerable data`);
        }
        clone.push(cloneJsonData(descriptor.value, `${label}[${index}]`, ancestors));
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        fail("RUNTIME_ACTION_SCHEMA", `${label} has unexpected array properties`);
      }
      return clone;
    }
    if (!exactObject(value)) fail("RUNTIME_ACTION_SCHEMA", `${label} must be a plain object`);
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        fail("RUNTIME_ACTION_SCHEMA", `${label} has a symbolic property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("RUNTIME_ACTION_SCHEMA", `${label}.${key} must be enumerable data`);
      }
      clone[key] = cloneJsonData(descriptor.value, `${label}.${key}`, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function deriveOperationId(projected, actionId) {
  const validatedActionId = requireIdentifier(actionId, "scenario operation actionId");
  return `operation-${hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-runtime-scenario-operation.v1",
    campaignRunId: projected.campaignRunId,
    attemptId: projected.attemptId,
    workId: projected.workId,
    actionId: validatedActionId,
    repetition: projected.repetition,
  }).slice(0, 32)}`;
}

function projectExpectedActor(invocation, preparedAuthority) {
  const resolved = resolveProbeActionActor(invocation);
  let identitySha256;
  switch (resolved.identitySource) {
    case "actors.primaryStandardUserSidSha256":
      identitySha256 = preparedAuthority.actors.primaryStandardUserSidSha256;
      break;
    case "controller.identitySha256":
      identitySha256 = preparedAuthority.controller.identitySha256;
      break;
    case "actors.powerControlActorSha256":
      identitySha256 = preparedAuthority.actors.powerControlActorSha256;
      break;
    case "actors.snapshotControlActorSha256":
      identitySha256 = preparedAuthority.actors.snapshotControlActorSha256;
      break;
    case "actors.remotePeerActorSha256":
      identitySha256 = preparedAuthority.actors.remotePeerActorSha256;
      break;
    case "actors.secondUserSidSha256":
      identitySha256 = preparedAuthority.actors.secondUserSidSha256;
      break;
    default:
      fail("RUNTIME_ACTION_ACTOR", "resolved actor identity source is not closed");
  }
  return Object.freeze({
    role: resolved.role,
    identitySource: resolved.identitySource,
    identitySha256: requireSha256(identitySha256, "expectedActor.identitySha256"),
  });
}

export function deriveProbeRuntimeScenarioOperationId(command, actionId) {
  return deriveOperationId(projectOperationCommand(command), actionId);
}

export function deriveProbeRuntimeActionPaths(command, actionId) {
  const campaignRunId = requireIdentifier(
    readOwnData(command, "campaignRunId", "command"),
    "scenario operation campaignRunId",
  );
  const attemptId = requireIdentifier(
    readOwnData(command, "attemptId", "command"),
    "scenario operation attemptId",
  );
  const workId = requireIdentifier(
    readOwnData(command, "workId", "command"),
    "scenario operation workId",
  );
  const validatedActionId = requireIdentifier(actionId, "scenario operation actionId");
  const base = ["runtime", "work", campaignRunId, attemptId, workId].join("/");
  return Object.freeze({
    operationIntentPath: `${base}/action-intents/${validatedActionId}.json`,
    operationResultPath: `${base}/action-results/${validatedActionId}.json`,
  });
}

function createRuntimeActionBinding(command, invocation, preparedAuthority) {
  assertExactDataKeys(invocation, invocationKeys, "invocation");
  assertExactDataKeys(invocation.action, actionKeys, "invocation.action");
  if (
    invocation.schemaVersion !== 1 ||
    invocation.kind !== "windows-host-probe-scenario-action-invocation" ||
    invocation.rowId !== command.rowId ||
    invocation.variantId !== command.variantId
  ) {
    fail("RUNTIME_ACTION_SCHEMA", "invocation identity differs from its command");
  }
  if (
    preparedAuthority.campaignRunId !== command.campaignRunId ||
    preparedAuthority.attemptId !== command.attemptId
  ) {
    fail("RUNTIME_ACTION_PREPARED", "prepared context identity differs from its command");
  }
  requireSha256(invocation.planSha256, "invocation.planSha256");
  const actionId = requireIdentifier(invocation.action.actionId, "invocation.action.actionId");
  const operationId = deriveOperationId(command, actionId);
  const paths = deriveProbeRuntimeActionPaths(command, actionId);
  const execution = getProbeActionMapping(invocation);
  const expectedActor = projectExpectedActor(invocation, preparedAuthority);
  const intent = deepFreeze({
    schemaVersion: PROBE_RUNTIME_ACTION_INTENT_SCHEMA_VERSION,
    kind: "windows-host-probe-runtime-action-intent",
    campaignRunId: command.campaignRunId,
    attemptId: command.attemptId,
    workId: command.workId,
    rowId: command.rowId,
    variantId: command.variantId,
    repetition: command.repetition,
    planSha256: invocation.planSha256,
    actionId,
    operationId,
    action: invocation.action,
    execution,
    expectedActor,
  });
  canonicalProbeJson(intent);
  const operationIntentSha256 = hashProbeCanonicalJson(intent);
  return deepFreeze({
    operationId,
    operationIntentSha256,
    ...paths,
    execution,
    expectedActor,
    intent,
  });
}

export function createProbeRuntimeActionBinding(input) {
  assertExactDataKeys(
    input,
    ["command", "invocation", "preparedContext"],
    "runtime action binding input",
  );
  const command = projectCommand(input.command);
  const invocation = cloneJsonData(input.invocation, "invocation");
  const preparedContext = validatePreparedProbeContext(
    cloneJsonData(input.preparedContext, "preparedContext"),
  );
  return createRuntimeActionBinding(command, invocation, {
    campaignRunId: preparedContext.campaignRunId,
    attemptId: preparedContext.attemptId,
    controller: preparedContext.executionBundleManifest.controller,
    actors: preparedContext.executionBundleManifest.actors,
  });
}

export function createProbeRuntimeActionBindingFromPreparedAuthority(input) {
  assertExactDataKeys(
    input,
    ["command", "invocation", "preparedAuthority"],
    "controller runtime action binding input",
  );
  const command = projectCommand(input.command);
  const invocation = cloneJsonData(input.invocation, "invocation");
  const preparedAuthority = validateProbeControllerPreparedAuthority(input.preparedAuthority);
  return createRuntimeActionBinding(command, invocation, preparedAuthority);
}
