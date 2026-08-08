import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  derivePreparedProbeContextDigest,
  deriveProbeExecutionBundleManifestDigest,
  deriveProbePreparationClaimReceiptDigest,
  deriveProbePreparationScopeDigest,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import type { PreparedProbeContext } from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import {
  createProbeRuntimeActionBinding,
  deriveProbeRuntimeActionPaths,
  deriveProbeRuntimeScenarioOperationId,
} from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import type { ProbeTranscriptFactValue } from "../scripts/windows-host-falsifier/probe-transcript.mjs";
import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function preparedContextFixture(identitySuffix = ""): PreparedProbeContext {
  const candidateSha256 = sha256("candidate");
  const labAttestationSha256 = sha256("attestation");
  const lifecyclePolicySha256 = sha256("lifecycle");
  const publicKeySha256 = sha256("controller-key");
  const runPlanSha256 = sha256("run-plan");
  const runAuthorizationSha256 = sha256("run-authorization");
  const runAuthorizationClaimReceiptSha256 = sha256("run-authorization-claim");
  const trustedEvaluationAt = "2026-08-07T00:00:00.000Z";
  const actorDigest = (role: string) => sha256(`${role}${identitySuffix}`);
  const actors = {
    primaryStandardUserSidSha256: actorDigest("primary-standard-user"),
    powerControlActorSha256: actorDigest("power-control-actor"),
    snapshotControlActorSha256: actorDigest("snapshot-control-actor"),
    remotePeerActorSha256: actorDigest("remote-peer-actor"),
    secondUserSidSha256: actorDigest("second-standard-user"),
  };
  const vm = {
    vmSnapshotId: "floor-snapshot",
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
  };
  const nativeHelper = {
    path: "bin/helper.exe",
    sha256: sha256("helper"),
    nativeCandidateDigest: sha256("native-candidate"),
    nativeManifestSha256: sha256("native-manifest"),
  };
  const brokerEnrollments = createPreparedContextFixture({
    environmentId: "win11-floor",
    actors,
    nativeHelper,
    bootIdSha256: vm.bootIdSha256,
    runnerSessionIdSha256: vm.runnerSessionIdSha256,
  }).executionBundleManifest.brokerEnrollments;
  const bundleDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-execution-bundle" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    labAttestationSha256,
    campaignRunId: "campaign-one",
    executionRunId: "execution-floor",
    executionBundleId: "bundle-floor",
    environmentId: "win11-floor" as const,
    authorization: {
      runPlanSha256,
      runAuthorizationSha256,
      claimReceiptSha256: runAuthorizationClaimReceiptSha256,
      operatorKeyId: "operator-one",
      operatorPublicKeySha256: sha256("operator-key"),
      trustStoreId: "trust-store-one",
      trustStoreGeneration: 1,
      trustStoreSha256: sha256("trust-store"),
      verifiedAt: trustedEvaluationAt,
      authorizationExpiresAt: "2026-08-08T00:00:00.000Z",
    },
    repository: {
      repositoryCommit: "c".repeat(40),
      sourceSetSha256: sha256("source-set"),
    },
    lifecyclePolicySha256,
    trustedEvaluationAt,
    vm,
    runtime: {
      nodeVersion: "24.11.1",
      powerShellVersion: "5.1.26100.1",
      powerShellEdition: "Desktop" as const,
      powerShellExecutableSha256: sha256("powershell"),
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: sha256("nsis"),
    },
    controller: {
      identitySha256: actorDigest("controller"),
      publicKeySha256,
      publicKeyArtifact: { path: "attestations/controller.der", sha256: publicKeySha256 },
      version: "1.0.0",
    },
    actors,
    brokerEnrollments,
    evidenceArtifacts: [
      { path: "attestations/controller.der", sha256: publicKeySha256 },
      { path: "attestations/controller.json", sha256: sha256("controller-evidence") },
      { path: "attestations/guest.json", sha256: sha256("guest-evidence") },
    ],
    binaries: {
      nativeHelper: {
        ...nativeHelper,
        machine: "x64" as const,
      },
      nsis: { path: "bin/nsis.exe", sha256: sha256("nsis") },
    },
  };
  const executionBundleManifest = {
    ...bundleDraft,
    executionBundleManifestSha256: deriveProbeExecutionBundleManifestDigest(bundleDraft),
  };
  const contextDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-prepared-context" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    labAttestationSha256,
    runPlanSha256,
    runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256,
    campaignRunId: bundleDraft.campaignRunId,
    executionRunId: bundleDraft.executionRunId,
    executionBundleId: bundleDraft.executionBundleId,
    executionBundleManifestSha256: executionBundleManifest.executionBundleManifestSha256,
    attemptId: "attempt-one",
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    vmSnapshotId: bundleDraft.vm.vmSnapshotId,
    bootIdSha256: bundleDraft.vm.bootIdSha256,
    runnerSessionIdSha256: bundleDraft.vm.runnerSessionIdSha256,
    lifecyclePolicySha256,
    trustedEvaluationAt,
    controllerPublicKeyArtifact: bundleDraft.controller.publicKeyArtifact,
    pathProfileObservation: {
      profileId: "ascii" as const,
      rootPathSha256: sha256("root-path"),
      evidenceRootObjectIdentitySha256: sha256("root-object"),
      volumeIdSha256: sha256("volume"),
      localAbsolute: true,
      networkPath: false,
      removableVolume: false,
      reparsePoint: false,
      nfcNormalized: true,
      containsSpaces: false,
      containsUnicode: false,
    },
    executionBundleManifest,
  };
  const preparationScopeSha256 = deriveProbePreparationScopeDigest(contextDraft);
  const preparedDraft = {
    ...contextDraft,
    preparationScopeSha256,
    preparationClaimReceiptSha256: deriveProbePreparationClaimReceiptDigest(preparationScopeSha256),
  };
  return {
    ...preparedDraft,
    preflightSha256: derivePreparedProbeContextDigest(preparedDraft),
  };
}

