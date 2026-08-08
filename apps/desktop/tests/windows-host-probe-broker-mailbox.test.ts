import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  PROBE_BROKER_MAILBOX_RESULT_KIND,
  PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
  PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
  deriveProbeBrokerMailboxResultEnvelopeDigest,
  deriveProbePreparedBrokerEnrollmentDigest,
  validateProbePreparedBrokerEnrollment,
  type ProbeBrokerMailboxObservation,
  type ProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import {
  assertProbeBrokerMailboxBytesSafe,
  initializeProbeBrokerMailboxStore,
  openProbeBrokerMailbox,
  type ProbeBrokerMailboxAuthorityGuard,
} from "../scripts/windows-host-falsifier/broker/mailbox.mjs";
import {
  createProbeBrokerResult,
  createProbeBrokerTask,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  type ProbeBrokerArtifactReference,
  type ProbeBrokerControllerAcceptanceInput,
  type ProbeBrokerExecutionMapping,
  type ProbeBrokerTask,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  openEvidenceStore,
  type EvidenceStore,
} from "../scripts/windows-host-falsifier/evidence-store.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import {
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({ format: "der", type: "spki" });
const controllerIdentitySha256 = sha256("controller-identity");
const processSidSha256 = sha256("primary-standard-user-sid");

function reference(bytes: Uint8Array): ProbeBrokerArtifactReference {
  const digest = sha256(bytes);
  return { blobPath: `blobs/sha256/${digest}`, bytes: bytes.byteLength, sha256: digest };
}

function createTask(
  binding: ProbePreparedBrokerEnrollment,
  driverRequestBytes: Uint8Array,
  options: {
    readonly attemptId?: string;
    readonly executionRunId?: string;
    readonly nonceByte?: number;
    readonly taskId?: string;
  } = {},
): ProbeBrokerTask {
  const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
  const plannedAction = definition.actions.find(
    (action) => action.actionId === "prepare-home-topology",
  )!;
  const invocation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-scenario-action-invocation" as const,
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: plannedAction,
  };
  const execution = getProbeActionMapping(invocation) as ProbeBrokerExecutionMapping;
  const campaignRunId = "campaign-run-a";
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
  const operationId = deriveProbeRuntimeScenarioOperationId(
    { campaignRunId, attemptId, workId: workItem.workId },
    plannedAction.actionId,
  );
  const expectedActor = {
    role: "primary-standard-user" as const,
    identitySource: "actors.primaryStandardUserSidSha256" as const,
    identitySha256: binding.processSidSha256,
  };
  const runtimeActionIntentSha256 = hashProbeCanonicalJson({
    schemaVersion: 2,
    kind: "windows-host-probe-runtime-action-intent",
    campaignRunId,
    attemptId,
    workId: workItem.workId,
    rowId: definition.rowId,
    variantId: definition.variantId,
    repetition: null,
    planSha256: definition.planSha256,
    actionId: plannedAction.actionId,
    operationId,
    action: plannedAction,
    execution,
    expectedActor,
  });
  return createProbeBrokerTask(
    {
      taskId: options.taskId ?? `task-${attemptId}`,
      controllerIdentitySha256,
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
      candidateSha256: sha256("candidate"),
      runAuthorizationClaimReceiptSha256: sha256("run-authorization-claim"),
      coordinate: {
        campaignRunId,
        executionRunId,
        attemptId,
        workId: workItem.workId,
        environmentId,
        pathProfileId,
        rowId: definition.rowId as `F-${string}`,
        variantId: definition.variantId,
        repetition: null,
      },
      runtimeActionIntentSha256,
      action: {
        scenarioPlanSha256: definition.planSha256,
        producerActionId: plannedAction.actionId,
        operationId,
        sequence: plannedAction.sequence,
      },
      execution,
      actorSelectorInput: null,
      expectedActor,
      brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
      brokerInstanceId: binding.brokerInstanceId,
      brokerRole: binding.brokerRole,
      mailboxAclSha256: binding.mailboxAclSha256,
      processSidSha256: binding.processSidSha256,
      bootIdSha256: binding.bootIdSha256,
      runnerSessionIdSha256: binding.runnerSessionIdSha256,
      driverRequest: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-request",
        driverId: execution.driverId,
        requestArtifact: reference(driverRequestBytes),
      },
      recoveryClass: "inspect-and-reconcile",
      issuedAt: "2098-12-31T23:55:00.000Z",
      deadline: "2099-01-01T00:00:00.000Z",
      nonceBase64: Buffer.alloc(32, options.nonceByte ?? 1).toString("base64"),
    },
    (digest) => sign(null, digest, controllerKeys.privateKey),
  );
}

