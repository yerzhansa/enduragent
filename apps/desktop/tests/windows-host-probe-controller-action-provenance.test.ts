import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProbeControllerActionProvenanceError,
  collectProbeControllerActionSignedArtifacts,
  createProbeControllerActionAttestation,
  createProbeControllerActionExecutionReceipt,
  createProbeControllerActionProvenance,
  createProbeControllerBrokerAcceptance,
  deriveProbeControllerActionAttestationDigest,
  deriveProbeControllerActionExecutionReceiptDigest,
  deriveProbeControllerActionProvenanceDigest,
  deriveProbeControllerBrokerAcceptanceDigest,
  probeControllerActionAttestationPath,
  probeControllerActionProvenancePaths,
  probeControllerBrokerAcceptancePath,
  validateProbeControllerActionExecutionReceipt,
  validateProbeControllerActionProvenance,
  validateProbeControllerActionAttestation,
  validateProbeControllerBrokerAcceptance,
  type ProbeControllerActionActorIdentitySource,
  type ProbeControllerActionActorRole,
  type ProbeControllerActionExecutionReceiptCreateInput,
  type ProbeControllerActionProvenanceTrustedInput,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { canonicalProbeJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";

const digest = (character: string) => character.repeat(64);
const rawDigest = (value: unknown) =>
  createHash("sha256").update(canonicalProbeJson(value), "utf8").digest("hex");

const identitySources: Record<
  ProbeControllerActionActorRole,
  ProbeControllerActionActorIdentitySource
> = {
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  controller: "controller.identitySha256",
  "power-control": "actors.powerControlActorSha256",
  "remote-peer": "actors.remotePeerActorSha256",
  "second-user": "actors.secondUserSidSha256",
};

function receiptInput(
  role: ProbeControllerActionActorRole = "primary-standard-user",
  overrides: Partial<ProbeControllerActionExecutionReceiptCreateInput> = {},
): ProbeControllerActionExecutionReceiptCreateInput {
  const producerActionId = role === "controller" ? "capture-durability-campaign" : "prepare-target";
  const brokered =
    role === "primary-standard-user" || role === "remote-peer" || role === "second-user";
  const coordinate = {
    campaignRunId: "campaign-run",
    executionRunId: "execution-run",
    attemptId: "attempt-one",
    workId: "work-0001",
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    rowId: "F-01" as const,
    variantId: "f01-ordinary-absolute-path",
    repetition: null,
  };
  const evidencePrefix = `segments/${coordinate.environmentId}/${coordinate.pathProfileId}/${coordinate.rowId.toLowerCase()}/${coordinate.variantId}/evidence`;
  const proof = { path: `${evidencePrefix}/proofs/execution.json`, sha256: digest("1") };
  const actionResult = {
    actionId: producerActionId,
    commandEvent: null,
    evidenceArtifacts: [proof],
  };
  const actorLocus = {
    "primary-standard-user": "guest-standard-user-worker",
    controller: "controller-host",
    "power-control": "controller-host",
    "remote-peer": "controller-remote-peer",
    "second-user": "guest-second-user-broker",
  } as const;
  return {
    candidateSha256: digest("a"),
    executionBundleId: "execution-bundle",
    executionBundleManifestSha256: digest("b"),
    runAuthorizationClaimReceiptSha256: digest("c"),
    coordinate,
    scenarioPlanSha256: digest("d"),
    producerActionId,
    operation: { operationId: "operation-one", kind: "scenario-action", sequence: 1 },
    intentSha256: digest("e"),
    execution: {
      actor: "external-controller",
      operation: role === "controller" ? "durability-campaign" : "prepare-target",
      locus: actorLocus[role],
      driverId: "f01-driver",
      disruptive: false,
      nativeTranscriptRequired: true,
      actorSelector: { kind: "fixed", role },
    },
    expectedActor: {
      role,
      identitySource: identitySources[role],
      identitySha256: digest("f"),
    },
    actionResult,
    actionResultArtifact: {
      path: `runtime/work/${coordinate.campaignRunId}/${coordinate.attemptId}/${coordinate.workId}/action-results/${producerActionId}.json`,
      sha256: rawDigest(actionResult),
    },
    proofArtifacts: [proof],
    observerTranscripts: [
      {
        path: `${evidencePrefix}/native-transcripts/${digest("2")}.json`,
        sha256: digest("9"),
        transcriptSha256: digest("2"),
      },
    ],
    brokerProof: brokered ? proof : null,
    pausedSessionReceipt: null,
    nativeActionPlans:
      role === "primary-standard-user"
        ? [
            {
              path: `runtime/work/${coordinate.campaignRunId}/${coordinate.attemptId}/${coordinate.workId}/driver-plans/capture-target.json`,
              sha256: digest("3"),
            },
          ]
        : [],
    ...overrides,
  };
}

function actionAttestationFixture(role: "primary-standard-user" | "remote-peer" | "second-user") {
  const receipt = receiptInput(role);
  const acceptance = createProbeControllerBrokerAcceptance({
    coordinate: receipt.coordinate,
    producerActionId: receipt.producerActionId,
    brokerTaskSha256: digest("4"),
    brokerTaskNonceSha256: digest("5"),
    brokerResultSha256: digest("6"),
    brokerEnrollmentSha256: digest("7"),
    brokerInstanceId: `${role}-broker-one`,
    brokerRole: role,
    expectedActor: receipt.expectedActor,
    mailboxAclSha256: digest("8"),
    processSidSha256: role === "remote-peer" ? digest("0") : receipt.expectedActor.identitySha256,
    bootIdSha256: digest("9"),
    runnerSessionIdSha256: digest("a"),
    replayJournalDisposition: "accepted",
    replayJournalEntrySha256: digest("b"),
  });
  const attestation = createProbeControllerActionAttestation({
    candidateSha256: receipt.candidateSha256,
    executionBundleId: receipt.executionBundleId,
    executionBundleManifestSha256: receipt.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: receipt.runAuthorizationClaimReceiptSha256,
    coordinate: receipt.coordinate,
    scenarioPlanSha256: receipt.scenarioPlanSha256,
    producerActionId: receipt.producerActionId,
    operation: receipt.operation,
    runtimeActionIntentSha256: receipt.intentSha256,
    execution: receipt.execution,
    expectedActor: receipt.expectedActor,
    broker: {
      brokerAcceptanceSha256: acceptance.acceptanceSha256,
      brokerTaskSha256: acceptance.brokerTaskSha256,
      brokerTaskNonceSha256: acceptance.brokerTaskNonceSha256,
      brokerResultSha256: acceptance.brokerResultSha256,
      brokerEnrollmentSha256: acceptance.brokerEnrollmentSha256,
      brokerInstanceId: acceptance.brokerInstanceId,
      brokerRole: acceptance.brokerRole,
      mailboxAclSha256: acceptance.mailboxAclSha256,
      processSidSha256: acceptance.processSidSha256,
      bootIdSha256: acceptance.bootIdSha256,
      runnerSessionIdSha256: acceptance.runnerSessionIdSha256,
      replayJournalDisposition: acceptance.replayJournalDisposition,
      replayJournalEntrySha256: acceptance.replayJournalEntrySha256,
    },
    observerCommands: [
      {
        transcriptSha256: digest("c"),
        sequence: 1,
        commandId: "broker-observer-command",
        requestFrameSha256: digest("d"),
        responseFrameSha256: digest("e"),
        ok: true,
      },
    ],
  });
  return { acceptance, attestation };
}

function trustedInput(
  receipt = createProbeControllerActionExecutionReceipt(receiptInput("controller")),
): ProbeControllerActionProvenanceTrustedInput {
  return {
    receipt,
    records: {
      controllerRequest: { bytes: 101, sha256: digest("4") },
      operationRequest: { bytes: 102, sha256: digest("5") },
      controllerResponse: { bytes: 103, sha256: digest("6") },
      operationResponse: { bytes: 104, sha256: digest("7") },
    },
  };
}

function expectCode(work: () => unknown, code: string) {
  expect(work).toThrowError(ProbeControllerActionProvenanceError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("controller action execution receipt", () => {
  it("builds immutable receipts for primary, controller, remote-peer, and second-user actors", () => {
    for (const role of [
      "primary-standard-user",
      "controller",
      "remote-peer",
      "second-user",
    ] as const) {
      const receipt = createProbeControllerActionExecutionReceipt(receiptInput(role));
      if (role === "controller") {
        expect(validateProbeControllerActionExecutionReceipt(receipt)).toEqual(receipt);
      } else {
        expectCode(
          () => validateProbeControllerActionExecutionReceipt(receipt),
          "CONTROLLER_ACTION_ATTESTATION_REQUIRED",
        );
      }
      expect(receipt.receiptSha256).toBe(
        deriveProbeControllerActionExecutionReceiptDigest(receipt),
      );
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.expectedActor)).toBe(true);
      expect(Object.isFrozen(receipt.actionResult.evidenceArtifacts)).toBe(true);

      if (role === "controller") {
        const provenance = createProbeControllerActionProvenance(trustedInput(receipt));
        expect(validateProbeControllerActionProvenance(provenance, trustedInput(receipt))).toEqual(
          provenance,
        );
      }
    }
  });

  it("builds closed broker acceptance and action attestations for every broker role", () => {
    for (const role of ["primary-standard-user", "remote-peer", "second-user"] as const) {
      const { acceptance, attestation } = actionAttestationFixture(role);
      expect(validateProbeControllerBrokerAcceptance(acceptance)).toEqual(acceptance);
      expect(acceptance.acceptanceSha256).toBe(
        deriveProbeControllerBrokerAcceptanceDigest(acceptance),
      );
      expect(validateProbeControllerActionAttestation(attestation)).toEqual(attestation);
      expect(attestation.attestationSha256).toBe(
        deriveProbeControllerActionAttestationDigest(attestation),
      );
      expect(attestation.expectedActor.role).toBe(role);
      expect(
        probeControllerActionAttestationPath({
          coordinate: attestation.coordinate,
          producerActionId: attestation.producerActionId,
        }),
      ).toContain(
        `/action-attestations/${attestation.coordinate.campaignRunId}/${attestation.coordinate.executionRunId}/${attestation.coordinate.attemptId}/${attestation.coordinate.workId}/`,
      );
      expect(
        probeControllerBrokerAcceptancePath({
          coordinate: acceptance.coordinate,
          producerActionId: acceptance.producerActionId,
        }),
      ).toContain(
        `/broker-acceptances/${acceptance.coordinate.campaignRunId}/${acceptance.coordinate.executionRunId}/${acceptance.coordinate.attemptId}/${acceptance.coordinate.workId}/`,
      );
      expect(attestation.broker).toMatchObject({
        brokerRole: role,
        processSidSha256:
          role === "remote-peer" ? digest("0") : attestation.expectedActor.identitySha256,
        brokerAcceptanceSha256: acceptance.acceptanceSha256,
      });
      expect(Object.isFrozen(acceptance)).toBe(true);
      expect(Object.isFrozen(attestation.observerCommands)).toBe(true);
    }
  });

  it("keeps action authority paths injective across attempts and repetitions", () => {
    const { attestation } = actionAttestationFixture("second-user");
    const coordinates = [
      { ...attestation.coordinate, repetition: null },
      { ...attestation.coordinate, repetition: 1 },
      { ...attestation.coordinate, repetition: 2 },
      { ...attestation.coordinate, attemptId: "attempt-two", repetition: 1 },
      { ...attestation.coordinate, executionRunId: "execution-two", repetition: 1 },
      { ...attestation.coordinate, campaignRunId: "campaign-two", repetition: 1 },
    ];
    const actionPaths = coordinates.map((coordinate) =>
      probeControllerActionAttestationPath({
        coordinate,
        producerActionId: attestation.producerActionId,
      }),
    );
    const acceptancePaths = coordinates.map((coordinate) =>
      probeControllerBrokerAcceptancePath({
        coordinate,
        producerActionId: attestation.producerActionId,
      }),
    );
    expect(new Set(actionPaths).size).toBe(coordinates.length);
    expect(new Set(acceptancePaths).size).toBe(coordinates.length);
  });

  it("builds a broker-free attestation for a direct controller action", () => {
    const receipt = receiptInput("controller");
    const attestation = createProbeControllerActionAttestation({
      candidateSha256: receipt.candidateSha256,
      executionBundleId: receipt.executionBundleId,
      executionBundleManifestSha256: receipt.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256: receipt.runAuthorizationClaimReceiptSha256,
      coordinate: receipt.coordinate,
      scenarioPlanSha256: receipt.scenarioPlanSha256,
      producerActionId: receipt.producerActionId,
      operation: receipt.operation,
      runtimeActionIntentSha256: receipt.intentSha256,
      execution: receipt.execution,
      expectedActor: receipt.expectedActor,
      broker: null,
      observerCommands: [
        {
          transcriptSha256: digest("c"),
          sequence: 1,
          commandId: "durability-campaign",
          requestFrameSha256: digest("d"),
          responseFrameSha256: digest("e"),
          ok: true,
        },
      ],
    });
    expect(validateProbeControllerActionAttestation(attestation)).toEqual(attestation);
    expect(attestation.broker).toBeNull();
    expect(attestation.attestationSha256).not.toBe(rawDigest(attestation));

    const { attestation: brokeredAttestation } = actionAttestationFixture("primary-standard-user");
    expectCode(
      () =>
        validateProbeControllerActionAttestation({
          ...attestation,
          broker: brokeredAttestation.broker,
        }),
      "CONTROLLER_ACTION_ATTESTATION_BROKER",
    );
  });

  it("binds a remote actor identity separately from its authenticated process SID", () => {
    const { acceptance, attestation } = actionAttestationFixture("remote-peer");
    expect(acceptance.expectedActor.identitySha256).not.toBe(acceptance.processSidSha256);
    expect(validateProbeControllerBrokerAcceptance(acceptance)).toEqual(acceptance);
    expect(validateProbeControllerActionAttestation(attestation)).toEqual(attestation);

    expectCode(
      () =>
        validateProbeControllerBrokerAcceptance({
          ...acceptance,
          processSidSha256: digest("1"),
        }),
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_DIGEST",
    );
    expectCode(
      () =>
        validateProbeControllerActionAttestation({
          ...attestation,
          expectedActor: { ...attestation.expectedActor, identitySha256: digest("1") },
        }),
      "CONTROLLER_ACTION_ATTESTATION_DIGEST",
    );
  });

  it("rejects broker acceptance and attestation identity or replay substitution", () => {
    const { acceptance, attestation } = actionAttestationFixture("second-user");
    expectCode(
      () =>
        validateProbeControllerBrokerAcceptance({
          ...acceptance,
          processSidSha256: digest("0"),
        }),
      "CONTROLLER_ACTION_BROKER_ACCEPTANCE_ACTOR",
    );
    expectCode(
      () =>
        validateProbeControllerActionAttestation({
          ...attestation,
          broker: { ...attestation.broker, replayJournalDisposition: "replayed" },
        }),
      "CONTROLLER_ACTION_ATTESTATION_BROKER",
    );
    expectCode(
      () =>
        validateProbeControllerActionAttestation({
          ...attestation,
          coordinate: { ...attestation.coordinate, repetition: 2 },
        }),
      "CONTROLLER_ACTION_ATTESTATION_DIGEST",
    );
  });

  it("returns the exact sorted signed artifact union", () => {
    const receipt = createProbeControllerActionExecutionReceipt(receiptInput());
    expect(collectProbeControllerActionSignedArtifacts(receipt)).toEqual([
      receipt.actionResultArtifact,
      receipt.nativeActionPlans[0],
      {
        path: receipt.observerTranscripts[0]!.path,
        sha256: receipt.observerTranscripts[0]!.sha256,
      },
      receipt.proofArtifacts[0],
    ]);
    expect(collectProbeControllerActionSignedArtifacts(receipt)[2]).not.toHaveProperty(
      "transcriptSha256",
    );
  });

  it("binds exact repetition, bundle, run claim, scenario, operation, intent, execution, and actor", () => {
    const input = receiptInput("power-control", {
      coordinate: { ...receiptInput().coordinate, repetition: 3 },
      execution: {
        ...receiptInput().execution,
        operation: "reboot-replacement-guest",
        locus: "controller-host",
        disruptive: true,
        actorSelector: { kind: "fixed", role: "power-control" },
      },
      expectedActor: {
        role: "power-control",
        identitySource: "actors.powerControlActorSha256",
        identitySha256: digest("f"),
      },
    });
    const actionResultArtifact = {
      ...input.actionResultArtifact,
      path: `runtime/work/${input.coordinate.campaignRunId}/${input.coordinate.attemptId}/${input.coordinate.workId}/action-results/${input.producerActionId}.json`,
    };
    const receipt = createProbeControllerActionExecutionReceipt({ ...input, actionResultArtifact });
    expect(receipt.coordinate.repetition).toBe(3);
    expect(receipt.executionBundleManifestSha256).toBe(digest("b"));
    expect(receipt.runAuthorizationClaimReceiptSha256).toBe(digest("c"));
    expect(receipt.operation).toEqual({
      operationId: "operation-one",
      kind: "scenario-action",
      sequence: 1,
    });
  });

  it("requires proofs to equal action-result evidence exactly", () => {
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          proofArtifacts: [
            { path: "segments/evidence/proofs/substituted.json", sha256: digest("8") },
          ],
        }),
      "CONTROLLER_ACTION_PROOF",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult: { ...receiptInput().actionResult, untrusted: true } as never,
        }),
      "CONTROLLER_ACTION_SCHEMA",
    );
    expectCode(() => {
      const actionResult = { ...receiptInput().actionResult, commandEvent: {} } as never;
      return createProbeControllerActionExecutionReceipt({
        ...receiptInput(),
        actionResult,
        actionResultArtifact: {
          ...receiptInput().actionResultArtifact,
          sha256: rawDigest(actionResult),
        },
      });
    }, "CONTROLLER_ACTION_SCHEMA");
  });

  it("requires broker proof plus a primary observer for every independent broker actor", () => {
    for (const role of ["primary-standard-user", "remote-peer", "second-user"] as const) {
      expectCode(
        () =>
          createProbeControllerActionExecutionReceipt({
            ...receiptInput(role),
            brokerProof: null,
          }),
        "CONTROLLER_ACTION_BROKER",
      );
      expectCode(
        () =>
          createProbeControllerActionExecutionReceipt({
            ...receiptInput(role),
            observerTranscripts: [],
          }),
        "CONTROLLER_ACTION_BROKER",
      );
    }
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput("controller"),
          brokerProof: receiptInput().proofArtifacts[0]!,
        }),
      "CONTROLLER_ACTION_BROKER",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput("controller"),
          observerTranscripts: [],
        }),
      "CONTROLLER_ACTION_OBSERVER",
    );
  });

  it("binds command-event transcript identities to observer identities, not file digests", () => {
    const commandEvent = {
      sequence: 1,
      producerKind: "external-controller" as const,
      commandId: "home-identity",
      requestSha256: digest("4"),
      responseSha256: digest("5"),
      nativeTranscriptSha256s: [digest("2")],
      observations: [{ factKey: "homePath", valueKind: "string" as const, value: "C:/Users/a" }],
    };
    const actionResult = { ...receiptInput().actionResult, commandEvent };
    const receipt = createProbeControllerActionExecutionReceipt({
      ...receiptInput(),
      actionResult,
      actionResultArtifact: {
        ...receiptInput().actionResultArtifact,
        sha256: rawDigest(actionResult),
      },
    });
    expect(receipt.observerTranscripts[0]).toMatchObject({
      sha256: digest("9"),
      transcriptSha256: digest("2"),
    });

    const mismatchedResult = {
      ...actionResult,
      commandEvent: { ...commandEvent, nativeTranscriptSha256s: [digest("8")] },
    };
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult: mismatchedResult,
          actionResultArtifact: {
            ...receiptInput().actionResultArtifact,
            sha256: rawDigest(mismatchedResult),
          },
        }),
      "CONTROLLER_ACTION_OBSERVER",
    );
  });

  it("rejects selector, identity-source, broker, and paused-receipt swaps", () => {
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          execution: {
            ...receiptInput().execution,
            actorSelector: { kind: "fixed", role: "controller" },
          },
        }),
      "CONTROLLER_ACTION_ACTOR",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          expectedActor: {
            ...receiptInput().expectedActor,
            identitySource: "controller.identitySha256",
          },
        }),
      "CONTROLLER_ACTION_ACTOR",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput("remote-peer"),
          brokerProof: {
            path: `segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/proofs/another.json`,
            sha256: digest("8"),
          },
        }),
      "CONTROLLER_ACTION_PROOF",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          pausedSessionReceipt: {
            path: `segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/proofs/paused.json`,
            sha256: digest("8"),
          },
        }),
      "CONTROLLER_ACTION_PROOF",
    );
  });

  it("rejects unsafe, escaping, and wrong-namespace artifact paths", () => {
    for (const path of [
      "/absolute/proof.json",
      "C:\\proof.json",
      "segments/../proof.json",
      "segments/./proof.json",
      "segments/unicode-ж/proof.json",
      "segments/del-\u007f/proof.json",
      "segments/.enduragent-publication-reserved/proof.json",
    ]) {
      const proof = { path, sha256: digest("1") };
      const actionResult = {
        ...receiptInput().actionResult,
        evidenceArtifacts: [proof],
      };
      expectCode(
        () =>
          createProbeControllerActionExecutionReceipt({
            ...receiptInput(),
            actionResult,
            actionResultArtifact: {
              ...receiptInput().actionResultArtifact,
              sha256: rawDigest(actionResult),
            },
            proofArtifacts: [proof],
          }),
        "CONTROLLER_ACTION_PATH",
      );
    }
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          nativeActionPlans: [{ path: "elsewhere/plan.json", sha256: digest("3") }],
        }),
      "CONTROLLER_ACTION_PLAN",
    );
    const crossCoordinateProof = {
      ...receiptInput().proofArtifacts[0]!,
      path: "segments/win11-current/ascii/f-01/f01-ordinary-absolute-path/evidence/proofs/execution.json",
    };
    const crossCoordinateResult = {
      ...receiptInput().actionResult,
      evidenceArtifacts: [crossCoordinateProof],
    };
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult: crossCoordinateResult,
          actionResultArtifact: {
            ...receiptInput().actionResultArtifact,
            sha256: rawDigest(crossCoordinateResult),
          },
          proofArtifacts: [crossCoordinateProof],
        }),
      "CONTROLLER_ACTION_PROOF",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput("remote-peer"),
          observerTranscripts: [
            {
              path: `segments/win11-current/ascii/f-01/f01-ordinary-absolute-path/evidence/native-transcripts/${digest("2")}.json`,
              sha256: digest("9"),
              transcriptSha256: digest("2"),
            },
          ],
        }),
      "CONTROLLER_ACTION_OBSERVER",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          observerTranscripts: [
            {
              ...receiptInput().observerTranscripts[0]!,
              path: `segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/native-transcripts/${digest("9")}.json`,
            },
          ],
        }),
      "CONTROLLER_ACTION_OBSERVER",
    );
    expectCode(
      () =>
        probeControllerActionProvenancePaths({
          campaignRunId: "../escape",
          attemptId: "attempt-one",
          workId: "work-0001",
          producerActionId: "prepare-target",
        }),
      "CONTROLLER_ACTION_IDENTIFIER",
    );
    expectCode(
      () =>
        probeControllerActionProvenancePaths({
          campaignRunId: "con",
          attemptId: "attempt-one",
          workId: "work-0001",
          producerActionId: "prepare-target",
        }),
      "CONTROLLER_ACTION_PATH",
    );
    expectCode(
      () =>
        probeControllerActionProvenancePaths({
          campaignRunId: "campaign-run",
          attemptId: "attempt-one",
          workId: "work-0001",
          producerActionId: "prepare-target.controller-request",
        }),
      "CONTROLLER_ACTION_IDENTIFIER",
    );
  });

  it("rejects path, case-fold, and digest collisions in arrays and across the signed union", () => {
    const collision = {
      path: "segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/proofs/EXECUTION.json",
      sha256: digest("8"),
    };
    const actionResult = {
      ...receiptInput().actionResult,
      evidenceArtifacts: [...receiptInput().proofArtifacts, collision],
    };
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult,
          actionResultArtifact: {
            ...receiptInput().actionResultArtifact,
            sha256: rawDigest(actionResult),
          },
          proofArtifacts: actionResult.evidenceArtifacts,
        }),
      "CONTROLLER_ACTION_ARTIFACT",
    );
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          observerTranscripts: [
            {
              path: `segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/native-transcripts/${digest("2")}.json`,
              sha256: digest("1"),
              transcriptSha256: digest("2"),
            },
          ],
        }),
      "CONTROLLER_ACTION_ARTIFACT",
    );

    const evidencePrefix =
      "segments/win11-floor/ascii/f-01/f01-ordinary-absolute-path/evidence/proofs";
    const excessiveProofs = Array.from({ length: 4_095 }, (_, index) => ({
      path: `${evidencePrefix}/proof-${String(index).padStart(4, "0")}.json`,
      sha256: index.toString(16).padStart(64, "0"),
    }));
    const excessiveResult = {
      ...receiptInput().actionResult,
      evidenceArtifacts: excessiveProofs,
    };
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult: excessiveResult,
          actionResultArtifact: {
            ...receiptInput().actionResultArtifact,
            sha256: rawDigest(excessiveResult),
          },
          proofArtifacts: excessiveProofs,
          brokerProof: excessiveProofs[0]!,
        }),
      "CONTROLLER_ACTION_ARTIFACT",
    );
  });

  it("rejects incomplete, accessor, hidden, symbolic, cyclic, and non-JSON inputs without getter reads", () => {
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          expectedActor: undefined,
        } as never),
      "CONTROLLER_ACTION_JSON",
    );

    let getterReads = 0;
    const accessor = { ...receiptInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "coordinate", {
      enumerable: true,
      get() {
        getterReads += 1;
        return receiptInput().coordinate;
      },
    });
    expectCode(
      () => createProbeControllerActionExecutionReceipt(accessor as never),
      "CONTROLLER_ACTION_JSON",
    );
    expect(getterReads).toBe(0);

    const hidden = { ...receiptInput() };
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expectCode(
      () => createProbeControllerActionExecutionReceipt(hidden as never),
      "CONTROLLER_ACTION_JSON",
    );

    const symbolic = { ...receiptInput(), [Symbol("hidden")]: true };
    expectCode(
      () => createProbeControllerActionExecutionReceipt(symbolic as never),
      "CONTROLLER_ACTION_JSON",
    );

    const cyclicEvent: Record<string, unknown> = {};
    cyclicEvent.self = cyclicEvent;
    expectCode(
      () =>
        createProbeControllerActionExecutionReceipt({
          ...receiptInput(),
          actionResult: { ...receiptInput().actionResult, commandEvent: cyclicEvent } as never,
        }),
      "CONTROLLER_ACTION_JSON",
    );
  });
});

