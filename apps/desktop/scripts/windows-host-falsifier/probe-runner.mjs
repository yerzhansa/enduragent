import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  hashProbeCanonicalJson,
  validateProbeCampaignManifest,
} from "./probe-contract.mjs";
import { getProbeTranscriptFactDefinition, getProbeVerifierDefinition } from "./probe-registry.mjs";

export const PROBE_RUNNER_SCHEMA_VERSION = 1;
export const PROBE_RUNNER_COMMANDS = Object.freeze([
  "prepare",
  "segment",
  "checkpoint",
  "resume",
  "finalize",
]);
export const PROBE_RUNNER_EXPECTED_WORK_COUNT = 1044;

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const flagPattern = /^--([a-z][a-z0-9-]*)=(.*)$/u;
const runPlanDomain = "enduragent.windows-host-probe-run-plan.v1";
const continuationIdentityDomain = "enduragent.windows-host-probe-runner-continuation.v1";

export class ProbeRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeRunnerError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required) {
  if (!exactObject(value)) fail("RUNNER_SCHEMA_OBJECT", "runner value must be an object");
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("RUNNER_SCHEMA_UNKNOWN_KEY", `unexpected runner key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("RUNNER_SCHEMA_MISSING_KEY", `missing runner key: ${key}`);
    }
  }
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("RUNNER_IDENTIFIER", `${label} must be lowercase kebab-case`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("RUNNER_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requirePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("RUNNER_INTEGER", `${label} must be a bounded positive integer`);
  }
  return value;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function runPlanDigestPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    workCount: value.workCount,
    conditionalWorkCount: value.conditionalWorkCount,
    hardCutWorkCount: value.hardCutWorkCount,
    stages: value.stages,
    work: value.work,
  };
}

function deriveRunPlanDigest(value) {
  return hashProbeCanonicalJson({
    domain: runPlanDomain,
    plan: runPlanDigestPayload(value),
  });
}

function dependencyStages(rows) {
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  for (const row of rows) {
    for (const dependency of row.dependsOnRowIds) {
      if (!rowById.has(dependency)) {
        fail("RUNNER_DEPENDENCY_UNKNOWN", `${row.rowId} depends on an unknown row`);
      }
    }
  }
  const unassigned = new Set(rowById.keys());
  const stageByRow = new Map();
  const stages = [];
  while (unassigned.size > 0) {
    const rowIds = [...unassigned]
      .filter((rowId) => {
        const row = rowById.get(rowId);
        return row.dependsOnRowIds.every((dependency) => stageByRow.has(dependency));
      })
      .sort(compareUtf8);
    if (rowIds.length === 0) {
      fail("RUNNER_DEPENDENCY_CYCLE", "campaign rows contain a dependency cycle");
    }
    const stageIndex = stages.length;
    for (const rowId of rowIds) {
      stageByRow.set(rowId, stageIndex);
      unassigned.delete(rowId);
    }
    stages.push({ stageIndex, rowIds });
  }
  return { stages, stageByRow, rowById };
}

function variantsForRow(row) {
  return [
    ...row.requiredVariantIds.map((variantId) => ({
      variantId,
      availability: "required",
      conditionId: null,
    })),
    ...row.conditionalVariants.map(({ variantId, conditionId }) => ({
      variantId,
      availability: "conditional",
      conditionId,
    })),
  ].sort((left, right) => compareUtf8(left.variantId, right.variantId));
}

export function deriveProbeRunPlan(manifest = PROBE_CAMPAIGN_MANIFEST) {
  validateProbeCampaignManifest(manifest);
  const { stages: dependencyStageDrafts, stageByRow, rowById } = dependencyStages(manifest.rows);
  const work = [];
  const stages = [];
  let conditionalWorkCount = 0;
  let hardCutWorkCount = 0;
  for (const stageDraft of dependencyStageDrafts) {
    const firstOrdinal = work.length + 1;
    const dependencyStageIndexes = [
      ...new Set(
        stageDraft.rowIds.flatMap((rowId) =>
          rowById.get(rowId).dependsOnRowIds.map((dependency) => stageByRow.get(dependency)),
        ),
      ),
    ].sort((left, right) => left - right);
    for (const rowId of stageDraft.rowIds) {
      const row = rowById.get(rowId);
      const variants = variantsForRow(row);
      for (const environmentId of manifest.environmentIds) {
        for (const pathProfileId of manifest.pathProfileIds) {
          for (const variant of variants) {
            const definition = getProbeVerifierDefinition(rowId, variant.variantId);
            const transcriptDefinition = getProbeTranscriptFactDefinition(rowId, variant.variantId);
            if (definition.conditionId !== variant.conditionId) {
              fail(
                "RUNNER_REGISTRY_DRIFT",
                `${rowId}/${variant.variantId} condition differs from the manifest`,
              );
            }
            const requiresExternalCheckpoint = variant.variantId.startsWith("f07-hard-cut-");
            const ordinal = work.length + 1;
            if (variant.availability === "conditional") conditionalWorkCount += 1;
            if (requiresExternalCheckpoint) hardCutWorkCount += 1;
            work.push({
              ordinal,
              workId: `work-${String(ordinal).padStart(4, "0")}`,
              stageIndex: stageDraft.stageIndex,
              environmentId,
              pathProfileId,
              rowId,
              variantId: variant.variantId,
              availability: variant.availability,
              conditionId: variant.conditionId,
              dependsOnRowIds: [...row.dependsOnRowIds],
              verifierId: definition.verifierId,
              verifierDefinitionSha256: definition.definitionSha256,
              transcriptKind: transcriptDefinition.transcriptKind,
              transcriptMappingSha256: transcriptDefinition.mappingSha256,
              transcriptCommandIds: transcriptDefinition.commands.map(({ commandId }) => commandId),
              mechanismId: definition.mechanismId,
              continuationRepetitions: requiresExternalCheckpoint
                ? manifest.parameters.f07Durability.repetitionsPerHardCutCheckpoint
                : 1,
              requiresExternalCheckpoint,
            });
          }
        }
      }
    }
    stages.push({
      stageIndex: stageDraft.stageIndex,
      rowIds: [...stageDraft.rowIds],
      dependencyStageIndexes,
      firstWorkOrdinal: firstOrdinal,
      lastWorkOrdinal: work.length,
      workCount: work.length - firstOrdinal + 1,
    });
  }
  if (
    manifest.campaignId === PROBE_CAMPAIGN_ID &&
    work.length !== PROBE_RUNNER_EXPECTED_WORK_COUNT
  ) {
    fail(
      "RUNNER_WORK_COUNT",
      `frozen campaign must enumerate ${PROBE_RUNNER_EXPECTED_WORK_COUNT} work items`,
    );
  }
  const draft = {
    schemaVersion: PROBE_RUNNER_SCHEMA_VERSION,
    kind: "windows-host-probe-run-plan",
    campaignId: manifest.campaignId,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    workCount: work.length,
    conditionalWorkCount,
    hardCutWorkCount,
    stages,
    work,
  };
  return deepFreeze({ ...draft, planSha256: deriveRunPlanDigest(draft) });
}

export const PROBE_RUN_PLAN = deriveProbeRunPlan();
export const PROBE_RUN_PLAN_SHA256 = PROBE_RUN_PLAN.planSha256;

export function validateProbeRunPlan(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "manifestSha256",
    "workCount",
    "conditionalWorkCount",
    "hardCutWorkCount",
    "stages",
    "work",
    "planSha256",
  ]);
  requireSha256(value.planSha256, "plan.planSha256");
  if (value.planSha256 !== deriveRunPlanDigest(value)) {
    fail("RUNNER_PLAN_DIGEST", "run plan digest is inconsistent");
  }
  if (canonicalProbeJson(value) !== canonicalProbeJson(PROBE_RUN_PLAN)) {
    fail("RUNNER_PLAN_IMMUTABLE", "run plan differs from the frozen authoritative plan");
  }
  return PROBE_RUN_PLAN;
}

function coordinateKey(environmentId, pathProfileId, rowId, variantId) {
  return [environmentId, pathProfileId, rowId, variantId].join("\0");
}

const WORK_BY_COORDINATE = new Map(
  PROBE_RUN_PLAN.work.map((item) => [
    coordinateKey(item.environmentId, item.pathProfileId, item.rowId, item.variantId),
    item,
  ]),
);

export function getProbeRunWorkItem({ environmentId, pathProfileId, rowId, variantId }) {
  const item = WORK_BY_COORDINATE.get(
    coordinateKey(environmentId, pathProfileId, rowId, variantId),
  );
  if (item === undefined) {
    fail("RUNNER_COORDINATE", "coordinate is not part of the frozen run plan");
  }
  return item;
}

export function extractProbeDependencySelection(campaignResult, rowId) {
  assertExactKeys(campaignResult, [
    "schemaVersion",
    "kind",
    "authority",
    "campaignId",
    "manifestSha256",
    "candidateSha256",
    "phase",
    "status",
    "selectionEligible",
    "rowClosureClaimed",
    "issues",
    "rowResults",
    "analysisSha256",
    "verifiedSegmentDigests",
    "campaignResultSha256",
  ]);
  if (
    campaignResult.schemaVersion !== 1 ||
    campaignResult.kind !== "windows-host-probe-campaign-result" ||
    campaignResult.authority !== "verified-artifact-finalizer" ||
    campaignResult.campaignId !== PROBE_CAMPAIGN_ID ||
    campaignResult.manifestSha256 !== PROBE_CAMPAIGN_MANIFEST_SHA256 ||
    campaignResult.phase !== "probe" ||
    campaignResult.rowClosureClaimed !== false
  ) {
    fail("RUNNER_SELECTION_RESULT", "dependency analysis is not an authoritative finalizer result");
  }
  requireSha256(campaignResult.candidateSha256, "campaignResult.candidateSha256");
  requireSha256(campaignResult.analysisSha256, "campaignResult.analysisSha256");
  requireSha256(campaignResult.campaignResultSha256, "campaignResult.campaignResultSha256");
  if (!Array.isArray(campaignResult.issues) || campaignResult.issues.length !== 0) {
    fail("RUNNER_SELECTION_ISSUES", "dependency analysis retains campaign issues");
  }
  if (!Array.isArray(campaignResult.rowResults)) {
    fail("RUNNER_SELECTION_ROWS", "dependency analysis rowResults must be an array");
  }
  const expectedRowIds = new Set(PROBE_CAMPAIGN_MANIFEST.rows.map((row) => row.rowId));
  if (!expectedRowIds.has(rowId)) fail("RUNNER_SELECTION_ROW", "dependency row is not in the plan");
  const matches = campaignResult.rowResults.filter((row) => row?.rowId === rowId);
  if (matches.length !== 1) {
    fail("RUNNER_SELECTION_ROW", "dependency analysis must contain the row exactly once");
  }
  const row = matches[0];
  assertExactKeys(row, [
    "rowId",
    "claim",
    "stopCondition",
    "status",
    "stopConditionTriggered",
    "selectedMechanism",
    "mechanismDefinitionSha256",
    "verifierBindings",
    "verificationInputSha256",
    "rowEvidenceSha256",
    "upstreamSelectionDigests",
    "selectionDigest",
    "blockedByRowIds",
    "environmentEvidenceRefs",
    "expectedSegmentCount",
    "observedSegmentCount",
    "missingSegments",
    "inconclusiveSegments",
    "skippedConditionalSegments",
    "rowClosureClaimed",
  ]);
  if (
    row.status !== "PASS" ||
    row.rowClosureClaimed !== false ||
    row.expectedSegmentCount !== row.observedSegmentCount ||
    !Number.isSafeInteger(row.expectedSegmentCount) ||
    row.expectedSegmentCount < 1 ||
    !Array.isArray(row.missingSegments) ||
    row.missingSegments.length !== 0 ||
    !Array.isArray(row.inconclusiveSegments) ||
    row.inconclusiveSegments.length !== 0 ||
    !Array.isArray(row.blockedByRowIds) ||
    row.blockedByRowIds.length !== 0
  ) {
    fail("RUNNER_SELECTION_INCOMPLETE", `${rowId} is not a complete PASS dependency row`);
  }
  return deepFreeze({
    rowId,
    selectionDigest: requireSha256(row.selectionDigest, `${rowId}.selectionDigest`),
  });
}

export function deriveProbeWorkUpstreamSelectionDigests(campaignResult, workItem) {
  const trustedWorkItem = getProbeRunWorkItem(workItem);
  return deepFreeze(
    trustedWorkItem.dependsOnRowIds
      .map((rowId) => extractProbeDependencySelection(campaignResult, rowId).selectionDigest)
      .sort(compareUtf8),
  );
}

function parseFlags(argv) {
  if (!Array.isArray(argv)) fail("RUNNER_ARGUMENT", "runner arguments must be an array");
  const flags = new Map();
  for (const argument of argv) {
    if (typeof argument !== "string") fail("RUNNER_ARGUMENT", "runner argument must be a string");
    const match = flagPattern.exec(argument);
    if (match === null) fail("RUNNER_ARGUMENT", `invalid runner argument: ${argument}`);
    if (flags.has(match[1])) {
      fail("RUNNER_ARGUMENT_DUPLICATE", `duplicate runner argument: --${match[1]}`);
    }
    flags.set(match[1], match[2]);
  }
  return flags;
}

function requireFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) {
    fail("RUNNER_ARGUMENT_MISSING", `missing runner argument: --${name}`);
  }
  return value;
}

function assertFlagSet(flags, expected) {
  const permitted = new Set(expected);
  for (const name of flags.keys()) {
    if (!permitted.has(name)) {
      fail("RUNNER_ARGUMENT_UNKNOWN", `unknown runner argument: --${name}`);
    }
  }
  for (const name of expected) requireFlag(flags, name);
}

function parseEnvironment(flags) {
  const environmentId = requireFlag(flags, "environment-id");
  const pathProfileId = requireFlag(flags, "path-profile-id");
  if (!PROBE_ENVIRONMENT_IDS.includes(environmentId)) {
    fail("RUNNER_ENVIRONMENT", "environment-id is not part of the campaign");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(pathProfileId)) {
    fail("RUNNER_PATH_PROFILE", "path-profile-id is not part of the campaign");
  }
  return { environmentId, pathProfileId };
}

function parseCoordinate(flags) {
  const environment = parseEnvironment(flags);
  const rowId = requireFlag(flags, "row-id");
  const variantId = requireFlag(flags, "variant-id");
  const workItem = getProbeRunWorkItem({ ...environment, rowId, variantId });
  return { ...environment, rowId, variantId, workItem };
}

function commonCommand(flags, command) {
  const campaignRunId = requireIdentifier(requireFlag(flags, "campaign-run-id"), "campaign-run-id");
  const planSha256 = requireSha256(requireFlag(flags, "plan-sha256"), "plan-sha256");
  if (planSha256 !== PROBE_RUN_PLAN_SHA256) {
    fail("RUNNER_PLAN_BINDING", "command is not bound to the frozen run plan");
  }
  return {
    schemaVersion: PROBE_RUNNER_SCHEMA_VERSION,
    kind: "windows-host-probe-runner-command",
    mode: "authoritative",
    command,
    campaignRunId,
    planSha256,
  };
}

function segmentCommandFields(flags) {
  const coordinate = parseCoordinate(flags);
  return {
    attemptId: requireIdentifier(requireFlag(flags, "attempt-id"), "attempt-id"),
    environmentId: coordinate.environmentId,
    pathProfileId: coordinate.pathProfileId,
    rowId: coordinate.rowId,
    variantId: coordinate.variantId,
    workId: coordinate.workItem.workId,
    stageIndex: coordinate.workItem.stageIndex,
  };
}

function continuationFields(command, common, segment, flags) {
  const workItem = getProbeRunWorkItem(segment);
  if (!workItem.requiresExternalCheckpoint) {
    fail("RUNNER_CHECKPOINT_COORDINATE", `${command} requires an F-07 hard-cut coordinate`);
  }
  const repetitionText = requireFlag(flags, "repetition");
  if (!/^[1-9]\d*$/u.test(repetitionText)) {
    fail("RUNNER_INTEGER", "repetition must be a positive integer");
  }
  const repetition = requirePositiveInteger(
    Number(repetitionText),
    "repetition",
    workItem.continuationRepetitions,
  );
  const identitySha256 = hashProbeCanonicalJson({
    domain: continuationIdentityDomain,
    campaignRunId: common.campaignRunId,
    attemptId: segment.attemptId,
    workId: segment.workId,
    repetition,
  });
  return {
    repetition,
    checkpointId: `checkpoint-${repetition}`,
    chainId: `chain-${identitySha256.slice(0, 32)}`,
  };
}

export function parseAuthoritativeProbeCommand(argv) {
  const flags = parseFlags(argv);
  if (requireFlag(flags, "mode") !== "authoritative") {
    fail("RUNNER_MODE", "authoritative runner requires --mode=authoritative");
  }
  const command = requireFlag(flags, "command");
  if (!PROBE_RUNNER_COMMANDS.includes(command)) {
    fail("RUNNER_COMMAND", "runner command is not allowlisted");
  }
  const baseFlags = ["mode", "command", "campaign-run-id", "plan-sha256"];
  if (command === "prepare") {
    assertFlagSet(flags, [
      ...baseFlags,
      "execution-run-id",
      "execution-bundle-id",
      "attempt-id",
      "environment-id",
      "path-profile-id",
    ]);
    const environment = parseEnvironment(flags);
    return deepFreeze({
      ...commonCommand(flags, command),
      executionRunId: requireIdentifier(requireFlag(flags, "execution-run-id"), "execution-run-id"),
      executionBundleId: requireIdentifier(
        requireFlag(flags, "execution-bundle-id"),
        "execution-bundle-id",
      ),
      attemptId: requireIdentifier(requireFlag(flags, "attempt-id"), "attempt-id"),
      ...environment,
      preparationId: `prepare-${environment.environmentId}-${environment.pathProfileId}`,
    });
  }
  if (command === "segment") {
    assertFlagSet(flags, [
      ...baseFlags,
      "attempt-id",
      "environment-id",
      "path-profile-id",
      "row-id",
      "variant-id",
    ]);
    return deepFreeze({
      ...commonCommand(flags, command),
      ...segmentCommandFields(flags),
    });
  }
  if (command === "checkpoint" || command === "resume") {
    assertFlagSet(flags, [
      ...baseFlags,
      "attempt-id",
      "environment-id",
      "path-profile-id",
      "row-id",
      "variant-id",
      "repetition",
    ]);
    const common = commonCommand(flags, command);
    const segment = segmentCommandFields(flags);
    return deepFreeze({
      ...common,
      ...segment,
      ...continuationFields(command, common, segment, flags),
    });
  }
  const scope = requireFlag(flags, "scope");
  if (scope === "campaign") {
    assertFlagSet(flags, [...baseFlags, "scope"]);
    return deepFreeze({ ...commonCommand(flags, command), scope });
  }
  if (scope !== "segment") {
    fail("RUNNER_FINALIZE_SCOPE", "finalize scope must be segment or campaign");
  }
  assertFlagSet(flags, [
    ...baseFlags,
    "scope",
    "attempt-id",
    "environment-id",
    "path-profile-id",
    "row-id",
    "variant-id",
  ]);
  return deepFreeze({
    ...commonCommand(flags, command),
    scope,
    ...segmentCommandFields(flags),
  });
}

function expectedCommandKeys(command) {
  const base = ["schemaVersion", "kind", "mode", "command", "campaignRunId", "planSha256"];
  const segment = [
    "attemptId",
    "environmentId",
    "pathProfileId",
    "rowId",
    "variantId",
    "workId",
    "stageIndex",
  ];
  if (command.command === "prepare") {
    return [
      ...base,
      "executionRunId",
      "executionBundleId",
      "attemptId",
      "environmentId",
      "pathProfileId",
      "preparationId",
    ];
  }
  if (command.command === "segment") return [...base, ...segment];
  if (command.command === "checkpoint" || command.command === "resume") {
    return [...base, ...segment, "repetition", "checkpointId", "chainId"];
  }
  return command.scope === "campaign" ? [...base, "scope"] : [...base, "scope", ...segment];
}

export function validateAuthoritativeProbeCommand(value) {
  if (!exactObject(value)) fail("RUNNER_SCHEMA_OBJECT", "runner command must be an object");
  if (!PROBE_RUNNER_COMMANDS.includes(value.command)) {
    fail("RUNNER_COMMAND", "runner command is not allowlisted");
  }
  assertExactKeys(value, expectedCommandKeys(value));
  if (
    value.schemaVersion !== PROBE_RUNNER_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-runner-command" ||
    value.mode !== "authoritative"
  ) {
    fail("RUNNER_COMMAND_SCHEMA", "runner command identity is invalid");
  }
  const common = {
    campaignRunId: requireIdentifier(value.campaignRunId, "campaignRunId"),
    planSha256: requireSha256(value.planSha256, "planSha256"),
  };
  if (common.planSha256 !== PROBE_RUN_PLAN_SHA256) {
    fail("RUNNER_PLAN_BINDING", "command is not bound to the frozen run plan");
  }
  if (value.command === "prepare") {
    requireIdentifier(value.executionRunId, "executionRunId");
    requireIdentifier(value.executionBundleId, "executionBundleId");
    requireIdentifier(value.attemptId, "attemptId");
    if (
      !PROBE_ENVIRONMENT_IDS.includes(value.environmentId) ||
      !PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId) ||
      value.preparationId !== `prepare-${value.environmentId}-${value.pathProfileId}`
    ) {
      fail("RUNNER_PREPARATION", "prepare command binding is invalid");
    }
  } else if (value.command !== "finalize" || value.scope === "segment") {
    requireIdentifier(value.attemptId, "attemptId");
    const item = getProbeRunWorkItem(value);
    if (value.workId !== item.workId || value.stageIndex !== item.stageIndex) {
      fail("RUNNER_COORDINATE_BINDING", "command work binding is invalid");
    }
    if (value.command === "checkpoint" || value.command === "resume") {
      if (!item.requiresExternalCheckpoint) {
        fail("RUNNER_CHECKPOINT_COORDINATE", "continuation command is not a hard-cut work item");
      }
      requirePositiveInteger(value.repetition, "repetition", item.continuationRepetitions);
      const identitySha256 = hashProbeCanonicalJson({
        domain: continuationIdentityDomain,
        campaignRunId: value.campaignRunId,
        attemptId: value.attemptId,
        workId: value.workId,
        repetition: value.repetition,
      });
      if (
        value.checkpointId !== `checkpoint-${value.repetition}` ||
        value.chainId !== `chain-${identitySha256.slice(0, 32)}`
      ) {
        fail("RUNNER_CONTINUATION_BINDING", "continuation command identity is invalid");
      }
    }
  } else if (value.scope !== "campaign") {
    fail("RUNNER_FINALIZE_SCOPE", "finalize scope is invalid");
  }
  return deepFreeze(value);
}

function requireDispatcher(dispatchers, name) {
  const dispatcher = dispatchers?.[name];
  if (typeof dispatcher !== "function") {
    fail("RUNNER_DISPATCHER_MISSING", `authoritative ${name} dispatcher is not installed`);
  }
  return dispatcher;
}

export async function dispatchAuthoritativeProbeCommand(command, dispatchers) {
  const validated = validateAuthoritativeProbeCommand(command);
  if (validated.command === "prepare") {
    return requireDispatcher(dispatchers, "prepare")({ command: validated, plan: PROBE_RUN_PLAN });
  }
  if (validated.command === "segment") {
    return requireDispatcher(
      dispatchers,
      "segment",
    )({
      command: validated,
      plan: PROBE_RUN_PLAN,
      workItem: getProbeRunWorkItem(validated),
    });
  }
  if (validated.command === "checkpoint") {
    return requireDispatcher(
      dispatchers,
      "checkpoint",
    )({
      command: validated,
      plan: PROBE_RUN_PLAN,
      workItem: getProbeRunWorkItem(validated),
    });
  }
  if (validated.command === "resume") {
    return requireDispatcher(
      dispatchers,
      "resume",
    )({
      command: validated,
      plan: PROBE_RUN_PLAN,
      workItem: getProbeRunWorkItem(validated),
    });
  }
  if (validated.scope === "segment") {
    return requireDispatcher(
      dispatchers,
      "finalizeSegment",
    )({
      command: validated,
      plan: PROBE_RUN_PLAN,
      workItem: getProbeRunWorkItem(validated),
    });
  }
  return requireDispatcher(
    dispatchers,
    "finalizeCampaign",
  )({
    command: validated,
    plan: PROBE_RUN_PLAN,
  });
}
