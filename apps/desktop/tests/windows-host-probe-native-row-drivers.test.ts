import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ProbeNativeLanePlanValidationInput,
  ProbeNativeLaneProjectionInput,
  ProbeNativeLaneStepOutcome,
} from "../scripts/windows-host-falsifier/probe-native-lane.mjs";
import {
  PROBE_NATIVE_ROW_DRIVERS,
  ProbeNativeRowDriverError,
} from "../scripts/windows-host-falsifier/probe-native-row-drivers.mjs";
import {
  createProbeNativeActionPlan,
  deriveProbeNativeActionPlanStepOperationId,
  type ProbeNativeActionPlan,
  type ProbeNativeActionPlanStep,
} from "../scripts/windows-host-falsifier/probe-native-action-plan.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { canonicalProbeJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  PROBE_RUN_PLAN_SHA256,
  getProbeRunWorkItem,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import {
  PROBE_SCENARIO_DEFINITIONS,
  getProbeScenarioDefinition,
} from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const driverKeys = [
  "F-01:capture-home-identity",
  "F-02:capture-directory-ensure",
  "F-02:capture-directory-inspection",
  "F-03:capture-private-file-create",
  "F-03:capture-target-identity",
  "F-04:capture-evidence-tree-seal",
  "F-04:capture-secure-path-operation",
  "F-05:capture-handle-bound-mutation",
  "F-05:capture-inspected-identity",
] as const;

type DriverKey = (typeof driverKeys)[number];

const digest = (character: string) => character.repeat(64);
const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function actionFor(rowId: string, variantId: string, actionId: string) {
  const definition = getProbeScenarioDefinition(rowId, variantId);
  const action = definition.actions.find((entry) => entry.actionId === actionId);
  if (action === undefined) throw new Error(`missing action ${actionId}`);
  return { definition, action };
}

function producerFor(rowId: string, variantId: string, actionId: string) {
  const { definition, action } = actionFor(rowId, variantId, actionId);
  const producer = definition.actions
    .slice(0, action.sequence - 1)
    .filter((entry) => entry.actor === "external-controller")
    .at(-1);
  if (producer === undefined) throw new Error(`missing producer for ${actionId}`);
  return producer;
}

function controllerReceiptPath(input: {
  campaignRunId: string;
  attemptId: string;
  workId: string;
  producerActionId: string;
}) {
  return `runtime/work/${input.campaignRunId}/${input.attemptId}/${input.workId}/controller-actions/${input.producerActionId}.json`;
}

function driverInputPath(
  input: {
    campaignRunId: string;
    attemptId: string;
    workId: string;
    consumerActionId: string;
  },
  leaf: string,
) {
  return `runtime/work/${input.campaignRunId}/${input.attemptId}/${input.workId}/driver-inputs/${input.consumerActionId}/${leaf}`;
}

interface FixtureOptions {
  rowId: string;
  variantId: string;
  actionId: string;
  steps: readonly ProbeNativeActionPlanStep[];
  inputLeaves?: readonly string[];
}

