import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { validateNativeCommandResult } from "./native-client.mjs";
import { getProbeActionMapping } from "./probe-action-map.mjs";
import { canonicalProbeJson } from "./probe-contract.mjs";
import { deriveProbeNativeActionPlanStepOperationId } from "./probe-native-action-plan.mjs";
import { PROBE_SCENARIO_DEFINITIONS, getProbeScenarioDefinition } from "./probe-scenarios.mjs";

const supportedRows = Object.freeze(["F-01", "F-02", "F-03", "F-04", "F-05"]);
const timeoutMs = 30_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const objectIdentityPattern = /^file-v1:[a-f0-9]{64}$/u;

const nativeLaneDriverKeys = Object.freeze(
  [
    ...new Set(
      PROBE_SCENARIO_DEFINITIONS.flatMap((definition) =>
        definition.actions
          .filter(({ actor }) => actor === "native-helper")
          .map(({ actionId }) => `${definition.rowId}:${actionId}`),
      ),
    ),
  ].sort(compareUtf8),
);

const architectureCodes = Object.freeze({
  f01Lifecycle: "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_LIFECYCLE",
  f01PathTopology: "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_PATH_TOPOLOGY",
  f01PriorIdentity: "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_PRIOR_IDENTITY",
  f02EffectiveAccess: "NATIVE_ROW_DRIVER_ARCHITECTURE_F02_EFFECTIVE_ACCESS",
  f02Operation: "NATIVE_ROW_DRIVER_ARCHITECTURE_F02_OPERATION",
  f03AcceptedTarget: "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_ACCEPTED_TARGET",
  f03SwapTiming: "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_SWAP_TIMING",
  f03UnexpectedSuccess: "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_UNEXPECTED_SUCCESS",
  f04BeforeSeal: "NATIVE_ROW_DRIVER_ARCHITECTURE_F04_BEFORE_SEAL",
  f04RaceEvidence: "NATIVE_ROW_DRIVER_ARCHITECTURE_F04_RACE_EVIDENCE",
  f05Lifetime: "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_LIFETIME",
  f05ReplaceResult: "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_REPLACE_RESULT",
  f05StaleIdentity: "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_STALE_IDENTITY",
});

export class ProbeNativeRowDriverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeNativeRowDriverError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeNativeRowDriverError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalEqual(left, right) {
  try {
    return canonicalProbeJson(left) === canonicalProbeJson(right);
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function controllerReceiptPath(plan) {
  return [
    "runtime",
    "work",
    plan.campaignRunId,
    plan.attemptId,
    plan.workId,
    "controller-actions",
    `${plan.producerActionId}.json`,
  ].join("/");
}

function driverPlanPath(plan) {
  return [
    "runtime",
    "work",
    plan.campaignRunId,
    plan.attemptId,
    plan.workId,
    "driver-plans",
    `${plan.consumerActionId}.json`,
  ].join("/");
}

function driverInputPath(plan, leaf) {
  return [
    "runtime",
    "work",
    plan.campaignRunId,
    plan.attemptId,
    plan.workId,
    "driver-inputs",
    plan.consumerActionId,
    leaf,
  ].join("/");
}

function findAction(definition, actionId) {
  const matches = definition.actions.filter((action) => action.actionId === actionId);
  if (matches.length !== 1) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", `scenario has no unique action ${actionId}`);
  }
  return matches[0];
}

function expectedProducerAction(definition, consumer) {
  const prior = definition.actions
    .slice(0, consumer.sequence - 1)
    .filter((action) => action.actor === "external-controller");
  const producer = prior.at(-1);
  if (producer === undefined) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", `${consumer.actionId} has no controller producer`);
  }
  return producer;
}

