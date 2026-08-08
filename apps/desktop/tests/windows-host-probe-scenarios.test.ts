import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROBE_CAMPAIGN_MANIFEST,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { getProbeTranscriptFactDefinition } from "../scripts/windows-host-falsifier/probe-registry.mjs";
import {
  PROBE_SCENARIO_DEFINITIONS,
  ProbeScenarioError,
  executeProbeScenario,
  executeProbeScenarioActionSlice,
  getProbeScenarioDefinition,
  type ProbeScenarioActionInvocation,
  type ProbeScenarioActionResult,
  type ProbeScenarioActionSeam,
  type ProbeScenarioDefinition,
} from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import type {
  ProbeTranscriptFactValue,
  ProbeTranscriptObservation,
} from "../scripts/windows-host-falsifier/probe-transcript.mjs";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function expectedCoordinates() {
  return PROBE_CAMPAIGN_MANIFEST.rows.flatMap((row) => [
    ...row.requiredVariantIds.map((variantId) => `${row.rowId}/${variantId}`),
    ...row.conditionalVariants.map(({ variantId }) => `${row.rowId}/${variantId}`),
  ]);
}

function observation(
  factKey: string,
  value: ProbeTranscriptFactValue = null,
): ProbeTranscriptObservation {
  if (value === null) return { factKey, valueKind: "null", value };
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "boolean")) {
      return { factKey, valueKind: "boolean-array", value: value as readonly boolean[] };
    }
    if (value.every((entry) => typeof entry === "number")) {
      return { factKey, valueKind: "number-array", value: value as readonly number[] };
    }
    return { factKey, valueKind: "string-array", value: value as readonly string[] };
  }
  if (typeof value === "boolean") return { factKey, valueKind: "boolean", value };
  if (typeof value === "number") return { factKey, valueKind: "number", value };
  return { factKey, valueKind: "string", value };
}

function actionResult(
  invocation: ProbeScenarioActionInvocation,
  values: Readonly<Record<string, ProbeTranscriptFactValue>> = {},
): ProbeScenarioActionResult {
  const { action } = invocation;
  return {
    actionId: action.actionId,
    commandEvent:
      action.capture === null
        ? null
        : {
            sequence: action.capture.sequence,
            producerKind: action.actor,
            commandId: action.capture.commandId,
            requestSha256: sha256(`request:${action.actionId}`),
            responseSha256: sha256(`response:${action.actionId}`),
            nativeTranscriptSha256s: [sha256(`native:${invocation.rowId}:${invocation.variantId}`)],
            observations: action.capture.factKeys.map((factKey) =>
              observation(factKey, values[factKey]),
            ),
          },
    evidenceArtifacts: [
      {
        path: `actions/${String(action.sequence).padStart(2, "0")}-${action.actionId}.json`,
        sha256: sha256(`evidence:${action.actionId}`),
      },
    ],
  };
}

function expectCode(work: () => unknown | Promise<unknown>, code: string) {
  return Promise.resolve()
    .then(work)
    .then(
      () => {
        throw new Error("expected scenario boundary to fail");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ProbeScenarioError);
        expect(error).toMatchObject({ code });
      },
    );
}

function action(definition: ProbeScenarioDefinition, actionId: string) {
  const found = definition.actions.find((candidate) => candidate.actionId === actionId);
  expect(found, `${definition.rowId}/${definition.variantId}/${actionId}`).toBeDefined();
  return found!;
}