describe("controller action provenance index", () => {
  it("derives the deterministic action-level stem and all six retained paths", () => {
    expect(
      probeControllerActionProvenancePaths({
        campaignRunId: "campaign-run",
        attemptId: "attempt-one",
        workId: "work-0001",
        producerActionId: "prepare-target",
      }),
    ).toEqual({
      stem: "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target",
      provenance:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.json",
      receipt:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.receipt.json",
      controllerRequest:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.controller-request.json",
      operationRequest:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.operation-request.json",
      controllerResponse:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.controller-response.json",
      operationResponse:
        "runtime/work/campaign-run/attempt-one/work-0001/action-provenance/prepare-target.operation-response.json",
    });
  });

  it("builds deterministic immutable records and validates only against trusted receipt and bytes", () => {
    const trusted = trustedInput();
    const provenance = createProbeControllerActionProvenance(trusted);
    expect(validateProbeControllerActionProvenance(provenance, trusted)).toEqual(provenance);
    expect(provenance.provenanceSha256).toBe(
      deriveProbeControllerActionProvenanceDigest(provenance),
    );
    expect(provenance.records.executionReceipt.sha256).toBe(rawDigest(trusted.receipt));
    expect(provenance.records.executionReceipt.bytes).toBe(
      Buffer.byteLength(canonicalProbeJson(trusted.receipt), "utf8"),
    );
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance.records)).toBe(true);
  });

  it("rejects binding swaps against an independently trusted receipt", () => {
    const primary = trustedInput();
    const substitutedReceipt = createProbeControllerActionExecutionReceipt(
      receiptInput("controller", { candidateSha256: digest("9") }),
    );
    const substituted = createProbeControllerActionProvenance(trustedInput(substitutedReceipt));
    expectCode(
      () => validateProbeControllerActionProvenance(substituted, primary),
      "CONTROLLER_ACTION_BINDING",
    );

    const provenance = createProbeControllerActionProvenance(primary);
    expectCode(
      () =>
        validateProbeControllerActionProvenance(provenance, {
          ...primary,
          records: {
            ...primary.records,
            controllerRequest: { ...primary.records.controllerRequest, sha256: digest("8") },
          },
        }),
      "CONTROLLER_ACTION_BINDING",
    );
  });

  it("rejects deterministic-path substitution and provenance record digest collisions", () => {
    const trusted = trustedInput();
    const provenance = createProbeControllerActionProvenance(trusted);
    expectCode(
      () =>
        validateProbeControllerActionProvenance(
          {
            ...provenance,
            records: {
              ...provenance.records,
              controllerRequest: {
                ...provenance.records.controllerRequest,
                path: "runtime/work/other/controller-request.json",
              },
            },
          },
          trusted,
        ),
      "CONTROLLER_ACTION_RECORD",
    );

    expectCode(
      () =>
        createProbeControllerActionProvenance({
          ...trusted,
          records: {
            ...trusted.records,
            operationRequest: {
              ...trusted.records.operationRequest,
              sha256: trusted.records.controllerRequest.sha256,
            },
          },
        }),
      "CONTROLLER_ACTION_RECORD",
    );
  });

  it("rejects incomplete or accessor-bearing trusted records without reading getters", () => {
    const trusted = trustedInput();
    expectCode(
      () =>
        createProbeControllerActionProvenance({
          ...trusted,
          records: {
            ...trusted.records,
            operationResponse: undefined,
          },
        } as never),
      "CONTROLLER_ACTION_JSON",
    );

    let getterReads = 0;
    const accessor = { ...trusted.records } as Record<string, unknown>;
    Object.defineProperty(accessor, "controllerResponse", {
      enumerable: true,
      get() {
        getterReads += 1;
        return trusted.records.controllerResponse;
      },
    });
    expectCode(
      () =>
        createProbeControllerActionProvenance({
          receipt: trusted.receipt,
          records: accessor,
        } as never),
      "CONTROLLER_ACTION_JSON",
    );
    expect(getterReads).toBe(0);
  });
});