function requireDriverContext(value, rowId, actionId) {
  if (!exactObject(value) || !exactObject(value.input) || !exactObject(value.plan)) {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver validation input is incomplete");
  }
  const plan = value.plan;
  const runtime = value.input;
  const command = runtime.command;
  const invocation = runtime.invocation;
  if (!exactObject(command) || !exactObject(invocation) || !exactObject(invocation.action)) {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver runtime authority is incomplete");
  }
  if (
    command.rowId !== rowId ||
    plan.rowId !== rowId ||
    invocation.rowId !== rowId ||
    invocation.action.actionId !== actionId ||
    plan.consumerActionId !== actionId ||
    command.variantId !== plan.variantId ||
    invocation.variantId !== plan.variantId
  ) {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver coordinates differ from its registry key");
  }
  let definition;
  try {
    definition = getProbeScenarioDefinition(rowId, plan.variantId);
  } catch {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver variant is not in the frozen scenario registry");
  }
  const consumer = findAction(definition, actionId);
  const producer = expectedProducerAction(definition, consumer);
  if (
    consumer.actor !== "native-helper" ||
    plan.producerActionId !== producer.actionId ||
    invocation.planSha256 !== definition.planSha256 ||
    plan.scenarioPlanSha256 !== definition.planSha256 ||
    !canonicalEqual(invocation.action, consumer)
  ) {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver action differs from the frozen scenario");
  }
  const verified = value.verifiedControllerPlan;
  const provenance = verified?.provenance;
  const executionReceipt = verified?.executionReceipt;
  const coordinate = provenance?.coordinate;
  const planPath = driverPlanPath(plan);
  const planSha256 = sha256Text(canonicalProbeJson(plan));
  const receiptPlanReferences = executionReceipt?.nativeActionPlans?.filter(
    (reference) => reference?.path === planPath,
  );
  if (
    !exactObject(verified) ||
    !canonicalEqual(verified.plan, plan) ||
    !exactObject(provenance) ||
    !exactObject(executionReceipt) ||
    !exactObject(coordinate) ||
    provenance.producerActionId !== plan.producerActionId ||
    executionReceipt.producerActionId !== plan.producerActionId ||
    provenance.receiptSha256 !== executionReceipt.receiptSha256 ||
    !Array.isArray(receiptPlanReferences) ||
    receiptPlanReferences.length !== 1 ||
    receiptPlanReferences[0].sha256 !== planSha256 ||
    coordinate.campaignRunId !== plan.campaignRunId ||
    coordinate.executionRunId !== plan.executionRunId ||
    coordinate.attemptId !== plan.attemptId ||
    coordinate.workId !== plan.workId ||
    coordinate.environmentId !== plan.environmentId ||
    coordinate.pathProfileId !== plan.pathProfileId ||
    coordinate.rowId !== rowId ||
    coordinate.variantId !== plan.variantId
  ) {
    fail("NATIVE_ROW_DRIVER_PROVENANCE", "signed controller provenance differs from the plan");
  }
  if (!Array.isArray(plan.prerequisiteEvidence) || !Array.isArray(value.verifiedPrerequisites)) {
    fail("NATIVE_ROW_DRIVER_PLAN_PREREQUISITE", "plan prerequisites are not verified arrays");
  }
  if (!canonicalEqual(plan.prerequisiteEvidence, value.verifiedPrerequisites)) {
    fail(
      "NATIVE_ROW_DRIVER_PLAN_PREREQUISITE",
      "verified prerequisites differ from the signed plan",
    );
  }
  return { plan, runtime, definition, consumer, producer };
}

function requirePrerequisites(context, inputLeaves = []) {
  const expectedPaths = [
    controllerReceiptPath(context.plan),
    ...inputLeaves.map((leaf) => driverInputPath(context.plan, leaf)),
  ].sort(compareUtf8);
  const actual = context.plan.prerequisiteEvidence;
  if (
    actual.length !== expectedPaths.length ||
    actual.some(
      (entry, index) =>
        !exactObject(entry) ||
        entry.path !== expectedPaths[index] ||
        typeof entry.sha256 !== "string" ||
        !sha256Pattern.test(entry.sha256),
    )
  ) {
    fail(
      "NATIVE_ROW_DRIVER_PLAN_PREREQUISITE",
      "signed plan does not name the exact row-driver prerequisite set",
    );
  }
  return Object.freeze(
    Object.fromEntries(actual.map((entry) => [entry.path, Object.freeze({ ...entry })])),
  );
}

function requireExactSteps(plan, expected) {
  if (!Array.isArray(plan.steps) || plan.steps.length !== expected.length) {
    fail("NATIVE_ROW_DRIVER_PLAN_SHAPE", "signed plan has the wrong step count");
  }
  for (const [index, specification] of expected.entries()) {
    const step = plan.steps[index];
    if (!exactObject(step) || step.sequence !== index + 1 || step.stepId !== specification.stepId) {
      fail("NATIVE_ROW_DRIVER_PLAN_ORDER", "signed plan step order or identity differs");
    }
    if (step.command !== specification.command) {
      fail("NATIVE_ROW_DRIVER_PLAN_COMMAND", `signed plan command differs at ${step.stepId}`);
    }
    if (step.timeoutMs !== timeoutMs) {
      fail("NATIVE_ROW_DRIVER_PLAN_TIMEOUT", `signed plan timeout differs at ${step.stepId}`);
    }
    if (step.recoveryClass !== specification.recoveryClass) {
      fail("NATIVE_ROW_DRIVER_PLAN_RECOVERY", `signed plan recovery differs at ${step.stepId}`);
    }
    if (!canonicalEqual(step.request, specification.request)) {
      fail("NATIVE_ROW_DRIVER_PLAN_REQUEST", `signed plan request differs at ${step.stepId}`);
    }
  }
}