function createResult(
  task: ProbeBrokerTask,
  options: { readonly driverId?: string; readonly includeObserverTranscript?: boolean } = {},
) {
  const driverResultBytes = Buffer.from(canonicalProbeJson({ result: "driver-result" }), "utf8");
  const proofBytes = Buffer.from("sanitized proof artifact", "utf8");
  const observerBytes = Buffer.from("sanitized observer transcript", "utf8");
  const driverResultReference = reference(driverResultBytes);
  const proofReference = reference(proofBytes);
  const observerReference = {
    ...reference(observerBytes),
    transcriptSha256: sha256(observerBytes),
  };
  const result = createProbeBrokerResult({
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
      driverId: options.driverId ?? task.execution.driverId,
      resultArtifact: driverResultReference,
    },
    proofArtifacts: [proofReference],
    observerTranscripts: options.includeObserverTranscript === false ? [] : [observerReference],
    pausedSessionReceipt: proofReference,
  });
  const controllerAcceptanceInput = createControllerAcceptanceInput(task, result);
  return {
    result,
    controllerAcceptanceInput,
    artifacts: [
      ...(options.includeObserverTranscript === false
        ? []
        : [{ reference: observerReference, bytes: observerBytes }]),
      { reference: proofReference, bytes: proofBytes },
      { reference: driverResultReference, bytes: driverResultBytes },
    ],
  };
}

function createControllerAcceptanceInput(
  task: ProbeBrokerTask,
  result: ReturnType<typeof createProbeBrokerResult>,
): ProbeBrokerControllerAcceptanceInput {
  return {
    coordinate: task.coordinate,
    producerActionId: task.action.producerActionId,
    brokerTaskSha256: task.taskSha256,
    brokerTaskNonceSha256: sha256(Buffer.from(task.nonceBase64, "base64")),
    brokerResultSha256: result.resultSha256,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
    expectedActor: task.expectedActor,
    mailboxAclSha256: task.mailboxAclSha256,
    processSidSha256: task.processSidSha256,
    bootIdSha256: task.bootIdSha256,
    runnerSessionIdSha256: task.runnerSessionIdSha256,
    replayJournalDisposition: "accepted",
    replayJournalEntrySha256: sha256("journal-entry"),
  };
}

function observationForEnrollment(
  brokerEnrollmentSha256: string,
  brokerInstanceId: string,
  mailboxRoot: string,
  mailboxAclSha256: string,
  journalRoot: string,
  journalRootAclSha256: string,
  journalDatabaseAclSha256: string,
): ProbeBrokerMailboxObservation {
  return {
    schemaVersion: 1,
    kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
    brokerEnrollmentSha256,
    environmentId: "win11-current",
    brokerRole: "primary-standard-user",
    brokerInstanceId,
    mailboxRoot,
    mailboxSecurityProfile: PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
    mailboxAclSha256,
    mailboxOwnerSidSha256: processSidSha256,
    processSidSha256,
    peerAuthoritySha256: null,
    mailboxRootObjectIdentitySha256: sha256("mailbox-root-object"),
    mailboxVolumeIdSha256: sha256("mailbox-volume"),
    mailboxTransportIdentitySha256: sha256("mailbox-transport"),
    mailboxFileSystem: "NTFS",
    mailboxDriveType: "fixed",
    mailboxLocalAbsolute: true,
    mailboxNetworkPath: false,
    mailboxReparsePoint: false,
    journalRoot,
    journalSecurityProfile: PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
    journalRootPathSha256: sha256("journal-root-path"),
    journalRootObjectIdentitySha256: sha256("journal-root-object"),
    journalVolumeIdSha256: sha256("journal-volume"),
    journalRootOwnerSidSha256: processSidSha256,
    journalRootAclSha256,
    journalDatabasePathSha256: sha256("journal-database-path"),
    journalDatabaseObjectIdentitySha256: sha256("journal-database-object"),
    journalDatabaseOwnerSidSha256: processSidSha256,
    journalDatabaseAclSha256,
    journalTransportIdentitySha256: sha256("journal-transport"),
    journalFileSystem: "NTFS",
    journalDriveType: "fixed",
    journalLocalAbsolute: true,
    journalNetworkPath: false,
    journalReparsePoint: false,
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
    nativeHelperSha256: sha256("native-helper"),
    nativeObservationSha256: sha256("native-observation"),
  };
}