function fixture(options: FixtureOptions) {
  const { definition, action } = actionFor(options.rowId, options.variantId, options.actionId);
  const producer = producerFor(options.rowId, options.variantId, options.actionId);
  const workItem = getProbeRunWorkItem({
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    rowId: options.rowId,
    variantId: options.variantId,
  });
  const identity = {
    candidateSha256: digest("a"),
    campaignRunId: "campaign-run",
    executionRunId: "execution-run",
    attemptId: "attempt-one",
    workId: workItem.workId,
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    rowId: options.rowId,
    variantId: options.variantId,
    scenarioPlanSha256: definition.planSha256,
    producerActionId: producer.actionId,
    consumerActionId: action.actionId,
    operationId: "runtime-operation",
    evidenceRootObjectIdentitySha256: digest("b"),
  };
  const prerequisitePaths = [
    controllerReceiptPath(identity),
    ...(options.inputLeaves ?? []).map((leaf) => driverInputPath(identity, leaf)),
  ].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
  const prerequisiteEvidence = prerequisitePaths.map((path, index) => ({
    path,
    sha256: digest(String.fromCharCode(99 + index)),
  }));
  const replaceContentDigests = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replaceContentDigests);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.kind === "staged-file" && typeof record.relativePath === "string") {
      return {
        ...record,
        sha256: prerequisiteEvidence.find(({ path }) => path === record.relativePath)?.sha256,
      };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, replaceContentDigests(entry)]),
    );
  };
  const steps = replaceContentDigests(options.steps) as readonly ProbeNativeActionPlanStep[];
  const plan = createProbeNativeActionPlan({
    ...identity,
    steps,
    prerequisiteEvidence,
  });
  const planPath = `runtime/work/${identity.campaignRunId}/${identity.attemptId}/${identity.workId}/driver-plans/${identity.consumerActionId}.json`;
  const receiptSha256 = digest("f");
  const runtimeInput = {
    command: {
      schemaVersion: 1,
      kind: "windows-host-probe-runner-command",
      mode: "authoritative",
      command: "segment",
      campaignRunId: identity.campaignRunId,
      planSha256: PROBE_RUN_PLAN_SHA256,
      attemptId: identity.attemptId,
      environmentId: identity.environmentId,
      pathProfileId: identity.pathProfileId,
      rowId: identity.rowId,
      variantId: identity.variantId,
      workId: identity.workId,
      stageIndex: workItem.stageIndex,
    },
    workItem,
    preparedContext: {
      campaignRunId: identity.campaignRunId,
      executionRunId: identity.executionRunId,
      attemptId: identity.attemptId,
      environmentId: identity.environmentId,
      pathProfileId: identity.pathProfileId,
      candidateSha256: identity.candidateSha256,
    },
    invocation: {
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: identity.rowId,
      variantId: identity.variantId,
      planSha256: definition.planSha256,
      action,
    },
    operationId: identity.operationId,
  };
  const verifiedControllerPlan = {
    plan,
    executionReceipt: {
      producerActionId: producer.actionId,
      receiptSha256,
      nativeActionPlans: [{ path: planPath, sha256: sha256Text(canonicalProbeJson(plan)) }],
    },
    provenance: {
      producerActionId: producer.actionId,
      receiptSha256,
      coordinate: {
        campaignRunId: identity.campaignRunId,
        executionRunId: identity.executionRunId,
        attemptId: identity.attemptId,
        workId: identity.workId,
        environmentId: identity.environmentId,
        pathProfileId: identity.pathProfileId,
        rowId: identity.rowId,
        variantId: identity.variantId,
      },
    },
  };
  return {
    plan,
    runtimeInput,
    verifiedControllerPlan,
    verifiedPrerequisites: prerequisiteEvidence,
    validationInput: {
      plan,
      verifiedControllerPlan,
      input: runtimeInput,
      verifiedPrerequisites: prerequisiteEvidence,
    } as unknown as ProbeNativeLanePlanValidationInput,
  };
}

function step(
  sequence: number,
  stepId: string,
  command: ProbeNativeActionPlanStep["command"],
  request: Readonly<Record<string, unknown>>,
  recoveryClass: ProbeNativeActionPlanStep["recoveryClass"],
): ProbeNativeActionPlanStep {
  return {
    sequence,
    stepId,
    command,
    request,
    timeoutMs: 30_000,
    recoveryClass,
  } as ProbeNativeActionPlanStep;
}

function f01Fixture(variantId = "f01-ordinary-absolute-path") {
  const paths: Record<string, readonly [string, string]> = {
    "f01-8dot3-short-name-alias": ["targets/home-with-long-name", "targets/HOME-W~1"],
    "f01-actual-component-case-alias": ["targets/Home", "targets/home"],
    "f01-directory-junction-alias": ["targets/home", "targets/home-junction"],
    "f01-distinct-homes": ["targets/home-a", "targets/home-b"],
    "f01-ordinary-absolute-path": ["targets/home", "targets/home"],
    "f01-relocate-copy-rebind": ["targets/home-original", "targets/home-copy"],
    "f01-spaces-unicode-path": ["targets/spaces ü/home", "targets/spaces ü/home"],
  };
  const selected = paths[variantId] ?? ["targets/home", "targets/home"];
  return fixture({
    rowId: "F-01",
    variantId,
    actionId: "capture-home-identity",
    steps: [
      step(1, "observe-home", "home-identity", { relativePath: selected[0] }, "read-only-replay"),
      step(
        2,
        "observe-comparison-home",
        "home-identity",
        { relativePath: selected[1] },
        "read-only-replay",
      ),
    ],
  });
}