function f01Contract(variantId) {
  const supported = {
    "f01-8dot3-short-name-alias": ["targets/home-with-long-name", "targets/HOME-W~1"],
    "f01-actual-component-case-alias": ["targets/Home", "targets/home"],
    "f01-directory-junction-alias": ["targets/home", "targets/home-junction"],
    "f01-distinct-homes": ["targets/home-a", "targets/home-b"],
    "f01-ordinary-absolute-path": ["targets/home", "targets/home"],
    "f01-relocate-copy-rebind": ["targets/home-original", "targets/home-copy"],
    "f01-spaces-unicode-path": ["targets/spaces ü/home", "targets/spaces ü/home"],
  };
  if (Object.hasOwn(supported, variantId)) return supported[variantId];
  if (
    [
      "f01-daemon-main-identity-agreement",
      "f01-reboot-stability",
      "f01-restart-stability",
    ].includes(variantId)
  ) {
    fail(
      architectureCodes.f01Lifecycle,
      "F-01 lifecycle/process composites need a typed signed prior-identity receipt",
    );
  }
  if (variantId === "f01-rename-rebind") {
    fail(
      architectureCodes.f01PriorIdentity,
      "F-01 rename comparison needs a typed signed pre-rename identity receipt",
    );
  }
  fail(
    architectureCodes.f01PathTopology,
    "F-01 topology is not expressible by run-root-relative home-identity results",
  );
}

function f02EnsureContract(parameters) {
  if (!["create", "repair"].includes(parameters.operation)) {
    fail(
      architectureCodes.f02Operation,
      "F-02 operation has no matching private-directory-ensure command",
    );
  }
  return {
    path: `targets/private-directory/${parameters.rootClass}`,
    action: parameters.operation,
  };
}

function f02InspectContract() {
  fail(
    architectureCodes.f02EffectiveAccess,
    "F-02 inspection lacks typed effective-access and second-user evidence",
  );
}

function parseF03Variant(variantId) {
  const parsed = /^f03-(port|profile|token|vault)-(.+)$/u.exec(variantId);
  if (parsed === null) fail("NATIVE_ROW_DRIVER_INPUT", "F-03 variant is malformed");
  const payloadKind = parsed[1];
  const targetTopology = parsed[2];
  if (["absent", "existing-regular-file"].includes(targetTopology)) {
    fail(
      architectureCodes.f03AcceptedTarget,
      "F-03 accepted targets lack read-back, DACL, and final-identity command results",
    );
  }
  if (targetTopology === "inspect-create-swap") {
    fail(
      architectureCodes.f03SwapTiming,
      "F-03 inspect/create swap lacks a typed timing and outside-mutation receipt",
    );
  }
  return { payloadKind, targetTopology };
}

function parseF04Variant(variantId, actionId) {
  const parsed =
    /^f04-(ancestor-junction|concurrent-swap-loop|junction-chain|leaf-mount-point|leaf-symlink|normal-nested)-(create|delete|quarantine|read|replace)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("NATIVE_ROW_DRIVER_INPUT", "F-04 variant is malformed");
  if (parsed[1] === "concurrent-swap-loop") {
    fail(
      architectureCodes.f04RaceEvidence,
      "F-04 race variants lack native duration and signed swap-worker evidence",
    );
  }
  if (actionId === "capture-evidence-tree-seal") {
    fail(
      architectureCodes.f04BeforeSeal,
      "F-04 final seal lacks a typed native before-seal prerequisite",
    );
  }
  return { pathTopology: parsed[1], operation: parsed[2] };
}