describe("Windows host role-specific broker mailbox", () => {
  let root: string;
  let physicalStore: EvidenceStore;
  let store: EvidenceStore;
  let binding: ProbePreparedBrokerEnrollment;
  let liveObservation: ProbeBrokerMailboxObservation;
  let authorityGuard: Mock<ProbeBrokerMailboxAuthorityGuard>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "enduragent-broker-mailbox-")));
    await mkdir(join(root, "store"), { mode: 0o700 });
    physicalStore = await openEvidenceStore({ root: join(root, "store") });
    const enrollment = createProbeBrokerEnrollment({
      environmentId: "win11-current",
      brokerRole: "primary-standard-user",
      brokerInstanceId: "win11-current-primary-broker",
      mailboxRoot: "E:\\Broker\\win11-current\\primary-standard-user",
      mailboxAclSha256: sha256("primary-mailbox-acl"),
      journalRoot: "E:\\BrokerJournal\\win11-current\\primary-standard-user",
      journalRootAclSha256: sha256("primary-journal-root-acl"),
      journalDatabaseAclSha256: sha256("primary-journal-database-acl"),
      processSidSha256,
      peerAuthoritySha256: null,
    });
    liveObservation = observationForEnrollment(
      enrollment.brokerEnrollmentSha256,
      enrollment.brokerInstanceId,
      enrollment.mailboxRoot,
      enrollment.mailboxAclSha256,
      enrollment.journalRoot,
      enrollment.journalRootAclSha256,
      enrollment.journalDatabaseAclSha256,
    );
    binding = createProbePreparedBrokerEnrollment(enrollment, liveObservation);
    store = Object.freeze({ ...physicalStore, root: binding.mailboxRoot });
    await initializeProbeBrokerMailboxStore({ store });
    authorityGuard = vi.fn<ProbeBrokerMailboxAuthorityGuard>(async () => liveObservation);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function mailbox(principal: "broker" | "controller", selectedStore = store) {
    return openProbeBrokerMailbox({
      store: selectedStore,
      binding,
      principal,
      assertMailboxAuthority: authorityGuard,
    });
  }

  it("publishes request blobs before immutable task envelopes and accepts exact replay", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ schemaVersion: 1, kind: "test-driver-request" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const controller = mailbox("controller");
    const broker = mailbox("broker");

    const first = await controller.publishTask({ task, driverRequestBytes });
    await expect(controller.publishTask({ task, driverRequestBytes })).resolves.toEqual(first);
    await expect(broker.listTaskPhysicalOperationKeys()).resolves.toEqual([
      deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    ]);
    await expect(broker.readTask(first.physicalOperationKeySha256)).resolves.toMatchObject({
      task: { taskSha256: task.taskSha256 },
      driverRequestBytes,
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    });
    expect(first.semanticKeySha256).toBe(deriveProbeBrokerTaskSemanticKeySha256(task));
    expect(authorityGuard).toHaveBeenCalled();
    for (const [request] of authorityGuard.mock.calls) {
      expect(request).not.toHaveProperty("taskSha256");
      expect(request).not.toHaveProperty("physicalOperationKeySha256");
      expect(request).toMatchObject({
        brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
        preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      });
    }
  });

  it("rejects a changed authority generation that collides on one physical operation", async () => {
    const driverRequestBytes = Buffer.from(canonicalProbeJson({ request: "collision" }), "utf8");
    const original = createTask(binding, driverRequestBytes, { nonceByte: 1 });
    const changedGeneration = createTask(binding, driverRequestBytes, {
      executionRunId: "execution-run-b",
      nonceByte: 2,
      taskId: "task-generation-b",
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(changedGeneration)).not.toBe(
      deriveProbeBrokerTaskSemanticKeySha256(original),
    );
    expect(deriveProbeBrokerTaskPhysicalOperationKeySha256(changedGeneration)).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(original),
    );
    await mailbox("controller").publishTask({ task: original, driverRequestBytes });
    await expect(
      mailbox("controller").publishTask({ task: changedGeneration, driverRequestBytes }),
    ).rejects.toMatchObject({ code: "BROKER_MAILBOX_COLLISION" });
  });

  it("publishes result blobs before one result envelope and authenticates the exact role mailbox", async () => {
    const driverRequestBytes = Buffer.from(canonicalProbeJson({ request: "result" }), "utf8");
    const task = createTask(binding, driverRequestBytes);
    const controller = mailbox("controller");
    const broker = mailbox("broker");
    await controller.publishTask({ task, driverRequestBytes });
    await broker.readTask(deriveProbeBrokerTaskPhysicalOperationKeySha256(task));
    const resultFixture = createResult(task);

    await expect(
      broker.publishResult({
        task,
        ...createResult(task, { driverId: "substituted-driver" }),
      }),
    ).rejects.toMatchObject({ code: "BROKER_MAILBOX_RESULT_BINDING" });

    const first = await broker.publishResult({ task, ...resultFixture });
    await expect(broker.publishResult({ task, ...resultFixture })).resolves.toEqual(first);
    const authenticated = await controller.readResult(task);
    expect(authenticated.result).toEqual(resultFixture.result);
    expect(authenticated.controllerAcceptanceInput).toEqual(
      resultFixture.controllerAcceptanceInput,
    );
    expect(authenticated.artifacts.map((entry) => entry.reference.sha256).sort()).toEqual(
      resultFixture.artifacts.map((entry) => entry.reference.sha256).sort(),
    );
    expect(authenticated).toMatchObject({
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
      mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    });
  });

  it("refuses direct result injection with another driver", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "injected-result" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const { result } = createResult(task, { driverId: "substituted-driver" });
    const controllerAcceptanceInput = createControllerAcceptanceInput(task, result);
    const physicalOperationKeySha256 = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
    const envelopeFields = {
      schemaVersion: 1 as const,
      kind: PROBE_BROKER_MAILBOX_RESULT_KIND,
      brokerEnrollmentSha256: task.brokerEnrollmentSha256,
      brokerRole: task.brokerRole,
      brokerInstanceId: task.brokerInstanceId,
      semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
      physicalOperationKeySha256,
      taskSha256: task.taskSha256,
      resultSha256: result.resultSha256,
      result,
      controllerAcceptanceInput,
    };
    const envelope = {
      ...envelopeFields,
      resultEnvelopeSha256: deriveProbeBrokerMailboxResultEnvelopeDigest(envelopeFields),
    };
    await store.writeBytes(
      `results/${physicalOperationKeySha256}.json`,
      Buffer.from(canonicalProbeJson(envelope), "utf8"),
    );

    await expect(mailbox("controller").readResult(task)).rejects.toMatchObject({
      code: "BROKER_MAILBOX_RESULT_BINDING",
    });
  });

  it("rejects a controller acceptance sidecar swapped from another task before staging", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "swapped-sidecar" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const otherTask = createTask(binding, driverRequestBytes, {
      attemptId: "attempt-sidecar-b",
      taskId: "task-sidecar-b",
      nonceByte: 2,
    });
    const resultFixture = createResult(task);
    const otherSidecar = createResult(otherTask).controllerAcceptanceInput;

    await expect(
      mailbox("broker").stageResultArtifacts({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: otherSidecar,
        artifacts: resultFixture.artifacts,
      }),
    ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_CONTROLLER_ACCEPTANCE" });
    await expect(store.list("blobs/sha256")).resolves.toEqual([]);
  });

  it("rejects a digest-valid result envelope with a task-tampered acceptance sidecar", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "tampered-sidecar" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const resultFixture = createResult(task);
    await mailbox("broker").stageResultArtifacts({ task, ...resultFixture });
    const controllerAcceptanceInput = {
      ...resultFixture.controllerAcceptanceInput,
      mailboxAclSha256: sha256("tampered-sidecar-acl"),
    };
    const physicalOperationKeySha256 = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
    const envelopeFields = {
      schemaVersion: 1 as const,
      kind: PROBE_BROKER_MAILBOX_RESULT_KIND,
      brokerEnrollmentSha256: task.brokerEnrollmentSha256,
      brokerRole: task.brokerRole,
      brokerInstanceId: task.brokerInstanceId,
      semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
      physicalOperationKeySha256,
      taskSha256: task.taskSha256,
      resultSha256: resultFixture.result.resultSha256,
      result: resultFixture.result,
      controllerAcceptanceInput,
    };
    const envelope = {
      ...envelopeFields,
      resultEnvelopeSha256: deriveProbeBrokerMailboxResultEnvelopeDigest(envelopeFields),
    };
    await store.writeBytes(
      `results/${physicalOperationKeySha256}.json`,
      Buffer.from(canonicalProbeJson(envelope), "utf8"),
    );

    await expect(mailbox("controller").readResult(task)).rejects.toMatchObject({
      code: "BROKER_PROTOCOL_CONTROLLER_ACCEPTANCE",
    });
  });

  it("keeps staged result blobs invisible until retained-envelope publication after restart", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "staged-result" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const controller = mailbox("controller");
    const resultFixture = createResult(task);

    await controller.publishTask({ task, driverRequestBytes });
    const stagedEnvelope = await mailbox("broker").stageResultArtifacts({
      task,
      ...resultFixture,
    });

    await expect(controller.readResult(task)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.list("results")).resolves.toEqual([]);

    const restartedBroker = mailbox("broker");
    await expect(
      restartedBroker.publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
    ).resolves.toEqual(stagedEnvelope);
    await expect(controller.readResult(task)).resolves.toMatchObject({
      result: { resultSha256: resultFixture.result.resultSha256 },
      controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
    });
  });

  it("refuses retained-envelope publication when a referenced blob is missing", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "missing-result" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const resultFixture = createResult(task);

    await expect(
      mailbox("broker").publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.list("results")).resolves.toEqual([]);
  });

  it("refuses retained-envelope publication when a staged blob is corrupt", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "corrupt-result" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const resultFixture = createResult(task);
    const corruptedPath = resultFixture.artifacts[0]!.reference.blobPath;
    await mailbox("broker").stageResultArtifacts({ task, ...resultFixture });
    const corruptedStore = Object.freeze({
      ...store,
      readArtifact: async (path: string) => {
        const artifact = await store.readArtifact(path);
        return path === corruptedPath
          ? Object.freeze({ ...artifact, bytes: Buffer.alloc(artifact.size, 0x78) })
          : artifact;
      },
    });

    await expect(
      mailbox("broker", corruptedStore).publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
    ).rejects.toMatchObject({ code: "BROKER_MAILBOX_BLOB" });
    await expect(store.list("results")).resolves.toEqual([]);
  });

  it("accepts exact retries of both staged blobs and the retained result envelope", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "retried-result" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes);
    const resultFixture = createResult(task);
    const broker = mailbox("broker");

    const staged = await broker.stageResultArtifacts({ task, ...resultFixture });
    await expect(broker.stageResultArtifacts({ task, ...resultFixture })).resolves.toEqual(staged);
    const retained = await broker.publishRetainedResult({
      task,
      result: resultFixture.result,
      controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
    });
    await expect(
      broker.publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
    ).resolves.toEqual(retained);
  });

  it("publishes a bounded refusal and forbids result/refusal equivocation", async () => {
    const driverRequestBytes = Buffer.from(canonicalProbeJson({ request: "refusal" }), "utf8");
    const task = createTask(binding, driverRequestBytes, {
      attemptId: "attempt-refusal",
      taskId: "task-refusal",
    });
    const controller = mailbox("controller");
    const broker = mailbox("broker");
    await controller.publishTask({ task, driverRequestBytes });
    await expect(
      broker.publishRefusal({ task, refusalCode: "UNSUPPORTED_DRIVER" }),
    ).resolves.toMatchObject({ refusalCode: "UNSUPPORTED_DRIVER" });
    await expect(controller.readRefusal(task)).resolves.toMatchObject({
      envelope: { refusalCode: "UNSUPPORTED_DRIVER" },
      preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    });
    const resultFixture = createResult(task);
    await expect(
      broker.publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
    ).rejects.toMatchObject({ code: "BROKER_MAILBOX_COMPLETION_COLLISION" });
  });

  it("atomically selects exactly one terminal completion across concurrent publishers", async () => {
    const driverRequestBytes = Buffer.from(
      canonicalProbeJson({ request: "terminal-race" }),
      "utf8",
    );
    const task = createTask(binding, driverRequestBytes, {
      attemptId: "attempt-terminal-race",
      taskId: "task-terminal-race",
    });
    const broker = mailbox("broker");
    const resultFixture = createResult(task);
    const physicalOperationKeySha256 = deriveProbeBrokerTaskPhysicalOperationKeySha256(task);
    await broker.stageResultArtifacts({ task, ...resultFixture });

    const settled = await Promise.allSettled([
      broker.publishRetainedResult({
        task,
        result: resultFixture.result,
        controllerAcceptanceInput: resultFixture.controllerAcceptanceInput,
      }),
      broker.publishRefusal({ task, refusalCode: "UNSUPPORTED_DRIVER" }),
    ]);

    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "BROKER_MAILBOX_COMPLETION_COLLISION" }),
      }),
    ]);
    await expect(store.list("terminals")).resolves.toEqual([
      expect.objectContaining({ name: `${physicalOperationKeySha256}.json`, kind: "file" }),
    ]);
    const results = await store.list("results");
    const refusals = await store.list("refusals");
    expect(results.length + refusals.length).toBe(1);
  });

  it.each([
    ["mailboxAclSha256", sha256("changed-acl")],
    ["mailboxRootObjectIdentitySha256", sha256("changed-root-object")],
    ["mailboxTransportIdentitySha256", sha256("changed-transport")],
  ] as const)("refuses live %s drift before mailbox I/O", async (key, value) => {
    liveObservation = { ...liveObservation, [key]: value };
    await expect(mailbox("broker").listTaskPhysicalOperationKeys()).rejects.toMatchObject({
      code: "BROKER_MAILBOX_AUTHORITY_DRIFT",
    });
  });

  it("revalidates authority after a read and mints no authenticated delivery on mid-read drift", async () => {
    const driverRequestBytes = Buffer.from(canonicalProbeJson({ request: "post-check" }), "utf8");
    const task = createTask(binding, driverRequestBytes);
    await mailbox("controller").publishTask({ task, driverRequestBytes });
    let mutateAfterRead = true;
    const driftingStore = Object.freeze({
      ...store,
      readArtifact: async (path: string) => {
        const artifact = await store.readArtifact(path);
        if (mutateAfterRead) {
          mutateAfterRead = false;
          liveObservation = {
            ...liveObservation,
            mailboxTransportIdentitySha256: sha256("transport-changed-during-read"),
          };
        }
        return artifact;
      },
    });
    await expect(
      mailbox("broker", driftingStore).readTask(
        deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
      ),
    ).rejects.toMatchObject({ code: "BROKER_MAILBOX_AUTHORITY_DRIFT" });
  });

  it("cannot operate without a live authority guard or through another role root", async () => {
    expect(() =>
      openProbeBrokerMailbox({ store, binding, principal: "controller" } as never),
    ).toThrow(/live authority guard/u);
    const anotherStore = Object.freeze({ ...physicalStore, root: "E:\\Broker\\another-role" });
    expect(() =>
      openProbeBrokerMailbox({
        store: anotherStore,
        binding,
        principal: "controller",
        assertMailboxAuthority: authorityGuard,
      }),
    ).toThrow(/root differs/u);
  });

  it("rejects a prepared receipt whose static enrollment fields do not match its enrollment digest", () => {
    const changedFields = {
      ...binding,
      mailboxAclSha256: sha256("forged-static-mailbox-acl"),
    };
    const forged = {
      ...changedFields,
      preparedBrokerEnrollmentSha256: deriveProbePreparedBrokerEnrollmentDigest(changedFields),
    };

    expect(() => validateProbePreparedBrokerEnrollment(forged)).toThrow(
      /broker enrollment digest mismatch/u,
    );
  });

  it.each([
    "CON",
    "con.txt",
    "CONIN$",
    "conout$.log",
    "PrN.log",
    "AUX",
    "NUL.data",
    "CLOCK$",
    "COM1",
    "lpt9.bin",
  ])("rejects reserved DOS device mailbox component %s", (component) => {
    expect(() =>
      createProbeBrokerEnrollment({
        environmentId: "win11-current",
        brokerRole: "primary-standard-user",
        brokerInstanceId: "reserved-device-broker",
        mailboxRoot: `E:\\Broker\\${component}\\primary`,
        mailboxAclSha256: sha256("reserved-device-acl"),
        journalRoot: "E:\\BrokerJournal\\reserved-device\\primary",
        journalRootAclSha256: sha256("reserved-device-journal-root-acl"),
        journalDatabaseAclSha256: sha256("reserved-device-journal-database-acl"),
        processSidSha256,
        peerAuthoritySha256: null,
      }),
    ).toThrow(/unsafe Windows path segment/u);
  });

  it.each(["console", "com10", "lpt0", "auxiliary", "null-device"])(
    "allows benign mailbox component %s",
    (component) => {
      expect(() =>
        createProbeBrokerEnrollment({
          environmentId: "win11-current",
          brokerRole: "primary-standard-user",
          brokerInstanceId: "benign-device-name-broker",
          mailboxRoot: `E:\\Broker\\${component}\\primary`,
          mailboxAclSha256: sha256("benign-device-name-acl"),
          journalRoot: "E:\\BrokerJournal\\benign-device\\primary",
          journalRootAclSha256: sha256("benign-device-journal-root-acl"),
          journalDatabaseAclSha256: sha256("benign-device-journal-database-acl"),
          processSidSha256,
          peerAuthoritySha256: null,
        }),
      ).not.toThrow();
    },
  );

  it.each([
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    '{"accessToken":"synthetic-access-token"}',
    '{"clientSecret":"synthetic-client-secret"}',
    "Authorization: Basic dXNlcjpwYXNz",
    "Cookie: theme=dark; session_id=synthetic-session-value",
    "Set-Cookie: connect.sid=synthetic-session-value; Secure; HttpOnly",
    "Cookie: __Host-session-token=synthetic-session-value",
  ])("rejects prohibited material before any blob publication", (value) => {
    expect(() => assertProbeBrokerMailboxBytesSafe(Buffer.from(value, "utf8"))).toThrow(
      /prohibited material/u,
    );
  });

  it("allows benign credential and session terminology", () => {
    for (const value of [
      "Basic authorization is documented without credentials.",
      "Session cookies are disabled in this fixture.",
      "The accessToken field name is discussed without a serialized value.",
      "clientSecret rotation policy",
    ]) {
      expect(() => assertProbeBrokerMailboxBytesSafe(Buffer.from(value, "utf8"))).not.toThrow();
    }
  });

  it("rejects configured forbidden values", () => {
    expect(() =>
      assertProbeBrokerMailboxBytesSafe(Buffer.from("contains sentinel-value", "utf8"), {
        forbiddenValues: ["sentinel-value"],
      }),
    ).toThrow(/prohibited material/u);
  });
});
