import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import {
  acquireProbeBrokerExecutionAuthorityLease,
  confirmProbeBrokerExecutionAuthority,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import {
  PROBE_BROKER_MAX_ARTIFACT_BYTES,
  PROBE_BROKER_MAX_DEPTH,
  PROBE_BROKER_MAX_REFERENCES,
  PROBE_BROKER_TASK_MAX_TTL_MS,
  acceptProbeBrokerTask,
  createProbeBrokerControllerAcceptanceInput,
  createProbeBrokerDriverValidationReceipt,
  createProbeBrokerResult,
  createProbeBrokerTask,
  deriveProbeBrokerResultDigest,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  deriveProbeBrokerTaskDigest,
  getProbeBrokerAcceptedContextExecutionAuthorityLease,
  validateProbeBrokerControllerAcceptanceInput,
  validateProbeBrokerControllerAcceptanceInputForTask,
  validateProbeBrokerResult,
  validateProbeBrokerResultForTask,
  validateProbeBrokerTask,
  verifyProbeBrokerTaskSignature,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import type {
  ProbeAcceptedBrokerTaskContext,
  ProbeBrokerActorIdentitySource,
  ProbeBrokerDriverValidationRequest,
  ProbeBrokerRecoveryClass,
  ProbeBrokerReplayBinding,
  ProbeBrokerReplayJournalDecision,
  ProbeBrokerRole,
  ProbeBrokerTask,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeControllerBrokerAcceptance } from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});
const controllerIdentitySha256 = sha256("controller-identity");
const brokerEnrollmentSha256 = sha256("primary-broker-enrollment");
const driverRequestBlobs = new Map<string, Buffer>();

const brokerCases = [
  {
    role: "primary-standard-user",
    identitySource: "actors.primaryStandardUserSidSha256",
    rowId: "F-01",
    variantId: "f01-ordinary-absolute-path",
    actionId: "prepare-home-topology",
  },
  {
    role: "second-user",
    identitySource: "actors.secondUserSidSha256",
    rowId: "F-08",
    variantId: "f08-client-second-user-refusal",
    actionId: "start-second-user-pipe-client",
  },
  {
    role: "remote-peer",
    identitySource: "actors.remotePeerActorSha256",
    rowId: "F-08",
    variantId: "f08-client-remote-pipe-refusal",
    actionId: "start-remote-pipe-client",
  },
] as const;

interface ScenarioTaskFixture {
  readonly role: ProbeBrokerRole;
  readonly identitySource: ProbeBrokerActorIdentitySource;
  readonly rowId: string;
  readonly variantId: string;
  readonly actionId: string;
}

function createScenarioTask(
  broker: ScenarioTaskFixture,
  options: {
    readonly enrollmentSha256?: string;
    readonly instanceId?: string;
    readonly taskId?: string;
    readonly nonceByte?: number;
    readonly issuedAt?: string;
    readonly deadline?: string;
    readonly campaignRunId?: string;
    readonly executionRunId?: string;
    readonly attemptId?: string;
    readonly candidateSha256?: string;
    readonly claimReceiptSha256?: string;
    readonly recoveryClass?: ProbeBrokerRecoveryClass;
    readonly mailboxAclSha256?: string;
    readonly processSidSha256?: string;
    readonly bootIdSha256?: string;
    readonly runnerSessionIdSha256?: string;
    readonly driverRequestKind?: string;
  } = {},
) {
  const definition = getProbeScenarioDefinition(broker.rowId, broker.variantId);
  const plannedAction = definition.actions.find((action) => action.actionId === broker.actionId)!;
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: plannedAction,
  };
  const execution = getProbeActionMapping(invocation);
  const enrollmentSha256 = options.enrollmentSha256 ?? sha256(`${broker.role}-enrollment`);
  const instanceId = options.instanceId ?? `${broker.role}-broker-a`;
  const campaignRunId = options.campaignRunId ?? "campaign-run-a";
  const executionRunId = options.executionRunId ?? "execution-run-a";
  const attemptId = options.attemptId ?? "attempt-a";
  const environmentId = "win11-current";
  const pathProfileId = "ascii";
  const workItem = PROBE_RUN_PLAN.work.find(
    (candidate) =>
      candidate.environmentId === environmentId &&
      candidate.pathProfileId === pathProfileId &&
      candidate.rowId === definition.rowId &&
      candidate.variantId === definition.variantId,
  )!;
  const repetition = Number.isSafeInteger(plannedAction.parameters.repetition)
    ? (plannedAction.parameters.repetition as number)
    : null;
  const expectedActor = {
    role: broker.role,
    identitySource: broker.identitySource,
    identitySha256: sha256(`${broker.role}-actor`),
  };
  const processSidSha256 =
    options.processSidSha256 ??
    (broker.role === "remote-peer"
      ? sha256(`${broker.role}-process-sid`)
      : expectedActor.identitySha256);
  const operationCommand = {
    campaignRunId,
    attemptId,
    workId: workItem.workId,
    ...(repetition === null ? {} : { repetition }),
  };
  const operationId = deriveProbeRuntimeScenarioOperationId(
    operationCommand,
    plannedAction.actionId,
  );
  const runtimeActionIntentSha256 = hashProbeCanonicalJson({
    schemaVersion: 2,
    kind: "windows-host-probe-runtime-action-intent",
    campaignRunId,
    attemptId,
    workId: workItem.workId,
    rowId: definition.rowId,
    variantId: definition.variantId,
    repetition,
    planSha256: definition.planSha256,
    actionId: plannedAction.actionId,
    operationId,
    action: plannedAction,
    execution,
    expectedActor,
  });
  const actorSelectorInput =
    execution.actorSelector.kind === "fixed"
      ? null
      : {
          parameter: "actor" as const,
          value: plannedAction.parameters.actor as "current-user" | "second-user",
        };
  return createProbeBrokerTask(
    {
      taskId: options.taskId ?? `task-${broker.role}-${broker.actionId}`,
      controllerIdentitySha256,
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
      candidateSha256: options.candidateSha256 ?? sha256("candidate"),
      runAuthorizationClaimReceiptSha256:
        options.claimReceiptSha256 ?? sha256("run-authorization-claim"),
      coordinate: {
        campaignRunId,
        executionRunId,
        attemptId,
        workId: workItem.workId,
        environmentId,
        pathProfileId,
        rowId: definition.rowId,
        variantId: definition.variantId,
        repetition,
      },
      runtimeActionIntentSha256,
      action: {
        scenarioPlanSha256: definition.planSha256,
        producerActionId: plannedAction.actionId,
        operationId,
        sequence: plannedAction.sequence,
      },
      execution,
      actorSelectorInput,
      expectedActor,
      brokerEnrollmentSha256: enrollmentSha256,
      brokerInstanceId: instanceId,
      brokerRole: broker.role,
      mailboxAclSha256: options.mailboxAclSha256 ?? sha256(`${broker.role}-mailbox-acl`),
      processSidSha256,
      bootIdSha256: options.bootIdSha256 ?? sha256(`${broker.role}-boot`),
      runnerSessionIdSha256:
        options.runnerSessionIdSha256 ?? sha256(`${broker.role}-runner-session`),
      driverRequest: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-request",
        driverId: execution.driverId,
        requestArtifact: driverRequestArtifact(
          execution.driverId,
          `${broker.role}-${plannedAction.actionId}`,
          options.driverRequestKind,
        ),
      },
      recoveryClass: options.recoveryClass ?? "inspect-and-reconcile",
      issuedAt: options.issuedAt ?? "2098-12-31T23:55:00.000Z",
      deadline: options.deadline ?? "2099-01-01T00:00:00.000Z",
      nonceBase64: Buffer.alloc(32, options.nonceByte ?? 1).toString("base64"),
    },
    (digest) => sign(null, digest, controllerKeys.privateKey),
  );
}

