import { Buffer } from "node:buffer";

import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  hashProbeCanonicalJson,
} from "./probe-contract.mjs";
import { NATIVE_COMMANDS } from "./native-client.mjs";
import { PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX } from "./probe-native-paths.mjs";
import { PROBE_RUN_PLAN_SHA256, getProbeRunWorkItem } from "./probe-runner.mjs";
import { getProbeScenarioDefinition } from "./probe-scenarios.mjs";

export const PROBE_NATIVE_ACTION_PLAN_SCHEMA_VERSION = 1;
export const PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES = Object.freeze([
  "read-only-replay",
  "inspect-and-reconcile",
  "never-auto-replay",
]);

const maximumSteps = 64;
const maximumPrerequisiteEvidence = 4096;
const maximumJsonDepth = 32;
const maximumJsonNodes = 20_000;
const maximumTimeoutMs = 5 * 60 * 1000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const absolutePathPattern = /^(?:[\\/]|[A-Za-z]:[\\/]|file:(?:\/{0,2})[\\/])/iu;
const unsafePathCharacterPattern = /[<>:"\\|?*]/u;
const windowsReservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const forbiddenRequestKeyPattern =
  /^(?:auth(?:entication|orization)?[_-]?(?:material|token)|credential|credentials|evidence[_-]?root|password|passwd|passphrase|private[_-]?key(?:[_-]?material)?|secret|secrets|signing[_-]?key(?:[_-]?material)?)$/iu;
const privateKeyMaterialPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const readOnlyCommands = new Set([
  "home-identity",
  "private-directory-inspect",
  "file-identity",
  "evidence-tree-seal",
  "pipe-name-derive",
  "process-identity",
  "job-query",
]);
const rootBoundCommands = new Set([
  "private-file-create",
  "file-identity",
  "secure-path-operation",
  "durable-replace",
]);
const planKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "runPlanSha256",
  "candidateSha256",
  "campaignRunId",
  "executionRunId",
  "attemptId",
  "workId",
  "environmentId",
  "pathProfileId",
  "rowId",
  "variantId",
  "scenarioPlanSha256",
  "producerActionId",
  "consumerActionId",
  "operationId",
  "evidenceRootObjectIdentitySha256",
  "steps",
  "prerequisiteEvidence",
  "actionPlanSha256",
]);
const planDraftKeys = Object.freeze(planKeys.filter((key) => key !== "actionPlanSha256"));
const createInputKeys = Object.freeze(
  planDraftKeys.filter(
    (key) =>
      !["schemaVersion", "kind", "campaignId", "manifestSha256", "runPlanSha256"].includes(key),
  ),
);

export class ProbeNativeActionPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeNativeActionPlanError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeNativeActionPlanError(code, message);
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
  if (!exactObject(value)) {
    fail("NATIVE_ACTION_PLAN_SCHEMA", label + " must be a plain object");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("NATIVE_ACTION_PLAN_SCHEMA", label + " has an invalid field set");
  }
  const actual = ownKeys.sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("NATIVE_ACTION_PLAN_SCHEMA", label + " has an invalid field set");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("NATIVE_ACTION_PLAN_SCHEMA", label + " fields must be enumerable data");
    }
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("NATIVE_ACTION_PLAN_SHA256", label + " must be lowercase 64-hex");
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("NATIVE_ACTION_PLAN_IDENTIFIER", label + " must be a bounded protocol identifier");
  }
  return value;
}

function requirePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("NATIVE_ACTION_PLAN_INTEGER", label + " must be a bounded positive integer");
  }
  return value;
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

