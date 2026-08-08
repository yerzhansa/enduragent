import { Buffer } from "node:buffer";

import { PROBE_CAMPAIGN_MANIFEST, hashProbeCanonicalJson } from "./probe-contract.mjs";
import { getProbeTranscriptFactDefinition } from "./probe-registry.mjs";

export const PROBE_SCENARIO_SCHEMA_VERSION = 1;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const parameterKeyPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const factKeyPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const forbiddenAuthorityKeyPattern = /(?:outcome|mechanism|verification|expectation)/iu;

export class ProbeScenarioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeScenarioError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeScenarioError(code, message);
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

function assertExactKeys(value, required, optional, label, code = "SCENARIO_SCHEMA") {
  if (!exactObject(value)) fail(code, `${label} must be a plain object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${label} has unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${label} is missing key: ${key}`);
  }
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

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("SCENARIO_IDENTIFIER", `${label} must be lowercase kebab-case`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("SCENARIO_SHA256", `${label} must be lowercase 64-hex`);
  }
}

function assertString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    value.includes("\0") ||
    value.normalize("NFC") !== value
  ) {
    fail("SCENARIO_STRING", `${label} must be a bounded NFC string`);
  }
}

function assertPrimitiveParameter(value, label) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("SCENARIO_PARAMETER", `${label} must be finite`);
    return;
  }
  if (typeof value === "string") {
    assertString(value, label);
    return;
  }
  if (!Array.isArray(value)) {
    fail("SCENARIO_PARAMETER", `${label} must be a primitive or primitive array`);
  }
  for (const [index, entry] of value.entries()) {
    if (!["boolean", "number", "string"].includes(typeof entry)) {
      fail("SCENARIO_PARAMETER", `${label}[${index}] must be a non-null primitive`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      fail("SCENARIO_PARAMETER", `${label}[${index}] must be finite`);
    }
    if (typeof entry === "string") assertString(entry, `${label}[${index}]`);
  }
}