function fixture(repetition?: number) {
  return scenarioFixture("F-01", "f01-ordinary-absolute-path", "prepare-home-topology", repetition);
}

function scenarioFixture(rowId: string, variantId: string, actionId: string, repetition?: number) {
  const definition = getProbeScenarioDefinition(rowId, variantId);
  const action = definition.actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) throw new Error(`${rowId}/${variantId}/${actionId} is missing`);
  const command = {
    campaignRunId: "campaign-one",
    attemptId: "attempt-one",
    workId: "work-0010",
    rowId: definition.rowId,
    variantId: definition.variantId,
    ...(repetition === undefined ? {} : { repetition }),
  };
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action,
  };
  return { command, invocation, preparedContext: preparedContextFixture() };
}

describe("runtime scenario action binding", () => {
  it("constructs one frozen canonical identity for operation, actor, paths, intent, and execution", () => {
    const input = fixture();
    const binding = createProbeRuntimeActionBinding(input);

    expect(binding.operationId).toBe(
      deriveProbeRuntimeScenarioOperationId(input.command, input.invocation.action.actionId),
    );
    expect(binding.operationIntentSha256).toBe(hashProbeCanonicalJson(binding.intent));
    expect(binding).toMatchObject({
      ...deriveProbeRuntimeActionPaths(input.command, input.invocation.action.actionId),
      expectedActor: {
        role: "primary-standard-user",
        identitySource: "actors.primaryStandardUserSidSha256",
        identitySha256:
          input.preparedContext.executionBundleManifest.actors.primaryStandardUserSidSha256,
      },
      intent: {
        schemaVersion: 2,
        repetition: null,
        operationId: binding.operationId,
        actionId: input.invocation.action.actionId,
        execution: binding.execution,
        expectedActor: binding.expectedActor,
      },
    });
    expect(binding.operationIntentPath).toBe(
      "runtime/work/campaign-one/attempt-one/work-0010/action-intents/prepare-home-topology.json",
    );
    expect(binding.operationResultPath).toBe(
      "runtime/work/campaign-one/attempt-one/work-0010/action-results/prepare-home-topology.json",
    );
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.intent)).toBe(true);
    expect(Object.isFrozen(binding.expectedActor)).toBe(true);
    expect(Object.isFrozen(binding.intent.action.parameters)).toBe(true);
    expect(binding.intent.action).not.toBe(input.invocation.action);
  });

  it("selects the controller identity for a controller lifecycle action", () => {
    const input = scenarioFixture("F-01", "f01-restart-stability", "restart-probe-process");
    expect(createProbeRuntimeActionBinding(input).expectedActor).toEqual({
      role: "controller",
      identitySource: "controller.identitySha256",
      identitySha256: input.preparedContext.executionBundleManifest.controller.identitySha256,
    });
  });

  it("selects F-02 current-user and second-user identities from the trusted invocation", () => {
    const currentUser = scenarioFixture("F-02", "f02-owner-read", "exercise-directory-access");
    const secondUser = scenarioFixture(
      "F-02",
      "f02-second-user-read-refusal",
      "exercise-directory-access",
    );

    expect(createProbeRuntimeActionBinding(currentUser).expectedActor).toEqual({
      role: "primary-standard-user",
      identitySource: "actors.primaryStandardUserSidSha256",
      identitySha256:
        currentUser.preparedContext.executionBundleManifest.actors.primaryStandardUserSidSha256,
    });
    expect(createProbeRuntimeActionBinding(secondUser).expectedActor).toEqual({
      role: "second-user",
      identitySource: "actors.secondUserSidSha256",
      identitySha256: secondUser.preparedContext.executionBundleManifest.actors.secondUserSidSha256,
    });
  });

  it("rejects missing, differently typed, and unknown F-02 actor selector input", () => {
    const input = scenarioFixture("F-02", "f02-owner-read", "exercise-directory-access");
    for (const actor of [undefined, 7, "administrator"]) {
      const parameters = {
        ...input.invocation.action.parameters,
      } as Record<string, ProbeTranscriptFactValue>;
      if (actor === undefined) delete parameters.actor;
      else parameters.actor = actor;
      expect(() =>
        createProbeRuntimeActionBinding({
          ...input,
          invocation: {
            ...input.invocation,
            action: { ...input.invocation.action, parameters },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MAP_ACTOR_SELECTOR_INPUT" }));
    }
  });

  it("binds continuation repetition without changing actor projection or intent paths", () => {
    const ordinary = createProbeRuntimeActionBinding(fixture());
    const first = createProbeRuntimeActionBinding(fixture(1));
    const second = createProbeRuntimeActionBinding(fixture(2));

    expect(first.intent.repetition).toBe(1);
    expect(second.intent.repetition).toBe(2);
    expect(first.expectedActor).toEqual(ordinary.expectedActor);
    expect(new Set([ordinary.operationId, first.operationId, second.operationId]).size).toBe(3);
    expect(first.operationIntentPath).toBe(second.operationIntentPath);
  });

  it("rejects coordinate drift and non-positive continuation repetitions", () => {
    const value = fixture();
    expect(() =>
      createProbeRuntimeActionBinding({
        ...value,
        command: { ...value.command, rowId: "F-02" },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));
    expect(() =>
      createProbeRuntimeActionBinding({
        ...value,
        command: { ...value.command, campaignRunId: "another-campaign" },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_PREPARED" }));
    for (const repetition of [0, -1, 1.5, null]) {
      expect(() =>
        createProbeRuntimeActionBinding({
          ...value,
          command: { ...value.command, repetition } as never,
        }),
      ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_OPERATION" }));
    }
  });

  it("rejects a substituted prepared identity that is not retained by the prepared digest", () => {
    const value = fixture();
    const preparedContext = {
      ...value.preparedContext,
      executionBundleManifest: {
        ...value.preparedContext.executionBundleManifest,
        actors: {
          ...value.preparedContext.executionBundleManifest.actors,
          primaryStandardUserSidSha256: sha256("substituted-primary-user"),
        },
      },
    };
    expect(() => createProbeRuntimeActionBinding({ ...value, preparedContext })).toThrowError(
      expect.objectContaining({ code: "PREFLIGHT_BUNDLE_DIGEST" }),
    );
  });

  it("rejects accessor, hidden, symbolic, and nested non-data inputs without evaluating getters", () => {
    const value = fixture();
    let getterReads = 0;
    const accessorCommand = { ...value.command };
    Object.defineProperty(accessorCommand, "workId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return value.command.workId;
      },
    });
    expect(() =>
      createProbeRuntimeActionBinding({ ...value, command: accessorCommand }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));

    const hiddenInvocation = { ...value.invocation };
    Object.defineProperty(hiddenInvocation, "planSha256", {
      enumerable: false,
      value: value.invocation.planSha256,
    });
    expect(() =>
      createProbeRuntimeActionBinding({ ...value, invocation: hiddenInvocation }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));

    const symbolicInvocation = { ...value.invocation } as Record<PropertyKey, unknown>;
    symbolicInvocation[Symbol("unexpected")] = true;
    expect(() =>
      createProbeRuntimeActionBinding({ ...value, invocation: symbolicInvocation as never }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));

    const f02 = scenarioFixture("F-02", "f02-owner-read", "exercise-directory-access");
    const parameters = { ...f02.invocation.action.parameters };
    Object.defineProperty(parameters, "actor", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "current-user";
      },
    });
    expect(() =>
      createProbeRuntimeActionBinding({
        ...f02,
        invocation: {
          ...f02.invocation,
          action: { ...f02.invocation.action, parameters },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));

    const accessorPrepared = { ...value.preparedContext };
    Object.defineProperty(accessorPrepared, "executionBundleManifest", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return value.preparedContext.executionBundleManifest;
      },
    });
    expect(() =>
      createProbeRuntimeActionBinding({ ...value, preparedContext: accessorPrepared }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_SCHEMA" }));
    expect(getterReads).toBe(0);
  });
});