function f02EnsureFixture(variantId = "f02-create-private-directory") {
  const { action } = actionFor("F-02", variantId, "capture-directory-ensure");
  return fixture({
    rowId: "F-02",
    variantId,
    actionId: "capture-directory-ensure",
    steps: [
      step(
        1,
        "ensure-directory",
        "private-directory-ensure",
        {
          relativePath: `targets/private-directory/${String(action.parameters.rootClass)}`,
          action: action.parameters.operation,
        },
        "inspect-and-reconcile",
      ),
    ],
  });
}

function f03IdentityFixture(variantId = "f03-port-directory") {
  const payloadKind = variantId.split("-")[1];
  return fixture({
    rowId: "F-03",
    variantId,
    actionId: "capture-target-identity",
    steps: [
      step(
        1,
        "inspect-target",
        "file-identity",
        { relativePath: `targets/private-files/${payloadKind}.bin` },
        "read-only-replay",
      ),
    ],
  });
}

function f03CreateFixture(variantId = "f03-port-directory") {
  const payloadKind = variantId.split("-")[1];
  const { action } = actionFor("F-03", variantId, "capture-private-file-create");
  const sizes = action.parameters.testedPayloadBytes as readonly number[];
  const base = {
    campaignRunId: "campaign-run",
    attemptId: "attempt-one",
    workId: getProbeRunWorkItem({
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F-03",
      variantId,
    }).workId,
    consumerActionId: "capture-private-file-create",
  };
  const leaves = sizes.map((bytes) => `${payloadKind}-${bytes}.bin`);
  return fixture({
    rowId: "F-03",
    variantId,
    actionId: "capture-private-file-create",
    inputLeaves: leaves,
    steps: sizes.map((bytes, index) =>
      step(
        index + 1,
        `create-${bytes}`,
        "private-file-create",
        {
          relativePath: `targets/private-files/${payloadKind}.bin`,
          contentSource: {
            kind: "staged-file",
            relativePath: driverInputPath(base, leaves[index] ?? "missing"),
            bytes,
            sha256: digest("f"),
          },
        },
        "never-auto-replay",
      ),
    ),
  });
}

function f04Fixture(
  variantId = "f04-normal-nested-read",
  actionId = "capture-secure-path-operation",
) {
  const parsed = /^f04-(.+)-(create|delete|quarantine|read|replace)$/u.exec(variantId);
  if (parsed === null) throw new Error("invalid F-04 test variant");
  const pathTopology = parsed[1];
  const operation = parsed[2];
  const base = {
    campaignRunId: "campaign-run",
    attemptId: "attempt-one",
    workId: getProbeRunWorkItem({
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F-04",
      variantId,
    }).workId,
    consumerActionId: actionId,
  };
  if (actionId === "capture-evidence-tree-seal") {
    return fixture({
      rowId: "F-04",
      variantId,
      actionId,
      steps: [
        step(
          1,
          "seal-tree",
          "evidence-tree-seal",
          {
            relativePath: `targets/secure-path/${pathTopology}`,
            mode: "digest-only",
            maxDepth: 8,
            maxEntries: 256,
            maxFileBytes: 1_048_576,
            maxTotalBytes: 8_388_608,
          },
          "read-only-replay",
        ),
      ],
    });
  }
  const inputLeaves = ["create", "replace"].includes(operation) ? ["content.bin"] : [];
  const request: Record<string, unknown> = {
    relativePath: `targets/secure-path/${pathTopology}/target.bin`,
    operation,
  };
  if (inputLeaves.length > 0) {
    request.contentSource = {
      kind: "staged-file",
      relativePath: driverInputPath(base, "content.bin"),
      bytes: 4096,
      sha256: digest("f"),
    };
  }
  if (operation === "quarantine") {
    request.destinationRelativePath = `targets/secure-path/${pathTopology}/quarantined.bin`;
  }
  return fixture({
    rowId: "F-04",
    variantId,
    actionId,
    inputLeaves,
    steps: [step(1, "operate-path", "secure-path-operation", request, "never-auto-replay")],
  });
}