function createRoleTask(role: (typeof brokerCases)[number]["role"]) {
  const broker = brokerCases.find((entry) => entry.role === role)!;
  return createScenarioTask(broker, { nonceByte: brokerCases.indexOf(broker) + 1 });
}

function createPrimaryTask() {
  return createScenarioTask(brokerCases[0], {
    enrollmentSha256: brokerEnrollmentSha256,
    instanceId: "primary-broker-a",
    taskId: "task-primary-home-topology",
    nonceByte: 7,
  });
}

function artifact(label: string, bytes = 128) {
  const digest = sha256(label);
  return {
    blobPath: `blobs/sha256/${digest}` as const,
    bytes,
    sha256: digest,
  };
}

function driverRequestArtifact(
  driverId: string,
  label: string,
  kind = "test-windows-host-probe-driver-request",
) {
  const bytes = Buffer.from(
    canonicalProbeJson({
      schemaVersion: 1,
      kind,
      driverId,
      label,
    }),
    "utf8",
  );
  const digest = sha256(bytes);
  driverRequestBlobs.set(digest, bytes);
  return {
    blobPath: `blobs/sha256/${digest}` as const,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

function createPrimaryResult(task = createPrimaryTask()) {
  const proof = artifact("proof");
  return createProbeBrokerResult({
    taskSha256: task.taskSha256,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
    actor: task.expectedActor,
    bootIdSha256: task.bootIdSha256,
    runnerSessionIdSha256: task.runnerSessionIdSha256,
    outcome: "SUCCEEDED",
    driverResult: {
      schemaVersion: 1,
      kind: "windows-host-probe-broker-driver-result",
      driverId: task.execution.driverId,
      resultArtifact: artifact("driver-result"),
    },
    proofArtifacts: [proof],
    observerTranscripts: [
      {
        ...artifact("primary-observer"),
        transcriptSha256: sha256("primary-observer-transcript"),
      },
    ],
    pausedSessionReceipt: proof,
  });
}

function observedLocalContext(task: ProbeBrokerTask) {
  return {
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
    peerAuthoritySha256:
      task.brokerRole === "remote-peer" ? task.expectedActor.identitySha256 : null,
    mailboxAclSha256: task.mailboxAclSha256,
    processSidSha256: task.processSidSha256,
    bootIdSha256: task.bootIdSha256,
    runnerSessionIdSha256: task.runnerSessionIdSha256,
  };
}

function executionAuthoritySnapshot(task: ProbeBrokerTask) {
  const observed = observedLocalContext(task);
  return {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-broker-execution-authority" as const,
    preparedRunGenerationSha256: sha256(`prepared-run:${task.coordinate.executionRunId}`),
    controllerIdentitySha256: task.controllerIdentitySha256,
    controllerPublicKeySha256: task.controllerPublicKeySha256,
    candidateSha256: task.candidateSha256,
    runAuthorizationClaimReceiptSha256: task.runAuthorizationClaimReceiptSha256,
    coordinate: task.coordinate,
    semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
    physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    runtimeActionIntentSha256: task.runtimeActionIntentSha256,
    operationId: task.action.operationId,
    producerActionId: task.action.producerActionId,
    driverId: task.driverRequest.driverId,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: sha256(`prepared:${task.brokerEnrollmentSha256}`),
    brokerInstanceId: observed.brokerInstanceId,
    brokerRole: observed.brokerRole,
    mailboxRootObjectIdentitySha256: sha256(`${task.brokerInstanceId}-mailbox-object`),
    mailboxVolumeIdSha256: sha256(`${task.brokerInstanceId}-mailbox-volume`),
    mailboxTransportIdentitySha256: sha256(`${task.brokerInstanceId}-mailbox-transport`),
    mailboxAclSha256: observed.mailboxAclSha256,
    mailboxOwnerSidSha256: observed.processSidSha256,
    journalRoot: `/tmp/${task.brokerInstanceId}-journal`,
    journalSecurityProfile: "role-separated-append-only-journal-v1" as const,
    journalRootPathSha256: sha256(`${task.brokerInstanceId}-journal-root-path`),
    journalRootObjectIdentitySha256: sha256(`${task.brokerInstanceId}-journal-root-object`),
    journalVolumeIdSha256: sha256(`${task.brokerInstanceId}-journal-volume`),
    journalRootOwnerSidSha256: sha256(`${task.brokerInstanceId}-journal-root-owner`),
    journalRootAclSha256: sha256(`${task.brokerInstanceId}-journal-root-acl`),
    journalDatabasePathSha256: sha256(`${task.brokerInstanceId}-journal-database-path`),
    journalDatabaseObjectIdentitySha256: sha256(`${task.brokerInstanceId}-journal-database-object`),
    journalDatabaseOwnerSidSha256: sha256(`${task.brokerInstanceId}-journal-database-owner`),
    journalDatabaseAclSha256: sha256(`${task.brokerInstanceId}-journal-database-acl`),
    journalTransportIdentitySha256: sha256(`${task.brokerInstanceId}-journal-transport`),
    processSidSha256: observed.processSidSha256,
    bootIdSha256: observed.bootIdSha256,
    runnerSessionIdSha256: observed.runnerSessionIdSha256,
    nativeObservationSha256: sha256(`${task.brokerInstanceId}-native-observation`),
    peerAuthoritySha256: observed.peerAuthoritySha256,
  };
}

async function validateDriverRequestFixture(
  request: ProbeBrokerDriverValidationRequest,
  recoveryClass: ProbeBrokerRecoveryClass,
) {
  const bytes = driverRequestBlobs.get(request.requestArtifact.sha256);
  if (
    bytes === undefined ||
    bytes.byteLength !== request.requestArtifact.bytes ||
    sha256(bytes) !== request.requestArtifact.sha256
  ) {
    throw new Error("driver request artifact bytes failed digest or length validation");
  }
  const payload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (
    canonicalProbeJson(Object.keys(payload).sort()) !==
      canonicalProbeJson(["driverId", "kind", "label", "schemaVersion"]) ||
    payload.schemaVersion !== 1 ||
    payload.kind !== "test-windows-host-probe-driver-request" ||
    payload.driverId !== request.driverId ||
    typeof payload.label !== "string"
  ) {
    throw new Error("driver request artifact failed its driver-specific schema");
  }
  return createProbeBrokerDriverValidationReceipt({
    taskSha256: request.taskSha256,
    driverId: request.driverId,
    requestArtifactSha256: request.requestArtifact.sha256,
    requestArtifactBytes: request.requestArtifact.bytes,
    requestSchemaSha256: sha256(`test-driver-request-schema:${request.driverId}`),
    recoveryClass,
  });
}

interface ReplayRecord {
  readonly semanticKeySha256: string;
  readonly physicalOperationKeySha256: string;
  readonly taskSha256: string;
  readonly replayJournalEntrySha256: string;
}

function createDurableReplayGuard(seed: readonly ReplayRecord[] = []) {
  const records = new Map(seed.map((record) => [record.physicalOperationKeySha256, record]));
  return {
    consume: async (
      binding: ProbeBrokerReplayBinding,
    ): Promise<ProbeBrokerReplayJournalDecision> => {
      const retained = records.get(binding.physicalOperationKeySha256);
      if (retained === undefined) {
        if (!binding.allowFresh) {
          return {
            disposition: "absent",
            semanticKeySha256: binding.semanticKeySha256,
            physicalOperationKeySha256: binding.physicalOperationKeySha256,
          };
        }
        const replayJournalEntrySha256 = sha256(
          canonicalProbeJson({ domain: "test-broker-replay-journal", binding }),
        );
        records.set(binding.physicalOperationKeySha256, {
          semanticKeySha256: binding.semanticKeySha256,
          physicalOperationKeySha256: binding.physicalOperationKeySha256,
          taskSha256: binding.taskSha256,
          replayJournalEntrySha256,
        });
        return {
          disposition: "fresh",
          semanticKeySha256: binding.semanticKeySha256,
          physicalOperationKeySha256: binding.physicalOperationKeySha256,
          taskSha256: binding.taskSha256,
          replayJournalEntrySha256,
        };
      }
      if (retained.taskSha256 === binding.taskSha256) {
        return {
          disposition: "retained",
          semanticKeySha256: binding.semanticKeySha256,
          physicalOperationKeySha256: binding.physicalOperationKeySha256,
          taskSha256: binding.taskSha256,
          replayJournalEntrySha256: retained.replayJournalEntrySha256,
        };
      }
      return {
        disposition: "equivocation",
        semanticKeySha256: binding.semanticKeySha256,
        physicalOperationKeySha256: binding.physicalOperationKeySha256,
        retainedTaskSha256: retained.taskSha256,
        replayJournalEntrySha256: retained.replayJournalEntrySha256,
      };
    },
    snapshot: () => [...records.values()],
  };
}

async function acceptanceOptions(
  task: ProbeBrokerTask,
  replayGuard = createDurableReplayGuard(),
  overrides: {
    readonly verificationInstant?: Date;
    readonly observedContext?: ReturnType<typeof observedLocalContext>;
    readonly authority?: Pick<
      ReturnType<typeof executionAuthoritySnapshot>,
      "candidateSha256" | "runAuthorizationClaimReceiptSha256" | "coordinate"
    >;
    readonly driverRecoveryClass?: ProbeBrokerRecoveryClass;
    readonly executionAuthoritySnapshot?: ReturnType<typeof executionAuthoritySnapshot>;
    readonly revalidateExecutionAuthority?: () =>
      | ReturnType<typeof executionAuthoritySnapshot>
      | Promise<ReturnType<typeof executionAuthoritySnapshot>>;
    readonly validateDriverRequest?: (
      request: ProbeBrokerDriverValidationRequest,
    ) => ReturnType<typeof validateDriverRequestFixture>;
  } = {},
) {
  const base = executionAuthoritySnapshot(task);
  const observedOverride =
    overrides.observedContext === undefined
      ? {}
      : {
          brokerEnrollmentSha256: overrides.observedContext.brokerEnrollmentSha256,
          preparedBrokerEnrollmentSha256: sha256(
            `prepared:${overrides.observedContext.brokerEnrollmentSha256}`,
          ),
          brokerInstanceId: overrides.observedContext.brokerInstanceId,
          brokerRole: overrides.observedContext.brokerRole,
          peerAuthoritySha256: overrides.observedContext.peerAuthoritySha256,
          mailboxAclSha256: overrides.observedContext.mailboxAclSha256,
          processSidSha256: overrides.observedContext.processSidSha256,
          bootIdSha256: overrides.observedContext.bootIdSha256,
          runnerSessionIdSha256: overrides.observedContext.runnerSessionIdSha256,
        };
  const authority = {
    ...base,
    ...overrides.authority,
    ...observedOverride,
    ...overrides.executionAuthoritySnapshot,
  };
  const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
    acquire: async () => authority,
    revalidate: overrides.revalidateExecutionAuthority ?? (async () => authority),
    release: async () => {},
  });
  return {
    controllerPublicKeyBytes,
    expectedControllerIdentitySha256: controllerIdentitySha256,
    executionAuthorityLease,
    validateDriverRequest:
      overrides.validateDriverRequest ??
      ((request: ProbeBrokerDriverValidationRequest) =>
        validateDriverRequestFixture(request, overrides.driverRecoveryClass ?? task.recoveryClass)),
    verificationInstant: overrides.verificationInstant ?? new Date("2098-12-31T23:59:59.000Z"),
    replayGuard: { consume: replayGuard.consume },
  };
}