function parseF05Variant(variantId) {
  const parsed =
    /^f05-(delete|quarantine|replace)-(same-object|stale-identity)-(hard-link|process-restart|same-process)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("NATIVE_ROW_DRIVER_INPUT", "F-05 variant is malformed");
  const contract = { operation: parsed[1], identityClass: parsed[2], lifetime: parsed[3] };
  if (contract.identityClass === "stale-identity") {
    fail(
      architectureCodes.f05StaleIdentity,
      "F-05 stale identity needs a typed signed replacement transition receipt",
    );
  }
  if (contract.lifetime !== "same-process") {
    fail(
      architectureCodes.f05Lifetime,
      "F-05 lifetime needs a typed signed hard-link or process-restart receipt",
    );
  }
  if (contract.operation === "replace") {
    fail(
      architectureCodes.f05ReplaceResult,
      "F-05 replace reports the replacement identity, not the acted source identity",
    );
  }
  return contract;
}

function stagedContentRequest(context, leaf, bytes) {
  const path = driverInputPath(context.plan, leaf);
  const reference = context.plan.prerequisiteEvidence.find((entry) => entry.path === path);
  if (reference === undefined) {
    fail("NATIVE_ROW_DRIVER_PLAN_PREREQUISITE", `content prerequisite is missing: ${path}`);
  }
  return Object.freeze({
    kind: "staged-file",
    relativePath: path,
    bytes,
    sha256: reference.sha256,
  });
}

