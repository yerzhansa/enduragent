import { describe, expect, it } from "vitest";

import {
  ProbeNativeActionPlanError,
  createProbeNativeActionPlan,
  deriveProbeNativeActionPlanStepOperationId,
  probeNativeActionPlanPath,
  validateProbeNativeActionPlan,
  verifyProbeNativeActionPlanBinding,
} from "../scripts/windows-host-falsifier/probe-native-action-plan.mjs";
import {
  PROBE_RUN_PLAN_SHA256,
  getProbeRunWorkItem,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const digest = (character: string) => character.repeat(64);

function planInput() {
  return {
    candidateSha256: digest("a"),
    campaignRunId: "campaign-run",
    executionRunId: "execution-run",
    attemptId: "attempt-one",
    workId: getProbeRunWorkItem({
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
    }).workId,
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    rowId: "F-01",
    variantId: "f01-ordinary-absolute-path",
    scenarioPlanSha256: getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path").planSha256,
    producerActionId: "prepare-home-topology",
    consumerActionId: "capture-home-identity",
    operationId: "operation-one",
    evidenceRootObjectIdentitySha256: digest("b"),
    steps: [
      {
        sequence: 1,
        stepId: "observe-home",
        command: "home-identity" as const,
        request: { relativePath: "targets/home" },
        timeoutMs: 30_000,
        recoveryClass: "read-only-replay" as const,
      },
    ],
    prerequisiteEvidence: [{ path: "controller/observations/spaces ü.json", sha256: digest("c") }],
  };
}

function bindingInput() {
  const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
  const action = definition.actions.find((entry) => entry.actionId === "capture-home-identity");
  if (action === undefined) throw new Error("fixture action is missing");
  const workItem = getProbeRunWorkItem({
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    rowId: "F-01",
    variantId: "f01-ordinary-absolute-path",
  });
  return {
    command: {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-runner-command" as const,
      mode: "authoritative" as const,
      command: "segment" as const,
      campaignRunId: "campaign-run",
      planSha256: PROBE_RUN_PLAN_SHA256,
      attemptId: "attempt-one",
      environmentId: "win11-floor" as const,
      pathProfileId: "ascii" as const,
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      workId: workItem.workId,
      stageIndex: workItem.stageIndex,
    },
    workItem,
    preparedContext: {
      campaignRunId: "campaign-run",
      executionRunId: "execution-run",
      attemptId: "attempt-one",
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      candidateSha256: digest("a"),
    },
    invocation: {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-scenario-action-invocation" as const,
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      planSha256: definition.planSha256,
      action,
    },
    operationId: "operation-one",
    evidenceRootObjectIdentitySha256: digest("b"),
  };
}

describe("native action plan", () => {
  it("derives the one deterministic driver-plan artifact path", () => {
    expect(
      probeNativeActionPlanPath({
        campaignRunId: "campaign-run",
        attemptId: "attempt-one",
        workId: "work-0001",
        consumerActionId: "capture-home-identity",
      }),
    ).toBe(
      "runtime/work/campaign-run/attempt-one/work-0001/driver-plans/capture-home-identity.json",
    );
    expect(() =>
      probeNativeActionPlanPath({
        campaignRunId: "../escape",
        attemptId: "attempt-one",
        workId: "work-0001",
        consumerActionId: "capture-home-identity",
      }),
    ).toThrowError(ProbeNativeActionPlanError);
  });

  it("creates a canonical, immutable, self-digested plan", () => {
    const plan = createProbeNativeActionPlan(planInput());
    expect(validateProbeNativeActionPlan(plan)).toBeDefined();
    expect(plan.actionPlanSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps[0]?.request)).toBe(true);
    expect(deriveProbeNativeActionPlanStepOperationId(plan, "observe-home")).toMatch(
      /^native-step-[a-f0-9]{32}$/u,
    );
  });

  it("binds an earlier controller producer to the exact native consumer and runtime", () => {
    const plan = createProbeNativeActionPlan(planInput());
    expect(verifyProbeNativeActionPlanBinding(plan, bindingInput())).toEqual(plan);
  });

  it("rejects digest and coordinate substitution", () => {
    const plan = createProbeNativeActionPlan(planInput());
    expect(() =>
      validateProbeNativeActionPlan({ ...plan, candidateSha256: digest("d") }),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_DIGEST",
      }),
    );
    expect(() =>
      verifyProbeNativeActionPlanBinding(plan, {
        ...bindingInput(),
        operationId: "operation-two",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_BINDING",
      }),
    );
  });

  it("rejects absolute paths and embedded authority material", () => {
    for (const request of [
      { relativePath: "C:\\Users\\runner\\secret" },
      { evidenceRoot: "targets/root" },
      { privateKey: "not-allowed" },
    ]) {
      expect(() =>
        createProbeNativeActionPlan({
          ...planInput(),
          steps: [{ ...planInput().steps[0], request }],
        }),
      ).toThrowError(ProbeNativeActionPlanError);
    }
  });

  it("rejects sparse arrays and replay classifications that can repeat mutations", () => {
    const sparse: unknown[] = [];
    sparse[1] = "value";
    expect(() =>
      createProbeNativeActionPlan({
        ...planInput(),
        steps: [{ ...planInput().steps[0], request: { values: sparse } }],
      }),
    ).toThrowError(ProbeNativeActionPlanError);
    expect(() =>
      createProbeNativeActionPlan({
        ...planInput(),
        steps: [
          {
            ...planInput().steps[0],
            command: "private-file-create",
            request: {
              relativePath: "file",
              contentSource: {
                kind: "deterministic",
                seedHex: "00",
                bytes: 1,
                sha256: digest("e"),
              },
            },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_RECOVERY",
      }),
    );
  });

  it("uses the preflight-bound evidence root for root-bearing native commands", () => {
    const rootBoundStep = {
      ...planInput().steps[0],
      command: "private-file-create" as const,
      request: {
        relativePath: "targets/file",
        contentSource: {
          kind: "deterministic",
          seedHex: digest("d"),
          bytes: 1,
          sha256: digest("e"),
        },
      },
      recoveryClass: "never-auto-replay" as const,
    };
    expect(
      createProbeNativeActionPlan({ ...planInput(), steps: [rootBoundStep] }).steps[0]?.request,
    ).not.toHaveProperty("root");
    expect(() =>
      createProbeNativeActionPlan({
        ...planInput(),
        steps: [{ ...rootBoundStep, request: { ...rootBoundStep.request, root: "targets" } }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_ROOT_BINDING",
      }),
    );
  });

  it("requires sorted safe prerequisite references and an exact schema", () => {
    expect(() =>
      createProbeNativeActionPlan({
        ...planInput(),
        prerequisiteEvidence: [
          {
            path: "runtime/native-operation-journals/campaign/attempt/native-operations.sqlite",
            sha256: digest("a"),
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_RESERVED_PATH",
      }),
    );
    expect(() =>
      createProbeNativeActionPlan({
        ...planInput(),
        prerequisiteEvidence: [
          { path: "z.json", sha256: digest("a") },
          { path: "A.json", sha256: digest("b") },
        ],
      }),
    ).toThrowError(ProbeNativeActionPlanError);
    expect(() =>
      createProbeNativeActionPlan({ ...planInput(), extra: true } as never),
    ).toThrowError(
      expect.objectContaining<Partial<ProbeNativeActionPlanError>>({
        code: "NATIVE_ACTION_PLAN_SCHEMA",
      }),
    );
  });
});