function f05Fixture(
  variantId = "f05-delete-same-object-same-process",
  actionId = "capture-inspected-identity",
) {
  const operation = variantId.split("-")[1];
  if (actionId === "capture-inspected-identity") {
    return fixture({
      rowId: "F-05",
      variantId,
      actionId,
      steps: [
        step(
          1,
          "inspect-object",
          "file-identity",
          { relativePath: `targets/object-lifetime/${operation}/target.bin` },
          "read-only-replay",
        ),
      ],
    });
  }
  const request: Record<string, unknown> = {
    relativePath: `targets/object-lifetime/${operation}/target.bin`,
    operation,
    expectedIdentity: `file-v1:${digest("a")}`,
  };
  if (operation === "quarantine") {
    request.destinationRelativePath = `targets/object-lifetime/${operation}/quarantined.bin`;
  }
  return fixture({
    rowId: "F-05",
    variantId,
    actionId,
    steps: [step(1, "mutate-object", "secure-path-operation", request, "never-auto-replay")],
  });
}

function rebuildPlan(
  plan: ProbeNativeActionPlan,
  changes: Partial<Pick<ProbeNativeActionPlan, "steps" | "prerequisiteEvidence">>,
) {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    campaignId: _campaignId,
    manifestSha256: _manifestSha256,
    runPlanSha256: _runPlanSha256,
    actionPlanSha256: _actionPlanSha256,
    ...input
  } = plan;
  return createProbeNativeActionPlan({ ...input, ...changes });
}

function withPlan(
  source: ReturnType<typeof fixture>,
  plan: ProbeNativeActionPlan,
): ProbeNativeLanePlanValidationInput {
  return {
    ...source.validationInput,
    plan,
    verifiedControllerPlan: {
      ...source.verifiedControllerPlan,
      plan,
      executionReceipt: {
        ...source.verifiedControllerPlan.executionReceipt,
        nativeActionPlans: [
          {
            path: `runtime/work/${plan.campaignRunId}/${plan.attemptId}/${plan.workId}/driver-plans/${plan.consumerActionId}.json`,
            sha256: sha256Text(canonicalProbeJson(plan)),
          },
        ],
      },
    },
    verifiedPrerequisites: plan.prerequisiteEvidence,
  } as unknown as ProbeNativeLanePlanValidationInput;
}

function projectionInput(
  source: ReturnType<typeof fixture>,
  primaryStepId: string,
  outcomes: readonly ProbeNativeLaneStepOutcome[],
) {
  const steps = source.plan.steps.map((planStep, index) => ({
    step: planStep,
    operationId: deriveProbeNativeActionPlanStepOperationId(source.plan, planStep.stepId),
    outcome: outcomes[index] as ProbeNativeLaneStepOutcome,
    recordSha256: digest(String(index + 1)),
  }));
  const primary = steps.find((entry) => entry.step.stepId === primaryStepId);
  if (primary === undefined) throw new Error("missing primary test step");
  return {
    input: source.runtimeInput,
    validatedPlan: { plan: source.plan, primaryStepId },
    verifiedControllerPlan: source.verifiedControllerPlan,
    verifiedPrerequisites: source.verifiedPrerequisites,
    transcript: {},
    primaryRecord: {
      kind: "command",
      command: primary.step.command,
      operationId: primary.operationId,
    },
    steps,
  } as unknown as ProbeNativeLaneProjectionInput;
}

function facts(result: { readonly observations: readonly { factKey: string; value: unknown }[] }) {
  return Object.fromEntries(result.observations.map(({ factKey, value }) => [factKey, value]));
}