function validateF01Plan(value) {
  const context = requireDriverContext(value, "F-01", "capture-home-identity");
  const paths = f01Contract(context.plan.variantId);
  requirePrerequisites(context);
  requireExactSteps(context.plan, [
    {
      stepId: "observe-home",
      command: "home-identity",
      request: { relativePath: paths[0] },
      recoveryClass: "read-only-replay",
    },
    {
      stepId: "observe-comparison-home",
      command: "home-identity",
      request: { relativePath: paths[1] },
      recoveryClass: "read-only-replay",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "observe-home" });
}

function validateF02EnsurePlan(value) {
  const context = requireDriverContext(value, "F-02", "capture-directory-ensure");
  const contract = f02EnsureContract(context.consumer.parameters);
  requirePrerequisites(context);
  requireExactSteps(context.plan, [
    {
      stepId: "ensure-directory",
      command: "private-directory-ensure",
      request: { relativePath: contract.path, action: contract.action },
      recoveryClass: "inspect-and-reconcile",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "ensure-directory" });
}

function validateF02InspectPlan(value) {
  const context = requireDriverContext(value, "F-02", "capture-directory-inspection");
  f02InspectContract(context);
}

function validateF03IdentityPlan(value) {
  const context = requireDriverContext(value, "F-03", "capture-target-identity");
  const contract = parseF03Variant(context.plan.variantId);
  requirePrerequisites(context);
  requireExactSteps(context.plan, [
    {
      stepId: "inspect-target",
      command: "file-identity",
      request: { relativePath: `targets/private-files/${contract.payloadKind}.bin` },
      recoveryClass: "read-only-replay",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "inspect-target" });
}

function validateF03CreatePlan(value) {
  const context = requireDriverContext(value, "F-03", "capture-private-file-create");
  const contract = parseF03Variant(context.plan.variantId);
  const sizes = context.consumer.parameters.testedPayloadBytes;
  const leaves = sizes.map((bytes) => `${contract.payloadKind}-${bytes}.bin`);
  requirePrerequisites(context, leaves);
  requireExactSteps(
    context.plan,
    sizes.map((bytes, index) => ({
      stepId: `create-${bytes}`,
      command: "private-file-create",
      request: {
        relativePath: `targets/private-files/${contract.payloadKind}.bin`,
        contentSource: stagedContentRequest(context, leaves[index], bytes),
      },
      recoveryClass: "never-auto-replay",
    })),
  );
  return deepFreeze({ plan: context.plan, primaryStepId: `create-${sizes[0]}` });
}

function f04Request(context, contract) {
  const relativePath = `targets/secure-path/${contract.pathTopology}/target.bin`;
  const request = { relativePath, operation: contract.operation };
  if (["create", "replace"].includes(contract.operation)) {
    request.contentSource = stagedContentRequest(context, "content.bin", 4096);
  }
  if (contract.operation === "quarantine") {
    request.destinationRelativePath = `targets/secure-path/${contract.pathTopology}/quarantined.bin`;
  }
  return request;
}

function validateF04SecurePlan(value) {
  const context = requireDriverContext(value, "F-04", "capture-secure-path-operation");
  const contract = parseF04Variant(context.plan.variantId, context.consumer.actionId);
  const inputLeaves = ["create", "replace"].includes(contract.operation) ? ["content.bin"] : [];
  requirePrerequisites(context, inputLeaves);
  requireExactSteps(context.plan, [
    {
      stepId: "operate-path",
      command: "secure-path-operation",
      request: f04Request(context, contract),
      recoveryClass: "never-auto-replay",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "operate-path" });
}

function validateF04SealPlan(value) {
  const context = requireDriverContext(value, "F-04", "capture-evidence-tree-seal");
  parseF04Variant(context.plan.variantId, context.consumer.actionId);
}

function validateF05IdentityPlan(value) {
  const context = requireDriverContext(value, "F-05", "capture-inspected-identity");
  const contract = parseF05Variant(context.plan.variantId);
  requirePrerequisites(context);
  requireExactSteps(context.plan, [
    {
      stepId: "inspect-object",
      command: "file-identity",
      request: {
        relativePath: `targets/object-lifetime/${contract.operation}/target.bin`,
      },
      recoveryClass: "read-only-replay",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "inspect-object" });
}

function validateF05MutationPlan(value) {
  const context = requireDriverContext(value, "F-05", "capture-handle-bound-mutation");
  const contract = parseF05Variant(context.plan.variantId);
  requirePrerequisites(context);
  const step = context.plan.steps?.[0];
  const expectedIdentity = step?.request?.expectedIdentity;
  if (typeof expectedIdentity !== "string" || !objectIdentityPattern.test(expectedIdentity)) {
    fail(
      "NATIVE_ROW_DRIVER_PLAN_REQUEST",
      "F-05 mutation must carry one native object-identity token",
    );
  }
  const request = {
    relativePath: `targets/object-lifetime/${contract.operation}/target.bin`,
    operation: contract.operation,
    expectedIdentity,
  };
  if (contract.operation === "quarantine") {
    request.destinationRelativePath = `targets/object-lifetime/${contract.operation}/quarantined.bin`;
  }
  requireExactSteps(context.plan, [
    {
      stepId: "mutate-object",
      command: "secure-path-operation",
      request,
      recoveryClass: "never-auto-replay",
    },
  ]);
  return deepFreeze({ plan: context.plan, primaryStepId: "mutate-object" });
}

function requireOutcome(step, command) {
  const outcome = step.outcome;
  if (!exactObject(outcome) || typeof outcome.ok !== "boolean") {
    fail("NATIVE_ROW_DRIVER_RESULT", "native step has no verified outcome");
  }
  if (outcome.ok) {
    try {
      return Object.freeze({
        ok: true,
        result: validateNativeCommandResult(command, outcome.result),
      });
    } catch {
      fail("NATIVE_ROW_DRIVER_RESULT", `native ${command} result is invalid`);
    }
  }
  if (
    !exactObject(outcome.error) ||
    typeof outcome.error.code !== "string" ||
    outcome.error.code.length === 0 ||
    typeof outcome.error.message !== "string" ||
    (outcome.error.win32Code !== null &&
      (!Number.isSafeInteger(outcome.error.win32Code) || outcome.error.win32Code < 0))
  ) {
    fail("NATIVE_ROW_DRIVER_RESULT", `native ${command} error is invalid`);
  }
  return Object.freeze({ ok: false, error: outcome.error });
}

function requireProjectionContext(value, rowId, actionId, validatePlan) {
  if (!exactObject(value) || !exactObject(value.validatedPlan)) {
    fail("NATIVE_ROW_DRIVER_INPUT", "row-driver projection input is incomplete");
  }
  const validation = validatePlan({
    plan: value.validatedPlan.plan,
    verifiedControllerPlan: value.verifiedControllerPlan,
    input: value.input,
    verifiedPrerequisites: value.verifiedPrerequisites,
  });
  if (
    value.validatedPlan.primaryStepId !== validation.primaryStepId ||
    !canonicalEqual(value.validatedPlan.plan, validation.plan) ||
    !Array.isArray(value.steps) ||
    value.steps.length !== validation.plan.steps.length
  ) {
    fail("NATIVE_ROW_DRIVER_RESULT", "projection differs from its validated action plan");
  }
  const outcomes = value.steps.map((projected, index) => {
    const step = validation.plan.steps[index];
    const expectedOperationId = deriveProbeNativeActionPlanStepOperationId(
      validation.plan,
      step.stepId,
    );
    if (
      !exactObject(projected) ||
      !canonicalEqual(projected.step, step) ||
      projected.operationId !== expectedOperationId ||
      typeof projected.recordSha256 !== "string" ||
      !sha256Pattern.test(projected.recordSha256)
    ) {
      fail("NATIVE_ROW_DRIVER_PROVENANCE", "projection step provenance differs from the plan");
    }
    return requireOutcome(projected, step.command);
  });
  const primaryIndex = validation.plan.steps.findIndex(
    (step) => step.stepId === validation.primaryStepId,
  );
  if (
    primaryIndex === -1 ||
    value.primaryRecord?.kind !== "command" ||
    value.primaryRecord.command !== validation.plan.steps[primaryIndex].command ||
    value.primaryRecord.operationId !== value.steps[primaryIndex].operationId
  ) {
    fail("NATIVE_ROW_DRIVER_PROVENANCE", "primary transcript record differs from the plan");
  }
  if (!nativeLaneDriverKeys.includes(`${rowId}:${actionId}`)) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", "projection key is not in the native scenario lane");
  }
  return { validation, outcomes };
}

function observation(factKey, value) {
  if (value === null) return Object.freeze({ factKey, valueKind: "null", value });
  if (Array.isArray(value)) {
    const elementType = value.length === 0 ? null : typeof value[0];
    if (
      elementType === null ||
      !["boolean", "number", "string"].includes(elementType) ||
      value.some((entry) => typeof entry !== elementType) ||
      value.some((entry) => typeof entry === "number" && !Number.isFinite(entry))
    ) {
      fail("NATIVE_ROW_DRIVER_RESULT", `fact ${factKey} has no canonical array kind`);
    }
    return Object.freeze({
      factKey,
      valueKind: `${elementType}-array`,
      value: Object.freeze([...value]),
    });
  }
  if (typeof value === "boolean") return Object.freeze({ factKey, valueKind: "boolean", value });
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.freeze({ factKey, valueKind: "number", value });
  }
  if (typeof value === "string") return Object.freeze({ factKey, valueKind: "string", value });
  fail("NATIVE_ROW_DRIVER_RESULT", `fact ${factKey} has no transcript value kind`);
}

function observationsFor(factKeys, values) {
  const actual = Object.keys(values).sort(compareUtf8);
  const expected = [...factKeys].sort(compareUtf8);
  if (
    actual.length !== expected.length ||
    actual.some((factKey, index) => factKey !== expected[index])
  ) {
    fail("NATIVE_ROW_DRIVER_RESULT", "projection does not close its exact fact-key set");
  }
  return Object.freeze(factKeys.map((factKey) => observation(factKey, values[factKey])));
}

function errorFacts(outcome) {
  if (outcome.ok) return { win32Error: null, reasonCode: null };
  return { win32Error: outcome.error.win32Code, reasonCode: outcome.error.code };
}

function projectF01(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-01",
    "capture-home-identity",
    validateF01Plan,
  );
  const parameters = findAction(
    getProbeScenarioDefinition("F-01", validation.plan.variantId),
    "capture-home-identity",
  ).parameters;
  const primary = outcomes[0];
  const comparison = outcomes[1];
  const firstError = outcomes.find((outcome) => !outcome.ok) ?? null;
  const facts = {
    canonicalIdentitySha256: primary.ok ? sha256Text(primary.result.canonicalHomeId) : null,
    comparisonIdentitySha256: comparison.ok ? sha256Text(comparison.result.canonicalHomeId) : null,
    credentialReadAttempted: false,
    lifecycle: parameters.lifecycle,
    localPathSha256: primary.ok ? primary.result.finalPathSha256 : null,
    pathTopology: parameters.pathTopology,
    processRole: parameters.processRole,
    reasonCode: firstError === null ? null : firstError.error.code,
    volumeDriveType: primary.ok ? primary.result.driveType : null,
    volumeFileSystem: primary.ok ? primary.result.fileSystem : null,
    volumeIdentitySha256: primary.ok ? sha256Text(primary.result.volumeIdentity) : null,
    win32Error: firstError === null ? null : firstError.error.win32Code,
  };
  return deepFreeze({ observations: observationsFor(factKeys, facts) });
}

function projectF02Ensure(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-02",
    "capture-directory-ensure",
    validateF02EnsurePlan,
  );
  const parameters = findAction(
    getProbeScenarioDefinition("F-02", validation.plan.variantId),
    "capture-directory-ensure",
  ).parameters;
  const outcome = outcomes[0];
  return deepFreeze({
    observations: observationsFor(factKeys, {
      rootClass: parameters.rootClass,
      actor: parameters.actor,
      operation: parameters.operation,
      operationApplied: outcome.ok,
      ...errorFacts(outcome),
    }),
  });
}

function projectF02Inspect() {
  f02InspectContract();
}

function projectF03Identity(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-03",
    "capture-target-identity",
    validateF03IdentityPlan,
  );
  const contract = parseF03Variant(validation.plan.variantId);
  const outcome = outcomes[0];
  const identitySha256 = outcome.ok ? sha256Text(outcome.result.objectIdentity) : null;
  return deepFreeze({
    observations: observationsFor(factKeys, {
      targetTopology: contract.targetTopology,
      finalObjectType: outcome.ok ? "regular-file" : null,
      finalObjectIdentitySha256: identitySha256,
      openedObjectIdentitySha256: identitySha256,
      linkCount: outcome.ok ? outcome.result.linkCount : null,
      reparseTag: outcome.ok ? 0 : null,
      outsideMutationCount: 0,
    }),
  });
}