describe("Windows host probe scenario definitions", () => {
  it("closes every frozen F-01 through F-10 manifest coordinate exactly once", () => {
    const expected = expectedCoordinates().sort();
    const actual = PROBE_SCENARIO_DEFINITIONS.map(
      (definition) => `${definition.rowId}/${definition.variantId}`,
    ).sort();

    expect(PROBE_SCENARIO_DEFINITIONS).toHaveLength(261);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("binds immutable plans to the registry producer, commands, facts, and manifest prerequisites", () => {
    for (const definition of PROBE_SCENARIO_DEFINITIONS) {
      const row = PROBE_CAMPAIGN_MANIFEST.rows.find(
        (candidate) => candidate.rowId === definition.rowId,
      );
      expect(row).toBeDefined();
      const conditional = row!.conditionalVariants.find(
        (candidate) => candidate.variantId === definition.variantId,
      );
      const factDefinition = getProbeTranscriptFactDefinition(
        definition.rowId,
        definition.variantId,
      );
      const captures = definition.actions
        .flatMap((candidate) => (candidate.capture === null ? [] : [candidate.capture]))
        .sort((left, right) => left.sequence - right.sequence);
      const { planSha256: _planSha256, ...draft } = definition;

      expect(definition.transcriptProducerKind).toBe(
        factDefinition.transcriptKind === "windows-host-probe-native-transcript"
          ? "native-helper"
          : "external-controller",
      );
      expect(captures).toEqual(
        factDefinition.commands.map((command, index) => ({
          sequence: index + 1,
          commandId: command.commandId,
          factKeys: command.factKeys,
        })),
      );
      expect(definition.prerequisites).toMatchObject({
        completedRowIds: row!.dependsOnRowIds,
        conditionId: conditional?.conditionId ?? null,
      });
      expect(definition.planSha256).toBe(
        hashProbeCanonicalJson({
          domain: "enduragent.windows-host-probe-scenario-definition.v1",
          definition: draft,
        }),
      );
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.actions)).toBe(true);
      for (const [index, plannedAction] of definition.actions.entries()) {
        expect(plannedAction.sequence).toBe(index + 1);
        expect(Object.isFrozen(plannedAction.parameters)).toBe(true);
        expect(plannedAction.prerequisiteActionIds).toEqual(
          index === 0 ? [] : [definition.actions[index - 1].actionId],
        );
        if (plannedAction.capture !== null) {
          expect(plannedAction.actor).toBe(definition.transcriptProducerKind);
        }
      }
    }
  });

  it("contains scenario inputs and orchestration only, without verifier authority", () => {
    for (const definition of PROBE_SCENARIO_DEFINITIONS) {
      expect(definition).not.toHaveProperty("outcome");
      expect(definition).not.toHaveProperty("mechanism");
      expect(definition).not.toHaveProperty("verification");
      expect(definition).not.toHaveProperty("expectation");
      for (const plannedAction of definition.actions) {
        expect(plannedAction).not.toHaveProperty("outcome");
        expect(plannedAction).not.toHaveProperty("mechanism");
        expect(plannedAction).not.toHaveProperty("verification");
        expect(plannedAction).not.toHaveProperty("expectation");
      }
    }
  });

  it("makes row-specific Windows transitions and campaign bounds explicit", () => {
    const f01 = getProbeScenarioDefinition("F-01", "f01-reboot-stability");
    expect(f01.actions.map(({ actionId }) => actionId)).toEqual([
      "prepare-home-topology",
      "reboot-guest",
      "capture-home-identity",
    ]);
    expect(f01.prerequisites.attestationCapabilityIds).toContain("bootCompleteObservation");

    const f02 = getProbeScenarioDefinition("F-02", "f02-second-user-write-refusal");
    expect(action(f02, "exercise-directory-access").parameters).toEqual({
      actor: "second-user",
      operation: "write",
    });
    expect(f02.prerequisites.attestationCapabilityIds).toContain("secondStandardUser");

    const f03 = getProbeScenarioDefinition("F-03", "f03-profile-inspect-create-swap");
    expect(action(f03, "prepare-private-file-target").parameters).toEqual({
      payloadKind: "profile",
      targetTopology: "inspect-create-swap",
      testedPayloadBytes: [4096, 262144, 1048576],
    });
    expect(f03.actions.map(({ actionId }) => actionId)).toContain("arm-inspect-create-swap");

    const f04 = getProbeScenarioDefinition("F-04", "f04-concurrent-swap-loop-replace");
    expect(action(f04, "start-swap-workers").parameters).toEqual({
      durationMs: 30_000,
      minimumSwapCount: 10_000,
      operationWorkers: 8,
      swapWorkers: 4,
    });

    const f05 = getProbeScenarioDefinition("F-05", "f05-delete-stale-identity-process-restart");
    expect(f05.actions.map(({ actionId }) => actionId)).toEqual([
      "prepare-object-lifetime",
      "capture-inspected-identity",
      "restart-probe-process",
      "replace-inspected-object",
      "capture-handle-bound-mutation",
    ]);

    const f06 = getProbeScenarioDefinition(
      "F-06",
      "f06-defender-scan-during-write-share-denies-replace",
    );
    expect(action(f06, "start-defender-scan").parameters).toEqual({
      scanMode: "mpcmdrun-custom",
    });
    expect(f06.prerequisites.attestationCapabilityIds).toContain("defenderRealtimeEnabled");

    const f08 = getProbeScenarioDefinition("F-08", "f08-client-remote-pipe-refusal");
    expect(f08.actions.map(({ actionId }) => actionId)).toContain("start-remote-pipe-client");
    expect(f08.prerequisites.attestationCapabilityIds).toContain("remoteWindowsPeer");

    const f09 = getProbeScenarioDefinition("F-09", "f09-pid-reuse-pressure");
    expect(action(f09, "start-pid-pressure").parameters).toEqual({
      pidPressureCount: 20_000,
      pidPressureDeadlineMs: 120_000,
    });

    const f10 = getProbeScenarioDefinition("F-10", "f10-simultaneous-electron-launches");
    expect(action(f10, "launch-singleton-starters").parameters).toEqual({
      raceRounds: 100,
      starterCount: 32,
    });
    const f10Crash = getProbeScenarioDefinition("F-10", "f10-kill-after-port-bind");
    expect(f10Crash.actions.map(({ actionId }) => actionId)).toEqual([
      "prepare-singleton-scenario",
      "arm-singleton-session",
      "kill-singleton-process",
      "inspect-singleton-after-kill",
      "capture-singleton-campaign",
    ]);
  });

  it("splits lifecycle authority before controller campaign projection", () => {
    const expected = [
      [
        getProbeScenarioDefinition("F-06", "f06-process-crash-after-flush-share-allows-replace"),
        [
          "prepare-replacement-target",
          "arm-replacement-session",
          "terminate-replacement-process",
          "inspect-replacement-after-recovery",
          "capture-atomic-replacement-campaign",
        ],
      ],
      [
        getProbeScenarioDefinition("F-06", "f06-reboot-after-flush-share-allows-replace"),
        [
          "prepare-replacement-target",
          "arm-replacement-session",
          "reboot-replacement-guest",
          "inspect-replacement-after-recovery",
          "capture-atomic-replacement-campaign",
        ],
      ],
      [
        getProbeScenarioDefinition("F-07", "f07-process-kill-after-file-flush"),
        [
          "prepare-durability-target",
          "start-durability-operation",
          "kill-process-at-checkpoint",
          "inspect-durability-after-process-kill",
          "capture-durability-campaign",
        ],
      ],
      [
        getProbeScenarioDefinition("F-08", "f08-kill-before-accept"),
        [
          "prepare-named-pipe-scenario",
          "arm-pipe-owner-session",
          "kill-pipe-owner-at-checkpoint",
          "inspect-pipe-after-owner-kill",
          "capture-named-pipe-campaign",
        ],
      ],
      [
        getProbeScenarioDefinition("F-08", "f08-reboot-stability"),
        [
          "prepare-named-pipe-scenario",
          "reboot-pipe-owner-guest",
          "inspect-pipe-after-reboot",
          "capture-named-pipe-campaign",
        ],
      ],
      [
        getProbeScenarioDefinition("F-10", "f10-kill-after-port-bind"),
        [
          "prepare-singleton-scenario",
          "arm-singleton-session",
          "kill-singleton-process",
          "inspect-singleton-after-kill",
          "capture-singleton-campaign",
        ],
      ],
    ] as const;

    for (const [definition, actionIds] of expected) {
      expect(definition.actions.map(({ actionId }) => actionId)).toEqual(actionIds);
      const captureIndex = definition.actions.findIndex(({ capture }) => capture !== null);
      const recoveryIndex = definition.actions.findLastIndex(({ phase }) => phase === "recovery");
      expect(captureIndex).toBe(definition.actions.length - 1);
      expect(recoveryIndex).toBe(captureIndex - 1);
      expect(definition.actions[captureIndex].prerequisiteActionIds).toEqual([
        definition.actions[recoveryIndex].actionId,
      ]);
    }

    const hardCut = getProbeScenarioDefinition("F-07", "f07-hard-cut-after-file-flush");
    expect(hardCut.actions.slice(1, 5).map(({ actionId }) => actionId)).toEqual([
      "start-durability-operation-r1",
      "hard-cut-guest-r1",
      "start-guest-after-hard-cut-r1",
      "inspect-durability-after-hard-cut-r1",
    ]);
    expect(action(hardCut, "start-guest-after-hard-cut-r1").prerequisiteActionIds).toEqual([
      "hard-cut-guest-r1",
    ]);
    expect(action(hardCut, "inspect-durability-after-hard-cut-r1").prerequisiteActionIds).toEqual([
      "start-guest-after-hard-cut-r1",
    ]);
    expect(hardCut.actions.at(-1)?.actionId).toBe("capture-durability-campaign");
  });

  it("requires exactly five external continuations only for the four F-07 hard cuts", () => {
    const hardCuts = PROBE_SCENARIO_DEFINITIONS.filter(
      (definition) => definition.continuation.kind === "external-hard-cut",
    );
    expect(hardCuts.map(({ variantId }) => variantId)).toEqual([
      "f07-hard-cut-after-file-flush",
      "f07-hard-cut-after-namespace-replace",
      "f07-hard-cut-after-parent-volume-flush",
      "f07-hard-cut-after-temp-creation",
    ]);
    for (const definition of hardCuts) {
      expect(definition.continuation.repetitions).toBe(5);
      expect(definition.actions).toHaveLength(22);
      expect(
        definition.actions.filter(({ operation }) => operation === "hard-cut-guest"),
      ).toHaveLength(5);
      expect(definition.prerequisites.attestationCapabilityIds).toEqual(
        expect.arrayContaining(["externalAbruptPower", "externalSnapshotRestore"]),
      );
    }

    const processKill = getProbeScenarioDefinition(
      "F-07",
      "f07-process-kill-after-namespace-replace",
    );
    expect(processKill.continuation).toEqual({
      kind: "none",
      checkpoint: null,
      repetitions: 0,
    });
    expect(processKill.actions.map(({ actionId }) => actionId)).toContain(
      "kill-process-at-checkpoint",
    );
  });

  it("rejects unknown row or variant dispatch", () => {
    expect(() => getProbeScenarioDefinition("F-11", "f11-made-up")).toThrowError(
      expect.objectContaining({ code: "SCENARIO_UNKNOWN" }),
    );
  });
});