function assertParameters(value, label) {
  if (!exactObject(value)) fail("SCENARIO_PARAMETER", `${label} must be a plain object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!parameterKeyPattern.test(key) || forbiddenAuthorityKeyPattern.test(key)) {
      fail("SCENARIO_PARAMETER", `${label}.${key} is not an allowed parameter`);
    }
    assertPrimitiveParameter(entry, `${label}.${key}`);
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareUtf8);
}

function producerKindFor(transcriptKind) {
  if (transcriptKind === "windows-host-probe-native-transcript") return "native-helper";
  if (transcriptKind === "windows-host-probe-controller-transcript") {
    return "external-controller";
  }
  fail("SCENARIO_INTERNAL", `unsupported transcript kind: ${transcriptKind}`);
}

function createActionComposer(factDefinition) {
  const actions = [];
  const commandById = new Map(
    factDefinition.commands.map((command, index) => [command.commandId, { command, index }]),
  );

  function add({ actionId, actor, phase, operation, parameters, commandId = null }) {
    const previous = actions.at(-1);
    let capture = null;
    if (commandId !== null) {
      const entry = commandById.get(commandId);
      if (entry === undefined) {
        fail(
          "SCENARIO_INTERNAL",
          `${factDefinition.rowId}/${factDefinition.variantId} references unknown command ${commandId}`,
        );
      }
      capture = {
        sequence: entry.index + 1,
        commandId,
        factKeys: [...entry.command.factKeys],
      };
    }
    actions.push({
      sequence: actions.length + 1,
      actionId,
      actor,
      phase,
      operation,
      parameters,
      prerequisiteActionIds: previous === undefined ? [] : [previous.actionId],
      capture,
    });
  }

  return { actions, add };
}

const BASE_CAPABILITIES = ["nativeWindows11X64", "standardUserNonElevated"];

function rowCapabilities(rowId) {
  if (["F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-10"].includes(rowId)) {
    return [...BASE_CAPABILITIES, "ntfsSystemAndTestVolumes"];
  }
  return [...BASE_CAPABILITIES];
}

function scenarioDraft(actions, capabilityIds, continuation = null) {
  return {
    actions,
    capabilityIds: sortedUnique(capabilityIds),
    continuation: continuation ?? { kind: "none", checkpoint: null, repetitions: 0 },
  };
}

const F01_SCENARIOS = Object.freeze({
  "f01-8dot3-short-name-alias": ["8dot3-short-name-alias", "main", "same-process"],
  "f01-actual-component-case-alias": ["actual-component-case-alias", "main", "same-process"],
  "f01-case-sensitive-directory": ["case-sensitive-directory", "main", "same-process"],
  "f01-daemon-main-identity-agreement": [
    "ordinary-absolute-path",
    "daemon-and-main",
    "same-process",
  ],
  "f01-directory-junction-alias": ["directory-junction-alias", "main", "same-process"],
  "f01-distinct-homes": ["distinct-homes", "main", "same-process"],
  "f01-drive-letter-case-alias": ["drive-letter-case-alias", "main", "same-process"],
  "f01-long-path-alias": ["long-path-alias", "main", "same-process"],
  "f01-mapped-network-drive-refusal": ["mapped-network-drive", "main", "same-process"],
  "f01-ordinary-absolute-path": ["ordinary-absolute-path", "main", "same-process"],
  "f01-reboot-stability": ["ordinary-absolute-path", "main", "reboot"],
  "f01-relocate-copy-rebind": ["relocated-copy", "main", "same-process"],
  "f01-removable-non-ntfs-refusal": ["removable-non-ntfs", "main", "same-process"],
  "f01-rename-rebind": ["renamed-home", "main", "same-process"],
  "f01-reparse-chain-escape": ["reparse-chain-escape", "main", "same-process"],
  "f01-restart-stability": ["ordinary-absolute-path", "main", "restart"],
  "f01-spaces-unicode-path": ["spaces-unicode-path", "main", "same-process"],
  "f01-subst-drive-alias": ["subst-drive-alias", "main", "same-process"],
  "f01-unc-path-refusal": ["unc-path", "main", "same-process"],
});

function buildF01(variantId, factDefinition) {
  const scenario = F01_SCENARIOS[variantId];
  if (scenario === undefined) fail("SCENARIO_INTERNAL", `unparsed F-01 variant: ${variantId}`);
  const [pathTopology, processRole, lifecycle] = scenario;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-home-topology",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-home-topology",
    parameters: { pathTopology, processRole },
  });
  if (lifecycle === "restart") {
    add({
      actionId: "restart-probe-process",
      actor: "external-controller",
      phase: "transition",
      operation: "restart-probe-process",
      parameters: { processRole },
    });
  }
  if (lifecycle === "reboot") {
    add({
      actionId: "reboot-guest",
      actor: "external-controller",
      phase: "transition",
      operation: "reboot-guest",
      parameters: { waitForBootComplete: true },
    });
  }
  add({
    actionId: "capture-home-identity",
    actor: "native-helper",
    phase: "capture",
    operation: "home-identity",
    parameters: { lifecycle, pathTopology, processRole },
    commandId: "home-identity",
  });
  const capabilities = rowCapabilities("F-01");
  if (lifecycle === "reboot") capabilities.push("bootCompleteObservation");
  return scenarioDraft(actions, capabilities);
}

const F02_SCENARIOS = Object.freeze({
  "f02-broad-authenticated-users-repair": ["authenticated-users", "current-user", "repair"],
  "f02-broad-everyone-repair": ["everyone", "current-user", "repair"],
  "f02-broad-users-repair": ["users", "current-user", "repair"],
  "f02-create-private-directory": ["fresh-private", "current-user", "create"],
  "f02-explicit-local-appdata-root": ["explicit-local-appdata", "current-user", "create"],
  "f02-inherited-profile-parent": ["inherited-profile", "current-user", "repair"],
  "f02-invalid-root-empty": ["invalid-empty", "current-user", "validate-root"],
  "f02-invalid-root-network": ["invalid-network", "current-user", "validate-root"],
  "f02-invalid-root-relative": ["invalid-relative", "current-user", "validate-root"],
  "f02-invalid-root-removable": ["invalid-removable", "current-user", "validate-root"],
  "f02-invalid-root-reparse-escape": ["invalid-reparse-escape", "current-user", "validate-root"],
  "f02-invalid-root-roaming": ["invalid-roaming", "current-user", "validate-root"],
  "f02-owner-create": ["owned-private", "current-user", "create"],
  "f02-owner-delete": ["owned-private", "current-user", "delete"],
  "f02-owner-ordered-aces": ["owned-private", "current-user", "inspect"],
  "f02-owner-read": ["owned-private", "current-user", "read"],
  "f02-owner-rename": ["owned-private", "current-user", "rename"],
  "f02-second-user-read-refusal": ["second-user", "second-user", "read"],
  "f02-second-user-write-refusal": ["second-user", "second-user", "write"],
  "f02-unrepairable-owner-deny": ["unrepairable-owner-deny", "current-user", "repair"],
});

function buildF02(variantId, factDefinition) {
  const scenario = F02_SCENARIOS[variantId];
  if (scenario === undefined) fail("SCENARIO_INTERNAL", `unparsed F-02 variant: ${variantId}`);
  const [rootClass, actor, operation] = scenario;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-directory-root",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-directory-root",
    parameters: { rootClass },
  });
  add({
    actionId: "capture-directory-ensure",
    actor: "native-helper",
    phase: "capture",
    operation: "private-directory-ensure",
    parameters: { actor, operation, rootClass },
    commandId: "private-directory-ensure",
  });
  add({
    actionId: "exercise-directory-access",
    actor: "external-controller",
    phase: "transition",
    operation: "exercise-directory-access",
    parameters: { actor, operation },
  });
  add({
    actionId: "capture-directory-inspection",
    actor: "native-helper",
    phase: "capture",
    operation: "private-directory-inspect",
    parameters: { actor, rootClass },
    commandId: "private-directory-inspect",
  });
  const capabilities = rowCapabilities("F-02");
  if (actor === "second-user") {
    capabilities.push("secondStandardUser", "interactiveStandardUserSession");
  }
  return scenarioDraft(actions, capabilities);
}

function buildF03(variantId, factDefinition) {
  const parsed = /^f03-(port|profile|token|vault)-(.+)$/u.exec(variantId);
  if (parsed === null) fail("SCENARIO_INTERNAL", `unparsed F-03 variant: ${variantId}`);
  const payloadKind = parsed[1];
  const targetTopology = parsed[2];
  const testedPayloadBytes = PROBE_CAMPAIGN_MANIFEST.parameters.f03PayloadBytes[payloadKind];
  if (
    ![
      "absent",
      "directory",
      "existing-regular-file",
      "hard-link",
      "inspect-create-swap",
      "junction-reparse",
      "read-only-file",
      "symlink",
    ].includes(targetTopology) ||
    testedPayloadBytes === undefined
  ) {
    fail("SCENARIO_INTERNAL", `unparsed F-03 variant: ${variantId}`);
  }
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-private-file-target",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-private-file-target",
    parameters: { payloadKind, targetTopology, testedPayloadBytes },
  });
  add({
    actionId: "capture-target-identity",
    actor: "native-helper",
    phase: "capture",
    operation: "file-identity",
    parameters: { targetTopology },
    commandId: "file-identity",
  });
  if (targetTopology === "inspect-create-swap") {
    add({
      actionId: "arm-inspect-create-swap",
      actor: "external-controller",
      phase: "transition",
      operation: "arm-inspect-create-swap",
      parameters: { targetTopology },
    });
  }
  add({
    actionId: "capture-private-file-create",
    actor: "native-helper",
    phase: "capture",
    operation: "private-file-create",
    parameters: { payloadKind, targetTopology, testedPayloadBytes },
    commandId: "private-file-create",
  });
  return scenarioDraft(actions, rowCapabilities("F-03"));
}

function buildF04(variantId, factDefinition) {
  const parsed =
    /^f04-(ancestor-junction|concurrent-swap-loop|junction-chain|leaf-mount-point|leaf-symlink|normal-nested)-(create|delete|quarantine|read|replace)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("SCENARIO_INTERNAL", `unparsed F-04 variant: ${variantId}`);
  const pathTopology = parsed[1];
  const operation = parsed[2];
  const race = PROBE_CAMPAIGN_MANIFEST.parameters.f04Race;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-path-topology",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-path-topology",
    parameters: { pathTopology, operation },
  });
  if (pathTopology === "concurrent-swap-loop") {
    add({
      actionId: "start-swap-workers",
      actor: "external-controller",
      phase: "transition",
      operation: "start-swap-workers",
      parameters: {
        durationMs: race.durationMs,
        minimumSwapCount: race.minimumSwapCount,
        operationWorkers: race.operationWorkers,
        swapWorkers: race.swapWorkers,
      },
    });
  }
  add({
    actionId: "capture-secure-path-operation",
    actor: "native-helper",
    phase: "capture",
    operation: "secure-path-operation",
    parameters: {
      pathTopology,
      operation,
      durationMs: pathTopology === "concurrent-swap-loop" ? race.durationMs : 0,
      operationWorkers: pathTopology === "concurrent-swap-loop" ? race.operationWorkers : 1,
      swapWorkers: pathTopology === "concurrent-swap-loop" ? race.swapWorkers : 0,
    },
    commandId: "secure-path-operation",
  });
  if (pathTopology === "concurrent-swap-loop") {
    add({
      actionId: "stop-swap-workers",
      actor: "external-controller",
      phase: "recovery",
      operation: "stop-swap-workers",
      parameters: { collectWorkerEvidence: true },
    });
  }
  add({
    actionId: "capture-evidence-tree-seal",
    actor: "native-helper",
    phase: "capture",
    operation: "evidence-tree-seal",
    parameters: { pathTopology, operation, sealBeforeAndAfter: true },
    commandId: "evidence-tree-seal",
  });
  return scenarioDraft(actions, rowCapabilities("F-04"));
}

function buildF05(variantId, factDefinition) {
  const parsed =
    /^f05-(delete|quarantine|replace)-(same-object|stale-identity)-(hard-link|process-restart|same-process)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("SCENARIO_INTERNAL", `unparsed F-05 variant: ${variantId}`);
  const operation = parsed[1];
  const identityClass = parsed[2];
  const lifetime = parsed[3];
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-object-lifetime",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-object-lifetime",
    parameters: { identityClass, lifetime, operation },
  });
  add({
    actionId: "capture-inspected-identity",
    actor: "native-helper",
    phase: "capture",
    operation: "file-identity",
    parameters: { identityClass, lifetime },
    commandId: "file-identity",
  });
  if (lifetime === "process-restart") {
    add({
      actionId: "restart-probe-process",
      actor: "external-controller",
      phase: "transition",
      operation: "restart-probe-process",
      parameters: { preserveIdentityToken: true },
    });
  }
  if (identityClass === "stale-identity") {
    add({
      actionId: "replace-inspected-object",
      actor: "external-controller",
      phase: "transition",
      operation: "replace-inspected-object",
      parameters: { lifetime },
    });
  }
  add({
    actionId: "capture-handle-bound-mutation",
    actor: "native-helper",
    phase: "capture",
    operation: "secure-path-operation",
    parameters: { identityClass, lifetime, operation },
    commandId: "secure-path-operation",
  });
  return scenarioDraft(actions, rowCapabilities("F-05"));
}

const F06_CONTEXTS = ["baseline", "defender-scan", "process-crash", "rapid-readers", "reboot"];
const F06_CHECKPOINTS = [
  "after-flush",
  "after-replace",
  "before-replace",
  "before-temp-write",
  "during-replace",
  "during-write",
];

function buildF06(variantId, factDefinition) {
  const context = F06_CONTEXTS.find((entry) => variantId.startsWith(`f06-${entry}-`));
  const checkpoint = F06_CHECKPOINTS.find((entry) => variantId.includes(`-${entry}-share-`));
  const shareMode = variantId.endsWith("-share-denies-replace")
    ? "share-denies-replace"
    : "share-allows-replace";
  if (context === undefined || checkpoint === undefined) {
    fail("SCENARIO_INTERNAL", `unparsed F-06 variant: ${variantId}`);
  }
  const replacement = PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-replacement-target",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-replacement-target",
    parameters: { checkpoint, context, shareMode },
  });
  if (context === "defender-scan") {
    add({
      actionId: "start-defender-scan",
      actor: "external-controller",
      phase: "transition",
      operation: "start-defender-scan",
      parameters: { scanMode: replacement.defenderScanMode },
    });
  } else if (context === "rapid-readers") {
    add({
      actionId: "start-rapid-readers",
      actor: "external-controller",
      phase: "transition",
      operation: "start-rapid-readers",
      parameters: { readerCount: replacement.rapidReaderCount },
    });
  }
  if (["process-crash", "reboot"].includes(context)) {
    add({
      actionId: "arm-replacement-session",
      actor: "external-controller",
      phase: "transition",
      operation: "arm-replacement-session",
      parameters: { checkpoint, context, shareMode },
    });
  } else {
    add({
      actionId: "run-replacement-operation",
      actor: "external-controller",
      phase: "transition",
      operation: "run-replacement-operation",
      parameters: {
        checkpoint,
        context,
        shareMode,
        maxRetries: replacement.maxRetries,
        retryBaseDelayMs: replacement.retryBaseDelayMs,
        retryDeadlineMs: replacement.retryDeadlineMs,
        retryMaximumDelayMs: replacement.retryMaximumDelayMs,
      },
    });
  }
  if (context === "process-crash") {
    add({
      actionId: "terminate-replacement-process",
      actor: "external-controller",
      phase: "transition",
      operation: "terminate-replacement-process",
      parameters: { checkpoint },
    });
  } else if (context === "reboot") {
    add({
      actionId: "reboot-replacement-guest",
      actor: "external-controller",
      phase: "transition",
      operation: "reboot-replacement-guest",
      parameters: { waitForBootComplete: true },
    });
  }
  if (["defender-scan", "rapid-readers"].includes(context)) {
    add({
      actionId: "stop-context-workers",
      actor: "external-controller",
      phase: "recovery",
      operation: "stop-context-workers",
      parameters: { context },
    });
  }
  add({
    actionId: "inspect-replacement-after-recovery",
    actor: "external-controller",
    phase: "recovery",
    operation: "inspect-replacement-after-recovery",
    parameters: { checkpoint, context, shareMode },
  });
  add({
    actionId: "capture-atomic-replacement-campaign",
    actor: "external-controller",
    phase: "capture",
    operation: "atomic-replacement-campaign",
    parameters: {
      checkpoint,
      context,
      shareMode,
      maxRetries: replacement.maxRetries,
      retryBaseDelayMs: replacement.retryBaseDelayMs,
      retryDeadlineMs: replacement.retryDeadlineMs,
      retryMaximumDelayMs: replacement.retryMaximumDelayMs,
    },
    commandId: "atomic-replacement-campaign",
  });
  const capabilities = rowCapabilities("F-06");
  if (context === "defender-scan") capabilities.push("defenderRealtimeEnabled");
  if (context === "reboot") capabilities.push("bootCompleteObservation");
  return scenarioDraft(actions, capabilities);
}

const F07_HARD_CUT_CHECKPOINTS = Object.freeze({
  "f07-hard-cut-after-file-flush": "file-flush",
  "f07-hard-cut-after-namespace-replace": "namespace-replace",
  "f07-hard-cut-after-parent-volume-flush": "parent-volume-flush",
  "f07-hard-cut-after-temp-creation": "temp-creation",
});

const F07_PROCESS_KILL_CHECKPOINTS = Object.freeze({
  "f07-process-kill-after-file-flush": "file-flush",
  "f07-process-kill-after-namespace-replace": "namespace-replace",
  "f07-process-kill-after-parent-volume-flush": "parent-volume-flush",
  "f07-process-kill-after-temp-creation": "temp-creation",
});

function f07Checkpoint(variantId) {
  if (variantId === "f07-file-flush-capability") return "file-flush-capability";
  if (variantId === "f07-parent-directory-handle-capability") {
    return "parent-directory-handle-capability";
  }
  if (variantId === "f07-recovery-envelope-checksum") return "recovery-envelope-checksum";
  if (variantId === "f07-recovery-old-or-new-complete") {
    return "recovery-old-or-new-complete";
  }
  if (variantId === "f07-truthful-commit-uncertain") return "truthful-commit-uncertain";
  return F07_HARD_CUT_CHECKPOINTS[variantId] ?? F07_PROCESS_KILL_CHECKPOINTS[variantId] ?? null;
}

function buildF07(variantId, factDefinition) {
  const checkpoint = f07Checkpoint(variantId);
  if (checkpoint === null) fail("SCENARIO_INTERNAL", `unparsed F-07 variant: ${variantId}`);
  const hardCut = Object.hasOwn(F07_HARD_CUT_CHECKPOINTS, variantId);
  const processKill = Object.hasOwn(F07_PROCESS_KILL_CHECKPOINTS, variantId);
  const repetitions = hardCut
    ? PROBE_CAMPAIGN_MANIFEST.parameters.f07Durability.repetitionsPerHardCutCheckpoint
    : 1;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-durability-target",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-durability-target",
    parameters: { checkpoint, hardCut, processKill, repetitions },
  });
  if (hardCut) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      add({
        actionId: `start-durability-operation-r${repetition}`,
        actor: "external-controller",
        phase: "transition",
        operation: "start-durability-operation",
        parameters: { checkpoint, repetition },
      });
      add({
        actionId: `hard-cut-guest-r${repetition}`,
        actor: "external-controller",
        phase: "transition",
        operation: "hard-cut-guest",
        parameters: { checkpoint, repetition },
      });
      add({
        actionId: `start-guest-after-hard-cut-r${repetition}`,
        actor: "external-controller",
        phase: "recovery",
        operation: "start-guest-after-hard-cut",
        parameters: { checkpoint, repetition, waitForBootComplete: true },
      });
      add({
        actionId: `inspect-durability-after-hard-cut-r${repetition}`,
        actor: "external-controller",
        phase: "recovery",
        operation: "inspect-durability-after-hard-cut",
        parameters: { checkpoint, repetition },
      });
    }
  } else if (processKill) {
    add({
      actionId: "start-durability-operation",
      actor: "external-controller",
      phase: "transition",
      operation: "start-durability-operation",
      parameters: { checkpoint, repetition: 1 },
    });
    add({
      actionId: "kill-process-at-checkpoint",
      actor: "external-controller",
      phase: "transition",
      operation: "kill-process-at-checkpoint",
      parameters: { checkpoint },
    });
    add({
      actionId: "inspect-durability-after-process-kill",
      actor: "external-controller",
      phase: "recovery",
      operation: "inspect-durability-after-process-kill",
      parameters: { checkpoint },
    });
  }
  add({
    actionId: "capture-durability-campaign",
    actor: "external-controller",
    phase: "capture",
    operation: "durability-campaign",
    parameters: { checkpoint, hardCut, processKill, repetitions },
    commandId: "durability-campaign",
  });
  const capabilities = rowCapabilities("F-07");
  if (hardCut) {
    capabilities.push(
      "bootCompleteObservation",
      "externalAbruptPower",
      "externalSnapshotRestore",
      "immutableSnapshotIdentity",
    );
  }
  return scenarioDraft(
    actions,
    capabilities,
    hardCut
      ? { kind: "external-hard-cut", checkpoint, repetitions }
      : { kind: "none", checkpoint: null, repetitions: 0 },
  );
}

const F08_HANDOFF_CHECKPOINTS = Object.freeze({
  "f08-kill-after-capability-consumption": "after-capability-consumption",
  "f08-kill-after-successor-admission": "after-successor-admission",
  "f08-kill-before-accept": "before-accept",
  "f08-kill-during-frame-read": "during-frame-read",
  "f08-n-to-n-plus-one-handoff": "n-to-n-plus-one",
});

function f08Parameters(variantId) {
  const golden = /^f08-(main|daemon)-golden-(home-[ab])$/u.exec(variantId);
  if (golden !== null) return { scenario: "golden-name", processRole: golden[1], home: golden[2] };
  const production = /^f08-(main|daemon)-production-name$/u.exec(variantId);
  if (production !== null) return { scenario: "production-name", processRole: production[1] };
  if (Object.hasOwn(F08_HANDOFF_CHECKPOINTS, variantId)) {
    return { scenario: "successor-handoff", checkpoint: F08_HANDOFF_CHECKPOINTS[variantId] };
  }
  const clientScenarios = {
    "f08-client-correct-successor": "correct-successor",
    "f08-client-duplicate-correct-attempt": "duplicate-attempt",
    "f08-client-foreign-precreator": "foreign-precreator",
    "f08-client-ordinary-starter": "ordinary-starter",
    "f08-client-remote-pipe-refusal": "remote-client",
    "f08-client-second-user-refusal": "second-user",
    "f08-client-wrong-capability": "wrong-capability",
  };
  if (Object.hasOwn(clientScenarios, variantId)) {
    return { scenario: "client", clientKind: clientScenarios[variantId] };
  }
  const namedScenarios = {
    "f08-continuous-ownership-sampling": "continuous-ownership-sampling",
    "f08-distinct-home-names": "distinct-home-names",
    "f08-endpoint-grammar": "endpoint-grammar",
    "f08-injected-derivation-collision": "injected-derivation-collision",
    "f08-no-raw-identity-substring": "no-raw-identity-substring",
    "f08-reboot-stability": "reboot-stability",
    "f08-restart-stability": "restart-stability",
    "f08-starter-race": "starter-race",
  };
  return Object.hasOwn(namedScenarios, variantId) ? { scenario: namedScenarios[variantId] } : null;
}

function buildF08(variantId, factDefinition) {
  const parameters = f08Parameters(variantId);
  if (parameters === null) fail("SCENARIO_INTERNAL", `unparsed F-08 variant: ${variantId}`);
  const config = PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-named-pipe-scenario",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-named-pipe-scenario",
    parameters,
  });
  if (parameters.clientKind === "remote-client") {
    add({
      actionId: "start-remote-pipe-client",
      actor: "external-controller",
      phase: "transition",
      operation: "start-remote-pipe-client",
      parameters: { connectTimeoutMs: config.connectTimeoutMs },
    });
  } else if (parameters.clientKind === "second-user") {
    add({
      actionId: "start-second-user-pipe-client",
      actor: "external-controller",
      phase: "transition",
      operation: "start-second-user-pipe-client",
      parameters: { connectTimeoutMs: config.connectTimeoutMs },
    });
  } else if (parameters.clientKind === "foreign-precreator") {
    add({
      actionId: "precreate-foreign-pipe",
      actor: "external-controller",
      phase: "transition",
      operation: "precreate-foreign-pipe",
      parameters: { maxFrameBytes: config.maxFrameBytes },
    });
  }
  if (parameters.checkpoint !== undefined) {
    add({
      actionId: "arm-pipe-owner-session",
      actor: "external-controller",
      phase: "transition",
      operation: "arm-pipe-owner-session",
      parameters: { checkpoint: parameters.checkpoint },
    });
    add({
      actionId: "kill-pipe-owner-at-checkpoint",
      actor: "external-controller",
      phase: "transition",
      operation: "kill-pipe-owner-at-checkpoint",
      parameters: { checkpoint: parameters.checkpoint },
    });
    add({
      actionId: "inspect-pipe-after-owner-kill",
      actor: "external-controller",
      phase: "recovery",
      operation: "inspect-pipe-after-owner-kill",
      parameters: { checkpoint: parameters.checkpoint },
    });
  }
  if (["starter-race", "continuous-ownership-sampling"].includes(parameters.scenario)) {
    add({
      actionId: "launch-competing-starters",
      actor: "external-controller",
      phase: "transition",
      operation: "launch-competing-starters",
      parameters: {
        ordinaryStarterCount: config.ordinaryStarterCount,
        ownershipSampleIntervalMs: config.ownershipSampleIntervalMs,
        raceIterations: config.raceIterations,
      },
    });
  }
  if (parameters.scenario === "restart-stability") {
    add({
      actionId: "restart-pipe-owner",
      actor: "external-controller",
      phase: "transition",
      operation: "restart-pipe-owner",
      parameters: { preserveCanonicalHome: true },
    });
    add({
      actionId: "inspect-pipe-after-restart",
      actor: "external-controller",
      phase: "recovery",
      operation: "inspect-pipe-after-restart",
      parameters: { preserveCanonicalHome: true },
    });
  }
  if (parameters.scenario === "reboot-stability") {
    add({
      actionId: "reboot-pipe-owner-guest",
      actor: "external-controller",
      phase: "transition",
      operation: "reboot-pipe-owner-guest",
      parameters: { waitForBootComplete: true },
    });
    add({
      actionId: "inspect-pipe-after-reboot",
      actor: "external-controller",
      phase: "recovery",
      operation: "inspect-pipe-after-reboot",
      parameters: { preserveCanonicalHome: true },
    });
  }
  add({
    actionId: "capture-named-pipe-campaign",
    actor: "external-controller",
    phase: "capture",
    operation: "named-pipe-campaign",
    parameters: {
      ...parameters,
      capabilityBytes: config.capabilityBytes,
      connectTimeoutMs: config.connectTimeoutMs,
      maxFrameBytes: config.maxFrameBytes,
      readTimeoutMs: config.readTimeoutMs,
    },
    commandId: "named-pipe-campaign",
  });
  const capabilities = rowCapabilities("F-08");
  if (parameters.clientKind === "remote-client") capabilities.push("remoteWindowsPeer");
  if (parameters.clientKind === "second-user") {
    capabilities.push("secondStandardUser", "interactiveStandardUserSession");
  }
  if (parameters.scenario === "reboot-stability") capabilities.push("bootCompleteObservation");
  return scenarioDraft(actions, capabilities);
}

function f09Scenario(variantId) {
  const scenarios = {
    "f09-assignment-before-start": "assignment-before-start",
    "f09-crash-after-ready": "crash-after-ready",
    "f09-explicit-quit": "explicit-quit",
    "f09-grandchild-cleanup": "grandchild-cleanup",
    "f09-hang-before-ready": "hang-before-ready",
    "f09-ignore-shutdown-forced-stop": "ignore-shutdown-forced-stop",
    "f09-main-process-crash": "main-process-crash",
    "f09-nestable-outer-job": "nestable-outer-job",
    "f09-non-nestable-outer-job-refusal": "non-nestable-outer-job",
    "f09-normal-ready-shutdown": "normal-ready-shutdown",
    "f09-os-shutdown-notification": "os-shutdown-notification",
    "f09-pid-creation-time-binding": "pid-creation-time-binding",
    "f09-pid-reuse-pressure": "pid-reuse-pressure",
    "f09-uninstall-drain": "uninstall-drain",
    "f09-unrelated-process-safety": "unrelated-process-safety",
    "f09-update-drain": "update-drain",
  };
  return scenarios[variantId] ?? null;
}

function buildF09(variantId, factDefinition) {
  const scenario = f09Scenario(variantId);
  if (scenario === null) fail("SCENARIO_INTERNAL", `unparsed F-09 variant: ${variantId}`);
  const config = PROBE_CAMPAIGN_MANIFEST.parameters.f09Lifecycle;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-job-object-scenario",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-job-object-scenario",
    parameters: {
      scenario,
      gracefulTimeoutMs: config.gracefulTimeoutMs,
      forcedTimeoutMs: config.forcedTimeoutMs,
      settleMs: config.settleMs,
    },
  });
  if (["nestable-outer-job", "non-nestable-outer-job"].includes(scenario)) {
    add({
      actionId: "configure-outer-job",
      actor: "external-controller",
      phase: "transition",
      operation: "configure-outer-job",
      parameters: { nestable: scenario === "nestable-outer-job" },
    });
  } else if (scenario === "pid-reuse-pressure") {
    add({
      actionId: "start-pid-pressure",
      actor: "external-controller",
      phase: "transition",
      operation: "start-pid-pressure",
      parameters: {
        pidPressureCount: config.pidPressureCount,
        pidPressureDeadlineMs: config.pidPressureDeadlineMs,
      },
    });
  } else if (scenario === "os-shutdown-notification") {
    add({
      actionId: "request-os-shutdown-notification",
      actor: "external-controller",
      phase: "transition",
      operation: "request-os-shutdown-notification",
      parameters: { waitForNotification: true },
    });
  } else if (scenario === "unrelated-process-safety") {
    add({
      actionId: "start-unrelated-sentinel",
      actor: "external-controller",
      phase: "transition",
      operation: "start-unrelated-sentinel",
      parameters: { outsideJob: true },
    });
  }
  add({
    actionId: "capture-job-object-campaign",
    actor: "external-controller",
    phase: "capture",
    operation: "job-object-campaign",
    parameters: {
      scenario,
      gracefulTimeoutMs: config.gracefulTimeoutMs,
      forcedTimeoutMs: config.forcedTimeoutMs,
      pidPressureCount: scenario === "pid-reuse-pressure" ? config.pidPressureCount : 0,
    },
    commandId: "job-object-campaign",
  });
  return scenarioDraft(actions, rowCapabilities("F-09"));
}

const F10_CRASH_PATTERN =
  /^f10-kill-(after|before)-(database-open|handshake-publication|port-bind|port-file-publication|temp-hardlink-claim)$/u;

function f10Parameters(variantId) {
  const crash = F10_CRASH_PATTERN.exec(variantId);
  if (crash !== null) return { scenario: "crash-recovery", checkpoint: `${crash[1]}-${crash[2]}` };
  const scenarios = {
    "f10-bound-unresponsive-listener": "bound-unresponsive-listener",
    "f10-database-writer-sentinel": "database-writer-sentinel",
    "f10-defender-share-deny": "defender-share-deny",
    "f10-distinct-home-control": "distinct-home-control",
    "f10-foreign-listener": "foreign-listener",
    "f10-healthy-compatible-peer": "healthy-compatible-peer",
    "f10-mixed-alias-starter-race": "mixed-alias-starter-race",
    "f10-newer-protocol-refusal": "newer-protocol",
    "f10-older-protocol-refusal": "older-protocol",
    "f10-pid-reuse-pressure": "pid-reuse-pressure",
    "f10-read-only-tooling": "read-only-tooling",
    "f10-second-electron-activation": "second-electron-activation",
    "f10-second-user-acl-refusal": "second-user-acl",
    "f10-simultaneous-electron-launches": "simultaneous-electron-launches",
    "f10-stale-lock-no-listener": "stale-lock-no-listener",
    "f10-stale-port-file": "stale-port-file",
    "f10-unmanaged-compatible-peer-guidance": "unmanaged-compatible-peer",
  };
  return Object.hasOwn(scenarios, variantId) ? { scenario: scenarios[variantId] } : null;
}

function buildF10(variantId, factDefinition) {
  const parameters = f10Parameters(variantId);
  if (parameters === null) fail("SCENARIO_INTERNAL", `unparsed F-10 variant: ${variantId}`);
  const config = PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton;
  const { actions, add } = createActionComposer(factDefinition);
  add({
    actionId: "prepare-singleton-scenario",
    actor: "external-controller",
    phase: "setup",
    operation: "prepare-singleton-scenario",
    parameters,
  });
  if (
    ["mixed-alias-starter-race", "simultaneous-electron-launches"].includes(parameters.scenario)
  ) {
    add({
      actionId: "launch-singleton-starters",
      actor: "external-controller",
      phase: "transition",
      operation: "launch-singleton-starters",
      parameters: { raceRounds: config.raceRounds, starterCount: config.starterCount },
    });
  } else if (parameters.scenario === "crash-recovery") {
    add({
      actionId: "arm-singleton-session",
      actor: "external-controller",
      phase: "transition",
      operation: "arm-singleton-session",
      parameters: { checkpoint: parameters.checkpoint },
    });
    add({
      actionId: "kill-singleton-process",
      actor: "external-controller",
      phase: "transition",
      operation: "kill-singleton-process",
      parameters: { checkpoint: parameters.checkpoint },
    });
    add({
      actionId: "inspect-singleton-after-kill",
      actor: "external-controller",
      phase: "recovery",
      operation: "inspect-singleton-after-kill",
      parameters: { checkpoint: parameters.checkpoint },
    });
  } else if (parameters.scenario === "defender-share-deny") {
    add({
      actionId: "start-defender-share-deny",
      actor: "external-controller",
      phase: "transition",
      operation: "start-defender-share-deny",
      parameters: { retryDeadlineMs: config.retryDeadlineMs },
    });
  } else if (parameters.scenario === "second-user-acl") {
    add({
      actionId: "start-second-user-singleton-client",
      actor: "external-controller",
      phase: "transition",
      operation: "start-second-user-singleton-client",
      parameters: { contentionTimeoutMs: config.contentionTimeoutMs },
    });
  }
  add({
    actionId: "capture-singleton-campaign",
    actor: "external-controller",
    phase: "capture",
    operation: "singleton-campaign",
    parameters: {
      ...parameters,
      contentionTimeoutMs: config.contentionTimeoutMs,
      maxRetries: config.maxRetries,
      raceRounds: config.raceRounds,
      retryDeadlineMs: config.retryDeadlineMs,
      starterCount: config.starterCount,
    },
    commandId: "singleton-campaign",
  });
  const capabilities = rowCapabilities("F-10");
  if (parameters.scenario === "defender-share-deny") capabilities.push("defenderRealtimeEnabled");
  if (parameters.scenario === "second-user-acl") {
    capabilities.push("secondStandardUser", "interactiveStandardUserSession");
  }
  return scenarioDraft(actions, capabilities);
}

const ROW_BUILDERS = Object.freeze({
  "F-01": buildF01,
  "F-02": buildF02,
  "F-03": buildF03,
  "F-04": buildF04,
  "F-05": buildF05,
  "F-06": buildF06,
  "F-07": buildF07,
  "F-08": buildF08,
  "F-09": buildF09,
  "F-10": buildF10,
});

function assertScenarioActions(actions, factDefinition, producerKind, label) {
  if (!Array.isArray(actions) || actions.length === 0) {
    fail("SCENARIO_INTERNAL", `${label}.actions must be non-empty`);
  }
  const actionIds = new Set();
  const captures = [];
  for (const [index, action] of actions.entries()) {
    assertExactKeys(
      action,
      [
        "sequence",
        "actionId",
        "actor",
        "phase",
        "operation",
        "parameters",
        "prerequisiteActionIds",
        "capture",
      ],
      [],
      `${label}.actions[${index}]`,
      "SCENARIO_INTERNAL",
    );
    if (action.sequence !== index + 1) {
      fail("SCENARIO_INTERNAL", `${label}.actions must have contiguous sequences`);
    }
    assertIdentifier(action.actionId, `${label}.actions[${index}].actionId`);
    if (actionIds.has(action.actionId)) fail("SCENARIO_INTERNAL", `${label} has duplicate actions`);
    if (!["native-helper", "external-controller"].includes(action.actor)) {
      fail("SCENARIO_INTERNAL", `${label}.actions[${index}].actor is invalid`);
    }
    if (!["setup", "transition", "recovery", "capture"].includes(action.phase)) {
      fail("SCENARIO_INTERNAL", `${label}.actions[${index}].phase is invalid`);
    }
    assertIdentifier(action.operation, `${label}.actions[${index}].operation`);
    assertParameters(action.parameters, `${label}.actions[${index}].parameters`);
    if (!Array.isArray(action.prerequisiteActionIds)) {
      fail("SCENARIO_INTERNAL", `${label}.actions[${index}].prerequisiteActionIds is invalid`);
    }
    for (const prerequisite of action.prerequisiteActionIds) {
      if (!actionIds.has(prerequisite)) {
        fail("SCENARIO_INTERNAL", `${label}.actions[${index}] has a forward prerequisite`);
      }
    }
    if (action.capture !== null) {
      assertExactKeys(
        action.capture,
        ["sequence", "commandId", "factKeys"],
        [],
        `${label}.actions[${index}].capture`,
        "SCENARIO_INTERNAL",
      );
      if (action.actor !== producerKind || action.phase !== "capture") {
        fail("SCENARIO_INTERNAL", `${label} capture actor does not match its transcript producer`);
      }
      captures.push(action.capture);
    }
    actionIds.add(action.actionId);
  }
  captures.sort((left, right) => left.sequence - right.sequence);
  if (captures.length !== factDefinition.commands.length) {
    fail("SCENARIO_INTERNAL", `${label} does not capture every transcript command`);
  }
  for (const [index, command] of factDefinition.commands.entries()) {
    const capture = captures[index];
    if (
      capture.sequence !== index + 1 ||
      capture.commandId !== command.commandId ||
      JSON.stringify(capture.factKeys) !== JSON.stringify(command.factKeys)
    ) {
      fail("SCENARIO_INTERNAL", `${label} transcript command mapping drifted`);
    }
  }
}

function assertScenarioDraft(draft, row, variantId, conditionId, factDefinition) {
  const producerKind = producerKindFor(factDefinition.transcriptKind);
  assertScenarioActions(draft.actions, factDefinition, producerKind, `${row.rowId}/${variantId}`);
  const requiredCapabilities = new Set(PROBE_CAMPAIGN_MANIFEST.requiredAttestationCapabilities);
  for (const capabilityId of draft.capabilityIds) {
    if (!requiredCapabilities.has(capabilityId)) {
      fail("SCENARIO_INTERNAL", `${row.rowId}/${variantId} has unknown capability ${capabilityId}`);
    }
  }
  const hardCut = Object.hasOwn(F07_HARD_CUT_CHECKPOINTS, variantId);
  if (hardCut) {
    const checkpoint = F07_HARD_CUT_CHECKPOINTS[variantId];
    const repetitions =
      PROBE_CAMPAIGN_MANIFEST.parameters.f07Durability.repetitionsPerHardCutCheckpoint;
    if (
      draft.continuation.kind !== "external-hard-cut" ||
      draft.continuation.checkpoint !== checkpoint ||
      draft.continuation.repetitions !== repetitions
    ) {
      fail("SCENARIO_INTERNAL", `${row.rowId}/${variantId} has an invalid hard-cut requirement`);
    }
  } else if (
    draft.continuation.kind !== "none" ||
    draft.continuation.checkpoint !== null ||
    draft.continuation.repetitions !== 0
  ) {
    fail("SCENARIO_INTERNAL", `${row.rowId}/${variantId} has an unexpected continuation`);
  }
  return {
    schemaVersion: PROBE_SCENARIO_SCHEMA_VERSION,
    kind: "windows-host-probe-scenario-definition",
    rowId: row.rowId,
    variantId,
    transcriptProducerKind: producerKind,
    prerequisites: {
      completedRowIds: [...row.dependsOnRowIds],
      attestationCapabilityIds: draft.capabilityIds,
      conditionId,
    },
    continuation: draft.continuation,
    actions: draft.actions,
  };
}

function buildScenarioDefinitions() {
  const expectedCoordinates = new Set();
  const definitions = new Map();
  for (const row of PROBE_CAMPAIGN_MANIFEST.rows) {
    const builder = ROW_BUILDERS[row.rowId];
    if (builder === undefined)
      fail("SCENARIO_INTERNAL", `missing scenario builder for ${row.rowId}`);
    const variants = [
      ...row.requiredVariantIds.map((variantId) => ({ variantId, conditionId: null })),
      ...row.conditionalVariants,
    ];
    for (const { variantId, conditionId } of variants) {
      const key = `${row.rowId}\0${variantId}`;
      expectedCoordinates.add(key);
      const factDefinition = getProbeTranscriptFactDefinition(row.rowId, variantId);
      const scenario = builder(variantId, factDefinition);
      const draft = assertScenarioDraft(scenario, row, variantId, conditionId, factDefinition);
      const definition = deepFreeze({
        ...draft,
        planSha256: hashProbeCanonicalJson({
          domain: "enduragent.windows-host-probe-scenario-definition.v1",
          definition: draft,
        }),
      });
      if (definitions.has(key)) fail("SCENARIO_INTERNAL", `duplicate scenario definition: ${key}`);
      definitions.set(key, definition);
    }
  }
  const actualCoordinates = new Set(definitions.keys());
  const missing = [...expectedCoordinates].filter((key) => !actualCoordinates.has(key));
  const extra = [...actualCoordinates].filter((key) => !expectedCoordinates.has(key));
  if (missing.length !== 0 || extra.length !== 0) {
    fail(
      "SCENARIO_CLOSURE",
      `scenario definitions do not close the manifest (missing=${missing.length}, extra=${extra.length})`,
    );
  }
  return definitions;
}

const DEFINITIONS = buildScenarioDefinitions();

export const PROBE_SCENARIO_DEFINITIONS = deepFreeze(
  [...DEFINITIONS.values()].sort((left, right) => {
    const rowOrder = compareUtf8(left.rowId, right.rowId);
    return rowOrder === 0 ? compareUtf8(left.variantId, right.variantId) : rowOrder;
  }),
);

export function getProbeScenarioDefinition(rowId, variantId) {
  const definition = DEFINITIONS.get(`${rowId}\0${variantId}`);
  if (definition === undefined) {
    fail("SCENARIO_UNKNOWN", `unknown probe scenario: ${rowId}/${variantId}`);
  }
  return definition;
}

function assertArtifactPath(value, label) {
  assertString(value, label);
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("SCENARIO_EVIDENCE", `${label} must be a canonical relative slash path`);
  }
}

function validateObservation(value, factKey, label) {
  assertExactKeys(value, ["factKey", "valueKind", "value"], [], label, "SCENARIO_OBSERVATION");
  if (value.factKey !== factKey || !factKeyPattern.test(value.factKey)) {
    fail("SCENARIO_OBSERVATION", `${label}.factKey is not the assigned fact`);
  }
  if (value.valueKind === "null") {
    if (value.value !== null) fail("SCENARIO_OBSERVATION", `${label}.value is not null`);
    return { factKey: value.factKey, valueKind: value.valueKind, value: null };
  }
  const scalarKinds = { boolean: "boolean", number: "number", string: "string" };
  if (Object.hasOwn(scalarKinds, value.valueKind)) {
    const expectedType = scalarKinds[value.valueKind];
    if (typeof value.value !== expectedType) {
      fail("SCENARIO_OBSERVATION", `${label}.value does not match valueKind`);
    }
    if (expectedType === "number" && !Number.isFinite(value.value)) {
      fail("SCENARIO_OBSERVATION", `${label}.value must be finite`);
    }
    if (expectedType === "string") assertString(value.value, `${label}.value`);
    return { factKey: value.factKey, valueKind: value.valueKind, value: value.value };
  }
  const arrayKinds = {
    "boolean-array": "boolean",
    "number-array": "number",
    "string-array": "string",
  };
  if (!Object.hasOwn(arrayKinds, value.valueKind) || !Array.isArray(value.value)) {
    fail("SCENARIO_OBSERVATION", `${label}.valueKind is invalid`);
  }
  const expectedType = arrayKinds[value.valueKind];
  for (const [index, entry] of value.value.entries()) {
    if (typeof entry !== expectedType) {
      fail("SCENARIO_OBSERVATION", `${label}.value[${index}] has the wrong type`);
    }
    if (expectedType === "number" && !Number.isFinite(entry)) {
      fail("SCENARIO_OBSERVATION", `${label}.value[${index}] must be finite`);
    }
    if (expectedType === "string") assertString(entry, `${label}.value[${index}]`);
  }
  return { factKey: value.factKey, valueKind: value.valueKind, value: [...value.value] };
}

function validateCommandEvent(value, action, producerKind, label) {
  assertExactKeys(
    value,
    [
      "sequence",
      "producerKind",
      "commandId",
      "requestSha256",
      "responseSha256",
      "nativeTranscriptSha256s",
      "observations",
    ],
    [],
    label,
    "SCENARIO_COMMAND_EVENT",
  );
  if (
    value.sequence !== action.capture.sequence ||
    value.producerKind !== producerKind ||
    value.commandId !== action.capture.commandId
  ) {
    fail("SCENARIO_COMMAND_EVENT", `${label} is not bound to the planned capture`);
  }
  assertSha256(value.requestSha256, `${label}.requestSha256`);
  assertSha256(value.responseSha256, `${label}.responseSha256`);
  if (!Array.isArray(value.nativeTranscriptSha256s) || value.nativeTranscriptSha256s.length === 0) {
    fail("SCENARIO_COMMAND_EVENT", `${label}.nativeTranscriptSha256s must be non-empty`);
  }
  let previousDigest = null;
  for (const [index, digest] of value.nativeTranscriptSha256s.entries()) {
    assertSha256(digest, `${label}.nativeTranscriptSha256s[${index}]`);
    if (previousDigest !== null && compareUtf8(previousDigest, digest) >= 0) {
      fail("SCENARIO_COMMAND_EVENT", `${label}.nativeTranscriptSha256s must be sorted and unique`);
    }
    previousDigest = digest;
  }
  if (
    !Array.isArray(value.observations) ||
    value.observations.length !== action.capture.factKeys.length
  ) {
    fail("SCENARIO_OBSERVATION", `${label}.observations does not match the planned fact set`);
  }
  const observations = action.capture.factKeys.map((factKey, index) =>
    validateObservation(value.observations[index], factKey, `${label}.observations[${index}]`),
  );
  return {
    sequence: value.sequence,
    producerKind: value.producerKind,
    commandId: value.commandId,
    requestSha256: value.requestSha256,
    responseSha256: value.responseSha256,
    nativeTranscriptSha256s: [...value.nativeTranscriptSha256s],
    observations,
  };
}

function validateEvidenceArtifacts(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("SCENARIO_EVIDENCE", `${label} must be a non-empty array`);
  }
  return values.map((artifact, index) => {
    assertExactKeys(artifact, ["path", "sha256"], [], `${label}[${index}]`, "SCENARIO_EVIDENCE");
    assertArtifactPath(artifact.path, `${label}[${index}].path`);
    assertSha256(artifact.sha256, `${label}[${index}].sha256`);
    return { path: artifact.path, sha256: artifact.sha256 };
  });
}

function validateActionResult(value, action, producerKind, label) {
  assertExactKeys(
    value,
    ["actionId", "commandEvent", "evidenceArtifacts"],
    [],
    label,
    "SCENARIO_ACTION_RESULT",
  );
  if (value.actionId !== action.actionId) {
    fail("SCENARIO_ACTION_RESULT", `${label}.actionId does not match the invocation`);
  }
  if (action.capture === null) {
    if (value.commandEvent !== null) {
      fail("SCENARIO_ACTION_RESULT", `${label} supplied an unplanned command event`);
    }
  } else {
    if (value.commandEvent === null) {
      fail("SCENARIO_ACTION_RESULT", `${label} omitted its planned command event`);
    }
    const commandEvent = validateCommandEvent(
      value.commandEvent,
      action,
      producerKind,
      `${label}.commandEvent`,
    );
    return {
      commandEvent,
      evidenceArtifacts: validateEvidenceArtifacts(
        value.evidenceArtifacts,
        `${label}.evidenceArtifacts`,
      ),
    };
  }
  return {
    commandEvent: null,
    evidenceArtifacts: validateEvidenceArtifacts(
      value.evidenceArtifacts,
      `${label}.evidenceArtifacts`,
    ),
  };
}

function assertScenarioSeams(input) {
  for (const [key, value] of [
    ["invokeNative", input.invokeNative],
    ["invokeController", input.invokeController],
  ]) {
    if (value !== undefined && typeof value !== "function") {
      fail("SCENARIO_INPUT", `input.${key} must be a function when supplied`);
    }
  }
}

function selectContiguousActions(definition, actionIds) {
  if (!Array.isArray(actionIds) || actionIds.length === 0) {
    fail("SCENARIO_ACTION_SLICE", "input.actionIds must be a non-empty array");
  }
  for (const [index, actionId] of actionIds.entries()) {
    if (typeof actionId !== "string") {
      fail("SCENARIO_ACTION_SLICE", `input.actionIds[${index}] must be a string`);
    }
  }
  const startIndex = definition.actions.findIndex(({ actionId }) => actionId === actionIds[0]);
  if (startIndex === -1) {
    fail("SCENARIO_ACTION_SLICE", `unknown scenario action: ${actionIds[0]}`);
  }
  const actions = definition.actions.slice(startIndex, startIndex + actionIds.length);
  if (
    actions.length !== actionIds.length ||
    actions.some((action, index) => action.actionId !== actionIds[index])
  ) {
    fail(
      "SCENARIO_ACTION_SLICE",
      "input.actionIds must identify an exact contiguous slice in plan order",
    );
  }
  return actions;
}

async function executeScenarioActions(definition, actions, input) {
  const commandEvents = [];
  const evidenceArtifacts = [];
  for (const action of actions) {
    const seam = action.actor === "native-helper" ? input.invokeNative : input.invokeController;
    if (typeof seam !== "function") {
      fail("SCENARIO_SEAM_MISSING", `no seam was supplied for ${action.actor}`);
    }
    const invocation = deepFreeze({
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action,
    });
    const result = validateActionResult(
      await seam(invocation),
      action,
      definition.transcriptProducerKind,
      `result(${action.actionId})`,
    );
    if (result.commandEvent !== null) commandEvents.push(result.commandEvent);
    evidenceArtifacts.push(...result.evidenceArtifacts);
  }
  commandEvents.sort((left, right) => left.sequence - right.sequence);
  evidenceArtifacts.sort((left, right) => compareUtf8(left.path, right.path));
  let previousPath = null;
  const foldedPaths = new Set();
  for (const artifact of evidenceArtifacts) {
    const foldedPath = artifact.path.toLocaleLowerCase("en-US");
    if (previousPath === artifact.path || foldedPaths.has(foldedPath)) {
      fail("SCENARIO_EVIDENCE", "scenario evidence paths must be unique without case collisions");
    }
    previousPath = artifact.path;
    foldedPaths.add(foldedPath);
  }
  return { commandEvents, evidenceArtifacts };
}

export async function executeProbeScenarioActionSlice(input) {
  assertExactKeys(
    input,
    ["rowId", "variantId", "actionIds"],
    ["invokeNative", "invokeController"],
    "input",
    "SCENARIO_INPUT",
  );
  const definition = getProbeScenarioDefinition(input.rowId, input.variantId);
  assertScenarioSeams(input);
  const actions = selectContiguousActions(definition, input.actionIds);
  const { commandEvents, evidenceArtifacts } = await executeScenarioActions(
    definition,
    actions,
    input,
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-partial-capture",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    actionIds: actions.map(({ actionId }) => actionId),
    commandEvents,
    evidenceArtifacts,
  });
}

export async function executeProbeScenario(input) {
  assertExactKeys(
    input,
    ["rowId", "variantId"],
    ["invokeNative", "invokeController"],
    "input",
    "SCENARIO_INPUT",
  );
  const definition = getProbeScenarioDefinition(input.rowId, input.variantId);
  assertScenarioSeams(input);
  const { commandEvents, evidenceArtifacts } = await executeScenarioActions(
    definition,
    definition.actions,
    input,
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-capture",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    transcriptProducerKind: definition.transcriptProducerKind,
    commandEvents,
    evidenceArtifacts,
  });
}