const nativeError = (code = "ACCESS_DENIED", win32Code: number | null = 5) => ({
  ok: false as const,
  error: { code, message: "native refusal", win32Code },
});

const homeResult = (character: string) => ({
  ok: true as const,
  result: {
    canonicalHomeId: `win-home-v1:${digest(character)}`,
    objectIdentity: `file-v1:${digest(character)}`,
    volumeIdentity: `volume-v1:${digest("f")}`,
    finalPathSha256: digest(character),
    fileSystem: "NTFS" as const,
    driveType: "fixed" as const,
    reparseTag: 0,
    linkCount: 1,
  },
});

const privateDirectoryResult = {
  ok: true as const,
  result: {
    objectIdentity: `file-v1:${digest("a")}`,
    ownerSidSha256: digest("b"),
    protectedAcl: true,
    principals: ["current-user", "System", "Administrators"] as const,
    unexpectedAceCount: 0,
    sddlSha256: digest("c"),
  },
};

describe("trusted native row-driver registry", () => {
  it("closes exactly the nine lane keys with action-map-consistent immutable metadata", () => {
    expect(Object.keys(PROBE_NATIVE_ROW_DRIVERS)).toEqual(driverKeys);
    expect(Object.isFrozen(PROBE_NATIVE_ROW_DRIVERS)).toBe(true);
    for (const key of driverKeys) {
      const driver = PROBE_NATIVE_ROW_DRIVERS[key];
      const [rowId, actionId] = key.split(":");
      const actions = PROBE_SCENARIO_DEFINITIONS.filter((entry) => entry.rowId === rowId).map(
        (entry) => entry.actions.find((action) => action.actionId === actionId),
      );
      expect(actions.every((action) => action !== undefined)).toBe(true);
      const action = actions[0];
      if (action === undefined || action.capture === null) throw new Error("missing metadata");
      const mapping = getProbeActionMapping(action.actor, action.operation);
      expect(driver).toMatchObject({
        rowId,
        actionId,
        operation: action.operation,
        driverId: mapping.driverId,
        captureCommandId: action.capture.commandId,
        factKeys: action.capture.factKeys,
      });
      expect(Object.isFrozen(driver)).toBe(true);
      expect(Object.isFrozen(driver.factKeys)).toBe(true);
    }
  });

  it.each([
    ["F-01:capture-home-identity", f01Fixture(), "observe-home"],
    ["F-02:capture-directory-ensure", f02EnsureFixture(), "ensure-directory"],
    [
      "F-02:capture-directory-ensure",
      f02EnsureFixture("f02-broad-everyone-repair"),
      "ensure-directory",
    ],
    ["F-03:capture-target-identity", f03IdentityFixture(), "inspect-target"],
    ["F-03:capture-private-file-create", f03CreateFixture(), "create-128"],
    ["F-04:capture-secure-path-operation", f04Fixture(), "operate-path"],
    ["F-04:capture-secure-path-operation", f04Fixture("f04-normal-nested-create"), "operate-path"],
    ["F-05:capture-inspected-identity", f05Fixture(), "inspect-object"],
    [
      "F-05:capture-handle-bound-mutation",
      f05Fixture("f05-quarantine-same-object-same-process", "capture-handle-bound-mutation"),
      "mutate-object",
    ],
  ] satisfies readonly [DriverKey, ReturnType<typeof fixture>, string][])(
    "validates the exact supported plan for %s",
    async (key, source, primaryStepId) => {
      await expect(
        PROBE_NATIVE_ROW_DRIVERS[key].validateActionPlan(source.validationInput),
      ).resolves.toEqual({ plan: source.plan, primaryStepId });
    },
  );

  it.each([
    [
      "F-01:capture-home-identity",
      f01Fixture("f01-drive-letter-case-alias"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_PATH_TOPOLOGY",
    ],
    [
      "F-01:capture-home-identity",
      f01Fixture("f01-restart-stability"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_LIFECYCLE",
    ],
    [
      "F-01:capture-home-identity",
      f01Fixture("f01-rename-rebind"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F01_PRIOR_IDENTITY",
    ],
    [
      "F-02:capture-directory-ensure",
      f02EnsureFixture("f02-owner-read"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F02_OPERATION",
    ],
    [
      "F-02:capture-directory-inspection",
      fixture({
        rowId: "F-02",
        variantId: "f02-create-private-directory",
        actionId: "capture-directory-inspection",
        steps: [
          step(
            1,
            "inspect-directory",
            "private-directory-inspect",
            { relativePath: "targets/private-directory/fresh-private" },
            "read-only-replay",
          ),
        ],
      }),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F02_EFFECTIVE_ACCESS",
    ],
    [
      "F-03:capture-target-identity",
      f03IdentityFixture("f03-port-absent"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_ACCEPTED_TARGET",
    ],
    [
      "F-03:capture-private-file-create",
      f03CreateFixture("f03-port-inspect-create-swap"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_SWAP_TIMING",
    ],
    [
      "F-04:capture-secure-path-operation",
      f04Fixture("f04-concurrent-swap-loop-read"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F04_RACE_EVIDENCE",
    ],
    [
      "F-04:capture-evidence-tree-seal",
      f04Fixture("f04-normal-nested-read", "capture-evidence-tree-seal"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F04_BEFORE_SEAL",
    ],
    [
      "F-05:capture-inspected-identity",
      f05Fixture("f05-delete-stale-identity-same-process"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_STALE_IDENTITY",
    ],
    [
      "F-05:capture-inspected-identity",
      f05Fixture("f05-delete-same-object-hard-link"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_LIFETIME",
    ],
    [
      "F-05:capture-handle-bound-mutation",
      f05Fixture("f05-replace-same-object-same-process", "capture-handle-bound-mutation"),
      "NATIVE_ROW_DRIVER_ARCHITECTURE_F05_REPLACE_RESULT",
    ],
  ] satisfies readonly [DriverKey, ReturnType<typeof fixture>, string][])(
    "fails closed for the unsupported architecture behind %s",
    async (key, source, code) => {
      await expect(
        PROBE_NATIVE_ROW_DRIVERS[key].validateActionPlan(source.validationInput),
      ).rejects.toEqual(expect.objectContaining({ code }));
    },
  );

  it.each([
    [
      "extra command",
      () => {
        const source = f04Fixture();
        const plan = rebuildPlan(source.plan, {
          steps: [
            ...source.plan.steps,
            step(
              2,
              "inspect-again",
              "file-identity",
              { relativePath: "targets/secure-path/normal-nested/target.bin" },
              "read-only-replay",
            ),
          ],
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_SHAPE"] as const;
      },
    ],
    [
      "wrong order",
      () => {
        const source = f01Fixture();
        const [first, second] = source.plan.steps;
        const plan = rebuildPlan(source.plan, {
          steps: [
            { ...second, sequence: 1 },
            { ...first, sequence: 2 },
          ] as readonly ProbeNativeActionPlanStep[],
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_ORDER"] as const;
      },
    ],
    [
      "wrong recovery",
      () => {
        const source = f02EnsureFixture();
        const plan = rebuildPlan(source.plan, {
          steps: [
            { ...source.plan.steps[0], recoveryClass: "never-auto-replay" },
          ] as readonly ProbeNativeActionPlanStep[],
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_RECOVERY"] as const;
      },
    ],
    [
      "wrong path",
      () => {
        const source = f04Fixture();
        const plan = rebuildPlan(source.plan, {
          steps: [
            {
              ...source.plan.steps[0],
              request: { relativePath: "targets/other.bin", operation: "read" },
            },
          ] as readonly ProbeNativeActionPlanStep[],
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_REQUEST"] as const;
      },
    ],
    [
      "wrong content",
      () => {
        const source = f04Fixture("f04-normal-nested-create");
        const original = source.plan.steps[0];
        const contentSource = (original.request as { contentSource: Record<string, unknown> })
          .contentSource;
        const plan = rebuildPlan(source.plan, {
          steps: [
            {
              ...original,
              request: {
                ...original.request,
                contentSource: { ...contentSource, bytes: 4095 },
              },
            },
          ] as readonly ProbeNativeActionPlanStep[],
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_REQUEST"] as const;
      },
    ],
    [
      "extra prerequisite",
      () => {
        const source = f04Fixture();
        const plan = rebuildPlan(source.plan, {
          prerequisiteEvidence: [
            { path: "extra/controller.json", sha256: digest("e") },
            ...source.plan.prerequisiteEvidence,
          ].sort((left, right) =>
            Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")),
          ),
        });
        return [source, plan, "NATIVE_ROW_DRIVER_PLAN_PREREQUISITE"] as const;
      },
    ],
  ])("rejects a signed plan with %s", async (_label, build) => {
    const [source, plan, code] = build();
    const key = `${source.plan.rowId}:${source.plan.consumerActionId}` as DriverKey;
    await expect(
      PROBE_NATIVE_ROW_DRIVERS[key].validateActionPlan(withPlan(source, plan)),
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("projects F-01 only from the two verified home results", async () => {
    const source = f01Fixture();
    const result = await PROBE_NATIVE_ROW_DRIVERS["F-01:capture-home-identity"].projectActionResult(
      projectionInput(source, "observe-home", [homeResult("a"), homeResult("b")]),
    );
    expect(Object.keys(result)).toEqual(["observations"]);
    expect(facts(result)).toEqual({
      canonicalIdentitySha256: sha256Text(`win-home-v1:${digest("a")}`),
      comparisonIdentitySha256: sha256Text(`win-home-v1:${digest("b")}`),
      credentialReadAttempted: false,
      lifecycle: "same-process",
      localPathSha256: digest("a"),
      pathTopology: "ordinary-absolute-path",
      processRole: "main",
      reasonCode: null,
      volumeDriveType: "fixed",
      volumeFileSystem: "NTFS",
      volumeIdentitySha256: sha256Text(`volume-v1:${digest("f")}`),
      win32Error: null,
    });
  });

  it("projects F-02 ensure success and a typed native error without ACL inference", async () => {
    const source = f02EnsureFixture();
    const driver = PROBE_NATIVE_ROW_DRIVERS["F-02:capture-directory-ensure"];
    const success = await driver.projectActionResult(
      projectionInput(source, "ensure-directory", [privateDirectoryResult]),
    );
    expect(facts(success)).toEqual({
      actor: "current-user",
      operation: "create",
      operationApplied: true,
      reasonCode: null,
      rootClass: "fresh-private",
      win32Error: null,
    });
    const refused = await driver.projectActionResult(
      projectionInput(source, "ensure-directory", [nativeError()]),
    );
    expect(facts(refused)).toMatchObject({
      operationApplied: false,
      reasonCode: "ACCESS_DENIED",
      win32Error: 5,
    });
  });

  it("projects F-03 refusal mechanics and rejects an unexpected success", async () => {
    const identitySource = f03IdentityFixture("f03-port-hard-link");
    const identity = await PROBE_NATIVE_ROW_DRIVERS[
      "F-03:capture-target-identity"
    ].projectActionResult(
      projectionInput(identitySource, "inspect-target", [
        {
          ok: true,
          result: { objectIdentity: `file-v1:${digest("a")}`, linkCount: 2 },
        },
      ]),
    );
    expect(facts(identity)).toMatchObject({
      targetTopology: "hard-link",
      finalObjectType: "regular-file",
      linkCount: 2,
      reparseTag: 0,
      outsideMutationCount: 0,
    });

    const createSource = f03CreateFixture("f03-port-directory");
    const driver = PROBE_NATIVE_ROW_DRIVERS["F-03:capture-private-file-create"];
    const refusal = await driver.projectActionResult(
      projectionInput(
        createSource,
        "create-128",
        createSource.plan.steps.map(() => nativeError("TARGET_EXISTS", 183)),
      ),
    );
    expect(facts(refusal)).toMatchObject({
      operationApplied: false,
      reasonCode: "TARGET_EXISTS",
      testedPayloadBytes: [128, 4096],
      writtenPayloadSha256: null,
      readBackPayloadSha256: null,
    });
    await expect(
      driver.projectActionResult(
        projectionInput(createSource, "create-128", [
          {
            ok: true,
            result: {
              objectIdentity: `file-v1:${digest("a")}`,
              linkCount: 1,
              bytesWritten: 128,
              sddlSha256: digest("b"),
            },
          },
          nativeError("TARGET_EXISTS", 183),
        ]),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "NATIVE_ROW_DRIVER_ARCHITECTURE_F03_UNEXPECTED_SUCCESS" }),
    );
  });

  it("projects non-race F-04 native outcomes without inventing worker measurements", async () => {
    const source = f04Fixture("f04-leaf-symlink-read");
    const driver = PROBE_NATIVE_ROW_DRIVERS["F-04:capture-secure-path-operation"];
    const refused = await driver.projectActionResult(
      projectionInput(source, "operate-path", [
        {
          ok: true,
          result: {
            outcome: "refused",
            objectIdentity: null,
            contentSha256: null,
            win32Code: null,
            reasonCode: "REPARSE_POINT",
          },
        },
      ]),
    );
    expect(facts(refused)).toEqual({
      durationMs: 0,
      operation: "read",
      operationApplied: false,
      operationWorkerCount: 1,
      pathTopology: "leaf-symlink",
      reasonCode: "REPARSE_POINT",
      swapWorkerCount: 0,
      win32Error: null,
    });
  });

  it("cross-checks F-05 acted identity and rejects a mismatched completed result", async () => {
    const identitySource = f05Fixture();
    const identity = await PROBE_NATIVE_ROW_DRIVERS[
      "F-05:capture-inspected-identity"
    ].projectActionResult(
      projectionInput(identitySource, "inspect-object", [
        {
          ok: true,
          result: { objectIdentity: `file-v1:${digest("a")}`, linkCount: 1 },
        },
      ]),
    );
    expect(facts(identity)).toMatchObject({
      identityClass: "same-object",
      lifetime: "same-process",
      processRestartObserved: false,
      hardLinkAliasObserved: false,
    });

    const mutationSource = f05Fixture(
      "f05-delete-same-object-same-process",
      "capture-handle-bound-mutation",
    );
    const driver = PROBE_NATIVE_ROW_DRIVERS["F-05:capture-handle-bound-mutation"];
    const completed = await driver.projectActionResult(
      projectionInput(mutationSource, "mutate-object", [
        {
          ok: true,
          result: {
            outcome: "completed",
            objectIdentity: `file-v1:${digest("a")}`,
            contentSha256: null,
            win32Code: null,
            reasonCode: null,
          },
        },
      ]),
    );
    expect(facts(completed)).toMatchObject({
      operation: "delete",
      operationApplied: true,
      actedObjectIdentitySha256: sha256Text(`file-v1:${digest("a")}`),
      identityCheckCount: 1,
      unrelatedMutationCount: 0,
    });
    await expect(
      driver.projectActionResult(
        projectionInput(mutationSource, "mutate-object", [
          {
            ok: true,
            result: {
              outcome: "completed",
              objectIdentity: `file-v1:${digest("b")}`,
              contentSha256: null,
              win32Code: null,
              reasonCode: null,
            },
          },
        ]),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "NATIVE_ROW_DRIVER_RESULT_IDENTITY" }));
  });

  it("rejects projection provenance and verified prerequisite substitution", async () => {
    const source = f02EnsureFixture();
    const driver = PROBE_NATIVE_ROW_DRIVERS["F-02:capture-directory-ensure"];
    const projection = projectionInput(source, "ensure-directory", [privateDirectoryResult]);
    await expect(
      driver.projectActionResult({
        ...projection,
        verifiedPrerequisites: [],
      } as unknown as ProbeNativeLaneProjectionInput),
    ).rejects.toBeInstanceOf(ProbeNativeRowDriverError);
    await expect(
      driver.projectActionResult({
        ...projection,
        steps: [{ ...projection.steps[0], recordSha256: digest("A") }],
      } as unknown as ProbeNativeLaneProjectionInput),
    ).rejects.toEqual(expect.objectContaining({ code: "NATIVE_ROW_DRIVER_PROVENANCE" }));
  });
});