function validateRequest(value) {
  const ancestors = new WeakSet();
  const stack = [{ value, key: null, depth: 0, exiting: false }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.exiting) {
      ancestors.delete(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > maximumJsonNodes || current.depth > maximumJsonDepth) {
      fail("NATIVE_ACTION_PLAN_REQUEST_BOUND", "native request exceeds its structural bound");
    }
    const entry = current.value;
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "string") {
      if (
        !isWellFormedString(entry) ||
        entry !== entry.normalize("NFC") ||
        entry.includes("\0") ||
        Buffer.byteLength(entry, "utf8") > 64 * 1024
      ) {
        fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains an invalid string");
      }
      if (absolutePathPattern.test(entry)) {
        fail("NATIVE_ACTION_PLAN_ABSOLUTE_PATH", "native request contains an absolute path");
      }
      if (privateKeyMaterialPattern.test(entry)) {
        fail("NATIVE_ACTION_PLAN_SECRET", "native request contains private key material");
      }
      continue;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) {
        fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains a non-finite number");
      }
      continue;
    }
    if (typeof entry !== "object") {
      fail("NATIVE_ACTION_PLAN_REQUEST", "native request is not canonical JSON data");
    }
    if (ancestors.has(entry)) {
      fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains a cycle");
    }
    ancestors.add(entry);
    stack.push({ ...current, exiting: true });
    if (Array.isArray(entry)) {
      const ownKeys = Reflect.ownKeys(entry);
      if (
        ownKeys.length !== entry.length + 1 ||
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(?:0|[1-9]\d*)$/u.test(key) ||
              !Object.hasOwn(entry, Number(key))),
        )
      ) {
        fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains a sparse or decorated array");
      }
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, index);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("NATIVE_ACTION_PLAN_REQUEST", "native request array entries must be data");
        }
        stack.push({
          value: descriptor.value,
          key: String(index),
          depth: current.depth + 1,
          exiting: false,
        });
      }
      continue;
    }
    if (!exactObject(entry)) {
      fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains an exotic object");
    }
    for (const key of Reflect.ownKeys(entry)) {
      if (
        typeof key !== "string" ||
        key === "__proto__" ||
        !isWellFormedString(key) ||
        key !== key.normalize("NFC") ||
        Buffer.byteLength(key, "utf8") > 256
      ) {
        fail("NATIVE_ACTION_PLAN_REQUEST", "native request contains an unsafe field name");
      }
      if (forbiddenRequestKeyPattern.test(key)) {
        fail("NATIVE_ACTION_PLAN_SECRET", "native request contains forbidden authority material");
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("NATIVE_ACTION_PLAN_REQUEST", "native request fields must be enumerable data");
      }
      stack.push({
        value: descriptor.value,
        key,
        depth: current.depth + 1,
        exiting: false,
      });
    }
  }
  return value;
}

function requireArtifactPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    fail("NATIVE_ACTION_PLAN_ARTIFACT_PATH", label + " is not a bounded relative path");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        Buffer.byteLength(part, "utf8") > 255 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        unsafePathCharacterPattern.test(part) ||
        windowsReservedNamePattern.test(part) ||
        [...part].some((character) => character.codePointAt(0) <= 0x1f),
    )
  ) {
    fail("NATIVE_ACTION_PLAN_ARTIFACT_PATH", label + " contains an unsafe path segment");
  }
  if (
    value === PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX ||
    value.startsWith(PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX + "/")
  ) {
    fail("NATIVE_ACTION_PLAN_RESERVED_PATH", label + " cannot name the native operation journal");
  }
  return value;
}

function validatePrerequisiteEvidence(value) {
  if (!Array.isArray(value) || value.length > maximumPrerequisiteEvidence) {
    fail("NATIVE_ACTION_PLAN_PREREQUISITES", "prerequisiteEvidence must be a bounded array");
  }
  let previous = null;
  const folded = new Set();
  const validated = value.map((entry, index) => {
    assertExactKeys(entry, ["path", "sha256"], "prerequisiteEvidence[" + index + "]");
    requireArtifactPath(entry.path, "prerequisiteEvidence[" + index + "].path");
    requireSha256(entry.sha256, "prerequisiteEvidence[" + index + "].sha256");
    if (previous !== null && compareUtf8(previous, entry.path) >= 0) {
      fail("NATIVE_ACTION_PLAN_PREREQUISITES", "prerequisiteEvidence must be strictly path sorted");
    }
    const foldedPath = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(foldedPath)) {
      fail(
        "NATIVE_ACTION_PLAN_PREREQUISITES",
        "prerequisiteEvidence contains a Windows path collision",
      );
    }
    folded.add(foldedPath);
    previous = entry.path;
    return { path: entry.path, sha256: entry.sha256 };
  });
  return validated;
}