describe("Windows host probe scenario executor", () => {
  it("executes exact contiguous F-07 continuation slices as distinct partial captures", async () => {
    const seam: ProbeScenarioActionSeam = (invocation) => actionResult(invocation);
    const base = {
      rowId: "F-07",
      variantId: "f07-hard-cut-after-file-flush",
      invokeNative: seam,
      invokeController: seam,
    } as const;

    const setup = await executeProbeScenarioActionSlice({
      ...base,
      actionIds: ["prepare-durability-target"],
    });
    const checkpoint = await executeProbeScenarioActionSlice({
      ...base,
      actionIds: ["start-durability-operation-r3", "hard-cut-guest-r3"],
    });
    const powerRecovery = await executeProbeScenarioActionSlice({
      ...base,
      actionIds: ["start-guest-after-hard-cut-r3"],
    });
    const guestRecovery = await executeProbeScenarioActionSlice({
      ...base,
      actionIds: ["inspect-durability-after-hard-cut-r3"],
    });
    const finalCapture = await executeProbeScenarioActionSlice({
      ...base,
      actionIds: ["capture-durability-campaign"],
    });

    expect(setup.kind).toBe("windows-host-probe-scenario-partial-capture");
    expect(checkpoint.actionIds).toEqual(["start-durability-operation-r3", "hard-cut-guest-r3"]);
    expect(powerRecovery.actionIds).toEqual(["start-guest-after-hard-cut-r3"]);
    expect(guestRecovery.actionIds).toEqual(["inspect-durability-after-hard-cut-r3"]);
    expect(finalCapture.commandEvents.map(({ commandId }) => commandId)).toEqual([
      "durability-campaign",
    ]);
    expect(setup).not.toHaveProperty("transcriptProducerKind");
    expect(Object.isFrozen(checkpoint)).toBe(true);
  });

  it("rejects unknown, reordered, noncontiguous, or empty action slices", async () => {
    const seam: ProbeScenarioActionSeam = (invocation) => actionResult(invocation);
    const execute = (actionIds: readonly string[]) =>
      executeProbeScenarioActionSlice({
        rowId: "F-07",
        variantId: "f07-hard-cut-after-file-flush",
        actionIds,
        invokeNative: seam,
        invokeController: seam,
      });

    await expectCode(() => execute([]), "SCENARIO_ACTION_SLICE");
    await expectCode(() => execute(["not-an-action"]), "SCENARIO_ACTION_SLICE");
    await expectCode(
      () => execute(["hard-cut-guest-r2", "start-durability-operation-r2"]),
      "SCENARIO_ACTION_SLICE",
    );
    await expectCode(
      () => execute(["start-durability-operation-r2", "start-guest-after-hard-cut-r2"]),
      "SCENARIO_ACTION_SLICE",
    );
  });

  it("executes every closed plan through injected seams without adding facts", async () => {
    const seam: ProbeScenarioActionSeam = (invocation) => actionResult(invocation);
    for (const definition of PROBE_SCENARIO_DEFINITIONS) {
      const capture = await executeProbeScenario({
        rowId: definition.rowId,
        variantId: definition.variantId,
        invokeNative: seam,
        invokeController: seam,
      });
      const factDefinition = getProbeTranscriptFactDefinition(
        definition.rowId,
        definition.variantId,
      );
      expect(capture.commandEvents.map(({ commandId }) => commandId)).toEqual(
        factDefinition.commands.map(({ commandId }) => commandId),
      );
      expect(
        capture.commandEvents.flatMap(({ observations }) => observations.map(({ value }) => value)),
      ).toEqual(capture.commandEvents.flatMap(({ observations }) => observations.map(() => null)));
    }
  });

  it("dispatches deterministic native/controller actions and returns only seam-supplied source data", async () => {
    const calls: string[] = [];
    const values = { pathTopology: "seam-sentinel" };
    const invokeController: ProbeScenarioActionSeam = (invocation) => {
      calls.push(`controller:${invocation.action.actionId}`);
      expect(Object.isFrozen(invocation)).toBe(true);
      return actionResult(invocation, values);
    };
    const invokeNative: ProbeScenarioActionSeam = (invocation) => {
      calls.push(`native:${invocation.action.actionId}`);
      return actionResult(invocation, values);
    };

    const capture = await executeProbeScenario({
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      invokeNative,
      invokeController,
    });

    expect(calls).toEqual(["controller:prepare-home-topology", "native:capture-home-identity"]);
    expect(capture.commandEvents).toHaveLength(1);
    expect(
      capture.commandEvents[0].observations.find(({ factKey }) => factKey === "pathTopology"),
    ).toEqual({ factKey: "pathTopology", valueKind: "string", value: "seam-sentinel" });
    expect(capture.evidenceArtifacts.map(({ path }) => path)).toEqual([
      "actions/01-prepare-home-topology.json",
      "actions/02-capture-home-identity.json",
    ]);
    expect(capture).not.toHaveProperty("outcome");
    expect(capture).not.toHaveProperty("mechanism");
    expect(capture).not.toHaveProperty("verification");
    expect(Object.isFrozen(capture)).toBe(true);
  });

  it("canonicalizes command events by assigned transcript sequence, not action execution order", async () => {
    const seam: ProbeScenarioActionSeam = (invocation) => actionResult(invocation);
    const capture = await executeProbeScenario({
      rowId: "F-04",
      variantId: "f04-normal-nested-read",
      invokeNative: seam,
      invokeController: seam,
    });

    expect(capture.commandEvents.map(({ commandId }) => commandId)).toEqual([
      "evidence-tree-seal",
      "secure-path-operation",
    ]);
  });

  it("rejects authority fields or unplanned command events from an injected seam", async () => {
    const extraAuthority = ((invocation: ProbeScenarioActionInvocation) => ({
      ...actionResult(invocation),
      outcome: "PASS",
    })) as unknown as ProbeScenarioActionSeam;
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: extraAuthority,
          invokeController: extraAuthority,
        }),
      "SCENARIO_ACTION_RESULT",
    );

    const unplannedEvent: ProbeScenarioActionSeam = (invocation) => {
      const result = actionResult(invocation);
      if (invocation.action.capture !== null) return result;
      const captureAction = getProbeScenarioDefinition(
        invocation.rowId,
        invocation.variantId,
      ).actions.find((candidate) => candidate.capture !== null)!;
      return {
        ...result,
        commandEvent: actionResult({ ...invocation, action: captureAction }).commandEvent,
      };
    };
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: unplannedEvent,
          invokeController: unplannedEvent,
        }),
      "SCENARIO_ACTION_RESULT",
    );
  });

  it("rejects missing, mismatched, or semantically pre-filtered capture events", async () => {
    const missing: ProbeScenarioActionSeam = (invocation) => ({
      ...actionResult(invocation),
      commandEvent: null,
    });
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: missing,
          invokeController: (invocation) => actionResult(invocation),
        }),
      "SCENARIO_ACTION_RESULT",
    );

    const wrongProducer: ProbeScenarioActionSeam = (invocation) => {
      const result = actionResult(invocation);
      if (result.commandEvent === null) return result;
      return {
        ...result,
        commandEvent: { ...result.commandEvent, producerKind: "external-controller" },
      };
    };
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: wrongProducer,
          invokeController: (invocation) => actionResult(invocation),
        }),
      "SCENARIO_COMMAND_EVENT",
    );

    const missingFact: ProbeScenarioActionSeam = (invocation) => {
      const result = actionResult(invocation);
      if (result.commandEvent === null) return result;
      return {
        ...result,
        commandEvent: {
          ...result.commandEvent,
          observations: result.commandEvent.observations.slice(1),
        },
      };
    };
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: missingFact,
          invokeController: (invocation) => actionResult(invocation),
        }),
      "SCENARIO_OBSERVATION",
    );
  });

  it("requires every planned actor seam and collision-free evidence", async () => {
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: (invocation) => actionResult(invocation),
        }),
      "SCENARIO_SEAM_MISSING",
    );

    const colliding: ProbeScenarioActionSeam = (invocation) => ({
      ...actionResult(invocation),
      evidenceArtifacts: [
        { path: "same/Artifact.json", sha256: sha256(invocation.action.actionId) },
      ],
    });
    await expectCode(
      () =>
        executeProbeScenario({
          rowId: "F-01",
          variantId: "f01-ordinary-absolute-path",
          invokeNative: colliding,
          invokeController: (invocation) => ({
            ...colliding(invocation),
            evidenceArtifacts: [
              { path: "same/artifact.json", sha256: sha256(invocation.action.actionId) },
            ],
          }),
        }),
      "SCENARIO_EVIDENCE",
    );
  });
});