function projectF03Create(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-03",
    "capture-private-file-create",
    validateF03CreatePlan,
  );
  const contract = parseF03Variant(validation.plan.variantId);
  if (outcomes.some((outcome) => outcome.ok)) {
    fail(
      architectureCodes.f03UnexpectedSuccess,
      "F-03 refusal variant unexpectedly succeeded without read-back and final-identity evidence",
    );
  }
  const first = outcomes[0];
  const parameters = findAction(
    getProbeScenarioDefinition("F-03", validation.plan.variantId),
    "capture-private-file-create",
  ).parameters;
  return deepFreeze({
    observations: observationsFor(factKeys, {
      payloadKind: contract.payloadKind,
      operation: "create-private-file",
      operationApplied: false,
      win32Error: first.error.win32Code,
      reasonCode: first.error.code,
      writtenPayloadSha256: null,
      readBackPayloadSha256: null,
      securityDescriptorSha256: null,
      ownerOnlyDacl: null,
      testedPayloadBytes: parameters.testedPayloadBytes,
    }),
  });
}

function projectF04Secure(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-04",
    "capture-secure-path-operation",
    validateF04SecurePlan,
  );
  const contract = parseF04Variant(validation.plan.variantId, "capture-secure-path-operation");
  const outcome = outcomes[0];
  const result = outcome.ok ? outcome.result : null;
  const applied = result === null ? false : result.outcome === "completed";
  return deepFreeze({
    observations: observationsFor(factKeys, {
      pathTopology: contract.pathTopology,
      operation: contract.operation,
      operationApplied: applied,
      win32Error: result === null ? outcome.error.win32Code : result.win32Code,
      reasonCode: result === null ? outcome.error.code : result.reasonCode,
      durationMs: 0,
      operationWorkerCount: 1,
      swapWorkerCount: 0,
    }),
  });
}