function validateSteps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSteps) {
    fail("NATIVE_ACTION_PLAN_STEPS", "steps must be a non-empty bounded array");
  }
  const stepIds = new Set();
  return value.map((step, index) => {
    const label = "steps[" + index + "]";
    assertExactKeys(
      step,
      ["sequence", "stepId", "command", "request", "timeoutMs", "recoveryClass"],
      label,
    );
    if (step.sequence !== index + 1) {
      fail("NATIVE_ACTION_PLAN_SEQUENCE", "step sequence must be contiguous and one-based");
    }
    requireIdentifier(step.stepId, label + ".stepId");
    const foldedStepId = step.stepId.toLocaleLowerCase("en-US");
    if (stepIds.has(foldedStepId)) {
      fail("NATIVE_ACTION_PLAN_SEQUENCE", "step identifiers must be unique");
    }
    stepIds.add(foldedStepId);
    if (!NATIVE_COMMANDS.includes(step.command)) {
      fail("NATIVE_ACTION_PLAN_COMMAND", label + ".command is not allowlisted");
    }
    validateRequest(step.request);
    if (!exactObject(step.request)) {
      fail("NATIVE_ACTION_PLAN_REQUEST", label + ".request must be a plain object");
    }
    if (rootBoundCommands.has(step.command) && Object.hasOwn(step.request, "root")) {
      fail(
        "NATIVE_ACTION_PLAN_ROOT_BINDING",
        label + ".request must use the already-bound evidence root",
      );
    }
    requirePositiveInteger(step.timeoutMs, label + ".timeoutMs", maximumTimeoutMs);
    if (!PROBE_NATIVE_ACTION_PLAN_RECOVERY_CLASSES.includes(step.recoveryClass)) {
      fail("NATIVE_ACTION_PLAN_RECOVERY", label + ".recoveryClass is invalid");
    }
    if (step.recoveryClass === "read-only-replay" && !readOnlyCommands.has(step.command)) {
      fail(
        "NATIVE_ACTION_PLAN_RECOVERY",
        "read-only-replay cannot authorize a state-changing native command",
      );
    }
    return {
      sequence: step.sequence,
      stepId: step.stepId,
      command: step.command,
      request: step.request,
      timeoutMs: step.timeoutMs,
      recoveryClass: step.recoveryClass,
    };
  });
}

function validatePlanIdentity(value) {
  if (
    value.schemaVersion !== PROBE_NATIVE_ACTION_PLAN_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-native-action-plan" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail("NATIVE_ACTION_PLAN_IDENTITY", "action plan campaign identity is invalid");
  }
  for (const key of ["candidateSha256", "scenarioPlanSha256", "evidenceRootObjectIdentitySha256"]) {
    requireSha256(value[key], "actionPlan." + key);
  }
  for (const key of [
    "campaignRunId",
    "executionRunId",
    "attemptId",
    "workId",
    "variantId",
    "producerActionId",
    "consumerActionId",
    "operationId",
  ]) {
    requireIdentifier(value[key], "actionPlan." + key);
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("NATIVE_ACTION_PLAN_COORDINATE", "actionPlan.environmentId is invalid");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("NATIVE_ACTION_PLAN_COORDINATE", "actionPlan.pathProfileId is invalid");
  }
  if (typeof value.rowId !== "string" || !rowIdPattern.test(value.rowId)) {
    fail("NATIVE_ACTION_PLAN_COORDINATE", "actionPlan.rowId is invalid");
  }
}

function actionPlanDigestPayload(value) {
  const { actionPlanSha256: _actionPlanSha256, ...payload } = value;
  return payload;
}

export function deriveProbeNativeActionPlanDigest(value) {
  if (!exactObject(value)) {
    fail("NATIVE_ACTION_PLAN_SCHEMA", "action plan must be a plain object");
  }
  assertExactKeys(
    value,
    Object.hasOwn(value, "actionPlanSha256") ? planKeys : planDraftKeys,
    "action plan",
  );
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-native-action-plan.v1",
    actionPlan: actionPlanDigestPayload(value),
  });
}

export function validateProbeNativeActionPlan(value) {
  assertExactKeys(value, planKeys, "action plan");
  validatePlanIdentity(value);
  const steps = validateSteps(value.steps);
  const prerequisiteEvidence = validatePrerequisiteEvidence(value.prerequisiteEvidence);
  requireSha256(value.actionPlanSha256, "actionPlan.actionPlanSha256");
  if (value.actionPlanSha256 !== deriveProbeNativeActionPlanDigest(value)) {
    fail("NATIVE_ACTION_PLAN_DIGEST", "action plan digest is invalid");
  }
  return deepFreeze({
    ...value,
    steps,
    prerequisiteEvidence,
  });
}

export function createProbeNativeActionPlan(input) {
  assertExactKeys(input, createInputKeys, "action plan creation input");
  const draft = {
    schemaVersion: PROBE_NATIVE_ACTION_PLAN_SCHEMA_VERSION,
    kind: "windows-host-probe-native-action-plan",
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    ...input,
  };
  validatePlanIdentity(draft);
  validateSteps(draft.steps);
  validatePrerequisiteEvidence(draft.prerequisiteEvidence);
  return validateProbeNativeActionPlan({
    ...draft,
    actionPlanSha256: deriveProbeNativeActionPlanDigest(draft),
  });
}

export function probeNativeActionPlanPath({ campaignRunId, attemptId, workId, consumerActionId }) {
  for (const [value, label] of [
    [campaignRunId, "campaignRunId"],
    [attemptId, "attemptId"],
    [workId, "workId"],
    [consumerActionId, "consumerActionId"],
  ]) {
    requireIdentifier(value, "action plan path " + label);
  }
  return [
    "runtime",
    "work",
    campaignRunId,
    attemptId,
    workId,
    "driver-plans",
    consumerActionId + ".json",
  ].join("/");
}