async function acceptTask(task: ProbeBrokerTask): Promise<ProbeAcceptedBrokerTaskContext> {
  return acceptProbeBrokerTask(task, await acceptanceOptions(task));
}

async function resultValidationConfirmation(context: ProbeAcceptedBrokerTaskContext) {
  return confirmProbeBrokerExecutionAuthority(
    getProbeBrokerAcceptedContextExecutionAuthorityLease(context),
    "result-validation",
  );
}

async function validateAcceptedResult(
  value: Parameters<typeof validateProbeBrokerResultForTask>[0],
  context: ProbeAcceptedBrokerTaskContext,
) {
  return validateProbeBrokerResultForTask(
    value,
    context,
    await resultValidationConfirmation(context),
  );
}

describe("Windows host probe broker protocol", () => {
  it("creates a task and verifies its controller signature without accepting delivery", () => {
    const task = createPrimaryTask();

    expect(
      verifyProbeBrokerTaskSignature(task, {
        controllerPublicKeyBytes,
        expectedControllerIdentitySha256: controllerIdentitySha256,
      }),
    ).toEqual(task);
    expect(task.signatureAlgorithm).toBe("Ed25519");
    expect(task.signatureBase64).toBe(
      sign(null, Buffer.from(task.taskSha256, "hex"), controllerKeys.privateKey).toString("base64"),
    );
    expect(Object.isFrozen(task)).toBe(true);
  });

  it("creates an unsigned digest-addressed result bound to the exact accepted task", async () => {
    const task = createPrimaryTask();
    const result = createPrimaryResult(task);
    const acceptedContext = await acceptTask(task);

    expect(await validateAcceptedResult(result, acceptedContext)).toEqual(result);
    const controllerAcceptanceInput = await createProbeBrokerControllerAcceptanceInput(
      result,
      acceptedContext,
      await resultValidationConfirmation(acceptedContext),
    );
    expect(controllerAcceptanceInput).toMatchObject({
      coordinate: task.coordinate,
      producerActionId: task.action.producerActionId,
      brokerTaskSha256: task.taskSha256,
      brokerResultSha256: result.resultSha256,
      mailboxAclSha256: task.mailboxAclSha256,
      processSidSha256: task.processSidSha256,
      bootIdSha256: task.bootIdSha256,
      runnerSessionIdSha256: task.runnerSessionIdSha256,
      replayJournalDisposition: "accepted",
    });
    expect(validateProbeBrokerControllerAcceptanceInput(controllerAcceptanceInput)).toEqual(
      controllerAcceptanceInput,
    );
    expect(
      validateProbeBrokerControllerAcceptanceInputForTask(controllerAcceptanceInput, task, result),
    ).toEqual(controllerAcceptanceInput);
    expect(() =>
      validateProbeBrokerControllerAcceptanceInputForTask(
        { ...controllerAcceptanceInput, brokerResultSha256: sha256("another-result") },
        task,
        result,
      ),
    ).toThrowError(expect.objectContaining({ code: "BROKER_PROTOCOL_CONTROLLER_ACCEPTANCE" }));
    expect(createProbeControllerBrokerAcceptance(controllerAcceptanceInput)).toMatchObject({
      ...controllerAcceptanceInput,
      acceptanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(
      validateAcceptedResult(result, task as unknown as ProbeAcceptedBrokerTaskContext),
    ).rejects.toThrow(/rehydrated through the durable replay guard/i);
    expect(result).not.toHaveProperty("signatureAlgorithm");
    expect(result).not.toHaveProperty("signatureBase64");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses one role-parametric contract for primary, second-user, and remote-peer brokers", async () => {
    for (const broker of brokerCases) {
      const task = createRoleTask(broker.role);
      expect((await acceptTask(task)).task.brokerRole).toBe(broker.role);
    }
  });

  it("distinguishes static enrollment identity from the prepared enrollment receipt", async () => {
    const task = createPrimaryTask();
    const authority = executionAuthoritySnapshot(task);
    expect(authority.brokerEnrollmentSha256).toBe(task.brokerEnrollmentSha256);
    expect(authority.preparedBrokerEnrollmentSha256).not.toBe(authority.brokerEnrollmentSha256);
    await expect(
      acceptProbeBrokerTask(
        task,
        await acceptanceOptions(task, createDurableReplayGuard(), {
          executionAuthoritySnapshot: authority,
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      acceptProbeBrokerTask(
        task,
        await acceptanceOptions(task, createDurableReplayGuard(), {
          executionAuthoritySnapshot: {
            ...authority,
            brokerEnrollmentSha256: authority.preparedBrokerEnrollmentSha256,
          },
        }),
      ),
    ).rejects.toThrow(/broker|enrollment|live execution authority/i);
  });

  it("rejects task tampering before and after digest recomputation", () => {
    const task = createPrimaryTask();
    const changedPayload = JSON.parse(JSON.stringify(task));
    changedPayload.candidateSha256 = sha256("substituted-candidate");
    expect(() => validateProbeBrokerTask(changedPayload)).toThrow(/digest/i);

    changedPayload.taskSha256 = deriveProbeBrokerTaskDigest(changedPayload);
    expect(() =>
      verifyProbeBrokerTaskSignature(changedPayload, {
        controllerPublicKeyBytes,
        expectedControllerIdentitySha256: controllerIdentitySha256,
      }),
    ).toThrow(/signature/i);

    const changedSignature = JSON.parse(JSON.stringify(task));
    changedSignature.signatureBase64 = Buffer.alloc(64, 9).toString("base64");
    expect(() =>
      verifyProbeBrokerTaskSignature(changedSignature, {
        controllerPublicKeyBytes,
        expectedControllerIdentitySha256: controllerIdentitySha256,
      }),
    ).toThrow(/signature/i);

    const changedMapping = JSON.parse(JSON.stringify(task));
    changedMapping.execution.driverId = "unreviewed-driver";
    changedMapping.driverRequest.driverId = "unreviewed-driver";
    expect(() => deriveProbeBrokerTaskDigest(changedMapping)).toThrow(/audited mapping/i);

    const changedAction = JSON.parse(JSON.stringify(task));
    changedAction.action.scenarioPlanSha256 = sha256("substituted-scenario-plan");
    expect(() => validateProbeBrokerTask(changedAction)).toThrow(/scenario plan|digest/i);
  });

  it("refuses cross-enrollment, cross-instance, and cross-role task delivery", async () => {
    const task = createPrimaryTask();
    const local = observedLocalContext(task);
    for (const observedContext of [
      {
        ...local,
        brokerEnrollmentSha256: sha256("other-enrollment"),
      },
      {
        ...local,
        brokerInstanceId: "primary-broker-b",
      },
      {
        ...local,
        brokerRole: "second-user" as const,
      },
    ]) {
      await expect(
        acceptProbeBrokerTask(
          task,
          await acceptanceOptions(task, createDurableReplayGuard(), { observedContext }),
        ),
      ).rejects.toThrow(/broker|enrollment|instance/i);
    }

    const otherController = generateKeyPairSync("ed25519").publicKey.export({
      format: "der",
      type: "spki",
    });
    expect(() =>
      verifyProbeBrokerTaskSignature(task, {
        controllerPublicKeyBytes: otherController,
        expectedControllerIdentitySha256: controllerIdentitySha256,
      }),
    ).toThrow(/controller/i);
  });

  it("requires exact enumerable data fields without invoking accessors", () => {
    const task = createPrimaryTask();
    const extraTopLevel = { ...task, unexpected: true };
    expect(() => validateProbeBrokerTask(extraTopLevel)).toThrow(/field set/i);

    const extraNested = JSON.parse(JSON.stringify(task));
    extraNested.execution.unreviewedFlag = true;
    expect(() => validateProbeBrokerTask(extraNested)).toThrow(/field set/i);

    const accessor = JSON.parse(JSON.stringify(task));
    let getterRead = false;
    Object.defineProperty(accessor, "taskId", {
      enumerable: true,
      get() {
        getterRead = true;
        return task.taskId;
      },
    });
    expect(() => validateProbeBrokerTask(accessor)).toThrow(/enumerable data/i);
    expect(getterRead).toBe(false);
  });

  it("requires an exact action binding with digest, identifiers, and positive sequence", () => {
    const task = createPrimaryTask();
    for (const [field, value, message] of [
      ["scenarioPlanSha256", "not-a-digest", /SHA-256/i],
      ["producerActionId", "UPPERCASE", /kebab-case/i],
      ["operationId", "contains spaces", /kebab-case/i],
      ["sequence", 0, /positive safe integer/i],
    ] as const) {
      const invalid = JSON.parse(JSON.stringify(task));
      invalid.action[field] = value;
      expect(() => validateProbeBrokerTask(invalid)).toThrow(message);
    }

    const expanded = JSON.parse(JSON.stringify(task));
    expanded.action.command = "ignored-command";
    expect(() => validateProbeBrokerTask(expanded)).toThrow(/field set/i);
  });

  it("resolves the frozen scenario action and normalized F-02 selector before execution", () => {
    const task = createScenarioTask({
      role: "second-user",
      identitySource: "actors.secondUserSidSha256",
      rowId: "F-02",
      variantId: "f02-second-user-write-refusal",
      actionId: "exercise-directory-access",
    });
    expect(task.actorSelectorInput).toEqual({ parameter: "actor", value: "second-user" });

    const changedSelector = JSON.parse(JSON.stringify(task));
    changedSelector.actorSelectorInput.value = "current-user";
    expect(() => validateProbeBrokerTask(changedSelector)).toThrow(
      /selectorInput.*frozen scenario/i,
    );

    const missingSelector = JSON.parse(JSON.stringify(task));
    missingSelector.actorSelectorInput = null;
    expect(() => validateProbeBrokerTask(missingSelector)).toThrow(
      /selectorInput.*frozen scenario/i,
    );

    const changedActor = JSON.parse(JSON.stringify(task));
    changedActor.expectedActor = {
      role: "primary-standard-user",
      identitySource: "actors.primaryStandardUserSidSha256",
      identitySha256: sha256("primary-standard-user-actor"),
    };
    changedActor.brokerRole = "primary-standard-user";
    expect(() => validateProbeBrokerTask(changedActor)).toThrow(
      /expectedActor.*scenario selector/i,
    );

    const changedAction = JSON.parse(JSON.stringify(task));
    changedAction.action.sequence -= 1;
    expect(() => validateProbeBrokerTask(changedAction)).toThrow(/action.*frozen scenario/i);

    const changedCoordinate = JSON.parse(JSON.stringify(task));
    changedCoordinate.coordinate.variantId = "f02-second-user-read-refusal";
    expect(() => validateProbeBrokerTask(changedCoordinate)).toThrow(/scenario plan/i);

    const changedOperation = JSON.parse(JSON.stringify(createPrimaryTask()));
    changedOperation.execution = getProbeActionMapping(
      "external-controller",
      "prepare-private-file-target",
    );
    changedOperation.driverRequest.driverId = changedOperation.execution.driverId;
    expect(() => validateProbeBrokerTask(changedOperation)).toThrow(/action.*frozen scenario/i);
  });

  it("binds the frozen work coordinate, repetition, operation identity, and runtime intent", () => {
    const task = createPrimaryTask();

    const fakeWork = JSON.parse(JSON.stringify(task));
    fakeWork.coordinate.workId = "work-9999";
    expect(() => validateProbeBrokerTask(fakeWork)).toThrow(/frozen run-plan work item/i);

    const crossTuple = JSON.parse(JSON.stringify(task));
    crossTuple.coordinate.environmentId = "win11-floor";
    expect(() => validateProbeBrokerTask(crossTuple)).toThrow(/frozen run-plan work item/i);

    const fakeRepetition = JSON.parse(JSON.stringify(task));
    fakeRepetition.coordinate.repetition = 1;
    expect(() => validateProbeBrokerTask(fakeRepetition)).toThrow(/repetition/i);

    const fakeIntent = JSON.parse(JSON.stringify(task));
    fakeIntent.runtimeActionIntentSha256 = sha256("fake-runtime-intent");
    expect(() => validateProbeBrokerTask(fakeIntent)).toThrow(/runtime action intent/i);

    const fakeOperation = JSON.parse(JSON.stringify(task));
    fakeOperation.action.operationId = `operation-${"a".repeat(32)}`;
    expect(() => validateProbeBrokerTask(fakeOperation)).toThrow(/canonical operation/i);

    const repeated = createScenarioTask({
      role: "primary-standard-user",
      identitySource: "actors.primaryStandardUserSidSha256",
      rowId: "F-07",
      variantId: "f07-hard-cut-after-file-flush",
      actionId: "start-durability-operation-r2",
    });
    expect(repeated.coordinate.repetition).toBe(2);
    expect(validateProbeBrokerTask(repeated)).toEqual(repeated);
  });

  it("journals a stable semantic key and rejects a re-enveloped task as equivocation", async () => {
    const task = createPrimaryTask();
    const durableGuard = createDurableReplayGuard();
    const consumed: ProbeBrokerReplayBinding[] = [];
    const replayGuard = {
      consume: async (binding: ProbeBrokerReplayBinding) => {
        consumed.push(binding);
        return durableGuard.consume(binding);
      },
    };
    const options = await acceptanceOptions(task, replayGuard);

    const acceptedContext = await acceptProbeBrokerTask(task, options);
    expect(consumed).toEqual([
      {
        taskId: task.taskId,
        taskSha256: task.taskSha256,
        nonceBase64: task.nonceBase64,
        recoveryClass: task.recoveryClass,
        issuedAt: task.issuedAt,
        deadline: task.deadline,
        allowFresh: true,
        semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
        physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
        controllerIdentitySha256: task.controllerIdentitySha256,
        brokerEnrollmentSha256: task.brokerEnrollmentSha256,
        candidateSha256: task.candidateSha256,
        runAuthorizationClaimReceiptSha256: task.runAuthorizationClaimReceiptSha256,
        coordinate: task.coordinate,
        runtimeActionIntentSha256: task.runtimeActionIntentSha256,
        operationId: task.action.operationId,
        producerActionId: task.action.producerActionId,
      },
    ]);
    expect(acceptedContext.recoveryDirective).toBe("execute");
    expect(acceptedContext.capability.replayJournalDisposition).toBe("accepted");
    expect(acceptedContext.capability.physicalOperationKeySha256).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    );
    expect(await validateAcceptedResult(createPrimaryResult(task), acceptedContext)).toBeDefined();

    const reEnveloped = createScenarioTask(brokerCases[0], {
      enrollmentSha256: brokerEnrollmentSha256,
      instanceId: "primary-broker-a",
      taskId: "task-primary-home-topology-re-enveloped",
      nonceByte: 8,
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(reEnveloped)).toBe(
      deriveProbeBrokerTaskSemanticKeySha256(task),
    );
    expect(reEnveloped.taskSha256).not.toBe(task.taskSha256);
    await expect(
      acceptProbeBrokerTask(reEnveloped, await acceptanceOptions(reEnveloped, replayGuard)),
    ).rejects.toThrow(/equivocation/i);
  });

  it("deduplicates authorization generations by their physical canonical operation", async () => {
    const original = createPrimaryTask();
    const executionRunOnly = createScenarioTask(brokerCases[0], {
      enrollmentSha256: brokerEnrollmentSha256,
      instanceId: "primary-broker-a",
      taskId: original.taskId,
      nonceByte: 7,
      executionRunId: "execution-run-b",
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(executionRunOnly)).not.toBe(
      deriveProbeBrokerTaskSemanticKeySha256(original),
    );
    expect(deriveProbeBrokerTaskPhysicalOperationKeySha256(executionRunOnly)).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(original),
    );
    const sharedGuard = createDurableReplayGuard();
    await acceptProbeBrokerTask(original, await acceptanceOptions(original, sharedGuard));
    await expect(
      acceptProbeBrokerTask(
        executionRunOnly,
        await acceptanceOptions(executionRunOnly, sharedGuard),
      ),
    ).rejects.toThrow(/equivocation/i);
    expect(sharedGuard.snapshot()).toHaveLength(1);

    const authorizationGenerationOnly = createScenarioTask(brokerCases[0], {
      enrollmentSha256: brokerEnrollmentSha256,
      instanceId: "primary-broker-a",
      taskId: original.taskId,
      nonceByte: 7,
      candidateSha256: sha256("candidate-generation-b"),
      claimReceiptSha256: sha256("claim-generation-b"),
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(authorizationGenerationOnly)).not.toBe(
      deriveProbeBrokerTaskSemanticKeySha256(original),
    );
    expect(deriveProbeBrokerTaskPhysicalOperationKeySha256(authorizationGenerationOnly)).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(original),
    );
    await expect(
      acceptProbeBrokerTask(
        authorizationGenerationOnly,
        await acceptanceOptions(authorizationGenerationOnly, sharedGuard),
      ),
    ).rejects.toThrow(/equivocation/i);
    expect(sharedGuard.snapshot()).toHaveLength(1);
  });

  it("rehydrates exact retained deliveries after a crash with class-specific recovery", async () => {
    const cases = [
      ["read-only-replay", "replay"],
      ["inspect-and-reconcile", "reconcile"],
      ["never-auto-replay", "manual-intervention"],
    ] as const;
    for (const [recoveryClass, recoveryDirective] of cases) {
      const task = createScenarioTask(brokerCases[0], {
        campaignRunId: `campaign-${recoveryClass}`,
        recoveryClass,
      });
      const firstProcessGuard = createDurableReplayGuard();
      const fresh = await acceptProbeBrokerTask(
        task,
        await acceptanceOptions(task, firstProcessGuard),
      );
      expect(fresh.recoveryDirective).toBe("execute");

      const restartedGuard = createDurableReplayGuard(firstProcessGuard.snapshot());
      const recovered = await acceptProbeBrokerTask(
        task,
        await acceptanceOptions(task, restartedGuard, {
          verificationInstant: new Date("2099-01-01T00:30:00.000Z"),
        }),
      );
      expect(recovered.recoveryDirective).toBe(recoveryDirective);
      expect(recovered.capability.replayJournalDisposition).toBe("idempotent-replay");
      expect(await validateAcceptedResult(createPrimaryResult(task), recovered)).toBeDefined();
      const serializedContext = JSON.parse(
        canonicalProbeJson(recovered),
      ) as ProbeAcceptedBrokerTaskContext;
      await expect(
        validateAcceptedResult(createPrimaryResult(task), serializedContext),
      ).rejects.toThrow(/rehydrated through the durable replay guard/i);

      await expect(
        acceptProbeBrokerTask(
          task,
          await acceptanceOptions(task, restartedGuard, {
            driverRecoveryClass:
              recoveryClass === "read-only-replay" ? "never-auto-replay" : "read-only-replay",
          }),
        ),
      ).rejects.toThrow(/recovery class/i);
    }
  });

  it("does not insert an expired never-seen task and consumes concurrent first delivery atomically", async () => {
    const expired = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-expired-never-seen",
    });
    const emptyGuard = createDurableReplayGuard();
    await expect(
      acceptProbeBrokerTask(
        expired,
        await acceptanceOptions(expired, emptyGuard, {
          verificationInstant: new Date("2099-01-01T00:30:00.000Z"),
        }),
      ),
    ).rejects.toThrow(/expired.*absent|absent.*expired/i);
    expect(emptyGuard.snapshot()).toEqual([]);

    const concurrent = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-concurrent-first-delivery",
      recoveryClass: "inspect-and-reconcile",
    });
    const atomicGuard = createDurableReplayGuard();
    const contexts = await Promise.all([
      acceptProbeBrokerTask(concurrent, await acceptanceOptions(concurrent, atomicGuard)),
      acceptProbeBrokerTask(concurrent, await acceptanceOptions(concurrent, atomicGuard)),
    ]);
    expect(contexts.map(({ recoveryDirective }) => recoveryDirective).sort()).toEqual([
      "execute",
      "reconcile",
    ]);
    expect(contexts.map(({ capability }) => capability.replayJournalDisposition).sort()).toEqual([
      "accepted",
      "idempotent-replay",
    ]);
    expect(atomicGuard.snapshot()).toHaveLength(1);
  });

  it("binds authenticated local SID, boot, session, ACL, enrollment, instance, and role", async () => {
    for (const role of ["primary-standard-user", "second-user"] as const) {
      const task = createRoleTask(role);
      await expect(
        acceptProbeBrokerTask(
          task,
          await acceptanceOptions(task, createDurableReplayGuard(), {
            observedContext: {
              ...observedLocalContext(task),
              processSidSha256: sha256("wrong-process-sid"),
            },
          }),
        ),
      ).rejects.toThrow(/process SID|local identity/i);
    }

    const task = createPrimaryTask();
    for (const [field, value] of [
      ["mailboxAclSha256", sha256("wrong-mailbox-acl")],
      ["bootIdSha256", sha256("wrong-boot")],
      ["runnerSessionIdSha256", sha256("wrong-session")],
    ] as const) {
      await expect(
        acceptProbeBrokerTask(
          task,
          await acceptanceOptions(task, createDurableReplayGuard(), {
            observedContext: {
              ...observedLocalContext(task),
              [field]: value,
            },
          }),
        ),
      ).rejects.toThrow(/local identity|mailbox|boot|session/i);
    }

    const forgedTask = createScenarioTask(brokerCases[0], {
      enrollmentSha256: brokerEnrollmentSha256,
      instanceId: "primary-broker-a",
      mailboxAclSha256: sha256("forged-signed-mailbox-acl"),
    });
    const actualObservation = observedLocalContext(createPrimaryTask());
    await expect(
      acceptProbeBrokerTask(
        forgedTask,
        await acceptanceOptions(forgedTask, createDurableReplayGuard(), {
          observedContext: actualObservation,
        }),
      ),
    ).rejects.toThrow(/live execution authority|mailbox/i);

    const remote = createRoleTask("remote-peer");
    await expect(
      acceptProbeBrokerTask(
        remote,
        await acceptanceOptions(remote, createDurableReplayGuard(), {
          observedContext: {
            ...observedLocalContext(remote),
            peerAuthoritySha256: sha256("wrong-remote-peer-authority"),
          },
        }),
      ),
    ).rejects.toThrow(/peer authority|remote/i);
    const remoteContext = await acceptTask(remote);
    expect(remoteContext.capability.processSidSha256).toBe(remote.processSidSha256);
    expect(remoteContext.capability.processSidSha256).not.toBe(remote.expectedActor.identitySha256);
    expect(remoteContext.capability.expectedActor).toEqual(remote.expectedActor);

    const accepted = await acceptTask(task);
    for (const field of ["bootIdSha256", "runnerSessionIdSha256"] as const) {
      const changed = JSON.parse(JSON.stringify(createPrimaryResult(task)));
      changed[field] = sha256(`wrong-result-${field}`);
      changed.resultSha256 = deriveProbeBrokerResultDigest(changed);
      await expect(validateAcceptedResult(changed, accepted)).rejects.toThrow(/binding|local/i);
    }
  });

  it("validates driver bytes and trusted recovery policy before journal consumption", async () => {
    const task = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-driver-policy",
      recoveryClass: "never-auto-replay",
    });
    const policyMismatchGuard = createDurableReplayGuard();
    await expect(
      acceptProbeBrokerTask(
        task,
        await acceptanceOptions(task, policyMismatchGuard, {
          driverRecoveryClass: "inspect-and-reconcile",
        }),
      ),
    ).rejects.toThrow(/recovery class.*driver|driver.*recovery class/i);
    expect(policyMismatchGuard.snapshot()).toEqual([]);

    const corruptGuard = createDurableReplayGuard();
    const artifactSha256 = task.driverRequest.requestArtifact.sha256;
    const validBytes = driverRequestBlobs.get(artifactSha256)!;
    driverRequestBlobs.set(artifactSha256, Buffer.from("corrupt-driver-request", "utf8"));
    try {
      await expect(
        acceptProbeBrokerTask(task, await acceptanceOptions(task, corruptGuard)),
      ).rejects.toThrow(/artifact bytes.*digest|length validation/i);
    } finally {
      driverRequestBlobs.set(artifactSha256, validBytes);
    }
    expect(corruptGuard.snapshot()).toEqual([]);

    const malformedSchemaTask = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-driver-schema",
      driverRequestKind: "unreviewed-driver-request-schema",
    });
    const schemaGuard = createDurableReplayGuard();
    await expect(
      acceptProbeBrokerTask(
        malformedSchemaTask,
        await acceptanceOptions(malformedSchemaTask, schemaGuard),
      ),
    ).rejects.toThrow(/driver-specific schema/i);
    expect(schemaGuard.snapshot()).toEqual([]);

    const valid = await acceptTask(task);
    expect(valid.capability.driverValidationReceiptSha256).toBe(
      valid.driverValidationReceipt.receiptSha256,
    );
    expect(valid.driverValidationReceipt.requestArtifactSha256).toBe(artifactSha256);
  });

  it("rejects a captured run-A first delivery under current prepared run-B authority", async () => {
    const runA = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-run-a-captured",
      executionRunId: "execution-run-a-captured",
      attemptId: "attempt-a-captured",
      candidateSha256: sha256("candidate-run-a"),
      claimReceiptSha256: sha256("claim-run-a"),
    });
    const runB = createScenarioTask(brokerCases[0], {
      campaignRunId: "campaign-run-b-current",
      executionRunId: "execution-run-b-current",
      attemptId: "attempt-b-current",
      candidateSha256: sha256("candidate-run-b"),
      claimReceiptSha256: sha256("claim-run-b"),
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(runA)).not.toBe(
      deriveProbeBrokerTaskSemanticKeySha256(runB),
    );
    const untouchedGuard = createDurableReplayGuard();
    await expect(
      acceptProbeBrokerTask(
        runA,
        await acceptanceOptions(runA, untouchedGuard, {
          authority: executionAuthoritySnapshot(runB),
        }),
      ),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING" });
    expect(untouchedGuard.snapshot()).toEqual([]);
  });

  it("separates signature verification from bounded-time task acceptance", async () => {
    expect(PROBE_BROKER_TASK_MAX_TTL_MS).toBe(600_000);
    expect(() =>
      createScenarioTask(brokerCases[0], {
        issuedAt: "2099-01-01T00:00:00.000Z",
        deadline: "2099-01-01T00:10:00.001Z",
      }),
    ).toThrow(/at most ten minutes/i);

    const futureTask = createScenarioTask(brokerCases[0], {
      issuedAt: "2099-01-01T00:00:00.000Z",
      deadline: "2099-01-01T00:05:00.000Z",
    });
    expect(
      verifyProbeBrokerTaskSignature(futureTask, {
        controllerPublicKeyBytes,
        expectedControllerIdentitySha256: controllerIdentitySha256,
      }),
    ).toEqual(futureTask);
    await expect(
      acceptProbeBrokerTask(futureTask, {
        ...(await acceptanceOptions(futureTask)),
        verificationInstant: new Date("2098-12-31T23:59:59.999Z"),
      }),
    ).rejects.toThrow(/issued in the future/i);

    const expiredTask = createPrimaryTask();
    await expect(
      acceptProbeBrokerTask(expiredTask, {
        ...(await acceptanceOptions(expiredTask)),
        verificationInstant: new Date(expiredTask.deadline),
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("closes the envelope while requiring driver-specific blob validation on dereference", () => {
    const task = createPrimaryTask();

    const absolutePath = JSON.parse(JSON.stringify(task));
    absolutePath.driverRequest.requestArtifact.blobPath = "C:/probe/request.json";
    expect(() => validateProbeBrokerTask(absolutePath)).toThrow(/content-addressed/i);

    for (const [key, value] of [
      ["command", "powershell -EncodedCommand AAAA"],
      ["executablePath", "C:/Windows/System32/cmd.exe"],
      ["script", "Remove-Item -Recurse C:/"],
    ] as const) {
      const injected = JSON.parse(JSON.stringify(task));
      injected.driverRequest[key] = value;
      expect(() => validateProbeBrokerTask(injected)).toThrow(/field set/i);
    }

    for (const key of ["credentials", "privateSigningKey", "accessToken"] as const) {
      const injected = JSON.parse(JSON.stringify(task));
      injected[key] = "-----BEGIN PRIVATE KEY-----";
      expect(() => validateProbeBrokerTask(injected)).toThrow(/credential material/i);
    }
  });

  it("rejects malformed Unicode, exotic data, unsafe depth, sizes, counts, and deadlines", async () => {
    const task = createPrimaryTask();

    const malformedUnicode = JSON.parse(JSON.stringify(task));
    malformedUnicode.taskId = "task-\ud800";
    expect(() => validateProbeBrokerTask(malformedUnicode)).toThrow(/canonical Unicode/i);

    const exotic = JSON.parse(JSON.stringify(task));
    exotic.coordinate = new Date();
    expect(() => validateProbeBrokerTask(exotic)).toThrow(/plain object/i);

    let deep: unknown = "leaf";
    for (let index = 0; index < PROBE_BROKER_MAX_DEPTH + 2; index += 1) {
      deep = { nested: deep };
    }
    const tooDeep = JSON.parse(JSON.stringify(task));
    tooDeep.driverRequest.unexpected = deep;
    expect(() => validateProbeBrokerTask(tooDeep)).toThrow(/depth|node bound/i);

    const oversizedArtifact = JSON.parse(JSON.stringify(task));
    oversizedArtifact.driverRequest.requestArtifact.bytes = PROBE_BROKER_MAX_ARTIFACT_BYTES + 1;
    expect(() => validateProbeBrokerTask(oversizedArtifact)).toThrow(/artifact bound/i);

    const oversizedReferences = JSON.parse(JSON.stringify(createPrimaryResult(task)));
    oversizedReferences.proofArtifacts = Array.from(
      { length: PROBE_BROKER_MAX_REFERENCES + 1 },
      (_, index) => artifact(`proof-${index}`),
    );
    expect(() => validateProbeBrokerResult(oversizedReferences)).toThrow(/bounded plain array/i);

    await expect(
      acceptProbeBrokerTask(task, {
        ...(await acceptanceOptions(task)),
        verificationInstant: new Date(task.deadline),
      }),
    ).rejects.toThrow(/deadline/i);
  });

  it("derives task and result digests from canonical domain-separated payloads", () => {
    const task = createPrimaryTask();
    const { taskSha256: _taskSha256, signatureBase64: _signatureBase64, ...taskDraft } = task;
    expect(task.taskSha256).toBe(
      sha256(
        canonicalProbeJson({
          domain: "enduragent.windows-host-probe-broker-task.v1",
          task: taskDraft,
        }),
      ),
    );
    expect(deriveProbeBrokerTaskDigest(task)).toBe(task.taskSha256);

    const result = createPrimaryResult(task);
    const { resultSha256: _resultSha256, ...resultDraft } = result;
    expect(result.resultSha256).toBe(
      sha256(
        canonicalProbeJson({
          domain: "enduragent.windows-host-probe-broker-result.v1",
          result: resultDraft,
        }),
      ),
    );
    expect(deriveProbeBrokerResultDigest(result)).toBe(result.resultSha256);
  });

  it("refuses cross-task actor, enrollment, instance, role, and driver result swaps", async () => {
    const task = createPrimaryTask();
    const acceptedTask = await acceptTask(task);
    const baseline = createPrimaryResult(task);
    const substitutions = [
      (result: Record<string, unknown>) => {
        result.taskSha256 = createRoleTask("remote-peer").taskSha256;
      },
      (result: Record<string, unknown>) => {
        result.brokerEnrollmentSha256 = sha256("substituted-enrollment");
      },
      (result: Record<string, unknown>) => {
        result.brokerInstanceId = "primary-broker-b";
      },
      (result: Record<string, unknown>) => {
        const actor = result.actor as Record<string, unknown>;
        actor.identitySha256 = sha256("substituted-actor");
      },
      (result: Record<string, unknown>) => {
        const driverResult = result.driverResult as Record<string, unknown>;
        driverResult.driverId = "substituted-driver";
      },
    ];

    for (const substitute of substitutions) {
      const changed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
      substitute(changed);
      changed.resultSha256 = deriveProbeBrokerResultDigest(
        changed as unknown as Parameters<typeof deriveProbeBrokerResultDigest>[0],
      );
      await expect(validateAcceptedResult(changed, acceptedTask)).rejects.toThrow(
        /binding|differs/i,
      );
    }

    const changedRole = JSON.parse(JSON.stringify(baseline));
    changedRole.brokerRole = "second-user";
    changedRole.actor = {
      role: "second-user",
      identitySource: "actors.secondUserSidSha256",
      identitySha256: sha256("second-user"),
    };
    changedRole.resultSha256 = deriveProbeBrokerResultDigest(changedRole);
    await expect(validateAcceptedResult(changedRole, acceptedTask)).rejects.toThrow(
      /binding|differs/i,
    );
  });

  it("rejects duplicate, cross-category, unsorted, and unattached result artifacts", () => {
    const result = createPrimaryResult();

    const duplicate = JSON.parse(JSON.stringify(result));
    duplicate.proofArtifacts = [duplicate.proofArtifacts[0], duplicate.proofArtifacts[0]];
    expect(() => validateProbeBrokerResult(duplicate)).toThrow(/sorted|unique/i);

    const crossCategory = JSON.parse(JSON.stringify(result));
    crossCategory.proofArtifacts = [crossCategory.driverResult.resultArtifact];
    crossCategory.pausedSessionReceipt = crossCategory.proofArtifacts[0];
    expect(() => validateProbeBrokerResult(crossCategory)).toThrow(/duplicate/i);

    const observerDuplicate = JSON.parse(JSON.stringify(result));
    observerDuplicate.observerTranscripts = [
      observerDuplicate.observerTranscripts[0],
      observerDuplicate.observerTranscripts[0],
    ];
    expect(() => validateProbeBrokerResult(observerDuplicate)).toThrow(/sorted|unique/i);

    const unattachedPausedSession = JSON.parse(JSON.stringify(result));
    unattachedPausedSession.pausedSessionReceipt = artifact("unattached-paused-session");
    expect(() => validateProbeBrokerResult(unattachedPausedSession)).toThrow(/retained proof/i);

    const brokerSigned = { ...result, signatureBase64: Buffer.alloc(64).toString("base64") };
    expect(() => validateProbeBrokerResult(brokerSigned)).toThrow(/field set/i);
  });

  it("detects accidental result corruption without claiming unsigned output authenticity", () => {
    const result = createPrimaryResult();
    const changed = JSON.parse(JSON.stringify(result));
    changed.bootIdSha256 = sha256("other-boot");
    expect(() => validateProbeBrokerResult(changed)).toThrow(/digest/i);
  });

  it("cannot reuse a result across two frozen actions sharing one execution mapping and driver", async () => {
    const shared = {
      role: "primary-standard-user",
      identitySource: "actors.primaryStandardUserSidSha256",
      rowId: "F-07",
      variantId: "f07-hard-cut-after-file-flush",
    } as const;
    const options = { taskId: "task-shared-durability-action", nonceByte: 11 } as const;
    const firstTask = createScenarioTask(
      { ...shared, actionId: "start-durability-operation-r1" },
      options,
    );
    const secondTask = createScenarioTask(
      { ...shared, actionId: "start-durability-operation-r2" },
      options,
    );
    const acceptedSecondTask = await acceptTask(secondTask);

    expect(secondTask.execution).toEqual(firstTask.execution);
    expect(secondTask.driverRequest.driverId).toBe(firstTask.driverRequest.driverId);
    expect(secondTask.taskSha256).not.toBe(firstTask.taskSha256);
    await expect(
      validateAcceptedResult(createPrimaryResult(firstTask), acceptedSecondTask),
    ).rejects.toThrow(/binding|differs/i);
  });
});