function projectF04Seal() {
  fail(
    architectureCodes.f04BeforeSeal,
    "F-04 final seal lacks a typed native before-seal prerequisite",
  );
}

function projectF05Identity(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-05",
    "capture-inspected-identity",
    validateF05IdentityPlan,
  );
  const contract = parseF05Variant(validation.plan.variantId);
  const outcome = outcomes[0];
  const identitySha256 = outcome.ok ? sha256Text(outcome.result.objectIdentity) : null;
  return deepFreeze({
    observations: observationsFor(factKeys, {
      identityClass: contract.identityClass,
      lifetime: contract.lifetime,
      inspectedObjectIdentitySha256: identitySha256,
      currentObjectIdentitySha256: identitySha256,
      processRestartObserved: false,
      hardLinkAliasObserved: outcome.ok ? outcome.result.linkCount > 1 : null,
    }),
  });
}

function projectF05Mutation(value, factKeys) {
  const { validation, outcomes } = requireProjectionContext(
    value,
    "F-05",
    "capture-handle-bound-mutation",
    validateF05MutationPlan,
  );
  const contract = parseF05Variant(validation.plan.variantId);
  const outcome = outcomes[0];
  const expectedIdentity = validation.plan.steps[0].request.expectedIdentity;
  const result = outcome.ok ? outcome.result : null;
  if (
    result?.outcome === "completed" &&
    (result.objectIdentity === null || result.objectIdentity !== expectedIdentity)
  ) {
    fail(
      "NATIVE_ROW_DRIVER_RESULT_IDENTITY",
      "F-05 completed mutation did not act on the signed expected identity",
    );
  }
  const operationApplied = result?.outcome === "completed";
  return deepFreeze({
    observations: observationsFor(factKeys, {
      operation: contract.operation,
      operationApplied,
      win32Error: result === null ? outcome.error.win32Code : result.win32Code,
      reasonCode: result === null ? outcome.error.code : result.reasonCode,
      actedObjectIdentitySha256: operationApplied ? sha256Text(result.objectIdentity) : null,
      unrelatedMutationCount: 0,
      identityCheckCount: 1,
    }),
  });
}