export function deriveProbeNativeActionPlanStepOperationId(value, stepId) {
  const plan = validateProbeNativeActionPlan(value);
  requireIdentifier(stepId, "native action plan step operation stepId");
  const step = plan.steps.find((entry) => entry.stepId === stepId);
  if (step === undefined) {
    fail("NATIVE_ACTION_PLAN_STEP", "native action plan step is not present");
  }
  const digest = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-native-action-plan-step-operation.v1",
    actionPlanSha256: plan.actionPlanSha256,
    operationId: plan.operationId,
    sequence: step.sequence,
    stepId: step.stepId,
    command: step.command,
  });
  return "native-step-" + digest.slice(0, 32);
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

function canonicalEqual(left, right) {
  return hashProbeCanonicalJson(left) === hashProbeCanonicalJson(right);
}

export function verifyProbeNativeActionPlanBinding(value, input) {
  const plan = validateProbeNativeActionPlan(value);
  assertExactKeys(
    input,
    [
      "command",
      "workItem",
      "preparedContext",
      "invocation",
      "operationId",
      "evidenceRootObjectIdentitySha256",
    ],
    "action plan binding input",
  );
  if (
    !exactObject(input.command) ||
    !exactObject(input.workItem) ||
    !exactObject(input.preparedContext) ||
    !exactObject(input.invocation)
  ) {
    fail("NATIVE_ACTION_PLAN_BINDING", "action plan binding inputs must be plain objects");
  }
  requireIdentifier(input.operationId, "action plan binding operationId");
  requireSha256(
    input.evidenceRootObjectIdentitySha256,
    "action plan binding evidenceRootObjectIdentitySha256",
  );
  const trustedWorkItem = getProbeRunWorkItem({
    environmentId: input.command.environmentId,
    pathProfileId: input.command.pathProfileId,
    rowId: input.command.rowId,
    variantId: input.command.variantId,
  });
  if (!canonicalEqual(input.workItem, trustedWorkItem)) {
    fail("NATIVE_ACTION_PLAN_WORK", "action plan work item differs from the frozen run plan");
  }
  const definition = getProbeScenarioDefinition(input.command.rowId, input.command.variantId);
  const consumer = definition.actions.find(
    (action) => action.actionId === input.invocation.action?.actionId,
  );
  const producer = definition.actions.find((action) => action.actionId === plan.producerActionId);
  if (
    consumer === undefined ||
    producer === undefined ||
    input.invocation.schemaVersion !== 1 ||
    input.invocation.kind !== "windows-host-probe-scenario-action-invocation" ||
    input.invocation.rowId !== definition.rowId ||
    input.invocation.variantId !== definition.variantId ||
    input.invocation.planSha256 !== definition.planSha256 ||
    !canonicalEqual(input.invocation.action, consumer)
  ) {
    fail("NATIVE_ACTION_PLAN_SCENARIO", "action plan invocation is not a frozen scenario action");
  }
  if (
    consumer.actor !== "native-helper" ||
    producer.actor !== "external-controller" ||
    producer.sequence >= consumer.sequence ||
    plan.consumerActionId !== consumer.actionId ||
    !plan.steps.some((step) => step.command === consumer.operation)
  ) {
    fail("NATIVE_ACTION_PLAN_HANDOFF", "action plan producer/consumer handoff is invalid");
  }
  const bindings = [
    [plan.campaignRunId, input.command.campaignRunId],
    [plan.executionRunId, input.preparedContext.executionRunId],
    [plan.attemptId, input.command.attemptId],
    [plan.workId, input.command.workId],
    [plan.environmentId, input.command.environmentId],
    [plan.pathProfileId, input.command.pathProfileId],
    [plan.rowId, input.command.rowId],
    [plan.variantId, input.command.variantId],
    [plan.scenarioPlanSha256, definition.planSha256],
    [plan.operationId, input.operationId],
    [plan.candidateSha256, input.preparedContext.candidateSha256],
    [plan.evidenceRootObjectIdentitySha256, input.evidenceRootObjectIdentitySha256],
    [input.preparedContext.campaignRunId, input.command.campaignRunId],
    [input.preparedContext.attemptId, input.command.attemptId],
    [input.preparedContext.environmentId, input.command.environmentId],
    [input.preparedContext.pathProfileId, input.command.pathProfileId],
    [input.command.planSha256, PROBE_RUN_PLAN_SHA256],
  ];
  if (bindings.some(([actual, expected]) => actual !== expected)) {
    fail("NATIVE_ACTION_PLAN_BINDING", "action plan is bound to another execution coordinate");
  }
  return plan;
}