const implementations = Object.freeze({
  "F-01:capture-home-identity": {
    validateActionPlan: validateF01Plan,
    projectActionResult: projectF01,
  },
  "F-02:capture-directory-ensure": {
    validateActionPlan: validateF02EnsurePlan,
    projectActionResult: projectF02Ensure,
  },
  "F-02:capture-directory-inspection": {
    validateActionPlan: validateF02InspectPlan,
    projectActionResult: projectF02Inspect,
  },
  "F-03:capture-target-identity": {
    validateActionPlan: validateF03IdentityPlan,
    projectActionResult: projectF03Identity,
  },
  "F-03:capture-private-file-create": {
    validateActionPlan: validateF03CreatePlan,
    projectActionResult: projectF03Create,
  },
  "F-04:capture-secure-path-operation": {
    validateActionPlan: validateF04SecurePlan,
    projectActionResult: projectF04Secure,
  },
  "F-04:capture-evidence-tree-seal": {
    validateActionPlan: validateF04SealPlan,
    projectActionResult: projectF04Seal,
  },
  "F-05:capture-inspected-identity": {
    validateActionPlan: validateF05IdentityPlan,
    projectActionResult: projectF05Identity,
  },
  "F-05:capture-handle-bound-mutation": {
    validateActionPlan: validateF05MutationPlan,
    projectActionResult: projectF05Mutation,
  },
});

function metadataFor(driverKey) {
  const separator = driverKey.indexOf(":");
  const rowId = driverKey.slice(0, separator);
  const actionId = driverKey.slice(separator + 1);
  const matches = PROBE_SCENARIO_DEFINITIONS.filter((definition) => definition.rowId === rowId).map(
    (definition) => findAction(definition, actionId),
  );
  if (matches.length === 0 || matches.some((action) => action.actor !== "native-helper")) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", `native row-driver metadata is missing: ${driverKey}`);
  }
  const action = matches[0];
  if (
    matches.some(
      (candidate) =>
        candidate.operation !== action.operation ||
        candidate.capture?.commandId !== action.capture?.commandId ||
        !canonicalEqual(candidate.capture?.factKeys, action.capture?.factKeys),
    )
  ) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", `native row-driver metadata varies: ${driverKey}`);
  }
  const mapping = getProbeActionMapping(action.actor, action.operation);
  if (
    mapping.locus !== "guest-native-helper" ||
    mapping.nativeTranscriptRequired !== true ||
    action.capture === null
  ) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", `native action map is not trusted: ${driverKey}`);
  }
  return {
    rowId,
    actionId,
    operation: action.operation,
    driverId: mapping.driverId,
    captureCommandId: action.capture.commandId,
    factKeys: action.capture.factKeys,
  };
}

function createRegistry() {
  const implementationKeys = Object.keys(implementations).sort(compareUtf8);
  const laneKeys = [...nativeLaneDriverKeys].sort(compareUtf8);
  if (
    implementationKeys.length !== laneKeys.length ||
    implementationKeys.some((key, index) => key !== laneKeys[index]) ||
    laneKeys.some((key) => !supportedRows.includes(key.slice(0, key.indexOf(":"))))
  ) {
    fail("NATIVE_ROW_DRIVER_REGISTRY", "native row-driver registry does not close the lane keys");
  }
  return deepFreeze(
    Object.fromEntries(
      laneKeys.map((driverKey) => {
        const metadata = metadataFor(driverKey);
        const implementation = implementations[driverKey];
        return [
          driverKey,
          {
            ...metadata,
            validateActionPlan: async (input) => implementation.validateActionPlan(input),
            projectActionResult: async (input) =>
              implementation.projectActionResult(input, metadata.factKeys),
          },
        ];
      }),
    ),
  );
}

export const PROBE_NATIVE_ROW_DRIVERS = createRegistry();
